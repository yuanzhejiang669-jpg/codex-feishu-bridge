import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createSharedClaudeSessionStore } from '../src/claude/shared-sessions.mjs';
import { createClaudeBridge } from '../src/claude/bridge-runner.mjs';
import { claudeEnvironment } from '../src/claude/cli-client.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-shared-claude-'));
  const envKey = `CFB_SHARED_${crypto.randomBytes(8).toString('hex')}`;
  process.env[envKey] = 'fixture-credential';
  t.after(() => { delete process.env[envKey]; fs.rmSync(root, { recursive: true, force: true }); });
  let clock = 1000;
  const configs = [1, 2].map((i) => ({ larkProfile: `claude-${i}`, claudeHome: path.join(root, 'homes', `claude-${i}`),
    workspace: path.join(root, 'workspaces', `claude-${i}`), stateDir: path.join(root, 'instances', `claude-${i}`, 'state'),
    claudeSharedSessionsRoot: path.join(root, 'shared'), claudeBotConfig: path.join(root, `bot-${i}.json`),
    claudeProviderCatalog: path.join(root, 'providers.json'), claudeProviderId: 'fixture', claudeCli: { command: 'claude' }, disableMcp: true }));
  for (const c of configs) {
    fs.mkdirSync(c.claudeHome, { recursive: true }); fs.mkdirSync(c.workspace, { recursive: true }); fs.mkdirSync(c.stateDir, { recursive: true });
    fs.writeFileSync(c.claudeBotConfig, JSON.stringify({ provider: { id: 'fixture', model: 'claude-opus-5-5', reasoning: 'high' }, claude: { permissionMode: 'bypassPermissions' } }));
  }
  fs.writeFileSync(configs[0].claudeProviderCatalog, JSON.stringify({ providers: [{ id: 'fixture', envKey, name: 'Fixture',
    model: 'claude-opus-5-5', effort: 'high', models: ['claude-opus-5-5'], baseUrl: 'https://example.invalid' }] }));
  const sources = configs.map((c) => ({ bot: c.larkProfile, home: c.claudeHome, workspace: c.workspace, stateFile: path.join(c.stateDir, 'sessions.json') }));
  function make(index) {
    return createSharedClaudeSessionStore({ config: configs[index], sessionsPath: sources[index].stateFile, sources,
      createSessionData: (title) => ({ id: crypto.randomBytes(4).toString('hex'), title, engine: 'claude', createdAt: ++clock, updatedAt: clock, messages: [], claudeSessionId: '' }),
      normalizeSessionData: (s) => ({ ...s }) });
  }
  function bridge(index, store, extra = {}) {
    const replies = []; const jobs = new Map();
    const b = createClaudeBridge({ config: configs[index], ...store, getChats: () => store.sessions.chats,
      sharedSessions: store.shared, userText: (v) => v, activeJobs: jobs, activeChildren: new Map(),
      sendMarkdown: async (_chat, text) => replies.push(text), ...extra });
    t.after(() => b.close());
    return { b, jobs, replies, send: (name, rest = '') => b.handleCommand({ chat_id: 'chat', sender_id: 'user', message_id: 'test' }, { name, rest }) };
  }
  return { root, configs, sources, make, bridge, readPool: () => JSON.parse(fs.readFileSync(path.join(root, 'shared', 'sessions.json'))) };
}

test('all Bots see new sessions while current selection and original native storage remain independent', (t) => {
  const f = fixture(t); const a = f.make(0);
  const first = a.resetSession('chat', 'from one');
  first.claudeSessionId = crypto.randomUUID(); a.saveSessions();
  const b = f.make(1);
  assert.equal(b.getChatState('chat').sessions[0].id, first.id);
  const second = b.resetSession('chat', 'from two');
  assert.equal(a.getSession('chat').id, first.id);
  assert.equal(b.getSession('chat').id, second.id);
  assert.equal(a.getChatState('chat').sessions.length, 2);
  assert.equal(b.shared.sessionHome(b.getChatState('chat').sessions.find((s) => s.id === first.id)), f.configs[0].claudeHome);
  assert.equal(f.make(0).getSession('chat').id, first.id);
});

test('stale processes merge changed fields without erasing another Bot rename or local pending progress', (t) => {
  const f = fixture(t); const a = f.make(0); const first = a.getSession('chat');
  const b = f.make(1); const other = b.getSession('chat');
  first.title = 'new shared title'; a.saveSessions();
  other.reasoningOverride = 'medium';
  assert.equal(b.getSession('chat'), other);
  assert.equal(other.title, 'new shared title');
  assert.equal(other.reasoningOverride, 'medium');
  b.saveSessions();
  assert.equal(a.getSession('chat').title, 'new shared title');
  assert.equal(a.getSession('chat').reasoningOverride, 'medium');
});

test('list snapshots keep switch and rename indices stable when another Bot creates a session', async (t) => {
  const f = fixture(t); const a = f.make(0); a.resetSession('chat', 'one');
  const b = f.make(1); const two = b.resetSession('chat', 'two');
  const ui = f.bridge(1, b);
  await ui.send('/list');
  assert.match(ui.replies.at(-1), /共享会话库/);
  a.resetSession('chat', 'three');
  await ui.send('/switch', '1');
  assert.equal(b.getSession('chat').id, two.id);
  await ui.send('/rename', '1 shared renamed');
  assert.equal(a.getChatState('chat').sessions.find((s) => s.id === two.id).title, 'shared renamed');
});

test('cross-Bot resume uses the original Home and workspace but current Bot tool isolation', async (t) => {
  const f = fixture(t); const a = f.make(0); const first = a.getSession('chat');
  first.claudeSessionId = crypto.randomUUID(); a.saveSessions();
  const b = f.make(1); let launched;
  f.configs[1].claudeToolsRoot = path.join(f.root, 'tools');
  f.configs[1].disableMcp = false;
  fs.mkdirSync(f.configs[1].claudeToolsRoot);
  fs.writeFileSync(path.join(f.configs[1].claudeToolsRoot, '.mcp.json'), JSON.stringify({ mcpServers: {
    cloakbrowser: { command: 'fixture', env: { PLAYWRIGHT_MCP_USER_DATA_DIR: '${CLAUDE_CONFIG_DIR}/old' } },
    other: { command: 'other-fixture' } } }));
  const ui = f.bridge(1, b, { createClient: (options) => {
    launched = options;
    return { run: async () => {
      assert.throws(() => a.shared.acquire(a.getSession('chat')), /使用|运行/);
      return { result: 'continued' };
    } };
  } });
  assert.equal((await ui.b.run({ chat_id: 'chat', content: 'continue' }, b.getSession('chat'), null)).text, 'continued');
  assert.equal(launched.home, f.configs[0].claudeHome);
  assert.equal(launched.cwd, f.configs[0].workspace);
  assert.equal(launched.toolHome, f.configs[1].claudeHome);
  assert.equal(launched.sessionId, first.claudeSessionId);
  assert.equal(launched.resume, true);
  const mcp = JSON.parse(launched.mcpConfigs[0]);
  assert.equal(mcp.mcpServers.cloakbrowser.env.PLAYWRIGHT_MCP_USER_DATA_DIR, path.join(f.configs[1].claudeHome, 'browser-profiles', 'cloakbrowser'));
  assert.equal(mcp.mcpServers.other.command, 'other-fixture');
  const env = claudeEnvironment({}, { home: launched.home, toolHome: launched.toolHome, provider: { baseUrl: 'https://example.invalid', apiKey: 'fixture', model: 'claude-opus-5-5' } });
  assert.equal(env.CFB_CLAUDE_BOT_HOME, f.configs[1].claudeHome);
  const release = a.shared.acquire(a.getSession('chat')); release();
});

test('busy shared sessions reject switching, reset and deletion until the owner finishes', async (t) => {
  const f = fixture(t); const a = f.make(0); const first = a.getSession('chat');
  const b = f.make(1); const ui = f.bridge(1, b);
  const release = a.shared.acquire(first);
  await assert.rejects(ui.send('/switch', first.id), /运行/);
  await assert.rejects(ui.send('/reset'), /使用|运行/);
  await ui.send('/delete', first.id);
  assert.match(ui.replies.at(-1), /使用|运行/);
  release();
  await ui.send('/reset');
  assert.equal(a.getSession('chat').claudeSessionId, '');
});

test('confirmed shared deletion removes the original record everywhere and cannot be resurrected by stale caches', async (t) => {
  const f = fixture(t); const a = f.make(0); const first = a.getSession('chat');
  first.claudeSessionId = crypto.randomUUID(); a.saveSessions();
  const project = path.join(f.configs[0].claudeHome, 'projects', 'original-project'); fs.mkdirSync(project, { recursive: true });
  const transcript = path.join(project, first.claudeSessionId + '.jsonl'); fs.writeFileSync(transcript, '{}\n');
  const b = f.make(1); const stale = b.getSession('chat'); const ui = f.bridge(1, b);
  await ui.send('/list'); await ui.send('/delete', first.id);
  assert.match(ui.replies.at(-1), /所有 Claude Bot/);
  assert.ok(fs.existsSync(transcript));
  await ui.send('/confirm', 'delete 1');
  assert.match(ui.replies.at(-1), /已删除 1/);
  assert.equal(fs.existsSync(transcript), false);
  stale.title = 'stale overwrite'; a.saveSessions();
  assert.equal(a.getChatState('chat').sessions.length, 0);
  assert.equal(f.readPool().sessions[first.id], undefined);
  assert.ok(f.readPool().deleted[first.id]);
  assert.equal(f.make(0).getChatState('chat').sessions.length, 0);
});

test('deletion confirmation rechecks a remote lease and normal run failures always release it', async (t) => {
  const f = fixture(t); const a = f.make(0); const first = a.getSession('chat'); const b = f.make(1);
  const ui = f.bridge(1, b, { createClient: () => ({ run: async () => { throw new Error('fixture failure'); } }) });
  await ui.send('/delete', first.id);
  const release = a.shared.acquire(first);
  await ui.send('/confirm', 'delete 1'); assert.match(ui.replies.at(-1), /使用|运行/);
  release();
  await assert.rejects(ui.b.run({ chat_id: 'chat', content: 'test' }, b.getSession('chat'), null), /fixture failure/);
  const again = a.shared.acquire(first); again();
});

test('shared leases recover a dead native host without stealing a live host lock', (t) => {
  const f = fixture(t); const a = f.make(0); const first = a.getSession('chat');
  const directory = path.join(f.root, 'shared', 'leases', first.id); fs.mkdirSync(directory, { recursive: true });
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ pid: dead.pid, bot: 'dead-host', token: 'old' }));
  const release = a.shared.acquire(first); release();
  assert.equal(fs.existsSync(directory), false);
});

test('two independent processes create shared sessions without losing concurrent catalog writes', async (t) => {
  const f = fixture(t); f.make(0);
  const oldLock = path.join(f.root, 'shared', '.catalog.lock'); fs.mkdirSync(oldLock);
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  fs.writeFileSync(path.join(oldLock, 'owner.json'), JSON.stringify({ pid: dead.pid, token: 'stale-catalog' }));
  const moduleUrl = pathToFileURL(path.resolve('src/claude/shared-sessions.mjs')).href;
  const code = `import crypto from 'node:crypto'; import path from 'node:path';
    import { createSharedClaudeSessionStore } from ${JSON.stringify(moduleUrl)};
    const c=JSON.parse(process.env.CFB_TEST_CONFIG); const sources=JSON.parse(process.env.CFB_TEST_SOURCES);
    const s=createSharedClaudeSessionStore({config:c,sessionsPath:path.join(c.stateDir,'sessions.json'),sources,
      createSessionData:title=>({id:crypto.randomBytes(8).toString('hex'),title,engine:'claude',createdAt:Date.now(),messages:[]}),normalizeSessionData:v=>({...v})});
    for(let i=0;i<20;i++)s.resetSession('chat',c.larkProfile+'-'+i);`;
  await Promise.all(f.configs.map((c) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true,
      env: { ...process.env, CFB_TEST_CONFIG: JSON.stringify(c), CFB_TEST_SOURCES: JSON.stringify(f.sources) }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', (b) => { stderr += b; });
    child.once('error', reject); child.once('close', (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  assert.equal(Object.keys(f.readPool().sessions).length, 40);
});
