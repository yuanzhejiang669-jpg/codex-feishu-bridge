import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createClaudeBridge } from '../src/claude/bridge-runner.mjs';
import { claudeHelpMarkdown } from '../src/claude/commands.mjs';

function fixture(t, extras = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-claude-parity-'));
  const envKey = `CFB_PARITY_${process.pid}_${Math.random().toString(16).slice(2)}`;
  process.env[envKey] = 'fixture-key';
  t.after(() => { delete process.env[envKey]; fs.rmSync(root, { recursive: true, force: true }); });
  const config = { stateDir: root, claudeHome: root, workspace: root, larkProfile: 'claude-fixture',
    claudeCli: { command: 'claude' }, claudeBotConfig: path.join(root, 'bot.json'),
    claudeProviderCatalog: path.join(root, 'providers.json'), claudeProviderId: 'one' };
  const provider = { id: 'one', name: 'One', model: 'claude-opus-5-5', effort: 'high',
    envKey, baseUrl: 'https://example.invalid', models: ['claude-opus-5-5', 'claude-other'] };
  fs.writeFileSync(config.claudeProviderCatalog, JSON.stringify({ providers: [provider, { ...provider, id: 'two' }] }));
  fs.writeFileSync(config.claudeBotConfig, JSON.stringify({ engine: 'claude', provider: { id: 'one', model: provider.model, reasoning: 'high' }, unrelated: 'keep' }));
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ autoCompactWindow: 400000,
    env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000', ENABLE_TOOL_SEARCH: 'false' }, unrelated: 'keep' }));
  const sessions = [{ id: 'first', engine: 'claude', title: 'First', messages: [] }, { id: 'second', engine: 'claude', title: 'Second', messages: [] }];
  const chat = { currentSessionId: 'first', sessions };
  const replies = []; const activeJobs = new Map(); let saves = 0;
  const bridge = createClaudeBridge({ config, getSession: () => chat.sessions.find((s) => s.id === chat.currentSessionId),
    getChatState: () => chat, getChats: () => ({ chat }), resetSession: () => sessions[0],
    saveSessions: () => { saves++; }, activeJobs, activeChildren: new Map(), userText: (c) => c,
    queueSummary: () => '2 条等待', sendMarkdown: async (_id, text) => replies.push(text),
    refreshModels: async () => provider.models, ...extras });
  t.after(() => bridge.close());
  const event = { chat_id: 'chat', sender_id: 'user', content: 'original', message_id: 'message' };
  return { root, config, provider, sessions, chat, replies, activeJobs, bridge,
    send: (name, rest = '') => bridge.handleCommand(event, { name, rest }), get saves() { return saves; } };
}

test('model and effort operations persist across reads, support clear/save, and keep per-Bot defaults', async (t) => {
  const f = fixture(t);
  await f.send('/model', 'claude-other medium');
  assert.equal(f.bridge.settings(f.sessions[0]).model, 'claude-other');
  assert.equal(f.bridge.settings(f.sessions[0]).reasoning, 'medium');
  assert.equal(f.bridge.settings(f.sessions[1]).model, 'claude-opus-5-5');
  await f.send('/model', 'clear');
  assert.equal(f.bridge.settings(f.sessions[0]).model, 'claude-opus-5-5');
  await f.send('/model', 'save effort xhigh');
  assert.equal(f.bridge.settings(f.sessions[1]).reasoning, 'xhigh');
  const native = JSON.parse(fs.readFileSync(path.join(f.root, 'settings.json')));
  assert.equal(native.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '400000');
  assert.equal(native.env.ENABLE_TOOL_SEARCH, 'false');
  assert.equal(native.unrelated, 'keep');
  assert.equal(JSON.parse(fs.readFileSync(f.config.claudeBotConfig)).unrelated, 'keep');
  await f.send('/effort', 'HIGH');
  assert.equal(f.bridge.settings(f.sessions[0]).reasoning, 'high');
  await assert.rejects(f.send('/effort', 'none'), /Claude 可用强度/);
  await f.send('/model', 'reasoning low');
  assert.equal(f.bridge.settings(f.sessions[0]).reasoning, 'low');
  await f.send('/model', 'claude-other');
  await f.send('/model', 'save effort medium');
  assert.equal(JSON.parse(fs.readFileSync(f.config.claudeBotConfig)).provider.model, 'claude-opus-5-5');
  assert.equal(f.bridge.settings(f.sessions[0]).model, 'claude-other');
  await assert.rejects(f.send('/model', 'missing-model'), /模型不在/);
});

test('provider save and clear retain catalog credentials and do not switch other sessions', async (t) => {
  const f = fixture(t);
  await f.send('/provider', 'two');
  assert.equal(f.bridge.settings(f.sessions[0]).provider, 'two');
  assert.equal(f.bridge.settings(f.sessions[1]).provider, 'one');
  await f.send('/provider', 'clear');
  assert.equal(f.bridge.settings(f.sessions[0]).provider, 'one');
  await f.send('/provider', 'save two');
  assert.equal(f.bridge.settings(f.sessions[1]).provider, 'two');
  const bot = fs.readFileSync(f.config.claudeBotConfig, 'utf8');
  assert.equal(bot.includes('fixture-key'), false);
  const catalog = fs.readFileSync(f.config.claudeProviderCatalog, 'utf8');
  await f.send('/provider', 'shortcuts');
  assert.equal(fs.readFileSync(f.config.claudeProviderCatalog, 'utf8'), catalog);
  f.activeJobs.set('chat', {});
  await assert.rejects(f.send('/provider', 'one'), /任务结束/);
});

test('rename accepts a list index and context reports the configured window without inventing model capacity', async (t) => {
  const f = fixture(t);
  await f.send('/rename', '2 New second title');
  assert.equal(f.sessions[1].title, 'New second title');
  assert.equal(f.sessions[0].title, 'First');
  await f.send('/context');
  assert.match(f.replies.at(-1), /400,000 tokens/);
  assert.match(f.replies.at(-1), /2 条等待/);
  assert.match(f.replies.at(-1), /固定触发点/);
  assert.equal(f.sessions[0].lastContextUsage, undefined);
  await f.send('/reset');
  assert.equal(f.sessions[0].lastCompactedAt, null);
});

test('model list refresh is shared in the catalog and degrades to a labeled cached list', async (t) => {
  const f = fixture(t, { refreshModels: async () => ['claude-opus-5-5', 'new-model'] });
  await f.send('/model', 'list');
  assert.match(f.replies.at(-1), /new-model/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.config.claudeProviderCatalog)).providers[0].models,
    ['claude-opus-5-5', 'new-model']);
  const bad = fixture(t, { refreshModels: async () => { throw new Error('HTTP 502'); } });
  await bad.send('/model', 'list');
  assert.match(bad.replies.at(-1), /HTTP 502.*已保存/);
});

test('model test uses an isolated nonpersistent CLI and leaves the original binding and settings untouched', async (t) => {
  let launched;
  const f = fixture(t, { createClient: (options) => {
    launched = options;
    return { run: async () => ({ result: 'OK' }) };
  } });
  const original = JSON.stringify(f.sessions);
  await f.send('/model', 'test claude-opus-5-5');
  assert.equal(JSON.stringify(f.sessions), original);
  assert.equal(launched.persistSession, false);
  assert.equal(launched.disableMcp, true);
  assert.equal(launched.tools, '');
  assert.equal(launched.resume, undefined);
  assert.match(f.replies.at(-1), /测试成功/);
});

test('manual compact calls the native command and reports success only on a real compact boundary', async (t) => {
  let launched; let content;
  const f = fixture(t, { createClient: (options) => {
    launched = options;
    return { run: async (input) => {
      content = input;
      options.onEvent({ type: 'compacted', at: 1234567890000 });
      return { result: 'Compacted' };
    } };
  } });
  f.sessions[0].claudeSessionId = '7507f65c-a17f-4c14-b2d8-5badb5a0aa80';
  await f.send('/compact', 'keep equations');
  assert.equal(launched.dispatchCommand, true);
  assert.equal(content[0].text, '/compact keep equations');
  assert.match(f.replies.at(-1), /上下文已压缩/);
  f.activeJobs.set('chat', {});
  await assert.rejects(f.send('/compact'), /还在运行/);
  const noOp = fixture(t, { createClient: () => ({ run: async () => ({ result: 'Not enough messages to compact.' }) }) });
  noOp.sessions[0].claudeSessionId = f.sessions[0].claudeSessionId;
  await noOp.send('/compact');
  assert.match(noOp.replies.at(-1), /本次未发生压缩/);
});

test('steer targets the active native client, preserves text and rejects failed attachments', async (t) => {
  const f = fixture(t); let steered;
  f.activeJobs.set('chat', { mode: 'claude', sessionId: 'second', client: { steer: (value) => { steered = value; } } });
  await f.send('/steer', '只保留第一部分');
  assert.equal(steered[0].text, '只保留第一部分');
  assert.equal(f.sessions[1].messages[0].content, '只保留第一部分');
  assert.equal(f.sessions[0].messages.length, 0);
  f.activeJobs.clear();
  await f.send('/steer', 'next');
  assert.match(f.replies.at(-1), /没有可追加/);
});

test('help lists shared operations and Codex-only commands never fall through to a Codex client', async (t) => {
  const f = fixture(t);
  for (const name of ['/provider save', '/model save', '/rename <序号>', '/compact', '/steer', '/clearqueueall']) {
    assert.ok(claudeHelpMarkdown().includes(name), name);
  }
  for (const name of ['/goal', '/fast']) {
    assert.equal(await f.send(name), true);
    assert.match(f.replies.at(-1), /Codex 专属/);
  }
  for (const name of ['/stop', '/stopall', '/queue', '/clearqueue', '/clearqueueall']) {
    assert.equal(await f.send(name), false, `${name} must use the shared queue controller`);
  }
});
