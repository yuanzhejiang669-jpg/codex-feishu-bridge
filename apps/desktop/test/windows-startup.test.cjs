const assert = require("node:assert/strict");
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
