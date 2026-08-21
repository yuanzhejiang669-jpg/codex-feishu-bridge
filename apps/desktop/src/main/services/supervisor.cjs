const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { activeRunCount, isProcessAlive, readJson } = require("./bridge-discovery.cjs");
const { readManagedBots } = require("./bot-setup.cjs");
const { inspectProviderCatalog } = require("./provider-manager.cjs");

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;

function managedRuntimeRoot(localAppData, name) {
  return path.join(localAppData, "CodexFeishuBridge", "instances", name);
}

function inspectManagedBots(dataRoot, localAppData) {
  return readManagedBots(dataRoot).map((bot) => {
    const runtimeRoot = managedRuntimeRoot(localAppData, bot.name);
    const stateDir = path.join(runtimeRoot, "state");
    const processIdText = (() => {
      try { return fs.readFileSync(path.join(stateDir, "bridge.pid"), "utf8").trim(); } catch { return ""; }
    })();
    const processId = /^\d+$/.test(processIdText) ? Number(processIdText) : null;
    const active = readJson(path.join(stateDir, "active-runs.json"));
    const seenEventsPath = path.join(stateDir, "seen-events.json");
    const seenEvents = readJson(seenEventsPath);
    const messageEventVerified = Array.isArray(seenEvents) && seenEvents.length > 0;
    let messageEventVerifiedAt = "";
    if (messageEventVerified) {
      try { messageEventVerifiedAt = fs.statSync(seenEventsPath).mtime.toISOString(); } catch {}
    }
    return {
      ...bot,
      runtimeRoot,
      processId,
      online: isProcessAlive(processId),
      activeRunCount: activeRunCount(active),
      messageEventVerified,
      messageEventVerifiedAt,
      messageEventCount: Array.isArray(seenEvents) ? seenEvents.length : 0,
      logDir: path.join(runtimeRoot, "logs"),
    };
  });
}

function runPowerShell(scriptPath, args, options) {
  return new Promise((resolve, reject) => {
    const maxBuffer = 2 * 1024 * 1024;
    const spawnProcess = options.spawnProcess || spawn;
    const child = spawnProcess("powershell.exe", ["-NoProfile", "-File", scriptPath, ...args], {
      windowsHide: true,
      env: options.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };
    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > maxBuffer) {
        child.kill();
        finish(new Error("PowerShell output exceeded 2 MiB"));
        return current;
      }
      return next;
    };

    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      const detail = String(stderr || stdout || `PowerShell exited with ${signal || `code ${code}`}`).trim();
      finish(new Error(detail));
    });

    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`PowerShell timed out after ${options.timeoutMs || 60_000}ms`));
    }, options.timeoutMs || 60_000);
  });
}

function resolveLarkProfileHome(options) {
  const profileHome = path.join(options.dataRoot, "profile-home");
  if ((options.platform || process.platform) !== "darwin") return profileHome;
  const alias = path.resolve(options.larkProfileHome || path.join(os.homedir(), ".cfb-lark-profile"));
  fs.mkdirSync(profileHome, { recursive: true, mode: 0o700 });
  try {
    const stat = fs.lstatSync(alias);
    if (!stat.isSymbolicLink() || fs.realpathSync(alias) !== fs.realpathSync(profileHome)) {
      throw new Error(`macOS Lark Profile 短路径已被其他文件占用：${alias}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    fs.symlinkSync(profileHome, alias, "dir");
  }
  return alias;
}

function processEnvironment(options, bot = null) {
  const profileHome = resolveLarkProfileHome(options);
  const platform = options.platform || process.platform;
  const macosToolDirs = platform === "darwin"
    ? (options.macosToolDirs || ["/Library/TeX/texbin", "/opt/homebrew/bin", "/usr/local/bin"])
      .filter((directory) => fs.existsSync(directory))
    : [];
  const toolDirs = [...new Set([
    path.dirname(options.nodePath),
    path.dirname(options.larkCliPath),
    ...macosToolDirs,
  ])];
  const environment = {
    ...process.env,
    ...(options.environment || {}),
    LOCALAPPDATA: options.localAppData,
    USERPROFILE: profileHome,
    HOME: profileHome,
    LARK_CLI_BIN: options.larkCliPath,
    CODEX_FEISHU_DESKTOP_DATA_ROOT: options.dataRoot,
    PATH: [...toolDirs, process.env.PATH || ""].join(path.delimiter),
  };
  if (bot?.provider?.mode === "custom") {
    if (typeof options.decryptSecret !== "function") throw new Error("系统安全存储不可用，无法读取 Provider API Key");
    const secretPath = path.join(path.dirname(bot.configPath), "provider-secret.bin");
    let encrypted;
    try { encrypted = fs.readFileSync(secretPath); } catch { throw new Error("Provider API Key 文件缺失，请重新配置 Provider"); }
    const apiKey = options.decryptSecret(encrypted);
    if (!apiKey) throw new Error("Provider API Key 解密结果为空");
    environment[bot.provider.envKey] = apiKey;
  }
  const engine = String(bot?.engine || "codex").trim().toLowerCase();
  environment.CODEX_FEISHU_AGENT_ENGINE = engine;
  if (engine === "pi") {
    const envKey = String(bot.provider?.envKey || "").trim();
    if (!ENV_NAME.test(envKey)) throw new Error("Pi Provider 环境变量名无效");
    if (!environment[envKey]) throw new Error(`Pi Provider 密钥不可用：${envKey}`);
    const skillPaths = (bot.piRuntime?.skillPaths || []).filter((item) => item && fs.existsSync(item));
    if (!skillPaths.length) throw new Error("Pi Skills 权威源不可用");
    Object.assign(environment, {
      PI_CODING_AGENT_DIR: bot.agentHome,
      CODEX_FEISHU_PI_SESSION_DIR: bot.sessionDir,
      CODEX_FEISHU_PI_PROVIDER: bot.provider.id,
      CODEX_FEISHU_PI_MODEL: bot.provider.model,
      CODEX_FEISHU_PI_THINKING: String(bot.provider.reasoning || "medium"),
      CODEX_FEISHU_PI_EXTENSIONS: bot.piRuntime.extensionPath,
      CODEX_FEISHU_PI_SKILLS: skillPaths.join(path.delimiter),
      CODEX_FEISHU_PI_CAPABILITIES_CONFIG: bot.piRuntime.capabilitiesPath,
    });
  }
  if (options.codexPath) environment.CODEX_CLI_BIN = options.codexPath;
  return environment;
}

function macosProviderEnvironment(codexHome, bot, options = {}) {
  if ((options.platform || process.platform) !== "darwin" || bot?.provider?.mode === "custom") return {};
  const inspect = options.inspectProviderCatalog || inspectProviderCatalog;
  const catalog = inspect(codexHome, {});
  if (catalog.error) throw new Error(catalog.error);
  const readLaunchctl = options.readLaunchctlEnvironmentVariable || ((name) => execFileSync(
    "/bin/launchctl",
    ["getenv", name],
    { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 },
  ));
  const inheritedEnvironment = options.environment || process.env;
  const environment = {};
  for (const provider of catalog.providers || []) {
    const envKey = String(provider.envKey || "").trim();
    if (!ENV_NAME.test(envKey) || environment[envKey]) continue;
    const inherited = String(inheritedEnvironment[envKey] || "");
    let value = inherited;
    if (!value) {
      try { value = String(readLaunchctl(envKey) || "").trim(); } catch { value = ""; }
    }
    if (value) environment[envKey] = value;
  }
  return environment;
}

async function waitForMacosProviderEnvironment(codexHome, options = {}) {
  if ((options.platform || process.platform) !== "darwin") {
    return { attempt: 0, expectedNames: [], loadedNames: [], missingNames: [], ready: true };
  }
  const inspect = options.inspectProviderCatalog || inspectProviderCatalog;
  const catalog = inspect(codexHome, {});
  if (catalog.error) throw new Error(catalog.error);
  const expectedNames = [...new Set((catalog.providers || [])
    .map((provider) => String(provider.envKey || "").trim())
    .filter((name) => ENV_NAME.test(name)))];
  if (!expectedNames.length) {
    return { attempt: 0, expectedNames, loadedNames: [], missingNames: [], ready: true };
  }

  const prepare = options.prepareProviderEnvironment || (() => {
    const scriptPath = path.join(os.homedir(), ".config", "codex-feishu-bridge", "load-provider-env.sh");
    if (fs.existsSync(scriptPath)) {
      return execFileSync(scriptPath, [], { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 });
    }
    return execFileSync(
      "/bin/launchctl",
      ["kickstart", `gui/${process.getuid()}/com.codex-feishu-bridge.provider-env`],
      { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 },
    );
  });
  try { await Promise.resolve(prepare()); } catch {}

  const attempts = Math.max(1, Number(options.attempts || 1));
  const delayMs = Math.max(0, Number(options.delayMs || 0));
  const wait = options.wait || ((duration) => new Promise((resolve) => setTimeout(resolve, duration)));
  const environment = options.environment || process.env;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    Object.assign(environment, macosProviderEnvironment(codexHome, null, {
      ...options,
      environment,
      inspectProviderCatalog: () => catalog,
    }));
    const missingNames = expectedNames.filter((name) => !environment[name]);
    if (!missingNames.length) {
      return { attempt, expectedNames, loadedNames: [...expectedNames], missingNames, ready: true };
    }
    if (attempt < attempts) await wait(delayMs);
  }

  const loadedNames = expectedNames.filter((name) => Boolean(environment[name]));
  const missingNames = expectedNames.filter((name) => !environment[name]);
  return { attempt: attempts, expectedNames, loadedNames, missingNames, ready: false };
}

function writeJsonAtomic(destination, value) {
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.rmSync(destination, { force: true });
  fs.renameSync(temporary, destination);
}

function posixRuntimePaths(options, name) {
  const runtimeRoot = managedRuntimeRoot(options.localAppData, name);
  return {
    runtimeRoot,
    stateDir: path.join(runtimeRoot, "state"),
    logDir: path.join(runtimeRoot, "logs"),
  };
}

function posixBridgeEnvironment(bot, codexHome, options, paths) {
  return {
    ...processEnvironment(options, bot),
    ...macosProviderEnvironment(codexHome, bot, options),
    CODEX_FEISHU_WORKSPACE: bot.workspace,
    CODEX_FEISHU_INSTANCE_NAME: bot.name,
    CODEX_HOME: codexHome,
    CODEX_FEISHU_LARK_PROFILE: bot.profile,
    CODEX_FEISHU_SANDBOX: "danger-full-access",
    CODEX_FEISHU_RUN_MODE: "app-server",
    CODEX_FEISHU_EVENT_KEYS: "im.message.receive_v1",
    CODEX_FEISHU_REASONING: String(bot.provider?.reasoning || ""),
    CODEX_FEISHU_CODEX_TIMEOUT_MS: "0",
    CODEX_FEISHU_CODEX_IDLE_TIMEOUT_MS: "3600000",
    CODEX_FEISHU_LIST_LIMIT: "100",
    CODEX_FEISHU_DISABLE_MCP: "0",
    CODEX_FEISHU_MAX_CONCURRENT: "1",
    CODEX_FEISHU_CARD_MODE: "1",
    CODEX_FEISHU_CARD_THROTTLE_MS: "400",
    CODEX_FEISHU_CARD_DEBUG: "0",
    CODEX_FEISHU_SHOW_FINAL_STEPS: "1",
    CODEX_FEISHU_REPLY_TO_MESSAGE: "0",
    CODEX_FEISHU_REPLY_IN_THREAD: "0",
    CODEX_FEISHU_STATE_DIR: paths.stateDir,
    CODEX_FEISHU_LOG_DIR: paths.logDir,
  };
}

async function startManagedBotPosix(bot, codexHome, options) {
  const paths = posixRuntimePaths(options, bot.name);
  fs.mkdirSync(bot.workspace, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.mkdirSync(paths.logDir, { recursive: true });
  fs.rmSync(path.join(paths.stateDir, "bridge.stop"), { force: true });
  writeJsonAtomic(path.join(paths.stateDir, "launch-config.json"), {
    engine: bot.engine || "codex",
    instance: bot.name,
    workspace: bot.workspace,
    larkProfile: bot.profile,
    codexHome,
    desktopCodexHome: "",
    ...(bot.engine === "pi" ? {
      piAgentHome: bot.agentHome,
      piSessionDir: bot.sessionDir,
      piConfigurationSpace: bot.configurationSpace,
      piRuntime: bot.piRuntime,
    } : {}),
    updatedAt: new Date().toISOString(),
  });
  const stdoutFd = fs.openSync(path.join(paths.logDir, "bridge.stdout.log"), "a");
  const stderrFd = fs.openSync(path.join(paths.logDir, "bridge.stderr.log"), "a");
  try {
    await new Promise((resolve, reject) => {
      const child = require("node:child_process").spawn(options.nodePath, [options.bridgeEntry], {
        cwd: options.engineRoot,
        detached: true,
        env: posixBridgeEnvironment(bot, codexHome, options, paths),
        stdio: ["ignore", stdoutFd, stderrFd],
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
}

async function stopManagedBotPosix(current, options) {
  const paths = posixRuntimePaths(options, current.name);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, "bridge.stop"), `${new Date().toISOString()}\n`, "utf8");
  const force = options.force === true;
  const deadline = Date.now() + (force ? 2_000 : 10_000);
  while (Date.now() < deadline) {
    if (!isProcessAlive(current.processId)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (force) {
    try { process.kill(-current.processId, "SIGTERM"); } catch {
      try { process.kill(current.processId, "SIGTERM"); } catch {}
    }
    const killDeadline = Date.now() + 5_000;
    while (Date.now() < killDeadline && isProcessAlive(current.processId)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (isProcessAlive(current.processId)) {
      try { process.kill(-current.processId, "SIGKILL"); } catch {
        try { process.kill(current.processId, "SIGKILL"); } catch {}
      }
      const forceDeadline = Date.now() + 2_000;
      while (Date.now() < forceDeadline && isProcessAlive(current.processId)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (isProcessAlive(current.processId)) throw new Error(`Bridge process group ${current.processId} did not stop after SIGKILL`);
  } else if (isProcessAlive(current.processId)) {
    try { process.kill(current.processId, "SIGTERM"); } catch {}
    const killDeadline = Date.now() + 5_000;
    while (Date.now() < killDeadline && isProcessAlive(current.processId)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (isProcessAlive(current.processId)) throw new Error(`Bridge process ${current.processId} did not stop after SIGTERM`);
  }
  fs.rmSync(path.join(paths.stateDir, "bridge.pid"), { force: true });
  fs.rmSync(path.join(paths.stateDir, "bridge.stop"), { force: true });
}

function findManagedBot(name, options) {
  const bot = readManagedBots(options.dataRoot).find((item) => item.name === name);
  if (!bot) throw new Error(`找不到客户端管理的 Bot：${name}`);
  return bot;
}

function managedBotStartArguments(bot, codexHome) {
  const args = [
    "-Name", bot.name,
    "-LarkProfile", bot.profile,
    "-Workspace", bot.workspace,
    "-CodexHome", codexHome,
  ];
  if (bot.provider?.reasoning) args.push("-Reasoning", bot.provider.reasoning);
  return args;
}

function managedBotStopArguments(name, force = false) {
  const args = ["-Name", name];
  if (force) args.push("-Force");
  return args;
}

function clearManagedBotActiveRuns(name, options) {
  const statePath = path.join(managedRuntimeRoot(options.localAppData, name), "state", "active-runs.json");
  const previous = readJson(statePath);
  const cleared = activeRunCount(previous);
  writeJsonAtomic(statePath, { runs: {} });
  return cleared;
}

function setManagedBotAutoStart(name, enabled, options) {
  const bot = findManagedBot(name, options);
  const destination = bot.configPath;
  const id = crypto.randomUUID();
  const temporary = `${destination}.${id}.tmp`;
  const backup = `${destination}.${id}.bak`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ ...bot, autoStart: enabled === true, configPath: undefined }, null, 2)}\n`, "utf8");
    fs.renameSync(destination, backup);
    fs.renameSync(temporary, destination);
    fs.rmSync(backup, { force: true });
    return findManagedBot(name, options);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    if (fs.existsSync(backup)) {
      fs.rmSync(destination, { force: true });
      fs.renameSync(backup, destination);
    }
    throw error;
  }
}

async function startManagedBot(name, options) {
  const bot = findManagedBot(name, options);
  const current = inspectManagedBots(options.dataRoot, options.localAppData).find((item) => item.name === name);
  if (current?.online) return current;
  if (!fs.existsSync(options.nodePath) || !fs.existsSync(options.larkCliPath)) {
    throw new Error("客户端内置运行时不完整，请重新安装客户端");
  }
  const engine = String(bot.engine || "codex").toLowerCase();
  if (engine === "codex" && !options.codexAvailable) throw new Error("未检测到可用的 Codex 桌面运行时");
  if (engine === "pi") assertPiRuntimeAvailable(bot);
  const codexHome = bot.codexHome || options.defaultCodexHome;
  if ((options.platform || process.platform) === "win32") {
    const scriptPath = path.join(options.engineRoot, "start-codex-feishu-bridge.ps1");
    if (!fs.existsSync(scriptPath)) throw new Error("客户端 Bridge 启动脚本缺失");
    const startArgs = managedBotStartArguments(bot, codexHome);
    await runPowerShell(scriptPath, startArgs, { env: processEnvironment(options, bot), timeoutMs: 60_000 });
  } else {
    if (!fs.existsSync(options.bridgeEntry || "")) throw new Error("客户端 Bridge 入口缺失");
    if (engine === "codex" && !options.codexPath) throw new Error("未检测到可用的 Codex 桌面运行时");
    await startManagedBotPosix(bot, codexHome, options);
  }

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = inspectManagedBots(options.dataRoot, options.localAppData).find((item) => item.name === name);
    if (state?.online) return state;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("Bridge 启动命令已返回，但 30 秒内没有检测到存活进程");
}

function assertPiRuntimeAvailable(bot) {
  const required = [
    [bot.agentHome, "Pi Agent Home"],
    [bot.sessionDir, "Pi session 目录"],
    [bot.agentHome && path.join(bot.agentHome, "models.json"), "Pi models.json"],
    [bot.agentHome && path.join(bot.agentHome, "settings.json"), "Pi settings.json"],
    [bot.piRuntime?.extensionPath, "Pi capability extension"],
    [bot.piRuntime?.capabilitiesPath, "Pi capabilities.json"],
  ];
  const missing = required.filter(([target]) => !target || !fs.existsSync(target)).map(([, label]) => label);
  if (missing.length) throw new Error(`Pi 运行时配置不完整：${missing.join("、")}`);
}

async function stopManagedBot(name, options) {
  const bot = findManagedBot(name, options);
  const current = inspectManagedBots(options.dataRoot, options.localAppData).find((item) => item.name === name);
  if (!current?.online) return current;
  if (current.activeRunCount > 0 && !options.force) {
    const error = new Error(`Bot 仍有 ${current.activeRunCount} 个活动任务，已拒绝停止`);
    error.code = "BOT_ACTIVE";
    error.activeRunCount = current.activeRunCount;
    throw error;
  }
  if ((options.platform || process.platform) === "win32") {
    const scriptPath = path.join(options.engineRoot, "stop-codex-feishu-bridge.ps1");
    if (!fs.existsSync(scriptPath)) throw new Error("客户端 Bridge 停止脚本缺失");
    await runPowerShell(scriptPath, managedBotStopArguments(name, options.force === true), {
      env: processEnvironment(options),
      timeoutMs: 30_000,
    });
  } else {
    await stopManagedBotPosix(current, options);
  }
  return inspectManagedBots(options.dataRoot, options.localAppData).find((item) => item.name === name);
}

async function stopManagedBotAndDisableAutoStart(name, options) {
  const bot = findManagedBot(name, options);
  const restoreAutoStart = bot.autoStart === true;
  if (restoreAutoStart) setManagedBotAutoStart(name, false, options);
  try {
    const stopBot = options.stopBot || stopManagedBot;
    return await stopBot(name, options);
  } catch (error) {
    if (restoreAutoStart) setManagedBotAutoStart(name, true, options);
    throw error;
  }
}

async function restartSelectedManagedBots(options) {
  const inspectBots = options.inspectBots || (() => inspectManagedBots(options.dataRoot, options.localAppData));
  const stopBot = options.stopBot || ((name, mode) => stopManagedBot(name, { ...options, force: mode.force }));
  const startBot = options.startBot || ((name) => startManagedBot(name, options));
  const clearActiveRuns = options.clearActiveRuns || ((name) => clearManagedBotActiveRuns(name, options));
  const onProgress = options.onProgress || (() => {});
  const force = options.force === true;
  const names = [...new Set((options.names || []).map((name) => String(name || "").trim()).filter(Boolean))];
  if (!names.length) throw new Error("请先选择至少一个客户端管理的 Bot");
  const availableBots = await Promise.resolve(inspectBots());
  const availableByName = new Map(availableBots.map((bot) => [bot.name, bot]));
  const unknownNames = names.filter((name) => !availableByName.has(name));
  if (unknownNames.length) throw new Error(`找不到客户端管理的 Bot：${unknownNames.join("、")}`);
  const selectedBots = names.map((name) => availableByName.get(name));
  const onlineBots = selectedBots.filter((bot) => bot.online);
  const skippedOffline = selectedBots.filter((bot) => !bot.online).map((bot) => ({ name: bot.name }));
  const skippedActive = force ? [] : onlineBots
    .filter((bot) => Number(bot.activeRunCount || 0) > 0)
    .map((bot) => ({ name: bot.name, activeRunCount: Number(bot.activeRunCount || 0) }));
  const targets = force ? onlineBots : onlineBots.filter((bot) => Number(bot.activeRunCount || 0) === 0);
  const restarted = [];
  const clearedActiveRuns = [];
  const recovered = [];
  const failed = [];

  onProgress({
    stage: "ready",
    mode: force ? "force" : "safe",
    completed: 0,
    total: targets.length,
    skippedActive,
    skippedOffline,
  });
  for (let index = 0; index < targets.length; index += 1) {
    const bot = targets[index];
    try {
      const latest = (await Promise.resolve(inspectBots())).find((item) => item.name === bot.name);
      if (!latest?.online) {
        if (!skippedOffline.some((item) => item.name === bot.name)) skippedOffline.push({ name: bot.name });
        onProgress({ stage: "skipped-offline", name: bot.name, completed: index + 1, total: targets.length });
        continue;
      }
      if (!force && Number(latest.activeRunCount || 0) > 0) {
        skippedActive.push({ name: bot.name, activeRunCount: Number(latest.activeRunCount || 0) });
        onProgress({ stage: "skipped-active", name: bot.name, completed: index + 1, total: targets.length });
        continue;
      }
      onProgress({ stage: "stopping", name: bot.name, completed: index, total: targets.length });
      await stopBot(bot.name, { force });
      if (force) {
        const cleared = Number(await Promise.resolve(clearActiveRuns(bot.name))) || 0;
        clearedActiveRuns.push({ name: bot.name, count: cleared });
      }
      onProgress({ stage: "starting", name: bot.name, completed: index, total: targets.length });
      await startBot(bot.name);
      restarted.push(bot.name);
      onProgress({ stage: "restarted", name: bot.name, completed: index + 1, total: targets.length });
    } catch (error) {
      if (!force && error?.code === "BOT_ACTIVE") {
        skippedActive.push({ name: bot.name, activeRunCount: Number(error.activeRunCount || 0) });
        onProgress({ stage: "skipped-active", name: bot.name, completed: index + 1, total: targets.length });
        continue;
      }
      let recoveryError = "";
      try {
        const current = (await Promise.resolve(inspectBots())).find((item) => item.name === bot.name);
        if (current && !current.online) {
          await startBot(bot.name);
          recovered.push(bot.name);
        }
      } catch (recoveryFailure) {
        recoveryError = String(recoveryFailure?.message || recoveryFailure);
      }
      failed.push({
        name: bot.name,
        error: String(error?.message || error),
        recovered: recovered.includes(bot.name),
        recoveryError,
      });
      onProgress({ stage: "failed", name: bot.name, completed: index + 1, total: targets.length });
    }
  }

  return {
    mode: force ? "force" : "safe",
    selectedCount: selectedBots.length,
    onlineCount: onlineBots.length,
    targetCount: targets.length,
    restarted,
    skippedActive,
    skippedOffline,
    clearedActiveRuns,
    recovered,
    failed,
  };
}

async function restartOnlineManagedBots(options) {
  const inspectBots = options.inspectBots || (() => inspectManagedBots(options.dataRoot, options.localAppData));
  const bots = await Promise.resolve(inspectBots());
  return restartSelectedManagedBots({
    ...options,
    names: bots.filter((bot) => bot.online).map((bot) => bot.name),
    inspectBots,
  });
}

module.exports = {
  inspectManagedBots,
  clearManagedBotActiveRuns,
  managedBotStartArguments,
  managedBotStopArguments,
  managedRuntimeRoot,
  macosProviderEnvironment,
  waitForMacosProviderEnvironment,
  posixBridgeEnvironment,
  posixRuntimePaths,
  processEnvironment,
  assertPiRuntimeAvailable,
  resolveLarkProfileHome,
  runPowerShell,
  restartOnlineManagedBots,
  restartSelectedManagedBots,
  setManagedBotAutoStart,
  startManagedBot,
  stopManagedBot,
  stopManagedBotAndDisableAutoStart,
};
