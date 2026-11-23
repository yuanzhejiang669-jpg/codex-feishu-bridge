const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const providers = require('../src/main/services/claude-providers.cjs');
const { createManagedBot, readManagedBots } = require('../src/main/services/bot-setup.cjs');
const { previewWorkspaceFactory, createWorkspaceFactoryQueue, registerFactoryBot } = require('../src/main/services/workspace-factory.cjs');
const { assignClaudeProvider, previewClaudeBot } = require('../src/main/services/claude-bots.cjs');
const { queueClaudeReconfiguration, processClaudeReconfiguration, readPending } = require('../src/main/services/claude-reconfiguration.cjs');
const { migrateClaudeCapabilities, saveClaudeMcp, inspectClaudeCapabilities, validateMcp } = require('../src/main/services/claude-capabilities.cjs');
const { checkBotReadiness } = require('../src/main/services/bot-readiness.cjs');
const { collectKnownPaths, isKnownPath } = require('../src/main/services/known-paths.cjs');
const { providerSyncPlan } = require('../src/main/services/provider-manager.cjs');
const { supportedClaudeVersion } = require('../src/main/services/agent-engines.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-claude-engine-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const value = { root, dataRoot: path.join(root, 'data'), workspaceRoot: path.join(root, 'workspaces'),
    sourceCodexHome: path.join(root, 'source'), userHome: path.join(root, 'user'), env: {}, credentials: new Map(), calls: [] };
  fs.mkdirSync(value.sourceCodexHome, { recursive: true });
  fs.writeFileSync(path.join(value.sourceCodexHome, 'config.toml'), '', 'utf8');
  value.readCredential = async (key) => value.credentials.get(key) || '';
  value.setCredential = async (key, secret) => {
    if (secret) { value.credentials.set(key, secret); value.env[key] = secret; }
    else { value.credentials.delete(key); delete value.env[key]; }
  };
  value.fetchImpl = async (url, options) => {
    value.calls.push({ url, options });
    return { ok: true, text: async () => JSON.stringify(url.endsWith('/models') ? { data: [{ id: 'claude-test' }, { id: 'claude-second' }] }
      : { type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'OK' }] }) };
  };
  return value;
}
const rawProvider = (id = 'company') => ({ id, name: 'Company', baseUrl: 'https://provider.example/v1/',
  auth: 'bearer', model: 'claude-test', effort: 'high', apiKey: 'private-test-key' });
async function saved(t) { const value = fixture(t); await providers.saveClaudeProvider(rawProvider(), value); return value; }

test('Claude providers discover models, encrypt via the store, redact failures and remain separate from Codex', async (t) => {
  const value = await saved(t);
  const provider = providers.readCatalog(value.dataRoot).providers[0];
  assert.equal(provider.baseUrl, 'https://provider.example');
  assert.equal(value.calls[0].options.headers.authorization, 'Bearer private-test-key');
  assert.equal(value.calls[0].options.redirect, 'error');
  const catalog = fs.readFileSync(providers.catalogPath(value.dataRoot), 'utf8');
  assert.equal(catalog.includes('private-test-key'), false);
  assert.equal(providers.inspectClaudeProviders(value.dataRoot, value.env).providers[0].credentialAvailable, true);
  assert.equal(fs.readFileSync(path.join(value.sourceCodexHome, 'config.toml'), 'utf8'), '');
  assert.notEqual(providers.normalizeClaudeProvider(rawProvider('a-b')).envKey, providers.normalizeClaudeProvider(rawProvider('a_b')).envKey);
  await providers.replaceClaudeProviderKey({ id: provider.id, apiKey: 'replacement-key' }, value);
  assert.equal(value.credentials.get(provider.envKey), 'replacement-key');
  await assert.rejects(providers.listClaudeModels({ ...rawProvider(), apiKey: 'do-not-print' }, { fetchImpl: async () => { throw new Error('rejected do-not-print'); } }), /rejected \[redacted\]/);
  assert.throws(() => providers.normalizeClaudeProvider({ ...rawProvider(), baseUrl: 'https://user:password@example.com' }), /地址/);
});

test('invalid replacement keys leave working credentials untouched; concurrent providers are preserved', async (t) => {
  const value = await saved(t);
  const key = providers.readCatalog(value.dataRoot).providers[0].envKey;
  value.fetchImpl = async () => ({ ok: false, status: 403, text: async () => 'invalid credential' });
  await assert.rejects(providers.replaceClaudeProviderKey({ id: 'company', apiKey: 'bad' }, value), /403/);
  assert.equal(value.credentials.get(key), 'private-test-key');
  value.fetchImpl = async () => ({ ok: true, text: async () => JSON.stringify({ data: [{ id: 'claude-test' }] }) });
  await Promise.all([providers.saveClaudeProvider(rawProvider('another'), value), providers.saveClaudeProvider(rawProvider('third'), value)]);
  assert.deepEqual(providers.readCatalog(value.dataRoot).providers.map((p) => p.id).sort(), ['another', 'company', 'third']);
});

test('Claude 1–10 use ten independent native homes and carry their provider through QR registration', async (t) => {
  const value = await saved(t);
  const raw = { engine: 'claude', providerId: 'company', model: 'claude-test', count: 10 };
  const preview = previewWorkspaceFactory(raw, value);
  assert.equal(preview.available, true);
  assert.deepEqual(preview.bots.map((bot) => bot.label), Array.from({ length: 10 }, (_, i) => `Claude ${i+1}`));
  assert.equal(new Set(preview.bots.map((bot) => bot.claudeHome)).size, 10);
  assert.equal(preview.bots.every((bot) => bot.engine === 'claude' && !bot.codexHome), true);
  assert.throws(() => previewClaudeBot({ name: 'claude-11', claudeHome: preview.bots[0].claudeHome }, value), /隔离/);
  createWorkspaceFactoryQueue(raw, value);
  await registerFactoryBot('claude-1', { dataRoot: value.dataRoot, registrationOptions: value,
    registerBot: async (input) => {
      assert.equal(input.provider.id, 'company');
      return createManagedBot(input, { appId: 'cli_test123', appSecret: 'app-secret' }, {
        ...value, larkCliPath: 'lark', runLarkCli: async (_cli, args, options) => {
          if (args[0] === 'profile' && args[1] === 'list') return { stdout: '[]' };
          assert.equal(args.includes('app-secret'), false);
          assert.equal(options.input, 'app-secret'); return { stdout: '{}' };
        } });
    } });
  const bot = readManagedBots(value.dataRoot)[0];
  assert.equal(bot.engine, 'claude');
  assert.equal(bot.claude.permissionMode, 'bypassPermissions');
  assert.equal(bot.provider.model, 'claude-test');
  assert.equal(fs.readFileSync(path.join(bot.claudeHome, 'settings.json'), 'utf8').includes('private-test-key'), false);
  assert.equal(fs.existsSync(path.join(value.sourceCodexHome, 'auth.json')), false);
  assert.equal(isKnownPath(bot.claudeHome, collectKnownPaths({ setup: { managedBots: [bot] } })), true);
  const original = fs.readFileSync(bot.configPath, 'utf8');
  assert.throws(() => assignClaudeProvider({ providerId: 'company', botNames: [bot.name, 'codex-1'] }, value,
    [bot, { name: 'codex-1', engine: 'codex' }]), /不是 Claude/);
  assert.equal(fs.readFileSync(bot.configPath, 'utf8'), original);
  assignClaudeProvider({ providerId: 'company', model: 'claude-second', botNames: [bot.name] }, value, [bot]);
  assert.equal(JSON.parse(fs.readFileSync(bot.configPath)).provider.model, 'claude-second');
  assert.equal(fs.existsSync(path.join(bot.claudeHome, 'settings.json')), true);
});

test('provider updates defer active bots, retain newer revisions and never start disabled offline bots', async (t) => {
  const value = fixture(t);
  const bots = [{ name: 'busy', engine: 'claude', online: true, activeRunCount: 1 },
    { name: 'idle', engine: 'claude', online: true, activeRunCount: 0 },
    { name: 'offline', engine: 'claude', online: false, activeRunCount: 0 }];
  queueClaudeReconfiguration(value.dataRoot, bots.map((bot) => bot.name));
  const started = [];
  const result = await processClaudeReconfiguration({ dataRoot: value.dataRoot, inspectBots: () => bots,
    stopBot: async (name) => { bots.find((bot) => bot.name === name).online = false; },
    startBot: async (name) => { started.push(name); queueClaudeReconfiguration(value.dataRoot, [name]); bots.find((bot) => bot.name === name).online = true; } });
  assert.deepEqual(result.pending, ['busy']);
  assert.deepEqual(started, ['idle']);
  assert.deepEqual(Object.keys(readPending(value.dataRoot).bots).sort(), ['busy', 'idle']);
  bots[0].activeRunCount = 0;
  const race = await processClaudeReconfiguration({ dataRoot: value.dataRoot, inspectBots: () => bots,
    stopBot: async () => { throw Object.assign(new Error('new active turn'), { code: 'BOT_ACTIVE' }); },
    startBot: async () => assert.fail('must not start while active') });
  assert.deepEqual(race.pending.sort(), ['busy', 'idle']);
  assert.equal(race.failed.length, 0);
});

test('Claude MCP/Skills migration preserves native env references and existing entries', (t) => {
  const value = fixture(t);
  const skill = path.join(value.sourceCodexHome, 'skills', 'portable'); fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: portable\ndescription: Test skill\n---\nUse the local CLI.\n');
  fs.writeFileSync(path.join(value.sourceCodexHome, 'config.toml'), '[mcp_servers.docs]\nurl="https://mcp.example"\nbearer_token_env_var="DOCS_TOKEN"\n');
  assert.throws(() => migrateClaudeCapabilities({ skills: ['portable'], mcp: ['missing'] }, value), /不存在/);
  assert.equal(fs.existsSync(path.join(value.dataRoot, 'claude-tools', '.claude', 'skills', 'portable')), false);
  const result = migrateClaudeCapabilities({ skills: ['portable'], mcp: ['docs'] }, value);
  assert.equal(result.linked.length, 1); assert.deepEqual(result.added, ['docs']);
  const inventory = inspectClaudeCapabilities(value);
  assert.equal(inventory.skills[0].name, 'portable');
  assert.match(inventory.mcpJson, /Bearer \$\{DOCS_TOKEN\}/);
  assert.equal(migrateClaudeCapabilities({ skills: ['portable'], mcp: ['docs'] }, value).skipped.length, 2);
  assert.throws(() => validateMcp({ mcpServers: { bad: { command: 'node', env: { API_KEY: 'secret' } } } }), /内联凭据/);
  assert.doesNotThrow(() => saveClaudeMcp({ mcpServers: { good: { command: 'node', args: ['server.js'], env: { API_KEY: '${TOOL_TOKEN}' } } } }, value));
});

test('Claude readiness uses the Claude CLI and Claude provider, independent of Codex login', async (t) => {
  const value = await saved(t);
  const botRoot = path.join(value.dataRoot, 'managed-bots', 'claude-1'); fs.mkdirSync(botRoot, { recursive: true });
  fs.writeFileSync(path.join(botRoot, 'bot.json'), JSON.stringify({ name: 'claude-1', engine: 'claude', profile: 'claude-1', appId: 'cli_test', provider: { id: 'company', model: 'claude-test' } }));
  const result = await checkBotReadiness('claude-1', { ...value, larkCliPath: 'lark', claudeAvailable: true, codexAvailable: false,
    claudeProviders: providers.inspectClaudeProviders(value.dataRoot, value.env), engineAvailable: true,
    runLarkCli: async (_cli, args) => ({ stdout: JSON.stringify(args[0] === 'whoami'
      ? { identity: 'bot', available: true, tokenStatus: 'ready' }
      : args[0] === 'auth' ? { identities: { bot: { available: true, verified: true } } } : { code: 0, data: { scopes: [] } }) }) });
  assert.equal(result.checks.find((item) => item.id === 'claude').status, 'good');
  assert.equal(result.checks.some((item) => item.id === 'codex'), false);
  assert.equal(result.checks.find((item) => item.id === 'provider').status, 'good');
});

test('Codex provider sync cannot target a Claude Bot or its private home', (t) => {
  const value = fixture(t);
  const directory = path.join(value.dataRoot, 'managed-bots', 'claude-1'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'bot.json'), JSON.stringify({ name: 'claude-1', engine: 'claude', codexHome: '', codexHomeMode: 'isolated', claudeHome: '/private/claude' }));
  const result = providerSyncPlan({ ...value, codexHome: value.sourceCodexHome,
    writeTextAtomic: () => assert.fail('Codex sync must not write a Claude home') }, true);
  assert.equal(result.targets.length, 0);
  assert.equal(supportedClaudeVersion('2.1.327'), true);
  assert.equal(supportedClaudeVersion('2.1.328'), true);
  assert.equal(supportedClaudeVersion('2.1.80'), false);
});

test('ENG-CLD-002: createClaudeBot preserves max effortLevel in settings.json without downgrading to high', async (t) => {
  const value = fixture(t);
  await providers.saveClaudeProvider({ ...rawProvider('maxp'), effort: 'max' }, value);
  const bot = await createManagedBot(
    { name: 'claude-max', profile: 'claude-max', label: 'Claude Max', engine: 'claude', providerId: 'maxp', model: 'claude-test', reasoning: 'max' },
    { appId: 'cli_max123', appSecret: 'app-secret' },
    {
      ...value,
      larkCliPath: 'lark',
      runLarkCli: async (_cli, args) => ({ stdout: args[0] === 'profile' && args[1] === 'list' ? '[]' : '{}' }),
    },
  );
  const nativeSettings = JSON.parse(fs.readFileSync(path.join(bot.claudeHome, 'settings.json'), 'utf8'));
  assert.equal(nativeSettings.modelSettings['claude-test'].effortLevel, 'max');
});
