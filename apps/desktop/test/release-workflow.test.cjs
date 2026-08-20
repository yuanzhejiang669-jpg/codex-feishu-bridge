const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workflow = fs.readFileSync(
  path.join(__dirname, "..", "..", "..", ".github", "workflows", "release-desktop.yml"),
  "utf8",
);

test("stable GitHub releases publish verified Windows and macOS desktop assets", () => {
  assert.match(workflow, /^\s{2}build-windows:\s*$/m);
  assert.match(workflow, /^\s{2}build-macos:\s*$/m);
  assert.match(workflow, /^\s{4}needs: \[build-windows, build-macos\]\s*$/m);
  assert.match(workflow, /npm run dist:mac/);
  assert.match(workflow, /CSC_IDENTITY_AUTO_DISCOVERY: "false"/);
  assert.match(workflow, /macos-release/);
  assert.match(workflow, /latest-mac\.yml/);
  assert.match(workflow, /checksums-macos\.txt/);
  assert.match(workflow, /Codex-Feishu-Bridge-\*-mac-\*\.dmg/);
  assert.match(workflow, /Missing required release asset/);
});

test("release verification protects the packaged Codex runtime detector", () => {
  const verifier = fs.readFileSync(path.join(__dirname, "..", "scripts", "verify-release.cjs"), "utf8");
  assert.match(verifier, /detect-codex\.ps1/);
  assert.match(verifier, /resolve-codex-runtime\.ps1/);
  assert.match(verifier, /Packaged runtime detector differs from source/);
});
