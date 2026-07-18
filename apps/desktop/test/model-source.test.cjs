const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  applyDesktopModelSourceSwitch,
  listDesktopModelSources,
  previewDesktopModelSourceSwitch,
  trustDesktopCodexHome,
} = require("../src/main/services/model-source.cjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-desktop-model-source-"));
  const dataRoot = path.join(root, "data");
  const localAppData = path.join(root, "local");
  const defaultCodexHome = path.join(root, ".codex");
  const codexHomeRoot = path.join(root, "codex-homes");
  const drawing = path.join(codexHomeRoot, "drawing");
  const future = path.join(codexHomeRoot, "future");
  const engineRoot = path.join(root, "engine");
  const sharedTarget = path.join(engineRoot, "src", "codex", "model-source.cjs");
  fs.mkdirSync(path.dirname(sharedTarget), { recursive: true });
  fs.copyFileSync(path.resolve(__dirname, "..", "..", "..", "src", "codex", "model-source.cjs"), sharedTarget);
  fs.mkdirSync(defaultCodexHome, { recursive: true });
  fs.mkdirSync(drawing, { recursive: true });
  fs.mkdirSync(future, { recursive: true });
  fs.writeFileSync(path.join(drawing, "config.toml"), [
    'model_provider = "company"',
    '[model_providers.company]',
    'name = "Company"',
    'base_url = "https://example.test/v1"',
    'wire_api = "responses"',
    'env_key = "COMPANY_API_KEY"',
    "[model_providers.company2]",
    'name = "Company 2"',
    'base_url = "https://example2.test/v1"',
    'wire_api = "responses"',
    'env_key = "COMPANY2_API_KEY"',
    "",
  ].join("\n"), "utf8");
  const botRoot = path.join(dataRoot, "managed-bots", "drawing-1");
  fs.mkdirSync(botRoot, { recursive: true });
  fs.writeFileSync(path.join(botRoot, "bot.json"), `${JSON.stringify({
    name: "drawing-1", label: "画图1", codexHome: drawing, codexHomeMode: "isolated", autoStart: true,
    provider: { mode: "custom", id: "company", envKey: "COMPANY_API_KEY" },
  })}\n`, "utf8");
  fs.writeFileSync(path.join(botRoot, "provider-secret.bin"), "encrypted", "utf8");
  const runtimeRoot = path.join(localAppData, "CodexFeishuBridge", "instances", "drawing-1");
  const stateRoot = path.join(runtimeRoot, "state");
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(path.join(stateRoot, "sessions.json"), `${JSON.stringify({ chats: { chat: { sessions: [
    { id: "one", providerOverride: "company", providerBundleOverride: "" },
  ] } } }, null, 2)}\n`, "utf8");
  const botConfigPath = path.join(botRoot, "bot.json");
  return {
    root,
    options: {
      dataRoot, localAppData, defaultCodexHome, codexHomeRoot, engineRoot,
      codexPath: path.join(root, "missing-codex.exe"),
      envValue: (name) => name === "COMPANY2_API_KEY" ? "available" : "",
      supervisorOptions: {},
      inspectBots: () => [{
        name: "drawing-1", label: "画图1", codexHome: drawing, runtimeRoot,
        online: true, processId: 123, activeRunCount: 0, configPath: botConfigPath,
        provider: { mode: "custom", id: "company", envKey: "COMPANY_API_KEY" },
      }],
    },
    drawing,
    future,
    sessionPath: path.join(stateRoot, "sessions.json"),
  };
}

test("desktop model sources dynamically include managed and future Codex Homes", async () => {
  const value = fixture();
  try {
    const result = await listDesktopModelSources(value.options);
    assert.equal(result.homes.length, 3);
    const drawing = result.homes.find((home) => home.bots.some((bot) => bot.name === "drawing-1"));
    assert.equal(drawing.bots[0].name, "drawing-1");
    assert.equal(drawing.providers.find((provider) => provider.id === "company").credentialAvailable, true);
    assert.ok(result.homes.some((home) => path.basename(home.codexHome) === path.basename(value.future)));
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("desktop applies a DPAPI-backed Provider without requiring a process environment key", async () => {
  const value = fixture();
  const configPath = path.join(value.drawing, "config.toml");
  fs.writeFileSync(configPath, fs.readFileSync(configPath, "utf8").replace(
    'model_provider = "company"',
    'model_provider = "company2"',
  ), "utf8");
  try {
    const result = await applyDesktopModelSourceSwitch({
      codexHome: value.drawing,
      targetProvider: "company",
      confirm: "\u5207\u6362\u5230 company",
    }, {
      ...value.options,
      envValue: () => "",
      stopBot: async () => {},
      startBot: async (name) => ({ name }),
    });
    assert.equal(result.applied, true);
    assert.match(fs.readFileSync(configPath, "utf8"), /^model_provider = "company"$/m);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("desktop preview treats OpenAI separately from discovered third-party Providers", async () => {
  const value = fixture();
  try {
    const openai = await previewDesktopModelSourceSwitch({ codexHome: value.drawing, targetProvider: "openai" }, value.options);
    assert.equal(openai.targetKind, "openai");
    assert.match(openai.blockers.join(" "), /尚未完成 OpenAI/);
    const thirdParty = await previewDesktopModelSourceSwitch({ codexHome: value.drawing, targetProvider: "company" }, value.options);
    assert.equal(thirdParty.targetKind, "third-party");
    assert.equal(thirdParty.blockers.length, 0);
    const unbound = await previewDesktopModelSourceSwitch({ codexHome: value.future, targetProvider: "openai" }, value.options);
    assert.match(unbound.blockers.join(" "), /只读/);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("desktop explicitly trusts a discovered Home before managing it without Bots", async () => {
  const value = fixture();
  try {
    fs.writeFileSync(path.join(value.future, "config.toml"), 'model_provider = "openai"\n', "utf8");
    const before = await previewDesktopModelSourceSwitch({ codexHome: value.future, targetProvider: "openai" }, value.options);
    assert.match(before.blockers.join(" "), /只读/);
    const imported = trustDesktopCodexHome(value.future, value.options);
    assert.equal(imported.changed, true);
    assert.equal(imported.trusted, true);
    const listed = await listDesktopModelSources(value.options);
    const future = listed.homes.find((home) => path.basename(home.codexHome) === path.basename(value.future));
    assert.equal(future.trusted, true);
    assert.equal(future.manageable, true);
    assert.equal(future.bots.length, 0);
    const after = await previewDesktopModelSourceSwitch({ codexHome: value.future, targetProvider: "openai" }, value.options);
    assert.doesNotMatch(after.blockers.join(" "), /只读/);
    assert.match(after.blockers.join(" "), /尚未完成 OpenAI/);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("desktop applies a whole-Home switch and clears persisted session overrides", async () => {
  const value = fixture();
  const calls = [];
  try {
    const result = await applyDesktopModelSourceSwitch({
      codexHome: value.drawing,
      targetProvider: "company2",
      confirm: "切换到 company2",
    }, {
      ...value.options,
      stopBot: async (name) => { calls.push(`stop:${name}`); },
      startBot: async (name) => { calls.push(`start:${name}`); return { name }; },
    });
    assert.equal(result.applied, true);
    assert.deepEqual(calls, ["stop:drawing-1", "start:drawing-1"]);
    assert.match(fs.readFileSync(path.join(value.drawing, "config.toml"), "utf8"), /^model_provider = "company2"$/m);
    assert.equal(JSON.parse(fs.readFileSync(value.sessionPath, "utf8")).chats.chat.sessions[0].providerOverride, "");
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("desktop restores Provider and session overrides when Bot recovery fails", async () => {
  const value = fixture();
  const configPath = path.join(value.drawing, "config.toml");
  const configBefore = fs.readFileSync(configPath, "utf8");
  const sessionBefore = fs.readFileSync(value.sessionPath, "utf8");
  let starts = 0;
  try {
    await assert.rejects(() => applyDesktopModelSourceSwitch({
      codexHome: value.drawing,
      targetProvider: "company2",
      confirm: "切换到 company2",
    }, {
      ...value.options,
      stopBot: async () => {},
      startBot: async () => {
        starts += 1;
        if (starts === 1) throw new Error("injected start failure");
        return {};
      },
    }), /已尝试回滚/);
    assert.equal(fs.readFileSync(configPath, "utf8"), configBefore);
    assert.equal(fs.readFileSync(value.sessionPath, "utf8"), sessionBefore);
    assert.equal(starts, 2);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});
