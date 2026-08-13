import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readThreadMetrics } from "../src/sessions/thread-metrics.mjs";

test("reads rollout size and the latest three first-token delays", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "thread-metrics-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const rollout = path.join(directory, "rollout.jsonl");
  const lines = [
    { type: "event_msg", payload: { type: "task_complete", time_to_first_token_ms: 1000 } },
    { type: "event_msg", payload: { type: "task_complete", duration_ms: 9999 } },
    { type: "event_msg", payload: { type: "task_complete", time_to_first_token_ms: 2000 } },
    { type: "event_msg", payload: { type: "task_complete", time_to_first_token_ms: 3000 } },
    { type: "event_msg", payload: { type: "task_complete", time_to_first_token_ms: 4000 } },
  ].map(JSON.stringify).join("\n") + "\n";
  fs.writeFileSync(rollout, lines, "utf8");

  const result = readThreadMetrics(rollout, { initialReadBytes: 64 });
  assert.equal(result.rolloutBytes, Buffer.byteLength(lines));
  assert.deepEqual(result.firstTokenSamplesMs, [2000, 3000, 4000]);
});

test("returns unknown metrics for a missing rollout", () => {
  assert.deepEqual(readThreadMetrics("missing.jsonl"), {
    rolloutBytes: null,
    firstTokenSamplesMs: [],
  });
});
