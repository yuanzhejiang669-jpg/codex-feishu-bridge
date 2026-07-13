import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLogger } from "../src/logging/logger.mjs";
import { createActiveRunStore } from "../src/runtime/active-runs.mjs";
import { recordsMatchColumns } from "../src/utils/json.mjs";

test("active run state preserves the previous JSON when an atomic write fails", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-state-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, "active-runs.json");
  const previous = { runs: { existing: { messageId: "existing" } } };
  fs.writeFileSync(statePath, JSON.stringify(previous), "utf8");

  const store = createActiveRunStore({ activeRunsPath: statePath });
  const originalFsync = fs.fsyncSync;
  fs.fsyncSync = () => {
    throw new Error("injected fsync failure");
  };
  try {
    assert.throws(
      () => store.recordActiveRun({ messageId: "new" }),
      /injected fsync failure/,
    );
  } finally {
    fs.fsyncSync = originalFsync;
  }

  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), previous);
  assert.equal(fs.readdirSync(directory).some((name) => name.endsWith(".tmp")), false);

  store.saveActiveRuns();
  const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(saved.runs.existing.messageId, "existing");
  assert.equal(saved.runs.new.messageId, "new");
});

test("logger rotates at the configured size and enforces backup retention", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-log-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const logPath = path.join(directory, "bridge.log");
  const log = createLogger(logPath, {
    maxBytes: 220,
    maxBackups: 2,
    mirrorToConsole: false,
  });

  for (let index = 0; index < 12; index += 1) {
    log("INFO", `entry-${index}-${"x".repeat(70)}`);
  }

  const files = fs.readdirSync(directory).sort();
  assert.deepEqual(files, ["bridge.log", "bridge.log.1", "bridge.log.2"]);
  for (const file of files) {
    assert.ok(fs.statSync(path.join(directory, file)).size <= 220);
  }
});

test("sidebar record comparison detects only material column changes", () => {
  const current = { id: "thread-1", title: "Title", archived: 0, nullable: null };
  const columns = ["id", "title", "archived", "nullable"];

  assert.equal(recordsMatchColumns(current, { ...current }, columns), true);
  assert.equal(recordsMatchColumns(current, { ...current, title: "Changed" }, columns), false);
  assert.equal(recordsMatchColumns(null, current, columns), false);
  assert.equal(recordsMatchColumns(current, { ...current, nullable: undefined }, columns), true);
});
