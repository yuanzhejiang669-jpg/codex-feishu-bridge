const fs = require("node:fs");
const path = require("node:path");

const LINUX_MARKER = "X-Codex-Feishu-Bridge-Autostart=true";

function quoteDesktopExec(value) {
  return `"${String(value || "").replace(/[\\"`$]/g, "\\$&")}"`;
}

function linuxAutostartPath(home) {
  return path.join(home, ".config", "autostart", "codex-feishu-bridge.desktop");
}

function linuxDesktopEntry(executablePath) {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    "Name=Codex Feishu Bridge",
    "Comment=Start Codex Feishu Bridge in the background",
    `Exec=${quoteDesktopExec(executablePath)} --background`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    LINUX_MARKER,
    "",
  ].join("\n");
}

function createWindowsStartup(app, options = {}) {
  const packaged = options.packaged == null ? app.isPackaged : options.packaged;
  const platform = options.platform || process.platform;
  const args = ["--background"];

  function supported() {
    return packaged === true && new Set(["win32", "darwin", "linux"]).has(platform);
  }

  function inspect() {
    if (!supported()) return { supported: false, enabled: false };
    const executablePath = options.executablePath || process.execPath;
    if (platform === "linux") {
      const destination = linuxAutostartPath(options.home || app.getPath("home"));
      let content = "";
      try { content = fs.readFileSync(destination, "utf8"); } catch {}
      return { supported: true, enabled: content.includes(LINUX_MARKER), path: destination };
    }
    const value = app.getLoginItemSettings({ path: executablePath, args });
    return { supported: true, enabled: value.openAtLogin === true };
  }

  function setEnabled(enabled) {
    if (!supported()) return { supported: false, enabled: false };
    const executablePath = options.executablePath || process.execPath;
    if (platform === "linux") {
      const destination = linuxAutostartPath(options.home || app.getPath("home"));
      let existing = "";
      try { existing = fs.readFileSync(destination, "utf8"); } catch {}
      if (existing && !existing.includes(LINUX_MARKER)) {
        throw new Error(`Linux 登录启动文件已被其他程序占用：${destination}`);
      }
      if (enabled === true) {
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        const temporary = `${destination}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, linuxDesktopEntry(executablePath), { encoding: "utf8", mode: 0o600 });
        fs.rmSync(destination, { force: true });
        fs.renameSync(temporary, destination);
      } else if (existing.includes(LINUX_MARKER)) {
        fs.rmSync(destination, { force: true });
      }
      return inspect();
    }
    if (platform === "darwin") {
      app.setLoginItemSettings({ openAtLogin: enabled === true, openAsHidden: true });
    } else {
      app.setLoginItemSettings({ openAtLogin: enabled === true, path: executablePath, args });
    }
    const actual = app.getLoginItemSettings({ path: executablePath, args });
    return { supported: true, enabled: actual.openAtLogin === true };
  }

  return { args: [...args], inspect, setEnabled, supported };
}

const createDesktopStartup = createWindowsStartup;

module.exports = { createDesktopStartup, createWindowsStartup };
