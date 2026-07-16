const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function readJson(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readPid(filePath) {
  try {
    const value = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").trim();
    return /^\d+$/.test(value) ? Number(value) : null;
  } catch {
    return null;
  }
}

function isProcessAlive(processId) {
  if (!Number.isInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

function activeRunCount(value) {
  const runs = value && typeof value === "object" ? value.runs : null;
  if (!runs || typeof runs !== "object") return 0;
  return Object.values(runs).filter((item) => item !== null && item !== undefined).length;
}

function discoverInstance(instanceRoot, name) {
  const stateDir = path.join(instanceRoot, "state");
  const logDir = path.join(instanceRoot, "logs");
  const launch = readJson(path.join(stateDir, "launch-config.json")) || {};
  const lock = readJson(path.join(stateDir, "bridge.lock.json")) || {};
  const processId = readPid(path.join(stateDir, "bridge.pid"));
  const active = readJson(path.join(stateDir, "active-runs.json"));

  return {
    name,
    processId,
    online: isProcessAlive(processId),
    activeRunCount: activeRunCount(active),
    workspace: String(launch.workspace || lock.workspace || ""),
    codexHome: String(launch.codexHome || ""),
    larkProfile: String(launch.larkProfile || lock.larkProfile || ""),
    stateDir,
    logDir,
  };
}

function discoverBridge(root = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "CodexFeishuBridge")) {
  const instancesRoot = path.join(root, "instances");
  let names = [];
  try {
    names = fs.readdirSync(instancesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    names = [];
  }

  const instances = names
    .filter((name) => name.toLowerCase() !== "default")
    .map((name) => discoverInstance(path.join(instancesRoot, name), name));
  const rootDefault = discoverInstance(root, "default");
  const rootHasDefaultState = fs.existsSync(rootDefault.stateDir)
    && (rootDefault.processId !== null || rootDefault.workspace || rootDefault.larkProfile);
  if (rootHasDefaultState) instances.push(rootDefault);
  instances.sort((left, right) => left.name.localeCompare(right.name));
  return {
    installed: fs.existsSync(root),
    root,
    instances,
    summary: {
      total: instances.length,
      online: instances.filter((item) => item.online).length,
      activeRuns: instances.reduce((sum, item) => sum + item.activeRunCount, 0),
    },
  };
}

module.exports = {
  activeRunCount,
  discoverBridge,
  isProcessAlive,
  readJson,
};
