const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { updateManagedBotConfig } = require("../src/main/services/bot-config-editor.cjs");
const { readPending } = require("../src/main/services/claude-reconfiguration.cjs");
const { processEnvironment } = require("../src/main/services/supervisor.cjs");

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-bot-cfg-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "managed-bots", "antigravity-1"), { recursive: true });
  fs.mkdirSync(path.join(root, "managed-bots", "claude-1"), { recursive: true });
  fs.mkdirSync(path.join(root, "claude-homes", "claude-1"), { recursive: true });
  fs.writeFileSync(path.join(root, "claude-providers.json"), JSON.stringify({
    schemaVersion: 1,
    providers: [{
      id: "anthropic-main",
      name: "Anthropic Main",
      baseUrl: "https://api.example.invalid",
      envKey: "CLAUDE_MAIN_KEY",
      model: "claude-opus-5-5",
      effort: "high",
      models: ["claude-opus-5-5", "claude-sonnet-4-5"],
    }],
  }, null, 2));
  fs.writeFileSync(path.join(root, "managed-bots", "antigravity-1", "bot.json"), JSON.stringify({
    schemaVersion: 2,
    name: "antigravity-1",
    label: "Antigravity 1",
    engine: "antigravity",
    provider: { mode: "antigravity", id: "official", name: "Antigravity 官方", model: "", reasoning: "" },
    antigravity: { permissionMode: "default" },
  }, null, 2));
  fs.writeFileSync(path.join(root, "managed-bots", "claude-1", "bot.json"), JSON.stringify({
    schemaVersion: 2,
    name: "claude-1",
    label: "Claude 1",
    engine: "claude",
    claudeHome: path.join(root, "claude-homes", "claude-1"),
    provider: { mode: "claude", id: "anthropic-main", name: "Anthropic Main", model: "claude-opus-5-5", reasoning: "high" },
    claude: { permissionMode: "manual" },
  }, null, 2));
  return { root };
}

test("updateManagedBotConfig switches Antigravity permissionMode and restarts idle online Bot", async (t) => {
  const { root } = createFixture(t);
  const calls = [];
  const res = await updateManagedBotConfig(
    { name: "antigravity-1", permissionMode: "always-proceed", reasoning: "xhigh" },
    {
      dataRoot: root,
      inspectBots: async () => [{ name: "antigravity-1", engine: "antigravity", online: true, activeRunCount: 0 }],
      stopBot: async (n) => calls.push(`stop:${n}`),
      startBot: async (n) => calls.push(`start:${n}`),
    },
  );
  assert.equal(res.applied, "restarted");
  assert.deepEqual(calls, ["stop:antigravity-1", "start:antigravity-1"]);
  const saved = JSON.parse(fs.readFileSync(path.join(root, "managed-bots", "antigravity-1", "bot.json"), "utf8"));
  assert.equal(saved.antigravity.permissionMode, "always-proceed");
  assert.equal(saved.provider.reasoning, "xhigh");
});

test("updateManagedBotConfig queues idle reload when Bot has active runs and never interrupts it", async (t) => {
  const { root } = createFixture(t);
  let stopped = false;
  const res = await updateManagedBotConfig(
    { name: "antigravity-1", permissionMode: "always-proceed" },
    {
      dataRoot: root,
      inspectBots: async () => [{ name: "antigravity-1", engine: "antigravity", online: true, activeRunCount: 2 }],
      stopBot: async () => { stopped = true; },
      startBot: async () => {},
    },
  );
  assert.equal(res.applied, "queued-idle-reload");
  assert.equal(stopped, false);
  assert.ok(readPending(root, "antigravity").bots["antigravity-1"]);
});

test("updateManagedBotConfig updates Claude settings.json retaining max effort and rolls back on write error", async (t) => {
  const { root } = createFixture(t);
  const res = await updateManagedBotConfig(
    { name: "claude-1", permissionMode: "bypassPermissions", model: "claude-opus-5-5", reasoning: "max" },
    { dataRoot: root, inspectBots: async () => [{ name: "claude-1", online: false, activeRunCount: 0 }] },
  );
  assert.equal(res.applied, "saved-offline");
  const native = JSON.parse(fs.readFileSync(path.join(root, "claude-homes", "claude-1", "settings.json"), "utf8"));
  assert.equal(native.modelSettings["claude-opus-5-5"].effortLevel, "max");

  await assert.rejects(
    updateManagedBotConfig(
      { name: "claude-1", model: "claude-sonnet-4-5", reasoning: "low" },
      {
        dataRoot: root,
        writeBotConfig: () => { throw new Error("disk full"); },
      },
    ),
    /disk full/,
  );
  const rolledBackNative = JSON.parse(fs.readFileSync(path.join(root, "claude-homes", "claude-1", "settings.json"), "utf8"));
  assert.equal(rolledBackNative.model, "claude-opus-5-5");
});

test("supervisor defaults missing Claude permissionMode to bypassPermissions", (t) => {
  const { root } = createFixture(t);
  const env = processEnvironment(
    { dataRoot: root, localAppData: root, nodePath: process.execPath, larkCliPath: "lark", platform: "win32" },
    { name: "claude-1", engine: "claude", claudeHome: path.join(root, "claude-homes", "claude-1"), configPath: path.join(root, "bot.json") },
  );
  assert.equal(env.CLAUDE_FEISHU_PERMISSION_MODE, "bypassPermissions");
});
