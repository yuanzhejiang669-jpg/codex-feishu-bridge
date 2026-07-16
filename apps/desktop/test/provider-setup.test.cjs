const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const TOML = require("smol-toml");
const {
  inspectProvider,
  normalizeProviderInput,
  prepareProviderConfiguration,
  testProvider: callProvider,
} = require("../src/main/services/provider-setup.cjs");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cfb-provider-test-"));
}

test("normalizes a third-party Responses provider", () => {
  const provider = normalizeProviderInput({
    id: "example",
    baseUrl: "https://example.test/v1/",
    model: "gpt-test",
    apiKey: "secret",
  }, "assistant-1");
  assert.equal(provider.baseUrl, "https://example.test/v1");
  assert.equal(provider.envKey, "CODEX_FEISHU_ASSISTANT_1_API_KEY");
  assert.equal(provider.wireApi, "responses");
  assert.equal(provider.reasoning, "medium");
});

test("accepts every supported reasoning effort and rejects unknown values", () => {
  const base = {
    mode: "global",
    id: "example",
    model: "gpt-test",
  };
  for (const reasoning of ["none", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.equal(normalizeProviderInput({ ...base, reasoning }).reasoning, reasoning);
  }
  assert.throws(() => normalizeProviderInput({ ...base, reasoning: "super" }), /推理强度/);
});

test("writes the effective model effort while retaining the requested effort", () => {
  const root = tempRoot();
  try {
    const transactionRoot = path.join(root, "transaction");
    const codexHome = path.join(root, "codex-home");
    fs.mkdirSync(transactionRoot, { recursive: true });
    const plan = prepareProviderConfiguration({
      name: "assistant-reasoning",
      codexHome,
      codexHomeMode: "isolated",
    }, {
      id: "deepseek",
      baseUrl: "https://example.test/v1",
      model: "deepseek-v4-preview",
      apiKey: "plain-secret",
      reasoning: "medium",
    }, {
      transactionRoot,
      encryptSecret: (value) => Buffer.from(`encrypted:${value.length}`, "utf8"),
    });
    plan.commit();
    const config = TOML.parse(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"));
    assert.equal(config.model_reasoning_effort, "high");
    assert.equal(plan.publicConfig.reasoning, "medium");
    assert.equal(plan.publicConfig.effectiveReasoning, "high");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stages an encrypted secret and commits only public Provider config", () => {
  const root = tempRoot();
  try {
    const transactionRoot = path.join(root, "transaction");
    const codexHome = path.join(root, "codex-home");
    fs.mkdirSync(transactionRoot, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    const plan = prepareProviderConfiguration({
      name: "assistant-1",
      codexHome,
      codexHomeMode: "isolated",
    }, {
      id: "example",
      baseUrl: "https://example.test/v1",
      model: "gpt-test",
      apiKey: "plain-secret",
    }, {
      transactionRoot,
      encryptSecret: (value) => Buffer.from(`encrypted:${value.length}`, "utf8"),
    });
    plan.commit();
    const configText = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    assert.equal(configText.includes("plain-secret"), false);
    assert.equal(fs.readFileSync(path.join(transactionRoot, "provider-secret.bin"), "utf8"), "encrypted:12");
    const config = TOML.parse(configText);
    assert.equal(config.model_provider, "example");
    assert.equal(config.model_providers.example.wire_api, "responses");
    const inspected = inspectProvider(codexHome, { CODEX_FEISHU_ASSISTANT_1_API_KEY: "present" });
    assert.equal(inspected.thirdParty, true);
    assert.equal(inspected.credentialAvailable, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("performs a minimal Responses API request without returning the key", async () => {
  let request = null;
  const result = await callProvider({
    id: "example",
    baseUrl: "https://example.test/v1",
    model: "gpt-test",
    apiKey: "private-key",
  }, {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ id: "resp_test" }), { status: 200 });
    },
  });
  assert.equal(request.url, "https://example.test/v1/responses");
  assert.equal(request.options.headers.authorization, "Bearer private-key");
  assert.equal(JSON.stringify(result).includes("private-key"), false);
  assert.equal(result.responseId, "resp_test");
});
