import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildPiRpcArguments, writePiRuntimeConfig } from "../src/pi/config.mjs";
import { assistantTextFromPiMessage } from "../src/pi/events.mjs";
import { PiRpcClient } from "../src/pi/rpc-client.mjs";
import { resolvePiModelLimits, resolvePiModelThinkingMetadata } from "../src/pi/model-metadata.mjs";
import { listPiProviderModels, registerPiProviderModel } from "../src/pi/provider-models.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const apiKey = String(process.env.BACKUP_API_KEY || "");
if (!apiKey) throw new Error("BACKUP_API_KEY is not available");
const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-pi-backup-smoke-"));
const sessionDir = path.join(temporaryHome, "sessions");
const directories = {
  modelsPath: path.join(temporaryHome, "models.json"),
  settingsPath: path.join(temporaryHome, "settings.json"),
};
const entryPath = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
let client;

try {
  writePiRuntimeConfig({
    directories,
    provider: {
      id: "backup-api",
      name: "Backup API",
      baseUrl: "https://backup.s2a.kdns.fr:9443/v1",
      envKey: "BACKUP_API_KEY",
      wireApi: "responses",
      model: "gpt-5.6-sol",
      ...resolvePiModelLimits("backup-api", "gpt-5.6-sol"),
      ...resolvePiModelThinkingMetadata("backup-api", "gpt-5.6-sol"),
      input: ["text", "image"],
    },
  });
  const modelsText = fs.readFileSync(directories.modelsPath, "utf8");
  if (!modelsText.includes("$BACKUP_API_KEY") || modelsText.includes(apiKey)) {
    throw new Error("Rendered Pi models.json did not preserve the environment-only credential boundary");
  }
  const liveModels = await listPiProviderModels({
    modelsPath: directories.modelsPath,
    provider: "backup-api",
  });
  const dynamicModel = liveModels.models.find((model) => model.id === "gpt-5.6-terra")
    || liveModels.models.find((model) => model.id !== "gpt-5.6-sol" && model.id.startsWith("gpt-") && !model.id.startsWith("gpt-image"));
  if (!dynamicModel) throw new Error("Backup API did not expose a second text model for dynamic switch verification");
  const registered = await registerPiProviderModel({
    modelsPath: directories.modelsPath,
    provider: "backup-api",
    modelId: dynamicModel.id,
  });
  if (!registered.configChanged) throw new Error(`Dynamic smoke model was already registered: ${dynamicModel.id}`);
  client = new PiRpcClient({
    command: process.execPath,
    args: [
      ...buildPiRpcArguments({
        entryPath,
        provider: "backup-api",
        model: "gpt-5.6-sol",
        thinking: "medium",
        sessionDir,
      }),
      "--no-tools",
      "--no-context-files",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
    ],
    cwd: root,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: temporaryHome,
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    },
    label: "Pi Backup API smoke",
    requestTimeoutMs: 90_000,
  });
  let finalText = "";
  client.onEvent((event) => {
    if (event?.type === "message_end" && event.message?.role === "assistant") {
      finalText = assistantTextFromPiMessage(event.message);
    }
  });
  await client.start();
  await client.waitUntilReady({ timeoutMs: 60_000, probeTimeoutMs: 5_000, retryDelayMs: 250 });
  const available = await client.request({ type: "get_available_models" }, 30_000);
  if (!available?.data?.models?.some((model) => model.provider === "backup-api" && model.id === dynamicModel.id)) {
    throw new Error(`Pi RPC did not load dynamically registered model: ${dynamicModel.id}`);
  }
  await client.request({ type: "set_model", provider: "backup-api", modelId: dynamicModel.id }, 30_000);
  const switched = await client.request({ type: "get_state" }, 30_000);
  if (switched?.data?.model?.provider !== "backup-api" || switched?.data?.model?.id !== dynamicModel.id) {
    throw new Error(`Pi RPC did not switch to dynamically registered model: ${dynamicModel.id}`);
  }
  await client.request({ type: "set_model", provider: "backup-api", modelId: "gpt-5.6-sol" }, 30_000);
  const restored = await client.request({ type: "get_state" }, 30_000);
  if (restored?.data?.model?.provider !== "backup-api" || restored?.data?.model?.id !== "gpt-5.6-sol") {
    throw new Error("Pi RPC did not restore backup-api/gpt-5.6-sol before the real request");
  }
  const thinking = await client.request({ type: "get_available_thinking_levels" }, 30_000);
  const thinkingLevels = Array.isArray(thinking?.data?.levels) ? thinking.data.levels : [];
  const expectedThinkingLevels = ["off", "low", "medium", "high", "xhigh", "max"];
  if (JSON.stringify(thinkingLevels) !== JSON.stringify(expectedThinkingLevels)) {
    throw new Error(`Unexpected gpt-5.6-sol thinking levels: ${thinkingLevels.join(",")}`);
  }
  const originalThinking = restored?.data?.thinkingLevel;
  const alternateThinking = thinkingLevels.find((level) => level !== originalThinking && level !== "off");
  if (!originalThinking || !alternateThinking) throw new Error("Pi RPC did not expose switchable thinking levels for gpt-5.6-sol");
  await client.request({ type: "set_thinking_level", level: alternateThinking }, 30_000);
  const thinkingChanged = await client.request({ type: "get_state" }, 30_000);
  if (thinkingChanged?.data?.thinkingLevel !== alternateThinking) {
    throw new Error(`Pi RPC did not switch thinking level to ${alternateThinking}`);
  }
  await client.request({ type: "set_thinking_level", level: originalThinking }, 30_000);
  const thinkingRestored = await client.request({ type: "get_state" }, 30_000);
  if (thinkingRestored?.data?.thinkingLevel !== originalThinking) {
    throw new Error(`Pi RPC did not restore thinking level to ${originalThinking}`);
  }
  const settled = client.waitForEvent((event) => event?.type === "agent_settled", 90_000);
  await client.request({ type: "prompt", message: "Reply with exactly: PI_BACKUP_OK" }, 90_000);
  await settled;
  const stats = await client.request({ type: "get_session_stats" }, 30_000);
  if (!finalText.includes("PI_BACKUP_OK")) throw new Error(`Unexpected Pi response: ${finalText.slice(0, 200)}`);
  if (Number(stats?.data?.tokens?.total) <= 0) throw new Error("Pi Backup API session stats did not report usage");
  process.stdout.write(`Pi Backup API smoke passed: dynamically switched ${dynamicModel.id}, restored gpt-5.6-sol, switched thinking ${originalThinking}->${alternateThinking}->${originalThinking}, response and usage received\n`);
} finally {
  await client?.stop({ forceAfterMs: 1_000 }).catch(() => {});
  fs.rmSync(temporaryHome, { recursive: true, force: true });
}
