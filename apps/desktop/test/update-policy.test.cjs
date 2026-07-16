const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildInstallPlan } = require("../src/main/services/update-policy.cjs");
const {
  readRecoveryMarker,
  restoreUpdateBots,
  writeRecoveryMarker,
} = require("../src/main/services/update-recovery.cjs");

test("blocks update installation while any managed Bot has an active task", () => {
  const plan = buildInstallPlan([
    { name: "idle", online: true, activeRunCount: 0 },
    { name: "busy", online: true, activeRunCount: 2 },
  ]);
  assert.equal(plan.allowed, false);
  assert.deepEqual(plan.activeBots, [{ name: "busy", activeRunCount: 2 }]);
  assert.deepEqual(plan.restartNames, ["idle", "busy"]);
});

test("records online Bots and restores them after an update", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-update-recovery-test-"));
  try {
    writeRecoveryMarker(root, ["assistant-1", "assistant-2", "assistant-1"], "0.2.0");
    assert.deepEqual(readRecoveryMarker(root).botNames, ["assistant-1", "assistant-2"]);
    const restored = [];
    const result = await restoreUpdateBots(root, async (name) => { restored.push(name); });
    assert.deepEqual(result.failed, []);
    assert.deepEqual(restored, ["assistant-1", "assistant-2"]);
    assert.equal(readRecoveryMarker(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("replaces a stale recovery marker before a later update", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-update-recovery-test-"));
  try {
    writeRecoveryMarker(root, ["old-bot"], "0.2.0");
    writeRecoveryMarker(root, ["new-bot"], "0.2.1");
    assert.deepEqual(readRecoveryMarker(root).botNames, ["new-bot"]);
    assert.equal(readRecoveryMarker(root).targetVersion, "0.2.1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("keeps the recovery marker when a Bot cannot be restored", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-update-recovery-test-"));
  try {
    writeRecoveryMarker(root, ["assistant-1"], "0.2.0");
    const result = await restoreUpdateBots(root, async () => { throw new Error("offline"); });
    assert.equal(result.failed.length, 1);
    assert.deepEqual(readRecoveryMarker(root).botNames, ["assistant-1"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
