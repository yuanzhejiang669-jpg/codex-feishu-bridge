const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("staged desktop Bridge engine matches the repository engine", () => {
  const desktopRoot = path.resolve(__dirname, "..");
  const repositoryEnginePath = path.resolve(desktopRoot, "..", "..", "codex-feishu-bridge.mjs");
  const stagedEnginePath = path.join(desktopRoot, "generated", "engine", "codex-feishu-bridge.mjs");

  assert.equal(
    fs.readFileSync(stagedEnginePath, "utf8"),
    fs.readFileSync(repositoryEnginePath, "utf8"),
    "run npm run stage:engine after changing the Bridge engine so a later client build cannot restore stale code",
  );
});
