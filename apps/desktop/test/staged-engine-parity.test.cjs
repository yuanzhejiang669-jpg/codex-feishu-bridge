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

test("staged desktop Bridge engine includes formula runtime dependencies", () => {
  const engineRoot = path.resolve(__dirname, "..", "generated", "engine");
  for (const relativePath of [
    "node_modules/katex/package.json",
    "node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2",
    "node_modules/markdown-it/package.json",
    "node_modules/playwright-core/package.json",
    "scripts/check-formula-runtime-dependencies.mjs",
  ]) {
    assert.equal(
      fs.existsSync(path.join(engineRoot, relativePath)),
      true,
      `staged formula runtime item is missing: ${relativePath}`,
    );
  }
});

test("staged desktop Bridge engine includes the Pi runtime and capability extension", () => {
  const engineRoot = path.resolve(__dirname, "..", "generated", "engine");
  for (const relativePath of [
    "extensions/pi-capabilities.ts",
    "node_modules/@earendil-works/pi-coding-agent/package.json",
    "src/pi/engine-adapter.mjs",
    "src/pi/setup-state.mjs",
  ]) {
    assert.equal(
      fs.existsSync(path.join(engineRoot, relativePath)),
      true,
      `staged Pi runtime item is missing: ${relativePath}`,
    );
  }
});
