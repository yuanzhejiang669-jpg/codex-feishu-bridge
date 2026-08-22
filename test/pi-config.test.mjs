import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertPiProviderCredentialAvailable,
  buildPiRpcArguments,
  createPiModelsConfig,
  createPiSettings,
  resolvePiDirectories,
  resolvePiProviderEnvironmentKey,
  writePiRuntimeConfig,
} from "../src/pi/config.mjs";
import {
  piThinkingLevelsFromMetadata,
  reconcilePiSessionModelLimits,
  resolvePiModelLimits,
  resolvePiModelThinkingMetadata,
} from "../src/pi/model-metadata.mjs";

test("Pi directories isolate workspaces and agent homes while sharing a space", () => {
  const one = resolvePiDirectories({ documentsRoot: "C:/Users/test/Documents", botName: "pi-agent-01" });
  const two = resolvePiDirectories({ documentsRoot: "C:/Users/test/Documents", botName: "pi-agent-02" });
  assert.notEqual(one.workspace, two.workspace);
  assert.notEqual(one.agentHome, two.agentHome);
  assert.equal(one.configurationSpaceHome, two.configurationSpaceHome);
});

test("Pi runtime config writes atomic environment-only Provider files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-pi-config-"));
  const directories = { modelsPath: path.join(root, "models.json"), settingsPath: path.join(root, "settings.json") };
  const previous = process.env.BACKUP_API_KEY;
  process.env.BACKUP_API_KEY = "must-not-be-rendered";
  try {
    writePiRuntimeConfig({
      directories,
      provider: {
        id: "backup-api",
        baseUrl: "https://example.test/v1",
        envKey: "BACKUP_API_KEY",
        wireApi: "responses",
        model: "gpt-5.6-sol",
        contextWindow: 258_400,
        maxTokens: 32_000,
      },
    });
    const models = fs.readFileSync(directories.modelsPath, "utf8");
    assert.match(models, /\$BACKUP_API_KEY/);
    assert.doesNotMatch(models, /must-not-be-rendered/);
    assert.equal(JSON.parse(models).providers["backup-api"].api, "openai-responses");
    assert.equal(JSON.parse(fs.readFileSync(directories.settingsPath, "utf8")).defaultProjectTrust, "always");
  } finally {
    if (previous === undefined) delete process.env.BACKUP_API_KEY;
    else process.env.BACKUP_API_KEY = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Pi models config references an environment variable instead of a secret", () => {
  const config = createPiModelsConfig({
    id: "backup-api",
    name: "Backup API",
    baseUrl: "https://example.test/v1/",
    envKey: "BACKUP_API_KEY",
    wireApi: "responses",
    model: "gpt-5.6-sol",
    contextWindow: 258_400,
    maxTokens: 32_000,
  });
  assert.equal(config.providers["backup-api"].api, "openai-responses");
  assert.equal(config.providers["backup-api"].apiKey, "$BACKUP_API_KEY");
  assert.equal(config.providers["backup-api"].baseUrl, "https://example.test/v1");
  assert.equal(config.providers["backup-api"].models[0].contextWindow, 258_400);
  assert.equal(config.providers["backup-api"].models[0].maxTokens, 32_000);
});

test("Pi Provider credential preflight resolves only environment references and never returns a secret", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-pi-provider-preflight-"));
  const modelsPath = path.join(root, "models.json");
  try {
    fs.writeFileSync(modelsPath, JSON.stringify(createPiModelsConfig({
      id: "backup-api",
      baseUrl: "https://example.test/v1",
      envKey: "BACKUP_API_KEY",
      wireApi: "responses",
      model: "gpt-5.6-sol",
      contextWindow: 258_400,
      maxTokens: 32_000,
    })), "utf8");
    assert.equal(resolvePiProviderEnvironmentKey({ modelsPath, provider: "backup-api" }), "BACKUP_API_KEY");
    assert.throws(
      () => assertPiProviderCredentialAvailable({ modelsPath, provider: "backup-api", env: {} }),
      (error) => error.code === "PI_PROVIDER_CREDENTIAL_UNAVAILABLE" && /BACKUP_API_KEY/.test(error.message),
    );
    assert.deepEqual(
      assertPiProviderCredentialAvailable({ modelsPath, provider: "backup-api", env: { BACKUP_API_KEY: "secret" } }),
      { provider: "backup-api", envKey: "BACKUP_API_KEY" },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Pi models config rejects missing or invalid model limits", () => {
  const provider = {
    id: "backup-api",
    baseUrl: "https://example.test/v1",
    envKey: "BACKUP_API_KEY",
    wireApi: "responses",
    model: "gpt-5.6-sol",
  };
  assert.throws(() => createPiModelsConfig(provider), /contextWindow must be a positive integer/);
  assert.throws(() => createPiModelsConfig({ ...provider, contextWindow: 10, maxTokens: 11 }), /must not exceed contextWindow/);
  assert.throws(() => createPiModelsConfig({ ...provider, contextWindow: 10.5, maxTokens: 5 }), /contextWindow must be a positive integer/);
});

test("Pi model limits come from one strict authority table", () => {
  assert.deepEqual(resolvePiModelLimits("deepseek-direct", "deepseek-chat"), { contextWindow: 128_000, maxTokens: 8_192, input: ["text"] });
  assert.deepEqual(resolvePiModelLimits("backup-api", "gpt-5.6-sol"), { contextWindow: 258_400, maxTokens: 32_000, input: ["text", "image"] });
  assert.throws(() => resolvePiModelLimits("backup-api", "unknown"), /metadata is unavailable/);
});

test("Pi model thinking metadata exposes only real upstream effort levels", () => {
  const gpt = resolvePiModelThinkingMetadata("backup-api", "gpt-5.6-sol");
  assert.deepEqual(piThinkingLevelsFromMetadata(gpt), ["off", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(gpt.thinkingLevelMap.off, "none");
  assert.equal(gpt.thinkingLevelMap.minimal, null);

  const deepseek = resolvePiModelThinkingMetadata("deepseek-direct", "deepseek-v4-pro");
  assert.deepEqual(piThinkingLevelsFromMetadata(deepseek), ["off", "high", "max"]);
  assert.equal(deepseek.thinkingLevelMap.max, "max");
  assert.deepEqual(piThinkingLevelsFromMetadata(resolvePiModelThinkingMetadata("deepseek-direct", "deepseek-chat")), ["off"]);
  assert.equal(resolvePiModelThinkingMetadata("backup-api", "unknown"), null);
});

test("Pi persisted context snapshots rebase to the configured model window", () => {
  const session = {
    engine: "pi",
    piContextUsage: { usedTokens: 35_034, contextWindow: 258_400, percent: 13.558, updatedAt: 1 },
    piContextPeakUsage: { usedTokens: 40_000, contextWindow: 258_400, percent: 15.48, updatedAt: 2 },
  };
  assert.equal(reconcilePiSessionModelLimits(session, resolvePiModelLimits("deepseek-direct", "deepseek-chat")), true);
  assert.equal(session.piContextUsage.contextWindow, 128_000);
  assert.equal(session.piContextUsage.percent, (35_034 / 128_000) * 100);
  assert.equal(session.piContextPeakUsage.contextWindow, 128_000);
  assert.equal(session.piContextPeakUsage.updatedAt, 2);
  assert.equal(reconcilePiSessionModelLimits({ engine: "codex", piContextUsage: session.piContextUsage }, { contextWindow: 1 }), false);
});

test("Pi RPC arguments use explicit session and extension paths", () => {
  const args = buildPiRpcArguments({
    entryPath: "C:/engine/node_modules/pi/dist/cli.js",
    provider: "backup-api",
    model: "gpt-5.6-sol",
    sessionDir: "C:/pi/sessions",
    sessionFile: "C:/pi/sessions/a.jsonl",
    extensionPaths: ["C:/pi/extensions/mcp.ts"],
  });
  assert.deepEqual(args.slice(1, 5), ["--mode", "rpc", "--approve", "--provider"]);
  assert.ok(args.includes(path.resolve("C:/pi/sessions/a.jsonl")));
  assert.ok(args.includes(path.resolve("C:/pi/extensions/mcp.ts")));
  assert.equal(createPiSettings({ shellPath: "C:/Program Files/Git/bin/bash.exe" }).defaultProjectTrust, "always");
});
