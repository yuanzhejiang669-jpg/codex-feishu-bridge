const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const TOML = require("smol-toml");
const {
  applyCapabilityMigration,
  containsSensitiveValue,
  previewCapabilityMigration,
} = require("../src/main/services/capability-migration.cjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-capability-test-"));
  const dataRoot = path.join(root, "data");
  const sourceCodexHome = path.join(root, "source-codex");
  const targetCodexHome = path.join(root, "target-codex");
  const botRoot = path.join(dataRoot, "managed-bots", "assistant-1");
  fs.mkdirSync(botRoot, { recursive: true });
  fs.mkdirSync(path.join(sourceCodexHome, "skills", "safe-skill"), { recursive: true });
  fs.writeFileSync(path.join(sourceCodexHome, "skills", "safe-skill", "SKILL.md"), "# Safe skill\n", "utf8");
  fs.writeFileSync(path.join(sourceCodexHome, "config.toml"), [
    "[mcp_servers.safe]",
    'command = "safe.exe"',
    "",
    "[mcp_servers.secret.env]",
    'API_KEY = "must-not-copy"',
    "",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(botRoot, "bot.json"), JSON.stringify({
    schemaVersion: 1,
    name: "assistant-1",
    profile: "assistant-1",
    workspace: path.join(root, "workspace"),
    codexHome: targetCodexHome,
    codexHomeMode: "isolated",
  }), "utf8");
  return { root, dataRoot, sourceCodexHome, targetCodexHome };
}

test("detects nested inline secrets", () => {
  assert.equal(containsSensitiveValue({ env: { API_KEY: "value" } }), true);
  assert.equal(containsSensitiveValue({ command: "tool.exe", args: ["--safe"] }), false);
});

test("previews and applies only ready MCP and Skills", () => {
  const value = fixture();
  try {
    const siblingRoot = path.join(value.dataRoot, "managed-bots", "assistant-2");
    fs.mkdirSync(siblingRoot, { recursive: true });
    fs.writeFileSync(path.join(siblingRoot, "bot.json"), JSON.stringify({
      schemaVersion: 1,
      name: "assistant-2",
      profile: "assistant-2",
      workspace: path.join(value.root, "workspace-2"),
      codexHome: value.targetCodexHome,
      codexHomeMode: "isolated",
    }));
    const selection = { mcpServers: ["safe", "secret"], skills: ["safe-skill"] };
    const options = { dataRoot: value.dataRoot, sourceCodexHome: value.sourceCodexHome };
    const preview = previewCapabilityMigration("assistant-1", selection, options);
    assert.equal(preview.summary.ready, 2);
    assert.deepEqual(preview.affectedBots, ["assistant-1", "assistant-2"]);
    assert.equal(preview.mcpServers.find((item) => item.name === "safe").sourcePath, path.join(value.sourceCodexHome, "config.toml"));
    assert.equal(preview.skills.find((item) => item.name === "safe-skill").targetPath, path.join(value.targetCodexHome, "skills", "safe-skill"));
    assert.equal(preview.mcpServers.find((item) => item.name === "secret").status, "blocked-sensitive");
    const result = applyCapabilityMigration("assistant-1", selection, options);
    assert.equal(result.applied, 2);
    assert.equal(fs.existsSync(path.join(value.targetCodexHome, "skills", "safe-skill", "SKILL.md")), true);
    const target = TOML.parse(fs.readFileSync(path.join(value.targetCodexHome, "config.toml"), "utf8"));
    assert.equal(target.mcp_servers.safe.command, "safe.exe");
    assert.equal(Object.hasOwn(target.mcp_servers, "secret"), false);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects capability migration into a shared Codex Home", () => {
  const value = fixture();
  try {
    const configPath = path.join(value.dataRoot, "managed-bots", "assistant-1", "bot.json");
    const bot = JSON.parse(fs.readFileSync(configPath, "utf8"));
    bot.codexHomeMode = "shared";
    fs.writeFileSync(configPath, JSON.stringify(bot), "utf8");
    assert.throws(() => previewCapabilityMigration("assistant-1", {}, {
      dataRoot: value.dataRoot,
      sourceCodexHome: value.sourceCodexHome,
    }), /隔离 Codex Home/);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});
