const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { TOOL_ENTRIES, shouldStageToolEntry, stageTools } = require("../scripts/stage-engine.cjs");

function walkFiles(directory, relative = "") {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const childRelative = path.join(relative, entry.name);
    return entry.isDirectory()
      ? walkFiles(path.join(directory, entry.name), childRelative)
      : [childRelative.split(path.sep).join("/")];
  }).sort();
}

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

test("staged desktop Bridge engine tools match repository sources byte-for-byte with exact 4-file whitelist", () => {
  const desktopRoot = path.resolve(__dirname, "..");
  const repositoryRoot = path.resolve(desktopRoot, "..", "..");
  const stagedToolsRoot = path.join(desktopRoot, "generated", "engine", "tools");
  const expectedFiles = [
    "firecrawl-router/server.py",
    "router_file_lock.py",
    "tavily-router/server.py",
    "tavily-router/tavily_router_core.py",
  ];
  assert.deepEqual(walkFiles(stagedToolsRoot), expectedFiles);
  for (const relative of expectedFiles) {
    assert.deepEqual(
      fs.readFileSync(path.join(stagedToolsRoot, relative)),
      fs.readFileSync(path.join(repositoryRoot, "tools", relative)),
      `staged tool file drifted from repository source: tools/${relative}`,
    );
  }
  for (const excludedDir of ["codex-browser-control-mcp", "codex-desktop-control-mcp", "codex-android-control-mcp", "mineru"]) {
    assert.equal(fs.existsSync(path.join(stagedToolsRoot, excludedDir)), false);
  }
});

test("staged tool payload contains only the three-source whitelist and four runtime files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-stage-tools-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  for (const relative of TOOL_ENTRIES) {
    const file = path.join(source, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (relative.endsWith(".py")) fs.writeFileSync(file, "lock source\n");
    else fs.mkdirSync(file, { recursive: true });
  }
  for (const [relative, body] of [
    ["tools/tavily-router/server.py", "tavily server\n"],
    ["tools/tavily-router/tavily_router_core.py", "tavily core\n"],
    ["tools/tavily-router/test_router.py", "test\n"],
    ["tools/tavily-router/test_router_test.py", "test\n"],
    ["tools/tavily-router/pool.json", "{}\n"],
    ["tools/tavily-router/state.json", "{}\n"],
    ["tools/tavily-router/pool-state.json", "{}\n"],
    ["tools/tavily-router/tavily-key-pool.json", "{}\n"],
    ["tools/tavily-router/backup-pool-v2.json", "{}\n"],
    ["tools/tavily-router/custom-state-1.json", "{}\n"],
    ["tools/tavily-router/app.secret.json", "{}\n"],
    ["tools/tavily-router/cache.pyc", "cache\n"],
    ["tools/tavily-router/trace.log", "log\n"],
    ["tools/tavily-router/tmp.tmp", "temp\n"],
    ["tools/tavily-router/router.lock", "lock\n"],
    ["tools/tavily-router/router.bak", "bak\n"],
    ["tools/tavily-router/router.sqlite3", "db\n"],
    ["tools/tavily-router/.env", "secret\n"],
    ["tools/tavily-router/.env.local", "secret\n"],
    ["tools/tavily-router/__pycache__/module.pyc", "cache\n"],
    ["tools/tavily-router/.pytest_cache/cache.json", "{}\n"],
    ["tools/tavily-router/venv/bin.py", "venv\n"],
    ["tools/firecrawl-router/server.py", "firecrawl server\n"],
    ["tools/firecrawl-router/firecrawl-key-pool.json", "{}\n"],
    ["tools/firecrawl-router/firecrawl-router-state.json", "{}\n"],
    ["tools/firecrawl-router/test_server.py", "test\n"],
    ["tools/codex-browser-control-mcp/server.py", "must not be staged\n"],
  ]) {
    const file = path.join(source, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  const benignJson = path.join(root, "config.json");
  fs.writeFileSync(benignJson, "{}\n");
  assert.equal(shouldStageToolEntry(benignJson), true);
  stageTools(source, target);
  assert.deepEqual(walkFiles(path.join(target, "tools")), [
    "firecrawl-router/server.py",
    "router_file_lock.py",
    "tavily-router/server.py",
    "tavily-router/tavily_router_core.py",
  ]);
  assert.equal(fs.readFileSync(path.join(target, "tools/firecrawl-router/server.py"), "utf8"), "firecrawl server\n");
  assert.equal(shouldStageToolEntry(path.join(source, "tools/tavily-router/__pycache__")), false);
  assert.equal(shouldStageToolEntry(path.join(source, "tools/firecrawl-router/firecrawl-key-pool.json")), false);
  assert.equal(shouldStageToolEntry(path.join(source, "tools/firecrawl-router/firecrawl-router-state.json")), false);
});
