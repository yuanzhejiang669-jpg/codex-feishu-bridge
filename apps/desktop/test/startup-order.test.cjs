const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("registers IPC and reveals the window before awaiting runtime services", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main", "index.cjs"), "utf8");
  const readyBlock = source.slice(source.indexOf("app.whenReady().then"));
  const getStateHandler = readyBlock.indexOf('ipcMain.handle("desktop:get-state"');
  const markWindowReady = readyBlock.indexOf("windowReadiness.markReady()");
  const awaitRuntime = readyBlock.indexOf("await initializeDesktopRuntime(startupState())");

  assert.ok(getStateHandler >= 0, "desktop:get-state must be registered during app readiness");
  assert.ok(markWindowReady > getStateHandler, "the window must be revealed only after IPC registration");
  assert.ok(awaitRuntime > markWindowReady, "runtime services must not block initial window creation");
});
