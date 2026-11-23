const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workflow = fs.readFileSync(
  path.join(__dirname, "..", "..", "..", ".github", "workflows", "release-desktop.yml"),
  "utf8",
);

test("stable GitHub releases publish verified Windows and Linux desktop assets without macOS", () => {
  assert.match(workflow, /^\s{2}build-windows:\s*$/m);
  assert.doesNotMatch(workflow, /^\s{2}build-macos:\s*$/m);
  assert.match(workflow, /^\s{2}build-linux:\s*$/m);
  assert.match(workflow, /^\s{4}needs: \[build-windows, build-linux\]\s*$/m);
  assert.match(workflow, /CSC_IDENTITY_AUTO_DISCOVERY: "false"/);
  assert.match(workflow, /windows-release/);
  assert.match(workflow, /latest\.yml/);
  assert.match(workflow, /checksums-windows\.txt/);
  assert.match(workflow, /npm run dist:linux/);
  assert.match(workflow, /linux-release/);
  assert.match(workflow, /checksums-linux\.txt/);
  assert.match(workflow, /Codex-Feishu-Bridge-\*-linux-amd64\.deb/);
  assert.match(workflow, /Missing required release asset/);
});

test("Linux revision tags publish only an isolated Ubuntu prerelease", () => {
  assert.match(workflow, /build-windows:\s*\n\s+if: \$\{\{ !contains\(github\.ref_name, '-linux\.'\) \}\}/);
  assert.match(workflow, /publish-linux:\s*\n\s+needs: \[build-linux\]/);
  assert.match(workflow, /--prerelease/);
  assert.match(workflow, /Codex-Feishu-Bridge-\$\{version\}-linux-amd64\.deb/);
});

test("release verification protects the packaged Codex runtime detector", () => {
  const verifier = fs.readFileSync(path.join(__dirname, "..", "scripts", "verify-release.cjs"), "utf8");
  assert.match(verifier, /detect-codex\.ps1/);
  assert.match(verifier, /resolve-codex-runtime\.ps1/);
  assert.match(verifier, /Packaged runtime detector differs from source/);
});
