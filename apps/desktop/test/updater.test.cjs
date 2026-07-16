const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { createUpdaterService } = require("../src/main/services/updater.cjs");

function fakeUpdater() {
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => {};
  updater.quitAndInstall = () => { updater.installed = true; };
  return updater;
}

test("tracks download events and blocks installation while a Bot is active", async () => {
  const updater = fakeUpdater();
  let prepared = false;
  const service = createUpdaterService({
    supported: true,
    updater,
    currentVersion: "0.2.0",
    checkDelayMs: 60_000,
    inspectBots: async () => [{ name: "assistant-1", online: true, activeRunCount: 1 }],
    prepareInstall: async () => { prepared = true; },
  });
  service.start();
  try {
    updater.emit("update-available", { version: "0.2.1" });
    updater.emit("download-progress", { percent: 55.4 });
    updater.emit("update-downloaded", { version: "0.2.1" });
    assert.equal(service.snapshot().status, "downloaded");
    const blocked = await service.install();
    assert.equal(blocked.status, "blocked");
    assert.deepEqual(blocked.activeBots, [{ name: "assistant-1", activeRunCount: 1 }]);
    assert.equal(prepared, false);
    assert.equal(updater.installed, undefined);
  } finally {
    service.stop();
  }
});

test("prepares and invokes the installer only after every Bot is idle", async () => {
  const updater = fakeUpdater();
  const prepared = [];
  const service = createUpdaterService({
    supported: true,
    updater,
    currentVersion: "0.2.0",
    checkDelayMs: 60_000,
    inspectBots: async () => [{ name: "assistant-1", online: true, activeRunCount: 0 }],
    prepareInstall: async (names, version) => {
      prepared.push({ names, version });
      return { rollback: async () => {} };
    },
  });
  service.start();
  try {
    updater.emit("update-downloaded", { version: "0.2.1" });
    const result = await service.install();
    assert.equal(result.status, "installing");
    assert.deepEqual(prepared, [{ names: ["assistant-1"], version: "0.2.1" }]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(updater.installed, true);
  } finally {
    service.stop();
  }
});
