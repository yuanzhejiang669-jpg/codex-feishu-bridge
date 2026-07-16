const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  readDesktopSettings,
  settingsPath,
  writeDesktopSettings,
} = require("../src/main/services/desktop-settings.cjs");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cfb-settings-test-"));
}

test("uses safe desktop settings defaults", () => {
  const root = tempRoot();
  try {
    assert.deepEqual(readDesktopSettings(root), { launchAtLogin: false, closeToTray: true, error: "" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writes desktop settings atomically and preserves unspecified values", () => {
  const root = tempRoot();
  try {
    writeDesktopSettings(root, { launchAtLogin: true });
    const result = writeDesktopSettings(root, { closeToTray: false });
    assert.deepEqual(result, { launchAtLogin: true, closeToTray: false, error: "" });
    assert.equal(JSON.parse(fs.readFileSync(settingsPath(root), "utf8")).launchAtLogin, true);
    assert.equal(fs.readdirSync(root).some((name) => /\.(tmp|bak)$/.test(name)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a damaged settings file instead of overwriting it", () => {
  const root = tempRoot();
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(settingsPath(root), "not-json", "utf8");
    assert.match(readDesktopSettings(root).error, /JSON/);
    assert.throws(() => writeDesktopSettings(root, { launchAtLogin: true }), /设置损坏/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
