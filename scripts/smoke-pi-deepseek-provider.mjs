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
const apiKey = String(process.env.DEEPSEEK_API_KEY || "");
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not available");
const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-pi-deepseek-smoke-"));
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
      id: "deepseek-direct",
      name: "DeepSeek Official Responses",
      baseUrl: "https://api.deepseek.com",
      envKey: "DEEPSEEK_API_KEY",
      wireApi: "responses",
      model: "deepseek-chat",
      ...resolvePiModelLimits("deepseek-direct", "deepseek-chat"),
      ...resolvePiModelThinkingMetadata("deepseek-direct", "deepseek-chat"),
      input: ["text"],
    },
  });
  const modelsText = fs.readFileSync(directories.modelsPath, "utf8");
  if (!modelsText.includes("$DEEPSEEK_API_KEY") || modelsText.includes(apiKey)) {
    throw new Error("Rendered Pi models.json did not preserve the environment-only credential boundary");
  }
  const liveModels = await listPiProviderModels({ modelsPath: directories.modelsPath, provider: "deepseek-direct" });
  const v4Model = liveModels.models.find((model) => model.id === "deepseek-v4-flash")
    || liveModels.models.find((model) => /^deepseek-v4-(?:flash|pro)$/.test(model.id));
  if (!v4Model) throw new Error("DeepSeek did not expose a V4 model for thinking-level verification");
  await verifyDeepSeekResponseEfforts(v4Model.id, apiKey);
  await registerPiProviderModel({ modelsPath: directories.modelsPath, provider: "deepseek-direct", modelId: v4Model.id });
  client = new PiRpcClient({
    command: process.execPath,
    args: [
      ...buildPiRpcArguments({
        entryPath,
        provider: "deepseek-direct",
        model: "deepseek-chat",
        thinking: "off",
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
    label: "Pi DeepSeek smoke",
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
  await client.request({ type: "set_model", provider: "deepseek-direct", modelId: v4Model.id }, 30_000);
  const thinking = await client.request({ type: "get_available_thinking_levels" }, 30_000);
  const thinkingLevels = Array.isArray(thinking?.data?.levels) ? thinking.data.levels : [];
  if (JSON.stringify(thinkingLevels) !== JSON.stringify(["off", "high", "max"])) {
    throw new Error(`Unexpected ${v4Model.id} thinking levels: ${thinkingLevels.join(",")}`);
  }
  await client.request({ type: "set_thinking_level", level: "high" }, 30_000);
  const settled = client.waitForEvent((event) => event?.type === "agent_settled", 90_000);
  await client.request({ type: "prompt", message: "Reply with exactly: PI_DEEPSEEK_OK" }, 90_000);
  await settled;
  const stats = await client.request({ type: "get_session_stats" }, 30_000);
  if (!finalText.includes("PI_DEEPSEEK_OK")) throw new Error(`Unexpected Pi response: ${finalText.slice(0, 200)}`);
  if (Number(stats?.data?.tokens?.total) <= 0) throw new Error("Pi DeepSeek session stats did not report usage");
  process.stdout.write(`Pi DeepSeek smoke passed: ${v4Model.id} exposed off/high/max, high-effort response and usage received\n`);
} finally {
  await client?.stop({ forceAfterMs: 1_000 }).catch(() => {});
  fs.rmSync(temporaryHome, { recursive: true, force: true });
}

async function verifyDeepSeekResponseEfforts(model, credential) {
  for (const effort of ["none", "high", "max"]) {
    const response = await fetch("https://api.deepseek.com/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: "Reply OK.", max_output_tokens: 16, reasoning: { effort } }),
    });
    const text = await response.text();
    let body = {};
    try { body = JSON.parse(text); } catch {}
    if (!response.ok) {
      const detail = String(body?.error?.message || body?.message || "request rejected").slice(0, 200);
      throw new Error(`DeepSeek ${model} rejected reasoning effort ${effort}: HTTP ${response.status} ${detail}`);
    }
    if (!body?.id || !body?.usage) throw new Error(`DeepSeek ${model} ${effort} probe returned no response id or usage`);
  }
}
