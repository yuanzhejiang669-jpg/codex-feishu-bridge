import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AntigravityAcpClient, antigravityEnvironment, safeMessage } from '../src/antigravity/acp-client.mjs';
import { createAntigravityBridge } from '../src/antigravity/bridge-runner.mjs';
import { parseCommand } from '../src/commands/parser.mjs';
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

  // 3) Second /model list within 5 min hits cache (zero new subprocess); /model refresh forces new probe
  await bridge.handleCommand(event, { name: '/model', rest: 'list' });
  assert.equal(createClientCalls, 1);
  assert.match(replies.at(-1), /缓存/);
  await bridge.handleCommand(event, { name: '/model', rest: 'refresh' });
  assert.equal(createClientCalls, 2);

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
