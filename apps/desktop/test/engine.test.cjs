const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readManifest } = require("../src/main/services/engine.cjs");

test("readManifest reads a staged protocol manifest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-engine-test-"));
  try {
    fs.writeFileSync(path.join(root, "desktop-engine-manifest.json"), '{"protocolVersion":1}', "utf8");
    assert.deepEqual(readManifest(root), { protocolVersion: 1 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

