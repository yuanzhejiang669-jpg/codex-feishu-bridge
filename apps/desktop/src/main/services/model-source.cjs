const fs = require("node:fs");
const path = require("node:path");
const { readManagedBots } = require("./bot-setup.cjs");
const { inspectManagedBots, startManagedBot, stopManagedBot } = require("./supervisor.cjs");
const { isTrustedCodexHome, trustCodexHome } = require("./trusted-codex-homes.cjs");

const managers = new Map();

function sharedModule(options) {
  const modulePath = path.join(options.engineRoot, "src", "codex", "model-source.cjs");
  return require(modulePath);
}

function loginManager(options) {
  const key = path.resolve(options.engineRoot).toLowerCase();
  if (!managers.has(key)) managers.set(key, sharedModule(options).createLoginManager());
  return managers.get(key);
}

function bindings(options) {
  return readManagedBots(options.dataRoot).map((bot) => ({
    codexHome: bot.codexHome || options.defaultCodexHome,
    source: "desktop",
    bot: { name: bot.name, label: bot.label || bot.name, owner: "desktop" },
  }));
}

function discoveredHomes(options) {
  return sharedModule(options).discoverCodexHomes({
    globalHome: options.defaultCodexHome,
    roots: [options.codexHomeRoot],
    bindings: bindings(options),
  });
}

function requireHome(codexHome, options) {
  const shared = sharedModule(options);
  const requested = shared.canonicalPath(String(codexHome || "").trim()).toLowerCase();
  const home = discoveredHomes(options).find((item) => shared.canonicalPath(item.codexHome).toLowerCase() === requested);
  if (!home) throw new Error("Codex Home 不在当前客户端的已知范围内");
  return home;
}

function botStates(home, options) {
  const shared = sharedModule(options);
  const target = shared.canonicalPath(home.codexHome).toLowerCase();
  const inspect = options.inspectBots || inspectManagedBots;
  return inspect(options.dataRoot, options.localAppData)
    .filter((bot) => shared.canonicalPath(bot.codexHome || options.defaultCodexHome).toLowerCase() === target)
    .map((bot) => ({
      name: bot.name,
      label: bot.label || bot.name,
      online: bot.online,
      processId: bot.processId,
      activeRunCount: bot.activeRunCount,
      sessionsPath: path.join(bot.runtimeRoot, "state", "sessions.json"),
      provider: bot.provider || {},
      configPath: bot.configPath,
    }));
}

function homeEnvValue(bots, options) {
  return (name) => {
    const inherited = options.envValue?.(name);
    if (inherited) return inherited;
    if (bots.length && bots.every((bot) => (
      bot.provider?.mode === "custom"
      && bot.provider?.envKey === name
      && fs.existsSync(path.join(path.dirname(bot.configPath), "provider-secret.bin"))
    ))) return "client-encrypted";
    return "";
  };
}

async function listDesktopModelSources(options) {
  const shared = sharedModule(options);
  const homes = [];
  for (const home of discoveredHomes(options)) {
    const bots = botStates(home, options);
    const trusted = isTrustedCodexHome(home.codexHome, options.dataRoot);
    const source = shared.inspectCodexHome(home.codexHome, { envValue: homeEnvValue(bots, options) });
    homes.push({
      ...source,
      label: path.resolve(home.codexHome).toLowerCase() === path.resolve(options.defaultCodexHome).toLowerCase()
        ? "全局配置"
        : path.basename(home.codexHome),
      sources: home.sources,
      bots,
      trusted,
      manageable: trusted || bots.length > 0,
      login: await shared.inspectLogin(options.codexPath, home.codexHome),
      loginJob: loginManager(options).get(home.codexHome),
      sessionOverrideCount: shared.inspectSessionOverrides(bots.map((item) => item.sessionsPath)).overrideCount,
    });
  }
  return { codexPath: options.codexPath, homes };
}

function startDesktopOpenAiLogin(codexHome, options) {
  const home = requireHome(codexHome, options);
  if (!botStates(home, options).length && !isTrustedCodexHome(home.codexHome, options.dataRoot)) {
    throw new Error("该 Codex Home 尚未纳入客户端管理，在本客户端中只读");
  }
  return loginManager(options).start(options.codexPath, home.codexHome);
}

function trustDesktopCodexHome(codexHome, options) {
  const home = requireHome(codexHome, options);
  return trustCodexHome(home.codexHome, { dataRoot: options.dataRoot, discoveredHomes: discoveredHomes(options) });
}

async function previewDesktopModelSourceSwitch(raw, options) {
  const shared = sharedModule(options);
  const home = requireHome(raw.codexHome, options);
  const bots = botStates(home, options);
  const trusted = isTrustedCodexHome(home.codexHome, options.dataRoot);
  const preview = shared.previewModelSourceSwitch(home.codexHome, raw.targetProvider, { envValue: homeEnvValue(bots, options) });
  const login = await shared.inspectLogin(options.codexPath, home.codexHome);
  return {
    ...preview,
    login,
    bots,
    sessionOverrideCount: shared.inspectSessionOverrides(bots.map((item) => item.sessionsPath)).overrideCount,
    blockers: [
      ...(!bots.length && !trusted ? ["该 Codex Home 尚未纳入客户端管理，在本客户端中只读"] : []),
      ...(preview.targetProvider === "openai" && login.state !== "signed-in" ? ["该 Codex Home 尚未完成 OpenAI 官方登录"] : []),
      ...bots.filter((item) => item.activeRunCount > 0).map((item) => `${item.label} 有 ${item.activeRunCount} 个活动任务`),
    ],
  };
}

async function applyDesktopModelSourceSwitch(raw, options) {
  const shared = sharedModule(options);
  const preview = await previewDesktopModelSourceSwitch(raw, options);
  if (raw.confirm !== `切换到 ${preview.targetProvider}`) throw new Error(`确认文本不匹配，请输入：切换到 ${preview.targetProvider}`);
  if (preview.blockers.length) throw new Error(preview.blockers.join("；"));
  if (!preview.changed && preview.sessionOverrideCount === 0) return { ...preview, applied: false, restarted: [] };
  const stopped = [];
  let sourceWrite = null;
  let sessionWrite = null;
  try {
    for (const bot of preview.bots.filter((item) => item.online)) {
      await (options.stopBot || stopManagedBot)(bot.name, options.supervisorOptions);
      stopped.push(bot);
    }
    sourceWrite = shared.applyModelSourceSwitch(preview.codexHome, preview.targetProvider, {
      envValue: homeEnvValue(preview.bots, options),
    });
    sessionWrite = shared.clearSessionOverrides(preview.bots.map((item) => item.sessionsPath));
    const restarted = [];
    for (const bot of stopped) restarted.push(await (options.startBot || startManagedBot)(bot.name, options.supervisorOptions));
    return { ...preview, applied: sourceWrite.applied || sessionWrite.changed > 0, clearedSessionOverrides: sessionWrite.changed, restarted };
  } catch (error) {
    try { shared.restoreSessionOverrides(sessionWrite); } catch {}
    try { shared.restoreModelSourceSwitch(sourceWrite); } catch {}
    for (const bot of stopped) {
      try { await (options.startBot || startManagedBot)(bot.name, options.supervisorOptions); } catch {}
    }
    throw new Error(`模型来源切换失败：${error.message}；配置与会话覆盖已尝试回滚`);
  }
}

module.exports = {
  applyDesktopModelSourceSwitch,
  listDesktopModelSources,
  previewDesktopModelSourceSwitch,
  startDesktopOpenAiLogin,
  trustDesktopCodexHome,
};
