const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_SETTINGS = Object.freeze({
  launchAtLogin: false,
  closeToTray: true,
});

function settingsPath(dataRoot) {
  return path.join(dataRoot, "desktop-settings.json");
}

function normalizeSettings(value = {}) {
  return {
    launchAtLogin: value.launchAtLogin === true,
    closeToTray: value.closeToTray !== false,
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

module.exports = {
  DEFAULT_SETTINGS,
  normalizeSettings,
  readDesktopSettings,
  settingsPath,
  writeDesktopSettings,
};
