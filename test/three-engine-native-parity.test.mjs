import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { AntigravityAcpClient, DEFAULT_MAX_LINE_BYTES as AGY_MAX_LINE } from '../src/antigravity/acp-client.mjs';
import { createAntigravityBridge, extractAntigravityModelCatalog } from '../src/antigravity/bridge-runner.mjs';
import { listAntigravityNativeConversations, isAntigravityConversationBusy } from '../src/antigravity/native-sessions.mjs';
import { ClaudeCliClient, claudeArguments, DEFAULT_MAX_LINE_BYTES as CLAUDE_MAX_LINE } from '../src/claude/cli-client.mjs';
import { createClaudeBridge } from '../src/claude/bridge-runner.mjs';
import { listClaudeNativeSessions } from '../src/claude/native-sessions.mjs';
import { createSharedClaudeSessionStore } from '../src/claude/shared-sessions.mjs';
import { createAppServerProtocol } from '../src/codex/app-server-protocol.mjs';
import { parseCommand } from '../src/commands/parser.mjs';
import { classifyCodexFailure } from '../src/logging/errors.mjs';

function makeAcpMock(handler, { capabilities = { sessionCapabilities: { resume: {}, list: {}, load: {} } } } = {}) {
  const child = new EventEmitter();
  child.pid = 77771;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.emit('close', 0, null); return true; };
  const requests = [];
  const send = (msg) => child.stdout.write(`${JSON.stringify(msg)}\n`);
  let buf = '';
  child.stdin.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      const req = JSON.parse(line);
      requests.push(req);
      if (handler && handler(req, send, child) === true) continue;
      if (req.method === 'initialize') {
        send({ id: req.id, result: { agentInfo: { version: '1.5.14' }, agentCapabilities: capabilities } });
      } else if (['session/new', 'session/resume', 'session/load'].includes(req.method)) {
        send({
          id: req.id,
          result: {
            sessionId: req.params?.sessionId || 'agy-native-1',
            models: {
              currentModelId: 'gemini-4-neon-high',
              availableModels: [
                { modelId: 'gemini-4-neon-low', name: 'Gemini 4 Neon (Low)' },
                { modelId: 'gemini-4-neon-medium', name: 'Gemini 4 Neon (Medium)' },
                { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
                { modelId: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (XHigh)' },
                { modelId: 'claude-opus-5-5-low', name: 'Claude Opus 5.5 (Low)' },
                { modelId: 'claude-opus-5-5-medium', name: 'Claude Opus 5.5 (Medium)' },
                { modelId: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
              ],
            },
            configOptions: [
              {
                id: 'model',
                currentValue: 'gemini-4-neon',
                options: [
                  { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
                  { value: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
                ],
              },
              {
                id: 'thought_level',
                currentValue: 'high',
                options: [
                  { value: 'low', name: 'Low' },
                  { value: 'medium', name: 'Medium' },
                  { value: 'high', name: 'High' },
                  { value: 'xhigh', name: 'Extra' },
                ],
              },
            ],
          },
        });
      } else if (req.method === 'session/set_config_option') {
        send({ id: req.id, result: { configOptions: [{ id: req.params.configId, currentValue: req.params.value }] } });
      } else {
        send({ id: req.id, result: {} });
      }
    }
  });
  return { child, requests, send };
}

test('Antigravity ACP uses session/resume, set_config_option(model), auto-approves always-proceed, and handles >16MiB lines in O(N)', async () => {
  assert.ok(AGY_MAX_LINE >= 128 * 1024 * 1024);
  const mock = makeAcpMock();
  const client = new AntigravityAcpClient({
    command: 'agy',
    cwd: process.cwd(),
    provider: { id: 'official', mode: 'official' },
    permissionMode: 'always-proceed',
    spawnProcess: () => mock.child,
    onPermission: () => { throw new Error('always-proceed must auto-approve without invoking interactive prompt'); },
  });

  await client.openSession({ sessionId: 'desktop-conv-1', model: 'claude-opus-5-5', effort: 'high', mode: 'always-proceed' });
  assert.deepEqual(
    mock.requests.map((r) => r.method),
    ['initialize', 'session/resume', 'session/set_config_option', 'session/set_config_option'],
  );
  assert.deepEqual(mock.requests[2].params, { sessionId: 'desktop-conv-1', configId: 'model', value: 'claude-opus-5-5' });
  assert.deepEqual(mock.requests[3].params, { sessionId: 'desktop-conv-1', configId: 'thought_level', value: 'high' });

  // Verify always-proceed auto-approves even if server emits session/request_permission
  mock.send({
    id: 'perm-auto-1',
    method: 'session/request_permission',
    params: { options: [{ optionId: 'opt-always', kind: 'allow_always' }, { optionId: 'opt-once', kind: 'allow_once' }] },
  });
  await new Promise((r) => setImmediate(r));
  const permReply = mock.requests.find((r) => r.id === 'perm-auto-1');
  assert.deepEqual(permReply?.result?.outcome, { outcome: 'selected', optionId: 'opt-always' });

  // Verify >16MiB multi-chunk JSON event frames cleanly in linear time without error
  const big = 'y'.repeat(18 * 1024 * 1024);
  const payload = Buffer.from(`${JSON.stringify({ method: 'session/update', params: { sessionId: 'desktop-conv-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: big } } } })}\n`, 'utf8');
  const t0 = Date.now();
  for (let i = 0; i < payload.length; i += 65536) {
    mock.child.stdout.emit('data', payload.subarray(i, Math.min(i + 65536, payload.length)));
  }
  assert.equal(client.text.length, big.length);
  assert.ok(Date.now() - t0 < 5000);
  await client.close();
});

test('Antigravity /model shows real active ID, /model list shows clean base models, and /list all integrates Desktop sidebar DB with busy guard & SEC-001 isolation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-agy-parity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const stateDir = path.join(root, 'state');
  const logDir = path.join(root, 'logs');
  const agyHome = path.join(root, 'agy-home');
  const desktopGeminiDir = path.join(root, 'desktop-gemini');
  const desktopAppDir = path.join(desktopGeminiDir, 'antigravity');
  const sharedRoot = path.join(root, 'antigravity-shared-sessions');
  const workspace = path.join(root, 'ws-agy-5');
  const desktopWs = path.join(root, 'ws-desktop-project');
  for (const dir of [stateDir, logDir, agyHome, desktopAppDir, sharedRoot, workspace, desktopWs]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Create mock Antigravity Desktop conversation_summaries.db
  const dbPath = path.join(desktopAppDir, 'conversation_summaries.db');
  const db = new DatabaseSync(dbPath);
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
  const insert = db.prepare(`INSERT INTO conversation_summaries (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, not_fully_idle, killed, parent_conversation_id, app_data_dir) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run('conv-desktop-idle-0001', 'Desktop Idle Chat', '', 12, '2026-11-23 11:00:00.000+00:00', desktopWs, 'idle', 0, 0, '', 'antigravity');
  insert.run('conv-desktop-busy-0002', 'Desktop Active Chat', '', 20, '2026-11-23 12:00:00.000+00:00', desktopWs, 'running', 1, 0, '', 'antigravity');
  db.close();

  const nativeListed = listAntigravityNativeConversations({ geminiDir: desktopGeminiDir, appDataDir: 'antigravity' });
  assert.equal(nativeListed.length, 2);
  assert.equal(isAntigravityConversationBusy({ geminiDir: desktopGeminiDir, appDataDir: 'antigravity', conversationId: 'conv-desktop-busy-0002' }), true);
  assert.equal(isAntigravityConversationBusy({ geminiDir: desktopGeminiDir, appDataDir: 'antigravity', conversationId: 'conv-desktop-idle-0001' }), false);

  // Seed antigravity-runtime.json so /model & /status know the real active ID with zero subprocesses
  fs.writeFileSync(path.join(stateDir, 'antigravity-runtime.json'), JSON.stringify({
    provider: 'official',
    models: {
      currentModelId: 'gemini-4-neon-high',
      availableModels: [
        { modelId: 'gemini-4-neon-low', name: 'Gemini 4 Neon (Low)' },
        { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
        { modelId: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (XHigh)' },
        { modelId: 'claude-opus-5-5-low', name: 'Claude Opus 5.5 (Low)' },
        { modelId: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
      ],
    },
    configOptions: [
      { id: 'model', currentValue: 'gemini-4-neon', options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }, { value: 'claude-opus-5-5', name: 'Claude Opus 5.5' }] },
      { id: 'thought_level', currentValue: 'high', options: [{ value: 'low' }, { value: 'high' }, { value: 'xhigh' }] },
    ],
  }));

  const botConfigPath = path.join(root, 'bot.json');
  fs.writeFileSync(botConfigPath, JSON.stringify({ engine: 'antigravity', provider: { id: 'official', model: '', reasoning: '' }, antigravity: { permissionMode: 'always-proceed' } }));

  const config = {
    engine: 'antigravity',
    larkProfile: 'antigravity-5',
    workspace,
    stateDir,
    logDir,
    antigravityCli: { command: 'agy', argsPrefix: [] },
    antigravityHome: agyHome,
    antigravityDesktopGeminiDir: desktopGeminiDir,
    antigravityDataRoot: root,
    antigravityBotConfig: botConfigPath,
    antigravitySharedSessionsRoot: sharedRoot,
    ownerOpenId: 'ou_owner123',
    codexIdleTimeoutMs: 60_000,
  };
  const sharedStore = createSharedClaudeSessionStore({
    config,
    sessionsPath: path.join(stateDir, 'sessions.json'),
    createSessionData: (title) => ({ id: Math.random().toString(16).slice(2, 10), title, createdAt: Date.now(), updatedAt: Date.now(), messages: [] }),
  });

  const replies = [];
  let probeClients = 0;
  const bridge = createAntigravityBridge({
    config,
    getSession: sharedStore.getSession,
    getChatState: sharedStore.getChatState,
    getChats: () => sharedStore.sessions.chats,
    resetSession: sharedStore.resetSession,
    saveSessions: sharedStore.saveSessions,
    sharedSessions: sharedStore.shared,
    userText: (c) => String(c || ''),
    sendMarkdown: async (_chatId, text) => { replies.push(text); },
    activeChildren: new Map(),
    activeJobs: new Map(),
    appendText: () => {},
    reduceEvent: () => {},
    markPhase: () => {},
    ensureDone: () => {},
    markInterrupted: () => {},
    markError: () => {},
    createClient: (opts) => {
      probeClients += 1;
      const mock = makeAcpMock();
      return new AntigravityAcpClient({ ...opts, spawnProcess: () => mock.child });
    },
  });

  const ownerDm = { chat_id: 'oc_dm_owner', chat_type: 'p2p', sender_id: 'ou_owner123', message_id: 'm1' };
  const groupEvt = { chat_id: 'oc_group_1', chat_type: 'group', sender_id: 'ou_owner123', message_id: 'm2' };

  // 1) /model shows real resolved model ID & effort with ZERO subprocesses
  await bridge.handleCommand(ownerDm, { name: '/model', rest: '' });
  assert.equal(probeClients, 0);
  assert.match(replies.at(-1), /gemini-4-neon/);
  assert.match(replies.at(-1), /high/);

  // 2) /model list shows clean base models (NOT Cartesian product) with ● highlight
  await bridge.handleCommand(ownerDm, { name: '/model', rest: 'list' });
  assert.equal(probeClients, 1);
  assert.match(replies.at(-1), /● `gemini-4-neon`/);
  assert.match(replies.at(-1), /`claude-opus-5-5`/);
  assert.doesNotMatch(replies.at(-1), /gemini-4-neon-xhigh/);

  // 3) /model claude-opus-5-5 switches cleanly and validates per-model effort
  await bridge.handleCommand(ownerDm, { name: '/model', rest: 'claude-opus-5-5' });
  assert.match(replies.at(-1), /claude-opus-5-5/);
  await assert.rejects(
    () => bridge.handleCommand(ownerDm, { name: '/effort', rest: 'xhigh' }),
    /思考强度无效/,
  );

  // 4) Legacy suffixed model ID still works by splitting into base model + effort
  await bridge.handleCommand(ownerDm, { name: '/model', rest: 'gemini-4-neon-xhigh' });
  assert.match(replies.at(-1), /gemini-4-neon/);
  assert.match(replies.at(-1), /xhigh/);

  // 5) /mode always-proceed works
  await bridge.handleCommand(ownerDm, { name: '/mode', rest: 'always-proceed' });
  assert.match(replies.at(-1), /always-proceed/);

  // 6) /list hints about Desktop sidebar; /list all lists Desktop sidebar conversations; group chat sees ZERO Desktop conversations
  await bridge.handleCommand(ownerDm, { name: '/list', rest: '' });
  assert.match(replies.at(-1), /侧边栏另有 2 条原生对话/);

  await bridge.handleCommand(groupEvt, { name: '/list', rest: 'all' });
  assert.doesNotMatch(replies.at(-1), /Desktop Idle Chat/);

  await bridge.handleCommand(ownerDm, { name: '/list', rest: 'all' });
  const listAllText = replies.at(-1);
  assert.match(listAllText, /Desktop Active Chat.*\[客户端运行中\]/);
  assert.match(listAllText, /Desktop Idle Chat/);

  // Switching to busy Desktop conversation is blocked cleanly
  await bridge.handleCommand(ownerDm, { name: '/switch', rest: 'conv-desktop-busy-0002' });
  assert.match(replies.at(-1), /正在 Antigravity 客户端中运行/);

  // Switching to idle Desktop conversation binds with desktopGeminiDir + appDataDir='antigravity' + original cwd
  await bridge.handleCommand(ownerDm, { name: '/switch', rest: 'conv-desktop-idle-0001' });
  assert.match(replies.at(-1), /已切换到原生对话：Desktop Idle Chat/);
  const switched = sharedStore.getSession(ownerDm.chat_id, sharedStore.shared.accessContextForEvent(ownerDm));
  assert.equal(switched.antigravitySessionId, 'conv-desktop-idle-0001');
  assert.equal(switched.antigravityAppDataDir, 'antigravity');
  assert.equal(path.resolve(switched.antigravityHome), path.resolve(desktopGeminiDir));
  assert.equal(path.resolve(switched.antigravityWorkspace), path.resolve(desktopWs));

  // Catalog extractor unit check
  const cat = extractAntigravityModelCatalog(
    { currentModelId: 'gemini-4-neon-xhigh', availableModels: [{ modelId: 'gemini-4-neon-low' }, { modelId: 'gemini-4-neon-xhigh' }] },
    [{ id: 'model', currentValue: 'gemini-4-neon', options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }] }],
  );
  assert.equal(cat.currentBaseModel, 'gemini-4-neon');
  assert.deepEqual(cat.baseModels[0].efforts, ['low', 'xhigh']);
});

test('Codex parser supports /effort and passes unknown native /skills through; protocol preserves codexWorkspace', () => {
  assert.deepEqual(parseCommand('/effort high', { engine: 'codex' }), { name: '/effort', rest: 'high', text: '/effort high' });
  assert.deepEqual(parseCommand('/effort clear', { engine: 'codex' }), { name: '/effort', rest: 'clear', text: '/effort clear' });
  assert.equal(parseCommand('/plan refactor auth', { engine: 'codex' }), null);
  assert.equal(parseCommand('/my-custom-skill arg', { engine: 'codex' }), null);

  const protocol = createAppServerProtocol({
    config: { workspace: 'C:\\default-ws', codexSandbox: 'danger-full-access', disableMcp: false },
    applySessionThreadOverrides: (p) => p,
    applySessionTurnOverrides: (p) => p,
    userTextFromContent: (c) => String(c || ''),
    attachmentPromptBlock: () => '',
  });
  assert.equal(protocol.resumeParams({ codexThreadId: 't1', codexWorkspace: 'C:\\other-project' }).cwd, 'C:\\other-project');
  assert.equal(protocol.resumeParams({ codexThreadId: 't1' }).cwd, 'C:\\default-ws');
});

test('Claude defaults to bypassPermissions, raises line limit to >=128MiB, fixes /effort clear, highlights /model list, and lists native ~/.claude sessions in /list all', async (t) => {
  assert.ok(CLAUDE_MAX_LINE >= 128 * 1024 * 1024);
  const fullArgs = claudeArguments({ sessionId: '11111111-1111-4111-8111-111111111111', model: 'claude-opus-5-5', permissionMode: 'bypassPermissions' });
  assert.equal(fullArgs[fullArgs.indexOf('--permission-mode') + 1], 'bypassPermissions');
  assert.ok(fullArgs.includes('--dangerously-skip-permissions'));

  // Verify ClaudeCliClient auto-approves can_use_tool in bypassPermissions mode
  const written = [];
  const bypassClient = new ClaudeCliClient({
    command: 'claude',
    cwd: process.cwd(),
    home: os.tmpdir(),
    provider: { model: 'claude-opus-5-5', baseUrl: 'https://example.invalid', apiKey: 'k' },
    permissionMode: 'bypassPermissions',
    onPermission: () => { throw new Error('bypassPermissions must auto-approve'); },
  });
  bypassClient.child = { stdin: { writable: true, writableEnded: false, write: (line) => written.push(JSON.parse(line)) } };
  await bypassClient.handleControl({ request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
  assert.equal(written[0]?.response?.response?.behavior, 'allow');

  // Fixture for Claude commands + native ~/.claude /list all
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-claude-parity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  const botHome = path.join(root, 'claude-home-1');
  const desktopClaudeHome = path.join(root, 'desktop-claude');
  const nativeProjDir = path.join(desktopClaudeHome, 'projects', 'c--work-demo');
  const sharedRoot = path.join(root, 'claude-shared-sessions');
  const workspace = path.join(root, 'ws-claude-1');
  for (const dir of [stateDir, botHome, nativeProjDir, sharedRoot, workspace]) fs.mkdirSync(dir, { recursive: true });

  const nativeUuid = '22222222-2222-4222-8222-222222222222';
  fs.writeFileSync(path.join(nativeProjDir, `${nativeUuid}.jsonl`), [
    JSON.stringify({ type: 'user', cwd: 'C:\\work\\demo', message: { role: 'user', content: 'Native CLI session prompt' } }),
    JSON.stringify({ type: 'custom-title', customTitle: 'My Native CLI Chat', sessionId: nativeUuid }),
  ].join('\n') + '\n');

  const scanned = listClaudeNativeSessions({ claudeHome: desktopClaudeHome });
  assert.equal(scanned.length, 1);
  assert.equal(scanned[0].title, 'My Native CLI Chat');
  assert.equal(scanned[0].cwd, 'C:\\work\\demo');

  const catalogFile = path.join(root, 'claude-providers.json');
  fs.writeFileSync(catalogFile, JSON.stringify({
    schemaVersion: 1,
    providers: [{ id: 'p1', name: 'P1', baseUrl: 'https://example.invalid', envKey: 'TEST_CLAUDE_K', model: 'claude-opus-5-5', effort: 'high', models: ['claude-opus-5-5', 'claude-sonnet-5-5'] }],
  }));
  const botConfig = path.join(root, 'bot.json');
  fs.writeFileSync(botConfig, JSON.stringify({ engine: 'claude', provider: { id: 'p1', model: 'claude-opus-5-5', reasoning: 'high' } }));

  const config = {
    engine: 'claude',
    larkProfile: 'claude-1',
    workspace,
    stateDir,
    claudeCli: { command: 'claude', argsPrefix: [] },
    claudeHome: botHome,
    claudeDesktopHome: desktopClaudeHome,
    claudeProviderCatalog: catalogFile,
    claudeProviderId: 'p1',
    claudeBotConfig: botConfig,
    claudeSharedSessionsRoot: sharedRoot,
    ownerOpenId: 'ou_owner123',
  };
  const sharedStore = createSharedClaudeSessionStore({
    config,
    sessionsPath: path.join(stateDir, 'sessions.json'),
    createSessionData: (title) => ({ id: Math.random().toString(16).slice(2, 10), title, createdAt: Date.now(), updatedAt: Date.now(), messages: [] }),
  });

  const replies = [];
  const bridge = createClaudeBridge({
    config,
    getSession: sharedStore.getSession,
    getChatState: sharedStore.getChatState,
    getChats: () => sharedStore.sessions.chats,
    resetSession: sharedStore.resetSession,
    saveSessions: sharedStore.saveSessions,
    sharedSessions: sharedStore.shared,
    refreshModels: async () => ['claude-opus-5-5', 'claude-sonnet-5-5'],
    userText: (c) => String(c || ''),
    sendText: async (_c, text) => { replies.push(text); },
    sendMarkdown: async (_c, text) => { replies.push(text); },
    activeChildren: new Map(),
    activeJobs: new Map(),
    appendText: () => {},
    reduceEvent: () => {},
    markPhase: () => {},
    ensureDone: () => {},
    markInterrupted: () => {},
    markError: () => {},
    terminateProcessTree: () => {},
  });

  const ownerDm = { chat_id: 'oc_dm_owner', chat_type: 'p2p', sender_id: 'ou_owner123', message_id: 'c1' };
  const groupEvt = { chat_id: 'oc_group_1', chat_type: 'group', sender_id: 'ou_owner123', message_id: 'c2' };

  // Default permissionMode falls back to bypassPermissions even when omitted in bot.json
  assert.equal(bridge.settings(sharedStore.getSession(ownerDm.chat_id, sharedStore.shared.accessContextForEvent(ownerDm))).permissionMode, 'bypassPermissions');

  // /effort xhigh -> /effort clear succeeds cleanly
  await bridge.handleCommand(ownerDm, { name: '/effort', rest: 'xhigh' });
  assert.equal(sharedStore.getSession(ownerDm.chat_id, sharedStore.shared.accessContextForEvent(ownerDm)).reasoningOverride, 'xhigh');
  await bridge.handleCommand(ownerDm, { name: '/effort', rest: 'clear' });
  assert.equal(sharedStore.getSession(ownerDm.chat_id, sharedStore.shared.accessContextForEvent(ownerDm)).reasoningOverride, '');

  // /model list highlights current model
  await bridge.handleCommand(ownerDm, { name: '/model', rest: 'list' });
  assert.match(replies.at(-1), /● claude-opus-5-5 ← 当前/);

  // /list hints native CLI; /list all lists native CLI for owner DM only; /switch binds cleanly
  await bridge.handleCommand(ownerDm, { name: '/list', rest: '' });
  assert.match(replies.at(-1), /本机原生 Claude CLI 另有 1 条会话/);
  await bridge.handleCommand(groupEvt, { name: '/list', rest: 'all' });
  assert.doesNotMatch(replies.at(-1), /My Native CLI Chat/);
  await bridge.handleCommand(ownerDm, { name: '/list', rest: 'all' });
  assert.match(replies.at(-1), /My Native CLI Chat.*原生 CLI/);
  await bridge.handleCommand(ownerDm, { name: '/switch', rest: nativeUuid });
  assert.match(replies.at(-1), /已切换到原生 Claude 会话：My Native CLI Chat/);

  // Line limit error classification across all 3 engines
  assert.equal(classifyCodexFailure(new Error('Claude Code 返回的单条事件超过上限 (134217728 bytes)')).kind, 'app_server_line_limit');
  assert.equal(classifyCodexFailure(new Error('Antigravity 单条事件超过上限 (134217728 bytes)')).kind, 'app_server_line_limit');
});

test('Antigravity supports native /goal & /compact pass-through plus batch/range /delete 1 3-4 across Bridge & native stores with busy/SEC-001 guards', async (t) => {
  for (const cmd of ['/goal build x', '/compact', '/plan step 1', '/boost deep', '/teamwork big', '/swarm run', '/schedule every 5m', '/browser open', '/grill-me', '/learn', '/btw hi']) {
    assert.equal(parseCommand(cmd, { engine: 'antigravity' }), null, `${cmd} should pass through natively`);
  }
  assert.equal(parseCommand('/steer 1', { engine: 'antigravity' })?.name, '/steer');
  assert.equal(parseCommand('/fast on', { engine: 'antigravity' })?.name, '/fast');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-agy-del-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  const stateDir = path.join(root, 'state');
  const logDir = path.join(root, 'logs');
  const agyHome = path.join(root, 'agy-home');
  const desktopGeminiDir = path.join(root, 'desktop-gemini');
  const desktopAppDir = path.join(desktopGeminiDir, 'antigravity');
  const cliAppDir = path.join(agyHome, 'antigravity-cli');
  const sharedRoot = path.join(root, 'antigravity-shared-sessions');
  const workspace = path.join(root, 'ws-agy');
  for (const dir of [stateDir, logDir, agyHome, desktopAppDir, cliAppDir, sharedRoot, workspace]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const initDb = (dir, appDataDir, rows) => {
    const db = new DatabaseSync(path.join(dir, 'conversation_summaries.db'));
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
    const ins = db.prepare(`INSERT INTO conversation_summaries (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, not_fully_idle, killed, parent_conversation_id, app_data_dir) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of rows) {
      ins.run(r.id, r.title, '', 5, r.ts, workspace, r.busy ? 'running' : 'idle', r.busy ? 1 : 0, 0, '', appDataDir);
      fs.mkdirSync(path.join(dir, 'conversations'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'brain', r.id), { recursive: true });
      fs.writeFileSync(path.join(dir, 'conversations', `${r.id}.db`), 'sqlite-data');
      fs.writeFileSync(path.join(dir, 'conversations', `${r.id}.db-wal`), 'wal-data');
      fs.writeFileSync(path.join(dir, 'conversations', `${r.id}.db-shm`), 'shm-data');
      fs.writeFileSync(path.join(dir, 'brain', r.id, 'note.md'), 'artifact');
    }
    db.close();
  };

  const busyUuid = '11111111-1111-4111-8111-111111111111';
  const idleDeskUuid = '22222222-2222-4222-8222-222222222222';
  const idleCliUuid = '33333333-3333-4333-8333-333333333333';
  initDb(desktopAppDir, 'antigravity', [
    { id: busyUuid, title: 'Busy Desktop Conv', ts: '2026-11-23 12:00:00.000+00:00', busy: true },
    { id: idleDeskUuid, title: 'Idle Desktop Conv', ts: '2026-11-23 11:00:00.000+00:00', busy: false },
  ]);
  initDb(cliAppDir, 'antigravity-cli', [
    { id: idleCliUuid, title: 'Idle CLI Conv', ts: '2026-11-23 10:00:00.000+00:00', busy: false },
  ]);

  const botConfigPath = path.join(root, 'bot.json');
  fs.writeFileSync(botConfigPath, JSON.stringify({
    engine: 'antigravity',
    provider: { id: 'official', model: '', reasoning: '' },
    antigravity: { permissionMode: 'always-proceed' },
  }));

  const config = {
    engine: 'antigravity',
    larkProfile: 'antigravity-5',
    stateDir,
    logDir,
    workspace,
    antigravityHome: agyHome,
    antigravityDesktopGeminiDir: desktopGeminiDir,
    antigravityDataRoot: root,
    antigravityBotConfig: botConfigPath,
    antigravitySharedSessionsRoot: sharedRoot,
    ownerOpenId: 'ou_owner999',
    antigravityCli: { command: 'agy' },
  };
  const sharedStore = createSharedClaudeSessionStore({
    config,
    sources: [{ bot: 'antigravity-5', home: agyHome, workspace, stateFile: path.join(stateDir, 'sessions.json') }],
    sessionsPath: path.join(stateDir, 'sessions.json'),
    createSessionData: (title) => ({ id: 'bridge01', title, engine: 'antigravity', createdAt: Date.now(), updatedAt: Date.now(), messages: [], antigravitySessionId: '' }),
  });
  const replies = [];
  const bridge = createAntigravityBridge({
    config,
    getSession: sharedStore.getSession,
    getChatState: sharedStore.getChatState,
    getChats: sharedStore.getChats,
    resetSession: sharedStore.resetSession,
    saveSessions: sharedStore.saveSessions,
    sharedSessions: sharedStore.shared,
    userText: (c) => String(c || ''),
    sendMarkdown: async (_c, text) => { replies.push(text); },
    activeChildren: new Map(),
    activeJobs: new Map(),
    appendText: () => {},
    reduceEvent: () => {},
    markPhase: () => {},
    ensureDone: () => {},
    markInterrupted: () => {},
    markError: () => {},
    queueSummary: () => '无',
  });

  const dmEvt = { chat_id: 'oc_dm', chat_type: 'p2p', sender_id: 'ou_owner999', message_id: 'm1' };
  const grpEvt = { chat_id: 'oc_grp', chat_type: 'group', sender_id: 'ou_owner999', message_id: 'm2' };

  // Seed Bridge session #1
  sharedStore.getSession(dmEvt.chat_id, sharedStore.shared.accessContextForEvent(dmEvt));
  sharedStore.saveSessions();

  // /list all -> 1=Bridge, 2=Busy Desktop, 3=Idle Desktop, 4=Idle CLI
  await bridge.handleCommand(dmEvt, { name: '/list', rest: 'all' });
  assert.match(replies.at(-1), /\*\*1\.\*\*/);
  assert.match(replies.at(-1), /\*\*4\.\*\*/);

  // Trying to include busy item #2 rejects cleanly
  await assert.rejects(() => bridge.handleCommand(dmEvt, { name: '/delete', rest: '1 2-4' }), /正在 Antigravity 客户端中运行/);

  // Group chat cannot delete native UUID (SEC-001)
  await bridge.handleCommand(grpEvt, { name: '/delete', rest: idleDeskUuid });
  assert.match(replies.at(-1), /未找到可访问的会话/);

  // Owner DM batch/range /delete 1 3-4 -> preview -> /confirm delete 1 3-4 deletes all 3 cleanly!
  await bridge.handleCommand(dmEvt, { name: '/delete', rest: '1 3-4' });
  assert.match(replies.at(-1), /待删除：3 条/);
  assert.match(replies.at(-1), /\/confirm delete 1 3-4/);

  await bridge.handleCommand(dmEvt, { name: '/confirm', rest: 'delete 1 3-4' });
  assert.match(replies.at(-1), /已删除 3 条会话（共享绑定 1 条，原生对话记录 2 条）/);

  // Verify idle Desktop & CLI artifacts (.db/.db-wal/.db-shm/brain) and DB rows are gone while busy conversation stays untouched
  assert.equal(fs.existsSync(path.join(desktopAppDir, 'conversations', `${idleDeskUuid}.db`)), false);
  assert.equal(fs.existsSync(path.join(desktopAppDir, 'conversations', `${idleDeskUuid}.db-wal`)), false);
  assert.equal(fs.existsSync(path.join(desktopAppDir, 'conversations', `${idleDeskUuid}.db-shm`)), false);
  assert.equal(fs.existsSync(path.join(desktopAppDir, 'brain', idleDeskUuid)), false);
  assert.equal(fs.existsSync(path.join(cliAppDir, 'conversations', `${idleCliUuid}.db`)), false);
  assert.equal(fs.existsSync(path.join(desktopAppDir, 'conversations', `${busyUuid}.db`)), true);
  assert.equal(listAntigravityNativeConversations({ geminiDir: desktopGeminiDir, appDataDir: 'antigravity' }).length, 1);
  assert.equal(listAntigravityNativeConversations({ geminiDir: agyHome, appDataDir: 'antigravity-cli' }).length, 0);
});
