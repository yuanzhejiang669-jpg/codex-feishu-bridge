const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { cleanVersion, inspectRuntimeDirectory, loginState, parseJsonOutput } = require("../src/main/services/environment.cjs");

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

test("inspectRuntimeDirectory reports the runtime folder and EXE component count", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-runtime-"));
  try {
    fs.writeFileSync(path.join(root, "codex.exe"), "");
    fs.writeFileSync(path.join(root, "rg.exe"), "");
    fs.writeFileSync(path.join(root, "notes.txt"), "");
    assert.deepEqual(inspectRuntimeDirectory(path.join(root, "codex.exe")), {
      runtimeDirectory: root,
      runtimeExecutableCount: 2,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
