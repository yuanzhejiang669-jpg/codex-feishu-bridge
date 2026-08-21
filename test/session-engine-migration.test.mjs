import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeEngineSessionIdentity, sessionMatchesEngine } from "../src/sessions/engine-state.mjs";
import { normalizeContextUsage } from "../src/sessions/normalize.mjs";
import { createSessionStore } from "../src/sessions/store.mjs";

test("context usage preserves Pi post-compaction null values across reload", () => {
  assert.deepEqual(normalizeContextUsage({
    usedTokens: null,
    contextWindow: 200000,
    percent: null,
    updatedAt: 123,
  }), {
    usedTokens: null,
    contextWindow: 200000,
    percent: null,
    updatedAt: 123,
  });
});

test("legacy sessions migrate to Codex and Pi identity never retains a Codex thread", () => {
  assert.deepEqual(normalizeEngineSessionIdentity({ codexThreadId: "thread-1" }), {
    engine: "codex",
    codexThreadId: "thread-1",
    piSessionId: "",
    piSessionFile: "",
  });
  assert.deepEqual(normalizeEngineSessionIdentity({
    engine: "pi",
    codexThreadId: "must-not-leak",
    piSessionId: "pi-1",
    piSessionFile: "C:/pi/pi-1.jsonl",
  }), {
    engine: "pi",
    codexThreadId: "",
    piSessionId: "pi-1",
    piSessionFile: "C:/pi/pi-1.jsonl",
  });
  assert.equal(sessionMatchesEngine({}, "codex"), true);
  assert.equal(sessionMatchesEngine({}, "pi"), false);
});

test("a Bot with a different fixed engine creates a new Bridge session", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-session-engine-"));
  const sessionsPath = path.join(root, "sessions.json");
  fs.writeFileSync(sessionsPath, JSON.stringify({
    chats: { chat: { currentSessionId: "old", sessions: [{ id: "old", engine: "codex" }] } },
  }));
  let sequence = 0;
  const store = createSessionStore({
    sessionsPath,
    createSessionData: () => ({ id: `pi-${++sequence}`, engine: "pi" }),
    normalizeSessionData: (session) => session,
    dedupeSessions: (sessions) => sessions,
    sessionListLimit: () => 20,
    isSessionCompatible: (session) => session.engine === "pi",
  });
  const selected = store.getSession("chat");
  assert.equal(selected.engine, "pi");
  assert.notEqual(selected.id, "old");
  assert.equal(store.getChatState("chat").sessions.some((session) => session.id === "old"), true);
  fs.rmSync(root, { recursive: true, force: true });
});
