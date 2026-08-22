import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  listConfiguredPiProviders,
  listPiProviderModels,
  registerPiProviderModel,
} from "../src/pi/provider-models.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-pi-live-models-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modelsPath = path.join(root, "models.json");
  fs.writeFileSync(modelsPath, `${JSON.stringify({
    providers: {
      "deepseek-direct": {
        name: "DeepSeek Direct",
        baseUrl: "https://api.deepseek.test",
        api: "openai-responses",
        apiKey: "$DEEPSEEK_API_KEY",
        models: [{ id: "deepseek-chat", name: "DeepSeek Chat", contextWindow: 128000, maxTokens: 8192, input: ["text"] }],
      },
      "backup-api": {
        name: "Backup API",
        baseUrl: "https://backup.test/v1/",
        api: "openai-responses",
        apiKey: "$BACKUP_API_KEY",
        models: [{ id: "gpt-known", name: "Known GPT", contextWindow: 258400, maxTokens: 32000, input: ["text", "image"] }],
      },
    },
  }, null, 2)}\n`, "utf8");
  return modelsPath;
}

function response(body, { ok = true, status = 200, statusText = "OK" } = {}) {
  return { ok, status, statusText, text: async () => JSON.stringify(body) };
}

test("Pi Provider listing exposes only explicitly configured providers", (t) => {
  const providers = listConfiguredPiProviders({ modelsPath: fixture(t) });
  assert.deepEqual(providers, [
    { id: "deepseek-direct", name: "DeepSeek Direct", defaultModel: "deepseek-chat", registeredModels: 1 },
    { id: "backup-api", name: "Backup API", defaultModel: "gpt-known", registeredModels: 1 },
  ]);
});

test("Pi model listing queries only the selected Provider live endpoint", async (t) => {
  const calls = [];
  const result = await listPiProviderModels({
    modelsPath: fixture(t),
    provider: "backup-api",
    env: { BACKUP_API_KEY: "secret" },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ data: [
        { id: "gpt-new", owned_by: "backup" },
        { id: "gpt-known", name: "Provider Display Name" },
      ] });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://backup.test/v1/models");
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret");
  assert.deepEqual(result.models.map((model) => model.id), ["gpt-known", "gpt-new"]);
  assert.equal(result.models[0].metadataSource, "configured");
  assert.equal(result.models[0].contextWindow, 258400);
  assert.equal(result.models[1].metadataSource, "unknown");
  assert.equal(result.models[1].contextWindow, null);
});

test("Pi live listing does not surface ambient models from another Provider", async (t) => {
  const result = await listPiProviderModels({
    modelsPath: fixture(t),
    provider: "backup-api",
    env: { BACKUP_API_KEY: "secret", DEEPSEEK_API_KEY: "also-visible" },
    fetchImpl: async () => response({ data: [{ id: "gpt-known" }] }),
  });
  assert.deepEqual(result.models.map((model) => `${model.provider}/${model.id}`), ["backup-api/gpt-known"]);
});

test("Pi live model names are bounded to one line before card rendering or registration", async (t) => {
  const result = await listPiProviderModels({
    modelsPath: fixture(t),
    provider: "backup-api",
    env: { BACKUP_API_KEY: "secret" },
    fetchImpl: async () => response({ data: [{ id: "gpt-name", name: `  upstream\nmodel\t${"x".repeat(200)}  ` }] }),
  });
  assert.equal(result.models[0].name.includes("\n"), false);
  assert.equal(result.models[0].name.includes("\t"), false);
  assert.equal(result.models[0].name.length, 160);
  assert.match(result.models[0].name, /^upstream model /);
});

test("Pi live listing reports model-specific GPT and DeepSeek thinking levels", async (t) => {
  const modelsPath = fixture(t);
  const backup = await listPiProviderModels({
    modelsPath,
    provider: "backup-api",
    env: { BACKUP_API_KEY: "secret" },
    fetchImpl: async () => response({ data: [{ id: "gpt-5.6-sol" }] }),
  });
  assert.deepEqual(backup.models[0].thinkingLevels, ["off", "low", "medium", "high", "xhigh", "max"]);

  const deepseek = await listPiProviderModels({
    modelsPath,
    provider: "deepseek-direct",
    env: { DEEPSEEK_API_KEY: "secret" },
    fetchImpl: async () => response({ data: [{ id: "deepseek-v4-flash" }, { id: "deepseek-chat" }] }),
  });
  assert.deepEqual(deepseek.models.find((model) => model.id === "deepseek-v4-flash").thinkingLevels, ["off", "high", "max"]);
  assert.deepEqual(deepseek.models.find((model) => model.id === "deepseek-chat").thinkingLevels, ["off"]);
});

test("Pi registration repairs known model thinking metadata without changing credentials", async (t) => {
  const modelsPath = fixture(t);
  const config = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
  config.providers["backup-api"].models.push({ id: "gpt-5.6-sol", name: "Sol", reasoning: true });
  fs.writeFileSync(modelsPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const selected = await registerPiProviderModel({
    modelsPath,
    provider: "backup-api",
    modelId: "gpt-5.6-sol",
    env: { BACKUP_API_KEY: "must-not-persist" },
    fetchImpl: async () => response({ data: [{ id: "gpt-5.6-sol" }] }),
  });
  assert.equal(selected.configChanged, true);
  assert.deepEqual(selected.thinkingLevels, ["off", "low", "medium", "high", "xhigh", "max"]);
  const text = fs.readFileSync(modelsPath, "utf8");
  const stored = JSON.parse(text).providers["backup-api"].models.find((model) => model.id === "gpt-5.6-sol");
  assert.equal(stored.thinkingLevelMap.max, "max");
  assert.equal(stored.thinkingLevelMap.minimal, null);
  assert.doesNotMatch(text, /must-not-persist/);
});

test("Pi model registration atomically adds a live model without persisting credentials", async (t) => {
  const modelsPath = fixture(t);
  const selected = await registerPiProviderModel({
    modelsPath,
    provider: "backup-api",
    modelId: "gpt-new",
    env: { BACKUP_API_KEY: "must-not-persist" },
    fetchImpl: async () => response({ data: [{ id: "gpt-known" }, { id: "gpt-new", name: "New GPT" }] }),
  });
  assert.equal(selected.configChanged, true);
  assert.equal(selected.metadataSource, "pi-default");
  const text = fs.readFileSync(modelsPath, "utf8");
  const config = JSON.parse(text);
  assert.deepEqual(config.providers["backup-api"].models.map((model) => model.id), ["gpt-known", "gpt-new"]);
  assert.deepEqual(config.providers["backup-api"].models[1], { id: "gpt-new", name: "New GPT" });
  assert.match(text, /\$BACKUP_API_KEY/);
  assert.doesNotMatch(text, /must-not-persist/);
});

test("Pi model registration preserves concurrent additions to the same models.json", async (t) => {
  const modelsPath = fixture(t);
  const fetchImpl = async () => response({ data: [
    { id: "gpt-known" },
    { id: "gpt-concurrent-a", name: "Concurrent A" },
    { id: "gpt-concurrent-b", name: "Concurrent B" },
  ] });
  const [first, second] = await Promise.all([
    registerPiProviderModel({
      modelsPath,
      provider: "backup-api",
      modelId: "gpt-concurrent-a",
      env: { BACKUP_API_KEY: "secret" },
      fetchImpl,
    }),
    registerPiProviderModel({
      modelsPath,
      provider: "backup-api",
      modelId: "gpt-concurrent-b",
      env: { BACKUP_API_KEY: "secret" },
      fetchImpl,
    }),
  ]);
  assert.equal(first.configChanged, true);
  assert.equal(second.configChanged, true);
  const models = JSON.parse(fs.readFileSync(modelsPath, "utf8")).providers["backup-api"].models;
  assert.deepEqual(models.map((model) => model.id), ["gpt-known", "gpt-concurrent-a", "gpt-concurrent-b"]);
});

test("Pi model discovery reports missing credentials, invalid JSON, HTTP errors and timeout", async (t) => {
  const modelsPath = fixture(t);
  await assert.rejects(
    listPiProviderModels({ modelsPath, provider: "backup-api", env: {} }),
    /BACKUP_API_KEY/,
  );
  await assert.rejects(
    listPiProviderModels({
      modelsPath,
      provider: "backup-api",
      env: { BACKUP_API_KEY: "secret" },
      fetchImpl: async () => ({ ok: true, status: 200, statusText: "OK", text: async () => "not-json" }),
    }),
    /invalid JSON/,
  );
  await assert.rejects(
    listPiProviderModels({
      modelsPath,
      provider: "backup-api",
      env: { BACKUP_API_KEY: "secret" },
      fetchImpl: async () => response({ error: { message: "denied" } }, { ok: false, status: 401 }),
    }),
    /HTTP 401 denied/,
  );
  await assert.rejects(
    listPiProviderModels({
      modelsPath,
      provider: "backup-api",
      env: { BACKUP_API_KEY: "secret" },
      timeoutMs: 5,
      fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      }),
    }),
    /timed out after 5ms/,
  );
});
