import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSharedClaudeSessionStore } from "../src/claude/shared-sessions.mjs";

function makeStoreEnv(engine = "antigravity") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `v01020-shared-${engine}-`));
  const sharedRoot = path.join(root, `${engine}-shared-sessions`);
  const nativeHome4 = path.join(root, `${engine}-home-4`);
  const nativeHome5 = engine === "antigravity" ? nativeHome4 : path.join(root, `${engine}-home-5`);
  const ws4 = path.join(root, "ws-4");
  const ws5 = path.join(root, "ws-5");
  const state4 = path.join(root, "instances", `${engine}-4`, "state");
  const state5 = path.join(root, "instances", `${engine}-5`, "state");
  for (const dir of [sharedRoot, nativeHome4, nativeHome5, ws4, ws5, state4, state5]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const sessions4 = path.join(state4, "sessions.json");
  const sessions5 = path.join(state5, "sessions.json");
  const sources = [
    { bot: `${engine}-4`, home: nativeHome4, workspace: ws4, stateFile: sessions4 },
    { bot: `${engine}-5`, home: nativeHome5, workspace: ws5, stateFile: sessions5 },
  ];

  let seq = 0;
  const openBot = (which) => {
    const is4 = which === 4;
    const cfg = {
      engine,
      larkProfile: is4 ? `${engine}-4` : `${engine}-5`,
      workspace: is4 ? ws4 : ws5,
      stateDir: is4 ? state4 : state5,
      ...(engine === "antigravity"
        ? { antigravityHome: is4 ? nativeHome4 : nativeHome5, antigravitySharedSessionsRoot: sharedRoot }
        : { claudeHome: is4 ? nativeHome4 : nativeHome5, claudeSharedSessionsRoot: sharedRoot }),
    };
    return createSharedClaudeSessionStore({
      config: cfg,
      sessionsPath: is4 ? sessions4 : sessions5,
      sources,
      createSessionData: (title) => ({
        id: `sess_${++seq}_${Math.random().toString(16).slice(2, 6)}`,
        title,
        createdAt: Date.now() + seq * 1000,
        updatedAt: Date.now() + seq * 1000,
        history: [],
      }),
    });
  };

  return { root, openBot, sessions5 };
}

for (const engine of ["antigravity", "claude"]) {
  test(`v0.10.20 (${engine}): cross-Bot currentSessionId survives Bot restart instead of jumping to newest session`, () => {
    const env = makeStoreEnv(engine);
    try {
      const ownerUnionId = "on_10b519648617e6441c1f10d93ae5ae2f";
      const ctxBot4 = {
        chatId: "oc_bot4_dm",
        chatType: "p2p",
        senderId: "ou_owner_bot4",
        senderUnionId: ownerUnionId,
      };
      const ctxBot5 = {
        chatId: "oc_bot5_dm",
        chatType: "p2p",
        senderId: "ou_owner_bot5",
        senderUnionId: ownerUnionId,
      };

      // Bot 4 creates an older session ("随便聊聊") and a newer session ("购买小鸡")
      const bot4 = env.openBot(4);
      const olderSession = bot4.resetSession("oc_bot4_dm", "随便聊聊", ctxBot4);
      const newerSession = bot4.resetSession("oc_bot4_dm", "购买小鸡", ctxBot4);
      assert.notEqual(olderSession.id, newerSession.id);

      // Bot 5 switches to Bot 4's older session ("随便聊聊") and persists state
      const bot5Before = env.openBot(5);
      const chat5Before = bot5Before.getChatState("oc_bot5_dm", ctxBot5);
      assert.ok(chat5Before.sessions.some((s) => s.id === olderSession.id));
      chat5Before.currentSessionId = olderSession.id;
      bot5Before.saveSessions();

      // Simulate Bot 5 restart (fresh store loaded from disk with unverified startup refresh)
      const bot5After = env.openBot(5);
      assert.equal(
        bot5After.sessions.chats["oc_bot5_dm"].currentSessionId,
        olderSession.id,
        "startup unverified refresh must preserve existing cross-Bot currentSessionId",
      );

      // Owner sends "继续" on Bot 5 -> must stay on olderSession ("随便聊聊"), NOT jump to newerSession ("购买小鸡")
      const resumed = bot5After.getSession("oc_bot5_dm", ctxBot5);
      assert.equal(resumed.id, olderSession.id);
      assert.equal(resumed.title, "随便聊聊");
    } finally {
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  });
}

test("v0.10.20: saveSessions from another chat does not wipe unvisited chat's cross-Bot currentSessionId, deleted sessions still clear, and unauthorized callers still fail closed", () => {
  const env = makeStoreEnv("antigravity");
  try {
    const ownerUnionId = "on_10b519648617e6441c1f10d93ae5ae2f";
    const ctxBot4 = { chatId: "oc_bot4_dm", chatType: "p2p", senderId: "ou_owner_4", senderUnionId: ownerUnionId };
    const ctxBot5 = { chatId: "oc_bot5_dm", chatType: "p2p", senderId: "ou_owner_5", senderUnionId: ownerUnionId };
    const ctxBot5Group = { chatId: "oc_bot5_grp", chatType: "group", senderId: "ou_other_member", senderUnionId: "on_other_member" };

    const bot4 = env.openBot(4);
    const crossSession = bot4.resetSession("oc_bot4_dm", "作业会话", ctxBot4);
    const newerSession = bot4.resetSession("oc_bot4_dm", "闲聊会话", ctxBot4);

    // Bot 5 has both oc_bot5_dm (switched to crossSession) and oc_bot5_grp
    const bot5Before = env.openBot(5);
    const dmBefore = bot5Before.getChatState("oc_bot5_dm", ctxBot5);
    dmBefore.currentSessionId = crossSession.id;
    bot5Before.resetSession("oc_bot5_grp", "群聊独立会话", ctxBot5Group);
    bot5Before.saveSessions();

    // Restart Bot 5; group chat triggers saveSessions() before DM receives any event
    const bot5After = env.openBot(5);
    bot5After.getSession("oc_bot5_grp", ctxBot5Group);
    bot5After.saveSessions();

    // Verify DM's cross-Bot selection survived on disk AND resolves cleanly on owner DM
    const persisted = JSON.parse(fs.readFileSync(env.sessions5, "utf8"));
    assert.equal(persisted.chats["oc_bot5_dm"].currentSessionId, crossSession.id);
    assert.equal(bot5After.getSession("oc_bot5_dm", ctxBot5).id, crossSession.id);

    // Security check: an unauthorized third user sending DM in that chatId MUST fail closed and NEVER get crossSession
    const intruderCtx = { chatId: "oc_bot5_dm", chatType: "p2p", senderId: "ou_intruder", senderUnionId: "on_intruder" };
    const intruderSession = bot5After.getSession("oc_bot5_dm", intruderCtx);
    assert.notEqual(intruderSession.id, crossSession.id);
    assert.notEqual(intruderSession.id, newerSession.id);

    // Deleted session check: restore DM selection to crossSession, delete crossSession on Bot 4, then restart Bot 5
    const dmRestore = bot5After.getChatState("oc_bot5_dm", ctxBot5);
    dmRestore.currentSessionId = crossSession.id;
    bot5After.saveSessions();
    bot4.shared.remove([crossSession.id], ctxBot4);

    const bot5AfterDelete = env.openBot(5);
    assert.notEqual(bot5AfterDelete.sessions.chats["oc_bot5_dm"].currentSessionId, crossSession.id);
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});
