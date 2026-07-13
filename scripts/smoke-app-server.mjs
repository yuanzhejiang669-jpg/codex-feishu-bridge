#!/usr/bin/env node
import os from "node:os";
import path from "node:path";

import { AppServerClient } from "../src/codex/app-server-client.mjs";
import { resolveDefaultTools } from "../src/config/env.mjs";
import { terminateProcessTree } from "../src/runtime/process-runner.mjs";

const workspace = process.cwd();
const client = new AppServerClient({
  tool: resolveDefaultTools().codexCli,
  codexHome: path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex")),
  workspace,
  activeChildren: new Map(),
  terminateProcessTree,
}).start();

try {
  const initialized = await client.request("initialize", {
    clientInfo: { name: "codex-feishu-bridge-smoke", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  }, 15_000);
  client.notify("initialized");
  process.stdout.write(`${JSON.stringify({
    ok: true,
    userAgent: initialized?.userAgent || "",
    pid: client.child?.pid || null,
  })}\n`);
} finally {
  await client.stop();
  await waitForClose(client, 6000);
}

async function waitForClose(target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!target.closed && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!target.closed) throw new Error("codex app-server did not close after smoke test");
}
