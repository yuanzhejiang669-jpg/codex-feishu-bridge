const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { readManagedBots } = require("./bot-setup.cjs");
const { inspectManagedBots, startManagedBot, stopManagedBot } = require("./supervisor.cjs");
const jobs = new Map();
const pendingSettlements = new Map();
const bindingChanges = new Set();
function store(options) { return require(path.join(options.engineRoot, "src", "codex", "openai-accounts.cjs")); }
function root(options) { return store(options).accountsRoot(options.defaultCodexHome); }
function publicJob(job) { return job ? { status: job.status, alias: job.alias, error: job.error || "", expiresAt: job.expiresAt } : null; }
function settlePending(options) {
  const key = root(options);
  if (pendingSettlements.has(key)) return pendingSettlements.get(key);
  const pending = settlePendingOnce(options).finally(() => pendingSettlements.delete(key));
  pendingSettlements.set(key, pending);
  return pending;
}
async function settlePendingOnce(options) {
  const accounts = store(options);
  const pending = path.join(root(options), "pending");
  if (!fs.existsSync(pending)) return;
  for (const entry of fs.readdirSync(pending, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
    const home = path.join(pending, entry.name);
    let request;
    try { request = JSON.parse(fs.readFileSync(path.join(home, "request.json"), "utf8")); } catch { continue; }
    const job = jobs.get(root(options));
    // A successful OAuth callback may write auth.json just before its process exits.
    if (job?.home === home && job.status === "running") continue;
    if (!fs.existsSync(path.join(home, "auth.json"))) {
      // An interrupted or cancelled login must not leave pending files forever.
      if (Date.now() - fs.statSync(path.join(home, "request.json")).mtimeMs > 600_000) fs.rmSync(home, { recursive: true, force: true });
      continue;
    }
    try {
      const account = await accounts.saveAccount(root(options), home, { owned: true, expectedAlias: request.alias || "" });
      if (job?.home === home) { job.status = "completed"; job.alias = account.alias; }
    } catch (error) {
      if (job?.home === home) { job.status = "failed"; job.error = error.message; }
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}
async function accountState(options, homes = []) {
  const accounts = store(options);
  await settlePending(options);
  for (const home of homes) if (home.manageable) await accounts.discoverAccount(root(options), home.codexHome);
  const bots = readManagedBots(options.dataRoot);
  return {
    accounts: accounts.listAccounts(root(options)),
    accountLoginJob: publicJob(jobs.get(root(options))),
    accountBots: bots.map((bot) => ({ name: bot.name, label: bot.label || bot.name, accountAlias: bot.openaiAccount || "" })),
  };
}
function startAccountLogin(input = {}, options) {
  const accounts = store(options);
  const current = jobs.get(root(options));
  if (current?.status === "running" || current?.status === "finishing") throw new Error("已有账号正在登录，请先完成该登录");
  if (!fs.existsSync(options.codexPath)) throw new Error("Codex 运行时不可用");
  if (input.alias) accounts.accountRecord(root(options), input.alias);
  const home = accounts.loginStagingHome(root(options));
  fs.writeFileSync(path.join(home, "request.json"), JSON.stringify({ alias: input.alias || "" }));
  const child = (options.spawn || spawn)(options.codexPath, ["-c", 'cli_auth_credentials_store="file"', "login"], {
    windowsHide: true, stdio: "ignore", env: { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined, CODEX_ACCESS_TOKEN: undefined },
  });
  const job = { home, alias: input.alias || "", status: "running", expiresAt: new Date(Date.now() + 600_000).toISOString() };
  jobs.set(root(options), job);
  const timer = setTimeout(() => {
    if (job.status !== "running") return;
    job.status = "timed-out"; try { child.kill(); } catch {}
  }, 600_000);
  timer.unref?.();
  child.once("error", () => { clearTimeout(timer); job.status = "failed"; job.error = "无法启动官方登录"; fs.rmSync(home, { recursive: true, force: true }); });
  child.once("exit", async (code) => {
    clearTimeout(timer);
    if (job.status === "running") job.status = code === 0 ? "finishing" : "failed";
    if (job.status === "finishing") {
      try { await settlePending(options); } catch { job.status = "failed"; job.error = "保存账号失败，请重试"; }
    } else { fs.rmSync(home, { recursive: true, force: true }); }
  });
  child.unref?.();
  return publicJob(job);
}
async function setBotAccount(input, options) {
  const key = `${path.resolve(options.dataRoot)}\0${input.name}`;
  if (bindingChanges.has(key)) throw new Error("该 Bot 正在切换账号，请稍后重试");
  bindingChanges.add(key);
  try { return await setBotAccountOnce(input, options); }
  finally { bindingChanges.delete(key); }
}
async function setBotAccountOnce(input, options) {
  const accounts = store(options);
  const bot = readManagedBots(options.dataRoot).find((item) => item.name === input.name);
  if (!bot) throw new Error("找不到客户端 Bot");
  const alias = String(input.alias || "");
  if (alias) accounts.readAccountAuth(root(options), alias);
  const state = (options.inspectBots || inspectManagedBots)(options.dataRoot, options.localAppData).find((item) => item.name === bot.name);
  if (state?.activeRunCount > 0) throw new Error("Bot 正在执行任务，请结束后再切换账号");
  const original = fs.readFileSync(bot.configPath, "utf8");
  const stop = options.stopBot || stopManagedBot;
  const start = options.startBot || startManagedBot;
  let stopped = false;
  let written = false;
  try {
    if (state?.online) { await stop(bot.name, options.supervisorOptions); stopped = true; }
    if (fs.readFileSync(bot.configPath, "utf8") !== original) throw new Error("Bot 配置已被其他操作修改，请刷新后重试");
    const config = JSON.parse(original);
    config.openaiAccount = alias;
    const temporary = `${bot.configPath}.account.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`);
    fs.renameSync(temporary, bot.configPath);
    written = true;
    if (stopped) await start(bot.name, options.supervisorOptions);
    return { name: bot.name, alias, restarted: stopped };
  } catch (error) {
    if (written) fs.writeFileSync(bot.configPath, original);
    if (stopped) { try { await start(bot.name, options.supervisorOptions); } catch {} }
    throw error;
  }
}
async function forgetAccount(input, options) {
  const accounts = store(options);
  const bots = readManagedBots(options.dataRoot);
  // Existing session selections are retained and fail closed if their account is removed.
  if (bots.some((bot) => bot.openaiAccount === input.alias)) throw new Error("请先解除使用该账号的 Bot 默认绑定");
  return accounts.removeAccount(root(options), input.alias);
}
module.exports = { accountState, startAccountLogin, setBotAccount, forgetAccount };
