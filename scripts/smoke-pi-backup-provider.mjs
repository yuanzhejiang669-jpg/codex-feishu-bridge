import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildPiRpcArguments, writePiRuntimeConfig } from "../src/pi/config.mjs";
import { assistantTextFromPiMessage } from "../src/pi/events.mjs";
import { PiRpcClient } from "../src/pi/rpc-client.mjs";

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
      reasoning: true,
      input: ["text", "image"],
    },
  });
  const modelsText = fs.readFileSync(directories.modelsPath, "utf8");
  if (!modelsText.includes("$BACKUP_API_KEY") || modelsText.includes(apiKey)) {
    throw new Error("Rendered Pi models.json did not preserve the environment-only credential boundary");
  }
  client = new PiRpcClient({
    command: process.execPath,
    args: [
      ...buildPiRpcArguments({
        entryPath,
        provider: "backup-api",
        model: "gpt-5.6-sol",
        thinking: "minimal",
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
  const settled = client.waitForEvent((event) => event?.type === "agent_settled", 90_000);
  await client.request({ type: "prompt", message: "Reply with exactly: PI_BACKUP_OK" }, 90_000);
  await settled;
  const stats = await client.request({ type: "get_session_stats" }, 30_000);
  if (!finalText.includes("PI_BACKUP_OK")) throw new Error(`Unexpected Pi response: ${finalText.slice(0, 200)}`);
  if (Number(stats?.data?.tokens?.total) <= 0) throw new Error("Pi Backup API session stats did not report usage");
  process.stdout.write("Pi Backup API smoke passed: response and usage received\n");
} finally {
  await client?.stop({ forceAfterMs: 1_000 }).catch(() => {});
  fs.rmSync(temporaryHome, { recursive: true, force: true });
}
