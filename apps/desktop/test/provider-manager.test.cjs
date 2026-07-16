const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const TOML = require("smol-toml");
const {
  addGlobalProvider,
  inspectProviderCatalog,
  listProviderModels,
  providerSyncPlan,
  replaceGlobalProviderKey,
} = require("../src/main/services/provider-manager.cjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-provider-manager-"));
  const codexHome = path.join(root, "global");
  const dataRoot = path.join(root, "data");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), [
    'model = "gpt-test"',
    'model_provider = "existing"',
    '',
    '[mcp_servers.keep]',
    'command = "keep.exe"',
    '',
    '[model_providers.existing]',
    'name = "Existing"',
    'base_url = "https://existing.example/v1"',
    'wire_api = "responses"',
    'env_key = "EXISTING_API_KEY"',
    '',
  ].join("\n"));
  return { root, codexHome, dataRoot };
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

test("lists every global Provider without exposing key values", () => {
  const value = fixture();
  try {
    const catalog = inspectProviderCatalog(value.codexHome, { EXISTING_API_KEY: "top-secret" });
    assert.equal(catalog.providers.length, 1);
    assert.equal(catalog.providers[0].credentialAvailable, true);
    assert.equal(JSON.stringify(catalog).includes("top-secret"), false);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("adds a Provider atomically and stores its key outside TOML", async () => {
  const value = fixture();
  const writes = [];
  try {
    const result = await addGlobalProvider({ id: "new", name: "New", baseUrl: "https://new.example/v1", envKey: "NEW_API_KEY", apiKey: "secret" }, {
      codexHome: value.codexHome,
      readUserEnvironmentVariable: async () => "",
      setUserEnvironmentVariable: async (name, secret) => writes.push([name, secret]),
    });
    const text = fs.readFileSync(path.join(value.codexHome, "config.toml"), "utf8");
    assert.match(text, /model_providers\.new/);
    assert.match(text, /mcp_servers\.keep/);
    assert.equal(text.includes("secret"), false);
    assert.deepEqual(writes, [["NEW_API_KEY", "secret"]]);
    assert.equal(JSON.stringify(result).includes("secret"), false);
    await assert.rejects(() => addGlobalProvider({ id: "new", baseUrl: "https://new.example/v1", envKey: "NEW_API_KEY", apiKey: "secret" }, {
      codexHome: value.codexHome,
      readUserEnvironmentVariable: async () => "",
      setUserEnvironmentVariable: async () => {},
    }), /已存在/);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("validates Chat Completions and stores a client-proxy Responses endpoint", async () => {
  const value = fixture();
  const writes = [];
  let committed = false;
  try {
    const fetchImpl = async (url) => url.endsWith("/models")
      ? response(200, { data: [{ id: "qwen-test" }] })
      : response(200, { id: "chat_1", choices: [{ message: { content: "OK" } }] });
    const input = {
      id: "qwen", name: "Qwen", baseUrl: "https://chat.example/v1", envKey: "QWEN_API_KEY",
      apiKey: "secret", model: "qwen-test", wireApi: "chat",
    };
    const probe = await require("../src/main/services/provider-manager.cjs").probeProvider(input, { fetchImpl });
    assert.equal(probe.wireApi, "chat");
    await addGlobalProvider(input, {
      codexHome: value.codexHome,
      fetchImpl,
      readUserEnvironmentVariable: async () => "",
      setUserEnvironmentVariable: async (name, secret) => writes.push([name, secret]),
      prepareProtocolProxyProvider: () => ({
        codexProvider: { id: "qwen", name: "Qwen", baseUrl: "http://127.0.0.1:18788/v1", envKey: "QWEN_API_KEY", wireApi: "responses" },
        commit: async () => { committed = true; }, rollback: async () => {},
      }),
    });
    const text = fs.readFileSync(path.join(value.codexHome, "config.toml"), "utf8");
    assert.match(text, /base_url = "http:\/\/127\.0\.0\.1:18788\/v1"/);
    assert.match(text, /wire_api = "responses"/);
    assert.doesNotMatch(text, /chat\.example|secret/);
    assert.equal(committed, true);
    assert.deepEqual(writes, [["QWEN_API_KEY", "secret"]]);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("restores an absent user key when writing a new Provider fails", async () => {
  const value = fixture();
  const writes = [];
  try {
    await assert.rejects(() => addGlobalProvider({
      id: "broken",
      baseUrl: "https://broken.example/v1",
      envKey: "BROKEN_API_KEY",
      apiKey: "new-secret",
    }, {
      codexHome: value.codexHome,
      readUserEnvironmentVariable: async () => "",
      setUserEnvironmentVariable: async (name, secret) => writes.push([name, secret]),
      writeTextAtomic: () => { throw new Error("disk full"); },
    }), /disk full/);
    assert.deepEqual(writes, [["BROKEN_API_KEY", "new-secret"], ["BROKEN_API_KEY", null]]);
    assert.equal(fs.readFileSync(path.join(value.codexHome, "config.toml"), "utf8").includes("broken"), false);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("previews models and probes before replacing a key", async () => {
  const value = fixture();
  const writes = [];
  let calls = 0;
  try {
    const fetchImpl = async (url) => {
      calls += 1;
      return url.endsWith("/models")
        ? response(200, { data: [{ id: "gpt-test" }] })
        : response(200, { id: "resp_1" });
    };
    const preview = await listProviderModels({ id: "existing", baseUrl: "https://existing.example/v1", envKey: "EXISTING_API_KEY", apiKey: "new-secret" }, { fetchImpl });
    assert.deepEqual(preview.models.map((item) => item.id), ["gpt-test"]);
    const result = await replaceGlobalProviderKey({ id: "existing", apiKey: "new-secret", model: "gpt-test" }, {
      codexHome: value.codexHome,
      fetchImpl,
      setUserEnvironmentVariable: async (name, secret) => writes.push([name, secret]),
    });
    assert.equal(result.probe.ok, true);
    assert.equal(calls, 3);
    assert.deepEqual(writes, [["EXISTING_API_KEY", "new-secret"]]);
    assert.equal(JSON.stringify(result).includes("new-secret"), false);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("syncs definitions only to client-managed isolated Codex Homes", () => {
  const value = fixture();
  try {
    const botRoot = path.join(value.dataRoot, "managed-bots", "assistant-1");
    const targetHome = path.join(value.root, "target");
    fs.mkdirSync(botRoot, { recursive: true });
    fs.mkdirSync(targetHome, { recursive: true });
    fs.writeFileSync(path.join(botRoot, "bot.json"), JSON.stringify({ name: "assistant-1", codexHomeMode: "isolated", codexHome: targetHome }));
    fs.writeFileSync(path.join(targetHome, "config.toml"), '[mcp_servers.keep]\ncommand = "keep.exe"\n');
    const preview = providerSyncPlan({ codexHome: value.codexHome, dataRoot: value.dataRoot }, false);
    assert.equal(preview.targetCount, 1);
    assert.equal(preview.addCount, 1);
    assert.equal(preview.writtenCount, 0);
    const applied = providerSyncPlan({ codexHome: value.codexHome, dataRoot: value.dataRoot }, true);
    assert.equal(applied.writtenCount, 1);
    const parsed = TOML.parse(fs.readFileSync(path.join(targetHome, "config.toml"), "utf8"));
    assert.equal(parsed.mcp_servers.keep.command, "keep.exe");
    assert.equal(parsed.model_providers.existing.env_key, "EXISTING_API_KEY");
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("rolls back earlier Provider targets when a later sync write fails", () => {
  const value = fixture();
  try {
    const homes = ["first", "second"].map((name) => path.join(value.root, name));
    homes.forEach((home, index) => {
      const botRoot = path.join(value.dataRoot, "managed-bots", `bot-${index}`);
      fs.mkdirSync(botRoot, { recursive: true });
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(botRoot, "bot.json"), JSON.stringify({ name: `bot-${index}`, codexHomeMode: "isolated", codexHome: home }));
      fs.writeFileSync(path.join(home, "config.toml"), `[mcp_servers.keep]\ncommand = "keep-${index}.exe"\n`);
    });
    const originals = homes.map((home) => fs.readFileSync(path.join(home, "config.toml"), "utf8"));
    let writes = 0;
    assert.throws(() => providerSyncPlan({
      codexHome: value.codexHome,
      dataRoot: value.dataRoot,
      writeTextAtomic: (destination, content) => {
        writes += 1;
        if (writes === 2) throw new Error("disk full");
        fs.writeFileSync(destination, content);
      },
    }, true), /已回滚先前写入/);
    assert.deepEqual(homes.map((home) => fs.readFileSync(path.join(home, "config.toml"), "utf8")), originals);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("skips nested inline Provider secrets and shared Codex Homes", () => {
  const value = fixture();
  try {
    fs.appendFileSync(path.join(value.codexHome, "config.toml"), [
      "[model_providers.unsafe]",
      'name = "Unsafe"',
      'base_url = "https://unsafe.example/v1"',
      'wire_api = "responses"',
      'env_key = "SAFE_REFERENCE"',
      'headers = { Authorization = "Bearer inline-secret" }',
      "",
    ].join("\n"));
    for (const [name, mode] of [["isolated", "isolated"], ["shared", "shared"]]) {
      const botRoot = path.join(value.dataRoot, "managed-bots", name);
      const home = path.join(value.root, name);
      fs.mkdirSync(botRoot, { recursive: true });
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(botRoot, "bot.json"), JSON.stringify({ name, codexHomeMode: mode, codexHome: home }));
      fs.writeFileSync(path.join(home, "config.toml"), "");
    }
    const result = providerSyncPlan({ codexHome: value.codexHome, dataRoot: value.dataRoot }, true);
    assert.equal(result.targetCount, 1);
    assert.equal(result.providerCount, 1);
    assert.equal(result.skippedProviderCount, 1);
    const target = fs.readFileSync(path.join(value.root, "isolated", "config.toml"), "utf8");
    assert.match(target, /model_providers\.existing/);
    assert.doesNotMatch(target, /unsafe|inline-secret/);
    assert.equal(fs.readFileSync(path.join(value.root, "shared", "config.toml"), "utf8"), "");
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});
