const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const desktopRoot = path.resolve(__dirname, "..");
const unpackedRoot = path.join(desktopRoot, "out", "win-unpacked");
const executable = path.join(unpackedRoot, "Codex Feishu Bridge.exe");
const engineRoot = path.join(unpackedRoot, "resources", "engine");
const controlPanel = path.join(engineRoot, "control-panel.mjs");
const nodeRuntime = path.join(unpackedRoot, "resources", "tools", "node.exe");
const smokeRoot = path.join(desktopRoot, "out", "smoke-data");
const localAppData = path.join(smokeRoot, "LocalAppData");
const instancesConfig = path.join(smokeRoot, "bridge.instances.local.json");
const port = 18329;

for (const required of [executable, controlPanel, nodeRuntime]) {
  if (!fs.existsSync(required)) throw new Error(`Packaged engine item is missing: ${required}`);
}

fs.rmSync(smokeRoot, { recursive: true, force: true });
fs.mkdirSync(smokeRoot, { recursive: true });
fs.writeFileSync(instancesConfig, `${JSON.stringify({
  schemaVersion: 1,
  device: "desktop-smoke",
  paths: { workspaceRoot: path.join(smokeRoot, "workspaces"), codexHome: path.join(smokeRoot, "codex-home") },
  instances: [],
}, null, 2)}\n`, "utf8");

const child = spawn(nodeRuntime, [controlPanel, "--host", "127.0.0.1", "--port", String(port)], {
  cwd: engineRoot,
  windowsHide: true,
  env: {
    ...process.env,
    LOCALAPPDATA: localAppData,
    CODEX_FEISHU_INSTANCES_CONFIG: instancesConfig,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += String(chunk); });
child.stderr.on("data", (chunk) => { stderr += String(chunk); });

async function waitForHealth() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Packaged engine exited early (${child.exitCode}): ${stderr || stdout}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return response.json();
    } catch {
      // The packaged engine may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Packaged engine health timed out: ${stderr || stdout}`);
}

async function stopChild() {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
}

(async () => {
  try {
    const health = await waitForHealth();
    if (!health || health.ok !== true) throw new Error(`Unexpected health response: ${JSON.stringify(health)}`);
    const productionRoot = path.join(localAppData, "CodexFeishuBridge");
    if (!fs.existsSync(productionRoot)) throw new Error("Packaged engine did not use the isolated smoke data root");
    process.stdout.write(`Packaged engine healthy on ${port}\n`);
  } finally {
    await stopChild();
    fs.rmSync(smokeRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
