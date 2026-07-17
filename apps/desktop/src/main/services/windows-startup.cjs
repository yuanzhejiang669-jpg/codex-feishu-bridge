function createWindowsStartup(app, options = {}) {
  const packaged = options.packaged == null ? app.isPackaged : options.packaged;
  const platform = options.platform || process.platform;
  const args = ["--background"];

  function supported() {
    return packaged === true && new Set(["win32", "darwin"]).has(platform);
  }

  function inspect() {
    if (!supported()) return { supported: false, enabled: false };
    const executablePath = options.executablePath || process.execPath;
    const value = app.getLoginItemSettings({ path: executablePath, args });
    return { supported: true, enabled: value.openAtLogin === true };
  }

  function setEnabled(enabled) {
    if (!supported()) return { supported: false, enabled: false };
    const executablePath = options.executablePath || process.execPath;
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
