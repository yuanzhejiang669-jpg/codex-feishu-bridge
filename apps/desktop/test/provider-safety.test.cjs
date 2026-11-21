const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeWindowsUserEnvironment } = require('../src/main/services/windows-environment.cjs');
const { addGlobalProvider, replaceGlobalProviderKey, inspectProviderCatalog } = require('../src/main/services/provider-manager.cjs');
const { queueCodexCredentialReload, processCodexCredentialReload, readPendingCodexReload } = require('../src/main/services/codex-reconfiguration.cjs');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-provider-safety-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'config.toml'), 'model_provider="openai"\n[model_providers.existing]\nname="Existing"\nbase_url="https://example.test/v1"\nenv_key="TEST_API_KEY"\nwire_api="responses"\n');
  const state = { TEST_API_KEY: 'old-key' };
  return { dir, state, options: { codexHome: dir, dataRoot: dir, fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ data: [] }) }),
    readUserEnvironmentVariable: async key => state[key] || '', setUserEnvironmentVariable: async (key, value) => { state[key] = value; } } };
}
test('registry write verifies before updating the desktop environment and never waits on broadcast', async t => {
  const name = 'CFB_UNIT_ONLY_ENV', previous = process.env[name]; t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  let calls = 0;
  await writeWindowsUserEnvironment(name, 'fake-credential', {
    execFile: (exe, args, options, cb) => {
      calls++; assert.equal(exe, 'powershell.exe'); assert.equal(args.join(' ').includes('fake-credential'), false);
      assert.doesNotMatch(args.join(' '), /SetEnvironmentVariable|SendMessage/); assert.match(args.join(' '), /GetValue/);
      assert.equal(options.env.CFB_ENV_VALUE, 'fake-credential'); cb(null, 'OK');
    }, notify: () => new Promise(() => {}),
  });
  assert.equal(calls, 1); assert.equal(process.env[name], 'fake-credential');
});
test('unconfirmed registry write does not advertise an updated process credential', async t => {
  const name = 'CFB_UNIT_ONLY_ENV_FAILURE'; const previous = process.env[name]; process.env[name] = 'old';
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  await assert.rejects(writeWindowsUserEnvironment(name, 'new', { execFile: (exe, args, options, cb) => cb(new Error('test failure')), notify: () => { throw Error('not called'); } }), /保存/);
  assert.equal(process.env[name], 'old');
});
test('dotted Provider IDs round trip and can subsequently replace their key', async t => {
  const f = fixture(t);
  await addGlobalProvider({ id: 'company.api', name: 'Company', baseUrl: 'https://example.test/v1', envKey: 'COMPANY_API_KEY', apiKey: 'new' }, f.options);
  assert.equal(inspectProviderCatalog(f.dir).providers.some(p => p.id === 'company.api'), true);
  await replaceGlobalProviderKey({ id: 'company.api', apiKey: 'replacement' }, f.options);
  assert.equal(f.state.COMPANY_API_KEY, 'replacement');
});
test('add rolls back a setter that throws after committing the new value', async t => {
  const f = fixture(t), original = fs.readFileSync(path.join(f.dir, 'config.toml'), 'utf8'); let first = true;
  f.options.setUserEnvironmentVariable = async (key, value) => { f.state[key] = value; if (first) { first = false; throw Error('after commit'); } };
  await assert.rejects(addGlobalProvider({ id: 'new', baseUrl: 'https://example.test/v1', envKey: 'TEST_API_KEY', apiKey: 'new-key' }, f.options), /恢复原/);
  assert.equal(f.state.TEST_API_KEY, 'old-key'); assert.equal(fs.readFileSync(path.join(f.dir, 'config.toml'), 'utf8'), original);
});
test('key replacement rolls back a setter failure, and reports failed rollback explicitly', async t => {
  const f = fixture(t); let calls = 0;
  f.options.setUserEnvironmentVariable = async (key, value) => { calls++; f.state[key] = value; if (calls === 1) throw Error('after commit'); };
  await assert.rejects(replaceGlobalProviderKey({ id: 'existing', apiKey: 'new' }, f.options), /恢复原凭据/); assert.equal(f.state.TEST_API_KEY, 'old-key');
  f.options.setUserEnvironmentVariable = async () => { throw Error('no disk'); };
  await assert.rejects(replaceGlobalProviderKey({ id: 'existing', apiKey: 'new' }, f.options), /凭据回滚失败/);
});
test('idle reload targets only Codex users of this global variable and defers busy Bots', async t => {
  const f = fixture(t); const bots = [
    { name: 'codex', codexHome: f.dir, engine: 'codex', online: true, activeRunCount: 1 },
    { name: 'claude', codexHome: f.dir, engine: 'claude', online: true },
    { name: 'private', codexHome: f.dir, engine: 'codex', provider: { mode: 'custom', envKey: 'TEST_API_KEY' }, online: true },
  ];
  assert.deepEqual(queueCodexCredentialReload(f.dir, bots, 'TEST_API_KEY'), ['codex']);
  let stops = 0, starts = 0;
  const options = { dataRoot: f.dir, inspectBots: () => bots,
    stopBot: async () => { stops++; bots[0].online = false; return { online: false }; },
    startBot: async () => { starts++; bots[0].online = true; return { online: true }; } };
  let result = await processCodexCredentialReload(options); assert.deepEqual(result.pending, ['codex']); assert.equal(stops, 0);
  bots[0].activeRunCount = 0; result = await processCodexCredentialReload(options);
  assert.deepEqual(result.restarted, ['codex']); assert.equal(stops, 1); assert.equal(starts, 1); assert.deepEqual(readPendingCodexReload(f.dir).bots, {});
});
test('a task starting during the idle check prevents restart; a stopped Bot can recover after desktop crash', async t => {
  const f = fixture(t); const bot = { name: 'bot', engine: 'codex', codexHome: f.dir, online: true, activeRunCount: 0 };
  queueCodexCredentialReload(f.dir, [bot], 'TEST_API_KEY');
  const options = { dataRoot: f.dir, inspectBots: () => [bot], stopBot: async () => { throw Object.assign(new Error('busy'), { code: 'BOT_ACTIVE' }); }, startBot: async () => { throw Error('must not start'); } };
  assert.deepEqual((await processCodexCredentialReload(options)).pending, ['bot']);
  bot.online = false; let starts = 0; options.startBot = async () => { starts++; bot.online = true; return { online: true }; };
  await processCodexCredentialReload(options); assert.equal(starts, 1); assert.deepEqual(readPendingCodexReload(f.dir).bots, {});
});
