import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

import {
  buildAccessContext,
  canAccessSession,
  isOwnerDmContext,
  readOrBindPrimaryOwner,
} from '../src/sessions/access-control.mjs';
import { createSharedClaudeSessionStore } from '../src/claude/shared-sessions.mjs';
import { createClaudeBridge } from '../src/claude/bridge-runner.mjs';
import { createAntigravityBridge } from '../src/antigravity/bridge-runner.mjs';

const require = createRequire(import.meta.url);
const { readDesktopSettings, writeDesktopSettings } = require('../apps/desktop/src/main/services/desktop-settings.cjs');
const { processEnvironment } = require('../apps/desktop/src/main/services/supervisor.cjs');

function createFixture(t, engine = 'claude', configuredOwnerOpenId = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cfb-acl-${engine}-`));
  const envKey = `CFB_ACL_${crypto.randomBytes(6).toString('hex')}`;
  process.env[envKey] = 'fixture-secret';
  t.after(() => {
    delete process.env[envKey];
    fs.rmSync(root, { recursive: true, force: true });
  });
  let clock = 1000;
  const configs = [1, 2].map((i) => ({
    engine,
    larkProfile: `${engine}-${i}`,
    claudeHome: path.join(root, 'claude-homes', `${engine}-${i}`),
    antigravityHome: path.join(root, 'antigravity-home'),
    antigravityDataRoot: root,
    antigravityCli: { command: 'agy' },
    claudeCli: { command: 'claude' },
    claudeSharedSessionsRoot: path.join(root, 'shared'),
    antigravitySharedSessionsRoot: path.join(root, 'shared'),
    claudeBotConfig: path.join(root, `bot-${i}.json`),
    antigravityBotConfig: path.join(root, `bot-${i}.json`),
    claudeProviderCatalog: path.join(root, 'providers.json'),
    claudeProviderId: 'fixture',
    workspace: path.join(root, 'workspaces', `${engine}-${i}`),
    stateDir: path.join(root, 'instances', `${engine}-${i}`, 'state'),
    logDir: path.join(root, 'logs'),
    ownerOpenId: configuredOwnerOpenId,
    disableMcp: true,
  }));
  for (const c of configs) {
    fs.mkdirSync(c.claudeHome, { recursive: true });
    fs.mkdirSync(c.antigravityHome, { recursive: true });
    fs.mkdirSync(c.workspace, { recursive: true });
    fs.mkdirSync(c.stateDir, { recursive: true });
    fs.writeFileSync(c.claudeBotConfig, JSON.stringify({
      provider: { id: 'fixture', model: 'claude-opus-5-5', reasoning: 'high' },
      claude: { permissionMode: 'bypassPermissions' },
      antigravity: { permissionMode: 'always-proceed' },
    }));
  }
  fs.writeFileSync(configs[0].claudeProviderCatalog, JSON.stringify({
    providers: [{
      id: 'fixture', envKey, name: 'Fixture', model: 'claude-opus-5-5',
      effort: 'high', models: ['claude-opus-5-5'], baseUrl: 'https://example.invalid',
    }],
  }));
  const sources = configs.map((c) => ({
    bot: c.larkProfile,
    home: engine === 'antigravity' ? c.antigravityHome : c.claudeHome,
    workspace: c.workspace,
    stateFile: path.join(c.stateDir, 'sessions.json'),
  }));
  const makeStore = (index) => createSharedClaudeSessionStore({
    config: configs[index],
    sessionsPath: sources[index].stateFile,
    sources,
    createSessionData: (title) => ({
      id: `s_${crypto.randomBytes(4).toString('hex')}`,
      title,
      engine,
      createdAt: ++clock,
      updatedAt: clock,
      messages: [],
      ...(engine === 'antigravity' ? { antigravitySessionId: '' } : { claudeSessionId: '' }),
    }),
    normalizeSessionData: (s) => ({ ...s }),
  });
  const makeBridge = (index, store) => {
    const replies = [];
    const common = {
      config: configs[index],
      ...store,
      getChats: () => store.sessions.chats,
      sharedSessions: store.shared,
      userText: (v) => v,
      activeJobs: new Map(),
      activeChildren: new Map(),
      sendMarkdown: async (_chat, text) => replies.push(text),
    };
    const instance = engine === 'antigravity' ? createAntigravityBridge(common) : createClaudeBridge(common);
    t.after(() => instance.close());
    return {
      instance,
      replies,
      send: (event, name, rest = '') => instance.handleCommand({ message_id: 'om_test', ...event }, { name, rest }),
    };
  };
  return { root, configs, makeStore, makeBridge };
}

test('Scenario 1: primary owner DM shares sessions across multiple Bots (list, switch, delete)', async (t) => {
  const f = createFixture(t, 'claude', 'ou_ownerA');
  const storeA = f.makeStore(0);
  const storeB = f.makeStore(1);
  const botA = f.makeBridge(0, storeA);
  const botB = f.makeBridge(1, storeB);
  const dmBotA = { chat_id: 'oc_dm_botA', chat_type: 'p2p', sender_id: 'ou_ownerA' };
  const dmBotB = { chat_id: 'oc_dm_botB', chat_type: 'p2p', sender_id: 'ou_ownerA' };

  await botA.send(dmBotA, '/new', 'Owner Personal Session');
  const created = storeA.getSession('oc_dm_botA', storeA.shared.accessContextForEvent(dmBotA));
  assert.equal(created.scopeType, 'dm');
  assert.equal(created.ownerOpenId, 'ou_ownerA');
  assert.equal(created.originChatId, 'oc_dm_botA');

  await botB.send(dmBotB, '/list');
  assert.match(botB.replies.at(-1), new RegExp(created.id));
  await botB.send(dmBotB, '/switch', created.id);
  assert.equal(storeB.getSession('oc_dm_botB', storeB.shared.accessContextForEvent(dmBotB)).id, created.id);

  await botB.send(dmBotB, '/delete', created.id);
  assert.match(botB.replies.at(-1), /确认删除/);
  await botB.send(dmBotB, '/confirm', 'delete 1');
  assert.match(botB.replies.at(-1), /已删除 1/);
  assert.equal(storeA.getChatState('oc_dm_botA', storeA.shared.accessContextForEvent(dmBotA)).sessions.length, 0);
});

test('Scenario 2: group chat cannot list, switch, or delete owner DM session even with exact ID or native UUID', async (t) => {
  for (const engine of ['claude', 'antigravity']) {
    const f = createFixture(t, engine, 'ou_ownerA');
    const storeA = f.makeStore(0);
    const botA = f.makeBridge(0, storeA);
    const ownerDm = { chat_id: 'oc_dm_owner', chat_type: 'p2p', sender_id: 'ou_ownerA' };
    const groupA = { chat_id: 'oc_group_A', chat_type: 'group', sender_id: 'ou_ownerA' };

    const nativeId = crypto.randomUUID();
    const dmSession = storeA.resetSession('oc_dm_owner', 'Secret DM', storeA.shared.accessContextForEvent(ownerDm));
    if (engine === 'claude') dmSession.claudeSessionId = nativeId;
    else dmSession.antigravitySessionId = nativeId;
    storeA.saveSessions();

    await botA.send(groupA, '/list');
    assert.doesNotMatch(botA.replies.at(-1), new RegExp(dmSession.id));
    assert.doesNotMatch(botA.replies.at(-1), /Secret DM/);

    if (engine === 'claude') {
      await assert.rejects(botA.send(groupA, '/switch', dmSession.id), /未找到可访问的会话/);
      await assert.rejects(botA.send(groupA, '/switch', nativeId), /未找到可访问的会话/);
      await botA.send(groupA, '/delete', dmSession.id);
      assert.match(botA.replies.at(-1), /未找到可访问的会话/);
    } else {
      await botA.send(groupA, '/switch', dmSession.id);
      assert.match(botA.replies.at(-1), /未找到可访问的会话/);
      await botA.send(groupA, '/switch', nativeId);
      assert.match(botA.replies.at(-1), /未找到可访问的会话/);
      await botA.send(groupA, '/delete', dmSession.id);
      assert.match(botA.replies.at(-1), /未找到可访问的会话/);
    }

    assert.throws(
      () => storeA.shared.remove([dmSession.id], storeA.shared.accessContextForEvent(groupA)),
      /无权删除不属于当前作用域的会话/,
    );
  }
});

test('Scenario 3: group A session is strictly isolated from group B and from DMs', async (t) => {
  const f = createFixture(t, 'claude', 'ou_ownerA');
  const store = f.makeStore(0);
  const groupA = { chat_id: 'oc_group_A', chat_type: 'group', sender_id: 'ou_member1' };
  const groupB = { chat_id: 'oc_group_B', chat_type: 'group', sender_id: 'ou_member1' };
  const ownerDm = { chat_id: 'oc_dm_owner', chat_type: 'p2p', sender_id: 'ou_ownerA' };

  const sA = store.resetSession('oc_group_A', 'Group A Discussion', store.shared.accessContextForEvent(groupA));
  assert.equal(sA.scopeType, 'group');
  assert.equal(sA.originChatId, 'oc_group_A');

  assert.deepEqual(store.getChatState('oc_group_A', store.shared.accessContextForEvent(groupA)).sessions.map((s) => s.id), [sA.id]);
  assert.deepEqual(store.getChatState('oc_group_B', store.shared.accessContextForEvent(groupB)).sessions, []);
  assert.deepEqual(store.getChatState('oc_dm_owner', store.shared.accessContextForEvent(ownerDm)).sessions, []);
});

test('Scenario 4: User B DM cannot see or access User A DM sessions', (t) => {
  const f = createFixture(t, 'claude', 'ou_ownerA');
  const store = f.makeStore(0);
  const dmUserA = { chat_id: 'oc_dm_A', chat_type: 'p2p', sender_id: 'ou_ownerA' };
  const dmUserB = { chat_id: 'oc_dm_B', chat_type: 'p2p', sender_id: 'ou_otherB' };

  const sA = store.resetSession('oc_dm_A', 'User A Private', store.shared.accessContextForEvent(dmUserA));
  const sB = store.resetSession('oc_dm_B', 'User B Private', store.shared.accessContextForEvent(dmUserB));

  assert.deepEqual(store.getChatState('oc_dm_A', store.shared.accessContextForEvent(dmUserA)).sessions.map((s) => s.id), [sA.id]);
  assert.deepEqual(store.getChatState('oc_dm_B', store.shared.accessContextForEvent(dmUserB)).sessions.map((s) => s.id), [sB.id]);
  assert.throws(
    () => store.shared.remove([sA.id], store.shared.accessContextForEvent(dmUserB)),
    /无权删除不属于当前作用域的会话/,
  );
});

test('Scenario 5: missing chat_type or sender_id fails closed to strict originChatId isolation', () => {
  const dmSession = { id: 's1', scopeType: 'dm', ownerOpenId: 'ou_ownerA', originChatId: 'oc_dm_A' };
  const legacySession = { id: 's2', scopeType: 'dm', ownerOpenId: '', originChatId: '' };

  assert.equal(canAccessSession(dmSession, { chatId: 'oc_dm_B', chatType: '', senderId: 'ou_ownerA', primaryOwnerOpenId: 'ou_ownerA' }), false);
  assert.equal(canAccessSession(dmSession, { chatId: 'oc_dm_A', chatType: '', senderId: '', primaryOwnerOpenId: 'ou_ownerA' }), true);
  assert.equal(canAccessSession(legacySession, { chatId: 'oc_dm_A', chatType: '', senderId: '', primaryOwnerOpenId: 'ou_ownerA' }), false);
  assert.equal(isOwnerDmContext({ chatId: 'oc_dm_A', chatType: '', senderId: 'ou_ownerA', primaryOwnerOpenId: 'ou_ownerA' }), false);
  assert.equal(isOwnerDmContext({ chatId: 'oc_group', chatType: 'group', senderId: 'ou_ownerA', primaryOwnerOpenId: 'ou_ownerA' }), false);
  assert.equal(isOwnerDmContext({ chatId: 'oc_dm_A', chatType: 'p2p', senderId: 'ou_ownerA', primaryOwnerOpenId: 'ou_ownerA' }), true);
});

test('Scenario 6: legacy v1 catalog upgrades to v2 and binds first DM owner atomically without leaking to groups or others', (t) => {
  const f = createFixture(t, 'claude', '');
  const sharedDir = path.join(f.root, 'shared');
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.writeFileSync(path.join(sharedDir, 'sessions.json'), JSON.stringify({
    schemaVersion: 1,
    sessions: {
      legacy01: {
        id: 'legacy01',
        engine: 'claude',
        title: 'Pre-v0.10 Session',
        claudeSessionHome: f.configs[0].claudeHome,
        claudeWorkspace: f.configs[0].workspace,
        claudeOriginBot: 'claude-1',
        createdAt: 100,
        updatedAt: 100,
      },
    },
    deleted: {},
  }));

  const store = f.makeStore(0);
  const groupCtx = store.shared.accessContextForEvent({ chat_id: 'oc_group_1', chat_type: 'group', sender_id: 'ou_someone' });
  assert.deepEqual(store.getChatState('oc_group_1', groupCtx).sessions, []);

  // First DM atomically binds primaryOwnerOpenId to ou_firstOwner
  const firstOwnerDm = { chat_id: 'oc_dm_1', chat_type: 'p2p', sender_id: 'ou_firstOwner' };
  const ownerCtx = store.shared.accessContextForEvent(firstOwnerDm);
  assert.equal(ownerCtx.primaryOwnerOpenId, 'ou_firstOwner');
  assert.deepEqual(store.getChatState('oc_dm_1', ownerCtx).sessions.map((s) => s.id), ['legacy01']);

  // Second DM user cannot steal primaryOwnerOpenId or view legacy01
  const otherUserDm = { chat_id: 'oc_dm_2', chat_type: 'p2p', sender_id: 'ou_secondUser' };
  const otherCtx = store.shared.accessContextForEvent(otherUserDm);
  assert.equal(otherCtx.primaryOwnerOpenId, 'ou_firstOwner');
  assert.deepEqual(store.getChatState('oc_dm_2', otherCtx).sessions, []);

  // Saving persists schemaVersion: 2
  store.saveSessions();
  const persisted = JSON.parse(fs.readFileSync(path.join(sharedDir, 'sessions.json'), 'utf8'));
  assert.equal(persisted.schemaVersion, 2);
});

test('desktop settings validate ownerOpenId and supervisor injects CODEX_FEISHU_OWNER_OPEN_ID', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-owner-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(readDesktopSettings(root).ownerOpenId, '');
  assert.throws(() => writeDesktopSettings(root, { ownerOpenId: 'invalid-id' }), /Open ID/);
  const saved = writeDesktopSettings(root, { ownerOpenId: 'ou_owner123' });
  assert.equal(saved.ownerOpenId, 'ou_owner123');

  const env = processEnvironment({
    dataRoot: root,
    localAppData: path.join(root, 'runtime'),
    nodePath: process.execPath,
    larkCliPath: 'lark',
    platform: 'win32',
  }, { name: 'codex-1', engine: 'codex', profile: 'codex-1' });
  assert.equal(env.CODEX_FEISHU_OWNER_OPEN_ID, 'ou_owner123');
});
