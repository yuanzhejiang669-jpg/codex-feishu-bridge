const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const test = require("node:test");

const { stopManagedBot } = require("../src/main/services/supervisor.cjs");

function isAlive(processId) {
  try { process.kill(processId, 0); return true; } catch { return false; }
}

async function waitForFile(filePath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForExit(processId, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(processId)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Process ${processId} remained alive`);
}

function writeProcessTreeFixture(root) {
  const childPidPath = path.join(root, "child.pid");
  const parentScript = path.join(root, "parent.cjs");
  fs.writeFileSync(parentScript, `
    const fs = require("node:fs");
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid), "utf8");
    setInterval(() => {}, 1000);
  `, "utf8");
  const parent = spawn(process.execPath, [parentScript], {
    detached: process.platform === "darwin",
    stdio: "ignore",
  });
  return { childPidPath, parent };
}

test("forced Windows stop terminates the complete Bridge process tree", {
  skip: process.platform !== "win32",
  timeout: 20_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-force-tree-win-"));
  const name = "force-tree-test";
  const stateDir = path.join(root, "CodexFeishuBridge", "instances", name, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const { childPidPath, parent } = writeProcessTreeFixture(root);
  try {
    await waitForFile(childPidPath);
    const childPid = Number(fs.readFileSync(childPidPath, "utf8"));
    fs.writeFileSync(path.join(stateDir, "bridge.pid"), String(parent.pid), "utf8");
    const stopScript = path.resolve(__dirname, "..", "..", "..", "stop-codex-feishu-bridge.ps1");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-File", stopScript, "-Name", name, "-Force"], {
      env: { ...process.env, LOCALAPPDATA: root },
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    await waitForExit(parent.pid);
    await waitForExit(childPid);
  } finally {
    try { process.kill(parent.pid, "SIGKILL"); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("forced macOS stop terminates the detached Bridge process group", {
  skip: process.platform !== "darwin",
  timeout: 20_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-force-tree-mac-"));
  const dataRoot = path.join(root, "data");
  const localAppData = path.join(root, "local");
  const botRoot = path.join(dataRoot, "managed-bots", "force-tree-test");
  const stateDir = path.join(localAppData, "CodexFeishuBridge", "instances", "force-tree-test", "state");
  fs.mkdirSync(botRoot, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(botRoot, "bot.json"), JSON.stringify({
    schemaVersion: 1,
    name: "force-tree-test",
    profile: "force-tree-test",
    workspace: path.join(root, "workspace"),
  }), "utf8");
  const { childPidPath, parent } = writeProcessTreeFixture(root);
  try {
    await waitForFile(childPidPath);
    const childPid = Number(fs.readFileSync(childPidPath, "utf8"));
    fs.writeFileSync(path.join(stateDir, "bridge.pid"), String(parent.pid), "utf8");
    fs.writeFileSync(path.join(stateDir, "active-runs.json"), JSON.stringify({ runs: { stuck: {} } }), "utf8");
    await stopManagedBot("force-tree-test", { dataRoot, localAppData, platform: "darwin", force: true });
    await waitForExit(parent.pid);
    await waitForExit(childPid);
  } finally {
    try { process.kill(-parent.pid, "SIGKILL"); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});
