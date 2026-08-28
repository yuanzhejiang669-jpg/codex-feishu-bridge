const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createWindowsStartup } = require("../src/main/services/windows-startup.cjs");

test("uses the background argument for Windows login startup", () => {
  let stored = false;
  let applied = null;
  const fakeApp = {
    isPackaged: true,
    setLoginItemSettings(value) { applied = value; stored = value.openAtLogin; },
    getLoginItemSettings() { return { openAtLogin: stored }; },
  };
  const startup = createWindowsStartup(fakeApp, {
    packaged: true,
    platform: "win32",
    executablePath: "C:\\Client\\Bridge.exe",
  });
  assert.deepEqual(startup.setEnabled(true), { supported: true, enabled: true });
  assert.deepEqual(applied, {
    openAtLogin: true,
    path: "C:\\Client\\Bridge.exe",
    args: ["--background"],
  });
  assert.deepEqual(startup.inspect(), { supported: true, enabled: true });
});

test("does not mutate login settings outside packaged Windows", () => {
  let called = false;
  const startup = createWindowsStartup({
    isPackaged: false,
    setLoginItemSettings() { called = true; },
  }, { packaged: false, platform: "win32" });
  assert.deepEqual(startup.setEnabled(true), { supported: false, enabled: false });
  assert.equal(called, false);
});

test("uses the native hidden login item contract on packaged macOS", () => {
  let applied = null;
  const startup = createWindowsStartup({
    isPackaged: true,
    setLoginItemSettings(value) { applied = value; },
    getLoginItemSettings() { return { openAtLogin: true }; },
  }, { packaged: true, platform: "darwin" });
  assert.deepEqual(startup.setEnabled(true), { supported: true, enabled: true });
  assert.deepEqual(applied, { openAtLogin: true, openAsHidden: true });
});

test("writes and removes a marked XDG autostart entry on packaged Linux", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-linux-startup-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const executablePath = "/opt/Codex Feishu Bridge/codex-feishu-bridge";
  const startup = createWindowsStartup({
    isPackaged: true,
    getPath(name) { assert.equal(name, "home"); return home; },
  }, { packaged: true, platform: "linux", executablePath });

  const enabled = startup.setEnabled(true);
  assert.equal(enabled.supported, true);
  assert.equal(enabled.enabled, true);
  const content = fs.readFileSync(enabled.path, "utf8");
  assert.match(content, /X-Codex-Feishu-Bridge-Autostart=true/);
  assert.match(content, /Exec="\/opt\/Codex Feishu Bridge\/codex-feishu-bridge" --background/);
  assert.deepEqual(startup.inspect(), enabled);

  const upgraded = createWindowsStartup({ isPackaged: true, getPath: () => home }, {
    packaged: true,
    platform: "linux",
    executablePath: "/opt/Codex Feishu Bridge 2/codex-feishu-bridge",
  });
  upgraded.setEnabled(true);
  const refreshed = fs.readFileSync(enabled.path, "utf8");
  assert.match(refreshed, /Exec="\/opt\/Codex Feishu Bridge 2\/codex-feishu-bridge" --background/);
  assert.doesNotMatch(refreshed, /Exec="\/opt\/Codex Feishu Bridge\/codex-feishu-bridge" --background/);

  const disabled = upgraded.setEnabled(false);
  assert.equal(disabled.enabled, false);
  assert.equal(fs.existsSync(enabled.path), false);
});

test("does not overwrite an unrelated Linux autostart entry", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-linux-startup-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const destination = path.join(home, ".config", "autostart", "codex-feishu-bridge.desktop");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, "[Desktop Entry]\nName=Foreign\n", "utf8");
  const startup = createWindowsStartup({ isPackaged: true, getPath: () => home }, {
    packaged: true,
    platform: "linux",
    executablePath: "/opt/bridge",
  });

  assert.throws(() => startup.setEnabled(true), /已被其他程序占用/);
  assert.equal(fs.readFileSync(destination, "utf8"), "[Desktop Entry]\nName=Foreign\n");
});
