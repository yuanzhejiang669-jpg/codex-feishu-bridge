import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { createRequire } from 'node:module';

import { AntigravityAcpClient } from '../src/antigravity/acp-client.mjs';
import { createAntigravityBridge } from '../src/antigravity/bridge-runner.mjs';
import { ClaudeCliClient } from '../src/claude/cli-client.mjs';
import { createClaudeBridge } from '../src/claude/bridge-runner.mjs';
import { callFeishuTool, feishuMcpConfiguration } from '../src/claude/feishu-tools.mjs';
import { createSharedClaudeSessionStore } from '../src/claude/shared-sessions.mjs';
import { createLarkClient } from '../src/feishu/lark-cli.mjs';

const require = createRequire(import.meta.url);
const { antigravityProviderReference } = require('../apps/desktop/src/main/services/antigravity.cjs');
const { providerReference: claudeProviderReference } = require('../apps/desktop/src/main/services/claude-bots.cjs');

function makeAcpFixture(handler, extra = {}) {
  const child = new EventEmitter();
  child.pid = 41000 + Math.floor(Math.random() * 1000);
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin.on('finish', () => queueMicrotask(() => child.emit('close', 0, null)));
  child.kill = () => { child.emit('close', 0, null); return true; };
  const requests = [];
  let buffer = '';
  const send = (value) => child.stdout.write(`${JSON.stringify(value)}\n`);
  child.stdin.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    while (buffer.includes('\n')) {
      const nl = buffer.indexOf('\n');
      const req = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      requests.push(req);
      queueMicrotask(() => {
        if (handler?.(req, send, child) === true) return;
        if (req.id == null) return;
        if (req.method === 'initialize') {
          send({ jsonrpc: '2.0', id: req.id, result: { agentInfo: { version: '1.5.14' }, agentCapabilities: { sessionCapabilities: { resume: {}, load: {} } } } });
        } else if (['session/new', 'session/resume', 'session/load'].includes(req.method)) {
          send({
            jsonrpc: '2.0',
            id: req.id,
            result: {
              sessionId: req.params?.sessionId || 'agy-warm-session-1',
              models: {
                currentModelId: 'gemini-4-neon-high',
                availableModels: [
                  { modelId: 'gemini-4-neon-low' },
                  { modelId: 'gemini-4-neon-medium' },
                  { modelId: 'gemini-4-neon-high' },
                  { modelId: 'gemini-4-neon-xhigh' },
                ],
              },
              configOptions: [
                { id: 'model', currentValue: 'gemini-4-neon', options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }] },
                { id: 'thought_level', currentValue: 'high', options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }] },
              ],
            },
          });
        } else if (req.method === 'session/prompt') {
          const text = req.params?.prompt?.[0]?.text || '';
          send({ method: 'session/update', params: { sessionId: req.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `ECHO:${text}` } } } });
          send({ jsonrpc: '2.0', id: req.id, result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } });
        } else {
          send({ jsonrpc: '2.0', id: req.id, result: {} });
        }
      });
    }
  });
  const client = new AntigravityAcpClient({
    command: 'fixture-agy',
    cwd: '.',
    spawnProcess: () => child,
    requestTimeoutMs: 2000,
    idleTimeoutMs: 5000,
    ...extra,
  });
  return { client, child, requests, send };
}

function makeClaudePersistentChild(onMessage) {
  const child = new EventEmitter();
  child.pid = 51000 + Math.floor(Math.random() * 1000);
  child.exitCode = null;
  child.killed = false;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.send = (event) => child.stdout.write(`${JSON.stringify(event)}\n`);
  child.finish = (code = 0) => {
    if (child.exitCode !== null) return;
    child.exitCode = code;
    child.stdout.end();
    child.stderr.end();
    setImmediate(() => child.emit('close', code, null));
  };
  child.stdin = new Writable({
    write(chunk, _enc, done) {
      for (const line of chunk.toString('utf8').split('\n').map((s) => s.trim()).filter(Boolean)) {
        const msg = JSON.parse(line);
        setImmediate(() => onMessage(msg, child));
      }
      done();
    },
    final(done) {
      child.finish(0);
      done();
    },
  });
  child.kill = () => {
    child.killed = true;
    child.finish(1);
    return true;
  };
  return child;
}

test('Antigravity engine-wide /model save syncs sibling Bots, new Bots, /model clear, and preserves /new custom titles', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-agy-defaults-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  const bot3Dir = path.join(root, 'managed-bots', 'antigravity-3');
  const bot4Dir = path.join(root, 'managed-bots', 'antigravity-4');
  const state3 = path.join(root, 'state-3');
  const state4 = path.join(root, 'state-4');
  const logDir = path.join(root, 'logs');
  const agyHome = path.join(root, 'agy-home');
  for (const dir of [bot3Dir, bot4Dir, state3, state4, logDir, agyHome]) fs.mkdirSync(dir, { recursive: true });

  const bot3Config = path.join(bot3Dir, 'bot.json');
  const bot4Config = path.join(bot4Dir, 'bot.json');
  fs.writeFileSync(bot3Config, JSON.stringify({ engine: 'antigravity', provider: { id: 'official', model: '', reasoning: '' }, antigravity: { permissionMode: 'always-proceed' } }));
  fs.writeFileSync(bot4Config, JSON.stringify({ engine: 'antigravity', provider: { id: 'official', model: '', reasoning: '' }, antigravity: { permissionMode: 'always-proceed' } }));

  const runtimeCatalog = {
    provider: 'official',
    models: {
      currentModelId: 'gemini-4-neon-high',
      availableModels: [
        { modelId: 'gemini-4-neon-low' },
        { modelId: 'gemini-4-neon-medium' },
        { modelId: 'gemini-4-neon-high' },
        { modelId: 'gemini-4-neon-xhigh' },
      ],
    },
    configOptions: [
      { id: 'model', currentValue: 'gemini-4-neon', options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }] },
      { id: 'thought_level', currentValue: 'high', options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }] },
    ],
  };
  fs.writeFileSync(path.join(state3, 'antigravity-runtime.json'), JSON.stringify(runtimeCatalog));
  fs.writeFileSync(path.join(state4, 'antigravity-runtime.json'), JSON.stringify(runtimeCatalog));

  const makeBot = (botConfigPath, stateDir) => {
    const sessions = [{ id: 's1', title: 'Initial', engine: 'antigravity', messages: [], antigravitySessionId: '' }];
    const chat = { currentSessionId: 's1', sessions };
    const replies = [];
    const bridge = createAntigravityBridge({
      config: {
        stateDir,
        logDir,
        workspace: root,
        antigravityHome: agyHome,
        antigravityDataRoot: root,
        antigravityBotConfig: botConfigPath,
        antigravityCli: { command: 'fixture-agy' },
      },
      getSession: () => chat.sessions.find((s) => s.id === chat.currentSessionId),
      getChatState: () => chat,
      getChats: () => ({ dm: chat }),
      resetSession: (_chatId, title) => {
        const next = { id: `s-${sessions.length + 1}`, title, engine: 'antigravity', messages: [], antigravitySessionId: '' };
        sessions.unshift(next);
        chat.currentSessionId = next.id;
        return next;
      },
      saveSessions: () => {},
      userText: (c) => String(c || ''),
      sendMarkdown: async (_c, text) => { replies.push(text); },
      activeChildren: new Map(),
      activeJobs: new Map(),
      appendText: () => {}, reduceEvent: () => {}, markPhase: () => {}, ensureDone: () => {}, markInterrupted: () => {}, markError: () => {},
      createClient: (opts) => makeAcpFixture((req, send) => {
        if (req.method === 'session/prompt') {
          // Simulate agy auto-renaming title to "Number 1" on first turn
          send({ method: 'session/update', params: { sessionId: req.params.sessionId, update: { sessionUpdate: 'session_info_update', title: 'Number 1' } } });
          send({ method: 'session/update', params: { sessionId: req.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '收到' } } } });
          send({ jsonrpc: '2.0', id: req.id, result: { stopReason: 'end_turn' } });
          return true;
        }
        return false;
      }, opts).client,
    });
    t.after(() => bridge.close());
    return { bridge, sessions, chat, replies };
  };

  const bot3 = makeBot(bot3Config, state3);
  const bot4 = makeBot(bot4Config, state4);
  const evt = { chat_id: 'dm', chat_type: 'p2p', sender_id: 'ou_owner', message_id: 'm1' };

  // 1) Bot 3 runs /model save gemini-4-neon xhigh -> clears session overrides, shows 引擎默认, syncs Bot 4 & new Bots!
  await bot3.bridge.handleCommand(evt, { name: '/model', rest: 'save gemini-4-neon xhigh' });
  assert.equal(bot3.sessions[0].modelOverride, undefined);
  assert.equal(bot3.sessions[0].reasoningOverride, undefined);
  assert.match(bot3.replies.at(-1), /gemini-4-neon.*引擎默认/);
  assert.match(bot3.replies.at(-1), /xhigh.*引擎默认/);
  assert.equal(JSON.parse(fs.readFileSync(bot4Config, 'utf8')).provider.reasoning, 'xhigh');

  // 2) Bot 4 had an old override 'low' -> /model clear restores saved engine default xhigh!
  bot4.sessions[0].reasoningOverride = 'low';
  await bot4.bridge.handleCommand(evt, { name: '/model', rest: 'clear' });
  assert.equal(bot4.bridge.settings(bot4.sessions[0]).model, 'gemini-4-neon');
  assert.equal(bot4.bridge.settings(bot4.sessions[0]).reasoning, 'xhigh');
  assert.match(bot4.replies.at(-1), /xhigh.*引擎默认/);

  // 3) Newly created Antigravity Bot inherits saved engine defaults automatically
  const newBotProvider = antigravityProviderReference({}, { dataRoot: root });
  assert.equal(newBotProvider.model, 'gemini-4-neon');
  assert.equal(newBotProvider.reasoning, 'xhigh');

  // 4) /new 随便聊聊 locks custom title so ACP session_info_update("Number 1") never overwrites it
  await bot4.bridge.handleCommand(evt, { name: '/new', rest: '随便聊聊' });
  const customSession = bot4.chat.sessions.find((s) => s.id === bot4.chat.currentSessionId);
  assert.equal(customSession.title, '随便聊聊');
  assert.equal(customSession.userRenamed, true);
  await bot4.bridge.run({ ...evt, content: '1' }, customSession);
  assert.equal(customSession.title, '随便聊聊');
});

test('Claude engine-wide /model save syncs sibling Bots, settings.json, new Bots, and /model clear', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-claude-defaults-'));
  const envKey = `CFB_CLD_DEF_${crypto.randomBytes(6).toString('hex')}`;
  process.env[envKey] = 'fixture-key';
  t.after(() => { delete process.env[envKey]; fs.rmSync(root, { recursive: true, force: true }); });

  const catalog = path.join(root, 'claude-providers.json');
  const bot1Dir = path.join(root, 'managed-bots', 'claude-1');
  const bot2Dir = path.join(root, 'managed-bots', 'claude-2');
  const home1 = path.join(root, 'claude-homes', 'claude-1');
  const home2 = path.join(root, 'claude-homes', 'claude-2');
  for (const dir of [bot1Dir, bot2Dir, home1, home2]) fs.mkdirSync(dir, { recursive: true });

  const provider = { id: 'one', name: 'One', baseUrl: 'https://example.invalid', auth: 'bearer', envKey, model: 'claude-opus-5-5', effort: 'high', models: ['claude-opus-5-5', 'claude-sonnet-5'] };
  fs.writeFileSync(catalog, JSON.stringify({ schemaVersion: 1, providers: [provider] }));

  const bot1Config = path.join(bot1Dir, 'bot.json');
  const bot2Config = path.join(bot2Dir, 'bot.json');
  fs.writeFileSync(bot1Config, JSON.stringify({ engine: 'claude', claudeHome: home1, provider: { id: 'one', model: 'claude-opus-5-5', reasoning: 'high' } }));
  fs.writeFileSync(bot2Config, JSON.stringify({ engine: 'claude', claudeHome: home2, provider: { id: 'one', model: 'claude-opus-5-5', reasoning: 'high' } }));

  const makeClaudeBot = (botConfig, claudeHome, name) => {
    const session = { id: 's1', engine: 'claude', title: 'S1', messages: [] };
    const chat = { currentSessionId: 's1', sessions: [session] };
    const replies = [];
    const bridge = createClaudeBridge({
      config: { stateDir: claudeHome, claudeHome, workspace: root, larkProfile: name, claudeCli: { command: 'claude' }, claudeBotConfig: botConfig, claudeProviderCatalog: catalog, claudeProviderId: 'one' },
      getSession: () => session,
      getChatState: () => chat,
      getChats: () => ({ dm: chat }),
      resetSession: () => session,
      saveSessions: () => {},
      activeJobs: new Map(),
      activeChildren: new Map(),
      userText: (c) => c,
      sendMarkdown: async (_c, text) => replies.push(text),
    });
    t.after(() => bridge.close());
    return { bridge, session, replies };
  };

  const b1 = makeClaudeBot(bot1Config, home1, 'claude-1');
  const b2 = makeClaudeBot(bot2Config, home2, 'claude-2');
  const evt = { chat_id: 'dm', sender_id: 'u1', message_id: 'm1' };

  await b1.bridge.handleCommand(evt, { name: '/model', rest: 'save claude-sonnet-5 xhigh' });
  assert.equal(b1.session.modelOverride, '');
  assert.equal(b1.session.reasoningOverride, '');
  assert.match(b1.replies.at(-1), /claude-sonnet-5`（引擎默认）/);
  assert.match(b1.replies.at(-1), /xhigh`（引擎默认）/);

  // Sibling Bot 2 bot.json + settings.json updated & /model clear restores engine default
  assert.equal(JSON.parse(fs.readFileSync(bot2Config, 'utf8')).provider.model, 'claude-sonnet-5');
  assert.equal(JSON.parse(fs.readFileSync(bot2Config, 'utf8')).provider.reasoning, 'xhigh');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home2, 'settings.json'), 'utf8')).model, 'claude-sonnet-5');

  b2.session.modelOverride = 'claude-opus-5-5';
  b2.session.reasoningOverride = 'low';
  await b2.bridge.handleCommand(evt, { name: '/model', rest: 'clear' });
  assert.equal(b2.bridge.settings(b2.session).model, 'claude-sonnet-5');
  assert.equal(b2.bridge.settings(b2.session).reasoning, 'xhigh');

  // Newly created Claude Bot inherits engine defaults
  const ref = claudeProviderReference({ providerId: 'one' }, { dataRoot: root, env: process.env });
  assert.equal(ref.model, 'claude-sonnet-5');
  assert.equal(ref.reasoning, 'xhigh');
});

test('Antigravity warm idle pool reuses live ACP worker, releases shared leases while idle, and invalidates after cross-Bot update', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-agy-warm-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  const ownerCtx = (chatId) => ({ chatId, chatType: 'p2p', senderId: 'ou_owner1' });
  const configs = [1, 2].map((i) => ({
    engine: 'antigravity',
    larkProfile: `antigravity-${i}`,
    antigravityDataRoot: root,
    antigravityHome: path.join(root, 'home'),
    antigravityCli: { command: 'fixture-agy' },
    antigravitySharedSessionsRoot: path.join(root, 'shared'),
    workspace: path.join(root, `work-${i}`),
    stateDir: path.join(root, 'instances', `antigravity-${i}`, 'state'),
    logDir: path.join(root, 'logs'),
    ownerOpenId: 'ou_owner1',
    disableMcp: true,
    antigravityIdleTtlMs: 30_000,
  }));
  for (const c of configs) {
    fs.mkdirSync(c.workspace, { recursive: true });
    fs.mkdirSync(c.stateDir, { recursive: true });
  }
  const sources = configs.map((c) => ({ bot: c.larkProfile, home: c.antigravityHome, workspace: c.workspace, stateFile: path.join(c.stateDir, 'sessions.json') }));
  const makeStore = (i) => {
    const raw = createSharedClaudeSessionStore({
      config: configs[i],
      sources,
      sessionsPath: sources[i].stateFile,
      createSessionData: (title) => ({ id: crypto.randomUUID(), title, engine: 'antigravity', createdAt: Date.now(), updatedAt: Date.now(), messages: [], antigravitySessionId: '' }),
    });
    return {
      ...raw,
      getChatState: (chatId, ctx = ownerCtx(chatId)) => raw.getChatState(chatId, ctx),
      getSession: (chatId, ctx = ownerCtx(chatId)) => raw.getSession(chatId, ctx),
      resetSession: (chatId, title, ctx = ownerCtx(chatId)) => raw.resetSession(chatId, title, ctx),
    };
  };

  const storeA = makeStore(0);
  const storeB = makeStore(1);
  const fixtures = [];
  const bridgeA = createAntigravityBridge({
    config: configs[0],
    ...storeA,
    sharedSessions: storeA.shared,
    activeJobs: new Map(),
    activeChildren: new Map(),
    userText: (v) => String(v || ''),
    sendMarkdown: async () => {},
    appendText: () => {}, reduceEvent: () => {}, markPhase: () => {}, ensureDone: () => {}, markInterrupted: () => {}, markError: () => {},
    createClient: (opts) => {
      const f = makeAcpFixture(null, opts);
      fixtures.push(f);
      return f.client;
    },
  });
  t.after(() => bridgeA.close());

  const sessionA = storeA.getSession('chat-1');
  const r1 = await bridgeA.run({ chat_id: 'chat-1', chat_type: 'p2p', sender_id: 'ou_owner1', message_id: 'm1', content: 'turn1' }, sessionA);
  assert.equal(r1.text, 'ECHO:turn1');
  assert.equal(fixtures.length, 1);
  assert.equal(bridgeA.hasWarm('chat-1'), true);
  assert.equal(fixtures[0].client.closed, false);

  // Lease MUST be released while warm so Bot B is never blocked!
  const leaseB = storeB.shared.acquire(storeB.getSession('chat-2'));
  leaseB();
  assert.equal(fs.readdirSync(path.join(root, 'antigravity-account-usage')).length, 0);

  // Turn 2 on Bot A reuses exact same live ACP process (ZERO new spawn, ZERO extra openSession!)
  const r2 = await bridgeA.run({ chat_id: 'chat-1', chat_type: 'p2p', sender_id: 'ou_owner1', message_id: 'm2', content: 'turn2' }, sessionA);
  assert.equal(r2.text, 'ECHO:turn2');
  assert.equal(fixtures.length, 1);
  assert.equal(fixtures[0].requests.filter((r) => r.method === 'session/new' || r.method === 'session/resume').length, 1);

  // Simulate Bot B running a turn on the same shared session (advances updatedAt)
  const sessionB = storeB.getSession('chat-2');
  sessionB.updatedAt = Date.now() + 5000;
  storeB.saveSessions();

  // Turn 3 on Bot A reloads updatedAt, retires stale client #1, and spawns fresh client #2!
  const refreshedA = storeA.getSession('chat-1');
  const r3 = await bridgeA.run({ chat_id: 'chat-1', chat_type: 'p2p', sender_id: 'ou_owner1', message_id: 'm3', content: 'turn3' }, refreshedA);
  assert.equal(r3.text, 'ECHO:turn3');
  assert.equal(fixtures.length, 2);
  assert.equal(fixtures[0].client.closed, true);
  assert.equal(fixtures[1].client.closed, false);

  // /stop retires warm worker cleanly
  await bridgeA.retireWarm('chat-1');
  assert.equal(bridgeA.hasWarm('chat-1'), false);
  assert.equal(fixtures[1].client.closed, true);
});

test('Claude warm idle pool reuses persistent stream-json client, updates feishu_bridge context per turn, releases shared leases, and invalidates when modified', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-claude-warm-'));
  const envKey = `CFB_CLD_WARM_${crypto.randomBytes(6).toString('hex')}`;
  process.env[envKey] = 'fixture-secret';
  t.after(() => { delete process.env[envKey]; fs.rmSync(root, { recursive: true, force: true }); });

  const ownerCtx = { chatId: 'oc_chat1', chatType: 'p2p', senderId: 'ou_owner1' };
  const catalog = path.join(root, 'claude-providers.json');
  fs.writeFileSync(catalog, JSON.stringify({ providers: [{ id: 'p1', name: 'P1', envKey, baseUrl: 'https://example.invalid', model: 'claude-opus-5-5', effort: 'high', models: ['claude-opus-5-5'] }] }));

  const configs = [1, 2].map((i) => ({
    larkProfile: `claude-${i}`,
    claudeHome: path.join(root, 'homes', `claude-${i}`),
    workspace: path.join(root, 'ws', `claude-${i}`),
    stateDir: path.join(root, 'state', `claude-${i}`),
    claudeSharedSessionsRoot: path.join(root, 'shared'),
    claudeBotConfig: path.join(root, `bot-${i}.json`),
    claudeProviderCatalog: catalog,
    claudeProviderId: 'p1',
    claudeCli: { command: 'claude' },
    larkCli: { command: 'lark-cli', argsPrefix: [] },
    ownerOpenId: 'ou_owner1',
    disableMcp: true,
    claudeIdleTtlMs: 30_000,
  }));
  for (const c of configs) {
    fs.mkdirSync(c.claudeHome, { recursive: true });
    fs.mkdirSync(c.workspace, { recursive: true });
    fs.mkdirSync(c.stateDir, { recursive: true });
    fs.writeFileSync(c.claudeBotConfig, JSON.stringify({ engine: 'claude', provider: { id: 'p1', model: 'claude-opus-5-5', reasoning: 'high' }, claude: { permissionMode: 'bypassPermissions' } }));
  }

  const sources = configs.map((c) => ({ bot: c.larkProfile, home: c.claudeHome, workspace: c.workspace, stateFile: path.join(c.stateDir, 'sessions.json') }));
  const makeStore = (i) => {
    const raw = createSharedClaudeSessionStore({
      config: configs[i],
      sources,
      sessionsPath: sources[i].stateFile,
      createSessionData: (title) => ({ id: crypto.randomBytes(4).toString('hex'), title, engine: 'claude', createdAt: Date.now(), updatedAt: Date.now(), messages: [], claudeSessionId: '' }),
      normalizeSessionData: (s) => ({ ...s }),
    });
    return {
      ...raw,
      getChatState: (chatId, ctx = { ...ownerCtx, chatId }) => raw.getChatState(chatId, ctx),
      getSession: (chatId, ctx = { ...ownerCtx, chatId }) => raw.getSession(chatId, ctx),
      resetSession: (chatId, title, ctx = { ...ownerCtx, chatId }) => raw.resetSession(chatId, title, ctx),
    };
  };

  const storeA = makeStore(0);
  const storeB = makeStore(1);
  const spawnedClients = [];
  const nativeSessionId = crypto.randomUUID();

  const bridgeA = createClaudeBridge({
    config: configs[0],
    ...storeA,
    getChats: () => storeA.sessions.chats,
    sharedSessions: storeA.shared,
    userText: (v) => String(v || ''),
    activeJobs: new Map(),
    activeChildren: new Map(),
    appendText: () => {}, reduceEvent: () => {}, markPhase: () => {}, ensureDone: () => {}, markInterrupted: () => {}, markError: () => {},
    sendMarkdown: async () => {},
    createClient: (opts) => {
      const client = new ClaudeCliClient({
        ...opts,
        spawnProcess: () => makeClaudePersistentChild((msg, child) => {
          if (msg.type !== 'user') return;
          const text = msg.message?.content?.[0]?.text || '';
          child.send({ type: 'system', subtype: 'init', session_id: nativeSessionId, model: 'claude-opus-5-5', claude_code_version: '2.1.331', permissionMode: 'bypassPermissions' });
          child.send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `CLD:${text}` } } });
          child.send({ type: 'result', is_error: false, result: `CLD:${text}`, user_message_uuids: [msg.uuid], usage: { input_tokens: 10, output_tokens: 5 } });
        }),
      });
      spawnedClients.push(client);
      return client;
    },
  });
  t.after(() => bridgeA.close());

  const mcpCfg = JSON.parse(feishuMcpConfiguration(configs[0], { chat_id: 'oc_chat1', message_id: 'om_turn1' }));
  const mcpCtx = JSON.parse(mcpCfg.mcpServers.feishu_bridge.env.CFB_FEISHU_TOOL_CONTEXT);

  const sessionA = storeA.getSession('oc_chat1');
  const r1 = await bridgeA.run({ chat_id: 'oc_chat1', chat_type: 'p2p', sender_id: 'ou_owner1', message_id: 'om_turn1', content: 'first' }, sessionA, null);
  assert.equal(r1.text, 'CLD:first');
  assert.equal(spawnedClients.length, 1);
  assert.equal(bridgeA.hasWarm('oc_chat1'), true);
  assert.equal(spawnedClients[0].closed, false);

  // Lease MUST be released while warm!
  const leaseB = storeB.shared.acquire(storeB.getSession('oc_chat1'));
  leaseB();

  // Turn 2 reuses the exact same warm ClaudeCliClient AND updates dynamic feishu_bridge context!
  const r2 = await bridgeA.run({ chat_id: 'oc_chat1', chat_type: 'p2p', sender_id: 'ou_owner1', message_id: 'om_turn2', content: 'second' }, sessionA, null);
  assert.equal(r2.text, 'CLD:second');
  assert.equal(spawnedClients.length, 1);
  const liveConv = await callFeishuTool('current_conversation', {}, mcpCtx);
  assert.equal(liveConv.message_id, 'om_turn2');

  // Simulate Bot B updating the shared session -> Bot A retires stale warm client & spawns fresh one!
  const sessionB = storeB.getSession('oc_chat1');
  sessionB.updatedAt = Date.now() + 5000;
  storeB.saveSessions();

  const r3 = await bridgeA.run({ chat_id: 'oc_chat1', chat_type: 'p2p', sender_id: 'ou_owner1', message_id: 'om_turn3', content: 'third' }, storeA.getSession('oc_chat1'), null);
  assert.equal(r3.text, 'CLD:third');
  assert.equal(spawnedClients.length, 2);
  assert.equal(spawnedClients[0].closed, true);
  assert.equal(spawnedClients[1].closed, false);
});

test('lark-cli 1.0.100 compatibility: resolveUserUnionId passes --params without query string in path', async () => {
  const calls = [];
  const lark = createLarkClient({
    larkCli: 'lark',
    runTool: async (_cmd, args) => {
      calls.push(args);
      return { code: 0, stdout: JSON.stringify({ code: 0, data: { user: { union_id: 'on_compat100' } } }), stderr: '' };
    },
    delay: async () => {},
    splitText: (s) => [s],
    idempotencyKey: () => 'k',
  });
  const unionId = await lark.resolveUserUnionId('ou_compatUser1');
  assert.equal(unionId, 'on_compat100');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], '/open-apis/contact/v3/users/ou_compatUser1');
  assert.equal(calls[0][2].includes('?'), false);
  const paramsIndex = calls[0].indexOf('--params');
  assert.ok(paramsIndex > 2);
  assert.deepEqual(JSON.parse(calls[0][paramsIndex + 1]), { user_id_type: 'open_id' });
});
