const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  applyLegacyAdoption,
  processPendingLegacyAdoptions,
  previewLegacyAdoption,
} = require("../src/main/services/legacy-adoption.cjs");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fixture({ activeRunCount = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-adopt-"));
  const dataRoot = path.join(root, "desktop");
  const legacyLocalAppData = path.join(root, "legacy-local");
  const runtimeLocalAppData = path.join(root, "desktop-runtime");
  const sourceProfileHome = path.join(root, "source-profile");
  const targetProfileHome = path.join(dataRoot, "profile-home");
  const workspace = path.join(root, "workspace");
  const codexHome = path.join(root, ".codex");
  const name = "codex-assistant-2";
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  writeJson(path.join(sourceProfileHome, ".lark-cli", "config.json"), {
    apps: [{ name, appId: "cli_test2", appSecret: "secret", brand: "feishu", users: [] }],
  });
  writeJson(path.join(targetProfileHome, ".lark-cli", "config.json"), { apps: [] });
  const sourceState = path.join(legacyLocalAppData, "CodexFeishuBridge", "instances", name, "state");
  writeJson(path.join(sourceState, "sessions.json"), { version: 1 });
  writeJson(path.join(sourceState, "seen-events.json"), ["event-1"]);
  fs.writeFileSync(path.join(sourceState, "bridge.pid"), "123\n", "utf8");
  const instance = {
    name,
    processId: 123,
    online: true,
    activeRunCount,
    workspace,
    codexHome,
    larkProfile: name,
    stateDir: sourceState,
    logDir: path.join(path.dirname(sourceState), "logs"),
  };
  const calls = [];
  const options = {
    dataRoot,
    legacyLocalAppData,
    runtimeLocalAppData,
    sourceProfileHome,
    targetProfileHome,
    defaultCodexHome: codexHome,
    discoverBridge: () => ({ instances: [instance] }),
    taskExists: () => true,
    disableTask: (value) => calls.push(["disable", value]),
    restoreTask: (value) => calls.push(["restore", value]),
    stopLegacy: async (value) => calls.push(["stop-legacy", value]),
    startManaged: async (value) => calls.push(["start-managed", value]),
    stopManaged: async (value) => calls.push(["stop-managed", value]),
    isProcessAlive: () => false,
  };
  return { root, dataRoot, runtimeLocalAppData, targetProfileHome, name, options, calls };
}

test("preview blocks a legacy Bot with an active run", () => {
  const value = fixture({ activeRunCount: 1 });
  try {
    const [preview] = previewLegacyAdoption([], value.options);
    assert.equal(preview.ready, false);
    assert.equal(preview.queueable, true);
    assert.match(preview.blockers.join(" "), /1 个活动任务/);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("adoption preserves paths and persistent state while changing ownership", async () => {
  const value = fixture();
  try {
    const result = await applyLegacyAdoption([value.name], value.options);
    assert.deepEqual(result.adopted, [value.name], JSON.stringify(result));
    assert.deepEqual(value.calls, [
      ["disable", value.name],
      ["stop-legacy", value.name],
      ["start-managed", value.name],
    ]);
    const bot = JSON.parse(fs.readFileSync(path.join(value.dataRoot, "managed-bots", value.name, "bot.json"), "utf8"));
    assert.equal(bot.workspace, value.options.discoverBridge().instances[0].workspace);
    assert.equal(bot.codexHome, value.options.discoverBridge().instances[0].codexHome);
    assert.equal(bot.legacyAdoption.source, "script-watchdog");
    const targetConfig = JSON.parse(fs.readFileSync(path.join(value.targetProfileHome, ".lark-cli", "config.json"), "utf8"));
    assert.equal(targetConfig.apps.find((item) => item.name === value.name).appSecret, "secret");
    const targetState = path.join(value.runtimeLocalAppData, "CodexFeishuBridge", "instances", value.name, "state");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(targetState, "sessions.json"), "utf8")), { version: 1 });
    assert.equal(fs.existsSync(path.join(targetState, "bridge.pid")), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(targetState, "active-runs.json"), "utf8")), { runs: {} });
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("an active Bot is queued and adopted automatically after it becomes idle", async () => {
  const value = fixture({ activeRunCount: 1 });
  try {
    const queued = await applyLegacyAdoption([value.name], value.options);
    assert.deepEqual(queued.queued, [value.name]);
    assert.deepEqual(value.calls, []);
    value.options.discoverBridge().instances[0].activeRunCount = 0;
    const processed = await processPendingLegacyAdoptions(value.options);
    assert.deepEqual(processed.adopted, [value.name]);
    assert.equal(fs.existsSync(path.join(value.dataRoot, "pending-legacy-adoptions.json")), false);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("adoption reuses an already imported matching Profile", async () => {
  const value = fixture();
  const sourceConfig = JSON.parse(fs.readFileSync(path.join(value.options.sourceProfileHome, ".lark-cli", "config.json"), "utf8"));
  writeJson(path.join(value.targetProfileHome, ".lark-cli", "config.json"), sourceConfig);
  try {
    const [preview] = previewLegacyAdoption([], value.options);
    assert.equal(preview.ready, true);
    const result = await applyLegacyAdoption([value.name], value.options);
    assert.deepEqual(result.adopted, [value.name]);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("a failed managed start rolls back profile, runtime, config, and watchdog", async () => {
  const value = fixture();
  value.options.startManaged = async () => { throw new Error("start failed"); };
  try {
    const result = await applyLegacyAdoption([value.name], value.options);
    assert.equal(result.failed.length, 1);
    assert.equal(fs.existsSync(path.join(value.dataRoot, "managed-bots", value.name)), false);
    assert.equal(fs.existsSync(path.join(value.runtimeLocalAppData, "CodexFeishuBridge", "instances", value.name)), false);
    const targetConfig = JSON.parse(fs.readFileSync(path.join(value.targetProfileHome, ".lark-cli", "config.json"), "utf8"));
    assert.equal(targetConfig.apps.some((item) => item.name === value.name), false);
    assert.deepEqual(value.calls, [
      ["disable", value.name],
      ["stop-legacy", value.name],
      ["stop-managed", value.name],
      ["restore", value.name],
    ]);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});
