import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  AppServerClient,
  DEFAULT_MAX_STDERR_BYTES,
  appServerRequestResult,
} from "../src/codex/app-server-client.mjs";
import { createAppServerPool } from "../src/codex/app-server-pool.mjs";
import { createAppServerProtocol } from "../src/codex/app-server-protocol.mjs";
import { createPendingAttachmentStore } from "../src/attachments/pending.mjs";
import { createEventDispatcher } from "../src/runtime/event-dispatcher.mjs";
import { createEventQueue } from "../src/runtime/event-queue.mjs";
import {
  createEventReplayGuard,
  eventTimestampMs,
  normalizeEventTimestamp,
} from "../src/runtime/event-replay-guard.mjs";
import { createRunWatchdog } from "../src/runtime/run-watchdog.mjs";
import { createSingleInstanceLock } from "../src/runtime/single-instance-lock.mjs";

test("app-server permission responses preserve the Bridge policy", () => {
  assert.deepEqual(
    appServerRequestResult("item/commandExecution/requestApproval", "C:\\work"),
    { decision: "accept" },
  );
  assert.deepEqual(
    appServerRequestResult("item/permissions/requestApproval", "C:\\work"),
    {
      permissions: {
        network: { enabled: true },
        fileSystem: { read: null, write: ["C:\\work"] },
      },
      scope: "turn",
    },
  );
  assert.deepEqual(appServerRequestResult("unknown/request", "C:\\work"), {});
});

test("app-server request is registered before a synchronous response arrives", async () => {
  const client = new AppServerClient({
    tool: { command: "codex", argsPrefix: [] },
    workspace: "C:\\work",
  });
  client.child = {
    stdin: {
      destroyed: false,
      write(line) {
        const request = JSON.parse(line);
        client.onStdout(Buffer.from(`${JSON.stringify({ id: request.id, result: { ok: true } })}\n`));
      },
    },
  };

  assert.deepEqual(await client.request("test/request", { value: 1 }, 1000), { ok: true });
  assert.equal(client.pending.size, 0);
});

test("app-server request rejects cleanly when the transport is unavailable", async () => {
  const client = new AppServerClient({
    tool: { command: "codex", argsPrefix: [] },
    workspace: "C:\\work",
  });

  await assert.rejects(client.request("test/request", undefined, 1000), /not running/);
  assert.equal(client.pending.size, 0);
});

test("app-server keeps only a bounded stderr tail for long-running turns", () => {
  const client = new AppServerClient({
    tool: { command: "codex", argsPrefix: [] },
    workspace: "C:\\work",
    maxStderrBytes: 1024,
  });
  client.appendStderr(Buffer.from(`prefix-${"x".repeat(1200)}`));

  assert.equal(DEFAULT_MAX_STDERR_BYTES, 1024 * 1024);
  assert.equal(Buffer.byteLength(client.stderrText()), 1024);
  assert.equal(client.stderrText(), "x".repeat(1024));
});

test("app-server can discard stale buffered notifications before a pooled turn", () => {
  const client = new AppServerClient({
    tool: { command: "codex", argsPrefix: [] },
    workspace: "C:\\work",
  });
  client.notifications.push({ method: "turn/completed" }, { method: "thread/status/changed" });
  assert.equal(client.drainNotifications(), 2);
  assert.deepEqual(client.notifications, []);
  assert.equal(client.drainNotifications(), 0);
});

test("app-server normal close cancels forced process-tree termination", async () => {
  let forcedPid = 0;
  const child = new EventEmitter();
  child.pid = 707;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.emit("close", 0, null);
    return true;
  };
  const client = new AppServerClient({
    tool: { command: "codex", argsPrefix: [] },
    workspace: "C:\\work",
    stopGraceMs: 10,
    spawnProcess: () => child,
    terminateProcessTree: (pid) => {
      forcedPid = pid;
    },
  }).start();

  await client.stop();
  await delay(25);
  assert.equal(client.closed, true);
  assert.equal(forcedPid, 0);
});

test("app-server pool reuses one initialized client and evicts it after idle TTL", async () => {
  let processId = 900;
  let initializeCount = 0;
  const stopped = [];
  const timers = [];
  const pool = createAppServerPool({
    maxSize: 1,
    idleTtlMs: 1000,
    createClient: () => ({
      child: { pid: processId += 1 },
      closed: false,
      async stop() {
        this.closed = true;
        stopped.push(this.child.pid);
      },
    }),
    setTimer: (callback, timeoutMs) => {
      const timer = { callback, timeoutMs, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
  });

  const first = await pool.acquire();
  const firstPid = first.client.child.pid;
  const cold = await first.ensureInitialized(async () => {
    initializeCount += 1;
    return { userAgent: "test" };
  });
  assert.equal(cold.warm, false);
  await first.release();

  const second = await pool.acquire();
  assert.equal(second.client.child.pid, firstPid);
  const warm = await second.ensureInitialized(async () => {
    initializeCount += 1;
    return {};
  });
  assert.equal(warm.warm, true);
  assert.equal(initializeCount, 1);
  await second.release();

  assert.equal(timers.length, 1);
  await timers[0].callback();
  await waitFor(() => stopped.length === 1);
  assert.deepEqual(stopped, [firstPid]);
  assert.equal(pool.stats().size, 0);
});

test("app-server pool never leases one client to two jobs concurrently", async () => {
  let processId = 1000;
  const pool = createAppServerPool({
    maxSize: 1,
    idleTtlMs: 1000,
    createClient: () => ({
      child: { pid: processId += 1 },
      closed: false,
      async stop() {
        this.closed = true;
      },
    }),
  });

  const first = await pool.acquire();
  let secondResolved = false;
  const secondPromise = pool.acquire().then((lease) => {
    secondResolved = true;
    return lease;
  });
  await delay(10);
  assert.equal(secondResolved, false);
  assert.equal(pool.stats().waiting, 1);

  await first.release();
  const second = await secondPromise;
  assert.equal(second.client.child.pid, first.client.child.pid);
  await second.release({ discard: true });
  await pool.closeAll();
});

test("app-server pool discards failed clients and cold-starts a replacement", async () => {
  let processId = 1100;
  const pool = createAppServerPool({
    maxSize: 1,
    idleTtlMs: 1000,
    createClient: () => ({
      child: { pid: processId += 1 },
      closed: false,
      async stop() {
        this.closed = true;
      },
    }),
  });

  const first = await pool.acquire();
  const firstPid = first.client.child.pid;
  await first.release({ discard: true, reason: "test-failure" });
  const second = await pool.acquire();
  assert.notEqual(second.client.child.pid, firstPid);
  await second.release({ discard: true });
  await pool.closeAll();
});

test("event replay guard recognizes Feishu seconds, milliseconds, and ISO timestamps", () => {
  const expected = Date.UTC(2026, 6, 27, 1, 2, 3);
  assert.equal(normalizeEventTimestamp(expected), expected);
  assert.equal(normalizeEventTimestamp(Math.floor(expected / 1000)), Math.floor(expected / 1000) * 1000);
  assert.equal(normalizeEventTimestamp(new Date(expected).toISOString()), expected);
  assert.equal(eventTimestampMs({ event: { message: { create_time: String(Math.floor(expected / 1000)) } } }), Math.floor(expected / 1000) * 1000);
});

test("event replay guard skips only events older than the startup grace window", () => {
  const startedAt = 2_000_000;
  const guard = createEventReplayGuard({
    startedAt,
    graceMs: 120_000,
    timestampOf: (event) => event.timestampMs || 0,
  });
  assert.equal(guard.shouldSkip({ timestampMs: startedAt - 120_001 }), true);
  assert.equal(guard.shouldSkip({ timestampMs: startedAt - 120_000 }), false);
  assert.equal(guard.shouldSkip({ timestampMs: startedAt + 1_000 }), false);
  assert.equal(guard.shouldSkip({}), false);
});

test("app-server protocol preserves thread and turn request contracts", () => {
  const protocol = createTestProtocol();
  const session = { codexThreadId: "thread-1" };
  const event = { message_id: "message-1", content: "fallback" };

  assert.deepEqual(protocol.startParams(session), {
    cwd: "C:\\work",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    threadSource: "user",
    config: { mcp_servers: {} },
    serviceName: "codex-feishu-bridge",
    threadOverrideApplied: true,
  });
  assert.deepEqual(protocol.resumeParams(session), {
    threadId: "thread-1",
    cwd: "C:\\work",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    config: { mcp_servers: {} },
    threadOverrideApplied: true,
  });
  assert.deepEqual(protocol.turnParams("thread-1", event, "hello", session), {
    threadId: "thread-1",
    input: [{ type: "text", text: "hello", text_elements: [] }],
    clientUserMessageId: "message-1",
    cwd: "C:\\work",
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
    turnOverrideApplied: true,
  });
});

test("app-server protocol keeps attachment context in user text", () => {
  const protocol = createTestProtocol();
  const event = {
    content: "fallback",
    attachments: [{ type: "file", name: "report.txt" }],
  };

  assert.equal(protocol.userText(event, "review this"), "review this\n\n[1 attachment]");
  assert.deepEqual(protocol.inputItems(event, "review this"), [
    { type: "text", text: "review this\n\n[1 attachment]", text_elements: [] },
  ]);
});

test("event queue keeps chat-scoped removal and summaries isolated", () => {
  const queue = createEventQueue({
    chatIdOf: (event) => event.chatId || "",
    messageIdOf: (event) => event.messageId || "",
  });
  queue.enqueue({ chatId: "chat-a", messageId: "a-1" });
  queue.enqueue({ chatId: "chat-b", messageId: "b-1" });
  queue.enqueue({ messageId: "unknown-1" });

  assert.equal(queue.length, 3);
  assert.equal(queue.countForChat("chat-a"), 1);
  assert.equal(queue.summary("chat-a"), "总队列 3，当前聊天 1，未知聊天 1");
  assert.equal(queue.removeByMessageId("a-1"), 1);
  assert.equal(queue.clearForChat("chat-b"), 1);
  assert.deepEqual(queue.dequeue(), { messageId: "unknown-1" });
  assert.equal(queue.length, 0);
});

test("event queue can clear every queued chat explicitly", () => {
  const queue = createEventQueue({
    chatIdOf: (event) => event.chatId || "",
    messageIdOf: (event) => event.messageId || "",
  });
  queue.enqueue({ chatId: "chat-a", messageId: "a-1" });
  queue.enqueue({ chatId: "chat-b", messageId: "b-1" });

  assert.equal(queue.clearForChat("", { all: true }), 2);
  assert.equal(queue.length, 0);
});

test("event dispatcher preserves concurrency, queue acknowledgements, and FIFO order", async () => {
  const handled = [];
  const acknowledgements = [];
  let releaseFirst;
  const firstDone = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const dispatcher = createEventDispatcher({
    maxConcurrent: 1,
    chatIdOf: (event) => event.chatId || "",
    messageIdOf: (event) => event.messageId || "",
    handleEvent: async (event) => {
      handled.push(event.messageId);
      if (event.messageId === "first") await firstDone;
    },
    acknowledgeQueued: async (event, ahead) => {
      acknowledgements.push({ messageId: event.messageId, ahead });
    },
  });

  dispatcher.enqueue({ chatId: "chat-a", messageId: "first" });
  dispatcher.enqueue({ chatId: "chat-a", messageId: "second" });
  assert.deepEqual(handled, ["first"]);
  assert.deepEqual(acknowledgements, [{ messageId: "second", ahead: 1 }]);
  assert.equal(dispatcher.activeJobs, 1);
  assert.equal(dispatcher.pendingCount, 1);

  releaseFirst();
  await waitFor(() => handled.length === 2);
  assert.deepEqual(handled, ["first", "second"]);
  await waitFor(() => dispatcher.activeJobs === 0);
});

test("event dispatcher treats invalid concurrency as one worker", async () => {
  let handled = 0;
  const dispatcher = createEventDispatcher({
    maxConcurrent: 0,
    chatIdOf: () => "chat-a",
    messageIdOf: () => "message-1",
    handleEvent: async () => {
      handled += 1;
    },
  });

  dispatcher.enqueue({});
  await waitFor(() => handled === 1 && dispatcher.activeJobs === 0);
  assert.equal(dispatcher.pendingCount, 0);
});

test("event dispatcher continues after a queued job rejects", async () => {
  const handled = [];
  const errors = [];
  const dispatcher = createEventDispatcher({
    maxConcurrent: 1,
    chatIdOf: () => "chat-a",
    messageIdOf: (event) => event.messageId,
    handleEvent: async (event) => {
      handled.push(event.messageId);
      if (event.messageId === "first") throw new Error("injected failure");
    },
    log: (level, message) => errors.push({ level, message }),
  });

  dispatcher.enqueue({ messageId: "first" });
  dispatcher.enqueue({ messageId: "second" });
  await waitFor(() => handled.length === 2 && dispatcher.activeJobs === 0);
  assert.deepEqual(handled, ["first", "second"]);
  assert.deepEqual(errors, [{ level: "ERROR", message: "event handling failed" }]);
});

test("event dispatcher clear cancels a queued event already in preflight", async () => {
  const phases = [];
  let releaseFirst;
  let releasePreflight;
  let enterPreflight;
  const firstDone = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const preflightDone = new Promise((resolve) => {
    releasePreflight = resolve;
  });
  const preflightEntered = new Promise((resolve) => {
    enterPreflight = resolve;
  });
  const dispatcher = createEventDispatcher({
    maxConcurrent: 1,
    chatIdOf: (event) => event.chatId,
    messageIdOf: (event) => event.messageId,
    handleEvent: async (event, control) => {
      if (event.messageId === "first") {
        phases.push("first");
        await firstDone;
        assert.equal(control.commit(), true);
        return;
      }
      phases.push("second-preflight");
      enterPreflight();
      await preflightDone;
      if (!control.commit()) {
        phases.push("second-cleared");
        return;
      }
      phases.push("second-committed");
    },
  });

  dispatcher.enqueue({ chatId: "chat-a", messageId: "first" });
  dispatcher.enqueue({ chatId: "chat-a", messageId: "second" });
  releaseFirst();
  await preflightEntered;
  assert.equal(dispatcher.clearForChat("chat-a"), 1);
  assert.equal(dispatcher.pendingCount, 0);
  releasePreflight();
  await waitFor(() => dispatcher.activeJobs === 0);
  assert.deepEqual(phases, ["first", "second-preflight", "second-cleared"]);
});

test("event dispatcher clear does not cancel a queued event after commit", async () => {
  let releaseCommitted;
  let reportCommitted;
  const committedDone = new Promise((resolve) => {
    releaseCommitted = resolve;
  });
  const committed = new Promise((resolve) => {
    reportCommitted = resolve;
  });
  const dispatcher = createEventDispatcher({
    maxConcurrent: 1,
    chatIdOf: (event) => event.chatId,
    messageIdOf: (event) => event.messageId,
    handleEvent: async (event, control) => {
      assert.equal(control.commit(), true);
      if (event.messageId === "second") {
        reportCommitted();
        await committedDone;
      }
    },
  });

  dispatcher.enqueue({ chatId: "chat-a", messageId: "first" });
  dispatcher.enqueue({ chatId: "chat-a", messageId: "second" });
  await committed;
  assert.equal(dispatcher.clearForChat("chat-a"), 0);
  releaseCommitted();
  await waitFor(() => dispatcher.activeJobs === 0);
});

test("event dispatcher recall cancels an uncommitted event in preflight", async () => {
  let releasePreflight;
  let enterPreflight;
  const preflightDone = new Promise((resolve) => {
    releasePreflight = resolve;
  });
  const preflightEntered = new Promise((resolve) => {
    enterPreflight = resolve;
  });
  let committed = false;
  const dispatcher = createEventDispatcher({
    maxConcurrent: 1,
    chatIdOf: (event) => event.chatId,
    messageIdOf: (event) => event.messageId,
    handleEvent: async (_event, control) => {
      enterPreflight();
      await preflightDone;
      committed = control.commit();
    },
  });

  dispatcher.enqueue({ chatId: "chat-a", messageId: "message-1" });
  await preflightEntered;
  assert.equal(dispatcher.removeByMessageId("message-1"), 1);
  releasePreflight();
  await waitFor(() => dispatcher.activeJobs === 0);
  assert.equal(committed, false);
});

test("event dispatcher clear is idempotent and all mode includes cross-chat preflight", async () => {
  let releaseFirst;
  let releasePreflight;
  let enterPreflight;
  const firstDone = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const preflightDone = new Promise((resolve) => {
    releasePreflight = resolve;
  });
  const preflightEntered = new Promise((resolve) => {
    enterPreflight = resolve;
  });
  let thirdCommitted = null;
  const dispatcher = createEventDispatcher({
    maxConcurrent: 1,
    chatIdOf: (event) => event.chatId,
    messageIdOf: (event) => event.messageId,
    handleEvent: async (event, control) => {
      if (event.messageId === "first") {
        await firstDone;
        assert.equal(control.commit(), true);
        return;
      }
      enterPreflight();
      await preflightDone;
      thirdCommitted = control.commit();
    },
  });

  dispatcher.enqueue({ chatId: "chat-current", messageId: "first" });
  dispatcher.enqueue({ chatId: "chat-a", messageId: "second" });
  dispatcher.enqueue({ chatId: "chat-b", messageId: "third" });
  assert.equal(dispatcher.clearForChat("chat-a"), 1);
  assert.equal(dispatcher.clearForChat("chat-a"), 0);
  assert.equal(dispatcher.summary("chat-a"), "总队列 1，当前聊天 0");

  releaseFirst();
  await preflightEntered;
  assert.equal(dispatcher.clearForChat("", { all: true }), 1);
  assert.equal(dispatcher.clearForChat("", { all: true }), 0);
  releasePreflight();
  await waitFor(() => dispatcher.activeJobs === 0);
  assert.equal(thirdCommitted, false);
});

test("event dispatcher exposes in-flight work for session mutation guards", async () => {
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const dispatcher = createEventDispatcher({
    maxConcurrent: 1,
    chatIdOf: (event) => event.chatId,
    messageIdOf: (event) => event.messageId,
    handleEvent: async () => blocker,
  });
  dispatcher.enqueue({ chatId: "chat-a", messageId: "active" });
  dispatcher.enqueue({ chatId: "chat-a", messageId: "queued" });
  await waitFor(() => dispatcher.activeJobs === 1);
  assert.equal(dispatcher.countForChat("chat-a"), 1);
  assert.equal(dispatcher.workCountForChat("chat-a"), 2);
  release();
  await waitFor(() => dispatcher.activeJobs === 0);
  assert.equal(dispatcher.workCountForChat("chat-a"), 0);
});

test("run watchdog distinguishes idle timeout and supports progress touches", async () => {
  let reason = "";
  const watchdog = createRunWatchdog("test run", (value) => {
    reason = value;
  }, { idleMs: 40 });

  await delay(25);
  watchdog.touch();
  await delay(25);
  assert.equal(watchdog.timedOut, false);
  await delay(30);
  assert.equal(watchdog.timedOut, true);
  assert.match(reason, /idle timed out/);
  watchdog.clear();
});

test("single-instance lock rejects a live owner and only the owner can release", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-lock-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lockPath = path.join(directory, "bridge.lock.json");
  const pidPath = path.join(directory, "bridge.pid");
  fs.writeFileSync(pidPath, "101", "utf8");
  const first = createSingleInstanceLock({
    lockPath,
    pidPath,
    owner: { pid: 101, instance: "first" },
    processAlive: () => true,
  });
  assert.equal(first.acquire(), true);

  let duplicate = null;
  const second = createSingleInstanceLock({
    lockPath,
    pidPath,
    owner: { pid: 202, instance: "second" },
    processAlive: () => true,
    onDuplicate: (current) => {
      duplicate = current;
    },
  });
  assert.equal(second.acquire(), false);
  assert.equal(duplicate.instance, "first");
  assert.equal(second.release(), false);
  assert.equal(fs.existsSync(lockPath), true);
  assert.equal(first.release(), true);
  assert.equal(fs.existsSync(lockPath), false);
});

test("single-instance lock replaces a stale owner", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-stale-lock-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lockPath = path.join(directory, "bridge.lock.json");
  const pidPath = path.join(directory, "bridge.pid");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 303, instance: "stale" }), "utf8");
  fs.writeFileSync(pidPath, "303", "utf8");
  const current = createSingleInstanceLock({
    lockPath,
    pidPath,
    owner: { pid: 404, instance: "current" },
    processAlive: () => false,
  });

  assert.equal(current.acquire(), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, "utf8")), {
    pid: 404,
    instance: "current",
  });
});

test("single-instance lock fails instead of spinning when a stale lock cannot be removed", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-blocked-lock-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lockPath = path.join(directory, "bridge.lock.json");
  const pidPath = path.join(directory, "bridge.pid");
  fs.mkdirSync(lockPath);
  const lock = createSingleInstanceLock({
    lockPath,
    pidPath,
    owner: { pid: 505, instance: "current" },
    processAlive: () => false,
  });

  assert.throws(() => lock.acquire(), /Unable to remove stale Bridge lock/);
});

test("workspace factory and runtime keep distinct Codex homes isolated", () => {
  const bridgeSource = fs.readFileSync(new URL("../codex-feishu-bridge.mjs", import.meta.url), "utf8");
  const panelSource = fs.readFileSync(new URL("../control-panel.mjs", import.meta.url), "utf8");
  const factoryStart = panelSource.indexOf("function buildFactoryPreview(payload)");
  const factoryEnd = panelSource.indexOf("function resolveLarkCliTool()", factoryStart);
  const factorySource = panelSource.slice(factoryStart, factoryEnd);

  assert.match(bridgeSource, /DESKTOP_CODEX_HOME_PATH[\s\S]*sameResolvedPath/);
  assert.doesNotMatch(factorySource, /--desktop-codex-home|-DesktopCodexHome/);
  assert.match(factorySource, /desktopCodexHome:\s*""/);
  assert.match(panelSource, /planSharedSkill/);
  assert.match(panelSource, /action:\s*"link-dir"/);
  assert.match(panelSource, /skill\.name === "\.system"/);
  assert.doesNotMatch(panelSource, /await cp\(source, target, \{ recursive: true/);
});

test("explicit steer stays out of the ordinary queue and never starts a replacement turn", () => {
  const bridgeSource = fs.readFileSync(new URL("../codex-feishu-bridge.mjs", import.meta.url), "utf8");
  const handlerStart = bridgeSource.indexOf("async function handleSteerCommand(");
  const handlerEnd = bridgeSource.indexOf("async function handleCompactCommand(", handlerStart);
  const handlerSource = bridgeSource.slice(handlerStart, handlerEnd);

  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  assert.match(bridgeSource, /case "\/steer":[\s\S]*handleSteerCommand/);
  assert.match(handlerSource, /"turn\/steer"/);
  assert.doesNotMatch(handlerSource, /"turn\/start"/);
  assert.match(handlerSource, /activeCodexJobs\.get\(chatId\) !== job/);
  assert.match(handlerSource, /job\.steerInFlight/);
  assert.match(handlerSource, /takePendingAttachments\(chatId\)/);
  assert.match(handlerSource, /addPendingAttachments\(chatId, steerAttachments\)/);
  assert.match(bridgeSource, /async function prepareCommandAttachments\(/);
  assert.match(bridgeSource, /handleOutOfBandCommand[\s\S]*prepareCommandAttachments\(event, command\)[\s\S]*handleCommand\(event, command\)/);
  assert.match(bridgeSource, /if \(command\)[\s\S]*prepareCommandAttachments\(event, command\)[\s\S]*handleCommand\(event, command\)/);
  assert.match(bridgeSource, /command\?\.name !== "\/steer"/);
  assert.match(bridgeSource, /downloadImageAttachments\(event\)/);
  assert.match(bridgeSource, /downloadFileAttachments\(event\)/);
  assert.match(bridgeSource, /image download reported success without a saved file/);
  assert.match(bridgeSource, /file download reported success without a saved file/);
  assert.match(handlerSource, /downloadFailures/);
  assert.match(bridgeSource, /`\/steer <补充内容>`/);
});

test("Pi control commands route through the engine registry without entering Codex job maps", () => {
  const bridgeSource = fs.readFileSync(new URL("../codex-feishu-bridge.mjs", import.meta.url), "utf8");
  const stopStart = bridgeSource.indexOf("async function stopCurrentJob(");
  const steerStart = bridgeSource.indexOf("async function handleSteerCommand(", stopStart);
  const compactStart = bridgeSource.indexOf("async function handleCompactCommand(", steerStart);
  const helpStart = bridgeSource.indexOf("async function handleHelpCommand(", compactStart);
  const stopSource = bridgeSource.slice(stopStart, steerStart);
  const steerSource = bridgeSource.slice(steerStart, compactStart);
  const compactSource = bridgeSource.slice(compactStart, helpStart);

  assert.match(stopSource, /session\.engine === "pi"[\s\S]*agentEngineRegistry\.get\(session\.engine\)\.abort\(session\)/);
  assert.match(steerSource, /session\.engine === "pi"[\s\S]*agentEngineRegistry\.get\(session\.engine\)\.steer\(session/);
  assert.match(compactSource, /session\.engine === "pi"[\s\S]*adapter\.status\(session\)[\s\S]*adapter\.compact\(session\)/);
  assert.match(stopSource, /activeCodexJobs\.get\(chatId\)/);
  assert.match(steerSource, /activeCodexJobs\.get\(chatId\)/);
});

test("Pi status avoids Codex runtime fields and reports the Pi adapter configuration", () => {
  const bridgeSource = fs.readFileSync(new URL("../codex-feishu-bridge.mjs", import.meta.url), "utf8");
  const statusSource = bridgeSource.slice(
    bridgeSource.indexOf("async function statusMarkdown"),
    bridgeSource.indexOf("function failureStatsSummary"),
  );
  assert.match(statusSource, /currentSession\.engine === "pi"[\s\S]*piStatusMarkdown/);
  assert.match(statusSource, /agentEngineRegistry\.get\("pi"\)\.status\(session\)/);
  assert.match(statusSource, /Pi Agent Home[\s\S]*piSessionSelection\(session\)\.provider[\s\S]*piSessionSelection\(session\)\.model/);
  const piStatusSource = statusSource.slice(statusSource.indexOf("async function piStatusMarkdown"));
  assert.doesNotMatch(piStatusSource, /readCodexRuntimeVersionStatus|syncChatSessionsWithCodex|Codex Home|Codex CLI/);
});

test("common engine completion finalizes cards and uses the session engine label", () => {
  const bridgeSource = fs.readFileSync(new URL("../codex-feishu-bridge.mjs", import.meta.url), "utf8");
  const dispatchOffset = bridgeSource.indexOf("const result = await agentEngineRegistry.get(session.engine).run");
  const completionSource = bridgeSource.slice(dispatchOffset, bridgeSource.indexOf("appendHistory(session, \"user\"", dispatchOffset));
  assert.match(completionSource, /syncRunContextMeta\(cardState\)[\s\S]*ensureRunDone\(cardState, result\.text\)[\s\S]*await updateCard\(cardState\)[\s\S]*await cardOpenPromise/);
  const titleSource = bridgeSource.slice(bridgeSource.indexOf("function cardTitle"), bridgeSource.indexOf("function cardSummary"));
  assert.match(titleSource, /agentEngineLabel\(state\.session\?\.engine\)/);
  assert.match(titleSource, /`\$\{label\} 已完成`/);
  assert.doesNotMatch(titleSource.slice(titleSource.indexOf("const label")), /Codex 正在回复|Codex 已完成/);
  const answerSource = bridgeSource.slice(bridgeSource.indexOf("function formatAnswer("), bridgeSource.indexOf("function formatDuration("));
  assert.match(answerSource, /agentEngineLabel\(session\?\.engine\)/);
  assert.match(answerSource, /piSessionSelection\(session\)[\s\S]*thinking \$\{piSelection\.thinking\}/);
});

test("Pi completion cards use Pi context and compaction metadata", () => {
  const bridgeSource = fs.readFileSync(new URL("../codex-feishu-bridge.mjs", import.meta.url), "utf8");
  const metaStart = bridgeSource.indexOf("function engineContextMeta(");
  const metaEnd = bridgeSource.indexOf("function appendRunText(", metaStart);
  const metaSource = bridgeSource.slice(metaStart, metaEnd);
  assert.ok(metaStart >= 0 && metaEnd > metaStart);
  assert.match(metaSource, /session\?\.engine === "pi"/);
  assert.match(metaSource, /session\.piContextUsage/);
  assert.match(metaSource, /session\.piContextPeakUsage/);
  assert.match(metaSource, /session\.piCompactedAt/);
  const cardSource = bridgeSource.slice(
    bridgeSource.indexOf("function renderRunCard("),
    bridgeSource.indexOf("function renderContextUsage("),
  );
  assert.match(cardSource, /piRunIdentity\(state\.session\)/);
  assert.match(cardSource, /selection\.provider[\s\S]*selection\.model[\s\S]*selection\.thinking/);
});

test("Pi session commands never scan or mutate Codex thread inventory", () => {
  const bridgeSource = fs.readFileSync(new URL("../codex-feishu-bridge.mjs", import.meta.url), "utf8");
  const listStart = bridgeSource.indexOf("async function listChatSessionsSynced(");
  const listEnd = bridgeSource.indexOf("async function findSessionEntry(", listStart);
  const listSource = bridgeSource.slice(listStart, listEnd);
  assert.match(listSource, /CONFIG\.agentEngine === "pi"\) return listPiChatSessions\(chatId\)/);
  assert.ok(listSource.indexOf("listPiChatSessions(chatId)") < listSource.indexOf("syncChatSessionsWithCodex(chatId)"));

  const sessionsStart = bridgeSource.indexOf("async function sessionsMarkdown(");
  const sessionsEnd = bridgeSource.indexOf("function piSessionsMarkdown(", sessionsStart);
  const sessionsSource = bridgeSource.slice(sessionsStart, sessionsEnd);
  assert.match(sessionsSource, /CONFIG\.agentEngine === "pi"\) return piSessionsMarkdown\(chatId\)/);

  const resetStart = bridgeSource.indexOf("async function resetCurrentSession(");
  const resetEnd = bridgeSource.indexOf("function normalizeSessionData(", resetStart);
  const resetSource = bridgeSource.slice(resetStart, resetEnd);
  assert.match(resetSource, /current\.engine === "pi"[\s\S]*\.resetSession\(current\)/);

  const deleteStart = bridgeSource.indexOf("async function handleDeleteCommand(");
  const deleteEnd = bridgeSource.indexOf("async function handleConfirmCommand(", deleteStart);
  const deleteSource = bridgeSource.slice(deleteStart, deleteEnd);
  assert.match(deleteSource, /CONFIG\.agentEngine === "pi"[\s\S]*handlePiDeleteCommand/);
});

test("Pi model commands use Pi RPC handlers while remaining Codex-private commands stay isolated", () => {
  const bridgeSource = fs.readFileSync(new URL("../codex-feishu-bridge.mjs", import.meta.url), "utf8");
  const commandStart = bridgeSource.indexOf("async function handleCommand(");
  const commandEnd = bridgeSource.indexOf("async function handlePiPrivateCommand(", commandStart);
  const commandSource = bridgeSource.slice(commandStart, commandEnd);
  for (const [command, handler] of [
    ["/goal", "handleGoalCommand"],
    ["/fast", "handleFastCommand"],
  ]) {
    const offset = commandSource.indexOf(`case "${command}"`);
    const nextCase = commandSource.indexOf("case \"/", offset + 8);
    const block = commandSource.slice(offset, nextCase >= 0 ? nextCase : commandSource.length);
    assert.match(block, /handlePiPrivateCommand/);
    assert.ok(block.indexOf("handlePiPrivateCommand") < block.indexOf(handler));
  }
  for (const [command, piHandler, codexHandler] of [
    ["/provider", "handlePiProviderCommand", "handleProviderCommand"],
    ["/model", "handlePiModelCommand", "handleModelCommand"],
  ]) {
    const offset = commandSource.indexOf(`case "${command}"`);
    const nextCase = commandSource.indexOf("case \"/", offset + 8);
    const block = commandSource.slice(offset, nextCase >= 0 ? nextCase : commandSource.length);
    assert.match(block, new RegExp(piHandler));
    assert.ok(block.indexOf(piHandler) < block.indexOf(codexHandler));
  }
  assert.match(bridgeSource, /async function handlePiProviderCommand[\s\S]*adapter\.listProviders\(\)[\s\S]*adapter\.listModels\(session, targetProvider\)[\s\S]*switchPiSessionModel/);
  assert.match(bridgeSource, /async function handlePiModelCommand[\s\S]*adapter\.getThinkingState\(session\)[\s\S]*adapter\.setThinkingLevel\(session, requested\)[\s\S]*adapter\.listModels\(session, targetProvider\)[\s\S]*switchPiSessionModel/);
  assert.match(bridgeSource, /async function switchPiSessionModel[\s\S]*assertPiSessionMutationIdle\(chatId, "切换模型"\)[\s\S]*adapter\.setModel/);
  assert.match(bridgeSource, /function assertPiSessionMutationIdle[\s\S]*sessionMutationWorkForChat\(chatId\)/);
  assert.match(bridgeSource, /listProviderModels: \(provider\) => listPiProviderModels/);
  assert.match(bridgeSource, /prepareModelSelection: \(provider, modelId\) => registerPiProviderModel/);
  assert.match(bridgeSource, /function startPiRpcClient[\s\S]*piSessionSelection\(session\)[\s\S]*provider: selection\.provider[\s\S]*model: selection\.model/);
});

test("Pi reset and delete reject queued messages and persist unlinking before deleting JSONL", () => {
  const bridgeSource = fs.readFileSync(new URL("../codex-feishu-bridge.mjs", import.meta.url), "utf8");
  const resetSource = bridgeSource.slice(
    bridgeSource.indexOf("async function resetCurrentSession("),
    bridgeSource.indexOf("function normalizeSessionData("),
  );
  assert.match(resetSource, /sessionMutationWorkForChat\(chatId\)[\s\S]*\/stop queue[\s\S]*resetSession\(current\)/);

  const previewSource = bridgeSource.slice(
    bridgeSource.indexOf("async function handlePiDeleteCommand("),
    bridgeSource.indexOf("async function confirmPiSessionDeletion("),
  );
  assert.match(previewSource, /sessionMutationWorkForChat\(chatId\)[\s\S]*\/stop queue/);

  const confirmSource = bridgeSource.slice(
    bridgeSource.indexOf("async function confirmPiSessionDeletion("),
    bridgeSource.indexOf("async function handleDeleteCommand("),
  );
  assert.match(confirmSource, /sessionMutationWorkForChat\(chatId\)[\s\S]*\/stop queue/);
  assert.match(confirmSource, /\.deleteSession\(session, \{[\s\S]*beforeDelete: \(\) => \{[\s\S]*saveSessions\(\)/);
  assert.match(confirmSource, /catch \(error\) \{[\s\S]*chatState\.sessions = previousSessions[\s\S]*throw error/);
});

test("Pi setup commands are coordinator-bound, create atomically, and suppress stale QR delivery", () => {
  const bridgeSource = fs.readFileSync(new URL("../codex-feishu-bridge.mjs", import.meta.url), "utf8");
  const commandStart = bridgeSource.indexOf("async function handlePiSetupCommand(");
  const deliveryStart = bridgeSource.indexOf("async function deliverPiSetupArtifact(", commandStart);
  const deliveryEnd = bridgeSource.indexOf("function stopClearMode(", deliveryStart);
  const commandSource = bridgeSource.slice(commandStart, deliveryStart);
  const deliverySource = bridgeSource.slice(deliveryStart, deliveryEnd);

  assert.ok(commandStart >= 0 && deliveryStart > commandStart && deliveryEnd > deliveryStart);
  assert.match(bridgeSource, /case "\/pi":[\s\S]*handlePiSetupCommand/);
  assert.match(commandSource, /CONFIG\.agentEngine !== "codex"/);
  assert.match(commandSource, /current\.coordinator\?\.botName !== instanceName/);
  assert.match(commandSource, /current\.conversationId !== chatId/);
  assert.match(commandSource, /mutatePiSetupState\(piSetupFilePath, \(state\) => \{[\s\S]*if \(state\) return state;[\s\S]*return request;/);
  assert.match(deliverySource, /uploadImage\(artifact\.path/);
  assert.match(deliverySource, /latest\?\.status !== "active"[\s\S]*latest\.currentBotName !== bot\.name[\s\S]*idempotencyKey !== artifact\.idempotencyKey/);
  assert.match(deliverySource, /sendImage\(state\.conversationId, imageKey, artifact\.idempotencyKey/);
  assert.match(deliverySource, /fs\.rmSync\(artifact\.path, \{ force: true \}\)/);
});

test("pending attachments are deduplicated when a failed steer is retried", () => {
  const store = createPendingAttachmentStore({
    maxPendingAttachments: 12,
    pendingTtlMs: 60_000,
  });
  const attachment = {
    type: "image",
    messageId: "om_1",
    fileKey: "img_1",
    path: "C:\\work\\img_1.jpg",
    receivedAt: Date.now(),
  };

  store.add("chat_1", [attachment]);
  store.add("chat_1", [{ ...attachment, receivedAt: Date.now() + 1 }]);

  assert.equal(store.cleanup("chat_1").length, 1);
  assert.deepEqual(store.take("chat_1").map((item) => item.fileKey), ["img_1"]);
});

test("ordinary messages dispatch through the engine registry without awaiting CardKit and Codex uses the warm pool", () => {
  const bridgeSource = fs.readFileSync(new URL("../codex-feishu-bridge.mjs", import.meta.url), "utf8");
  const handlerStart = bridgeSource.indexOf("async function handleEvent(");
  const handlerEnd = bridgeSource.indexOf("function cleanupClearedDownloads(", handlerStart);
  const handlerSource = bridgeSource.slice(handlerStart, handlerEnd);
  const activeRunIndex = handlerSource.indexOf("recordActiveRunSafely({", handlerSource.indexOf("const cardState ="));
  const cardPromiseIndex = handlerSource.indexOf("const cardOpenPromise =");
  const engineRunIndex = handlerSource.indexOf("const result = await agentEngineRegistry.get(session.engine).run(");
  const awaitCardIndex = handlerSource.indexOf("await cardOpenPromise;", engineRunIndex);
  const runStart = bridgeSource.indexOf("async function runCodexAppServer(");
  const runEnd = bridgeSource.indexOf("async function runCodex(", runStart);
  const runSource = bridgeSource.slice(runStart, runEnd);

  assert.ok(activeRunIndex >= 0);
  assert.ok(cardPromiseIndex > activeRunIndex);
  assert.ok(engineRunIndex > cardPromiseIndex);
  assert.ok(awaitCardIndex > engineRunIndex);
  assert.match(runSource, /appServerPool\.acquire/);
  assert.match(runSource, /lease\.ensureInitialized/);
  assert.match(runSource, /lease\.release/);
  assert.doesNotMatch(runSource, /finally\s*\{[\s\S]*await client\.stop\(\)/);
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await delay(5);
  }
}

function createTestProtocol() {
  return createAppServerProtocol({
    config: {
      workspace: "C:\\work",
      codexSandbox: "danger-full-access",
      disableMcp: true,
    },
    applySessionThreadOverrides: (params) => ({ ...params, threadOverrideApplied: true }),
    applySessionTurnOverrides: (params) => ({ ...params, turnOverrideApplied: true }),
    userTextFromContent: (content) => String(content || ""),
    attachmentPromptBlock: (attachments) => `[${attachments.length} attachment]`,
  });
}
