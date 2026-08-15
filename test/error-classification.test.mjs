import test from "node:test";
import assert from "node:assert/strict";

import {
  bridgeTimeoutError,
  classifyCodexFailure,
  nativeRetryExhaustedFailure,
  shouldWaitForNativeRetry,
} from "../src/logging/errors.mjs";
import { createServiceTierPolicy } from "../src/config/service-tier.mjs";
import { createRunWatchdog } from "../src/runtime/run-watchdog.mjs";

test("response stream disconnect wins over request timed out and waits for native retry", () => {
  const params = {
    message: "Reconnecting... 2/5\nrequest timed out",
    codexErrorInfo: {
      responseStreamDisconnected: {
        httpStatusCode: null,
      },
    },
    willRetry: true,
  };

  const failure = classifyCodexFailure(params);
  assert.equal(failure.kind, "stream_disconnect");
  assert.equal(failure.recoverable, true);
  assert.equal(shouldWaitForNativeRetry(failure, params.willRetry), true);
});

test("stream disconnected before completion is recoverable", () => {
  const failure = classifyCodexFailure("stream disconnected before completion");
  assert.equal(failure.kind, "stream_disconnect");
  assert.equal(failure.recoverable, true);
});

test("a real Bridge total watchdog failure is timeout and not recoverable", async () => {
  const watchdog = createRunWatchdog("codex app-server", null, { totalMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const failure = classifyCodexFailure(
    bridgeTimeoutError(watchdog.reason, "total"),
  );
  watchdog.clear();
  assert.equal(watchdog.timedOut, true);
  assert.equal(failure.kind, "timeout");
  assert.equal(failure.recoverable, false);
  assert.match(failure.message, /总时长/);
});

test("a real Bridge idle watchdog failure is timeout and not recoverable", async () => {
  const watchdog = createRunWatchdog("codex app-server", null, { idleMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const failure = classifyCodexFailure(
    bridgeTimeoutError(watchdog.reason, "idle"),
  );
  watchdog.clear();
  assert.equal(watchdog.timedOut, true);
  assert.equal(failure.kind, "timeout");
  assert.equal(failure.recoverable, false);
  assert.match(failure.message, /无进展/);
});

test("stream disconnect with willRetry false does not wait for native retry", () => {
  const failure = classifyCodexFailure({
    message: "request timed out",
    codexErrorInfo: {
      responseStreamDisconnected: {
        httpStatusCode: null,
      },
    },
    willRetry: false,
  });
  assert.equal(failure.kind, "stream_disconnect");
  assert.equal(failure.recoverable, true);
  assert.equal(shouldWaitForNativeRetry(failure, false), false);
  const exhausted = nativeRetryExhaustedFailure(failure, false);
  assert.equal(exhausted.kind, "stream_disconnect");
  assert.equal(exhausted.recoverable, true);
  assert.equal(exhausted.label, "Codex 响应流重连失败");
});

test("a generic upstream request timeout is not mislabeled as Bridge timeout", () => {
  const failure = classifyCodexFailure("request timed out");
  assert.equal(failure.kind, "unknown");
});

test("local Windows file locks never trigger service tier fallback", () => {
  const error = new Error("EPERM: operation not permitted, rename active-runs.json.tmp -> active-runs.json");
  error.code = "EPERM";
  const failure = classifyCodexFailure(error);
  assert.equal(failure.kind, "local_io");

  const policy = createServiceTierPolicy({
    findProvider: () => ({ serviceTierPassthrough: true }),
  });
  const tierPlan = policy.serviceTierPlanForTurnSettings({
    provider: "backup-api",
    serviceTier: "standard",
  });
  assert.equal(policy.shouldRetryWithoutServiceTier(failure, tierPlan), false);
});
