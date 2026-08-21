const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("Desktop renders the persistent Pi setup stages and verification results", () => {
  const html = read("src/renderer/index.html");
  const renderer = read("src/renderer/app.js");

  assert.match(html, /id="pi-setup-panel"/);
  assert.match(html, /id="pi-setup-list"/);
  assert.match(renderer, /function renderPiSetup\(setup = \{\}\)/);
  assert.match(renderer, /setup\.piSetup/);
  assert.match(renderer, /APP_QR_SENT: "等待应用扫码"/);
  assert.match(renderer, /USER_AUTH_QR_SENT: "等待用户授权"/);
  assert.match(renderer, /bot\.permissionVerification/);
  assert.match(renderer, /bot\.readiness\.online/);
  assert.match(renderer, /renderPiSetup\(currentState\.setup\)/);
});
