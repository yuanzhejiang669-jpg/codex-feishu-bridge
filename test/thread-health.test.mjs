import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  evaluateThreadHealth,
  markThreadHealthNotified,
  normalizeThreadHealthConfig,
  recordThreadHealthSample,
} from "../src/sessions/thread-health.mjs";

const MB = 1_000_000;
const bridgeSource = fs.readFileSync(new URL("../codex-feishu-bridge.mjs", import.meta.url), "utf8");

function sample(previous, threadId, rolloutMb, resumeMs) {
  return recordThreadHealthSample(previous, {
    threadId,
    rolloutBytes: rolloutMb * MB,
    resumeMs,
    now: 1_000,
  });
}

test("does not warn for a large but fast thread", () => {
  let health = null;
  for (const resumeMs of [2_000, 3_000, 4_000]) health = sample(health, "thread-1", 160, resumeMs);
  assert.equal(evaluateThreadHealth(health).level, 0);
});

test("warns when size and the three-sample median cross the warning thresholds", () => {
  let health = null;
  for (const resumeMs of [14_000, 15_000, 16_000]) health = sample(health, "thread-1", 120, resumeMs);
  const result = evaluateThreadHealth(health);
  assert.equal(result.level, 1);
  assert.equal(result.reason, "warning_size_and_resume");
  assert.equal(result.medianResumeMs, 15_000);
  assert.equal(result.shouldNotify, true);
});

test("warns after three persistently slow resumes even when the thread is small", () => {
  let health = null;
  for (const resumeMs of [30_000, 31_000, 32_000]) health = sample(health, "thread-1", 20, resumeMs);
  const result = evaluateThreadHealth(health);
  assert.equal(result.level, 1);
  assert.equal(result.reason, "warning_persistent_resume");
});

test("persistent resume warning does not depend on rollout stat availability", () => {
  let health = null;
  for (const resumeMs of [30_000, 31_000, 32_000]) {
    health = recordThreadHealthSample(health, { threadId: "thread-1", resumeMs });
  }
  const result = evaluateThreadHealth(health);
  assert.equal(result.rolloutSizeKnown, false);
  assert.equal(result.level, 1);
  assert.equal(result.reason, "warning_persistent_resume");
});

test("does not warn for only one or two persistently slow resumes", () => {
  let health = sample(null, "thread-1", 20, 31_000);
  health = sample(health, "thread-1", 20, 32_000);
  assert.equal(evaluateThreadHealth(health).level, 0);
});

test("warns critically for a 200 MB thread or two consecutive minute-long resumes", () => {
  const bySize = evaluateThreadHealth(sample(null, "thread-1", 200, 2_000));
  assert.equal(bySize.level, 2);
  assert.equal(bySize.reason, "critical_size");

  let byResume = sample(null, "thread-2", 20, 61_000);
  byResume = sample(byResume, "thread-2", 20, 65_000);
  const resumeResult = evaluateThreadHealth(byResume);
  assert.equal(resumeResult.level, 2);
  assert.equal(resumeResult.reason, "critical_resume");
});

test("keeps rollout size unknown when stat data is unavailable", () => {
  let health = recordThreadHealthSample(null, { threadId: "thread-1", resumeMs: 61_000 });
  health = recordThreadHealthSample(health, { threadId: "thread-1", resumeMs: 65_000 });
  const result = evaluateThreadHealth(health);
  assert.equal(result.rolloutBytes, null);
  assert.equal(result.rolloutSizeKnown, false);
  assert.equal(result.level, 2);
  assert.equal(result.reason, "critical_resume");
});

test("persists reminder level and resets samples when the native thread changes", () => {
  let health = sample(null, "thread-1", 200, 70_000);
  health = markThreadHealthNotified(health, 2, 2_000);
  assert.equal(evaluateThreadHealth(health).shouldNotify, false);

  health = sample(health, "thread-2", 10, 1_000);
  assert.equal(health.notifiedLevel, 0);
  assert.deepEqual(health.resumeSamplesMs, [1_000]);
  assert.equal(evaluateThreadHealth(health).level, 0);
});

test("normalizes inverted or invalid threshold configuration", () => {
  const config = normalizeThreadHealthConfig({
    warningBytes: 200 * MB,
    criticalBytes: 100 * MB,
    warningResumeMs: 60_000,
    persistentResumeMs: 90_000,
    criticalResumeMs: 10_000,
    sampleWindow: 0,
    criticalSampleCount: 99,
  });
  assert.equal(config.criticalBytes, 200 * MB);
  assert.equal(config.criticalResumeMs, 90_000);
  assert.equal(config.sampleWindow, 3);
  assert.equal(config.criticalSampleCount, 3);
});

test("Bridge records resume time, preserves reminder state, and clears active state before notifying", () => {
  assert.match(bridgeSource, /threadResumeMs: threadReadyAt - initializedAt/);
  assert.match(bridgeSource, /threadHealth: entry\?\.threadHealth \|\| null/);
  const clearAt = bridgeSource.indexOf("if (activeRunRecorded) clearActiveRun(messageId);\n    await maybeSendThreadHealthReminder");
  assert.notEqual(clearAt, -1);
  assert.match(bridgeSource, /CODEX_FEISHU_THREAD_HEALTH_WARNING_RESUME_MS, 15_000/);
  assert.match(bridgeSource, /CODEX_FEISHU_THREAD_HEALTH_PERSISTENT_RESUME_MS, 30_000/);
  assert.match(bridgeSource, /最近.*次本地线程恢复/);
});
