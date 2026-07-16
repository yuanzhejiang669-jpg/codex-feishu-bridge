const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeReleaseVersion } = require("../scripts/release-version.cjs");

test("treats Windows two-part and semantic three-part release versions equally", () => {
  assert.equal(normalizeReleaseVersion("0.2"), "0.2.0");
  assert.equal(normalizeReleaseVersion("0.2.0"), "0.2.0");
  assert.equal(normalizeReleaseVersion("0.2.0.0"), "0.2.0");
  assert.equal(normalizeReleaseVersion("01.02.003"), "1.2.3");
  assert.equal(normalizeReleaseVersion("0.2.0.1"), "0.2.0.1");
});
