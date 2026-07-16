const fs = require("node:fs");
const path = require("node:path");

function markerPath(dataRoot) {
  return path.join(dataRoot, "pending-update-recovery.json");
}

function writeRecoveryMarker(dataRoot, names, targetVersion) {
  fs.mkdirSync(dataRoot, { recursive: true });
  const destination = markerPath(dataRoot);
  const temporary = `${destination}.${process.pid}.tmp`;
  const value = {
    schemaVersion: 1,
    targetVersion: String(targetVersion || ""),
    createdAt: new Date().toISOString(),
    botNames: [...new Set((names || []).map((name) => String(name || "").trim()).filter(Boolean))],
  };
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.rmSync(destination, { force: true });
  fs.renameSync(temporary, destination);
  return value;
}

function readRecoveryMarker(dataRoot) {
  try {
    const value = JSON.parse(fs.readFileSync(markerPath(dataRoot), "utf8"));
    if (value?.schemaVersion !== 1 || !Array.isArray(value.botNames)) return null;
    return value;
  } catch {
    return null;
  }
}

function clearRecoveryMarker(dataRoot) {
  fs.rmSync(markerPath(dataRoot), { force: true });
}

async function restoreUpdateBots(dataRoot, startBot) {
  const marker = readRecoveryMarker(dataRoot);
  if (!marker) return { restored: [], failed: [] };
  const restored = [];
  const failed = [];
  for (const name of marker.botNames) {
    try {
      await startBot(name);
      restored.push(name);
    } catch (error) {
      failed.push({ name, error: String(error?.message || error) });
    }
  }
  if (!failed.length) clearRecoveryMarker(dataRoot);
  return { restored, failed };
}

module.exports = {
  clearRecoveryMarker,
  markerPath,
  readRecoveryMarker,
  restoreUpdateBots,
  writeRecoveryMarker,
};
