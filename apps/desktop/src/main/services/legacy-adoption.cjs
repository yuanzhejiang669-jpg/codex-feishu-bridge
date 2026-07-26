const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { discoverBridge, isProcessAlive } = require("./bridge-discovery.cjs");
const { readManagedBots } = require("./bot-setup.cjs");
const { publicPermissionPolicy } = require("./permission-policy.cjs");

const PROFILE_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,62}[A-Za-z0-9])?$/;
const TRANSIENT_STATE_NAMES = new Set([
  "active-runs.json",
  "bridge.lock.json",
  "bridge.pid",
  "bridge.stop",
  "launch-config.json",
  "watchdog-last-restart.txt",
  "watchdog.lock",
]);

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function writeJsonAtomic(destination, value) {
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, destination);
}

function pendingPath(dataRoot) {
  return path.join(dataRoot, "pending-legacy-adoptions.json");
}

function readPendingNames(dataRoot) {
  const value = readJson(pendingPath(dataRoot));
  return Array.isArray(value?.names) ? value.names.map(String).filter(Boolean) : [];
}

function writePendingNames(dataRoot, names) {
  const unique = [...new Set(names.map(String).filter(Boolean))].sort();
  if (!unique.length) {
    fs.rmSync(pendingPath(dataRoot), { force: true });
    return;
  }
  writeJsonAtomic(pendingPath(dataRoot), { schemaVersion: 1, names: unique, updatedAt: new Date().toISOString() });
}

function profileConfigPath(profileHome) {
  return path.join(profileHome, ".lark-cli", "config.json");
}

function profileApps(config) {
  return Array.isArray(config?.apps) ? config.apps : [];
}

function findProfile(profileHome, name) {
  const config = readJson(profileConfigPath(profileHome));
  return profileApps(config).find((item) => item?.name === name) || null;
}

function mergeProfile(sourceHome, targetHome, name) {
  const sourcePath = profileConfigPath(sourceHome);
  const targetPath = profileConfigPath(targetHome);
  const source = readJson(sourcePath);
  const selected = profileApps(source).find((item) => item?.name === name);
  if (!selected) throw new Error(`全局 Lark CLI 中找不到 Profile：${name}`);
  const target = readJson(targetPath) || { apps: [] };
  if (!Array.isArray(target.apps)) throw new Error("客户端 Lark CLI Profile 配置格式不受支持");
  const existing = target.apps.find((item) => item?.name === name);
  if (existing) {
    if (existing.appId !== selected.appId) throw new Error(`客户端已有同名但 App ID 不同的 Profile：${name}`);
    return { added: false, appId: String(existing.appId || ""), brand: String(existing.brand || "feishu") };
  }
  if (target.apps.some((item) => item?.appId && item.appId === selected.appId)) {
    throw new Error(`客户端已有使用相同 App ID 的其他 Profile：${selected.appId}`);
  }
  writeJsonAtomic(targetPath, { ...target, apps: [...target.apps, structuredClone(selected)] });
  return { added: true, appId: String(selected.appId || ""), brand: String(selected.brand || "feishu") };
}

function removeProfile(profileHome, name) {
  const targetPath = profileConfigPath(profileHome);
  const target = readJson(targetPath);
  if (!target || !Array.isArray(target.apps)) return false;
  const apps = target.apps.filter((item) => item?.name !== name);
  if (apps.length === target.apps.length) return false;
  writeJsonAtomic(targetPath, { ...target, apps });
  return true;
}

function scheduledTaskName(name) {
  return name === "default" ? "CodexFeishuBridgeWatchdog" : `CodexFeishuBridgeWatchdog-${name}`;
}

function runScheduledTaskCommand(args, { ignoreFailure = false } = {}) {
  try {
    execFileSync("schtasks.exe", args, { windowsHide: true, stdio: "ignore" });
    return true;
  } catch (error) {
    if (ignoreFailure) return false;
    throw error;
  }
}

function taskExists(name) {
  return runScheduledTaskCommand(["/Query", "/TN", scheduledTaskName(name)], { ignoreFailure: true });
}

function disableTask(name) {
  runScheduledTaskCommand(["/End", "/TN", scheduledTaskName(name)], { ignoreFailure: true });
  runScheduledTaskCommand(["/Change", "/TN", scheduledTaskName(name), "/Disable"]);
}

function restoreTask(name) {
  runScheduledTaskCommand(["/Change", "/TN", scheduledTaskName(name), "/Enable"], { ignoreFailure: true });
  runScheduledTaskCommand(["/Run", "/TN", scheduledTaskName(name)], { ignoreFailure: true });
}

function inferLabel(name) {
  let match = /^codex-assistant-(\d+)-writing$/.exec(name);
  if (match) return `Codex助手${match[1]}-写作`;
  match = /^codex-assistant-(\d+)$/.exec(name);
  if (match) return `Codex 助手 ${match[1]}`;
  return name;
}

function inferWorkspaceFactory(name, codexHome, defaultCodexHome) {
  if (path.resolve(codexHome).toLowerCase() === path.resolve(defaultCodexHome).toLowerCase()) return null;
  if (name.endsWith("-writing")) return { spaceName: "写作", slug: "writing" };
  const slug = path.basename(codexHome).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "imported";
  return { spaceName: path.basename(codexHome), slug };
}

function targetRuntimeRoot(options, name) {
  return path.join(options.runtimeLocalAppData, "CodexFeishuBridge", "instances", name);
}

function sourceRuntimeRoot(options, name) {
  const bridgeRoot = path.join(options.legacyLocalAppData, "CodexFeishuBridge");
  return name === "default" ? bridgeRoot : path.join(bridgeRoot, "instances", name);
}

function copyPersistentRuntimeState(name, options) {
  const sourceState = path.join(sourceRuntimeRoot(options, name), "state");
  const targetRoot = targetRuntimeRoot(options, name);
  const targetState = path.join(targetRoot, "state");
  if (fs.existsSync(targetRoot)) throw new Error(`客户端运行目录已存在，拒绝覆盖：${targetRoot}`);
  fs.mkdirSync(targetState, { recursive: true });
  for (const entry of fs.readdirSync(sourceState, { withFileTypes: true })) {
    if (!entry.isFile() || TRANSIENT_STATE_NAMES.has(entry.name)) continue;
    fs.copyFileSync(path.join(sourceState, entry.name), path.join(targetState, entry.name));
  }
  writeJsonAtomic(path.join(targetState, "active-runs.json"), { runs: {} });
  return targetRoot;
}

function previewLegacyAdoption(rawNames, options) {
  const selected = new Set((rawNames || []).map((item) => String(item || "").trim()).filter(Boolean));
  const managedNames = new Set(readManagedBots(options.dataRoot).map((item) => item.name));
  const bridge = (options.discoverBridge || discoverBridge)(path.join(options.legacyLocalAppData, "CodexFeishuBridge"));
  const instances = bridge.instances.filter((item) => !managedNames.has(item.name));
  return instances
    .filter((item) => !selected.size || selected.has(item.name))
    .map((item) => {
      const profile = item.name === "default" && (!item.larkProfile || item.larkProfile === "default")
        ? "codex-assistant-default"
        : (item.larkProfile || item.name);
      const blockers = [];
      if (!PROFILE_PATTERN.test(item.name) || !PROFILE_PATTERN.test(profile)) blockers.push("Bot 或 Profile 标识格式无效");
      if (!item.workspace || !fs.existsSync(item.workspace)) blockers.push("工作空间不存在");
      if (!item.codexHome || !fs.existsSync(item.codexHome)) blockers.push("Codex Home 不存在");
      const sourceProfile = findProfile(options.sourceProfileHome, profile);
      const targetProfile = findProfile(options.targetProfileHome, profile);
      if (!sourceProfile) blockers.push("全局 Lark CLI Profile 不存在");
      if (targetProfile && sourceProfile && targetProfile.appId !== sourceProfile.appId) {
        blockers.push("客户端已有同名但 App ID 不同的 Lark CLI Profile");
      }
      if (!(options.taskExists || taskExists)(item.name)) blockers.push("脚本 Watchdog 计划任务不存在");
      if (fs.existsSync(path.join(options.dataRoot, "managed-bots", item.name))) blockers.push("客户端 Bot 配置目录已存在");
      if (fs.existsSync(targetRuntimeRoot(options, item.name))) blockers.push("客户端运行目录已存在");
      if (item.activeRunCount > 0) blockers.push(`仍有 ${item.activeRunCount} 个活动任务`);
      return {
        ...item,
        profile,
        label: inferLabel(item.name),
        scheduledTask: scheduledTaskName(item.name),
        ready: blockers.length === 0,
        queueable: blockers.length === 1 && item.activeRunCount > 0,
        blockers,
      };
    });
}

function managedBotConfig(item, profile, options) {
  const workspaceFactory = inferWorkspaceFactory(item.name, item.codexHome, options.defaultCodexHome);
  return {
    schemaVersion: 1,
    name: item.name,
    profile: item.profile,
    label: item.label,
    brand: profile.brand,
    workspace: item.workspace,
    codexHome: item.codexHome,
    codexHomeMode: workspaceFactory ? "isolated" : "shared",
    ...(workspaceFactory ? { workspaceFactory } : {}),
    permissionPolicy: publicPermissionPolicy(),
    appId: profile.appId,
    createdAt: new Date().toISOString(),
    state: "configured",
    autoStart: true,
    legacyAdoption: {
      source: "script-watchdog",
      scheduledTask: item.scheduledTask,
      adoptedAt: new Date().toISOString(),
    },
  };
}

async function adoptOne(item, options) {
  const finalRoot = path.join(options.dataRoot, "managed-bots", item.name);
  let taskDisabled = false;
  let profileAdded = false;
  let runtimeCopied = false;
  let configWritten = false;
  try {
    (options.disableTask || disableTask)(item.name);
    taskDisabled = true;
    await options.stopLegacy(item.name);
    const processId = item.processId;
    if (processId && (options.isProcessAlive || isProcessAlive)(processId)) {
      throw new Error(`旧 Bridge 进程仍然在线：${processId}`);
    }
    const profile = mergeProfile(options.sourceProfileHome, options.targetProfileHome, item.profile);
    profileAdded = profile.added;
    copyPersistentRuntimeState(item.name, options);
    runtimeCopied = true;
    const config = managedBotConfig(item, profile, options);
    fs.mkdirSync(finalRoot, { recursive: true });
    writeJsonAtomic(path.join(finalRoot, "bot.json"), config);
    configWritten = true;
    await options.startManaged(item.name);
    return { name: item.name, status: "adopted" };
  } catch (error) {
    if (configWritten) {
      try { await options.stopManaged(item.name); } catch {}
    }
    fs.rmSync(finalRoot, { recursive: true, force: true });
    if (runtimeCopied) fs.rmSync(targetRuntimeRoot(options, item.name), { recursive: true, force: true });
    if (profileAdded) removeProfile(options.targetProfileHome, item.profile);
    if (taskDisabled) (options.restoreTask || restoreTask)(item.name);
    return { name: item.name, status: "failed", error: String(error?.message || error) };
  }
}

async function applyLegacyAdoption(rawNames, options) {
  const names = [...new Set((rawNames || []).map((item) => String(item || "").trim()).filter(Boolean))];
  if (!names.length) throw new Error("请至少选择一个现有 Bot");
  const results = [];
  const pending = new Set(readPendingNames(options.dataRoot));
  for (const name of names) {
    const [latest] = previewLegacyAdoption([name], options);
    if (!latest || !latest.ready) {
      if (options.queueActive !== false && latest?.queueable) {
        pending.add(name);
        results.push({ name, status: "queued", blockers: latest.blockers });
      } else {
        results.push({ name, status: "skipped", blockers: latest?.blockers || ["现有 Bot 不存在或已被接管"] });
      }
      continue;
    }
    const result = await adoptOne(latest, options);
    results.push(result);
    if (result.status === "adopted") pending.delete(name);
  }
  writePendingNames(options.dataRoot, [...pending]);
  return {
    selectedCount: names.length,
    adopted: results.filter((item) => item.status === "adopted").map((item) => item.name),
    queued: results.filter((item) => item.status === "queued").map((item) => item.name),
    skipped: results.filter((item) => item.status === "skipped"),
    failed: results.filter((item) => item.status === "failed"),
  };
}

async function processPendingLegacyAdoptions(options) {
  const names = readPendingNames(options.dataRoot);
  if (!names.length) return { adopted: [], waiting: [], failed: [] };
  const adopted = [];
  const waiting = [];
  const failed = [];
  const remaining = new Set(names);
  for (const name of names) {
    const [latest] = previewLegacyAdoption([name], options);
    if (latest?.queueable) {
      waiting.push(name);
      continue;
    }
    if (!latest?.ready) {
      failed.push({ name, error: latest?.blockers?.join("；") || "现有 Bot 不存在或已被接管" });
      remaining.delete(name);
      continue;
    }
    const result = await adoptOne(latest, options);
    if (result.status === "adopted") {
      adopted.push(name);
      remaining.delete(name);
    } else {
      failed.push({ name, error: result.error });
      remaining.delete(name);
    }
  }
  writePendingNames(options.dataRoot, [...remaining]);
  return { adopted, waiting, failed };
}

module.exports = {
  applyLegacyAdoption,
  copyPersistentRuntimeState,
  disableTask,
  findProfile,
  inferLabel,
  mergeProfile,
  processPendingLegacyAdoptions,
  previewLegacyAdoption,
  readPendingNames,
  removeProfile,
  restoreTask,
  scheduledTaskName,
  taskExists,
};
