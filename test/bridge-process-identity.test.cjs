const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const test = require("node:test");
const { inspectBridgeOwners, inspectBridgeState, matchesBridgeOwner, windowsProcesses } = require("../src/runtime/bridge-process-identity.cjs");

const owner = { pid: 3112, startedAt: 1000, entryPath: "C:\\Program Files\\Bridge\\codex-feishu-bridge.mjs", processStartTime: 900 };
const valid = { pid: 3112, name: "node.exe", commandLine: '"C:\\Program Files\\Bridge\\node.exe" "C:\\Program Files\\Bridge\\codex-feishu-bridge.mjs"', createdAt: 900 };

test("rejects a recycled PID owned by a Windows service or another Bridge lifetime", () => {
  assert.equal(matchesBridgeOwner(valid, owner), true);
  assert.equal(matchesBridgeOwner({ ...valid, name: "svchost.exe" }, owner), false);
  assert.equal(matchesBridgeOwner({ ...valid, createdAt: 1100 }, owner), false);
  assert.equal(matchesBridgeOwner({ ...valid, commandLine: 'node.exe C:\\different\\codex-feishu-bridge.mjs' }, owner), false);
  assert.equal(matchesBridgeOwner({ ...valid, commandLine: 'node.exe -e "codex-feishu-bridge.mjs"' }, owner), false);
});

test("accepts an old lock only when the actual Bridge process predates that lock", () => {
  const legacy = { pid: 3112, startedAt: 1000 };
  assert.equal(matchesBridgeOwner(valid, legacy), true);
  assert.equal(matchesBridgeOwner({ ...valid, createdAt: 1001 }, legacy), false);
  assert.equal(matchesBridgeOwner(valid, { pid: 3112 }), false);
});

test("batches Windows PID inspection and fails closed when the query is unavailable", () => {
  let calls = 0;
  const options = { platform: "win32", execFileSync: (exe, args, settings) => {
    calls++;
    assert.equal(exe, "powershell.exe");
    assert.equal(settings.windowsHide, true);
    const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
    assert.match(script, /ProcessId=3112 OR ProcessId=42/);
    return JSON.stringify([valid]);
  } };
  assert.deepEqual(inspectBridgeOwners([owner, { pid: 42 }], options).map((item) => item.status), ["alive", "stale"]);
  assert.equal(calls, 1);
  assert.equal(inspectBridgeOwners([owner], { platform: "win32", execFileSync: () => { throw new Error("access denied"); } })[0].status, "unknown");
  assert.equal(inspectBridgeOwners([owner], { platform: "win32", execFileSync: () => JSON.stringify([{ ...valid, commandLine: null }]) })[0].status, "unknown");
});

test("does not interpret a fresh partial ownership file as stale", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-process-identity-"));
  try {
    fs.writeFileSync(path.join(root, "bridge.lock.json"), "");
    fs.writeFileSync(path.join(root, "bridge.pid"), String(process.pid));
    assert.equal(inspectBridgeState(root).status, "unknown");
    assert.equal(fs.readFileSync(path.join(root, "bridge.lock.json"), "utf8"), "");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Windows stop leaves an unrelated real process alive when its PID appears in a stale Bridge state", { skip: process.platform !== "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-process-stop-"));
  const stateDir = path.join(root, "CodexFeishuBridge", "instances", "identity-test", "state");
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "bridge.pid"), String(child.pid));
    fs.writeFileSync(path.join(stateDir, "bridge.lock.json"), JSON.stringify({ pid: child.pid, startedAt: 1 }));
    const infos = windowsProcesses([child.pid]);
    assert.equal(infos.length, 1);
    assert.equal(inspectBridgeState(stateDir).status, "stale");
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", path.resolve(__dirname, "..", "stop-codex-feishu-bridge.ps1"), "-Name", "identity-test", "-Force"], {
      windowsHide: true, encoding: "utf8", timeout: 20_000, env: { ...process.env, LOCALAPPDATA: root },
    });
    assert.match(output, /unrelated processes were left running/);
    assert.doesNotThrow(() => process.kill(child.pid, 0));
    assert.equal(fs.existsSync(path.join(stateDir, "bridge.pid")), false);
  } finally {
    child.kill();
    await new Promise((resolve) => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows recognizes a real Bridge entry only for its exact process lifetime", { skip: process.platform !== "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-process-live-"));
  const entry = path.join(root, "codex-feishu-bridge.mjs");
  fs.writeFileSync(entry, "console.log('ready');setInterval(()=>{},1000);\n");
  const child = spawn(process.execPath, [entry], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  try {
    await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("error", reject); child.once("exit", () => reject(new Error("Fixture exited before it was inspected"))); });
    const [info] = windowsProcesses([child.pid]);
    const record = { pid: child.pid, startedAt: Date.now(), entryPath: entry, processStartTime: info.createdAt };
    assert.equal(inspectBridgeOwners([record])[0].status, "alive");
    assert.equal(inspectBridgeOwners([{ ...record, processStartTime: record.processStartTime + 1 }])[0].status, "stale");
  } finally {
    child.kill();
    await new Promise((resolve) => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
