import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSharedClaudeSessionStore } from '../src/claude/shared-sessions.mjs';
import { createAntigravityBridge, nativeMcpServers } from '../src/antigravity/bridge-runner.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-agy-shared-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ownerCtx = (chatId) => ({ chatId, chatType: 'p2p', senderId: 'ou_owner1' });
  const configs = [1, 2].map((i) => ({ engine: 'antigravity', larkProfile: `antigravity-${i}`,
    antigravityDataRoot: root, antigravityHome: path.join(root, 'home'), antigravityCli: { command: 'agy' },
    antigravitySharedSessionsRoot: path.join(root, 'shared'), workspace: path.join(root, `work-${i}`),
    stateDir: path.join(root, 'instances', `antigravity-${i}`, 'state'), logDir: path.join(root, 'logs'),
    ownerOpenId: 'ou_owner1', disableMcp: true }));
  for (const config of configs) { fs.mkdirSync(config.workspace, { recursive: true }); fs.mkdirSync(config.stateDir, { recursive: true }); }
  const sources = configs.map((c) => ({ bot: c.larkProfile, home: c.antigravityHome, workspace: c.workspace, stateFile: path.join(c.stateDir, 'sessions.json') }));
  const make = (i) => {
    const raw = createSharedClaudeSessionStore({ config: configs[i], sources, sessionsPath: sources[i].stateFile,
      createSessionData: (title) => ({ id: crypto.randomUUID(), title, engine: 'antigravity', createdAt: Date.now(), messages: [], antigravitySessionId: '' }) });
    return {
      ...raw,
      getChatState: (chatId, ctx = ownerCtx(chatId)) => raw.getChatState(chatId, ctx),
      getSession: (chatId, ctx = ownerCtx(chatId)) => raw.getSession(chatId, ctx),
      resetSession: (chatId, title, ctx = ownerCtx(chatId)) => raw.resetSession(chatId, title, ctx),
    };
  };
  const bridge = (i, store, createClient) => createAntigravityBridge({ config: configs[i], ...store,
    sharedSessions: store.shared, activeJobs: new Map(), activeChildren: new Map(), userText: (v) => v, sendMarkdown: async () => {}, createClient });
  return { root, configs, sources, make, bridge, ownerCtx };
}

test('five-Bot session design shares bindings, preserves original workspace and locks concurrent execution', async (t) => {
  const f = fixture(t); const a = f.make(0); const first = a.getSession('chat');
  first.antigravitySessionId = 'native-id'; a.saveSessions(); const b = f.make(1); const selected = b.getSession('other-chat');
  assert.equal(selected.id, first.id); assert.equal(selected.engine, 'antigravity');
  let launched; const client = { runtime: {}, child: { pid: process.pid },
    openSession: async (input) => { assert.equal(input.sessionId, 'native-id'); assert.throws(() => a.shared.acquire(a.getSession('chat')), /使用|运行/); return { sessionId: 'native-id' }; },
    prompt: async () => ({ text: 'OK' }), close: async () => {} };
  const runner = f.bridge(1, b, (input) => { launched = input; return client; });
  const result = await runner.run({ chat_id: 'other-chat', content: 'hello' }, selected);
  assert.equal(result.text, 'OK'); assert.equal(launched.cwd, f.configs[0].workspace);
  const release = a.shared.acquire(a.getSession('chat')); release();
  a.getSession('chat').title = 'shared rename'; a.saveSessions();
  assert.equal(b.getSession('other-chat').title, 'shared rename');
  assert.ok(!JSON.stringify(a.sessions).includes('claudeSession'));
});

test('constructor and startup failures release account and shared-session leases', async (t) => {
  const f = fixture(t); const a = f.make(0); const session = a.getSession('chat');
  const runner = f.bridge(0, a, () => { throw new Error('fixture-startup-error'); });
  await assert.rejects(runner.run({ chat_id: 'chat' }, session), /fixture-startup-error/);
  const release = a.shared.acquire(session); release();
  assert.equal(fs.readdirSync(path.join(f.root, 'antigravity-account-usage')).length, 0);
});

test('shared deletion tombstones prevent stale Bot caches from restoring removed bindings', (t) => {
  const f = fixture(t); const a = f.make(0); const session = a.getSession('chat'); const b = f.make(1); b.getSession('chat');
  const release = a.shared.acquireMany([session]); a.shared.remove([session.id], f.ownerCtx('chat')); release();
  b.saveSessions(); assert.equal(a.getChatState('chat').sessions.length, 0);
});

test('ACP MCP conversion resolves environment references and rejects missing credentials and unsupported transport', (t) => {
  const f = fixture(t); const file = path.join(f.root, 'mcp.json');
  const config = { antigravityHome: f.configs[0].antigravityHome, workspace: f.configs[0].workspace, antigravityMcpConfig: file };
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { fixture: { command: 'node', args: ['${SCRIPT}'], env: { TOKEN: '${KEY}' } } } }));
  const converted = nativeMcpServers(config, null, { SCRIPT: 'server.mjs', KEY: 'opaque' });
  assert.deepEqual(converted[0].env, [{ name: 'TOKEN', value: 'opaque' }]);
  fs.mkdirSync(path.join(config.antigravityHome, 'config'), { recursive: true });
  const globalFile = path.join(config.antigravityHome, 'config', 'mcp_config.json');
  fs.writeFileSync(globalFile, '');
  assert.equal(nativeMcpServers(config, null, { SCRIPT: 'server.mjs', KEY: 'opaque' }).length, 1);
  fs.writeFileSync(globalFile, '{broken');
  assert.throws(() => nativeMcpServers(config), SyntaxError);
  fs.writeFileSync(globalFile, '');
  assert.throws(() => nativeMcpServers(config, null, {}), /SCRIPT/);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { fixture: { url: 'https://example.invalid', type: 'websocket' } } }));
  assert.throws(() => nativeMcpServers(config), /传输类型/);
});
