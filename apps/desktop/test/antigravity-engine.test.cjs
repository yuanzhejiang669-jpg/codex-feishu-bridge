const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const service = require('../src/main/services/antigravity.cjs');
const { createManagedBot } = require('../src/main/services/bot-setup.cjs');
const { previewWorkspaceFactory, createWorkspaceFactoryQueue } = require('../src/main/services/workspace-factory.cjs');
const { normalizeProvider, readAccounts, atomicJson, prepareNativeProfile } = require('../../../src/antigravity/configuration.cjs');
const { acquireOfficialLease } = require('../../../src/antigravity/account-lock.cjs');
const { inspectClaudeCapabilities, saveClaudeMcp } = require('../src/main/services/claude-capabilities.cjs');
const { queueClaudeReconfiguration, readPending } = require('../src/main/services/claude-reconfiguration.cjs');
const { startManagedBot, stopManagedBot } = require('../src/main/services/supervisor.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-agy-desktop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const credentials = new Map(); const calls = [];
  const options = { dataRoot: root, userHome: root, workspaceRoot: path.join(root, 'workspaces'),
    sourceCodexHome: path.join(root, '.codex'), engineRoot: path.resolve(__dirname, '../../..'),
    larkCliPath: 'fixture-lark', inspectRuntime: async () => ({ available: true, version: '1.5.14', runtimePath: 'fixture-agy' }),
    readCredential: async (name) => credentials.get(name) || '', setCredential: async (name, value) => credentials.set(name, value),
    createClient: () => ({ openSession: async () => ({ models: { currentModelId: 'native', availableModels: [{ modelId: 'native', name: 'Native' }] } }),
      prompt: async () => ({ text: 'ANTIGRAVITY_PROVIDER_OK' }), close: async () => {} }),
    runLarkCli: async (_tool, args) => { calls.push(args); return { stdout: '[]' }; },
    encrypt: (value) => Buffer.from(value).reverse(), decrypt: (value) => Buffer.from(value).reverse().toString(),
    readNativeCredential: () => ({ found: true, userName: 'antigravity', blob: 'b3BhcXVl', persist: 2 }),
    writeNativeCredential: (value) => { calls.push({ nativeWrite: value }); },
    inspectBots: async () => [], inspectExternalClients: async () => [] };
  fs.mkdirSync(options.sourceCodexHome); fs.writeFileSync(path.join(options.sourceCodexHome, 'config.toml'), '');
  return { root, credentials, calls, options };
}

test('Gemini channels validate endpoint protocol, use distinct credential slots, and save only after native generation', async (t) => {
  const f = fixture(t);
  assert.throws(() => normalizeProvider({ id: 'test', mode: 'openai' }), /Gemini/);
  assert.throws(() => normalizeProvider({ id: 'test', baseUrl: 'http://example.com' }), /HTTPS/);
  assert.throws(() => normalizeProvider({ id: 'test', baseUrl: 'https://example.com?key=unsafe' }), /URL/);
  assert.notEqual(normalizeProvider({ id: 'a-b' }).envKey, normalizeProvider({ id: 'a_b' }).envKey);
  const raw = { id: 'new-unsaved', mode: 'gemini-api', baseUrl: 'https://example.invalid', apiKey: 'fixture-secret', model: 'native' };
  assert.equal((await service.listAntigravityModels(raw, f.options)).models.length, 1);
  const saved = await service.saveAntigravityProvider(raw, f.options);
  assert.equal(f.credentials.get(saved.provider.envKey), 'fixture-secret');
  assert.ok(!fs.readFileSync(path.join(f.root, 'antigravity-providers.json'), 'utf8').includes('fixture-secret'));
  const failed = { ...f.options, createClient: () => ({ openSession: async () => ({ models: { availableModels: [{ modelId: 'native' }] } }), prompt: async () => ({ text: 'error' }), close: async () => {} }) };
  await assert.rejects(service.saveAntigravityProvider({ ...raw, id: 'bad-channel' }, failed), /生成测试/);
  assert.equal(service.inspectAntigravity(f.options).providers.length, 2);
});

test('manual official account snapshots are encrypted and cannot switch during active runs or native clients', async (t) => {
  const f = fixture(t); service.captureAntigravityAccount({ id: 'first' }, f.options); service.captureAntigravityAccount({ id: 'second' }, f.options);
  const binary = fs.readFileSync(path.join(f.root, 'antigravity-account-credentials', 'first.bin'));
  assert.ok(!binary.toString().includes('b3BhcXVl'));
  const release = acquireOfficialLease(f.root, { mode: 'official', accountId: 'second' });
  await assert.rejects(service.switchAntigravityAccount({ id: 'first' }, f.options), /仍被使用/);
  assert.throws(() => service.captureAntigravityAccount({ id: 'third' }, f.options), /仍被使用/); release();
  await assert.rejects(service.switchAntigravityAccount({ id: 'first' }, { ...f.options, inspectBots: async () => [{ name: 'antigravity-1', engine: 'antigravity', activeRunCount: 1 }] }), /任务仍在运行/);
  await assert.rejects(service.switchAntigravityAccount({ id: 'first' }, { ...f.options, inspectExternalClients: async () => [{ name: 'agy' }] }), /退出原生/);
  await service.switchAntigravityAccount({ id: 'first' }, f.options);
  assert.equal(readAccounts(f.root).activeId, 'first');
  assert.throws(() => acquireOfficialLease(f.root, { mode: 'official', accountId: 'second' }), /切换官方账号/);
  assert.equal(f.calls.filter((item) => item.nativeWrite).length, 1);
});

test('official login window blocks Bot use until it exits, without blocking third-party API mode', (t) => {
  const f = fixture(t); atomicJson(path.join(f.root, 'antigravity-login-session.json'), { pid: process.pid });
  assert.throws(() => acquireOfficialLease(f.root, { mode: 'official' }), /登录窗口/);
  assert.doesNotThrow(() => acquireOfficialLease(f.root, { mode: 'gemini-api' })());
});

test('native API mode is explicitly selected in a separate settings directory for each channel', (t) => {
  const f = fixture(t); const home = path.join(f.root, 'native-home');
  const a = prepareNativeProfile(home, { id: 'first', mode: 'gemini-api' });
  const b = prepareNativeProfile(home, { id: 'second', mode: 'gemini-api' });
  assert.notEqual(a, b); assert.equal(prepareNativeProfile(home, { mode: 'official' }), 'antigravity-cli');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, a, 'settings.json'))).modelProvider, 'gemini');
  assert.ok(!fs.existsSync(path.join(home, 'antigravity-cli', 'settings.json')));
  atomicJson(path.join(home, 'antigravity-cli', 'settings.json'), { modelProvider: 'gemini' });
  assert.throws(() => prepareNativeProfile(home, { mode: 'official' }), /API 模式/);
});

test('factory creates exactly five native-engine entries and registration persists native configuration', async (t) => {
  const f = fixture(t); const input = { engine: 'antigravity', providerId: 'official' };
  const preview = previewWorkspaceFactory(input, f.options);
  assert.equal(preview.bots.length, 5); assert.equal(preview.bots[4].label, 'Antigravity-5');
  assert.equal(new Set(preview.bots.map((bot) => bot.antigravityHome)).size, 1);
  const queue = createWorkspaceFactoryQueue(input, f.options); assert.equal(queue.factory.engine, 'antigravity');
  const created = await createManagedBot(preview.bots[0], { appId: 'cli_fixture123', appSecret: 'fixture-app-secret' }, f.options);
  const config = JSON.parse(fs.readFileSync(created.configPath));
  assert.equal(config.engine, 'antigravity'); assert.equal(config.provider.id, 'official');
  assert.equal(config.antigravity.permissionMode, 'default'); assert.equal(config.codexHome, '');
  assert.ok(!JSON.stringify(config).includes('fixture-app-secret'));
});

test('native toolset and pending restarts stay separate from Claude', (t) => {
  const f = fixture(t); const options = { ...f.options, toolEngine: 'antigravity' };
  const saved = saveClaudeMcp({ mcpServers: { fixture: { command: 'node' } } }, options);
  assert.match(saved.configPath, /antigravity-tools/);
  const inventory = inspectClaudeCapabilities(options); assert.equal(inventory.engine, 'antigravity'); assert.match(inventory.skillsRoot, /\.agents/);
  assert.equal(inspectClaudeCapabilities(f.options).mcpServers.length, 0);
  queueClaudeReconfiguration(f.root, ['antigravity-1'], 'antigravity');
  assert.equal(readPending(f.root).bots['antigravity-1'], undefined);
  assert.ok(readPending(f.root, 'antigravity').bots['antigravity-1']);
  assert.throws(() => saveClaudeMcp({ mcpServers: { fixture: { type: 'websocket', url: 'wss://example.invalid' } } }, options), /ACP/);
});

test('native Bot start and graceful stop work without PowerShell launch scripts', async (t) => {
  const f = fixture(t);
  const bot = await createManagedBot({ engine: 'antigravity', name: 'antigravity-1' }, { appId: 'cli_fixture123', appSecret: 'fixture' }, f.options);
  const entry = path.join(f.root, 'codex-feishu-bridge.mjs');
  fs.writeFileSync(entry, `import fs from 'node:fs';import path from 'node:path';const state=process.env.CODEX_FEISHU_STATE_DIR;fs.mkdirSync(state,{recursive:true});fs.writeFileSync(path.join(state,'bridge.pid'),String(process.pid));setInterval(()=>{if(fs.existsSync(path.join(state,'bridge.stop')))process.exit(0)},50);`);
  const options = { ...f.options, localAppData: path.join(f.root, 'runtime'), nodePath: process.execPath, larkCliPath: process.execPath,
    bridgeEntry: entry, inspectAntigravityRuntime: f.options.inspectRuntime };
  let started;
  try {
    started = await startManagedBot(bot.name, options); assert.equal(started.online, true);
    const stopped = await stopManagedBot(bot.name, options); assert.equal(stopped.online, false);
  } finally { if (started?.processId) { try { process.kill(started.processId); } catch {} } }
});
