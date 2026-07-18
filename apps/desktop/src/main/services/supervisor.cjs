const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { activeRunCount, isProcessAlive, readJson } = require("./bridge-discovery.cjs");
const { readManagedBots } = require("./bot-setup.cjs");

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
    execFile("powershell.exe", ["-NoProfile", "-File", scriptPath, ...args], {
      windowsHide: true,
      timeout: options.timeoutMs || 60_000,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      env: options.env,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || stdout || error.message).trim()));
        return;
      }
      resolve({ stdout, stderr });
    });
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
  const toolDirs = [path.dirname(options.nodePath), path.dirname(options.larkCliPath)];
  const environment = {
    ...process.env,
    LOCALAPPDATA: options.localAppData,
    USERPROFILE: profileHome,
    HOME: profileHome,
    LARK_CLI_BIN: options.larkCliPath,
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
  if (options.codexPath) environment.CODEX_CLI_BIN = options.codexPath;
  return environment;
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
    instance: bot.name,
    workspace: bot.workspace,
    larkProfile: bot.profile,
    codexHome,
    desktopCodexHome: "",
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
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(current.processId)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (isProcessAlive(current.processId)) {
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
  if (!options.codexAvailable) throw new Error("未检测到可用的 Codex 桌面运行时");
  const codexHome = bot.codexHome || options.defaultCodexHome;
  if ((options.platform || process.platform) === "win32") {
    const scriptPath = path.join(options.engineRoot, "start-codex-feishu-bridge.ps1");
    if (!fs.existsSync(scriptPath)) throw new Error("客户端 Bridge 启动脚本缺失");
    const startArgs = managedBotStartArguments(bot, codexHome);
    await runPowerShell(scriptPath, startArgs, { env: processEnvironment(options, bot), timeoutMs: 60_000 });
  } else {
    if (!fs.existsSync(options.bridgeEntry || "")) throw new Error("客户端 Bridge 入口缺失");
    if (!options.codexPath) throw new Error("未检测到可用的 Codex 桌面运行时");
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

async function stopManagedBot(name, options) {
  const bot = findManagedBot(name, options);
  const current = inspectManagedBots(options.dataRoot, options.localAppData).find((item) => item.name === name);
  if (!current?.online) return current;
  if (current.activeRunCount > 0 && !options.force) {
    throw new Error(`Bot 仍有 ${current.activeRunCount} 个活动任务，已拒绝停止`);
  }
  if ((options.platform || process.platform) === "win32") {
    const scriptPath = path.join(options.engineRoot, "stop-codex-feishu-bridge.ps1");
    if (!fs.existsSync(scriptPath)) throw new Error("客户端 Bridge 停止脚本缺失");
    await runPowerShell(scriptPath, ["-Name", name], {
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

module.exports = {
  inspectManagedBots,
  managedBotStartArguments,
  managedRuntimeRoot,
  posixBridgeEnvironment,
  posixRuntimePaths,
  processEnvironment,
  resolveLarkProfileHome,
  runPowerShell,
  setManagedBotAutoStart,
  startManagedBot,
  stopManagedBot,
  stopManagedBotAndDisableAutoStart,
};
