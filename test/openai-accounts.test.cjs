const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const accounts = require("../src/codex/openai-accounts.cjs");
function token(claims) { return `test.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.test`; }
function auth(email, accountId = email, exp = Math.floor(Date.now() / 1000) + 3600) {
  return { tokens: { id_token: token({ email, sub: email, "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } }), access_token: token({ exp }), refresh_token: "fixture-refresh", account_id: accountId } };
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-accounts-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "accounts");
  const home = (name, data) => {
    const destination = path.join(directory, name); fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, "auth.json"), JSON.stringify(data)); return destination;
  };
  return { directory, root, home };
}
test("multiple saved accounts retain credentials, stable aliases, and distinct workspaces", async (t) => {
  const { root, home } = fixture(t);
  const a = await accounts.saveAccount(root, home("a", auth("a@example.com")), { owned: true });
  const b = await accounts.saveAccount(root, home("b", auth("b@example.com")), { owned: true });
  const a2 = await accounts.saveAccount(root, home("a2", auth("a@example.com", "workspace-2")), { owned: true });
  assert.equal(a.alias, "openai-a@example.com"); assert.equal(b.alias, "openai-b@example.com");
  assert.match(a2.alias, /^openai-a@example.com--/);
  assert.equal(accounts.listAccounts(root).length, 3);
  assert.equal(JSON.stringify(accounts.listAccounts(root)).includes("fixture-refresh"), false);
  await assert.rejects(accounts.saveAccount(root, home("wrong", auth("wrong@example.com")), { owned: true, expectedAlias: a.alias }), /不同账号/);
  assert.equal(accounts.readAccountAuth(root, a.alias).identity.email, "a@example.com");
});
test("source login replacement, missing credentials and removed selections fail closed", async (t) => {
  const { root, home } = fixture(t);
  const original = home("native", auth("a@example.com"));
  const a = await accounts.saveAccount(root, original);
  fs.writeFileSync(path.join(original, "auth.json"), JSON.stringify(auth("b@example.com")));
  assert.throws(() => accounts.readAccountAuth(root, a.alias), /已拒绝使用其他账号/);
  assert.equal(accounts.listAccounts(root)[0].state, "reauth-required");
  await accounts.removeAccount(root, a.alias);
  await accounts.discoverAccount(root, original);
  assert.equal(accounts.listAccounts(root).some((item) => item.alias === a.alias), false);
  assert.throws(() => accounts.readAccountAuth(root, a.alias), /已移除/);
  assert.ok(fs.existsSync(path.join(original, "auth.json")), "removing a reference must not log out the original CLI");
});
test("concurrent processes' refresh requests share a lock and re-read rotated credentials", async (t) => {
  const { root, home } = fixture(t);
  const initial = auth("a@example.com", "workspace", 1);
  const a = await accounts.saveAccount(root, home("a", initial), { owned: true });
  let refreshes = 0;
  const refresh = async (_codex, destination) => {
    refreshes++; await new Promise((resolve) => setTimeout(resolve, 75));
    fs.writeFileSync(path.join(destination, "auth.json"), JSON.stringify(auth("a@example.com", "workspace")));
  };
  const results = await Promise.all(Array.from({ length: 4 }, () => accounts.accountTokens(root, a.alias, { refresh, force: true, previousToken: initial.tokens.access_token })));
  assert.equal(refreshes, 1); assert.ok(results.every((item) => item.accessToken === results[0].accessToken));
  await assert.rejects(accounts.accountTokens(root, a.alias, { refresh: async () => { throw new Error("secret fixture-refresh"); }, force: true, previousToken: results[0].accessToken }), /刷新失败/);
});
test("interrupted refresh lock is recoverable and same-email concurrent saves stay unambiguous", async (t) => {
  const { root, home } = fixture(t);
  const results = await Promise.all(["one", "two"].map((id) => accounts.saveAccount(root, home(id, auth("a@example.com", id)), { owned: true })));
  assert.equal(new Set(results.map((item) => item.alias)).size, 2);
  const record = accounts.accountRecord(root, results[0].alias);
  fs.writeFileSync(path.join(root, record.key, "refresh.lock"), '{"pid":2147483647}');
  assert.ok((await accounts.accountTokens(root, record.alias)).accessToken);
});
test("app-server pool never reuses a process across account identities, including queued requests", async () => {
  const { createAppServerPool } = await import("../src/codex/app-server-pool.mjs");
  const created = [];
  const pool = createAppServerPool({ createClient: (options) => { const client = { alias: options.accountAlias || "", stop: async () => {}, closed: false }; created.push(client); return client; }, maxSize: 1 });
  try {
    const a = await pool.acquire({ accountAlias: "a" });
    const pendingB = pool.acquire({ accountAlias: "b" });
    await a.release(); const b = await pendingB;
    assert.notEqual(a.client, b.client); assert.equal(b.client.alias, "b");
    await b.release(); const native = await pool.acquire();
    assert.notEqual(native.client, b.client); assert.equal(native.client.alias, ""); await native.release();
    assert.equal(created.length, 3);
  } finally { await pool.closeAll(); }
});
test("account refresh callback replies asynchronously and never includes underlying secret errors", async () => {
  const { AppServerClient } = await import("../src/codex/app-server-client.mjs");
  const replies = [];
  const client = new AppServerClient({ tool: { command: "fixture" }, refreshAccountTokens: async (params) => {
    assert.equal(params.previousToken, "old"); return { accessToken: "new", chatgptAccountId: "account" };
  } });
  client.currentAccountToken = "old"; client.write = (value) => replies.push(value);
  client.respondToServerRequest({ id: 1, method: "account/chatgptAuthTokens/refresh", params: {} });
  await new Promise(setImmediate);
  assert.equal(replies[0].result.accessToken, "new"); assert.equal(client.currentAccountToken, "new");
  client.refreshAccountTokens = async () => { throw new Error("fixture-refresh secret"); };
  client.respondToServerRequest({ id: 2, method: "account/chatgptAuthTokens/refresh" });
  await new Promise(setImmediate);
  assert.equal(JSON.stringify(replies[1]).includes("fixture-refresh"), false); assert.ok(replies[1].error);
});
function sourceFunction(name) {
  const source = fs.readFileSync(path.join(__dirname, "..", "codex-feishu-bridge.mjs"), "utf8");
  const begin = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  const end = source.slice(begin + 1).search(/\n(?:async )?function \w+\(/);
  return source.slice(begin, end < 0 ? undefined : begin + 1 + end);
}
test("real /provider handler persists account selection independently in two conversations", async (t) => {
  const { root, home } = fixture(t);
  const a = await accounts.saveAccount(root, home("a", auth("a@example.com")), { owned: true });
  const b = await accounts.saveAccount(root, home("b", auth("b@example.com")), { owned: true });
  const sessions = { one: { id: "one" }, two: { id: "two" } }; const sent = []; const writes = [];
  const context = { openaiAccounts: { ...accounts, accountsRoot: () => root }, CONFIG: { codexHome: home("default", auth("native@example.com")) },
    syncChatSessionsWithCodex: async () => {}, getSession: (id) => sessions[id], commandArgs: (text) => text.trim().split(/\s+/), activeCodexJobs: new Map(),
    clearProviderBundleOverride: () => {}, setSessionOverride: (session, key, value) => { session[key] = value; }, saveSessions: () => {},
    providerStatusMarkdown: (session) => session.openaiAccountOverride, sendMarkdown: async (...args) => sent.push(args), sendText: async (...args) => sent.push(args),
    writeCodexConfigValue: async (...args) => writes.push(args), findProviderBundle: () => null, findCodexProvider: () => null,
    runtimeCommandErrorMarkdown: (_title, error) => error.message };
  const handler = vm.runInNewContext(`(${sourceFunction("handleProviderCommand")})`, context);
  await handler("one", a.alias, "m1"); await handler("two", b.alias, "m2");
  assert.equal(sessions.one.openaiAccountOverride, a.alias); assert.equal(sessions.two.openaiAccountOverride, b.alias); assert.equal(writes.length, 0);
  context.activeCodexJobs.set("one", {}); await handler("one", b.alias, "m3");
  assert.equal(sessions.one.openaiAccountOverride, a.alias); assert.match(sent.at(-1)[1], /任务结束后/);
  context.activeCodexJobs.clear(); await handler("one", `save ${a.alias}`, "m4");
  assert.deepEqual(writes[0], ["model_provider", "openai"]); assert.equal(accounts.defaultAccount(context.CONFIG.codexHome), a.alias);
});

test("warm process validates removal and rotates injected tokens before its next turn", async (t) => {
  const { root, home } = fixture(t);
  const a = await accounts.saveAccount(root, home("a", auth("a@example.com")), { owned: true });
  const context = { openaiAccounts: { ...accounts, accountsRoot: () => root }, CONFIG: { codexCli: { command: "fixture" } } };
  const synchronize = vm.runInNewContext(`(${sourceFunction("synchronizeAppServerAccount")})`, context);
  const calls = []; const client = { accountAlias: a.alias, request: async (...args) => calls.push(args) };
  await synchronize(client); await synchronize(client); assert.equal(calls.length, 1);
  const rotated = auth("a@example.com", "a@example.com", Math.floor(Date.now()/1000)+7200);
  fs.writeFileSync(path.join(accounts.accountRecord(root, a.alias).authHome, "auth.json"), JSON.stringify(rotated));
  await synchronize(client); assert.equal(calls.length, 2); assert.equal(client.currentAccountToken, rotated.tokens.access_token);
  await accounts.removeAccount(root, a.alias);
  await assert.rejects(synchronize(client), /已移除/); assert.equal(calls.length, 2);
  assert.match(sourceFunction("runCodexAppServer"), /initialization\.warm\) await synchronizeAppServerAccount\(client\)/);
});

test("session account survives normalization and prevents exec fallback", () => {
  const normalize = vm.runInNewContext(`(${sourceFunction("normalizeSessionData")})`, {
    cleanOverride: (value) => String(value || "").trim(), crypto: require("node:crypto"), Date,
    normalizeTokenUsage: () => null, normalizeContextUsage: () => null, normalizeThreadHealth: () => null,
    normalizeGoal: () => null, normalizeFailure: () => null,
  });
  const saved = JSON.parse(JSON.stringify(normalize({ id: "one", codexThreadId: "thread", openaiAccountOverride: "openai-a@example.com", providerOverride: "openai" })));
  const reloaded = normalize(saved);
  assert.equal(reloaded.openaiAccountOverride, "openai-a@example.com"); assert.equal(reloaded.codexThreadId, "thread");
  assert.match(sourceFunction("runCodex"), /const canFallback = !selectedAccount/);
});

test("separate Node processes serialize refresh-token rotation on disk", async (t) => {
  const { root, home, directory } = fixture(t);
  const initial = auth("a@example.com", "workspace", 1);
  const a = await accounts.saveAccount(root, home("a", initial), { owned: true });
  const next = auth("a@example.com", "workspace"); const countFile = path.join(directory, "refresh-count.txt");
  const worker = `const fs=require('node:fs'); const accounts=require(${JSON.stringify(require.resolve('../src/codex/openai-accounts.cjs'))});
    accounts.accountTokens(${JSON.stringify(root)},${JSON.stringify(a.alias)},{force:true,previousToken:${JSON.stringify(initial.tokens.access_token)},
      refresh:async(_codex,home)=>{fs.appendFileSync(${JSON.stringify(countFile)},'refresh\\n');await new Promise(r=>setTimeout(r,100));fs.writeFileSync(require('node:path').join(home,'auth.json'),${JSON.stringify(JSON.stringify(next))});}
    }).catch(()=>{process.exitCode=1});`;
  const { execFile } = require('node:child_process');
  await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => execFile(process.execPath, ['-e', worker], { windowsHide: true }, (error) => error ? reject(error) : resolve()))));
  assert.equal(fs.readFileSync(countFile, 'utf8'), 'refresh\n');
});
