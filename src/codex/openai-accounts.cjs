const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

function accountsRoot(defaultHome = path.join(os.homedir(), ".codex")) {
  return path.resolve(process.env.CODEX_FEISHU_OPENAI_ACCOUNTS_ROOT || path.join(defaultHome, "bridge-openai-accounts"));
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); }
  catch (error) { if (error.code === "ENOENT") return null; throw new Error("账号存储损坏，请重新登录该账号"); }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function jwtClaims(token) {
  try { return JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8")); } catch { return {}; }
}
function authIdentity(auth) {
  const tokens = auth?.tokens;
  if (!tokens?.access_token || !tokens?.id_token) throw new Error("没有可保存的 ChatGPT 登录，请在客户端添加账号");
  const claims = jwtClaims(tokens.id_token);
  const access = jwtClaims(tokens.access_token);
  const info = claims["https://api.openai.com/auth"] || access["https://api.openai.com/auth"] || {};
  const email = String(claims.email || access["https://api.openai.com/profile"]?.email || "").trim().toLowerCase();
  const accountId = String(tokens.account_id || info.chatgpt_account_id || "");
  const subject = String(claims.sub || "");
  if (!accountId || !subject) throw new Error("无法确认 ChatGPT 账号身份，请重新登录");
  if (email && (!/^[^\s@`<>]+@[^\s@`<>]+\.[^\s@`<>]+$/.test(email) || email.length > 254)) throw new Error("登录邮箱格式无效");
  const key = crypto.createHash("sha256").update(`${subject}\0${accountId}`).digest("hex");
  return { key, email, accountId, subject, planType: info.chatgpt_plan_type || null };
}
function records(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
    .map((entry) => {
      const record = readJson(path.join(root, entry.name, "account.json"));
      if (!record) return null;
      if (record.key !== entry.name || !/^openai-[^\s`<>/\\]+$/.test(record.alias || "")) throw new Error("账号索引损坏");
      return record;
    }).filter(Boolean);
}
function accountRecord(root, alias) {
  const matches = records(root).filter((item) => !item.removed && item.alias === alias);
  if (matches.length !== 1) throw new Error(`账号不存在或已移除：${alias}；请在客户端重新登录`);
  return matches[0];
}
function readAccountAuth(root, alias) {
  const record = accountRecord(root, alias);
  const auth = readJson(path.join(record.authHome, "auth.json"));
  const identity = authIdentity(auth);
  if (identity.key !== record.key) throw new Error(`账号登录已变化：${alias}；请重新登录原账号，已拒绝使用其他账号`);
  return { record, auth, identity };
}
function listAccounts(root) {
  return records(root).filter((record) => !record.removed).map((record) => {
    let state = "saved";
    try { readAccountAuth(root, record.alias); } catch { state = "reauth-required"; }
    return { alias: record.alias, email: record.email, planType: record.planType, state, owned: record.owned === true };
  }).sort((a, b) => a.alias.localeCompare(b.alias));
}
async function withAccountLock(root, key, fn, options = {}) {
  const directory = path.join(root, key);
  const lock = path.join(directory, "refresh.lock");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + (options.lockTimeoutMs || 8_000);
  let acquired = false;
  while (!acquired) {
    try {
      const fd = fs.openSync(lock, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.closeSync(fd);
      acquired = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner;
      try { owner = JSON.parse(fs.readFileSync(lock, "utf8")); } catch {}
      let alive = true;
      if (owner?.pid) { try { process.kill(owner.pid, 0); } catch (error) { alive = error.code !== "ESRCH"; } }
      let stale = !alive;
      if (!owner) {
        try { stale = Date.now() - fs.statSync(lock).mtimeMs > 30_000; }
        catch (error) { if (error.code === "ENOENT") continue; throw error; }
      }
      if (stale) {
        try { fs.unlinkSync(lock); } catch {};
        continue;
      }
      if (Date.now() >= deadline) throw new Error("账号正在刷新或重新登录，请稍后重试");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try { return await fn(); } finally { fs.rmSync(lock, { force: true }); }
}
async function saveAccount(root, authHome, { owned = false, expectedAlias = "" } = {}) {
  const auth = readJson(path.join(authHome, "auth.json"));
  const identity = authIdentity(auth);
  if (expectedAlias && accountRecord(root, expectedAlias).key !== identity.key) throw new Error("登录了不同账号；原账号未被覆盖，请使用添加账号");
  return withAccountLock(root, "catalog", () => withAccountLock(root, identity.key, async () => {
    const existing = records(root).find((item) => item.key === identity.key);
    const baseAlias = `openai-${identity.email || `account-${identity.key.slice(0, 12)}`}`;
    const alias = existing?.alias || (records(root).some((item) => item.alias === baseAlias) ? `${baseAlias}--${identity.key.slice(0, 12)}` : baseAlias);
    const targetHome = owned ? path.join(root, identity.key, "home") : path.resolve(authHome);
    if (owned) {
      writeJson(path.join(targetHome, "auth.json"), auth);
      fs.writeFileSync(path.join(targetHome, "config.toml"), 'model_provider = "openai"\ncli_auth_credentials_store = "file"\n');
    }
    const record = { ...identity, alias, authHome: targetHome, owned, removed: false, savedAt: new Date().toISOString() };
    writeJson(path.join(root, identity.key, "account.json"), record);
    return listAccounts(root).find((item) => item.alias === alias);
  }));
}
async function discoverAccount(root, home) {
  let identity;
  try { identity = authIdentity(readJson(path.join(home, "auth.json"))); } catch { return; }
  if (!records(root).some((record) => record.key === identity.key)) await saveAccount(root, home);
}
async function removeAccount(root, alias) {
  const record = accountRecord(root, alias);
  return withAccountLock(root, record.key, async () => {
    // Keep the alias reserved so a stored conversation can never silently select a new identity.
    writeJson(path.join(root, record.key, "account.json"), { ...record, removed: true });
    if (record.owned) fs.rmSync(path.join(record.authHome, "auth.json"), { force: true });
    return { removed: true, alias };
  });
}
function loginStagingHome(root) {
  const home = path.join(root, "pending", crypto.randomUUID());
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, "config.toml"), 'model_provider = "openai"\ncli_auth_credentials_store = "file"\n');
  return home;
}
async function refreshWithCodex(codexPath, home) {
  const deadline = Date.now() + 7_000;
  const { AppServerClient } = await import("./app-server-client.mjs");
  const client = new AppServerClient({ tool: { command: codexPath, argsPrefix: ["-c", 'cli_auth_credentials_store="file"', "-c", 'model_provider="openai"'] }, codexHome: home, workspace: home,
    environment: { OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined, CODEX_ACCESS_TOKEN: undefined } }).start();
  try {
    await client.request("initialize", { clientInfo: { name: "bridge-account-refresh", version: "1" }, capabilities: { experimentalApi: true } }, 3_000);
    client.notify("initialized");
    const result = await client.request("account/read", { refreshToken: true }, Math.max(1, deadline - Date.now()));
    if (result?.account?.type !== "chatgpt") throw new Error("需要重新登录");
  } finally { await client.stop(); }
}
async function accountTokens(root, alias, { codexPath, force = false, previousToken = "", refresh = refreshWithCodex } = {}) {
  const initial = accountRecord(root, alias);
  return withAccountLock(root, initial.key, async () => {
    let current = readAccountAuth(root, alias);
    const expires = Number(jwtClaims(current.auth.tokens.access_token).exp || 0) * 1000;
    const needsRefresh = expires < Date.now() + 120_000 || (force && current.auth.tokens.access_token === previousToken);
    if (needsRefresh) {
      try { await refresh(codexPath, current.record.authHome); }
      catch { throw new Error(`账号 ${alias} 刷新失败，请在客户端重新登录；未切换其他账号`); }
      current = readAccountAuth(root, alias);
    }
    return { accessToken: current.auth.tokens.access_token, chatgptAccountId: current.identity.accountId, chatgptPlanType: current.identity.planType };
  }, { lockTimeoutMs: force ? 1_000 : 8_000 });
}
function defaultAccount(home) {
  return readJson(path.join(home, "bridge-openai-default.json"))?.alias || "";
}
function setDefaultAccount(home, alias) {
  writeJson(path.join(home, "bridge-openai-default.json"), { alias: String(alias || "") });
}

module.exports = { accountsRoot, authIdentity, jwtClaims, listAccounts, accountRecord, readAccountAuth, saveAccount, discoverAccount, removeAccount, loginStagingHome, accountTokens, defaultAccount, setDefaultAccount, withAccountLock };
