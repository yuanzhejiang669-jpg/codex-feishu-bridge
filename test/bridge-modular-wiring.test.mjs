import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createAttachmentManager } from "../src/feishu/attachments.mjs";
import { createPendingAttachmentStore } from "../src/attachments/pending.mjs";
import { createManagedCardClass } from "../src/feishu/cards/managed-card.mjs";
import { createProcessRunner } from "../src/runtime/process-runner.mjs";
import { createCodexSidebarSync } from "../src/codex/sidebar-sync.mjs";
import { createSessionInventory } from "../src/sessions/inventory.mjs";
import { createRunCardRenderer } from "../src/feishu/cards/run-card.mjs";
import { createCodexRunner } from "../src/codex/runner.mjs";
import { createCommandRouter } from "../src/commands/router.mjs";
import { createBridgeLifecycle } from "../src/runtime/lifecycle.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("T-018: codex-feishu-bridge.mjs stays modular and within <= 1500 lines", () => {
  const lines = fs.readFileSync(path.join(ROOT, "codex-feishu-bridge.mjs"), "utf8").split(/\r?\n/);
  assert.ok(lines.length <= 1500, `Expected <= 1500 lines, got ${lines.length}`);
});

test("T-018: extracted bridge modules have zero circular imports among themselves", () => {
  const moduleFiles = [
    "src/feishu/attachments.mjs",
    "src/codex/sidebar-sync.mjs",
    "src/sessions/inventory.mjs",
    "src/feishu/cards/run-card.mjs",
    "src/codex/runner.mjs",
    "src/commands/router.mjs",
    "src/runtime/lifecycle.mjs",
  ];
  const forbiddenTargets = [
    "/attachments.mjs",
    "/sidebar-sync.mjs",
    "/inventory.mjs",
    "/run-card.mjs",
    "/runner.mjs",
    "/router.mjs",
    "/lifecycle.mjs",
  ];
  for (const rel of moduleFiles) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const importLines = src.split(/\r?\n/).filter((l) => /^\s*import\b/.test(l)).join("\n");
    for (const target of forbiddenTargets) {
      assert.equal(
        importLines.includes(target),
        false,
        `${rel} must not directly import ${target} (use injected deps to avoid cycles)`,
      );
    }
  }
});

test("T-018: all 7 module factories wire cleanly and satisfy every cross-module deps reference", () => {
  const bridgeSrc = fs.readFileSync(path.join(ROOT, "codex-feishu-bridge.mjs"), "utf8");

  // Extract all keys declared in bridgeRuntime = { ... } and Object.assign(bridgeRuntime, { ... })
  const providedKeys = new Set();
  const runtimeStart = bridgeSrc.indexOf("const bridgeRuntime = {");
  const runtimeEnd = bridgeSrc.indexOf("};", runtimeStart);
  assert.ok(runtimeStart >= 0 && runtimeEnd > runtimeStart);
  for (const token of bridgeSrc.slice(runtimeStart + "const bridgeRuntime = {".length, runtimeEnd).split(/[,\s]+/)) {
    const clean = token.trim();
    if (/^[A-Za-z0-9_$]+$/.test(clean)) providedKeys.add(clean);
  }
  const assignStart = bridgeSrc.indexOf("Object.assign(bridgeRuntime, {");
  const assignEnd = bridgeSrc.indexOf("});", assignStart);
  assert.ok(assignStart >= 0 && assignEnd > assignStart);
  for (const token of bridgeSrc.slice(assignStart + "Object.assign(bridgeRuntime, {".length, assignEnd).split(/[,\s]+/)) {
    const clean = token.trim();
    if (/^[A-Za-z0-9_$]+$/.test(clean)) providedKeys.add(clean);
  }

  // Instantiate all 7 factories on a shared stub runtime and verify exported symbols
  const runtime = {
    CONFIG: { engine: "codex", workspace: ROOT, codexHome: ROOT, eventKeys: ["im.message.receive_v1"], larkCli: { command: "lark-cli", argsPrefix: [] }, codexCli: { command: "codex", argsPrefix: [] } },
    ENGINE_LABEL: "Codex",
    log: () => {},
    pendingAttachmentStore: {
      withAttachmentLock: async (_c, fn) => fn(),
      restore: () => {},
    },
  };
  const attachments = createAttachmentManager(runtime);
  Object.assign(runtime, attachments);
  const sidebarSync = createCodexSidebarSync(runtime);
  Object.assign(runtime, sidebarSync);
  const runCard = createRunCardRenderer(runtime);
  Object.assign(runtime, runCard);
  const inventory = createSessionInventory(runtime);
  Object.assign(runtime, inventory);
  const codexRunner = createCodexRunner(runtime);
  Object.assign(runtime, codexRunner);
  const commandRouter = createCommandRouter(runtime);
  Object.assign(runtime, commandRouter);
  const lifecycle = createBridgeLifecycle(runtime);
  Object.assign(runtime, lifecycle);

  for (const key of Object.keys(runtime)) providedKeys.add(key);

  // Spot-check V2 required factory exports
  for (const fn of ["syncCodexSidebarThread", "reconcileCodexDesktopSidebarIndexes", "scheduleSidebarReconcile", "deleteCodexLocalThread"]) {
    assert.equal(typeof sidebarSync[fn], "function", `sidebarSync missing ${fn}`);
  }
  for (const fn of ["downloadImageAttachments", "downloadFileAttachments", "prepareCommandAttachments", "buildPrompt", "withAttachmentLock", "takePendingAttachments", "restorePendingAttachments"]) {
    assert.equal(typeof attachments[fn], "function", `attachments missing ${fn}`);
  }
  for (const fn of ["runCodex", "runCodexAppServer", "startGoalRun", "maybeRouteMessageToGoal"]) {
    assert.equal(typeof codexRunner[fn], "function", `codexRunner missing ${fn}`);
  }
  for (const fn of ["handleCommand", "stopCurrentJob", "stopAllActiveJobs", "clearQueueCommand", "handleSteerCommand", "handleCompactCommand", "handleGoalCommand"]) {
    assert.equal(typeof commandRouter[fn], "function", `commandRouter missing ${fn}`);
  }
  for (const fn of ["startConsumer", "startSidebarReconciler", "startEventConsumer", "shutdown", "isShuttingDown"]) {
    assert.equal(typeof lifecycle[fn], "function", `lifecycle missing ${fn}`);
  }
  for (const fn of ["syncChatSessionsWithCodex", "effectiveSessionSettings", "mergedSessionEntries", "appendHistory"]) {
    assert.equal(typeof inventory[fn], "function", `inventory missing ${fn}`);
  }
  for (const fn of ["createRunState", "renderRunCard", "repairStaleActiveRunsOnStartup", "reduceAppServerEvent"]) {
    assert.equal(typeof runCard[fn], "function", `runCard missing ${fn}`);
  }

  // Verify every `deps.<key>` accessed inside all 7 modules is present in providedKeys
  const moduleFiles = [
    "src/feishu/attachments.mjs",
    "src/codex/sidebar-sync.mjs",
    "src/sessions/inventory.mjs",
    "src/feishu/cards/run-card.mjs",
    "src/codex/runner.mjs",
    "src/commands/router.mjs",
    "src/runtime/lifecycle.mjs",
  ];
  const missing = [];
  for (const rel of moduleFiles) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const destrMatch = src.match(/const\s*\{([\s\S]*?)\}\s*=\s*deps;/);
    if (destrMatch) {
      for (const token of destrMatch[1].split(/[,\s]+/)) {
        const clean = token.trim();
        if (/^[A-Za-z0-9_$]+$/.test(clean) && !providedKeys.has(clean)) {
          missing.push(`${rel}: ${clean}`);
        }
      }
    }
    for (const m of src.matchAll(/\bdeps\.([A-Za-z0-9_$]+)/g)) {
      if (!providedKeys.has(m[1])) {
        missing.push(`${rel}: deps.${m[1]}`);
      }
    }
  }
  assert.deepEqual(missing, [], `Unwired deps found: ${missing.join(", ")}`);
});

for (const engine of ["codex", "claude", "antigravity"]) {
  test(`T-018 live boot smoke: codex-feishu-bridge.mjs boots cleanly to starting bridge for engine=${engine}`, { timeout: 20_000 }, async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `cfb-boot-${engine}-`));
    t.after(() => {
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      } catch {
        // Windows child handle teardown race on temp dir cleanup
      }
    });
    const workspace = path.join(tmp, "ws");
    const stateDir = path.join(tmp, "state");
    const logDir = path.join(tmp, "logs");
    const codexHome = path.join(tmp, "codex-home");
    const fakeLarkScript = path.join(tmp, "fake-lark.mjs");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      fakeLarkScript,
      `
        process.stderr.write("[event] ready event_key=im.message.receive_v1\\n");
        const timer = setInterval(() => {}, 1000);
        process.on("SIGTERM", () => { clearInterval(timer); process.exit(0); });
        process.stdin.on("end", () => { clearInterval(timer); process.exit(0); });
        process.stdin.resume();
      `,
      "utf8",
    );
    const fakeLarkBin = path.join(tmp, process.platform === "win32" ? "fake-lark.cmd" : "fake-lark.sh");
    if (process.platform === "win32") {
      fs.writeFileSync(fakeLarkBin, `@echo off\r\n"${process.execPath}" "${fakeLarkScript}" %*\r\n`, "utf8");
    } else {
      fs.writeFileSync(fakeLarkBin, `#!/bin/sh\nexec "${process.execPath}" "${fakeLarkScript}" "$@"\n`, { encoding: "utf8", mode: 0o755 });
    }

    const child = spawn(process.execPath, [path.join(ROOT, "codex-feishu-bridge.mjs")], {
      cwd: workspace,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CODEX_FEISHU_ENGINE: engine,
        CODEX_FEISHU_WORKSPACE: workspace,
        CODEX_FEISHU_STATE_DIR: stateDir,
        CODEX_FEISHU_LOG_DIR: logDir,
        CODEX_HOME: codexHome,
        CLAUDE_CONFIG_DIR: codexHome,
        ANTIGRAVITY_CONFIG_DIR: codexHome,
        ANTIGRAVITY_BRIDGE_DATA_ROOT: tmp,
        CODEX_FEISHU_EVENT_KEYS: "im.message.receive_v1",
        LARK_CLI_BIN: fakeLarkBin,
      },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) break;
        if (stdout.includes("starting bridge") && stdout.includes("event consumer ready")) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(child.exitCode, null, `Bridge exited early for ${engine}: stderr=${stderr}\nstdout=${stdout}`);
      assert.match(stdout, /starting bridge/);
      assert.match(stdout, /event consumer ready/);
      assert.equal(stderr.includes("ReferenceError"), false, `Unexpected ReferenceError: ${stderr}`);

      // Trigger clean graceful shutdown via bridge.stop
      fs.writeFileSync(path.join(stateDir, "bridge.stop"), "stop\n", "utf8");
      const exited = await new Promise((resolve) => {
        const tmr = setTimeout(() => resolve(false), 8_000);
        child.once("close", (code) => { clearTimeout(tmr); resolve(code === 0); });
      });
      assert.equal(exited, true, `Bridge did not shut down cleanly on bridge.stop for ${engine}`);
    } finally {
      if (child.exitCode === null) {
        try { child.kill("SIGKILL"); } catch {}
      }
    }
  });
}

test("v0.10.14 regressions: attachments Object.assign has zero self-recursion, /steer works, command errors reply to Feishu, ManagedCard preserves flush failure, and ENOENT cleans activeChildren", async () => {
  // 1) P0-1: Attachment helpers survive Object.assign(runtime, attachments) without RangeError recursion, and /steer succeeds
  const store = createPendingAttachmentStore({ maxPendingAttachments: 12, pendingTtlMs: 60_000 });
  const cleared = [];
  const sentTexts = [];
  const sentMarkdowns = [];
  const steerRequests = [];
  const runtime = {
    CONFIG: { engine: "codex", workspace: ROOT, codexHome: ROOT, deleteConfirmTtlMs: 300_000 },
    ENGINE_LABEL: "Codex",
    log: () => {},
    pendingAttachmentStore: store,
    addPendingAttachments: store.add,
    cleanupPendingAttachments: store.cleanup,
    dropPendingAttachmentsByMessageId: store.dropByMessageId,
    dropPendingAttachmentsForMessage: store.dropForMessage,
    takePendingAttachments: store.take,
    withAttachmentLock: store.withAttachmentLock,
    cleanupClearedDownloads: (items) => cleared.push(...(items || [])),
    activeCodexJobs: new Map(),
    activeGoalRuns: new Map(),
    pendingDeleteConfirmations: new Map(),
    stoppedJobs: new Set(),
    sessions: { chats: { c1: { currentSessionId: "s1", sessions: [{ id: "s1", title: "Demo", messages: [] }] } } },
    saveSessions: () => {},
    recordChatScope: () => ({}),
    sendText: async (_c, text) => { sentTexts.push(text); },
    sendMarkdown: async (_c, md) => { sentMarkdowns.push(md); },
    appServerSteerParams: (threadId, turnId, _event, text) => ({ threadId, turnId, text }),
    appendHistory: () => {},
    clearPendingEventsForChat: () => ({ removedQueued: 0, cancelledPreflight: 0 }),
    queueSummary: () => "总队列 0",
  };
  const attachments = createAttachmentManager(runtime);
  Object.assign(runtime, attachments);

  // Calling every wrapped helper AFTER Object.assign must never recurse
  const realFile = path.join(ROOT, "package.json");
  await runtime.withAttachmentLock("c1", () => {
    runtime.addPendingAttachments("c1", [{ type: "image", path: realFile, messageId: "m1", receivedAt: Date.now() }]);
    assert.equal(runtime.cleanupPendingAttachments("c1").length, 1);
  });
  assert.equal(runtime.takePendingAttachments("c1").length, 1);
  runtime.restorePendingAttachments("c1", [{ type: "image", path: realFile, messageId: "m2", receivedAt: Date.now() }]);
  assert.equal(runtime.dropPendingAttachmentsForMessage("m2", "c1"), 1);
  assert.deepEqual(await runtime.dropPendingAttachmentsByMessageId("m3", "c1"), []);
  runtime.cleanupClearedDownloads([{ path: "x.tmp" }]);
  assert.equal(cleared.length, 1);

  const router = createCommandRouter(runtime);
  runtime.activeCodexJobs.set("c1", {
    mode: "app-server",
    threadId: "thr-1",
    turnId: "turn-1",
    sessionId: "s1",
    clearGeneration: 0,
    pendingSteerEntries: [],
    steerInFlight: null,
    client: {
      closed: false,
      request: async (method, params) => { steerRequests.push({ method, params }); return { turnId: "turn-2" }; },
    },
  });
  await router.handleCommand({ chat_id: "c1", message_id: "m-steer", content: "/steer 转成png" }, { name: "/steer", rest: "转成png" });
  assert.equal(steerRequests.length, 1);
  assert.equal(steerRequests[0].method, "turn/steer");
  assert.match(sentTexts.at(-1), /已将补充指令/);

  // 2) P0-2: Thrown validation errors in Claude/Antigravity handleCommand are caught and sent back to Feishu
  const agyRuntime = {
    ...runtime,
    CONFIG: { engine: "antigravity", workspace: ROOT },
    ENGINE_LABEL: "Antigravity",
    antigravityBridge: {
      handleCommand: async () => { throw new Error("思考强度无效，当前模型可用选项：low、high"); },
    },
  };
  const agyRouter = createCommandRouter(agyRuntime);
  await agyRouter.handleCommand({ chat_id: "c1", message_id: "m-err" }, { name: "/effort", rest: "bogus" });
  assert.match(sentMarkdowns.at(-1), /Antigravity 指令失败.*\/effort/);
  assert.match(sentMarkdowns.at(-1), /思考强度无效/);

  // 3) P1-2: /stopall waits on job.finished and accurately reports stopped count for Claude/Antigravity
  let resolveFinish;
  const finishPromise = new Promise((r) => { resolveFinish = r; });
  const stopRuntime = {
    ...runtime,
    CONFIG: { engine: "claude", workspace: ROOT },
    ENGINE_LABEL: "Claude Code",
    activeCodexJobs: new Map(),
    stoppedJobs: new Set(),
    terminateProcessTree: () => {},
  };
  stopRuntime.activeCodexJobs.set("c1", {
    mode: "claude",
    messageId: "m-run",
    finished: finishPromise,
    client: {
      interrupt: () => {
        setTimeout(() => {
          stopRuntime.activeCodexJobs.delete("c1");
          resolveFinish();
        }, 10);
      },
    },
  });
  const stopRouter = createCommandRouter(stopRuntime);
  await stopRouter.stopAllActiveJobs("c1", "m-stopall");
  assert.match(sentTexts.at(-1), /已停止全部 1 个运行中聊天任务/);

  // 4) P2-1: forgetDeleteConfirmationsForThread cleans batch/index confirmations
  runtime.pendingDeleteConfirmations.set("k-batch", {
    chatId: "c1",
    index: "1-2",
    items: [{ threadId: "thr-dead" }],
    expiresAt: Date.now() + 60_000,
  });
  router.forgetDeleteConfirmationsForThread("thr-dead");
  assert.equal(runtime.pendingDeleteConfirmations.has("k-batch"), false);

  // 5) P1-1: ManagedCard.flush() after failed flush + close() still returns false
  const ManagedCard = createManagedCardClass({
    larkJsonWithData: async () => { throw new Error("network down"); },
    findDeepKey: () => "",
    idempotencyKey: (a, b) => `${a}-${b}`,
    useThreadReply: false,
    cardThrottleMs: 100,
    log: () => {},
  });
  const card = new ManagedCard("card-1", "msg-1", "base-1");
  assert.equal(await card.flush({ schema: "2.0" }), false);
  card.close();
  assert.equal(await card.flush({ schema: "2.0" }), false);

  // 6) P2-5: process-runner ENOENT does not leak activeChildren[undefined]
  const activeChildren = new Map();
  const runner = createProcessRunner({ activeChildren, workspace: ROOT });
  await assert.rejects(
    runner.runTool({ command: "nonexistent-command-xyz-01014", argsPrefix: [] }, [], { timeoutMs: 5000 }),
  );
  assert.equal(activeChildren.size, 0);
});
