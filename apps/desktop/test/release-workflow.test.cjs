const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workflow = fs.readFileSync(
  path.join(__dirname, "..", "..", "..", ".github", "workflows", "release-desktop.yml"),
  "utf8",
);

test("stable GitHub releases publish only verified Windows desktop assets", () => {
  assert.match(workflow, /^\s{2}build-windows:\s*$/m);
  assert.match(workflow, /^\s{4}needs: \[build-windows\]\s*$/m);
  assert.match(workflow, /Expected exactly five Windows release assets/);
  assert.match(workflow, /macOS assets must not be published through the Windows stable channel/);
  assert.doesNotMatch(workflow, /^\s{2}build-macos:\s*$/m);
  assert.doesNotMatch(workflow, /macos-release|latest-mac\.yml|Codex-Feishu-Bridge-\*-mac-/);
});

test("release verification protects the packaged Codex runtime detector", () => {
  const verifier = fs.readFileSync(path.join(__dirname, "..", "scripts", "verify-release.cjs"), "utf8");
  assert.match(verifier, /detect-codex\.ps1/);
  assert.match(verifier, /resolve-codex-runtime\.ps1/);
  assert.match(verifier, /Packaged runtime detector differs from source/);
});
