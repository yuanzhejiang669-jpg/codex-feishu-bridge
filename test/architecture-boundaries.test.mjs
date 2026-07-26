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
import { createAppServerProtocol } from "../src/codex/app-server-protocol.mjs";
import { createEventDispatcher } from "../src/runtime/event-dispatcher.mjs";
import { createEventQueue } from "../src/runtime/event-queue.mjs";
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
  assert.match(bridgeSource, /`\/steer <补充内容>`/);
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
