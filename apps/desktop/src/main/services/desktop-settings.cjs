const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_SETTINGS = Object.freeze({
  launchAtLogin: false,
  closeToTray: true,
  ownerOpenId: "",
});

const OWNER_OPEN_ID_PATTERN = /^(?:|ou_[A-Za-z0-9]+)$/;

function settingsPath(dataRoot) {
  return path.join(dataRoot, "desktop-settings.json");
}

function normalizeSettings(value = {}) {
  const ownerOpenId = String(value.ownerOpenId || "").trim();
  return {
    launchAtLogin: value.launchAtLogin === true,
    closeToTray: value.closeToTray !== false,
    ownerOpenId: OWNER_OPEN_ID_PATTERN.test(ownerOpenId) ? ownerOpenId : "",
  };
}

function readDesktopSettings(dataRoot) {
  try {
    const value = JSON.parse(fs.readFileSync(settingsPath(dataRoot), "utf8").replace(/^\uFEFF/, ""));
    return { ...DEFAULT_SETTINGS, ...normalizeSettings(value), error: "" };
  } catch (error) {
    if (error?.code === "ENOENT") return { ...DEFAULT_SETTINGS, error: "" };
    return { ...DEFAULT_SETTINGS, error: String(error.message || error) };
  }
}

function writeDesktopSettings(dataRoot, patch = {}) {
  const current = readDesktopSettings(dataRoot);
  if (current.error) throw new Error(`客户端设置损坏：${current.error}`);
  if (patch && Object.prototype.hasOwnProperty.call(patch, "ownerOpenId")) {
    const candidate = String(patch.ownerOpenId || "").trim();
    if (!OWNER_OPEN_ID_PATTERN.test(candidate)) {
      throw new Error("主用户 Open ID 格式无效（需为空或 ou_ 开头）");
    }
  }
  const next = normalizeSettings({ ...current, ...patch });
  fs.mkdirSync(dataRoot, { recursive: true });
  const id = crypto.randomUUID();
  const destination = settingsPath(dataRoot);
  const temporary = `${destination}.${id}.tmp`;
  const backup = `${destination}.${id}.bak`;
  const existed = fs.existsSync(destination);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    if (existed) fs.renameSync(destination, backup);
    fs.renameSync(temporary, destination);
    fs.rmSync(backup, { force: true });
    return { ...next, error: "" };
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    if (fs.existsSync(backup)) {
      fs.rmSync(destination, { force: true });
      fs.renameSync(backup, destination);
    }
    throw error;
  }
}

function writeAtomicJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function setOwnerOpenId(input = {}, options = {}) {
  const dataRoot = options.dataRoot;
  const ownerOpenId = String(input?.ownerOpenId ?? "").trim();
  if (!OWNER_OPEN_ID_PATTERN.test(ownerOpenId)) {
    throw new Error("主用户 Open ID 格式无效（需为空或 ou_ 开头）");
  }
  const settings = writeDesktopSettings(dataRoot, { ownerOpenId });
  const ownerDirs = [
    path.join(dataRoot, "claude-shared-sessions"),
    path.join(dataRoot, "antigravity-shared-sessions"),
  ];
  for (const dir of ownerDirs) {
    const ownerFile = path.join(dir, "owner.json");
    if (ownerOpenId) {
      writeAtomicJsonFile(ownerFile, {
        schemaVersion: 1,
        primaryOwnerOpenId: ownerOpenId,
        boundAt: new Date().toISOString(),
      });
    } else if (fs.existsSync(ownerFile)) {
      fs.rmSync(ownerFile, { force: true });
    }
  }
  const queuedBots = { codex: [], claude: [], antigravity: [] };
  const bots = typeof options.readManagedBots === "function" ? options.readManagedBots(dataRoot) : [];
  const claudeNames = bots.filter((b) => b.engine === "claude").map((b) => b.name);
  const agyNames = bots.filter((b) => b.engine === "antigravity").map((b) => b.name);
  const codexNames = bots.filter((b) => !["claude", "antigravity"].includes(b.engine)).map((b) => b.name);
  if (claudeNames.length && typeof options.queueClaude === "function") {
    options.queueClaude(dataRoot, claudeNames, "claude");
    queuedBots.claude = claudeNames;
  }
  if (agyNames.length && typeof options.queueClaude === "function") {
    options.queueClaude(dataRoot, agyNames, "antigravity");
    queuedBots.antigravity = agyNames;
  }
  if (codexNames.length && typeof options.queueCodexBotReload === "function") {
    options.queueCodexBotReload(dataRoot, codexNames);
    queuedBots.codex = codexNames;
  }
  return { ok: true, ownerOpenId: settings.ownerOpenId, settings, queuedBots };
}

module.exports = {
  DEFAULT_SETTINGS,
  OWNER_OPEN_ID_PATTERN,
  normalizeSettings,
  readDesktopSettings,
  setOwnerOpenId,
  settingsPath,
  writeDesktopSettings,
};
