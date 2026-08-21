const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  createManagedBot,
  normalizeBotInput,
  previewBot,
  readManagedBots,
  resolveBotCreationTarget,
} = require("../src/main/services/bot-setup.cjs");
const { loadRegistrationDependencies } = require("../src/main/services/feishu-registration.cjs");

function temporaryRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cfb-desktop-bot-test-"));
}

test("normalizes a Bot and generates its default workspace", () => {
  const root = temporaryRoot();
  try {
    const result = normalizeBotInput({ name: "assistant-1", label: "Assistant 1" }, { workspaceRoot: root });
    assert.equal(result.profile, "assistant-1");
    assert.equal(result.workspace, path.join(root, "feishu-bridge-assistant-1"));
    assert.equal(result.engine, "codex");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("defaults old managed Bot records to the Codex engine", () => {
  const root = temporaryRoot();
  const configRoot = path.join(root, "managed-bots", "legacy");
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(path.join(configRoot, "bot.json"), JSON.stringify({ name: "legacy" }));
  try {
    assert.equal(readManagedBots(root)[0].engine, "codex");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("rejects unsafe Bot identifiers and existing names", () => {
  const root = temporaryRoot();
  try {
    assert.throws(() => normalizeBotInput({ name: "../bad" }, { workspaceRoot: root }), /Bot 标识/);
    const result = previewBot({ name: "assistant-1" }, {
      dataRoot: root,
      workspaceRoot: root,
      runtimeLocalAppData: path.join(root, "runtime"),
      existingNames: ["assistant-1"],
    });
    assert.equal(result.available, false);
    assert.equal(result.paths.botConfig, path.join(root, "managed-bots", "assistant-1", "bot.json"));
    assert.equal(result.paths.logDir, path.join(root, "runtime", "CodexFeishuBridge", "instances", "assistant-1", "logs"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolves explicit global and existing-space Bot targets", () => {
  const root = temporaryRoot();
  const dataRoot = path.join(root, "data");
  const sourceRoot = path.join(dataRoot, "managed-bots", "assistant-1-writing");
  const sharedHome = path.join(root, "homes", "writing");
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "bot.json"), JSON.stringify({
    name: "assistant-1-writing",
    label: "Codex助手1-写作",
    codexHomeMode: "isolated",
    codexHome: sharedHome,
    workspaceFactory: { spaceName: "写作", slug: "writing" },
    provider: { mode: "global", id: "company", model: "gpt-test" },
  }), "utf8");
  try {
    const global = resolveBotCreationTarget({ name: "assistant-2", configurationTarget: "global" }, {
      dataRoot,
      defaultCodexHome: path.join(root, "global-home"),
    });
    assert.equal(global.input.codexHomeMode, "shared");
    assert.deepEqual(global.input.provider, { mode: "current" });

    const space = resolveBotCreationTarget({
      name: "assistant-2-writing",
      configurationTarget: "space",
      spaceSourceName: "assistant-1-writing",
    }, { dataRoot });
    assert.equal(space.input.codexHome, sharedHome);
    assert.equal(space.target.spaceName, "写作");
    assert.equal(space.target.provider.id, "company");
    assert.throws(() => resolveBotCreationTarget({
      name: "missing",
      configurationTarget: "space",
      spaceSourceName: "missing",
    }, { dataRoot }), /有效的已有空间/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("creates a managed Bot without persisting its secret", async () => {
  const root = temporaryRoot();
  const calls = [];
  try {
    const result = await createManagedBot({ name: "assistant-1", label: "Assistant 1" }, {
      appId: "cli_test123",
      appSecret: "do-not-store-this",
    }, {
      dataRoot: root,
      workspaceRoot: path.join(root, "workspaces"),
      existingNames: [],
      larkCliPath: "lark-cli.exe",
      runLarkCli: async (...args) => { calls.push(args); return { stdout: "[]", stderr: "" }; },
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1][2].input, "do-not-store-this");
    const configText = fs.readFileSync(result.configPath, "utf8");
    assert.equal(configText.includes("do-not-store-this"), false);
    assert.equal(readManagedBots(root).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("adds one Bot to an existing space without rewriting shared configuration", async () => {
  const root = temporaryRoot();
  const dataRoot = path.join(root, "data");
  const sharedHome = path.join(root, "homes", "writing");
  const sourceRoot = path.join(dataRoot, "managed-bots", "assistant-1-writing");
  const configPath = path.join(sharedHome, "config.toml");
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(sharedHome, { recursive: true });
  fs.writeFileSync(configPath, 'model = "gpt-test"\nmodel_provider = "company"\n', "utf8");
  fs.writeFileSync(path.join(sourceRoot, "bot.json"), JSON.stringify({
    name: "assistant-1-writing",
    label: "Codex助手1-写作",
    profile: "assistant-1-writing",
    codexHomeMode: "isolated",
    codexHome: sharedHome,
    workspaceFactory: { spaceName: "写作", slug: "writing" },
    provider: { mode: "global", id: "company", model: "gpt-test", envKey: "COMPANY_API_KEY" },
  }), "utf8");
  try {
    const before = fs.readFileSync(configPath, "utf8");
    const result = await createManagedBot({
      name: "assistant-2-writing",
      label: "Codex助手2-写作",
      configurationTarget: "space",
      spaceSourceName: "assistant-1-writing",
    }, { appId: "cli_test123", appSecret: "feishu-secret" }, {
      dataRoot,
      workspaceRoot: path.join(root, "workspaces"),
      defaultCodexHome: path.join(root, "global-home"),
      existingNames: [],
      larkCliPath: "lark-cli.exe",
      runLarkCli: async (_tool, args) => ({ stdout: args.includes("list") ? "[]" : "", stderr: "" }),
    });
    assert.equal(result.codexHome, sharedHome);
    assert.equal(result.workspaceFactory.spaceName, "写作");
    assert.equal(result.provider.id, "company");
    assert.equal(fs.readFileSync(configPath, "utf8"), before);
    assert.equal(fs.existsSync(path.join(path.dirname(result.configPath), "provider-secret.bin")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rolls back transaction files and a newly created empty workspace", async () => {
  const root = temporaryRoot();
  const workspace = path.join(root, "workspaces", "failed");
  try {
    await assert.rejects(() => createManagedBot({ name: "failed", workspace }, {
      appId: "cli_test123",
      appSecret: "secret",
    }, {
      dataRoot: root,
      workspaceRoot: path.join(root, "workspaces"),
      existingNames: [],
      larkCliPath: "lark-cli.exe",
      runLarkCli: async () => { throw new Error("profile add failed"); },
    }), /profile add failed/);
    assert.equal(fs.existsSync(workspace), false);
    assert.equal(readManagedBots(root).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loads the Feishu QR registration and QR-code dependencies", async () => {
  const dependencies = await loadRegistrationDependencies();
  assert.equal(typeof dependencies.registerApp, "function");
  assert.equal(typeof dependencies.QRCode.toDataURL, "function");
});

test("suppresses lark-cli notifier output in the isolated Profile environment", async () => {
  const root = temporaryRoot();
  const executable = process.execPath;
  try {
    const result = await require("../src/main/services/bot-setup.cjs").runLarkCli(executable, [
      "-e",
      "process.stdout.write(JSON.stringify({ update: process.env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER, skills: process.env.LARKSUITE_CLI_NO_SKILLS_NOTIFIER }))",
    ], { profileHome: root });
    assert.deepEqual(JSON.parse(result.stdout), { update: "1", skills: "1" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("creates an isolated Provider Bot without writing the plain API key to JSON or TOML", async () => {
  const root = temporaryRoot();
  try {
    const result = await createManagedBot({
      name: "provider-bot",
      codexHomeMode: "isolated",
      provider: {
        mode: "custom",
        id: "example",
        baseUrl: "https://example.test/v1",
        model: "gpt-test",
        apiKey: "plain-provider-key",
      },
    }, {
      appId: "cli_test123",
      appSecret: "feishu-secret",
    }, {
      dataRoot: path.join(root, "data"),
      workspaceRoot: path.join(root, "workspaces"),
      codexHomeRoot: path.join(root, "codex-homes"),
      defaultCodexHome: path.join(root, "shared-codex"),
      existingNames: [],
      larkCliPath: "lark-cli.exe",
      encryptSecret: (value) => Buffer.from(`dpapi:${value.length}`, "utf8"),
      runLarkCli: async (_tool, args) => ({ stdout: args.includes("list") ? "[]" : "", stderr: "" }),
    });
    const botText = fs.readFileSync(result.configPath, "utf8");
    const codexText = fs.readFileSync(path.join(result.codexHome, "config.toml"), "utf8");
    assert.equal(botText.includes("plain-provider-key"), false);
    assert.equal(codexText.includes("plain-provider-key"), false);
    assert.equal(fs.readFileSync(path.join(path.dirname(result.configPath), "provider-secret.bin"), "utf8"), "dpapi:18");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("creates an isolated Bot from a saved global Provider without copying its key", async () => {
  const root = temporaryRoot();
  const sourceCodexHome = path.join(root, "source-codex");
  fs.mkdirSync(sourceCodexHome, { recursive: true });
  fs.writeFileSync(path.join(sourceCodexHome, "config.toml"), [
    "[model_providers.company]",
    'name = "Company"',
    'base_url = "https://example.test/v1"',
    'wire_api = "responses"',
    'env_key = "COMPANY_API_KEY"',
    "",
  ].join("\n"));
  try {
    const result = await createManagedBot({
      name: "global-provider-bot",
      codexHomeMode: "isolated",
      provider: { mode: "global", id: "company", model: "gpt-test" },
    }, { appId: "cli_test123", appSecret: "feishu-secret" }, {
      dataRoot: path.join(root, "data"),
      workspaceRoot: path.join(root, "workspaces"),
      codexHomeRoot: path.join(root, "codex-homes"),
      sourceCodexHome,
      env: { COMPANY_API_KEY: "global-secret" },
      existingNames: [],
      larkCliPath: "lark-cli.exe",
      runLarkCli: async (_tool, args) => ({ stdout: args.includes("list") ? "[]" : "", stderr: "" }),
    });
    const botText = fs.readFileSync(result.configPath, "utf8");
    const codexText = fs.readFileSync(path.join(result.codexHome, "config.toml"), "utf8");
    assert.match(botText, /"mode": "global"/);
    assert.match(codexText, /model_provider = "company"/);
    assert.equal(`${botText}${codexText}`.includes("global-secret"), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("creates an isolated Pi runtime without persisting Provider or Feishu secrets", async () => {
  const root = temporaryRoot();
  const sourceCodexHome = path.join(root, "source-codex");
  const engineRoot = path.resolve(__dirname, "..", "..", "..");
  const skillRoots = [path.join(root, "codex-skills"), path.join(root, "agent-skills")];
  fs.mkdirSync(sourceCodexHome, { recursive: true });
  skillRoots.forEach((target) => fs.mkdirSync(target, { recursive: true }));
  fs.writeFileSync(path.join(sourceCodexHome, "config.toml"), [
    "[model_providers.backup-api]",
    'name = "Backup API"',
    'base_url = "https://backup.example.test/v1"',
    'wire_api = "responses"',
    'env_key = "BACKUP_API_KEY"',
    "",
  ].join("\n"));
  try {
    const result = await createManagedBot({
      name: "pi-agent-01",
      engine: "pi",
      provider: { mode: "global", id: "backup-api", model: "gpt-5.6-sol" },
    }, { appId: "cli_test123", appSecret: "feishu-secret" }, {
      dataRoot: path.join(root, "data"),
      workspaceRoot: path.join(root, "workspaces"),
      piAgentHomeRoot: path.join(root, "pi-homes"),
      piConfigurationSpaceRoot: path.join(root, "pi-spaces"),
      sourceCodexHome,
      engineRoot,
      piSkillRoots: skillRoots,
      mcpDataRoot: path.join(root, "mcp-data"),
      mineruRoot: path.join(root, "mineru"),
      env: { BACKUP_API_KEY: "provider-secret" },
      existingNames: [],
      larkCliPath: "lark-cli.exe",
      runLarkCli: async (_tool, args) => ({ stdout: args.includes("list") ? "[]" : "", stderr: "" }),
    });
    const botText = fs.readFileSync(result.configPath, "utf8");
    const modelsText = fs.readFileSync(path.join(result.agentHome, "models.json"), "utf8");
    const capabilitiesText = fs.readFileSync(result.piRuntime.capabilitiesPath, "utf8");
    assert.equal(result.engine, "pi");
    assert.equal(result.configurationSpace.id, "pi-general");
    assert.equal(result.sessionDir, path.join(result.agentHome, "sessions"));
    assert.deepEqual(result.piRuntime.skillPaths, skillRoots);
    assert.match(modelsText, /\$BACKUP_API_KEY/);
    assert.match(modelsText, /openai-responses/);
    assert.equal(`${botText}${modelsText}${capabilitiesText}`.includes("provider-secret"), false);
    assert.equal(`${botText}${modelsText}${capabilitiesText}`.includes("feishu-secret"), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("rolls back Pi runtime and restores the shared capability config after failure", async () => {
  const root = temporaryRoot();
  const sourceCodexHome = path.join(root, "source-codex");
  const spaceRoot = path.join(root, "pi-spaces");
  const capabilityPath = path.join(spaceRoot, "pi-general", "capabilities.json");
  fs.mkdirSync(sourceCodexHome, { recursive: true });
    fs.mkdirSync(path.dirname(capabilityPath), { recursive: true });
  const skillRoot = path.join(root, "skills");
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(sourceCodexHome, "config.toml"), [
    "[model_providers.backup-api]",
    'base_url = "https://backup.example.test/v1"',
    'wire_api = "responses"',
    'env_key = "BACKUP_API_KEY"',
  ].join("\n"));
  fs.writeFileSync(capabilityPath, '{"existing":true}\n');
  try {
    await assert.rejects(() => createManagedBot({
      name: "pi-agent-failed", engine: "pi",
      provider: { mode: "global", id: "backup-api", model: "gpt-test" },
    }, { appId: "cli_test123", appSecret: "secret" }, {
      dataRoot: path.join(root, "data"), workspaceRoot: path.join(root, "workspaces"),
      piAgentHomeRoot: path.join(root, "pi-homes"), piConfigurationSpaceRoot: spaceRoot,
      sourceCodexHome, engineRoot: path.join(root, "missing-engine"), piSkillRoots: [skillRoot],
      env: { BACKUP_API_KEY: "provider-secret" }, existingNames: [], larkCliPath: "lark-cli.exe",
      runLarkCli: async (_tool, args) => ({ stdout: args.includes("list") ? "[]" : "", stderr: "" }),
    }));
    assert.equal(fs.existsSync(path.join(root, "pi-homes", "pi-agent-failed")), false);
    assert.equal(fs.readFileSync(capabilityPath, "utf8"), '{"existing":true}\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
