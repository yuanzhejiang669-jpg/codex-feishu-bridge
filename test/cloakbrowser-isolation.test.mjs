import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse as parseToml } from 'smol-toml';
import { applyCloakBrowserIsolationToMcpConfig, codexCloakBrowserArgs, resolveCloakBrowserDirs, shouldOverrideCloakBrowserPath } from '../src/config/cloakbrowser.mjs';
import { createClaudeBridge } from '../src/claude/bridge-runner.mjs';
import { nativeMcpServers } from '../src/antigravity/bridge-runner.mjs';
import { processEnvironment } from '../apps/desktop/src/main/services/supervisor.cjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-cloak-isolation-'));
  t.diagnostic('temporary fixture (cleaned after test): ' + root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function withBrowserEnv(t, values = {}) {
  for (const name of ['PLAYWRIGHT_MCP_USER_DATA_DIR', 'PLAYWRIGHT_MCP_OUTPUT_DIR']) {
    const before = process.env[name];
    if (values[name] === undefined) delete process.env[name]; else process.env[name] = values[name];
    t.after(() => { if (before === undefined) delete process.env[name]; else process.env[name] = before; });
  }
}

test('Codex overrides only enabled CloakBrowser default paths without mutating native configuration', () => {
  const config = { stateDir: path.join(os.tmpdir(), 'fixture', 'state') };
  const text = '[mcp_servers.cloakbrowser]\ncommand="fixture"\nargs=["server"]\n[mcp_servers.cloakbrowser.env]\nPLAYWRIGHT_MCP_USER_DATA_DIR="C:/shared/browser-profiles/cloakbrowser/default"\nPLAYWRIGHT_MCP_OUTPUT_DIR="C:/shared/browser-artifacts/cloakbrowser/default"\nKEEP="kept"\n';
  const dirs = resolveCloakBrowserDirs(config, {});
  const args = codexCloakBrowserArgs(text, config, {});
  assert.equal(args.length, 4);
  const parsed = parseToml(text);
  for (let i = 0; i < args.length; i += 2) {
    assert.equal(args[i], '-c');
    Object.assign(parsed.mcp_servers.cloakbrowser.env, parseToml(args[i + 1]).mcp_servers.cloakbrowser.env);
  }
  assert.equal(parsed.mcp_servers.cloakbrowser.command, 'fixture');
  assert.deepEqual(parsed.mcp_servers.cloakbrowser.args, ['server']);
  assert.equal(parsed.mcp_servers.cloakbrowser.env.KEEP, 'kept');
  assert.equal(parsed.mcp_servers.cloakbrowser.env.PLAYWRIGHT_MCP_USER_DATA_DIR, dirs.userDataDir);
  assert.equal(parsed.mcp_servers.cloakbrowser.env.PLAYWRIGHT_MCP_OUTPUT_DIR, dirs.outputDir);
  for (const invalid of ['', '[mcp_servers.other]\ncommand="node"', '[broken', '[mcp_servers.cloakbrowser]\nenv={}', '[mcp_servers.cloakbrowser]\ncommand="node"\nenabled=false', '[mcp_servers.cloakbrowser]\ncommand="node"\ndisabled=true']) {
    assert.deepEqual(codexCloakBrowserArgs(invalid, config, {}), []);
  }
  assert.deepEqual(codexCloakBrowserArgs(text, { ...config, disableMcp: true }, {}), []);
  const custom = '[mcp_servers.cloakbrowser]\ncommand="node"\n[mcp_servers.cloakbrowser.env]\nPLAYWRIGHT_MCP_USER_DATA_DIR="/explicit/profile"\nPLAYWRIGHT_MCP_OUTPUT_DIR="/explicit/output"';
  assert.deepEqual(codexCloakBrowserArgs(custom, config, {}), []);
});

test('shared placeholders and default paths are isolated while concrete custom paths are preserved immutably', () => {
  const dirs = { userDataDir: 'instance-profile', outputDir: 'instance-output' };
  for (const value of [undefined, '', ' ', 'C:\\shared\\browser-profiles\\cloakbrowser\\default\\', '/browser-output/cloakbrowser/default', '${CLAUDE_CONFIG_DIR}/old', '${PLAYWRIGHT_MCP_USER_DATA_DIR}', '${PLAYWRIGHT_MCP_OUTPUT_DIR:-fallback}']) {
    assert.equal(shouldOverrideCloakBrowserPath(value), true);
    const original = { mcpServers: { cloakbrowser: { command: 'fixture', env: { PLAYWRIGHT_MCP_USER_DATA_DIR: value, KEEP: 'yes' } } } };
    const result = applyCloakBrowserIsolationToMcpConfig(original, dirs);
    assert.equal(result.changed, true);
    assert.equal(result.mcp.mcpServers.cloakbrowser.env.PLAYWRIGHT_MCP_USER_DATA_DIR, dirs.userDataDir);
    assert.equal(result.mcp.mcpServers.cloakbrowser.env.KEEP, 'yes');
    assert.equal(original.mcpServers.cloakbrowser.env.PLAYWRIGHT_MCP_USER_DATA_DIR, value);
  }
  const explicit = { mcpServers: { cloakbrowser: { env: { PLAYWRIGHT_MCP_USER_DATA_DIR: '/custom/profile', PLAYWRIGHT_MCP_OUTPUT_DIR: '/custom/output' } } } };
  assert.equal(applyCloakBrowserIsolationToMcpConfig(explicit, dirs).mcp, explicit);
  assert.deepEqual(resolveCloakBrowserDirs({}, {}), { userDataDir: '', outputDir: '' });
});

test('desktop injects instance-local paths only for a managed Bot and preserves explicit overrides', (t) => {
  const root = fixture(t);
  const options = { dataRoot: path.join(root, 'data'), localAppData: path.join(root, 'runtime'), nodePath: process.execPath,
    larkCliPath: 'lark', platform: 'win32' };
  const bot = { name: 'fixture-bot', engine: 'codex', profile: 'fixture' };
  const env = processEnvironment(options, bot);
  assert.match(env.PLAYWRIGHT_MCP_USER_DATA_DIR, /instances[\\/]fixture-bot[\\/]state[\\/]browser-profiles[\\/]cloakbrowser$/);
  assert.match(env.PLAYWRIGHT_MCP_OUTPUT_DIR, /instances[\\/]fixture-bot[\\/]state[\\/]browser-output[\\/]cloakbrowser$/);
  assert.equal(processEnvironment(options).PLAYWRIGHT_MCP_USER_DATA_DIR, undefined);
  assert.equal(processEnvironment(options, { ...bot, name: '' }).PLAYWRIGHT_MCP_OUTPUT_DIR, undefined);
  const beforeUserData = process.env.PLAYWRIGHT_MCP_USER_DATA_DIR;
  const beforeOutput = process.env.PLAYWRIGHT_MCP_OUTPUT_DIR;
  t.after(() => { if (beforeUserData === undefined) delete process.env.PLAYWRIGHT_MCP_USER_DATA_DIR; else process.env.PLAYWRIGHT_MCP_USER_DATA_DIR = beforeUserData;
    if (beforeOutput === undefined) delete process.env.PLAYWRIGHT_MCP_OUTPUT_DIR; else process.env.PLAYWRIGHT_MCP_OUTPUT_DIR = beforeOutput; });
  process.env.PLAYWRIGHT_MCP_USER_DATA_DIR = 'preserved-profile';
  process.env.PLAYWRIGHT_MCP_OUTPUT_DIR = 'preserved-output';
  const explicit = processEnvironment(options, bot);
  assert.equal(explicit.PLAYWRIGHT_MCP_USER_DATA_DIR, 'preserved-profile');
  assert.equal(explicit.PLAYWRIGHT_MCP_OUTPUT_DIR, 'preserved-output');
});

for (const shared of [false, true]) {
  for (const external of [false, true]) {
    test('Claude isolates every MCP layer; shared=' + shared + ', external=' + external, async (t) => {
      const root = fixture(t);
      withBrowserEnv(t, external ? { PLAYWRIGHT_MCP_USER_DATA_DIR: path.join(root, 'external-profile'), PLAYWRIGHT_MCP_OUTPUT_DIR: path.join(root, 'external-output') } : {});
      const key = 'CFB_CLOAK_TEST_' + crypto.randomBytes(6).toString('hex');
      process.env[key] = 'fixture-key'; t.after(() => { delete process.env[key]; });
      const config = { claudeHome: path.join(root, 'current-home'), claudeToolsRoot: path.join(root, 'tools'),
        workspace: path.join(root, 'workspace'), stateDir: path.join(root, 'instance', 'state'),
        claudeProviderId: 'fixture', claudeProviderCatalog: path.join(root, 'providers.json'), claudeCli: { command: 'fixture' } };
      const originalWorkspace = shared ? path.join(root, 'original-workspace') : config.workspace;
      const files = [path.join(config.claudeToolsRoot, '.mcp.json'), path.join(config.claudeHome, '.mcp.json'), path.join(originalWorkspace, '.mcp.json')];
      const paths = ['', '${CLAUDE_CONFIG_DIR}/browser-profiles/cloakbrowser', '/shared/browser-profiles/cloakbrowser/default'];
      files.forEach((file, index) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ mcpServers: { cloakbrowser: { command: 'fixture-' + index, env: { PLAYWRIGHT_MCP_USER_DATA_DIR: paths[index] } }, other: { command: 'other-' + index } } })); });
      fs.writeFileSync(config.claudeProviderCatalog, JSON.stringify({ providers: [{ id: 'fixture', envKey: key, baseUrl: 'https://example.invalid', model: 'fixture', effort: 'high' }] }));
      const originals = files.map(file => fs.readFileSync(file, 'utf8'));
      const session = { id: 'fixture', claudeWorkspace: originalWorkspace };
      let launched;
      const bridge = createClaudeBridge({ config, activeChildren: new Map(), activeJobs: new Map(), getSession: () => session,
        getChatState: () => ({ sessions: [session] }), getChats: () => ({}), saveSessions: () => {}, userText: x => x,
        sharedSessions: shared ? { acquire: () => () => {}, sessionHome: () => path.join(root, 'original-home') } : undefined,
        createClient: options => { launched = options; return { run: async () => ({ result: 'OK' }) }; } });
      t.after(() => bridge.close());
      await bridge.run({ chat_id: 'fixture', content: 'fixture' }, session, null);
      const dirs = resolveCloakBrowserDirs(config);
      assert.equal(launched.mcpConfigs.length, 3);
      for (const [index, raw] of launched.mcpConfigs.entries()) {
        const value = JSON.parse(raw);
        assert.equal(value.mcpServers.cloakbrowser.env.PLAYWRIGHT_MCP_USER_DATA_DIR, dirs.userDataDir);
        assert.equal(value.mcpServers.cloakbrowser.env.PLAYWRIGHT_MCP_OUTPUT_DIR, dirs.outputDir);
        assert.equal(value.mcpServers.other.command, 'other-' + index);
      }
      assert.deepEqual(files.map(file => fs.readFileSync(file, 'utf8')), originals);
      const custom = { mcpServers: { cloakbrowser: { command: 'custom', env: { PLAYWRIGHT_MCP_USER_DATA_DIR: '/custom/profile', PLAYWRIGHT_MCP_OUTPUT_DIR: '/custom/output' } } } };
      fs.writeFileSync(files[2], JSON.stringify(custom));
      await bridge.run({ chat_id: 'fixture', content: 'fixture' }, session, null);
      assert.equal(launched.mcpConfigs[2], files[2]);
    });
  }
}

test('Antigravity isolates the merged MCP definition before expanding inherited-home placeholders', (t) => {
  const root = fixture(t);
  const config = { antigravityMcpConfig: path.join(root, 'shared.json'), antigravityHome: path.join(root, 'home'),
    workspace: path.join(root, 'workspace'), stateDir: path.join(root, 'state') };
  const files = [config.antigravityMcpConfig, path.join(config.antigravityHome, 'config', 'mcp_config.json'), path.join(config.workspace, '.mcp.json')];
  for (const [index, file] of files.entries()) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { cloakbrowser: { command: 'layer-' + index, env: { PLAYWRIGHT_MCP_USER_DATA_DIR: '${CLAUDE_CONFIG_DIR}/browser-profiles/cloakbrowser', KEEP: 'yes' } } } }));
  }
  const dirs = resolveCloakBrowserDirs(config, {});
  let result = nativeMcpServers(config, null, {})[0];
  assert.equal(result.command, 'layer-2');
  assert.deepEqual(Object.fromEntries(result.env.map(item => [item.name, item.value])), { PLAYWRIGHT_MCP_USER_DATA_DIR: dirs.userDataDir, KEEP: 'yes', PLAYWRIGHT_MCP_OUTPUT_DIR: dirs.outputDir });
  fs.writeFileSync(files[2], JSON.stringify({ mcpServers: { cloakbrowser: { command: 'custom', env: { PLAYWRIGHT_MCP_USER_DATA_DIR: '/custom/profile', PLAYWRIGHT_MCP_OUTPUT_DIR: '/custom/output' } } } }));
  result = nativeMcpServers(config, null, {})[0];
  assert.equal(result.env[0].value, '/custom/profile');
});
