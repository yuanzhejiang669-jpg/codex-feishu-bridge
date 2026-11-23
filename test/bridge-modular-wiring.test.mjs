import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createAttachmentManager } from "../src/feishu/attachments.mjs";
import { createCodexSidebarSync } from "../src/codex/sidebar-sync.mjs";
import { createSessionInventory } from "../src/sessions/inventory.mjs";
import { createRunCardRenderer } from "../src/feishu/cards/run-card.mjs";
import { createCodexRunner } from "../src/codex/runner.mjs";
import { createCommandRouter } from "../src/commands/router.mjs";
import { createBridgeLifecycle } from "../src/runtime/lifecycle.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("T-018: codex-feishu-bridge.mjs stays modular and within <= 1500 lines", () => {
  const lines = fs.readFileSync(path.join(ROOT, "codex-feishu-bridge.mjs"), "utf8").split(/\r?\n/);
  assert.ok(lines.length <= 1500, `Expected <= 1500 lines, got ${lines.length}`);
});

test("T-018: extracted bridge modules have zero circular imports among themselves", () => {
  const moduleFiles = [
    "src/feishu/attachments.mjs",
    "src/codex/sidebar-sync.mjs",
    "src/sessions/inventory.mjs",
    "src/feishu/cards/run-card.mjs",
    "src/codex/runner.mjs",
    "src/commands/router.mjs",
    "src/runtime/lifecycle.mjs",
  ];
  const forbiddenTargets = [
    "/attachments.mjs",
    "/sidebar-sync.mjs",
    "/inventory.mjs",
    "/run-card.mjs",
    "/runner.mjs",
    "/router.mjs",
    "/lifecycle.mjs",
  ];
  for (const rel of moduleFiles) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const importLines = src.split(/\r?\n/).filter((l) => /^\s*import\b/.test(l)).join("\n");
    for (const target of forbiddenTargets) {
      assert.equal(
        importLines.includes(target),
        false,
        `${rel} must not directly import ${target} (use injected deps to avoid cycles)`,
      );
    }
  }
});

test("T-018: all 7 module factories wire cleanly and satisfy every cross-module deps reference", () => {
  const bridgeSrc = fs.readFileSync(path.join(ROOT, "codex-feishu-bridge.mjs"), "utf8");

  // Extract all keys declared in bridgeRuntime = { ... } and Object.assign(bridgeRuntime, { ... })
  const providedKeys = new Set();
  const runtimeStart = bridgeSrc.indexOf("const bridgeRuntime = {");
  const runtimeEnd = bridgeSrc.indexOf("};", runtimeStart);
  assert.ok(runtimeStart >= 0 && runtimeEnd > runtimeStart);
  for (const token of bridgeSrc.slice(runtimeStart + "const bridgeRuntime = {".length, runtimeEnd).split(/[,\s]+/)) {
    const clean = token.trim();
    if (/^[A-Za-z0-9_$]+$/.test(clean)) providedKeys.add(clean);
  }
  const assignStart = bridgeSrc.indexOf("Object.assign(bridgeRuntime, {");
  const assignEnd = bridgeSrc.indexOf("});", assignStart);
  assert.ok(assignStart >= 0 && assignEnd > assignStart);
  for (const token of bridgeSrc.slice(assignStart + "Object.assign(bridgeRuntime, {".length, assignEnd).split(/[,\s]+/)) {
    const clean = token.trim();
    if (/^[A-Za-z0-9_$]+$/.test(clean)) providedKeys.add(clean);
  }

  // Instantiate all 7 factories on a shared stub runtime and verify exported symbols
  const runtime = {
    CONFIG: { engine: "codex", workspace: ROOT, codexHome: ROOT, eventKeys: ["im.message.receive_v1"], larkCli: { command: "lark-cli", argsPrefix: [] }, codexCli: { command: "codex", argsPrefix: [] } },
    ENGINE_LABEL: "Codex",
    log: () => {},
    pendingAttachmentStore: {
      withAttachmentLock: async (_c, fn) => fn(),
      restore: () => {},
    },
  };
  const attachments = createAttachmentManager(runtime);
  Object.assign(runtime, attachments);
  const sidebarSync = createCodexSidebarSync(runtime);
  Object.assign(runtime, sidebarSync);
  const runCard = createRunCardRenderer(runtime);
  Object.assign(runtime, runCard);
  const inventory = createSessionInventory(runtime);
  Object.assign(runtime, inventory);
  const codexRunner = createCodexRunner(runtime);
  Object.assign(runtime, codexRunner);
  const commandRouter = createCommandRouter(runtime);
  Object.assign(runtime, commandRouter);
  const lifecycle = createBridgeLifecycle(runtime);
  Object.assign(runtime, lifecycle);

  for (const key of Object.keys(runtime)) providedKeys.add(key);

  // Spot-check V2 required factory exports
  for (const fn of ["syncCodexSidebarThread", "reconcileCodexDesktopSidebarIndexes", "scheduleSidebarReconcile", "deleteCodexLocalThread"]) {
    assert.equal(typeof sidebarSync[fn], "function", `sidebarSync missing ${fn}`);
  }
  for (const fn of ["downloadImageAttachments", "downloadFileAttachments", "prepareCommandAttachments", "buildPrompt", "withAttachmentLock", "takePendingAttachments", "restorePendingAttachments"]) {
    assert.equal(typeof attachments[fn], "function", `attachments missing ${fn}`);
  }
  for (const fn of ["runCodex", "runCodexAppServer", "startGoalRun", "maybeRouteMessageToGoal"]) {
    assert.equal(typeof codexRunner[fn], "function", `codexRunner missing ${fn}`);
  }
  for (const fn of ["handleCommand", "stopCurrentJob", "stopAllActiveJobs", "clearQueueCommand", "handleSteerCommand", "handleCompactCommand", "handleGoalCommand"]) {
    assert.equal(typeof commandRouter[fn], "function", `commandRouter missing ${fn}`);
  }
  for (const fn of ["startConsumer", "startSidebarReconciler", "startEventConsumer", "shutdown", "isShuttingDown"]) {
    assert.equal(typeof lifecycle[fn], "function", `lifecycle missing ${fn}`);
  }
  for (const fn of ["syncChatSessionsWithCodex", "effectiveSessionSettings", "mergedSessionEntries", "appendHistory"]) {
    assert.equal(typeof inventory[fn], "function", `inventory missing ${fn}`);
  }
  for (const fn of ["createRunState", "renderRunCard", "repairStaleActiveRunsOnStartup", "reduceAppServerEvent"]) {
    assert.equal(typeof runCard[fn], "function", `runCard missing ${fn}`);
  }

  // Verify every `deps.<key>` accessed inside all 7 modules is present in providedKeys
  const moduleFiles = [
    "src/feishu/attachments.mjs",
    "src/codex/sidebar-sync.mjs",
    "src/sessions/inventory.mjs",
    "src/feishu/cards/run-card.mjs",
    "src/codex/runner.mjs",
    "src/commands/router.mjs",
    "src/runtime/lifecycle.mjs",
  ];
  const missing = [];
  for (const rel of moduleFiles) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const destrMatch = src.match(/const\s*\{([\s\S]*?)\}\s*=\s*deps;/);
    if (destrMatch) {
      for (const token of destrMatch[1].split(/[,\s]+/)) {
        const clean = token.trim();
        if (/^[A-Za-z0-9_$]+$/.test(clean) && !providedKeys.has(clean)) {
          missing.push(`${rel}: ${clean}`);
        }
      }
    }
    for (const m of src.matchAll(/\bdeps\.([A-Za-z0-9_$]+)/g)) {
      if (!providedKeys.has(m[1])) {
        missing.push(`${rel}: deps.${m[1]}`);
      }
    }
  }
  assert.deepEqual(missing, [], `Unwired deps found: ${missing.join(", ")}`);
});
