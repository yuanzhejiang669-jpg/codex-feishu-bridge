const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  inspectManagedBots,
  macosProviderEnvironment,
  managedBotStartArguments,
  managedRuntimeRoot,
  processEnvironment,
  restartOnlineManagedBots,
  waitForMacosProviderEnvironment,
  resolveLarkProfileHome,
  setManagedBotAutoStart,
  startManagedBot,
  stopManagedBot,
  stopManagedBotAndDisableAutoStart,
} = require("../src/main/services/supervisor.cjs");

test("passes only an explicitly recorded reasoning request to the launcher", () => {
  const base = { name: "assistant-1", profile: "assistant-1", workspace: "C:\\workspace" };
  assert.equal(managedBotStartArguments(base, "C:\\codex-home").includes("-Reasoning"), false);
  const args = managedBotStartArguments({ ...base, provider: { reasoning: "xhigh" } }, "C:\\codex-home");
  assert.deepEqual(args.slice(-2), ["-Reasoning", "xhigh"]);
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-desktop-supervisor-test-"));
  const dataRoot = path.join(root, "data");
  const localAppData = path.join(root, "local");
  const botRoot = path.join(dataRoot, "managed-bots", "assistant-1");
  fs.mkdirSync(botRoot, { recursive: true });
  fs.writeFileSync(path.join(botRoot, "bot.json"), JSON.stringify({
    schemaVersion: 1,
    name: "assistant-1",
    profile: "assistant-1",
    workspace: path.join(root, "workspace"),
  }), "utf8");
  return { root, dataRoot, localAppData };
}

test("inspects managed Bot runtime state from the selected local app data", () => {
  const value = fixture();
  try {
    const runtimeRoot = managedRuntimeRoot(value.localAppData, "assistant-1");
    const stateDir = path.join(runtimeRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "bridge.pid"), String(process.pid), "utf8");
    fs.writeFileSync(path.join(stateDir, "active-runs.json"), JSON.stringify({ runs: { one: {} } }), "utf8");
    fs.writeFileSync(path.join(stateDir, "seen-events.json"), JSON.stringify(["event-1"]), "utf8");
    const [bot] = inspectManagedBots(value.dataRoot, value.localAppData);
    assert.equal(bot.online, true);
    assert.equal(bot.activeRunCount, 1);
    assert.equal(bot.runtimeRoot, runtimeRoot);
    assert.equal(bot.messageEventVerified, true);
    assert.equal(bot.messageEventCount, 1);
    assert.match(bot.messageEventVerifiedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("updates auto-start only for a client-managed Bot", () => {
  const value = fixture();
  try {
    const enabled = setManagedBotAutoStart("assistant-1", true, { dataRoot: value.dataRoot });
    assert.equal(enabled.autoStart, true);
    const disabled = setManagedBotAutoStart("assistant-1", false, { dataRoot: value.dataRoot });
    assert.equal(disabled.autoStart, false);
    assert.equal(fs.readdirSync(path.dirname(disabled.configPath)).some((name) => /\.(tmp|bak)$/.test(name)), false);
    assert.throws(() => setManagedBotAutoStart("legacy-bot", true, { dataRoot: value.dataRoot }), /客户端管理/);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("refuses to stop a managed Bot while it has an active task", async () => {
  const value = fixture();
  try {
    const stateDir = path.join(managedRuntimeRoot(value.localAppData, "assistant-1"), "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "bridge.pid"), String(process.pid), "utf8");
    fs.writeFileSync(path.join(stateDir, "active-runs.json"), JSON.stringify({ runs: { one: {} } }), "utf8");
    await assert.rejects(() => stopManagedBot("assistant-1", {
      dataRoot: value.dataRoot,
      localAppData: value.localAppData,
      force: false,
    }), /活动任务/);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("manual stop disables auto-start so recovery does not immediately restart the Bot", async () => {
  const value = fixture();
  try {
    setManagedBotAutoStart("assistant-1", true, { dataRoot: value.dataRoot });
    await stopManagedBotAndDisableAutoStart("assistant-1", {
      dataRoot: value.dataRoot,
      stopBot: async () => ({ online: false }),
    });
    const [bot] = inspectManagedBots(value.dataRoot, value.localAppData);
    assert.equal(bot.autoStart, false);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("failed manual stop restores the previous auto-start setting", async () => {
  const value = fixture();
  try {
    setManagedBotAutoStart("assistant-1", true, { dataRoot: value.dataRoot });
    await assert.rejects(() => stopManagedBotAndDisableAutoStart("assistant-1", {
      dataRoot: value.dataRoot,
      stopBot: async () => { throw new Error("stop failed"); },
    }), /stop failed/);
    const [bot] = inspectManagedBots(value.dataRoot, value.localAppData);
    assert.equal(bot.autoStart, true);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("restarts online idle Bots sequentially and skips active Bots", async () => {
  const calls = [];
  const progress = [];
  const result = await restartOnlineManagedBots({
    inspectBots: () => [
      { name: "assistant-1", online: true, activeRunCount: 0 },
      { name: "assistant-2", online: true, activeRunCount: 1 },
      { name: "assistant-3", online: false, activeRunCount: 0 },
      { name: "assistant-4", online: true, activeRunCount: 0 },
    ],
    stopBot: async (name) => { calls.push(`stop:${name}`); },
    startBot: async (name) => { calls.push(`start:${name}`); },
    onProgress: (value) => progress.push(value),
  });

  assert.deepEqual(calls, [
    "stop:assistant-1",
    "start:assistant-1",
    "stop:assistant-4",
    "start:assistant-4",
  ]);
  assert.deepEqual(result.restarted, ["assistant-1", "assistant-4"]);
  assert.deepEqual(result.skippedActive, [{ name: "assistant-2", activeRunCount: 1 }]);
  assert.deepEqual(result.failed, []);
  assert.equal(progress.at(-1).stage, "restarted");
});

test("continues a batch restart after one Bot fails", async () => {
  const calls = [];
  const result = await restartOnlineManagedBots({
    inspectBots: () => [
      { name: "assistant-1", online: true, activeRunCount: 0 },
      { name: "assistant-2", online: true, activeRunCount: 0 },
    ],
    stopBot: async (name) => {
      calls.push(`stop:${name}`);
      if (name === "assistant-1") throw new Error("stop failed");
    },
    startBot: async (name) => { calls.push(`start:${name}`); },
  });

  assert.deepEqual(calls, ["stop:assistant-1", "stop:assistant-2", "start:assistant-2"]);
  assert.deepEqual(result.restarted, ["assistant-2"]);
  assert.deepEqual(result.failed, [{ name: "assistant-1", error: "stop failed" }]);
});

test("does not start a Bot when a task becomes active during batch restart", async () => {
  let started = false;
  const result = await restartOnlineManagedBots({
    inspectBots: () => [{ name: "assistant-1", online: true, activeRunCount: 0 }],
    stopBot: async () => { throw new Error("Bot 仍有 1 个活动任务，已拒绝停止"); },
    startBot: async () => { started = true; },
  });

  assert.equal(started, false);
  assert.deepEqual(result.restarted, []);
  assert.match(result.failed[0].error, /活动任务/);
});

test("builds a child environment with exact bundled tools and isolated profile home", () => {
  const clientRoot = path.join(os.tmpdir(), "Client Program");
  const dataRoot = path.join(os.tmpdir(), "ClientData");
  const runtimeRoot = path.join(os.tmpdir(), "RuntimeData");
  const nodePath = path.join(clientRoot, process.platform === "win32" ? "node.exe" : "node");
  const larkCliPath = path.join(clientRoot, process.platform === "win32" ? "lark-cli.exe" : "lark-cli");
  const env = processEnvironment({
    dataRoot,
    localAppData: runtimeRoot,
    nodePath,
    larkCliPath,
  });
  assert.equal(env.LOCALAPPDATA, runtimeRoot);
  assert.equal(env.USERPROFILE, path.join(dataRoot, "profile-home"));
  assert.equal(env.HOME, path.join(dataRoot, "profile-home"));
  assert.equal(env.LARK_CLI_BIN, larkCliPath);
  assert.equal(env.PATH.split(path.delimiter)[0], clientRoot);
});

test("uses a short symlinked Lark Profile home on macOS for Unix socket compatibility", {
  skip: process.platform !== "darwin",
}, () => {
  const value = fixture();
  const alias = path.join(value.root, ".cfb-lark-profile");
  try {
    const resolved = resolveLarkProfileHome({
      dataRoot: value.dataRoot,
      platform: "darwin",
      larkProfileHome: alias,
    });
    assert.equal(resolved, alias);
    assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(alias), fs.realpathSync(path.join(value.dataRoot, "profile-home")));
    const env = processEnvironment({
      dataRoot: value.dataRoot,
      localAppData: value.localAppData,
      nodePath: path.join(value.root, "node"),
      larkCliPath: path.join(value.root, "lark-cli"),
      platform: "darwin",
      larkProfileHome: alias,
    });
    assert.equal(env.HOME, alias);
    assert.equal(env.USERPROFILE, alias);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("adds installed macOS writing tool directories to the child PATH", {
  skip: process.platform === "win32",
}, () => {
  const value = fixture();
  const texBin = path.join(value.root, "Library", "TeX", "texbin");
  const homebrewBin = path.join(value.root, "opt", "homebrew", "bin");
  fs.mkdirSync(texBin, { recursive: true });
  fs.mkdirSync(homebrewBin, { recursive: true });
  try {
    const env = processEnvironment({
      dataRoot: value.dataRoot,
      localAppData: value.localAppData,
      nodePath: path.join(value.root, "node"),
      larkCliPath: path.join(value.root, "lark-cli"),
      platform: "darwin",
      larkProfileHome: path.join(value.root, ".cfb-lark-profile"),
      macosToolDirs: [texBin, homebrewBin, path.join(value.root, "missing")],
    });
    const directories = env.PATH.split(path.delimiter);
    assert.equal(directories.includes(texBin), true);
    assert.equal(directories.includes(homebrewBin), true);
    assert.equal(directories.includes(path.join(value.root, "missing")), false);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("refuses to replace an occupied macOS Lark Profile alias", () => {
  const value = fixture();
  const alias = path.join(value.root, ".cfb-lark-profile");
  try {
    fs.writeFileSync(alias, "occupied", "utf8");
    assert.throws(() => resolveLarkProfileHome({
      dataRoot: value.dataRoot,
      platform: "darwin",
      larkProfileHome: alias,
    }), /短路径已被其他文件占用/);
    assert.equal(fs.readFileSync(alias, "utf8"), "occupied");
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("injects a DPAPI-backed Provider key only into the managed Bot child environment", () => {
  const value = fixture();
  try {
    const configPath = path.join(value.dataRoot, "managed-bots", "assistant-1", "bot.json");
    const bot = JSON.parse(fs.readFileSync(configPath, "utf8"));
    bot.configPath = configPath;
    bot.provider = { mode: "custom", envKey: "BOT_API_KEY" };
    fs.writeFileSync(path.join(path.dirname(configPath), "provider-secret.bin"), Buffer.from("encrypted"));
    const env = processEnvironment({
      dataRoot: value.dataRoot,
      localAppData: value.localAppData,
      nodePath: "C:\\Client\\node.exe",
      larkCliPath: "C:\\Client\\lark-cli.exe",
      decryptSecret: (valueBuffer) => valueBuffer.toString("utf8") === "encrypted" ? "decrypted-key" : "",
    }, bot);
    assert.equal(env.BOT_API_KEY, "decrypted-key");
    assert.equal(process.env.BOT_API_KEY, undefined);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("refreshes macOS Provider keys from launchctl for every Bot start", () => {
  const previous = process.env.LTHOME_API_KEY;
  delete process.env.LTHOME_API_KEY;
  try {
    const environment = macosProviderEnvironment("/Users/example/.codex", { provider: { mode: "current" } }, {
      platform: "darwin",
      inspectProviderCatalog: () => ({
        error: "",
        providers: [
          { id: "lthome", envKey: "LTHOME_API_KEY" },
          { id: "duplicate", envKey: "LTHOME_API_KEY" },
          { id: "openai", envKey: "" },
        ],
      }),
      readLaunchctlEnvironmentVariable: (name) => name === "LTHOME_API_KEY" ? "launchctl-secret\n" : "",
    });
    assert.deepEqual(environment, { LTHOME_API_KEY: "launchctl-secret" });
    assert.equal(process.env.LTHOME_API_KEY, undefined);
  } finally {
    if (previous == null) delete process.env.LTHOME_API_KEY;
    else process.env.LTHOME_API_KEY = previous;
  }
});

test("does not replace a custom Provider key with launchctl state", () => {
  let queried = false;
  const environment = macosProviderEnvironment("/Users/example/.codex", { provider: { mode: "custom" } }, {
    platform: "darwin",
    inspectProviderCatalog: () => { queried = true; return { error: "", providers: [] }; },
  });
  assert.deepEqual(environment, {});
  assert.equal(queried, false);
});

test("waits for the macOS login Provider environment before desktop recovery", async () => {
  const environment = {};
  let launchctlReads = 0;
  let kickstarts = 0;
  const waits = [];
  const result = await waitForMacosProviderEnvironment("/Users/example/.codex", {
    platform: "darwin",
    attempts: 3,
    delayMs: 500,
    environment,
    inspectProviderCatalog: () => ({
      error: "",
      providers: [
        { id: "lthome", envKey: "LTHOME_API_KEY" },
        { id: "sub2api", envKey: "SUB2API_API_KEY" },
      ],
    }),
    prepareProviderEnvironment: () => { kickstarts += 1; },
    readLaunchctlEnvironmentVariable: (name) => {
      launchctlReads += 1;
      if (launchctlReads <= 2) return "";
      return `${name.toLowerCase()}-secret`;
    },
    wait: async (duration) => { waits.push(duration); },
  });

  assert.equal(result.ready, true);
  assert.equal(result.attempt, 2);
  assert.deepEqual(result.missingNames, []);
  assert.deepEqual(result.loadedNames, ["LTHOME_API_KEY", "SUB2API_API_KEY"]);
  assert.equal(environment.LTHOME_API_KEY, "lthome_api_key-secret");
  assert.equal(environment.SUB2API_API_KEY, "sub2api_api_key-secret");
  assert.equal(kickstarts, 1);
  assert.deepEqual(waits, [500]);
});

test("bounds macOS login Provider environment retries", async () => {
  const result = await waitForMacosProviderEnvironment("/Users/example/.codex", {
    platform: "darwin",
    attempts: 2,
    delayMs: 1,
    environment: {},
    inspectProviderCatalog: () => ({
      error: "",
      providers: [{ id: "lthome", envKey: "LTHOME_API_KEY" }],
    }),
    readLaunchctlEnvironmentVariable: () => "",
    wait: async () => {},
  });

  assert.equal(result.ready, false);
  assert.equal(result.attempt, 2);
  assert.deepEqual(result.loadedNames, []);
  assert.deepEqual(result.missingNames, ["LTHOME_API_KEY"]);
});

test("starts and stops through the direct macOS launcher contract", async () => {
  const value = fixture();
  try {
    const engineRoot = path.join(value.root, "engine");
    const toolsRoot = path.join(value.root, "tools");
    const larkCliPath = path.join(toolsRoot, "lark-cli");
    const bridgeEntry = path.join(engineRoot, "bridge-fixture.cjs");
    fs.mkdirSync(engineRoot, { recursive: true });
    fs.mkdirSync(toolsRoot, { recursive: true });
    fs.writeFileSync(larkCliPath, "fixture", "utf8");
    fs.writeFileSync(bridgeEntry, [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const state = process.env.CODEX_FEISHU_STATE_DIR;',
      'fs.mkdirSync(state, { recursive: true });',
      'fs.writeFileSync(path.join(state, "bridge.pid"), String(process.pid));',
      'const timer = setInterval(() => {',
      '  if (fs.existsSync(path.join(state, "bridge.stop"))) { clearInterval(timer); process.exit(0); }',
      '}, 50);',
    ].join("\n"), "utf8");
    const options = {
      dataRoot: value.dataRoot,
      localAppData: value.localAppData,
      engineRoot,
      bridgeEntry,
      nodePath: process.execPath,
      larkCliPath,
      codexPath: process.execPath,
      defaultCodexHome: path.join(value.root, "codex-home"),
      codexAvailable: true,
      platform: process.platform === "win32" ? "linux" : "darwin",
      larkProfileHome: path.join(value.root, ".cfb-lark-profile"),
    };
    const started = await startManagedBot("assistant-1", options);
    assert.equal(started.online, true);
    assert.notEqual(started.processId, process.pid);
    const launch = JSON.parse(fs.readFileSync(path.join(started.runtimeRoot, "state", "launch-config.json"), "utf8"));
    assert.equal(launch.larkProfile, "assistant-1");
    const stopped = await stopManagedBot("assistant-1", options);
    assert.equal(stopped.online, false);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("starts through the packaged PowerShell contract and confirms a live PID", { skip: process.platform !== "win32" }, async () => {
  const value = fixture();
  try {
    const engineRoot = path.join(value.root, "engine");
    const toolsRoot = path.join(value.root, "tools");
    const nodePath = path.join(toolsRoot, "node.exe");
    const larkCliPath = path.join(toolsRoot, "lark-cli.exe");
    fs.mkdirSync(engineRoot, { recursive: true });
    fs.mkdirSync(toolsRoot, { recursive: true });
    fs.writeFileSync(nodePath, "", "utf8");
    fs.writeFileSync(larkCliPath, "", "utf8");
    fs.writeFileSync(path.join(engineRoot, "start-codex-feishu-bridge.ps1"), [
      "param([string]$Name, [string]$LarkProfile, [string]$Workspace, [string]$CodexHome)",
      "$state = Join-Path (Join-Path (Join-Path $env:LOCALAPPDATA 'CodexFeishuBridge') 'instances') (Join-Path $Name 'state')",
      "New-Item -ItemType Directory -Force -Path $state | Out-Null",
      `Set-Content -LiteralPath (Join-Path $state 'bridge.pid') -Value '${process.pid}' -Encoding ASCII`,
    ].join("\r\n"), "utf8");
    const result = await startManagedBot("assistant-1", {
      dataRoot: value.dataRoot,
      localAppData: value.localAppData,
      engineRoot,
      nodePath,
      larkCliPath,
      defaultCodexHome: path.join(value.root, "codex-home"),
      codexAvailable: true,
    });
    assert.equal(result.online, true);
    assert.equal(result.processId, process.pid);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});
