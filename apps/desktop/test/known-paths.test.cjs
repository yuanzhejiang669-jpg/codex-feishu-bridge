const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { collectKnownPaths, isKnownPath } = require("../src/main/services/known-paths.cjs");

test("known path allowlist exposes exact discovered paths only", () => {
  const workspace = path.resolve("C:\\work\\paper");
  const state = {
    bridge: { root: "C:\\runtime", instances: [{ workspace, logDir: "C:\\runtime\\logs" }] },
    codex: { runtimePath: "C:\\codex\\codex.exe" },
    capabilities: {
      configPath: "C:\\Users\\test\\.codex\\config.toml",
      skills: [{ path: "C:\\Users\\test\\.codex\\skills\\demo", skillFile: "C:\\Users\\test\\.codex\\skills\\demo\\SKILL.md" }],
      mcpServers: [{ entryPath: "C:\\tools\\demo\\server.py" }],
    },
  };
  const known = collectKnownPaths(state);
  assert.equal(isKnownPath(workspace, known), true);
  assert.equal(isKnownPath(path.join(workspace, "..", "secret"), known), false);
  assert.equal(isKnownPath("C:\\Users\\test\\.codex\\skills\\demo\\SKILL.md", known), true);
  assert.equal(isKnownPath("C:\\tools\\demo\\server.py", known), true);
});
