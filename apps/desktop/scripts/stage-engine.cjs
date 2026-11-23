const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const desktopRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(desktopRoot, "..", "..");
const generatedRoot = path.join(desktopRoot, "generated");
const engineRoot = path.join(generatedRoot, "engine");

const files = [
  ".env.example",
  "LICENSE",
  "bridge.instances.json",
  "codex-feishu-bridge.mjs",
  "control-panel.mjs",
  "doctor-codex-feishu-bridge.ps1",
  "install-codex-feishu-watchdog.ps1",
  "install-control-panel-watchdog.ps1",
  "package-lock.json",
  "package.json",
  "register-codex-feishu-bot.mjs",
  "register-codex-feishu-bot.ps1",
  "start-codex-feishu-bridge-hidden.vbs",
  "start-codex-feishu-bridge.ps1",
  "start-control-panel-hidden.vbs",
  "start-control-panel.ps1",
  "stop-codex-feishu-bridge.ps1",
  "stop-control-panel.ps1",
  "watch-codex-feishu-bridge-hidden.vbs",
  "watch-codex-feishu-bridge.ps1",
];

const directories = ["config", "control-panel", "scripts", "src"];

function assertInside(parent, child) {
  const relative = path.relative(parent, child);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to stage outside the generated directory: ${child}`);
  }
}

function copyItem(relativePath) {
  const source = path.join(repositoryRoot, relativePath);
  const target = path.join(engineRoot, relativePath);
  if (!fs.existsSync(source)) throw new Error(`Required Bridge engine item is missing: ${source}`);
  fs.cpSync(source, target, { recursive: true, force: true });
}

function gitCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

const TOOL_ENTRIES = [
  "tools/router_file_lock.py",
  "tools/tavily-router",
  "tools/firecrawl-router",
];

const EXCLUDED_TOOL_DIRS = new Set([
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".venv",
  "venv",
  "node_modules",
]);

const EXCLUDED_TOOL_EXTS = new Set([
  ".pyc",
  ".pyo",
  ".pyd",
  ".tmp",
  ".log",
  ".lock",
  ".bak",
  ".sqlite",
  ".sqlite3",
]);

const EXCLUDED_TOOL_FILE_PATTERNS = [
  /^.*(?:pool|state).*\.json$/i,
  /\.secret/i,
  /^\.env(?:\..+)?$/i,
  /^test_.+\.py$/i,
  /_test\.py$/i,
];

function shouldStageToolEntry(sourcePath) {
  const base = path.basename(sourcePath);
  const lower = base.toLowerCase();
  let stat;
  try {
    stat = fs.lstatSync(sourcePath);
  } catch {
    return false;
  }
  if (stat.isDirectory()) {
    return !EXCLUDED_TOOL_DIRS.has(lower);
  }
  const ext = path.extname(lower);
  if (EXCLUDED_TOOL_EXTS.has(ext)) return false;
  if (EXCLUDED_TOOL_FILE_PATTERNS.some((pattern) => pattern.test(base))) return false;
  return true;
}

function stageTools(sourceRoot = repositoryRoot, targetEngineRoot = engineRoot) {
  for (const relativePath of TOOL_ENTRIES) {
    const source = path.join(sourceRoot, relativePath);
    const target = path.join(targetEngineRoot, relativePath);
    if (!fs.existsSync(source)) {
      throw new Error(`Required Bridge tool item is missing: ${source}`);
    }
    assertInside(targetEngineRoot, target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, {
      recursive: true,
      force: true,
      filter: (src) => shouldStageToolEntry(src),
    });
  }
}

function stageEngine() {
  assertInside(desktopRoot, generatedRoot);
  fs.rmSync(generatedRoot, { recursive: true, force: true });
  fs.mkdirSync(engineRoot, { recursive: true });

  for (const item of files) copyItem(item);
  for (const item of directories) copyItem(item);
  stageTools();

  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (!fs.existsSync(npmCli)) throw new Error(`npm CLI entry is unavailable: ${npmCli}`);
  const install = spawnSync(process.execPath, [npmCli, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: engineRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (install.status !== 0) {
    process.stderr.write(install.stdout || "");
    process.stderr.write(install.stderr || "");
    throw new Error(`Failed to install staged Bridge production dependencies: ${install.error?.message || install.status}`);
  }

  const manifest = {
    schemaVersion: 1,
    protocolVersion: 1,
    sourceCommit: gitCommit(),
    sourceDirty: spawnSync('git', ['status', '--porcelain'], { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true }).stdout?.trim().length > 0,
    generatedAt: new Date().toISOString(),
    entrypoints: {
      bridge: "codex-feishu-bridge.mjs",
      controlPanel: "control-panel.mjs",
      register: "register-codex-feishu-bot.mjs",
    },
  };
  fs.writeFileSync(path.join(engineRoot, "desktop-engine-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`Staged Bridge engine from ${manifest.sourceCommit}\n`);
}

if (require.main === module) stageEngine();
module.exports = { TOOL_ENTRIES, shouldStageToolEntry, stageTools, stageEngine };
