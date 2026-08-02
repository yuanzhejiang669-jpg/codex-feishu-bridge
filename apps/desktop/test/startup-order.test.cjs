const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("registers IPC and reveals the window before awaiting runtime services", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main", "index.cjs"), "utf8");
  const readyBlock = source.slice(source.indexOf("app.whenReady().then"));
  const getVersionHandler = readyBlock.indexOf('ipcMain.handle("desktop:get-version"');
  const getStateHandler = readyBlock.indexOf('ipcMain.handle("desktop:get-state"');
  const markWindowReady = readyBlock.indexOf("windowReadiness.markReady()");
  const awaitRuntime = readyBlock.indexOf("await initializeDesktopRuntime(startupState())");

  assert.ok(getVersionHandler >= 0, "desktop:get-version must not depend on runtime state");
  assert.ok(getStateHandler >= 0, "desktop:get-state must be registered during app readiness");
  assert.ok(markWindowReady > getStateHandler, "the window must be revealed only after IPC registration");
  assert.ok(awaitRuntime > markWindowReady, "runtime services must not block initial window creation");
});

test("renderer does not hard-code a release version", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "index.html"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "..", "src", "preload", "index.cjs"), "utf8");
  assert.doesNotMatch(html, /v\d+\.\d+\.\d+/);
  assert.match(preload, /desktop:get-version/);
});
