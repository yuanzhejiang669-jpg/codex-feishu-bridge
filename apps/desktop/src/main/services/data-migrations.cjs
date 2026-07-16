const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const CURRENT_SCHEMA_VERSION = 1;

function statePath(dataRoot) {
  return path.join(dataRoot, "desktop-state.json");
}

function readState(dataRoot) {
  const filePath = statePath(dataRoot);
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    const schemaVersion = Number(value?.schemaVersion);
    if (!Number.isInteger(schemaVersion) || schemaVersion < 0) throw new Error("schemaVersion 无效");
    return { exists: true, filePath, value, schemaVersion, error: "" };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, filePath, value: null, schemaVersion: 0, error: "" };
    return { exists: true, filePath, value: null, schemaVersion: null, error: error.message };
  }
}

function inspectDataSchema(dataRoot) {
  const state = readState(dataRoot);
  let status = "ready";
  if (state.error) status = "invalid";
  else if (state.schemaVersion > CURRENT_SCHEMA_VERSION) status = "newer-than-client";
  else if (state.schemaVersion < CURRENT_SCHEMA_VERSION) status = "migration-required";
  return {
    dataRoot,
    statePath: state.filePath,
    currentVersion: state.schemaVersion,
    supportedVersion: CURRENT_SCHEMA_VERSION,
    status,
    error: state.error,
  };
}

const DEFAULT_MIGRATIONS = [
  {
    version: 1,
    apply({ dataRoot }) {
      const created = [];
      for (const relativePath of ["managed-bots", "profile-home", "runtime-localappdata"]) {
        const target = path.join(dataRoot, relativePath);
        if (!fs.existsSync(target)) {
          fs.mkdirSync(target, { recursive: true });
          created.push(target);
        }
      }
      return () => {
        for (const target of created.reverse()) {
          try {
            if (fs.readdirSync(target).length === 0) fs.rmdirSync(target);
          } catch {
            // Migration rollback never removes a directory that gained user data.
          }
        }
      };
    },
  },
];

function migrateDesktopData(dataRoot, options = {}) {
  const before = readState(dataRoot);
  if (before.error) throw new Error(`客户端数据状态损坏：${before.error}`);
  if (before.schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(`客户端数据版本 ${before.schemaVersion} 高于当前支持版本 ${CURRENT_SCHEMA_VERSION}`);
  }
  if (
    before.schemaVersion === CURRENT_SCHEMA_VERSION
    && (!options.appVersion || String(before.value?.appVersion || "") === String(options.appVersion))
  ) return inspectDataSchema(dataRoot);

  fs.mkdirSync(dataRoot, { recursive: true });
  const transactionRoot = path.join(dataRoot, `.migration-${crypto.randomUUID()}`);
  fs.mkdirSync(transactionRoot, { recursive: true });
  const rollbackActions = [];
  const migrations = options.migrations || DEFAULT_MIGRATIONS;
  const targetMigrations = migrations
    .filter((item) => item.version > before.schemaVersion && item.version <= CURRENT_SCHEMA_VERSION)
    .sort((left, right) => left.version - right.version);
  let resultingVersion = before.schemaVersion;
  const destination = statePath(dataRoot);
  const originalState = before.exists ? fs.readFileSync(destination) : null;
  const temporary = path.join(transactionRoot, "desktop-state.json");
  const backup = path.join(transactionRoot, "desktop-state.backup.json");
  let stateReplaced = false;

  try {
    for (const migration of targetMigrations) {
      if (migration.version !== resultingVersion + 1) throw new Error(`缺少数据迁移步骤：${resultingVersion} -> ${resultingVersion + 1}`);
      const rollback = migration.apply({ dataRoot, transactionRoot });
      if (typeof rollback === "function") rollbackActions.push(rollback);
      resultingVersion = migration.version;
    }
    if (resultingVersion !== CURRENT_SCHEMA_VERSION) throw new Error(`数据迁移未达到目标版本 ${CURRENT_SCHEMA_VERSION}`);
    options.beforeCommit?.();
    const nextState = {
      schemaVersion: resultingVersion,
      appVersion: String(options.appVersion || ""),
      migratedAt: new Date().toISOString(),
    };
    fs.writeFileSync(temporary, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
    if (before.exists) fs.renameSync(destination, backup);
    fs.renameSync(temporary, destination);
    stateReplaced = true;
    fs.rmSync(backup, { force: true });
    fs.rmSync(transactionRoot, { recursive: true, force: true });
    return inspectDataSchema(dataRoot);
  } catch (error) {
    if (fs.existsSync(backup)) {
      fs.rmSync(destination, { force: true });
      fs.renameSync(backup, destination);
    } else if (stateReplaced) {
      if (originalState) fs.writeFileSync(destination, originalState);
      else fs.rmSync(destination, { force: true });
    }
    for (const rollback of rollbackActions.reverse()) {
      try { rollback(); } catch { /* Preserve the original migration error. */ }
    }
    fs.rmSync(transactionRoot, { recursive: true, force: true });
    throw error;
  }
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_MIGRATIONS,
  inspectDataSchema,
  migrateDesktopData,
  readState,
};
