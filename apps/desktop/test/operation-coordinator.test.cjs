const assert = require("node:assert/strict");
const test = require("node:test");
const { createOperationCoordinator } = require("../src/main/services/operation-coordinator.cjs");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("OperationCoordinator serializes concurrent exclusive operations and ref-counts recovery pause/resume", async () => {
  let pauses = 0;
  let resumes = 0;
  const order = [];
  let inFlight = 0;
  let maxConcurrent = 0;

  const coordinator = createOperationCoordinator({
    pauseRecovery: () => { pauses += 1; },
    resumeRecovery: () => { resumes += 1; },
  });

  const op1 = coordinator.runExclusive("restart-bots", async () => {
    inFlight += 1;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    order.push("op1:start");
    assert.equal(coordinator.snapshot().activeOperation, "restart-bots");
    assert.equal(coordinator.snapshot().paused, true);
    await delay(30);
    order.push("op1:end");
    inFlight -= 1;
    return "r1";
  });

  const op2 = coordinator.runExclusive("apply-provider", async () => {
    inFlight += 1;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    order.push("op2:start");
    await delay(15);
    order.push("op2:end");
    inFlight -= 1;
    return "r2";
  });

  const op3 = coordinator.runExclusive("recovery-tick", async () => {
    inFlight += 1;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    order.push("op3:tick");
    inFlight -= 1;
    return "r3";
  }, { pause: false });

  assert.ok(coordinator.snapshot().queuedCount >= 2);
  const results = await Promise.all([op1, op2, op3]);
  assert.deepEqual(results, ["r1", "r2", "r3"]);
  assert.equal(maxConcurrent, 1);
  assert.deepEqual(order, ["op1:start", "op1:end", "op2:start", "op2:end", "op3:tick"]);
  assert.equal(pauses, 2);
  assert.equal(resumes, 2);
  assert.deepEqual(coordinator.snapshot(), { activeOperation: "", queuedCount: 0, paused: false });
});

test("OperationCoordinator resumes recovery and continues queue even when an operation throws", async () => {
  let pauses = 0;
  let resumes = 0;
  const coordinator = createOperationCoordinator({
    pauseRecovery: () => { pauses += 1; },
    resumeRecovery: () => { resumes += 1; },
  });

  await assert.rejects(
    coordinator.runExclusive("failing-op", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  const next = await coordinator.runExclusive("after-fail", async () => "ok");
  assert.equal(next, "ok");
  assert.equal(pauses, 2);
  assert.equal(resumes, 2);
  assert.equal(coordinator.snapshot().paused, false);
});
