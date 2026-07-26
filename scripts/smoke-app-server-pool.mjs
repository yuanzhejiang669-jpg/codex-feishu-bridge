#!/usr/bin/env node
import os from "node:os";
import path from "node:path";

import { AppServerClient } from "../src/codex/app-server-client.mjs";
import { createAppServerPool } from "../src/codex/app-server-pool.mjs";
import { resolveDefaultTools } from "../src/config/env.mjs";
import { terminateProcessTree } from "../src/runtime/process-runner.mjs";

const workspace = process.cwd();
const activeChildren = new Map();
const pool = createAppServerPool({
  maxSize: 1,
  idleTtlMs: 60_000,
  createClient: () => new AppServerClient({
    tool: resolveDefaultTools().codexCli,
    codexHome: path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex")),
    workspace,
    activeChildren,
    terminateProcessTree,
  }).start(),
});

try {
  const first = await pool.acquire();
  const firstInitialization = await first.ensureInitialized(initialize);
  const firstPid = first.client.child?.pid || null;
  await first.release();

  const second = await pool.acquire();
  const secondInitialization = await second.ensureInitialized(initialize);
  const secondPid = second.client.child?.pid || null;
  await second.release();

  if (!firstPid || firstPid !== secondPid || firstInitialization.warm || !secondInitialization.warm) {
    throw new Error("app-server pool did not preserve one initialized process across leases");
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    pid: firstPid,
    coldInitializeMs: firstInitialization.durationMs,
    warmInitializeMs: secondInitialization.durationMs,
    pool: pool.stats(),
  })}\n`);
} finally {
  await pool.closeAll("smoke-complete");
  const deadline = Date.now() + 6000;
  while (activeChildren.size && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (activeChildren.size) throw new Error("pooled codex app-server did not close after smoke test");
}

async function initialize(client) {
  const initialized = await client.request("initialize", {
    clientInfo: { name: "codex-feishu-bridge-pool-smoke", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  }, 15_000);
  client.notify("initialized");
  return initialized;
}
