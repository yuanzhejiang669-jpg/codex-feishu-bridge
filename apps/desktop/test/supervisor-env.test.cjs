const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { posixBridgeEnvironment, processEnvironment } = require('../src/main/services/supervisor.cjs');

function fixture(platform, engine) {
  const root = path.join(os.tmpdir(), 'cfb-supervisor-env-fixture');
  const options = { dataRoot: path.join(root, 'data'), localAppData: path.join(root, 'runtime'),
    nodePath: path.join(root, 'tools', 'node'), larkCliPath: path.join(root, 'tools', 'lark-cli'), platform };
  const bot = { name: 'fixture-bot', profile: 'fixture-profile', workspace: path.join(root, 'workspace'), engine,
    claudeHome: path.join(root, 'claude-home'), antigravityHome: path.join(root, 'antigravity-home'),
    configPath: path.join(options.dataRoot, 'managed-bots', 'fixture-bot', 'bot.json') };
  const paths = { stateDir: path.join(root, 'state'), logDir: path.join(root, 'logs') };
  return { root, options, bot, paths, profileHome: path.join(options.dataRoot, 'profile-home') };
}

for (const platform of ['win32', 'linux']) {
  for (const engine of ['codex', 'claude', 'antigravity']) {
    test(`${platform} ${engine} preserves the host home and isolates only Lark identity`, () => {
      const value = fixture(platform, engine);
      for (const environment of [
        processEnvironment(value.options, value.bot),
        posixBridgeEnvironment(value.bot, path.join(value.root, 'codex-home'), value.options, value.paths),
      ]) {
        assert.equal(environment.CODEX_FEISHU_LARK_PROFILE_HOME, value.profileHome);
        assert.equal(environment.USERPROFILE, process.env.USERPROFILE);
        assert.equal(environment.HOME, process.env.HOME);
        assert.notEqual(environment.USERPROFILE, value.profileHome);
        assert.notEqual(environment.HOME, value.profileHome);
        assert.equal(environment.CODEX_FEISHU_ENGINE, engine);
        assert.equal(environment.LARK_CLI_BIN, value.options.larkCliPath);
      }
    });
  }
}
