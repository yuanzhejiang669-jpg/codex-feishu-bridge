const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanVersion, loginState, parseJsonOutput } = require("../src/main/services/environment.cjs");

test("parseJsonOutput tolerates a BOM and diagnostic prefix", () => {
  assert.deepEqual(parseJsonOutput("\uFEFFdiagnostic\n{\"packageFound\":true}\n"), { packageFound: true });
});

test("cleanVersion reads standard Codex version output", () => {
  assert.equal(cleanVersion("codex-cli 0.144.2"), "0.144.2");
  assert.equal(cleanVersion("codex 1.2.3-beta.1"), "1.2.3-beta.1");
});

test("loginState distinguishes signed in and signed out", () => {
  assert.equal(loginState("Logged in using ChatGPT", true), "signed-in");
  assert.equal(loginState("Not logged in", false), "signed-out");
  assert.equal(loginState("unexpected", false), "unknown");
});

