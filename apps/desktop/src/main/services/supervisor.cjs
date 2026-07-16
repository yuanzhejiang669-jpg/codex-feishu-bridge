const fs = require("node:fs");
const crypto = require("node:crypto");
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

function processEnvironment(options, bot = null) {
  const toolDirs = [path.dirname(options.nodePath), path.dirname(options.larkCliPath)];
  const environment = {
    ...process.env,
    LOCALAPPDATA: options.localAppData,
    USERPROFILE: path.join(options.dataRoot, "profile-home"),
    LARK_CLI_BIN: options.larkCliPath,
    PATH: [...toolDirs, process.env.PATH || ""].join(path.delimiter),
  };
  if (bot?.provider?.mode === "custom") {
    if (typeof options.decryptSecret !== "function") throw new Error("Windows 安全存储不可用，无法读取 Provider API Key");
    const secretPath = path.join(path.dirname(bot.configPath), "provider-secret.bin");
    let encrypted;
    try { encrypted = fs.readFileSync(secretPath); } catch { throw new Error("Provider API Key 文件缺失，请重新配置 Provider"); }
    const apiKey = options.decryptSecret(encrypted);
    if (!apiKey) throw new Error("Provider API Key 解密结果为空");
    environment[bot.provider.envKey] = apiKey;
  }
  return environment;
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
  const scriptPath = path.join(options.engineRoot, "start-codex-feishu-bridge.ps1");
  if (!fs.existsSync(scriptPath)) throw new Error("客户端 Bridge 启动脚本缺失");
  const codexHome = bot.codexHome || options.defaultCodexHome;
  const startArgs = managedBotStartArguments(bot, codexHome);
  await runPowerShell(scriptPath, startArgs, { env: processEnvironment(options, bot), timeoutMs: 60_000 });

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
  const scriptPath = path.join(options.engineRoot, "stop-codex-feishu-bridge.ps1");
  if (!fs.existsSync(scriptPath)) throw new Error("客户端 Bridge 停止脚本缺失");
  await runPowerShell(scriptPath, ["-Name", name], {
    env: processEnvironment(options),
    timeoutMs: 30_000,
  });
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
  processEnvironment,
  runPowerShell,
  setManagedBotAutoStart,
  startManagedBot,
  stopManagedBot,
  stopManagedBotAndDisableAutoStart,
};
