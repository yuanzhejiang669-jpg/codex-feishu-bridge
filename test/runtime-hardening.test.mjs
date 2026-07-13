import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLogger } from "../src/logging/logger.mjs";
import {
  BRIDGE_START_SCRIPT_TIMEOUT_MS,
  bridgeStartIsConfirmed,
  normalizeConfirmedStartResult,
} from "../src/control-panel/restart.mjs";
import { createActiveRunStore } from "../src/runtime/active-runs.mjs";
import {
  appServerToolStatus,
  createRunActivity,
  markCodexEvent,
  markModelEvent,
  markRunPhase,
  markToolCompleted,
  markToolProgress,
  markToolStarted,
  renderRunActivityMarkdown,
  runActivityView,
} from "../src/runtime/run-activity.mjs";
import { recordsMatchColumns } from "../src/utils/json.mjs";

test("active run state preserves the previous JSON when an atomic write fails", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-state-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, "active-runs.json");
  const previous = { runs: { existing: { messageId: "existing" } } };
  fs.writeFileSync(statePath, JSON.stringify(previous), "utf8");

  const store = createActiveRunStore({ activeRunsPath: statePath });
  const originalFsync = fs.fsyncSync;
  fs.fsyncSync = () => {
    throw new Error("injected fsync failure");
  };
  try {
    assert.throws(
      () => store.recordActiveRun({ messageId: "new" }),
      /injected fsync failure/,
    );
  } finally {
    fs.fsyncSync = originalFsync;
  }

  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), previous);
  assert.equal(fs.readdirSync(directory).some((name) => name.endsWith(".tmp")), false);

  store.saveActiveRuns();
  const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(saved.runs.existing.messageId, "existing");
  assert.equal(saved.runs.new.messageId, "new");
});

test("logger rotates at the configured size and enforces backup retention", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-log-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const logPath = path.join(directory, "bridge.log");
  const log = createLogger(logPath, {
    maxBytes: 220,
    maxBackups: 2,
    mirrorToConsole: false,
  });

  for (let index = 0; index < 12; index += 1) {
    log("INFO", `entry-${index}-${"x".repeat(70)}`);
  }

  const files = fs.readdirSync(directory).sort();
  assert.deepEqual(files, ["bridge.log", "bridge.log.1", "bridge.log.2"]);
  for (const file of files) {
    assert.ok(fs.statSync(path.join(directory, file)).size <= 220);
  }
});

test("sidebar record comparison detects only material column changes", () => {
  const current = { id: "thread-1", title: "Title", archived: 0, nullable: null };
  const columns = ["id", "title", "archived", "nullable"];

  assert.equal(recordsMatchColumns(current, { ...current }, columns), true);
  assert.equal(recordsMatchColumns(current, { ...current, title: "Changed" }, columns), false);
  assert.equal(recordsMatchColumns(null, current, columns), false);
  assert.equal(recordsMatchColumns(current, { ...current, nullable: undefined }, columns), true);
});

test("control panel trusts a live owned Bridge PID after the start wrapper times out", () => {
  const confirmed = bridgeStartIsConfirmed({
    pid: 4321,
    processAlive: true,
    lock: { pid: 4321, instance: "bot-1" },
    instanceName: "bot-1",
  });
  const result = normalizeConfirmedStartResult({
    ok: false,
    error: "start script timed out",
    exitCode: "ETIMEDOUT",
  }, confirmed);

  assert.equal(BRIDGE_START_SCRIPT_TIMEOUT_MS, 10_000);
  assert.equal(confirmed, true);
  assert.equal(result.ok, true);
  assert.equal(result.detached, true);
  assert.equal(result.error, "");
  assert.match(result.wrapperError, /timed out/);
  assert.equal(bridgeStartIsConfirmed({
    pid: 4321,
    processAlive: true,
    lock: { pid: 9999, instance: "bot-1" },
    instanceName: "bot-1",
  }), false);
});

test("run activity distinguishes a live tool from upstream model waiting", () => {
  const startedAt = 1_000_000;
  const state = {
    startedAt,
    activity: createRunActivity(startedAt),
    blocks: [],
  };
  const tool = {
    id: "tool-1",
    source: "Web",
    name: "web_search",
    status: "running",
  };
  state.blocks.push({ kind: "tool", tool });

  markCodexEvent(state, startedAt + 1_000);
  markToolStarted(state, tool, startedAt + 2_000);
  markToolProgress(state, tool, startedAt + 12_000);

  const running = runActivityView(state, startedAt + 20_000);
  assert.equal(running.healthLabel, "正常");
  assert.equal(running.phaseLabel, "工具执行中");
  assert.equal(running.currentTool, "Web · web_search");
  assert.equal(running.upstreamLabel, "等待工具结果");
  assert.match(running.recentProgress, /8秒前.*有新输出/);

  tool.status = "completed";
  markToolCompleted(state, tool, startedAt + 25_000);
  const waiting = runActivityView(state, startedAt + 35_000);
  assert.equal(waiting.phaseLabel, "等待模型处理工具结果");
  assert.equal(waiting.currentTool, "");
  assert.equal(waiting.upstreamLabel, "等待模型响应");
  assert.match(waiting.recentProgress, /10秒前.*执行完成/);
});

test("run activity reports slow and disconnected states without inventing progress", () => {
  const startedAt = 2_000_000;
  const state = {
    startedAt,
    activity: createRunActivity(startedAt),
    blocks: [],
  };

  markModelEvent(state, "model_thinking", startedAt + 5_000);
  const progressAt = state.activity.lastProgressAt;
  markRunPhase(state, "model_thinking", { connection: "connected", progress: false }, startedAt + 60_000);
  assert.equal(state.activity.lastProgressAt, progressAt);

  const slow = runActivityView(state, startedAt + 3 * 60_000);
  assert.equal(slow.healthLabel, "响应较慢");
  assert.equal(slow.phaseLabel, "等待模型响应");

  markRunPhase(state, "recovering", { connection: "recovering", retryAttempt: 1 }, startedAt + 4 * 60_000);
  const recovering = runActivityView(state, startedAt + 4 * 60_000 + 1_000);
  assert.equal(recovering.healthLabel, "恢复中");
  assert.match(recovering.upstreamLabel, /第 1 次/);

  markRunPhase(state, "error", { connection: "disconnected" }, startedAt + 5 * 60_000);
  const disconnected = runActivityView(state, startedAt + 5 * 60_000 + 1_000);
  assert.equal(disconnected.healthLabel, "连接中断");
  assert.equal(disconnected.connectionLabel, "已断开");
});

test("run activity card summary keeps the latest state visible and compact", () => {
  const startedAt = 3_000_000;
  const state = {
    startedAt,
    activity: createRunActivity(startedAt),
    blocks: [],
  };
  markModelEvent(state, "model_thinking", startedAt + 10_000);

  const markdown = renderRunActivityMarkdown(state, startedAt + 22_000);
  assert.match(markdown, /^\*\*当前状态\*\*/);
  assert.match(markdown, /运行状态：正常/);
  assert.match(markdown, /当前阶段：等待模型响应/);
  assert.match(markdown, /Codex 连接：正常/);
  assert.match(markdown, /任务总时长：22秒/);
  assert.doesNotMatch(markdown.replace(/^\*\*当前状态\*\*\n/, ""), /\*\*/);
  assert.ok(markdown.length < 300);
});

test("run activity accepts the card tool-name formatter", () => {
  const startedAt = 3_500_000;
  const state = {
    startedAt,
    activity: createRunActivity(startedAt),
    blocks: [],
  };
  const tool = {
    id: "tool-1",
    source: "command",
    name: "command_execution",
    status: "running",
  };
  state.blocks.push({ kind: "tool", tool });
  markToolStarted(state, tool, startedAt + 1_000);

  const markdown = renderRunActivityMarkdown(
    state,
    startedAt + 2_000,
    () => "PowerShell · command_execution",
  );
  assert.match(markdown, /当前工具：PowerShell · command_execution/);
  assert.match(markdown, /最近进展：1秒前 · 第 1 步 · PowerShell · command_execution 开始执行/);
  assert.doesNotMatch(markdown.replace(/^\*\*当前状态\*\*\n/, ""), /\*\*/);
});

test("run activity reports newer parallel completion without promoting an older running tool", () => {
  const startedAt = 4_000_000;
  const first = { id: "first", source: "Shell", name: "command_execution", status: "running" };
  const second = { id: "second", source: "Web", name: "web_search", status: "running" };
  const state = {
    startedAt,
    activity: createRunActivity(startedAt),
    blocks: [
      { kind: "tool", tool: first },
      { kind: "tool", tool: second },
    ],
  };

  markToolStarted(state, first, startedAt + 1_000);
  markToolStarted(state, second, startedAt + 2_000);
  markToolProgress(state, first, startedAt + 8_000);
  second.status = "done";
  markToolCompleted(state, second, startedAt + 10_000);

  const view = runActivityView(state, startedAt + 12_000);
  assert.equal(view.phaseLabel, "等待其余工具结果");
  assert.equal(view.currentTool, "");
  assert.equal(view.statusNote, "1 个较早工具尚未收到结束状态");
  assert.equal(view.upstreamLabel, "等待工具结果");
  assert.equal(view.healthLabel, "正常");
  assert.equal(view.phaseElapsed, "2秒");
  assert.match(view.recentProgress, /2秒前 · 第 2 步 · Web · web_search 执行完成/);
});

test("stale running tool cannot hide progress from later completed steps", () => {
  const startedAt = 4_500_000;
  const stale = { id: "stale", source: "Git", name: "command_execution", status: "running" };
  const later = { id: "later", source: "Shell", name: "command_execution", status: "running" };
  const state = {
    startedAt,
    activity: createRunActivity(startedAt),
    blocks: [
      { kind: "tool", tool: stale },
      { kind: "tool", tool: later },
    ],
  };

  markToolStarted(state, stale, startedAt + 1_000);
  markToolProgress(state, stale, startedAt + 2_000);
  markToolStarted(state, later, startedAt + 25 * 60_000);
  later.status = "done";
  markToolCompleted(state, later, startedAt + 25 * 60_000 + 10_000);

  const view = runActivityView(state, startedAt + 25 * 60_000 + 30_000);
  assert.equal(view.healthLabel, "正常");
  assert.equal(view.phaseLabel, "等待其余工具结果");
  assert.equal(view.currentTool, "");
  assert.equal(view.statusNote, "1 个较早工具尚未收到结束状态");
  assert.equal(view.phaseElapsed, "20秒");
  assert.equal(view.silenceMs, 20_000);
  assert.match(view.recentProgress, /20秒前 · 第 2 步 · Shell · command_execution 执行完成/);

  const markdown = renderRunActivityMarkdown(state, startedAt + 25 * 60_000 + 30_000);
  assert.match(markdown, /运行状态：正常/);
  assert.match(markdown, /当前阶段：等待其余工具结果/);
  assert.doesNotMatch(markdown, /当前工具：Git/);
  assert.match(markdown, /状态提示：1 个较早工具尚未收到结束状态/);
  assert.match(markdown, /最近进展：20秒前 · 第 2 步 · Shell · command_execution 执行完成/);
  assert.match(markdown, /本阶段：20秒/);
});

test("newer running step becomes the current tool despite an older unresolved tool", () => {
  const startedAt = 4_800_000;
  const stale = { id: "stale", source: "Git", name: "command_execution", status: "running" };
  const current = { id: "current", source: "Shell", name: "command_execution", status: "running" };
  const state = {
    startedAt,
    activity: createRunActivity(startedAt),
    blocks: [
      { kind: "tool", tool: stale },
      { kind: "tool", tool: current },
    ],
  };

  markToolStarted(state, stale, startedAt + 1_000);
  markToolProgress(state, stale, startedAt + 2_000);
  markToolStarted(state, current, startedAt + 30_000);

  const view = runActivityView(state, startedAt + 47_000);
  assert.equal(view.phaseLabel, "工具执行中");
  assert.equal(view.currentTool, "Shell · command_execution");
  assert.equal(view.statusNote, "1 个较早工具尚未收到结束状态");
  assert.equal(view.phaseElapsed, "17秒");
  assert.match(view.recentProgress, /17秒前 · 第 2 步 · Shell · command_execution 开始执行/);
});

test("newer model progress outranks an older unresolved tool", () => {
  const startedAt = 4_900_000;
  const stale = { id: "stale", source: "Git", name: "command_execution", status: "running" };
  const state = {
    startedAt,
    activity: createRunActivity(startedAt),
    blocks: [{ kind: "tool", tool: stale }],
  };
  markToolStarted(state, stale, startedAt + 1_000);
  markToolProgress(state, stale, startedAt + 2_000);
  markModelEvent(state, "model_streaming", startedAt + 60_000);

  const view = runActivityView(state, startedAt + 75_000);
  assert.equal(view.phaseLabel, "正在接收模型响应");
  assert.equal(view.currentTool, "");
  assert.equal(view.statusNote, "1 个较早工具尚未收到结束状态");
  assert.equal(view.phaseElapsed, "15秒");
  assert.match(view.recentProgress, /15秒前 · 收到模型事件/);
  assert.equal(view.upstreamLabel, "正在接收响应");
});

test("generic Codex events do not reset meaningful progress time", () => {
  const startedAt = 4_950_000;
  const state = {
    startedAt,
    activity: createRunActivity(startedAt),
    blocks: [],
  };
  markModelEvent(state, "model_thinking", startedAt + 10_000);
  markCodexEvent(state, startedAt + 5 * 60_000);

  const view = runActivityView(state, startedAt + 6 * 60_000);
  assert.equal(view.healthLabel, "响应较慢");
  assert.equal(view.silenceMs, 5 * 60_000 + 50_000);
  assert.match(view.recentProgress, /5分50秒前 · 收到模型事件/);
});

test("completed app-server tool events cannot remain visually running without a status", () => {
  assert.equal(appServerToolStatus({ type: "webSearch" }), "running");
  assert.equal(appServerToolStatus({ type: "webSearch" }, { completed: true }), "done");
  assert.equal(appServerToolStatus({ type: "webSearch", success: false }, { completed: true }), "error");
  assert.equal(appServerToolStatus({ type: "commandExecution", exitCode: 1 }, { completed: true }), "error");
});

test("long tool silence is not mislabeled as an upstream model delay", () => {
  const startedAt = 5_000_000;
  const tool = { id: "slow-tool", source: "Web", name: "web_search", status: "running" };
  const state = {
    startedAt,
    activity: createRunActivity(startedAt),
    blocks: [{ kind: "tool", tool }],
  };
  markToolStarted(state, tool, startedAt + 1_000);

  const quiet = runActivityView(state, startedAt + 3 * 60_000);
  assert.equal(quiet.healthLabel, "工具暂无新输出");
  assert.equal(quiet.upstreamLabel, "等待工具结果");

  const veryQuiet = runActivityView(state, startedAt + 11 * 60_000);
  assert.equal(veryQuiet.healthLabel, "工具长时间无输出");
});
