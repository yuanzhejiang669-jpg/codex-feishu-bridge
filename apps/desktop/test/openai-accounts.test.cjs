const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const service = require("../src/main/services/openai-accounts.cjs");
const accounts = require("../../../src/codex/openai-accounts.cjs");
// Bridge subprocesses inherit this override; fixtures must never use the live account store.
const inheritedAccountRoot = process.env.CODEX_FEISHU_OPENAI_ACCOUNTS_ROOT;
delete process.env.CODEX_FEISHU_OPENAI_ACCOUNTS_ROOT;
test.after(() => {
  if (inheritedAccountRoot === undefined) delete process.env.CODEX_FEISHU_OPENAI_ACCOUNTS_ROOT;
  else process.env.CODEX_FEISHU_OPENAI_ACCOUNTS_ROOT = inheritedAccountRoot;
});
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-account-ui-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const options = { engineRoot: path.resolve(__dirname, "../../.."), dataRoot: path.join(directory, "data"), localAppData: directory,
    defaultCodexHome: path.join(directory, "home"), codexPath: process.execPath, supervisorOptions: {} };
  const botPath = path.join(options.dataRoot, "managed-bots", "one", "bot.json");
  fs.mkdirSync(path.dirname(botPath), { recursive: true }); fs.writeFileSync(botPath, '{"name":"one","label":"机器人","provider":{"mode":"current"}}');
  const token = (data) => `test.${Buffer.from(JSON.stringify(data)).toString("base64url")}.test`;
  const loginAuth = (home, email) => fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ tokens: {
    id_token: token({ email, sub: email }), access_token: token({ exp: Math.floor(Date.now()/1000)+3600 }), account_id: email, refresh_token: "secret" } }));
  return { options, botPath, loginAuth, root: accounts.accountsRoot(options.defaultCodexHome) };
}
test("adding accounts preserves prior logins, saves email labels, and never exposes credentials to renderer", async (t) => {
  const { options, loginAuth } = fixture(t); let child; let loginHome;
  options.spawn = (_command, args, config) => { assert.deepEqual(args.slice(-1), ["login"]); loginHome = config.env.CODEX_HOME; child = new EventEmitter(); child.unref = () => {}; return child; };
  service.startAccountLogin({}, options); loginAuth(loginHome, "a@example.com"); child.emit("exit", 0);
  await new Promise(setImmediate);
  const first = await service.accountState(options);
  assert.equal(first.accounts[0].alias, "openai-a@example.com"); assert.equal(first.accountLoginJob.status, "completed");
  service.startAccountLogin({}, options); loginAuth(loginHome, "b@example.com"); child.emit("exit", 0); await new Promise(setImmediate);
  const second = await service.accountState(options); assert.equal(second.accounts.length, 2); assert.equal(JSON.stringify(second).includes('"secret"'), false);
  service.startAccountLogin({ alias: first.accounts[0].alias }, options); loginAuth(loginHome, "wrong@example.com"); child.emit("exit", 0); await new Promise(setImmediate);
  const wrong = await service.accountState(options); assert.equal(wrong.accountLoginJob.status, "failed"); assert.equal(wrong.accounts.length, 2);
});
test("binding refuses active work and restores bot configuration if restart fails", async (t) => {
  const { options, root, botPath, loginAuth } = fixture(t);
  const staging = accounts.loginStagingHome(root); loginAuth(staging, "a@example.com"); const a = await accounts.saveAccount(root, staging, { owned: true });
  let stops = 0; options.stopBot = async () => { stops++; }; options.startBot = async () => { throw new Error("fixture restart failed"); };
  options.inspectBots = () => [{ name: "one", online: true, activeRunCount: 1 }];
  await assert.rejects(service.setBotAccount({ name: "one", alias: a.alias }, options), /正在执行/); assert.equal(stops, 0);
  options.inspectBots = () => [{ name: "one", online: true, activeRunCount: 0 }]; const original = fs.readFileSync(botPath, "utf8");
  await assert.rejects(service.setBotAccount({ name: "one", alias: a.alias }, options), /restart failed/); assert.equal(fs.readFileSync(botPath, "utf8"), original);
  options.startBot = async () => {}; await service.setBotAccount({ name: "one", alias: a.alias }, options);
  assert.equal(JSON.parse(fs.readFileSync(botPath, "utf8")).openaiAccount, a.alias);
  await assert.rejects(service.forgetAccount({ alias: a.alias }, options), /解除/);
});

test("a completed login is recovered after restart and simultaneous refreshes import it once", async (t) => {
  const { options, root, loginAuth } = fixture(t);
  const home = accounts.loginStagingHome(root);
  fs.writeFileSync(path.join(home, "request.json"), '{}'); loginAuth(home, "recovered@example.com");
  const states = await Promise.all(Array.from({ length: 5 }, () => service.accountState(options)));
  assert.ok(states.every((state) => state.accounts.length === 1)); assert.equal(fs.existsSync(home), false);
  const abandoned = accounts.loginStagingHome(root); const request = path.join(abandoned, "request.json");
  fs.writeFileSync(request, '{}'); fs.utimesSync(request, new Date(0), new Date(0));
  await service.accountState(options); assert.equal(fs.existsSync(abandoned), false);
  const renderer = fs.readFileSync(path.join(__dirname, "../src/renderer/app.js"), "utf8");
  assert.match(renderer, /\["running", "finishing"\]\.includes\(modelSources\.accountLoginJob\?\.status\)/);
});

test("overlapping bindings and externally changed bot files cannot overwrite each other", async (t) => {
  const { options, botPath } = fixture(t);
  let release;
  options.inspectBots = () => [{ name: "one", online: true, activeRunCount: 0 }];
  options.stopBot = () => new Promise((resolve) => { release = resolve; }); options.startBot = async () => {};
  const first = service.setBotAccount({ name: "one", alias: "" }, options);
  await assert.rejects(service.setBotAccount({ name: "one", alias: "" }, options), /正在切换/);
  const changed = '{"name":"one","label":"externally changed","provider":{"mode":"current"}}';
  fs.writeFileSync(botPath, changed); release(); await assert.rejects(first, /其他操作修改/);
  assert.equal(fs.readFileSync(botPath, "utf8"), changed);
});
