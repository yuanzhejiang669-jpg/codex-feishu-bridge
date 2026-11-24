import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AntigravityAcpClient, antigravityEnvironment, safeMessage } from '../src/antigravity/acp-client.mjs';
import { createAntigravityBridge } from '../src/antigravity/bridge-runner.mjs';
import {
  getAntigravityConversationState,
  isAntigravityConversationBusy,
  isInAntigravityDesktopSidebar,
  listAntigravityNativeConversations,
} from '../src/antigravity/native-sessions.mjs';
import { createClaudeBridge } from '../src/claude/bridge-runner.mjs';
import { parseCommand } from '../src/commands/parser.mjs';
import { classifyCodexFailure } from '../src/logging/errors.mjs';
import agentEngine from '../src/agents/engine.cjs';

function fixture(handler, extra = {}) {
  const child = new EventEmitter(); child.pid = 12345;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin.on('finish', () => queueMicrotask(() => child.emit('close', 0)));
  child.kill = () => child.emit('close', 0);
  const requests = []; let buffer = '';
  const send = (value) => child.stdout.write(JSON.stringify(value) + '\n');
  child.stdin.on('data', (data) => {
    buffer += data;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'); const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      requests.push(request);
      queueMicrotask(() => {
        if (handler?.(request, send, child) === true) return;
        if (request.id == null) return;
        const result = request.method === 'initialize' ? { agentCapabilities: { loadSession: true } }
          : ['session/new', 'session/load'].includes(request.method) ? { sessionId: request.params.sessionId || 'native-session' } : {};
        send({ jsonrpc: '2.0', id: request.id, result });
      });
    }
  });
  const events = [];
  const client = new AntigravityAcpClient({ command: 'fixture', cwd: '.', spawnProcess: () => child,
    requestTimeoutMs: 2000, idleTimeoutMs: 1000, onEvent: (event) => events.push(event), ...extra });
  return { client, child, requests, send, events };
}

test('native ACP load suppresses history replay, streams split UTF-8, and reports context', async () => {
  const f = fixture((request, send, child) => {
    if (request.method === 'session/load') {
      send({ method: 'session/update', params: { sessionId: 'existing', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old history' } } } });
    }
    if (request.method !== 'session/prompt') return false;
    const line = Buffer.from(JSON.stringify({ method: 'session/update', params: { sessionId: 'existing', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '原生续聊' } } } }) + '\n');
    for (let i = 0; i < line.length; i += 1) child.stdout.write(line.subarray(i, i + 1));
    send({ method: 'session/update', params: { sessionId: 'existing', update: { sessionUpdate: 'usage_update', used: 9000, size: 1048576 } } });
    send({ id: request.id, result: { stopReason: 'end_turn' } }); return true;
  });
  await f.client.openSession({ sessionId: 'existing', model: 'native-model', effort: 'high', mode: 'plan' });
  const result = await f.client.prompt([{ type: 'text', text: 'hello' }]);
  assert.equal(result.text, '原生续聊'); assert.equal(result.runtime.context.usedTokens, 9000);
  assert.ok(!f.events.some((event) => event.update?.content?.text === 'old history'));
  assert.deepEqual(f.requests.map((item) => item.method), ['initialize', 'session/load', 'session/set_model', 'session/set_config_option', 'session/set_mode', 'session/prompt']);
  await f.client.close(); assert.equal(f.client.closed, true);
});

test('permissions use the offered option ID and are cancelled when stopped', async () => {
  let allow; const decision = new Promise((resolve) => { allow = resolve; });
  const f = fixture(null, { onPermission: () => decision });
  await f.client.openSession();
  f.send({ id: 'permission-1', method: 'session/request_permission', params: { sessionId: 'native-session', options: [{ optionId: 'native-allow', kind: 'allow_once' }] } });
  await new Promise((resolve) => setImmediate(resolve)); allow(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.requests.find((item) => item.id === 'permission-1').result.outcome, { outcome: 'selected', optionId: 'native-allow' });
  f.client.onPermission = () => new Promise(() => {});
  f.send({ id: 'permission-2', method: 'session/request_permission', params: { options: [] } });
  await new Promise((resolve) => setImmediate(resolve)); f.client.interrupt();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.requests.find((item) => item.id === 'permission-2').result.outcome, { outcome: 'cancelled' });
  assert.ok(f.requests.some((item) => item.method === 'session/cancel'));
  await f.client.close();
});

test('stop interrupts startup and shutdown rejects outstanding requests', async () => {
  const f = fixture((request) => request.method === 'initialize');
  const opening = f.client.openSession(); f.client.interrupt();
  await assert.rejects(opening, { code: 'USER_STOP' }); await f.client.close();
  assert.equal(f.client.pending.size, 0);
  const before = fixture(); before.client.interrupt();
  await assert.rejects(before.client.openSession(), { code: 'USER_STOP' });
  assert.equal(before.requests.length, 0);
});

test('native steer: a second session/prompt joins the running turn and prompt() follows the hand-over', async () => {
  // Mirrors live agy 1.5.14 behaviour: when a prompt arrives mid-turn, agy answers the earlier
  // session/prompt with end_turn right away and the newest request carries the rest of the turn.
  const prompts = [];
  const f = fixture((request, send) => {
    if (request.method !== 'session/prompt') return false;
    prompts.push(request);
    const chunk = (text) => send({ method: 'session/update', params: { sessionId: 'native-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
    if (prompts.length === 1) { chunk('STEP1 '); return true; }
    send({ id: prompts[0].id, result: { stopReason: 'end_turn' } });
    setTimeout(() => { chunk('STEP2 STEER-OK'); send({ id: request.id, result: { stopReason: 'end_turn', usage: { inputTokens: 7 } } }); }, 30);
    return true;
  });
  await f.client.openSession();
  assert.equal(f.client.canSteer(), false);
  assert.throws(() => f.client.steer([{ type: 'text', text: 'too early' }]), { code: 'ANTIGRAVITY_NO_ACTIVE_TURN' });
  const running = f.client.prompt([{ type: 'text', text: 'run 3 steps' }]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.client.canSteer(), true);
  f.client.steer([{ type: 'text', text: 'append STEER-OK' }]);
  const result = await running;
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.usage.inputTokens, 7);
  assert.equal(result.text, 'STEP1 STEP2 STEER-OK');
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1].params.sessionId, 'native-session');
  assert.deepEqual(prompts[1].params.prompt, [{ type: 'text', text: 'append STEER-OK' }]);
  assert.equal(f.client.canSteer(), false);
  await f.client.close();
});

test('native steer: a rejected steer request never takes the running turn down', async () => {
  const prompts = [];
  const f = fixture((request, send) => {
    if (request.method !== 'session/prompt') return false;
    prompts.push(request);
    if (prompts.length === 1) return true;
    send({ id: request.id, error: { code: -32000, message: 'steer refused' } });
    setTimeout(() => send({ id: prompts[0].id, result: { stopReason: 'end_turn' } }), 30);
    return true;
  });
  await f.client.openSession();
  const running = f.client.prompt([{ type: 'text', text: 'long task' }]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const steer = f.client.steer([{ type: 'text', text: 'extra' }]);
  await assert.rejects(steer, /steer refused/);
  const result = await running;
  assert.equal(result.stopReason, 'end_turn');
  await f.client.close();
});

test('provider secrets are isolated and redacted; native slash commands remain native', () => {
  assert.deepEqual(antigravityEnvironment({ PATH: 'p', GEMINI_API_KEY: 'old', GOOGLE_API_KEY: 'old', GOOGLE_GEMINI_BASE_URL: 'old' }, { mode: 'official' }), { PATH: 'p' });
  const api = antigravityEnvironment({}, { mode: 'gemini-api', apiKey: 'test-secret', baseUrl: 'https://example.invalid' });
  assert.equal(api.GEMINI_API_KEY, 'test-secret');
  assert.throws(() => antigravityEnvironment({}, { mode: 'gemini-api' }), /Key/);
  assert.ok(!safeMessage('echo test-secret Bearer abc sk-example', ['test-secret']).includes('test-secret'));
  assert.equal(parseCommand('/compact', { engine: 'antigravity' }), null);
  assert.equal(parseCommand('/steer 1', { engine: 'antigravity' }).name, '/steer');
  assert.equal(parseCommand('/goal do x', { engine: 'antigravity' }), null);
  assert.equal(parseCommand('/swarm parallel task', { engine: 'antigravity' }), null);
  assert.equal(parseCommand('/fast on', { engine: 'antigravity' }).name, '/fast');
  assert.equal(parseCommand('/eli5 hello', { engine: 'antigravity' }), null);
  assert.equal(parseCommand('/context', { engine: 'antigravity' }).name, '/context');
});

test('ENG-AGY-002: /model status uses zero subprocesses, /model list uses zero-MCP cached probe without mutating session/runtime, /effort clear works', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-agy-cmd-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const envKey = `CFB_AGY_KEY_${process.pid}_${Math.random().toString(16).slice(2)}`;
  process.env[envKey] = 'fixture-gemini-key';
  t.after(() => { delete process.env[envKey]; });

  const stateDir = path.join(root, 'state');
  const logDir = path.join(root, 'logs');
  const agyHome = path.join(root, 'agy-home');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(agyHome, { recursive: true });

  // Write provider catalog with a gemini-api provider (no official account needed)
  fs.writeFileSync(path.join(root, 'antigravity-providers.json'), JSON.stringify({
    schemaVersion: 1,
    providers: [{
      id: 'api-one',
      name: 'Gemini API',
      mode: 'gemini-api',
      baseUrl: 'https://example.invalid',
      envKey,
      model: 'gemini-4-neon',
      effort: 'high',
    }],
  }));
  const botConfigPath = path.join(root, 'bot.json');
  fs.writeFileSync(botConfigPath, JSON.stringify({
    engine: 'antigravity',
    provider: { id: 'api-one', model: 'gemini-4-neon', reasoning: 'high' },
    antigravity: { permissionMode: 'always-proceed' },
  }));
  const runtimePath = path.join(stateDir, 'antigravity-runtime.json');
  const originalRuntime = JSON.stringify({ sentinel: 'keep-me', sessionId: 'existing-runtime' });
  fs.writeFileSync(runtimePath, originalRuntime);

  const session = {
    id: 's-ag-1',
    engine: 'antigravity',
    title: 'AG',
    antigravitySessionId: '',
    reasoningOverride: 'xhigh',
  };
  const chat = { currentSessionId: session.id, sessions: [session] };
  const replies = [];
  let createClientCalls = 0;
  const openSessionCalls = [];
  let closeCalls = 0;

  const bridge = createAntigravityBridge({
    config: {
      stateDir,
      logDir,
      workspace: root,
      antigravityHome: agyHome,
      antigravityDataRoot: root,
      antigravityBotConfig: botConfigPath,
      antigravityCli: { command: 'agy' },
    },
    getSession: () => session,
    getChatState: () => chat,
    getChats: () => ({ 'chat-1': chat }),
    resetSession: () => session,
    saveSessions: () => {},
    userText: (c) => c,
    sendMarkdown: async (_chatId, text) => replies.push(text),
    activeChildren: new Map(),
    activeJobs: new Map(),
    appendText: () => {},
    reduceEvent: () => {},
    markPhase: () => {},
    ensureDone: () => {},
    markInterrupted: () => {},
    markError: () => {},
    queueSummary: () => '无',
    createClient: () => {
      createClientCalls += 1;
      return {
        runtime: { agentInfo: { version: '1.6.0' } },
        async openSession(opts) {
          openSessionCalls.push(opts);
          return {
            sessionId: 'ephemeral-probe-session',
            models: { availableModels: [{ modelId: 'gemini-4-neon', name: 'Gemini 4 Neon' }] },
            configOptions: [{ id: 'thought_level', options: [{ value: 'low' }, { value: 'high' }, { value: 'xhigh' }] }],
            modes: [],
          };
        },
        async close() { closeCalls += 1; },
        interrupt() {},
      };
    },
  });
  t.after(() => bridge.close());

  const event = { chat_id: 'chat-1', sender_id: 'ou_owner', chat_type: 'p2p', message_id: 'm1' };

  // 1) /model and /model status must NOT call createClient
  await bridge.handleCommand(event, { name: '/model', rest: '' });
  await bridge.handleCommand(event, { name: '/model', rest: 'status' });
  assert.equal(createClientCalls, 0);
  assert.match(replies.at(-1), /gemini-4-neon/);

  // 2) /model list uses zero MCP, empty sessionId, preserves session & runtime file
  await bridge.handleCommand(event, { name: '/model', rest: 'list' });
  assert.equal(createClientCalls, 1);
  assert.equal(closeCalls, 1);
  assert.deepEqual(openSessionCalls[0], { sessionId: '', mcpServers: [] });
  assert.equal(session.antigravitySessionId, '');
  assert.equal(fs.readFileSync(runtimePath, 'utf8'), originalRuntime);
  assert.match(replies.at(-1), /gemini-4-neon/);

  // 3) Both /model list and /model refresh perform live read-only probes (no stale cache); /model status still uses 0 subprocesses
  await bridge.handleCommand(event, { name: '/model', rest: 'list' });
  assert.equal(createClientCalls, 2);
  assert.match(replies.at(-1), /实时只读探针/);
  await bridge.handleCommand(event, { name: '/model', rest: 'refresh' });
  assert.equal(createClientCalls, 3);
  await bridge.handleCommand(event, { name: '/model', rest: 'status' });
  assert.equal(createClientCalls, 3);

  // 4) /effort rejects option outside cached thought_level; /effort clear restores default
  await assert.rejects(bridge.handleCommand(event, { name: '/effort', rest: 'max' }), /可用选项/);
  await bridge.handleCommand(event, { name: '/effort', rest: 'clear' });
  assert.equal(session.reasoningOverride, undefined);
  assert.match(replies.at(-1), /已清除/);

  // 5) Dynamic engineDisplayName removes hardcoded Codex copy in shared bridge paths
  assert.equal(agentEngine.engineDisplayName('antigravity'), 'Antigravity');
  assert.equal(agentEngine.engineDisplayName('claude'), 'Claude Code');
  assert.equal(agentEngine.engineDisplayName('codex'), 'Codex');
  const bridgeSrc = [
    fs.readFileSync(new URL('../codex-feishu-bridge.mjs', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../src/commands/router.mjs', import.meta.url), 'utf8'),
  ].join('\n');
  assert.match(bridgeSrc, /当前没有运行中的 \$\{ENGINE_LABEL\} 任务/);
  assert.doesNotMatch(bridgeSrc, /当前没有运行中的 Codex 任务/);
});

test('Antigravity native sessions: filters ghost summary rows without .db files, avoids IDLE+not_fully_idle deadlock, and tags engine errors cleanly', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-agy-ghost-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  const desktopAppDir = path.join(root, 'antigravity');
  const convDir = path.join(desktopAppDir, 'conversations');
  fs.mkdirSync(convDir, { recursive: true });

  const aliveRunningId = 'aaaaaaaa-1111-4111-8111-111111111111';
  const staleIdleId = 'bbbbbbbb-2222-4222-8222-222222222222';
  const deletedGhostId = 'cccccccc-3333-4333-8333-333333333333';

  // Only the first two exist on disk; deletedGhostId is a stale orphan row in SQLite
  fs.writeFileSync(path.join(convDir, `${aliveRunningId}.db`), 'live-db');
  fs.writeFileSync(path.join(convDir, `${staleIdleId}.db`), 'idle-db');

  const db = new DatabaseSync(path.join(desktopAppDir, 'conversation_summaries.db'));
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id text PRIMARY KEY,
      title text NOT NULL DEFAULT "",
      preview text NOT NULL DEFAULT "",
      step_count integer NOT NULL DEFAULT 0,
      last_modified_time datetime NOT NULL,
      workspace_uris text NOT NULL,
      status text NOT NULL DEFAULT "",
      not_fully_idle numeric NOT NULL DEFAULT false,
      killed numeric NOT NULL DEFAULT false,
      parent_conversation_id text NOT NULL DEFAULT "",
      app_data_dir text NOT NULL DEFAULT "antigravity"
    );
  `);
  const ins = db.prepare(`INSERT INTO conversation_summaries VALUES (?, ?, '', 10, ?, '', ?, ?, 0, '', 'antigravity')`);
  ins.run(aliveRunningId, 'Actually Running', '2026-11-24 01:25:00.000+00:00', 'CASCADE_RUN_STATUS_RUNNING', 1);
  ins.run(staleIdleId, 'Stale Background Idle', '2026-11-24 01:20:00.000+00:00', 'CASCADE_RUN_STATUS_IDLE', 1);
  ins.run(deletedGhostId, 'Deleted Ghost Row', '2026-11-23 07:00:00.000+00:00', 'CASCADE_RUN_STATUS_IDLE', 0);
  db.close();

  // 1) Deleted ghost row is filtered out because conversations/ exists and lacks cccccccc*.db/.pb
  const listed = listAntigravityNativeConversations({ geminiDir: root, appDataDir: 'antigravity' });
  assert.deepEqual(listed.map((item) => item.conversationId), [aliveRunningId, staleIdleId]);
  assert.equal(listed[0].running, true);
  assert.equal(listed[1].running, false);

  // 2) IDLE + not_fully_idle=1 must NOT be considered busy (fixes permanent self-deadlock)
  assert.equal(isAntigravityConversationBusy({ geminiDir: root, appDataDir: 'antigravity', conversationId: aliveRunningId }), true);
  assert.equal(isAntigravityConversationBusy({ geminiDir: root, appDataDir: 'antigravity', conversationId: staleIdleId }), false);
  const staleState = getAntigravityConversationState({ geminiDir: root, appDataDir: 'antigravity', conversationId: staleIdleId });
  assert.equal(staleState.exists, true);
  assert.equal(staleState.running, false);
  assert.equal(staleState.notFullyIdle, true);

  // 3) Pre-flight Antigravity busy error carries engine='antigravity' and classifies cleanly (never "Codex 运行失败")
  const stateDir = path.join(root, 'state');
  const logDir = path.join(root, 'logs');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const botConfigPath = path.join(root, 'bot.json');
  fs.writeFileSync(botConfigPath, JSON.stringify({ engine: 'antigravity', provider: { id: 'official' }, antigravity: { permissionMode: 'always-proceed' } }));
  const agySession = {
    id: 's1',
    title: 'Actually Running',
    engine: 'antigravity',
    antigravitySessionId: aliveRunningId,
    antigravityHome: root,
    antigravityAppDataDir: 'antigravity',
  };
  const agyBridge = createAntigravityBridge({
    config: {
      stateDir, logDir, workspace: root, antigravityDataRoot: root, antigravityHome: root,
      antigravityDesktopGeminiDir: root, antigravityBotConfig: botConfigPath, antigravityCli: { command: 'agy' },
    },
    getSession: () => agySession,
    getChatState: () => ({ currentSessionId: 's1', sessions: [agySession] }),
    getChats: () => ({ c1: { currentSessionId: 's1', sessions: [agySession] } }),
    resetSession: () => agySession,
    saveSessions: () => {},
    userText: (c) => String(c || ''),
    sendMarkdown: async () => {},
    activeChildren: new Map(),
    activeJobs: new Map(),
    appendText: () => {}, reduceEvent: () => {}, markPhase: () => {}, ensureDone: () => {}, markInterrupted: () => {}, markError: () => {},
  });
  t.after(() => agyBridge.close());
  let caughtAgy;
  try {
    await agyBridge.run({ chat_id: 'c1', message_id: 'm1', content: '现在怎么样了' }, agySession);
  } catch (err) {
    caughtAgy = err;
  }
  assert.ok(caughtAgy);
  assert.equal(caughtAgy.engine, 'antigravity');
  assert.equal(caughtAgy.code, 'ANTIGRAVITY_DESKTOP_BUSY');
  const agyFailure = classifyCodexFailure(caughtAgy);
  assert.equal(agyFailure.kind, 'desktop_busy');
  assert.equal(agyFailure.label, '客户端对话运行中');
  assert.doesNotMatch(agyFailure.message, /Codex/);

  // 4) Claude pre-flight error (wrong engine) also carries engine='claude' and never mislabels as "Codex 运行失败"
  const claudeBridge = createClaudeBridge({
    config: { stateDir, logDir, workspace: root, claudeHome: root, claudeCli: { command: 'claude' } },
    getSession: () => ({ id: 'x1', engine: 'codex' }),
    getChatState: () => ({ currentSessionId: 'x1', sessions: [] }),
    getChats: () => ({}),
    resetSession: () => ({}),
    saveSessions: () => {},
    userText: (c) => String(c || ''),
    sendText: async () => {}, sendMarkdown: async () => {},
    activeChildren: new Map(), activeJobs: new Map(),
    appendText: () => {}, reduceEvent: () => {}, markPhase: () => {}, ensureDone: () => {}, markInterrupted: () => {}, markError: () => {},
    terminateProcessTree: () => {}, log: () => {},
  });
  t.after(() => claudeBridge.close());
  let caughtClaude;
  try {
    await claudeBridge.run({ chat_id: 'c1', message_id: 'm2', content: 'hi' }, { id: 'x1', engine: 'codex' });
  } catch (err) {
    caughtClaude = err;
  }
  assert.ok(caughtClaude);
  assert.equal(caughtClaude.engine, 'claude');
  const claudeFailure = classifyCodexFailure(caughtClaude);
  assert.match(claudeFailure.message, /Claude Code 运行失败/);
  assert.doesNotMatch(claudeFailure.message, /Codex 运行失败/);
});

test('Antigravity ACP keepalive: preserves live worker across background tasks, delivers out-of-turn wakeup to Feishu, and reuses live worker on follow-up', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-agy-bg-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const stateDir = path.join(root, 'state');
  const logDir = path.join(root, 'logs');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const botConfigPath = path.join(root, 'bot.json');
  fs.writeFileSync(botConfigPath, JSON.stringify({ engine: 'antigravity', provider: { id: 'official' }, antigravity: { permissionMode: 'always-proceed' } }));

  const session = { id: 'bg1', title: 'HVI-CIDNet', engine: 'antigravity', messages: [], antigravitySessionId: '' };
  const chat = { currentSessionId: 'bg1', sessions: [session] };
  const sentMessages = [];
  const activeJobs = new Map();
  let spawnCount = 0;
  let activeFixture = null;
  let promptIndex = 0;

  const bridge = createAntigravityBridge({
    config: {
      stateDir, logDir, workspace: root, antigravityDataRoot: root, antigravityHome: root,
      antigravityBotConfig: botConfigPath, antigravityCli: { command: 'fixture' },
      antigravityBackgroundPollMs: 40,
      antigravityBackgroundFlushMs: 50,
      antigravityBackgroundUsageFlushMs: 30,
      antigravityBackgroundTimeoutMs: 10_000,
    },
    getSession: () => session,
    getChatState: () => chat,
    getChats: () => ({ 'chat-bg': chat }),
    resetSession: () => session,
    saveSessions: () => {},
    userText: (c) => String(c || ''),
    sendMarkdown: async (chatId, text, kind) => { sentMessages.push({ chatId, text, kind }); },
    activeChildren: new Map(),
    activeJobs,
    appendText: () => {}, reduceEvent: () => {}, markPhase: () => {}, ensureDone: () => {}, markInterrupted: () => {}, markError: () => {},
    createClient: (opts) => {
      spawnCount += 1;
      activeFixture = fixture((request, send) => {
        if (request.method !== 'session/prompt') return false;
        promptIndex += 1;
        if (promptIndex === 1) {
          // Turn 1 launches an in-flight background tool and ends turn waiting for wakeup
          send({ method: 'session/update', params: { sessionId: 'native-session', update: { sessionUpdate: 'tool_call', toolCallId: 'bg-task-1', title: 'Download LOL', status: 'in_progress' } } });
          send({ method: 'session/update', params: { sessionId: 'native-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '正在后台下载数据集' } } } });
          send({ id: request.id, result: { stopReason: 'end_turn' } });
          return true;
        }
        // Turn 2 ("现在怎么样了") arrives on the SAME reused live worker while bg-task-1 is still running
        send({ method: 'session/update', params: { sessionId: 'native-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '还在下载，已完成 60%' } } } });
        send({ id: request.id, result: { stopReason: 'end_turn' } });
        return true;
      }, opts);
      return activeFixture.client;
    },
  });
  t.after(() => bridge.close());

  // 1) Turn 1 returns with pending tool -> client stays alive & parked
  const r1 = await bridge.run({ chat_id: 'chat-bg', message_id: 'm1', content: '开始实验' }, session);
  assert.equal(r1.text, '正在后台下载数据集');
  assert.equal(spawnCount, 1);
  assert.equal(bridge.hasBackground('chat-bg'), true);
  assert.equal(activeFixture.client.closed, false);

  // 2) Follow-up ("现在怎么样了") reuses the exact same parked client (spawnCount stays 1!)
  const r2 = await bridge.run({ chat_id: 'chat-bg', message_id: 'm2', content: '现在怎么样了' }, session);
  assert.equal(r2.text, '还在下载，已完成 60%');
  assert.equal(spawnCount, 1);
  assert.equal(bridge.hasBackground('chat-bg'), true);
  assert.equal(activeFixture.client.closed, false);

  // 3) Background task completes and wakes the agent out-of-turn -> automatically delivered to Feishu & auto-retired!
  activeFixture.send({ method: 'session/update', params: { sessionId: 'native-session', update: { sessionUpdate: 'tool_call_update', toolCallId: 'bg-task-1', status: 'completed' } } });
  activeFixture.send({ method: 'session/update', params: { sessionId: 'native-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '数据集已就绪，已启动两张 4090 训练。' } } } });
  activeFixture.send({ method: 'session/update', params: { sessionId: 'native-session', update: { sessionUpdate: 'usage_update', used: 2048, size: 1048576 } } });

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && (sentMessages.length === 0 || bridge.hasBackground('chat-bg'))) {
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].kind, 'antigravity-background-wakeup');
  assert.match(sentMessages[0].text, /Antigravity 后台任务进展/);
  assert.match(sentMessages[0].text, /已启动两张 4090 训练/);
  assert.equal(bridge.hasBackground('chat-bg'), false);
  assert.equal(activeFixture.client.closed, true);
  assert.ok(session.messages.some((m) => m.role === 'assistant' && m.content.includes('4090')));
});

test('Antigravity routes new Feishu sessions to Bridge CLI store, checks agyhub_summaries_proto.pb for true sidebar ownership, and supports unified /model subcommands', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-agy-sidebar-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  const stateDir = path.join(root, 'state');
  const logDir = path.join(root, 'logs');
  const agyHome = path.join(root, 'agy-home');
  const desktopGeminiDir = path.join(root, 'desktop-gemini');
  const desktopAppDir = path.join(desktopGeminiDir, 'antigravity');
  const convDir = path.join(desktopAppDir, 'conversations');
  for (const dir of [stateDir, logDir, agyHome, convDir]) fs.mkdirSync(dir, { recursive: true });

  const realSidebarId = '11111111-1111-4111-8111-111111111111';
  const legacyFeishuId = '22222222-2222-4222-8222-222222222222';
  fs.writeFileSync(path.join(convDir, `${realSidebarId}.db`), 'real-sidebar-db');
  fs.writeFileSync(path.join(convDir, `${legacyFeishuId}.db`), 'legacy-feishu-db');
  // agyhub_summaries_proto.pb only contains the real Desktop sidebar conversation (just like real Desktop)
  fs.writeFileSync(path.join(desktopAppDir, 'agyhub_summaries_proto.pb'), `proto-header:${realSidebarId}:tail`);

  const db = new DatabaseSync(path.join(desktopAppDir, 'conversation_summaries.db'));
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT "", preview text NOT NULL DEFAULT "",
      step_count integer NOT NULL DEFAULT 0, last_modified_time datetime NOT NULL, workspace_uris text NOT NULL,
      status text NOT NULL DEFAULT "", not_fully_idle numeric NOT NULL DEFAULT false, killed numeric NOT NULL DEFAULT false,
      parent_conversation_id text NOT NULL DEFAULT "", app_data_dir text NOT NULL DEFAULT "antigravity"
    );
  `);
  const ins = db.prepare(`INSERT INTO conversation_summaries VALUES (?, ?, '', 5, ?, '', 'CASCADE_RUN_STATUS_IDLE', 0, 0, '', 'antigravity')`);
  ins.run(realSidebarId, 'Real Desktop Chat', '2026-11-24 02:00:00.000+00:00');
  ins.run(legacyFeishuId, 'Legacy Feishu In Desktop Dir', '2026-11-24 01:50:00.000+00:00');
  db.close();

  assert.equal(isInAntigravityDesktopSidebar({ geminiDir: desktopGeminiDir, appDataDir: 'antigravity', conversationId: realSidebarId }), true);
  assert.equal(isInAntigravityDesktopSidebar({ geminiDir: desktopGeminiDir, appDataDir: 'antigravity', conversationId: legacyFeishuId }), false);

  const botConfigPath = path.join(root, 'bot.json');
  fs.writeFileSync(botConfigPath, JSON.stringify({ engine: 'antigravity', provider: { id: 'official', model: '', reasoning: '' }, antigravity: { permissionMode: 'always-proceed' } }));
  fs.writeFileSync(path.join(stateDir, 'antigravity-runtime.json'), JSON.stringify({
    provider: 'official',
    models: {
      currentModelId: 'gemini-4-neon-high',
      availableModels: [
        { modelId: 'gemini-4-neon-low' }, { modelId: 'gemini-4-neon-high' }, { modelId: 'gemini-4-neon-xhigh' },
      ],
    },
    configOptions: [
      { id: 'model', currentValue: 'gemini-4-neon', options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }] },
      { id: 'thought_level', currentValue: 'high', options: [{ value: 'low' }, { value: 'high' }, { value: 'xhigh' }] },
    ],
  }));

  const legacySession = {
    id: 'leg01', title: 'Legacy Feishu In Desktop Dir', engine: 'antigravity',
    antigravitySessionId: legacyFeishuId, antigravityHome: desktopGeminiDir, antigravityAppDataDir: 'antigravity',
    antigravityOriginBot: 'antigravity-5', createdAt: Date.now(), updatedAt: Date.now(), messages: [],
  };
  const freshSession = { id: 'new01', title: 'Fresh Chat', engine: 'antigravity', createdAt: Date.now(), updatedAt: Date.now(), messages: [], antigravitySessionId: '' };
  const chat = { currentSessionId: 'leg01', sessions: [legacySession] };
  const replies = [];
  let createdClientOpts = null;

  const bridge = createAntigravityBridge({
    config: {
      stateDir, logDir, workspace: root, antigravityDataRoot: root, antigravityHome: agyHome,
      antigravityDesktopGeminiDir: desktopGeminiDir, antigravityBotConfig: botConfigPath,
      ownerOpenId: 'ou_owner', antigravityCli: { command: 'fixture' },
    },
    getSession: () => chat.sessions.find((s) => s.id === chat.currentSessionId) || freshSession,
    getChatState: () => chat,
    getChats: () => ({ dm: chat }),
    resetSession: () => freshSession,
    saveSessions: () => {},
    userText: (c) => String(c || ''),
    sendMarkdown: async (_c, text) => { replies.push(text); },
    activeChildren: new Map(),
    activeJobs: new Map(),
    appendText: () => {}, reduceEvent: () => {}, markPhase: () => {}, ensureDone: () => {}, markInterrupted: () => {}, markError: () => {},
    createClient: (opts) => {
      createdClientOpts = opts;
      const f = fixture((req, send) => {
        if (req.method === 'session/new') {
          send({
            id: req.id,
            result: {
              sessionId: '33333333-3333-4333-8333-333333333333',
              models: { currentModelId: 'gemini-4-neon-high', availableModels: [{ modelId: 'gemini-4-neon-low' }, { modelId: 'gemini-4-neon-high' }, { modelId: 'gemini-4-neon-xhigh' }] },
              configOptions: [
                { id: 'model', currentValue: 'gemini-4-neon', options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }] },
                { id: 'thought_level', currentValue: 'high', options: [{ value: 'low' }, { value: 'high' }, { value: 'xhigh' }] },
              ],
            },
          });
          return true;
        }
        if (req.method === 'session/prompt') {
          send({ id: req.id, result: { stopReason: 'end_turn' } });
          return true;
        }
        return false;
      }, opts);
      return f.client;
    },
  });
  t.after(() => bridge.close());

  const dmEvt = { chat_id: 'dm', chat_type: 'p2p', sender_id: 'ou_owner', message_id: 'm1' };

  // 1) /list all does NOT falsely label legacySession as 客户端侧边栏, while realSidebarId IS labeled 客户端侧边栏
  await bridge.handleCommand(dmEvt, { name: '/list', rest: 'all' });
  const listOut = replies.at(-1);
  assert.doesNotMatch(listOut, /Legacy Feishu In Desktop Dir.*客户端侧边栏/);
  assert.match(listOut, /Real Desktop Chat.*客户端侧边栏/);

  // 2) /delete 1 deletes legacySession cleanly (including its .db file), while /delete 2 protects realSidebarId
  await bridge.handleCommand(dmEvt, { name: '/delete', rest: '1' });
  assert.match(replies.at(-1), /\/confirm delete 1/);
  await bridge.handleCommand(dmEvt, { name: '/confirm', rest: 'delete 1' });
  assert.equal(fs.existsSync(path.join(convDir, `${legacyFeishuId}.db`)), false);
  assert.equal(fs.existsSync(path.join(convDir, `${realSidebarId}.db`)), true);

  // 3) New Feishu session runs in isolated Bridge antigravity-cli store (NOT Desktop antigravity store)
  chat.sessions = [freshSession];
  chat.currentSessionId = 'new01';
  await bridge.run({ ...dmEvt, content: 'hello new' }, freshSession);
  assert.equal(createdClientOpts.appDataDir, 'antigravity-cli');
  assert.equal(path.resolve(createdClientOpts.geminiDir), path.resolve(agyHome));

  // 4) Unified Codex-style /model, /model capability, /model effort, /model save <model> <effort>, /help
  await bridge.handleCommand(dmEvt, { name: '/model', rest: '' });
  assert.match(replies.at(-1), /当前会话：`Fresh Chat`/);
  assert.match(replies.at(-1), /模型：`gemini-4-neon`/);

  await bridge.handleCommand(dmEvt, { name: '/model', rest: 'capability' });
  assert.match(replies.at(-1), /支持档位：.*`xhigh`/);

  await bridge.handleCommand(dmEvt, { name: '/model', rest: 'effort xhigh' });
  assert.equal(freshSession.reasoningOverride, 'xhigh');
  assert.match(replies.at(-1), /思考强度：`xhigh`/);

  await bridge.handleCommand(dmEvt, { name: '/model', rest: 'save gemini-4-neon low' });
  const savedBot = JSON.parse(fs.readFileSync(botConfigPath, 'utf8'));
  assert.equal(savedBot.provider.model, 'gemini-4-neon');
  assert.equal(savedBot.provider.reasoning, 'low');

  await bridge.handleCommand(dmEvt, { name: '/help', rest: '' });
  assert.match(replies.at(-1), /\*\*Antigravity Bot 命令\*\*/);
  assert.match(replies.at(-1), /`\/model effort <强度\|clear>`/);
});
