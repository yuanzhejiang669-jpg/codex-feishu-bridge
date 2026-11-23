import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadJsonWithCorruptBackup } from "../src/utils/json.mjs";
import { createSessionStore } from "../src/sessions/store.mjs";
import { createActiveRunStore } from "../src/runtime/active-runs.mjs";
import nativeLock from "../src/sessions/native-lock.cjs";
import { createSharedClaudeSessionStore } from "../src/claude/shared-sessions.mjs";

const { lockDirectoryAsync } = nativeLock;

test("corrupt sessions.json and active-runs.json are backed up to *.corrupt.<ts>.bak before clean reinitialization", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-corrupt-json-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const sessionsPath = path.join(root, "sessions.json");
  const activeRunsPath = path.join(root, "active-runs.json");
  const corruptSessionsRaw = '{"chats":{"c1":{"sessions":[{"id":"truncated';
  const corruptActiveRaw = '{"runs":{"m1":';
  fs.writeFileSync(sessionsPath, corruptSessionsRaw, "utf8");
  fs.writeFileSync(activeRunsPath, corruptActiveRaw, "utf8");

  const logs = [];
  const log = (level, msg, meta) => logs.push({ level, msg, meta });

  const sessionStore = createSessionStore({
    sessionsPath,
    createSessionData: (title) => ({ id: "s1", title, messages: [] }),
    normalizeSessionData: (s) => ({ ...s }),
    dedupeSessions: (list) => list,
    sessionListLimit: () => 50,
    log,
  });
  const activeStore = createActiveRunStore({
    activeRunsPath,
    bridgePid: process.pid,
    workspace: root,
    log,
  });

  assert.deepEqual(sessionStore.sessions, { chats: {} });
  assert.deepEqual(activeStore.activeRuns, { runs: {} });

  const files = fs.readdirSync(root);
  const sessionBak = files.find((name) => /^sessions\.json\.corrupt\.\d+\.bak$/.test(name));
  const activeBak = files.find((name) => /^active-runs\.json\.corrupt\.\d+\.bak$/.test(name));
  assert.ok(sessionBak, `expected sessions backup in ${files.join(", ")}`);
  assert.ok(activeBak, `expected active-runs backup in ${files.join(", ")}`);
  assert.equal(fs.readFileSync(path.join(root, sessionBak), "utf8"), corruptSessionsRaw);
  assert.equal(fs.readFileSync(path.join(root, activeBak), "utf8"), corruptActiveRaw);
  assert.equal(logs.filter((l) => l.level === "ERROR").length, 2);
});

test("loadJsonWithCorruptBackup backs up schema-invalid JSON, retries transient EPERM/EBUSY 3 times, and throws if backup fails", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-corrupt-retry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const fileA = path.join(root, "schema-bad.json");
  fs.writeFileSync(fileA, JSON.stringify({ wrong: true }), "utf8");
  let renameAttempts = 0;
  const loaded = loadJsonWithCorruptBackup(
    fileA,
    (parsed) => Boolean(parsed && parsed.chats),
    () => ({ chats: {} }),
    () => {},
    {
      retryDelaysMs: [10, 10, 10],
      renameSync: (src, dst) => {
        renameAttempts += 1;
        if (renameAttempts <= 2) {
          const err = new Error("locked");
          err.code = "EBUSY";
          throw err;
        }
        fs.renameSync(src, dst);
      },
    },
  );
  assert.deepEqual(loaded, { chats: {} });
  assert.equal(renameAttempts, 3);
  assert.ok(fs.readdirSync(root).some((name) => name.startsWith("schema-bad.json.corrupt.")));

  const fileB = path.join(root, "unrenamable.json");
  fs.writeFileSync(fileB, "{corrupt", "utf8");
  let failAttempts = 0;
  assert.throws(
    () => loadJsonWithCorruptBackup(
      fileB,
      () => true,
      () => ({ chats: {} }),
      () => {},
      {
        retryDelaysMs: [5, 5, 5],
        renameSync: () => {
          failAttempts += 1;
          const err = new Error("busy forever");
          err.code = "EPERM";
          throw err;
        },
      },
    ),
    /busy forever/,
  );
  assert.equal(failAttempts, 4);
  // Original file must remain completely untouched when backup fails
  assert.equal(fs.readFileSync(fileB, "utf8"), "{corrupt");
});

test("lockDirectoryAsync never blocks the event loop under lock contention (max heartbeat drift < 100ms)", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-async-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockDir = path.join(root, "catalog.lock");

  const release1 = await lockDirectoryAsync(lockDir, { bot: "bot-1", purpose: "catalog" }, 1000);

  let lastTick = Date.now();
  let maxDrift = 0;
  let ticks = 0;
  const heartbeat = setInterval(() => {
    const now = Date.now();
    const drift = now - lastTick - 10;
    if (drift > maxDrift) maxDrift = drift;
    lastTick = now;
    ticks += 1;
  }, 10);

  // Release holder after 120ms while waiter is actively contending
  setTimeout(() => {
    release1();
  }, 120);

  const release2 = await lockDirectoryAsync(lockDir, { bot: "bot-2", purpose: "catalog" }, 2000);
  clearInterval(heartbeat);
  release2();

  assert.ok(ticks >= 4, `expected event loop to keep ticking during lock wait, got ${ticks} ticks`);
  assert.ok(maxDrift < 100, `expected event loop drift < 100ms, got ${maxDrift}ms`);
});

test("lockDirectoryAsync recovers stale dead-PID lock and shared session store async paths persist cleanly", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-shared-async-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const staleLock = path.join(root, "stale.lock");
  fs.mkdirSync(staleLock, { recursive: true });
  fs.writeFileSync(path.join(staleLock, "owner.json"), JSON.stringify({
    pid: 99999999,
    bot: "dead-bot",
    token: "dead-token",
    at: Date.now() - 60_000,
  }));
  const releaseStale = await lockDirectoryAsync(staleLock, { bot: "live-bot" }, 1000);
  assert.equal(JSON.parse(fs.readFileSync(path.join(staleLock, "owner.json"), "utf8")).pid, process.pid);
  releaseStale();
  assert.equal(fs.existsSync(staleLock), false);

  const sharedRoot = path.join(root, "shared");
  const claudeHome = path.join(root, "claude-home");
  const stateDir = path.join(root, "instances", "claude-1", "state");
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const store = createSharedClaudeSessionStore({
    config: {
      engine: "claude",
      larkProfile: "claude-1",
      claudeHome,
      claudeSharedSessionsRoot: sharedRoot,
      workspace: root,
      stateDir,
      ownerOpenId: "ou_owner1",
    },
    sessionsPath: path.join(stateDir, "sessions.json"),
    createSessionData: (title) => ({ id: "s_async1", title, createdAt: Date.now(), messages: [] }),
    sources: [],
  });

  const ctx = { chatId: "oc_dm1", chatType: "p2p", senderId: "ou_owner1" };
  const session = store.resetSession("oc_dm1", "Async Test", ctx);
  const releaseLease = await store.shared.acquireAsync(session, "run");
  session.title = "Updated Async";
  await store.saveSessionsAsync();
  releaseLease();

  const catalog = JSON.parse(fs.readFileSync(store.shared.catalogFile, "utf8"));
  assert.equal(catalog.sessions[session.id].title, "Updated Async");
  await store.shared.removeAsync([session.id], ctx);
  const afterRemove = JSON.parse(fs.readFileSync(store.shared.catalogFile, "utf8"));
  assert.equal(afterRemove.sessions[session.id], undefined);
});
