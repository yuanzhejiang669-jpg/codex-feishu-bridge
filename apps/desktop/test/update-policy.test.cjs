const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildInstallPlan } = require("../src/main/services/update-policy.cjs");
const { createUpdaterService } = require("../src/main/services/updater.cjs");
const { collectKnownPaths, isKnownPath } = require("../src/main/services/known-paths.cjs");
const { selectLinuxRelease } = require("../src/main/services/linux-release-updater.cjs");
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

test("prunes succeeded bots from recovery marker on partial failure (P1-5)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-update-recovery-partial-"));
  try {
    writeRecoveryMarker(root, ["ok-bot", "broken-bot"], "0.10.14");
    const result = await restoreUpdateBots(root, async (name) => {
      if (name === "broken-bot") throw new Error("broken");
    });
    assert.deepEqual(result.restored, ["ok-bot"]);
    assert.equal(result.failed.length, 1);
    assert.deepEqual(readRecoveryMarker(root).botNames, ["broken-bot"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("updater install() deduplicates concurrent clicks during slow prepareInstall (P1-10)", async () => {
  const EventEmitter = require("node:events");
  const fakeUpdater = new EventEmitter();
  let quitCalls = 0;
  let prepareCalls = 0;
  fakeUpdater.quitAndInstall = () => { quitCalls += 1; };
  let releasePrepare;
  const service = createUpdaterService({
    supported: true,
    updater: fakeUpdater,
    currentVersion: "0.10.12",
    inspectBots: async () => [{ name: "antigravity-5", online: true, activeRunCount: 0 }],
    prepareInstall: async () => {
      prepareCalls += 1;
      await new Promise((r) => { releasePrepare = r; });
      return { rollback: async () => {} };
    },
  });
  service.start();
  fakeUpdater.emit("update-downloaded", { version: "0.10.14" });
  const first = service.install();
  // Wait a tick for prepareInstall to start; status must already be "installing"
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(service.snapshot().status, "installing");
  const second = await service.install();
  assert.equal(second.status, "installing");
  assert.equal(prepareCalls, 1);
  releasePrepare();
  await first;
  assert.equal(quitCalls, 1);
  service.stop();
});

test("known-paths exposes bot.runtimeRoot, setup.runtimeLocalAppData, and capabilities.agentsPath (P1-8)", () => {
  const known = collectKnownPaths({
    capabilities: { agentsPath: "C:\\test\\.codex\\AGENTS.md" },
    setup: {
      runtimeLocalAppData: "C:\\test\\runtime-local",
      managedBots: [{ name: "b1", runtimeRoot: "C:\\test\\runtime-local\\instances\\b1" }],
    },
  });
  assert.equal(isKnownPath("C:\\test\\.codex\\AGENTS.md", known), true);
  assert.equal(isKnownPath("C:\\test\\runtime-local", known), true);
  assert.equal(isKnownPath("C:\\test\\runtime-local\\instances\\b1", known), true);
});

test("selectLinuxRelease respects allowPrerelease = false (P2-6)", () => {
  const releases = [
    {
      draft: false,
      prerelease: true,
      body: "beta",
      assets: [
        { name: "checksums-linux.txt", browser_download_url: "https://example.test/c" },
        { name: "Codex-Feishu-Bridge-0.10.99-linux-amd64.deb", browser_download_url: "https://example.test/d" },
      ],
    },
    {
      draft: false,
      prerelease: false,
      body: "stable",
      assets: [
        { name: "checksums-linux.txt", browser_download_url: "https://example.test/c2" },
        { name: "Codex-Feishu-Bridge-0.10.14-linux-amd64.deb", browser_download_url: "https://example.test/d2" },
      ],
    },
  ];
  assert.equal(selectLinuxRelease(releases, "0.10.12", false)?.version, "0.10.14");
  assert.equal(selectLinuxRelease(releases, "0.10.12", true)?.version, "0.10.99");
});
