import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PiRpcClient } from "../src/pi/rpc-client.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const entryPath = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
if (!fs.existsSync(entryPath)) throw new Error(`Pi entry point is missing: ${entryPath}`);

const client = new PiRpcClient({
  command: process.execPath,
  args: [
    entryPath,
    "--mode", "rpc",
    "--no-session",
    "--offline",
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
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  },
  label: "Pi RPC smoke",
  requestTimeoutMs: 30_000,
});

try {
  await client.start();
  await client.waitUntilReady({ timeoutMs: 60_000, probeTimeoutMs: 5_000, retryDelayMs: 250 });
  const state = await client.request({ type: "get_state" });
  const models = await client.request({ type: "get_available_models" });
  if (!state?.data?.sessionId) throw new Error("Pi RPC did not return a sessionId");
  if (!Array.isArray(models?.data?.models)) throw new Error("Pi RPC did not return a model array");
  process.stdout.write(`Pi RPC smoke passed: session=${state.data.sessionId}, models=${models.data.models.length}\n`);
} finally {
  await client.stop({ forceAfterMs: 1_000 });
}
