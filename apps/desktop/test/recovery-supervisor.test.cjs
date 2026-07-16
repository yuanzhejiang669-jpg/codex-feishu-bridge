const assert = require("node:assert/strict");
const test = require("node:test");
const { createRecoverySupervisor } = require("../src/main/services/recovery-supervisor.cjs");

test("starts only an offline Bot with auto-start enabled", async () => {
  const started = [];
  const supervisor = createRecoverySupervisor({
    inspectBots: async () => [
      { name: "manual", autoStart: false, online: false },
      { name: "online", autoStart: true, online: true },
      { name: "recover", autoStart: true, online: false },
    ],
    startBot: async (name) => { started.push(name); },
    now: () => 1000,
  });
  assert.deepEqual(await supervisor.tick(), { action: "started", name: "recover" });
  assert.deepEqual(started, ["recover"]);
  assert.equal(supervisor.snapshot().recover.status, "healthy");
});

test("backs off repeated recovery failures", async () => {
  let timestamp = 1000;
  let calls = 0;
  const supervisor = createRecoverySupervisor({
    inspectBots: async () => [{ name: "recover", autoStart: true, online: false }],
    startBot: async () => { calls += 1; throw new Error("invalid credentials"); },
    now: () => timestamp,
    intervalMs: 1000,
    baseBackoffMs: 5000,
    maxBackoffMs: 20_000,
  });
  assert.equal((await supervisor.tick()).delay, 5000);
  timestamp = 2000;
  assert.equal((await supervisor.tick()).action, "idle");
  assert.equal(calls, 1);
  timestamp = 6000;
  assert.equal((await supervisor.tick()).delay, 10_000);
  assert.equal(calls, 2);
  assert.equal(supervisor.snapshot().recover.failures, 2);
});

test("removes recovery state after auto-start is disabled", async () => {
  let enabled = true;
  const supervisor = createRecoverySupervisor({
    inspectBots: async () => enabled ? [{ name: "recover", autoStart: true, online: false }] : [],
    startBot: async () => { throw new Error("failed"); },
    now: () => 1000,
  });
  await supervisor.tick();
  assert.ok(supervisor.snapshot().recover);
  enabled = false;
  await supervisor.tick();
  assert.equal(supervisor.snapshot().recover, undefined);
});
