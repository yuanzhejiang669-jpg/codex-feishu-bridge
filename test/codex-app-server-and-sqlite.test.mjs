import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { AppServerClient, DEFAULT_MAX_LINE_BYTES } from "../src/codex/app-server-client.mjs";
import { classifyCodexFailure } from "../src/logging/errors.mjs";
import {
  deleteCodexThreadRows,
  sqliteExecTransaction,
  sqliteQueryAll,
  upsertCodexThreadRow,
} from "../src/codex/sqlite-store.mjs";

function createFakeChild({ closeDelayMs = 0 } = {}) {
  const child = new EventEmitter();
  child.pid = 424242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killedWith = [];
  child.kill = (signal) => {
    child.killedWith.push(signal);
    if (closeDelayMs >= 0) {
      setTimeout(() => child.emit("close", 0, signal), closeDelayMs);
    }
    return true;
  };
  return child;
}

test("AppServerClient decodes split multi-byte UTF-8 JSON chunks cleanly without U+FFFD corruption", async () => {
  const child = createFakeChild();
  const client = new AppServerClient({
    tool: { command: "codex", argsPrefix: [] },
    workspace: "C:\\work",
    spawnProcess: () => child,
  }).start();

  const text = "中文多字节UTF-8测试🚀✨与边界拆包验证";
  const payload = Buffer.from(`${JSON.stringify({ method: "item/agentMessage/delta", params: { delta: text } })}\n`, "utf8");
  for (let i = 0; i < payload.length; i += 2) {
    child.stdout.emit("data", payload.subarray(i, Math.min(i + 2, payload.length)));
  }

  const msg = await client.nextNotification(500);
  assert.equal(msg?.params?.delta, text);
  assert.equal(msg?.params?.delta.includes("\uFFFD"), false);
  await client.stop();
});

test("AppServerClient enforces maxLineBytes guard and stop() awaits child close", async () => {
  const child = createFakeChild({ closeDelayMs: 40 });
  const logs = [];
  const client = new AppServerClient({
    tool: { command: "codex", argsPrefix: [] },
    workspace: "C:\\work",
    stopGraceMs: 200,
    maxLineBytes: 64 * 1024,
    log: (level, message) => logs.push({ level, message }),
    spawnProcess: () => child,
  }).start();

  const stopStarted = Date.now();
  await client.stop();
  const elapsed = Date.now() - stopStarted;
  assert.equal(client.closed, true);
  assert.ok(elapsed >= 30, `expected stop() to await child close, elapsed=${elapsed}ms`);

  // Overflow guard test
  const child2 = createFakeChild({ closeDelayMs: 5 });
  const client2 = new AppServerClient({
    tool: { command: "codex", argsPrefix: [] },
    workspace: "C:\\work",
    stopGraceMs: 100,
    maxLineBytes: 64 * 1024,
    log: (level, message) => logs.push({ level, message }),
    spawnProcess: () => child2,
  }).start();

  const pendingReq = client2.request("thread/start", {}, 2000);
  child2.stdout.emit("data", Buffer.alloc(70 * 1024, 0x61)); // >64KiB with no newline
  await assert.rejects(pendingReq, /exceeded.*limit/);
  assert.ok(logs.some((entry) => entry.level === "ERROR" && /line limit/.test(entry.message)));
});

test("AppServerClient handles >16MiB multi-chunk JSON lines in linear time and classifies line-limit errors", async () => {
  assert.ok(DEFAULT_MAX_LINE_BYTES >= 128 * 1024 * 1024);
  const child = createFakeChild({ closeDelayMs: 5 });
  const client = new AppServerClient({
    tool: { command: "codex", argsPrefix: [] },
    workspace: "C:\\work",
    spawnProcess: () => child,
  }).start();

  const bigBlob = "x".repeat(18 * 1024 * 1024); // 18 MiB (> old 16 MiB cap)
  const payload = Buffer.from(`${JSON.stringify({ method: "thread/resumed", params: { blob: bigBlob } })}\n`, "utf8");
  const started = Date.now();
  const chunkSize = 64 * 1024;
  for (let i = 0; i < payload.length; i += chunkSize) {
    child.stdout.emit("data", payload.subarray(i, Math.min(i + chunkSize, payload.length)));
  }
  const msg = await client.nextNotification(5000);
  const elapsedMs = Date.now() - started;
  assert.equal(msg?.method, "thread/resumed");
  assert.equal(msg?.params?.blob?.length, bigBlob.length);
  assert.ok(elapsedMs < 5000, `expected linear-time framing for 18MiB line, got ${elapsedMs}ms`);
  await client.stop();

  const failure = classifyCodexFailure(new Error("codex app-server stdout line exceeded 134217728 bytes limit"));
  assert.equal(failure.kind, "app_server_line_limit");
  assert.match(failure.label, /单行事件输出超限/);
});

test("node:sqlite store handles quotes/SQL special chars safely without external sqlite3/python subprocesses", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-sqlite-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, "state_5.sqlite");

  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      title TEXT,
      first_user_message TEXT,
      preview TEXT,
      rollout_path TEXT,
      cwd TEXT,
      archived INTEGER DEFAULT 0
    );
    CREATE TABLE thread_dynamic_tools (thread_id TEXT, name TEXT);
    CREATE TABLE thread_goals (thread_id TEXT, objective TEXT);
    CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);
    CREATE TABLE agent_job_items (id TEXT, assigned_thread_id TEXT);
  `);
  db.close();

  const trickyId = "t_'DROP TABLE threads;--\"\\";
  const trickyTitle = "O'Brien's \"quoted\" ; DROP TABLE threads; 中文";
  upsertCodexThreadRow(dbPath, {
    id: trickyId,
    title: trickyTitle,
    first_user_message: "hello 'world'",
    preview: "preview; --",
    rollout_path: "C:\\tmp\\rollout.jsonl",
    cwd: "C:\\work\\it's",
    archived: 0,
  });

  sqliteExecTransaction(dbPath, [
    { sql: "INSERT INTO thread_dynamic_tools (thread_id, name) VALUES (?, ?);", params: [trickyId, "tool1"] },
    { sql: "INSERT INTO thread_goals (thread_id, objective) VALUES (?, ?);", params: [trickyId, "goal1"] },
    { sql: "INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id) VALUES (?, ?);", params: [trickyId, "child"] },
    { sql: "INSERT INTO agent_job_items (id, assigned_thread_id) VALUES (?, ?);", params: ["job1", trickyId] },
  ]);

  const rows = sqliteQueryAll(dbPath, "SELECT * FROM threads WHERE id = ?;", [trickyId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, trickyTitle);

  // Update via upsert on conflict
  upsertCodexThreadRow(dbPath, {
    id: trickyId,
    title: "Updated 'title'",
  });
  const updated = sqliteQueryAll(dbPath, "SELECT title FROM threads WHERE id = ?;", [trickyId]);
  assert.equal(updated[0].title, "Updated 'title'");

  // Parameterized atomic delete
  deleteCodexThreadRows(dbPath, trickyId);
  assert.equal(sqliteQueryAll(dbPath, "SELECT * FROM threads WHERE id = ?;", [trickyId]).length, 0);
  assert.equal(sqliteQueryAll(dbPath, "SELECT * FROM thread_dynamic_tools WHERE thread_id = ?;", [trickyId]).length, 0);
  assert.equal(sqliteQueryAll(dbPath, "SELECT * FROM thread_goals WHERE thread_id = ?;", [trickyId]).length, 0);
  assert.equal(sqliteQueryAll(dbPath, "SELECT * FROM thread_spawn_edges WHERE parent_thread_id = ?;", [trickyId]).length, 0);
  const jobItem = sqliteQueryAll(dbPath, "SELECT assigned_thread_id FROM agent_job_items WHERE id = ?;", ["job1"]);
  assert.equal(jobItem[0].assigned_thread_id, null);
});

test("bridge source removes sqlite3/python subprocess helpers, avoids model overwrite by userAgent, and deletes desktop mirror home", () => {
  const entrySource = fs.readFileSync(new URL("../codex-feishu-bridge.mjs", import.meta.url), "utf8");
  const sidebarSource = fs.readFileSync(new URL("../src/codex/sidebar-sync.mjs", import.meta.url), "utf8");
  const runnerSource = fs.readFileSync(new URL("../src/codex/runner.mjs", import.meta.url), "utf8");
  const combined = [entrySource, sidebarSource, runnerSource].join("\n");
  assert.doesNotMatch(combined, /\bSQLITE3_TOOL\b/);
  assert.doesNotMatch(combined, /\bPYTHON_SQLITE_JSON_SCRIPT\b/);
  assert.doesNotMatch(combined, /\bPYTHON_SQLITE_EXEC_SCRIPT\b/);
  assert.doesNotMatch(combined, /\bPYTHON_SQLITE_THREAD_UPSERT_SCRIPT\b/);
  assert.doesNotMatch(combined, /\bfunction shellQuote\b/);
  assert.doesNotMatch(combined, /\bfunction sqliteLiteral\b/);
  assert.doesNotMatch(combined, /\.meta\.model\s*=\s*initialized\.userAgent/);
  assert.match(runnerSource, /state\.meta\.runtimeUserAgent\s*=\s*initialized\.userAgent/);
  assert.match(runnerSource, /liveState\.meta\.runtimeUserAgent\s*=\s*initialized\.userAgent/);

  const delStart = sidebarSource.indexOf("async function deleteCodexLocalThread(");
  const delEnd = sidebarSource.indexOf("async function findCodexThreadIdForPrompt(", delStart);
  const delSource = sidebarSource.slice(delStart, delEnd);
  assert.match(delSource, /shouldMirrorDesktopCodexHome\s*&&\s*CONFIG\.desktopCodexHome/);
  assert.match(delSource, /homes\.push\(desktopHome\)/);
});
