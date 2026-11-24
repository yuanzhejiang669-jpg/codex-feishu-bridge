import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

import { createFormulaImageService } from '../src/feishu/cards/formula-renderer.mjs';
import { createAntigravityBridge, detectAntigravityResultError } from '../src/antigravity/bridge-runner.mjs';
import { createClaudeCommands } from '../src/claude/commands.mjs';
import { classifyCodexFailure, httpStatusFromText } from '../src/logging/errors.mjs';
import { runActivityView } from '../src/runtime/run-activity.mjs';

const require = createRequire(import.meta.url);
const updateRecovery = require('../apps/desktop/src/main/services/update-recovery.cjs');

test('formula service exposes synchronous hasPlannedFormulas and bridge uses non-blocking async upgrade + running heartbeat', () => {
  const service = createFormulaImageService({ enabled: true, browserBin: 'fake-edge', uploadImage: async () => 'img_key' });
  const disabled = createFormulaImageService({ enabled: false, browserBin: 'fake-edge', uploadImage: async () => 'img_key' });

  assert.equal(service.hasPlannedFormulas([{ kind: 'text', content: 'Plain answer without formulas.' }]), false);
  assert.equal(service.hasPlannedFormulas([{ kind: 'text', content: 'Simple inline math $x^2 + y^2 = z^2$ stays text.' }]), false);
  assert.equal(service.hasPlannedFormulas([{ kind: 'text', content: 'Display math:\n\n$$\\sum_{i=1}^{n} \\frac{1}{i^2} = \\frac{\\pi^2}{6}$$' }]), true);
  assert.equal(disabled.hasPlannedFormulas([{ kind: 'text', content: '$$\\frac{a}{b}$$' }]), false);

  const bridgeSrc = fs.readFileSync(new URL('../codex-feishu-bridge.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(bridgeSrc, /await state\.formulaRenderPromise;/);
  assert.match(bridgeSrc, /formulaImageService\.hasPlannedFormulas/);
  assert.match(bridgeSrc, /formula card upgraded asynchronously/);
  assert.match(bridgeSrc, /cardHeartbeatMs:\s*parseDurationMs/);
  assert.match(bridgeSrc, /clearInterval\(heartbeatTimer\)/);

  const view = runActivityView({
    startedAt: Date.now() - 5000,
    meta: { engine: 'antigravity' },
    activity: { phase: 'initializing', phaseStartedAt: Date.now() - 5000, lastProgressAt: Date.now() - 5000, connection: 'starting' },
    blocks: [],
  });
  assert.equal(view.phaseLabel, '正在初始化 Antigravity');
});

test('detectAntigravityResultError and classifyCodexFailure recognize 401 UNAUTHENTICATED and ACP executor errors without false positives', () => {
  const err401 = detectAntigravityResultError('⚠ UNAUTHENTICATED (code 401): Request had invalid authentication credentials.');
  assert.equal(Boolean(err401), true);
  assert.equal(err401.isAuth401, true);

  const errExec = detectAntigravityResultError('⚠ agent executor error: upstream failure');
  assert.equal(Boolean(errExec), true);
  assert.equal(errExec.isAuth401, false);

  const err403 = detectAntigravityResultError('⚠ PERMISSION_DENIED (code 403): access denied');
  assert.equal(Boolean(err403), true);
  assert.equal(err403.isAuth401, false);

  const trailing401 = detectAntigravityResultError('已检查本地文件。\n⚠ UNAUTHENTICATED (code 401): token expired');
  assert.equal(Boolean(trailing401), true);
  assert.equal(trailing401.isAuth401, true);

  assert.equal(detectAntigravityResultError('⚠ 注意：请先备份配置文件后再修改。'), null);
  assert.equal(detectAntigravityResultError('正常回答：这里提到 UNAUTHENTICATED 只是解释术语。'), null);

  assert.equal(httpStatusFromText('⚠ UNAUTHENTICATED (code 401): invalid credentials'), 401);

  const failure = classifyCodexFailure(Object.assign(
    new Error('⚠ UNAUTHENTICATED (code 401): Request had invalid authentication credentials.'),
    { engine: 'antigravity', code: 'ANTIGRAVITY_AUTH_401', retried401: true },
  ));
  assert.equal(failure.kind, 'auth');
  assert.match(failure.label, /Antigravity 鉴权失败（HTTP 401）/);
  assert.match(failure.message, /自动重试一次/);
});

function createStubAntigravityBridge(t, clientHandlers) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-v01017-agy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  const dataRoot = path.join(root, 'data');
  const stateDir = path.join(root, 'state');
  const logDir = path.join(root, 'logs');
  const geminiDir = path.join(root, 'gemini');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(geminiDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'antigravity-providers.json'), JSON.stringify({
    schemaVersion: 1,
    providers: [{ id: 'official', name: 'Official', mode: 'official', model: 'gemini-4-neon', effort: 'high' }],
  }));

  const session = {
    id: 's1',
    title: 'Test Session',
    engine: 'antigravity',
    antigravitySessionId: '',
    antigravitySourceId: '',
    messages: [],
  };
  const chat = { currentSessionId: 's1', sessions: [session] };
  const activeChildren = new Map();
  const activeJobs = new Map();
  let clientIndex = 0;
  const createdClients = [];
  const doneCalls = [];
  const errorCalls = [];

  const bridge = createAntigravityBridge({
    config: {
      antigravityCli: { command: 'agy.exe', argsPrefix: [] },
      antigravityHome: geminiDir,
      antigravityDesktopGeminiDir: '',
      antigravityDataRoot: dataRoot,
      antigravityIdleTtlMs: 60_000,
      workspace,
      stateDir,
      logDir,
      disableMcp: true,
    },
    getSession: () => session,
    getChatState: () => chat,
    getChats: () => ({ 'chat-1': chat }),
    resetSession: () => session,
    saveSessions: () => {},
    userText: (c) => String(c || ''),
    sendMarkdown: async () => {},
    activeChildren,
    activeJobs,
    appendText: (state, text) => {
      const last = state.blocks.at(-1);
      if (last?.kind === 'text') last.content += text;
      else state.blocks.push({ kind: 'text', content: text });
    },
    reduceEvent: (state, ev) => {
      if (ev.type === 'item.started') state.blocks.push({ kind: 'tool', tool: { ...ev.item, status: 'running' } });
    },
    markPhase: (state, phase, opts = {}) => {
      state.phases.push({ phase, ...opts });
    },
    ensureDone: (state, text) => {
      state.terminal = 'done';
      doneCalls.push(text);
    },
    markInterrupted: (state) => { state.terminal = 'interrupted'; },
    markError: (state, err) => {
      state.terminal = 'error';
      errorCalls.push(err);
    },
    queueSummary: () => '无',
    sharedSessions: null,
    createClient: (opts) => {
      const idx = clientIndex++;
      const handler = clientHandlers[idx] || clientHandlers.at(-1);
      const client = {
        idx,
        child: { pid: 10000 + idx },
        runtime: { agentInfo: { version: '1.5.14' } },
        appDataDir: 'antigravity-cli',
        closed: false,
        stopped: false,
        onEvent: opts.onEvent,
        onPermission: opts.onPermission,
        prompts: [],
        openCalls: [],
        closeCount: 0,
        async openSession(args) {
          this.openCalls.push(args);
          this.sessionId = args.sessionId || `native-conv-${idx}`;
          return {
            sessionId: this.sessionId,
            models: { availableModels: [{ modelId: 'gemini-4-neon', name: 'Gemini 4 Neon' }] },
            configOptions: [],
            modes: [],
          };
        },
        async prompt(content) {
          this.prompts.push(content);
          return handler(this, content);
        },
        async close() {
          this.closed = true;
          this.closeCount += 1;
        },
        interrupt() { this.stopped = true; },
      };
      createdClients.push(client);
      return client;
    },
  });
  t.after(() => bridge.close());
  return { bridge, session, createdClients, doneCalls, errorCalls };
}

test('Antigravity 401 auto-retry: closes stale warm client, strips error chunk, and succeeds transparently on fresh client', async (t) => {
  let firstClientPrompts = 0;
  const { bridge, session, createdClients, doneCalls, errorCalls } = createStubAntigravityBridge(t, [
    async (client) => {
      firstClientPrompts += 1;
      if (firstClientPrompts === 1) {
        client.onEvent({ type: 'agent_message_chunk', update: { content: { type: 'text', text: '第一轮正常完成' } } });
        return { text: '第一轮正常完成', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
      }
      const errText = '⚠ UNAUTHENTICATED (code 401): Request had invalid authentication credentials.';
      client.onEvent({ type: 'agent_message_chunk', update: { content: { type: 'text', text: errText } } });
      return { text: errText, usage: {} };
    },
    async (client) => {
      client.onEvent({ type: 'agent_message_chunk', update: { content: { type: 'text', text: '重连后正常回复' } } });
      return { text: '重连后正常回复', usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } };
    },
  ]);

  const event1 = { chat_id: 'chat-1', sender_id: 'ou_1', chat_type: 'p2p', message_id: 'm1', content: 'hi' };
  const state1 = { blocks: [], meta: {}, phases: [], terminal: 'running' };
  const r1 = await bridge.run(event1, session, state1, async () => {});
  assert.equal(r1.text, '第一轮正常完成');
  assert.equal(createdClients.length, 1);
  assert.equal(createdClients[0].closed, false, 'Turn 1 client should be parked in warm pool');

  // Turn 2 reuses warm client 0 -> hits 401 -> auto-closes client 0 -> spawns client 1 -> succeeds cleanly!
  const event2 = { chat_id: 'chat-1', sender_id: 'ou_1', chat_type: 'p2p', message_id: 'm2', content: 'follow up question' };
  const state2 = { blocks: [], meta: {}, phases: [], terminal: 'running' };
  const r2 = await bridge.run(event2, session, state2, async () => {});
  assert.equal(r2.text, '重连后正常回复');
  assert.equal(createdClients.length, 2);
  assert.equal(createdClients[0].closed, true, 'Stale 401 warm client must be closed');
  assert.equal(createdClients[1].closed, false, 'Fresh healthy client should be parked in warm pool');
  assert.equal(createdClients[1].openCalls[0].sessionId, 'native-conv-0', 'Fresh client must resume same conversation');
  assert.match(JSON.stringify(createdClients[1].prompts[0]), /follow up question/);
  assert.equal(state2.blocks.some((b) => String(b.content || '').includes('UNAUTHENTICATED')), false, '401 chunk must be stripped from card blocks');
  assert.equal(state2.phases.some((p) => p.phase === 'reconnecting'), true);
  assert.equal(state2.meta.upstreamRetry, undefined, 'upstreamRetry metadata cleared on success');
  assert.equal(errorCalls.length, 0);
  assert.equal(doneCalls.length, 2);
});

test('Antigravity 401 auto-retry after tools sends continuation prompt instead of re-running original prompt', async (t) => {
  const { bridge, session, createdClients } = createStubAntigravityBridge(t, [
    async (client) => {
      client.onEvent({ type: 'tool_call', update: { toolCallId: 't1', name: 'run_command', args: { cmd: 'ls' } } });
      const errText = '⚠ UNAUTHENTICATED (code 401): Request had invalid authentication credentials.';
      client.onEvent({ type: 'agent_message_chunk', update: { content: { type: 'text', text: errText } } });
      return { text: errText, usage: {} };
    },
    async (client) => {
      client.onEvent({ type: 'agent_message_chunk', update: { content: { type: 'text', text: '基于已完成工具继续回答' } } });
      return { text: '基于已完成工具继续回答', usage: { inputTokens: 15, outputTokens: 10, totalTokens: 25 } };
    },
  ]);

  const event = { chat_id: 'chat-1', sender_id: 'ou_1', chat_type: 'p2p', message_id: 'm1', content: 'run deployment script' };
  const state = { blocks: [], meta: {}, phases: [], terminal: 'running' };
  const res = await bridge.run(event, session, state, async () => {});
  assert.equal(res.text, '基于已完成工具继续回答');
  assert.equal(createdClients.length, 2);
  assert.match(JSON.stringify(createdClients[1].prompts[0]), /不要重复执行已完成的操作/);
  assert.doesNotMatch(JSON.stringify(createdClients[1].prompts[0]), /run deployment script/);
});

test('Antigravity persistent 401 or non-401 ACP error fails visibly as error and never parks broken client', async (t) => {
  const err401 = '⚠ UNAUTHENTICATED (code 401): Request had invalid authentication credentials.';
  const { bridge, session, createdClients, doneCalls, errorCalls } = createStubAntigravityBridge(t, [
    async (client) => {
      client.onEvent({ type: 'agent_message_chunk', update: { content: { type: 'text', text: err401 } } });
      return { text: err401, usage: {} };
    },
    async (client) => {
      client.onEvent({ type: 'agent_message_chunk', update: { content: { type: 'text', text: err401 } } });
      return { text: err401, usage: {} };
    },
  ]);

  const event = { chat_id: 'chat-1', sender_id: 'ou_1', chat_type: 'p2p', message_id: 'm1', content: 'hello' };
  const state = { blocks: [], meta: {}, phases: [], terminal: 'running' };
  await assert.rejects(
    bridge.run(event, session, state, async () => {}),
    (err) => err.code === 'ANTIGRAVITY_AUTH_401' && err.engine === 'antigravity' && err.retried401 === true,
  );
  assert.equal(createdClients.length, 2, 'Retries 401 exactly once');
  assert.equal(createdClients[0].closed, true);
  assert.equal(createdClients[1].closed, true, 'Failed retry client must be closed and never parked');
  assert.equal(doneCalls.length, 0, 'Must never mark 401 as done');
  assert.equal(errorCalls.length, 1);
  assert.equal(state.terminal, 'error');

  // Non-401 error fails immediately without retry
  const err403 = '⚠ PERMISSION_DENIED (code 403): forbidden';
  const second = createStubAntigravityBridge(t, [
    async () => ({ text: err403, usage: {} }),
  ]);
  const state403 = { blocks: [], meta: {}, phases: [], terminal: 'running' };
  await assert.rejects(
    second.bridge.run(event, second.session, state403, async () => {}),
    (err) => err.code === 'ANTIGRAVITY_EXECUTOR_ERROR' && err.retried401 === false,
  );
  assert.equal(second.createdClients.length, 1, 'Non-401 error must not retry');
  assert.equal(second.createdClients[0].closed, true);
  assert.equal(second.doneCalls.length, 0);
});

test('Claude /model refresh aliases live /model list and update-recovery parses UTF-8 BOM markers', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-v01017-misc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  const catalogPath = path.join(root, 'claude-providers.json');
  fs.writeFileSync(catalogPath, JSON.stringify({
    providers: [{ id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.example.com', envKey: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-4-6', models: ['claude-sonnet-4-6'] }],
  }));

  let refreshCalls = 0;
  const replies = [];
  const session = { id: 'c1', title: 'Claude Chat' };
  const commands = createClaudeCommands({
    config: { claudeProviderCatalog: catalogPath, claudeHome: root, larkProfile: 'claude-1' },
    settings: () => ({ provider: 'anthropic', model: 'claude-sonnet-4-6', reasoning: 'high', permissionMode: 'bypassPermissions' }),
    botConfiguration: () => ({}),
    providers: () => JSON.parse(fs.readFileSync(catalogPath, 'utf8')).providers,
    saveSessions: () => {},
    activeJobs: new Map(),
    getChatState: () => ({ sessions: [session] }),
    getSession: () => session,
    testModel: async () => ({ durationMs: 10, text: 'ok' }),
    refreshModels: async () => {
      refreshCalls += 1;
      return ['claude-sonnet-4-6', 'claude-opus-4-6'];
    },
  });

  const handled = await commands.handle(
    { chat_id: 'chat-c1', message_id: 'mc1' },
    { name: '/model', rest: 'refresh' },
    async (text) => { replies.push(text); },
  );
  assert.equal(handled, true);
  assert.equal(refreshCalls, 1);
  assert.match(replies[0], /claude-opus-4-6/);
  const updatedCatalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  assert.deepEqual(updatedCatalog.providers[0].models, ['claude-sonnet-4-6', 'claude-opus-4-6']);

  // UTF-8 BOM marker parsing
  const bomPayload = `\uFEFF${JSON.stringify({ schemaVersion: 1, targetVersion: '0.10.17', botNames: ['codex-1', 'antigravity-2'] })}`;
  fs.writeFileSync(path.join(root, 'pending-update-recovery.json'), bomPayload, 'utf8');
  const parsed = updateRecovery.readRecoveryMarker(root);
  assert.deepEqual(parsed?.botNames, ['codex-1', 'antigravity-2']);
  assert.equal(parsed?.targetVersion, '0.10.17');
});
