const assert = require("node:assert/strict");
const test = require("node:test");
const { isRetryableNetworkError } = require("../scripts/run-electron-builder.cjs");

test("retries only transient electron-builder network failures", () => {
  assert.equal(isRetryableNetworkError("RequestError: read ETIMEDOUT"), true);
  assert.equal(isRetryableNetworkError("download failed: socket hang up"), true);
  assert.equal(isRetryableNetworkError("configuration validation failed"), false);
  assert.equal(isRetryableNetworkError("JavaScript syntax error"), false);
});
