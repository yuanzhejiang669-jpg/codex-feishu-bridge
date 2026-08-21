import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PiEngineAdapter, PiEngineError, classifyPiFailure } from "../src/pi/engine-adapter.mjs";

class FakePiClient extends EventEmitter {
  constructor({
    sessionId = "pi-1",
    sessionFile = "C:/pi/sessions/pi-1.jsonl",
    autoSettle = true,
    statsError = null,
  } = {}) {
    super();
    this.sessionId = sessionId;
    this.sessionFile = sessionFile;
    this.commands = [];
    this.requestTimeouts = [];
    this.closed = false;
    this.autoSettle = autoSettle;
    this.statsError = statsError;
  }
  async start() { return this; }
  async waitUntilReady() { return this; }
  onEvent(listener) { this.on("event", listener); return () => this.off("event", listener); }
  waitForEvent(predicate) {
    return new Promise((resolve) => {
      const listener = (event) => {
        if (!predicate(event)) return;
        this.off("event", listener);
        resolve(event);
      };
      this.on("event", listener);
    });
  }
  async request(command, timeoutMs) {
    this.commands.push(command);
    this.requestTimeouts.push({ type: command.type, timeoutMs });
    if (command.type === "get_state") {
      return { data: { sessionId: this.sessionId, sessionFile: this.sessionFile, isStreaming: false } };
    }
    if (command.type === "get_session_stats") {
      if (this.statsError) throw this.statsError;
      return {
        data: {
          tokens: { input: 120, output: 30, cacheRead: 40, cacheWrite: 5, total: 195 },
          contextUsage: { tokens: 150, contextWindow: 1000, percent: 15 },
        },
      };
    }
    if (command.type === "new_session") {
      this.sessionId = "pi-reset";
      this.sessionFile = this.sessionFile.replace(/[^/\\]+\.jsonl$/i, "pi-reset.jsonl");
      return { data: { cancelled: false } };
    }
    if (command.type === "set_session_name") return { success: true };
    if (command.type === "prompt" && this.autoSettle) {
      queueMicrotask(() => {
        this.emit("event", { type: "message_update", usage: { input: 2, output: 1, totalTokens: 3 }, assistantMessageEvent: { type: "text_delta", delta: "hello" } });
        this.emit("event", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } });
        this.emit("event", { type: "agent_settled" });
      });
    }
    if (command.type === "compact") return { data: { summary: "short" } };
    return { success: true };
  }
  async stop() { this.closed = true; }
  settle() { this.emit("event", { type: "agent_settled" }); }
}

test("Pi adapter streams a turn, persists isolated session identity and usage", async () => {
  const client = new FakePiClient();
  const persisted = [];
  const normalized = [];
  const adapter = new PiEngineAdapter({
    createClient: async () => client,
    textFromEvent: () => "question",
    imagesFromEvent: async () => [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    persistSession: (session) => persisted.push({ ...session }),
    reduceEvent: (_state, event) => { normalized.push(event); return true; },
  });
  const session = { id: "bridge-1", codexThreadId: "" };
  const result = await adapter.run({ id: "m1" }, session, {}, () => {});
  assert.equal(result.text, "hello");
  assert.equal(result.mode, "pi-rpc");
  assert.equal(session.piSessionId, "pi-1");
  assert.equal(session.piSessionFile, "C:/pi/sessions/pi-1.jsonl");
  assert.equal(session.codexThreadId, "");
  assert.equal(result.usage.totalTokens, 3);
  assert.deepEqual(session.piUsage, {
    inputTokens: 120,
    outputTokens: 30,
    cachedInputTokens: 40,
    cacheWriteTokens: 5,
    totalTokens: 195,
  });
  assert.equal(session.piContextUsage.usedTokens, 150);
  assert.equal(session.piContextUsage.contextWindow, 1000);
  assert.equal(session.piContextUsage.percent, 15);
  assert.equal(session.piContextPeakUsage.percent, 15);
  assert.ok(client.commands.some((command) => command.type === "get_session_stats"));
  assert.equal(client.requestTimeouts.find((item) => item.type === "get_session_stats").timeoutMs, 3000);
  assert.ok(persisted.length >= 2);
  assert.ok(normalized.some((event) => event.kind === "text_delta"));
  const prompt = client.commands.find((command) => command.type === "prompt");
  assert.equal(prompt.message, "question");
  assert.equal(prompt.images[0].mimeType, "image/png");
});

test("Pi adapter routes steer, follow-up, abort, compact and status over RPC", async () => {
  const client = new FakePiClient({ autoSettle: false });
  const adapter = new PiEngineAdapter({ createClient: async () => client });
  const session = { id: "bridge-2" };
  const runPromise = adapter.run({ content: "hello" }, session);
  await new Promise((resolve) => setImmediate(resolve));
  await adapter.steer(session, { message: "now" });
  await adapter.steer(session, { message: "later", behavior: "follow_up" });
  await adapter.abort(session);
  client.settle();
  await runPromise;
  assert.equal((await adapter.compact(session)).summary, "short");
  assert.ok(Number.isFinite(session.piCompactedAt));
  assert.equal(session.piContextUsage.percent, 15);
  const status = await adapter.status(session);
  assert.equal(status.running, true);
  assert.deepEqual(
    client.commands.filter((command) => ["steer", "follow_up", "abort", "compact"].includes(command.type)).map((command) => command.type),
    ["steer", "follow_up", "abort", "compact"],
  );
  await adapter.dispose("test");
  assert.equal(client.closed, true);
});

test("Pi adapter refuses a mismatched resumed session without replacing it", async () => {
  const client = new FakePiClient({ sessionId: "different", sessionFile: "C:/pi/sessions/different.jsonl" });
  const adapter = new PiEngineAdapter({ createClient: async () => client });
  const session = { id: "bridge-3", piSessionId: "expected", piSessionFile: "C:/pi/sessions/expected.jsonl" };
  await assert.rejects(adapter.compact(session), (error) => error instanceof PiEngineError && error.kind === "session");
  assert.equal(session.piSessionId, "expected");
  assert.equal(client.closed, true);
});

test("Pi failure mapping distinguishes timeout, process exit, auth and user stop", () => {
  assert.equal(classifyPiFailure(new Error("request timed out")).kind, "timeout");
  assert.equal(classifyPiFailure(new Error("Pi exited with 1")).kind, "process_exit");
  assert.equal(classifyPiFailure(new Error("401 unauthorized API key")).kind, "auth");
  assert.equal(classifyPiFailure(new Error("job aborted by user")).kind, "user_stop");
});

test("Pi adapter keeps a successful answer when session stats are unavailable", async () => {
  const client = new FakePiClient({ statsError: new Error("stats timed out") });
  const warnings = [];
  const adapter = new PiEngineAdapter({
    createClient: async () => client,
    log: (level, message, detail) => warnings.push({ level, message, detail }),
  });
  const session = { id: "bridge-stats-fallback" };
  const result = await adapter.run({ content: "hello" }, session);
  assert.equal(result.text, "hello");
  assert.equal(session.piUsage.totalTokens, 3);
  assert.equal(session.piContextUsage, undefined);
  assert.ok(warnings.some((entry) => entry.level === "WARN" && entry.message === "Pi session stats unavailable"));
});

test("Pi adapter resets and renames the native Pi session", async () => {
  const client = new FakePiClient();
  const adapter = new PiEngineAdapter({ createClient: async () => client });
  const session = {
    id: "bridge-session-controls",
    piSessionId: "pi-1",
    piSessionFile: "C:/pi/sessions/pi-1.jsonl",
    piUsage: { totalTokens: 20 },
    piContextUsage: { usedTokens: 10 },
    piContextPeakUsage: { usedTokens: 15 },
    piCompactedAt: 123,
  };
  await adapter.renameSession(session, "renamed");
  await adapter.resetSession(session);
  assert.equal(session.piSessionId, "pi-reset");
  assert.match(session.piSessionFile, /pi-reset\.jsonl$/);
  assert.equal(session.piUsage, null);
  assert.equal(session.piContextUsage, null);
  assert.equal(session.piContextPeakUsage, null);
  assert.equal(session.piCompactedAt, null);
  assert.ok(client.commands.some((command) => command.type === "set_session_name" && command.name === "renamed"));
  assert.ok(client.commands.some((command) => command.type === "new_session"));
});

test("Pi adapter deletes only JSONL files inside its configured session directory", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-pi-delete-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, "sessions");
  fs.mkdirSync(sessionDir);
  const sessionFile = path.join(sessionDir, "inside.jsonl");
  const outsideFile = path.join(root, "outside.jsonl");
  fs.writeFileSync(sessionFile, "{}\n", "utf8");
  fs.writeFileSync(outsideFile, "{}\n", "utf8");
  const adapter = new PiEngineAdapter({ createClient: async () => new FakePiClient(), sessionDir });
  const deleted = await adapter.deleteSession({ id: "inside", piSessionFile: sessionFile });
  assert.equal(deleted.deleted, true);
  assert.equal(fs.existsSync(sessionFile), false);
  await assert.rejects(
    adapter.deleteSession({ id: "outside", piSessionFile: outsideFile }),
    (error) => error instanceof PiEngineError && error.kind === "session",
  );
  assert.equal(fs.existsSync(outsideFile), true);
});

test("Pi adapter marks a cold-starting turn active before the RPC client is ready", async () => {
  let releaseClient;
  const clientGate = new Promise((resolve) => { releaseClient = resolve; });
  const client = new FakePiClient();
  const adapter = new PiEngineAdapter({
    createClient: async () => {
      await clientGate;
      return client;
    },
  });
  const session = { id: "bridge-cold-start" };
  const runPromise = adapter.run({ content: "hello" }, session);
  await new Promise((resolve) => setImmediate(resolve));
  const status = await adapter.status(session);
  assert.equal(status.active, true);
  await assert.rejects(
    adapter.deleteSession(session),
    (error) => error instanceof PiEngineError && error.kind === "busy",
  );
  await adapter.abort(session);
  releaseClient();
  await assert.rejects(runPromise, (error) => error instanceof PiEngineError && error.kind === "user_stop");
});

test("Pi adapter locks a session while persisting deletion before unlinking JSONL", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-pi-delete-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionFile = path.join(root, "locked.jsonl");
  fs.writeFileSync(sessionFile, "{}\n", "utf8");
  const adapter = new PiEngineAdapter({ createClient: async () => new FakePiClient(), sessionDir: root });
  const session = { id: "locked", piSessionFile: sessionFile };
  let releasePersist;
  const persistGate = new Promise((resolve) => { releasePersist = resolve; });
  const deletePromise = adapter.deleteSession(session, { beforeDelete: () => persistGate });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(adapter.run({ content: "late" }, session), (error) => error instanceof PiEngineError && error.kind === "busy");
  assert.equal(fs.existsSync(sessionFile), true);
  releasePersist();
  const result = await deletePromise;
  assert.equal(result.deleted, true);
  assert.equal(fs.existsSync(sessionFile), false);
});
