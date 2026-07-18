const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  createWorkspaceFactoryQueue,
  previewWorkspaceFactory,
  readWorkspaceFactoryQueue,
  registerFactoryBot,
} = require("../src/main/services/workspace-factory.cjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-workspace-factory-"));
  const sourceCodexHome = path.join(root, "source");
  fs.mkdirSync(sourceCodexHome, { recursive: true });
  fs.writeFileSync(path.join(sourceCodexHome, "config.toml"), [
    '[model_providers.company]',
    'name = "Company"',
    'base_url = "https://example.com/v1"',
    'wire_api = "responses"',
    'env_key = "COMPANY_API_KEY"',
    '',
  ].join("\n"));
  return {
    root,
    dataRoot: path.join(root, "data"),
    workspaceRoot: path.join(root, "workspaces"),
    codexHomeRoot: path.join(root, "homes"),
    sourceCodexHome,
    existingNames: [],
    env: { COMPANY_API_KEY: "secret" },
  };
}

function input(count = 3) {
  return {
    spaceName: "写作",
    slug: "writing",
    count,
    baseIndex: 1,
    namePattern: "codex-assistant-{index}-{slug}",
    labelPattern: "Codex助手{index}-{space}",
    providerId: "company",
    model: "gpt-test",
  };
}

test("previews one or many Bots sharing one isolated Codex Home", () => {
  const value = fixture();
  try {
    const preview = previewWorkspaceFactory(input(3), value);
    assert.equal(preview.available, true);
    assert.deepEqual(preview.bots.map((bot) => bot.name), ["codex-assistant-1-writing", "codex-assistant-2-writing", "codex-assistant-3-writing"]);
    assert.equal(new Set(preview.bots.map((bot) => bot.codexHome)).size, 1);
    assert.equal(new Set(preview.bots.map((bot) => bot.workspace)).size, 3);
    assert.equal(previewWorkspaceFactory(input(1), value).bots.length, 1);
    assert.equal(preview.factory.reasoning, "medium");
    assert.equal(previewWorkspaceFactory({ ...input(1), reasoning: "minimal" }, value).factory.reasoning, "minimal");
    assert.throws(() => previewWorkspaceFactory({ ...input(1), reasoning: "super" }, value), /推理强度/);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("creates a secret-free persistent queue and selected Provider config", () => {
  const value = fixture();
  try {
    const state = createWorkspaceFactoryQueue(input(2), value);
    assert.equal(state.bots.length, 2);
    const queueText = fs.readFileSync(path.join(value.dataRoot, "workspace-factory.json"), "utf8");
    assert.equal(queueText.includes("secret"), false);
    const configText = fs.readFileSync(path.join(state.factory.codexHome, "config.toml"), "utf8");
    assert.match(configText, /model_provider = "company"/);
    assert.match(configText, /env_key = "COMPANY_API_KEY"/);
    assert.equal(configText.includes("secret"), false);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("maps workspace reasoning for the selected model and records both values", () => {
  const value = fixture();
  try {
    const state = createWorkspaceFactoryQueue({
      ...input(1),
      model: "deepseek-v4-preview",
      reasoning: "medium",
    }, value);
    const configText = fs.readFileSync(path.join(state.factory.codexHome, "config.toml"), "utf8");
    assert.match(configText, /model_reasoning_effort = "high"/);
    assert.equal(state.factory.reasoning, "medium");
    assert.equal(state.factory.reasoningPlan.effectiveEffort, "high");
    assert.equal(state.factory.providerReference.reasoning, "medium");
    assert.equal(state.factory.providerReference.effectiveReasoning, "high");
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("initializes one shared space AGENTS.md without overwriting a target", () => {
  const value = fixture();
  const agentsText = "# Global rules\n\n- Run tests.\n";
  fs.writeFileSync(path.join(value.sourceCodexHome, "AGENTS.md"), agentsText, "utf8");
  try {
    const state = createWorkspaceFactoryQueue({ ...input(2), initializeAgents: true }, value);
    assert.equal(state.factory.initializeAgents, true);
    assert.equal(fs.readFileSync(path.join(state.factory.codexHome, "AGENTS.md"), "utf8"), agentsText);
    assert.equal(state.bots.every((bot) => bot.codexHome === state.factory.codexHome), true);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("reuses a trusted existing Codex Home without rewriting its configuration or AGENTS.md", () => {
  const value = fixture();
  const target = path.join(value.codexHomeRoot, "codex-space-writing");
  fs.mkdirSync(target, { recursive: true });
  const configText = [
    'model = "existing-model"',
    'model_provider = "company"',
    '[model_providers.company]',
    'name = "Existing Company"',
    'base_url = "https://existing.example/v1"',
    'wire_api = "responses"',
    'env_key = "COMPANY_API_KEY"',
    '',
  ].join("\n");
  const agentsText = "# Existing space rules\n";
  fs.writeFileSync(path.join(target, "config.toml"), configText, "utf8");
  fs.writeFileSync(path.join(target, "AGENTS.md"), agentsText, "utf8");
  value.trustedCodexHomes = [target];
  try {
    const raw = { ...input(3), initializeAgents: true, reuseExistingHome: true };
    const preview = previewWorkspaceFactory(raw, value);
    assert.equal(preview.available, true);
    assert.equal(preview.factory.reusingExistingHome, true);
    const state = createWorkspaceFactoryQueue(raw, value);
    assert.equal(state.bots.length, 3);
    assert.equal(fs.readFileSync(path.join(target, "config.toml"), "utf8"), configText);
    assert.equal(fs.readFileSync(path.join(target, "AGENTS.md"), "utf8"), agentsText);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("refuses to reuse an existing Codex Home that is not trusted", () => {
  const value = fixture();
  const target = path.join(value.codexHomeRoot, "codex-space-writing");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "config.toml"), '[model_providers.company]\nname = "Company"\n', "utf8");
  try {
    const preview = previewWorkspaceFactory({ ...input(1), reuseExistingHome: true }, value);
    assert.equal(preview.available, false);
    assert.match(preview.bots[0].conflicts.join(" "), /已纳入客户端管理/);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("reports a missing global AGENTS.md before creating a space", () => {
  const value = fixture();
  try {
    const preview = previewWorkspaceFactory({ ...input(1), initializeAgents: true }, value);
    assert.equal(preview.available, false);
    assert.match(preview.bots[0].conflicts.join(" "), /AGENTS\.md/);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("registers queued Bots one at a time and persists progress", async () => {
  const value = fixture();
  try {
    createWorkspaceFactoryQueue(input(2), value);
    const options = {
      dataRoot: value.dataRoot,
      registrationOptions: {},
      registerBot: async (bot, _registrationOptions, progress) => {
        progress({ stage: "qr-ready" });
        const configPath = path.join(value.dataRoot, bot.name, "bot.json");
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(bot));
        return { ...bot, configPath };
      },
    };
    const first = await registerFactoryBot("codex-assistant-1-writing", options);
    assert.equal(first.bots[0].status, "created");
    assert.equal(first.bots[1].status, "pending");
    const second = await registerFactoryBot("codex-assistant-2-writing", options);
    assert.equal(second.status, "complete");
    assert.equal(readWorkspaceFactoryQueue(value.dataRoot).bots.every((bot) => bot.status === "created"), true);
    const botConfig = JSON.parse(fs.readFileSync(path.join(value.dataRoot, "codex-assistant-1-writing", "bot.json")));
    assert.equal(botConfig.provider.mode, "global");
    assert.equal(JSON.stringify(botConfig).includes("secret"), false);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("blocks conflicts and inline Provider secrets", () => {
  const value = fixture();
  try {
    value.existingNames = ["codex-assistant-1-writing"];
    assert.equal(previewWorkspaceFactory(input(2), value).available, false);
    value.existingNames = [];
    fs.appendFileSync(path.join(value.sourceCodexHome, "config.toml"), 'headers = { Authorization = "Bearer hidden" }\n');
    assert.throws(() => createWorkspaceFactoryQueue(input(1), value), /内联敏感字段/);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("does not leave an interrupted registration looking active forever", () => {
  const value = fixture();
  try {
    const state = createWorkspaceFactoryQueue(input(1), value);
    state.bots[0].status = "registering";
    fs.writeFileSync(path.join(value.dataRoot, "workspace-factory.json"), JSON.stringify(state));
    const recovered = readWorkspaceFactoryQueue(value.dataRoot);
    assert.equal(recovered.bots[0].status, "failed");
    assert.match(recovered.bots[0].error, /客户端退出中断/);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});
