import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createClaudeBridge, extractClaudeContextWindow } from '../src/claude/bridge-runner.mjs';
import { normalizeContextUsage } from '../src/sessions/normalize.mjs';
import { createSessionStore } from '../src/sessions/store.mjs';

test('Claude Bridge preserves text, maps tool activity, resumes native identity and binds approvals to the sender', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-claude-runner-'));
  const envKey = `CFB_RUNNER_${crypto.randomBytes(8).toString('hex')}`;
  process.env[envKey] = 'fixture-credential';
  t.after(() => { delete process.env[envKey]; fs.rmSync(root, { recursive: true, force: true }); });
  const catalog = path.join(root, 'providers.json');
  const botConfig = path.join(root, 'bot.json');
  fs.writeFileSync(botConfig, JSON.stringify({ claude: { permissionMode: 'manual' } }));
  fs.writeFileSync(catalog, JSON.stringify({ providers: [{ id: 'provider', envKey, model: 'claude-test', effort: 'high', models: ['claude-test'] }] }));
  const session = { id: 'local-session', engine: 'claude', title: 'test' };
  const chat = { currentSessionId: session.id, sessions: [session] };
  const event = { chat_id: 'chat-a', sender_id: 'user-a', message_id: 'message-a', content: '  用户原话\n不加要求。  ' };
  const state = { meta: {}, blocks: [] };
  const activeJobs = new Map(); const activeChildren = new Map(); const reduced = []; const replies = []; const phases = [];
  let saved = 0; let turnCount = 0; let bridge;
  const nativeId = crypto.randomUUID();
  bridge = createClaudeBridge({ config: { claudeProviderCatalog: catalog, claudeProviderId: 'provider', claudeBotConfig: botConfig,
    claudeCli: { command: 'claude' }, claudeHome: root, workspace: root, stateDir: root, larkProfile: 'claude-1' },
    getSession: () => session, getChatState: () => chat, resetSession: () => session,
    saveSessions: () => { saved += 1; }, userText: (content) => content, activeJobs, activeChildren,
    appendText: (current, text) => { current.text = (current.text || '') + text; },
    reduceEvent: (_current, value) => reduced.push(value), markPhase: (_current, phase) => phases.push(phase),
    ensureDone: (current, text) => { current.final = text; }, markInterrupted: () => {}, markError: () => {},
    sendMarkdown: async (chatId, text) => {
      replies.push({ chatId, text });
      const token = text.match(/\/approve ([a-f0-9]+)/)?.[1];
      if (token) {
        await bridge.handleCommand({ ...event, sender_id: 'other-user' }, { name: '/approve', rest: token });
        assert.match(replies.at(-1).text, /不属于当前用户/);
        await bridge.handleCommand(event, { name: '/approve', rest: token });
      }
    },
    createClient: (options) => ({ child: { pid: 123 }, async run(content) {
      assert.deepEqual(content[0], { type: 'text', text: event.content });
      assert.equal(options.resume, turnCount > 0);
      assert.equal(options.permissionMode, turnCount > 0 ? 'bypassPermissions' : 'manual');
      if (turnCount > 0) assert.equal(options.sessionId, nativeId);
      options.onStarted({ pid: 123 });
      try {
        await options.onSession(nativeId);
        options.onEvent({ type: 'initialized', sessionId: nativeId, model: 'claude-test', version: '2.1.327',
          permissionMode: options.permissionMode, tools: ['Read'], mcpServers: [], skills: [] });
        options.onEvent({ type: 'api_retry', statusCode: 502, attempt: 1, maxRetries: 2, delayMs: 60_000 });
        assert.equal(state.meta.upstreamRetry.statusCode, 502);
        assert.equal(phases.at(-1), 'reconnecting');
        options.onEvent({ type: 'model_progress' });
        assert.equal(state.meta.upstreamRetry, undefined);
        if (options.permissionMode === 'manual') assert.equal(await options.onPermission({ id: 'permission', toolName: 'Write', sessionId: nativeId, input: { file_path: '/fixture' } }), true);
        options.onEvent({ type: 'tool_start', id: 'tool', name: 'Write', input: { file_path: '/fixture' } });
        options.onEvent({ type: 'tool_end', id: 'tool', name: 'Write', output: 'success', error: false });
        options.onEvent({ type: 'context', usedTokens: 120 });
        options.onEvent({ type: 'text_delta', text: '原样回复\u200b' });
        const result = { result: '原样回复\u200b', usage: { input_tokens: 20, cache_read_input_tokens: 100, output_tokens: 15 } };
        options.onEvent({ type: 'result', result }); turnCount += 1; return result;
      } finally { options.onClosed({ pid: 123 }); }
    } }) });
  t.after(() => bridge.close());
  await bridge.run(event, session, state, async () => {});
  fs.writeFileSync(botConfig, JSON.stringify({ claude: { permissionMode: 'bypassPermissions' } }));
  await bridge.run(event, session, state, async () => {});
  await bridge.handleCommand(event, { name: '/status', rest: '' });
  assert.match(replies.at(-1).text, /完全授权（bypassPermissions）/);
  assert.equal(turnCount, 2); assert.equal(activeJobs.size, 0); assert.equal(activeChildren.size, 0);
  assert.equal(state.final, '原样回复\u200b'); assert.ok(saved >= 4);
  assert.deepEqual(reduced.slice(0, 2).map((value) => value.type), ['item.started', 'item.completed']);
  assert.equal(session.lastContextUsage.contextWindow, null);
  assert.equal(normalizeContextUsage(session.lastContextUsage).percent, null);
  assert.equal(session.lastTokenUsage.total.inputTokens, 120);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'claude-runtime.json'))).version, '2.1.327');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'claude-runtime.json'))).permissionMode, 'bypassPermissions');
});

test('unknown context capacity remains unknown through normalization', () => {
  assert.deepEqual(normalizeContextUsage({ usedTokens: 100, contextWindow: null, percent: null, updatedAt: 1 }),
    { usedTokens: 100, contextWindow: null, percent: null, updatedAt: 1 });
  assert.equal(normalizeContextUsage({ usedTokens: null, contextWindow: null, percent: null }), null);
});

test('Claude session identity survives concurrent status/permission reads so native state persists', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-claude-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionsPath = path.join(root, 'sessions.json');
  const store = createSessionStore({ sessionsPath, preserveSessionIdentity: true,
    createSessionData: () => ({ id: 'session', engine: 'claude', title: 'test', claudeSessionId: '', lastContextUsage: null }),
    normalizeSessionData: (value) => ({ ...value }), dedupeSessions: (values) => values, sessionListLimit: () => 100 });
  const running = store.getSession('chat');
  assert.equal(store.getSession('chat'), running);
  const otherCommand = store.getChatState('chat').sessions[0];
  assert.equal(otherCommand, running);
  otherCommand.title = 'renamed during run';
  running.claudeSessionId = 'native-id'; running.lastContextUsage = { usedTokens: 15, contextWindow: null };
  store.saveSessions();
  const persisted = JSON.parse(fs.readFileSync(sessionsPath)).chats.chat.sessions[0];
  assert.equal(persisted.claudeSessionId, 'native-id');
  assert.equal(persisted.title, 'renamed during run');
  assert.equal(persisted.lastContextUsage.usedTokens, 15);
});

test('ENG-CLD-002: real modelUsage.contextWindow populates contextWindow and percent while missing keeps null', async (t) => {
  assert.equal(extractClaudeContextWindow({ modelUsage: { 'claude-opus-5-5': { contextWindow: 200000 } } }, 'claude-opus-5-5'), 200000);
  assert.equal(extractClaudeContextWindow({ modelUsage: { other: { contextWindow: 1000000 } } }, 'claude-opus-5-5'), 1000000);
  assert.equal(extractClaudeContextWindow({}, 'claude-opus-5-5'), null);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-claude-ctxwin-'));
  const envKey = `CFB_CTX_${crypto.randomBytes(8).toString('hex')}`;
  process.env[envKey] = 'fixture-key';
  t.after(() => { delete process.env[envKey]; fs.rmSync(root, { recursive: true, force: true }); });
  const catalog = path.join(root, 'providers.json');
  const botConfig = path.join(root, 'bot.json');
  fs.writeFileSync(catalog, JSON.stringify({ providers: [{ id: 'p', envKey, model: 'claude-opus-5-5', effort: 'max', models: ['claude-opus-5-5'] }] }));
  fs.writeFileSync(botConfig, JSON.stringify({ claude: { permissionMode: 'bypassPermissions' } }));

  const session = { id: 's-ctx', engine: 'claude', title: 'ctx' };
  const chat = { currentSessionId: 's-ctx', sessions: [session] };
  const state = { meta: {}, blocks: [] };
  const bridge = createClaudeBridge({
    config: { claudeProviderCatalog: catalog, claudeProviderId: 'p', claudeBotConfig: botConfig,
      claudeCli: { command: 'claude' }, claudeHome: root, workspace: root, stateDir: root, larkProfile: 'c1' },
    getSession: () => session, getChatState: () => chat, resetSession: () => session,
    saveSessions: () => {}, userText: (c) => c, activeJobs: new Map(), activeChildren: new Map(),
    appendText: () => {}, reduceEvent: () => {}, markPhase: () => {}, ensureDone: () => {},
    markInterrupted: () => {}, markError: () => {}, sendMarkdown: async () => {},
    createClient: (options) => ({
      child: { pid: 456 },
      async run() {
        options.onStarted({ pid: 456 });
        try {
          options.onEvent({ type: 'initialized', sessionId: 'n1', model: 'claude-opus-5-5', version: '2.1.327', permissionMode: 'bypassPermissions', tools: [], mcpServers: [], skills: [] });
          options.onEvent({ type: 'context', usedTokens: 50000 });
          const result = {
            result: 'ok',
            usage: { input_tokens: 10000, cache_read_input_tokens: 40000, output_tokens: 500 },
            modelUsage: { 'claude-opus-5-5': { contextWindow: 200000 } },
          };
          options.onEvent({ type: 'result', result });
          return result;
        } finally {
          options.onClosed({ pid: 456 });
        }
      },
    }),
  });
  t.after(() => bridge.close());

  await bridge.run({ chat_id: 'chat-a', sender_id: 'u1', message_id: 'm1', content: 'hi' }, session, state, async () => {});
  assert.equal(session.lastContextUsage.contextWindow, 200000);
  assert.equal(session.lastContextUsage.percent, 25);
  assert.equal(session.lastTokenUsage.modelContextWindow, 200000);
});
