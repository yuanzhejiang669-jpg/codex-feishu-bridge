import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeCliClient } from '../src/claude/cli-client.mjs';
import { createClaudeBridge } from '../src/claude/bridge-runner.mjs';
import { createClaudeCommands } from '../src/claude/commands.mjs';
import { createAntigravityBridge } from '../src/antigravity/bridge-runner.mjs';
import { createRunCardRenderer } from '../src/feishu/cards/run-card.mjs';
import { createCommandRouter } from '../src/commands/router.mjs';

function makeCardHelpers(engine, model) {
  return createRunCardRenderer({
    CONFIG: { engine, showFinalSteps: false },
    log: () => {},
    activeRuns: new Map(),
    saveActiveRuns: () => {},
    userTextFromContent: (c) => String(c || ''),
    effectiveSessionSettings: () => ({ model }),
    updateSessionTokenUsage: () => {},
    updateSessionThreadStatus: () => {},
    updateSessionGoal: () => {},
    updateSessionFailure: () => {},
    clearSessionFailure: () => {},
    markSessionCompacted: () => {},
    resultTextFromState: () => '',
    goalStatusLabel: () => '',
    formatDuration: (ms) => `${Math.round((ms || 0) / 1000)}s`,
    formatNumber: (n) => Number(n || 0).toLocaleString('en-US'),
    formatTime: (ts) => new Date(ts).toISOString(),
  });
}

test('Claude client ignores placeholder 0 in message_start, reads real assistant.message.usage, and renders contextWindow % on card and /context', async (t) => {
  const events = [];
  const client = new ClaudeCliClient({
    command: 'claude.exe',
    cwd: process.cwd(),
    home: os.tmpdir(),
    provider: { id: 'dukouai', name: 'DukouAI', baseUrl: 'https://api.example.com', apiKey: 'sk-test-secret' },
    model: 'claude-fable-5-2',
    effort: 'high',
    onEvent: (ev) => events.push(ev),
  });

  // 1) Gateway placeholder 0 on message_start must NOT emit context=0
  await client.handleEvent({
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: { id: 'msg_1', usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    },
  });
  assert.equal(events.filter((e) => e.type === 'context').length, 0);

  // 2) Real per-request token usage on assistant message emits context=201983
  await client.handleEvent({
    type: 'assistant',
    message: {
      id: 'msg_1',
      model: 'claude-fable-5-2',
      usage: { input_tokens: 4, cache_creation_input_tokens: 1201, cache_read_input_tokens: 200778, output_tokens: 287 },
      content: [{ type: 'text', text: 'ok' }],
    },
  });
  const ctxEvs = events.filter((e) => e.type === 'context');
  assert.equal(ctxEvs.length, 1);
  assert.equal(ctxEvs[0].usedTokens, 201983);

  // 3) Full bridge-runner + run-card rendering with contextWindow=1,000,000 vs null
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-v01018-claude-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const catalogPath = path.join(root, 'claude-providers.json');
  const botPath = path.join(root, 'bot.json');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(catalogPath, JSON.stringify({
    providers: [{ id: 'dukouai', name: 'DukouAI', baseUrl: 'https://api.example.com', envKey: 'TEST_V01018_CLAUDE_KEY', model: 'claude-fable-5-2', models: ['claude-fable-5-2'] }],
  }));
  fs.writeFileSync(botPath, JSON.stringify({ provider: { id: 'dukouai', model: 'claude-fable-5-2', reasoning: 'high' } }));
  process.env.TEST_V01018_CLAUDE_KEY = 'sk-test-v01018';
  t.after(() => { delete process.env.TEST_V01018_CLAUDE_KEY; });

  const session = { id: 'c1', title: 'Claude Test', engine: 'claude', claudeSessionId: '', messages: [] };
  const chat = { currentSessionId: 'c1', sessions: [session] };
  const helpers = makeCardHelpers('claude', 'claude-fable-5-2');
  const state = helpers.createRunState(session, { chat_id: 'oc_1', message_id: 'm1' }, 'draw');

  const bridge = createClaudeBridge({
    config: {
      claudeCli: { command: 'claude.exe', argsPrefix: [] },
      claudeHome: root,
      claudeProviderCatalog: catalogPath,
      claudeBotConfig: botPath,
      claudeProviderId: 'dukouai',
      claudeIdleTtlMs: 0,
      workspace: root,
      stateDir,
      disableMcp: true,
      larkProfile: 'claude-1',
    },
    getSession: () => session,
    getChatState: () => chat,
    getChats: () => ({ oc_1: chat }),
    resetSession: () => session,
    saveSessions: () => {},
    userText: (c) => String(c || ''),
    sendText: async () => {},
    sendMarkdown: async () => {},
    activeChildren: new Map(),
    activeJobs: new Map(),
    appendText: helpers.appendRunText,
    reduceEvent: helpers.reduceCodexJsonEvent,
    markPhase: () => {},
    ensureDone: helpers.ensureRunDone,
    markInterrupted: helpers.markRunInterrupted,
    markError: helpers.markRunError,
    terminateProcessTree: () => {},
    log: () => {},
    queueSummary: () => '无',
    createClient: (opts) => ({
      async run() {
        opts.onEvent({ type: 'initialized', sessionId: '11111111-1111-4111-8111-111111111111', model: 'claude-fable-5-2' });
        // Simulate stray 0 context followed by real assistant usage
        opts.onEvent({ type: 'context', usedTokens: 0 });
        opts.onEvent({ type: 'context', usedTokens: 201983 });
        opts.onEvent({ type: 'text_delta', text: '完成绘制' });
        opts.onEvent({
          type: 'result',
          result: {
            usage: { input_tokens: 100, cache_creation_input_tokens: 100000, cache_read_input_tokens: 623706, output_tokens: 7732 },
            modelUsage: { 'claude-fable-5-2': { contextWindow: 1000000 } },
          },
        });
        return { result: '完成绘制' };
      },
    }),
  });
  t.after(() => bridge.close());

  await bridge.run({ chat_id: 'oc_1', message_id: 'm1', content: 'draw' }, session, state, async () => {});
  assert.equal(session.lastContextUsage.usedTokens, 201983);
  assert.equal(session.lastContextUsage.contextWindow, 1000000);
  assert.equal(session.lastContextUsage.percent, 20.2);

  const cardJsonWithWindow = JSON.stringify(helpers.renderRunCard(state));
  assert.match(cardJsonWithWindow, /当前窗口 20\.2% \/ 201,983\/1,000,000 tokens/);
  assert.doesNotMatch(cardJsonWithWindow, /容量未提供/);

  // Fallback when contextWindow is genuinely absent
  state.meta.contextUsage = { usedTokens: 201983, contextWindow: null, percent: null };
  const cardJsonNoWindow = JSON.stringify(helpers.renderRunCard(state));
  assert.match(cardJsonNoWindow, /当前请求上下文 201,983 tokens · 容量未提供/);

  // /context and /model capability live check
  const replies = [];
  const commands = createClaudeCommands({
    config: { claudeProviderCatalog: catalogPath, claudeHome: root, stateDir, larkProfile: 'claude-1', workspace: root },
    settings: () => ({ provider: 'dukouai', model: 'claude-fable-5-2', reasoning: 'high', permissionMode: 'bypassPermissions' }),
    botConfiguration: () => ({}),
    providers: () => JSON.parse(fs.readFileSync(catalogPath, 'utf8')).providers,
    saveSessions: () => {},
    activeJobs: new Map(),
    getChatState: () => chat,
    getSession: () => session,
    testModel: async () => ({ durationMs: 10, text: 'ok' }),
    refreshModels: async () => ['claude-fable-5-2', 'claude-opus-5-5'],
  });
  await commands.handle({ chat_id: 'oc_1', message_id: 'm2' }, { name: '/context', rest: '' }, async (txt) => replies.push(txt));
  assert.match(replies.at(-1), /当前窗口：20\.2% \/ 201,983 \/ 1,000,000 tokens/);

  await commands.handle({ chat_id: 'oc_1', message_id: 'm3' }, { name: '/model', rest: 'capability' }, async (txt) => replies.push(txt));
  assert.match(replies.at(-1), /渠道实时核验：`claude-fable-5-2` 在 `dukouai` 实时目录中可见（共 2 个模型）/);
});

test('Antigravity /model capability probes live and /compact records lastCompactedAt on card footer', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-v01018-agy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const dataRoot = path.join(root, 'data');
  const stateDir = path.join(root, 'state');
  const logDir = path.join(root, 'logs');
  const geminiDir = path.join(root, 'gemini');
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(geminiDir, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'antigravity-providers.json'), JSON.stringify({
    schemaVersion: 1,
    providers: [{ id: 'official', name: 'Official', mode: 'official', model: 'claude-opus-5-5', effort: 'high' }],
  }));

  const session = { id: 'a1', title: 'AGY Chat', engine: 'antigravity', antigravitySessionId: '', lastCompactedAt: null, messages: [] };
  const chat = { currentSessionId: 'a1', sessions: [session] };
  const replies = [];
  let probeCount = 0;

  const helpers = makeCardHelpers('antigravity', 'claude-opus-5-5');

  const bridge = createAntigravityBridge({
    config: {
      antigravityCli: { command: 'agy.exe', argsPrefix: [] },
      antigravityHome: geminiDir,
      antigravityDesktopGeminiDir: '',
      antigravityDataRoot: dataRoot,
      antigravityIdleTtlMs: 0,
      workspace: root,
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
    sendMarkdown: async (_chatId, text) => { replies.push(text); },
    activeChildren: new Map(),
    activeJobs: new Map(),
    appendText: helpers.appendRunText,
    reduceEvent: helpers.reduceCodexJsonEvent,
    markPhase: () => {},
    ensureDone: helpers.ensureRunDone,
    markInterrupted: helpers.markRunInterrupted,
    markError: helpers.markRunError,
    queueSummary: () => '无',
    sharedSessions: null,
    createClient: () => ({
      child: { pid: 22222 },
      runtime: { agentInfo: { version: '1.5.14' } },
      appDataDir: 'antigravity-cli',
      closed: false,
      stopped: false,
      async openSession({ sessionId }) {
        probeCount += 1;
        return {
          sessionId: sessionId || `conv-${probeCount}`,
          models: {
            availableModels: [
              { modelId: 'claude-opus-5-5-low', name: 'Opus 5.5' },
              { modelId: 'claude-opus-5-5-medium', name: 'Opus 5.5' },
              { modelId: 'claude-opus-5-5-high', name: 'Opus 5.5' },
            ],
          },
          configOptions: [
            { id: 'model', currentValue: 'claude-opus-5-5', options: [{ value: 'claude-opus-5-5', name: 'Claude Opus 5.5' }] },
            { id: 'thought_level', currentValue: 'high', options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] },
          ],
          modes: [],
        };
      },
      async prompt() {
        return { text: '', usage: {} };
      },
      async close() { this.closed = true; },
      interrupt() { this.stopped = true; },
    }),
  });
  t.after(() => bridge.close());

  const evt = { chat_id: 'chat-1', sender_id: 'ou_1', chat_type: 'p2p', message_id: 'm1' };
  await bridge.handleCommand(evt, { name: '/model', rest: 'capability' });
  assert.equal(probeCount, 1);
  assert.match(replies.at(-1), /来源：实时只读探针/);
  assert.match(replies.at(-1), /支持档位：`low`、`medium`、`high`/);

  // Native /compact run updates session.lastCompactedAt + card footer
  const state = helpers.createRunState(session, { ...evt, content: '/compact' }, '/compact');
  await bridge.run({ ...evt, content: '/compact' }, session, state, async () => {});
  assert.equal(typeof session.lastCompactedAt, 'number');
  assert.equal(state.meta.compactedAt, session.lastCompactedAt);
  const rendered = JSON.stringify(helpers.renderRunCard(state));
  assert.match(rendered, /上次压缩/);
  assert.doesNotMatch(rendered, /未压缩/);
});

test('Codex /model capability queries live provider model list and surfaces real-time supportedReasoningEfforts for brand-new models', async () => {
  const sent = [];
  const session = { id: 'x1', title: 'Codex Chat', modelOverride: 'gpt-5.9-unlisted', reasoningOverride: 'high' };
  let listCalls = 0;

  const router = createCommandRouter({
    CONFIG: { engine: 'codex', workspace: process.cwd(), codexHome: os.tmpdir(), stateDir: os.tmpdir(), listLimit: 20 },
    ENGINE_LABEL: 'Codex',
    log: () => {},
    recordChatScope: () => ({}),
    commandArgs: (rest) => String(rest || '').trim().split(/\s+/).filter(Boolean),
    cleanOverride: (v) => String(v || '').trim(),
    MODEL_REASONING_REGISTRY: {
      registryVersion: '2026-11-23',
      defaultRequestedEffort: 'high',
      defaultCapability: { id: 'default', name: '通用模型', known: false, acceptedEfforts: ['low', 'medium', 'high', 'xhigh'], reviewIntervalDays: 30, verifiedAt: '2026-11-23' },
      models: [],
    },
    acceptedEfforts: () => ['low', 'medium', 'high', 'xhigh'],
    capabilityOutcomeLines: () => ['- `high` → `high`'],
    reasoningReviewStatus: () => ({ stale: false, reviewDueAt: '2026-12-23' }),
    syncChatSessionsWithCodex: async () => {},
    getSession: () => session,
    effectiveSessionSettings: () => ({
      provider: 'openai',
      model: 'gpt-5.9-unlisted',
      requestedReasoning: 'high',
      reasoning: 'high',
      reasoningMapping: {
        supported: true,
        effectiveEffort: 'high',
        upstreamValue: 'high',
        capability: { id: 'default', name: '通用模型', known: false, verifiedAt: '2026-11-23' },
      },
    }),
    listCurrentProviderModels: async () => {
      listCalls += 1;
      return {
        source: 'openai-account',
        models: [{
          id: 'gpt-5.9-unlisted',
          displayName: 'GPT-5.9 Unlisted',
          supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }, { reasoningEffort: 'xhigh' }],
          serviceTiers: [{ id: 'fast', name: 'Fast' }],
        }],
      };
    },
    sendMarkdown: async (_chatId, text) => { sent.push(text); },
    sendText: async (_chatId, text) => { sent.push(text); },
    activeCodexJobs: new Map(),
  });

  await router.handleCommand({ chat_id: 'oc_codex', message_id: 'mc1', content: '/model capability' }, { name: '/model', rest: 'capability', text: '/model capability' });
  assert.equal(listCalls, 1);
  assert.match(sent.at(-1), /实时上游支持档位：`low`、`high`、`xhigh`（来源：官方账号实时查询）/);
  assert.match(sent.at(-1), /实时速度档：Fast\(fast\)/);
});
