const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function verifyPackagedEngineDependencies({ engineRoot, nodeRuntime, runFormulaSmoke = false }) {
  const required = [
    path.join(engineRoot, "node_modules", "katex", "package.json"),
    path.join(engineRoot, "node_modules", "katex", "dist", "fonts", "KaTeX_Main-Regular.woff2"),
    path.join(engineRoot, "node_modules", "playwright-core", "package.json"),
    path.join(engineRoot, "scripts", "check-formula-runtime-dependencies.mjs"),
    nodeRuntime,
  ];
  for (const item of required) {
    if (!fs.existsSync(item)) throw new Error(`Packaged formula runtime item is missing: ${item}`);
  }

  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-engine-"));
  const isolatedEngine = path.join(isolatedRoot, "engine");
  try {
    fs.cpSync(engineRoot, isolatedEngine, { recursive: true });
    execFileSync(nodeRuntime, [
      path.join(isolatedEngine, "scripts", "check-formula-runtime-dependencies.mjs"),
    ], {
      cwd: isolatedEngine,
      encoding: "utf8",
      stdio: "pipe",
      windowsHide: true,
    });
    if (runFormulaSmoke) {
      const output = execFileSync(nodeRuntime, [
        path.join(isolatedEngine, "scripts", "smoke-formula-renderer.mjs"),
      ], {
        cwd: isolatedEngine,
        encoding: "utf8",
        stdio: "pipe",
        windowsHide: true,
      });
      const result = JSON.parse(String(output || "").trim());
      if (result.skipped || result.stats?.rendered !== 3 || result.stats?.failed !== 0) {
        throw new Error(`Packaged formula renderer smoke failed: ${JSON.stringify(result)}`);
      }
    }
  } finally {
    fs.rmSync(isolatedRoot, { recursive: true, force: true });
  }
}

module.exports = { verifyPackagedEngineDependencies };
