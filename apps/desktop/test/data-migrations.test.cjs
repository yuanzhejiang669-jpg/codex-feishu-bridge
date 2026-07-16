const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  CURRENT_SCHEMA_VERSION,
  inspectDataSchema,
  migrateDesktopData,
} = require("../src/main/services/data-migrations.cjs");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cfb-data-migration-test-"));
}

test("initializes a new desktop data root at the current schema", () => {
  const parent = tempRoot();
  const dataRoot = path.join(parent, "desktop-data");
  try {
    const result = migrateDesktopData(dataRoot, { appVersion: "0.1.2" });
    assert.equal(result.status, "ready");
    assert.equal(result.currentVersion, CURRENT_SCHEMA_VERSION);
    const state = JSON.parse(fs.readFileSync(path.join(dataRoot, "desktop-state.json"), "utf8"));
    assert.equal(state.appVersion, "0.1.2");
    for (const name of ["managed-bots", "profile-home", "runtime-localappdata"]) {
      assert.equal(fs.existsSync(path.join(dataRoot, name)), true);
    }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("is idempotent after reaching the current schema", () => {
  const parent = tempRoot();
  const dataRoot = path.join(parent, "desktop-data");
  try {
    migrateDesktopData(dataRoot, { appVersion: "0.1.2" });
    const first = fs.readFileSync(path.join(dataRoot, "desktop-state.json"), "utf8");
    migrateDesktopData(dataRoot, { appVersion: "0.1.2" });
    const second = fs.readFileSync(path.join(dataRoot, "desktop-state.json"), "utf8");
    assert.equal(second, first);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("updates the recorded app version without changing the schema", () => {
  const parent = tempRoot();
  const dataRoot = path.join(parent, "desktop-data");
  try {
    migrateDesktopData(dataRoot, { appVersion: "0.1.2" });
    migrateDesktopData(dataRoot, { appVersion: "0.1.3" });
    const state = JSON.parse(fs.readFileSync(path.join(dataRoot, "desktop-state.json"), "utf8"));
    assert.equal(state.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(state.appVersion, "0.1.3");
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("rolls back directories and state when migration commit fails", () => {
  const parent = tempRoot();
  const dataRoot = path.join(parent, "desktop-data");
  try {
    assert.throws(() => migrateDesktopData(dataRoot, {
      appVersion: "0.1.2",
      beforeCommit: () => { throw new Error("injected migration failure"); },
    }), /injected migration failure/);
    assert.equal(fs.existsSync(path.join(dataRoot, "desktop-state.json")), false);
    for (const name of ["managed-bots", "profile-home", "runtime-localappdata"]) {
      assert.equal(fs.existsSync(path.join(dataRoot, name)), false);
    }
    assert.equal(fs.readdirSync(dataRoot).some((name) => name.startsWith(".migration-")), false);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("rejects data written by a newer client", () => {
  const parent = tempRoot();
  const dataRoot = path.join(parent, "desktop-data");
  try {
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(path.join(dataRoot, "desktop-state.json"), JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 }), "utf8");
    assert.equal(inspectDataSchema(dataRoot).status, "newer-than-client");
    assert.throws(() => migrateDesktopData(dataRoot), /高于当前支持版本/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
