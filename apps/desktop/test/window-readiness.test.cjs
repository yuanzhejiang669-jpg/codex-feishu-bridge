const assert = require("node:assert/strict");
const test = require("node:test");
const { createWindowReadiness } = require("../src/main/services/window-readiness.cjs");

test("defers and coalesces show requests until the desktop IPC is ready", () => {
  let showCount = 0;
  const readiness = createWindowReadiness(() => { showCount += 1; });

  assert.equal(readiness.requestShow(), false);
  assert.equal(readiness.requestShow(), false);
  assert.deepEqual(readiness.snapshot(), { ready: false, pending: true });
  assert.equal(showCount, 0);

  assert.equal(readiness.markReady(), true);
  assert.deepEqual(readiness.snapshot(), { ready: true, pending: false });
  assert.equal(showCount, 1);
});

test("shows immediately after the desktop IPC is ready", () => {
  let showCount = 0;
  const readiness = createWindowReadiness(() => { showCount += 1; });

  assert.equal(readiness.markReady(), false);
  assert.equal(readiness.requestShow(), true);
  assert.equal(readiness.requestShow(), true);
  assert.equal(showCount, 2);
});
