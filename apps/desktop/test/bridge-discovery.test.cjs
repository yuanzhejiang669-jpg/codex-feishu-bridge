const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { activeRunCount, discoverBridge } = require("../src/main/services/bridge-discovery.cjs");

test("activeRunCount counts only non-null runs", () => {
  assert.equal(activeRunCount({ runs: { first: {}, second: null, third: { id: 3 } } }), 2);
  assert.equal(activeRunCount({}), 0);
  assert.equal(activeRunCount(null), 0);
});

test("discovers the root default instance and ignores a stale instances/default duplicate", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-desktop-discovery-"));
  try {
    const rootState = path.join(root, "state");
    const duplicateState = path.join(root, "instances", "default", "state");
    fs.mkdirSync(rootState, { recursive: true });
    fs.mkdirSync(duplicateState, { recursive: true });
    fs.writeFileSync(path.join(rootState, "bridge.pid"), String(process.pid), "utf8");
    fs.writeFileSync(path.join(rootState, "launch-config.json"), JSON.stringify({ workspace: "C:\\root-default" }), "utf8");
    fs.writeFileSync(path.join(duplicateState, "launch-config.json"), JSON.stringify({ workspace: "C:\\stale-default" }), "utf8");
    const bridge = discoverBridge(root);
    const defaults = bridge.instances.filter((item) => item.name === "default");
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0].workspace, "C:\\root-default");
    assert.equal(defaults[0].online, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
