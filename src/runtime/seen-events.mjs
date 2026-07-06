import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function createSeenEventsStore({
  seenPath,
  eventLocksDir,
  instanceName = "",
  processId = process.pid,
  log = () => {},
} = {}) {
  const seen = loadSeen(seenPath);

  function saveSeen() {
    const last = [...seen].slice(-1000);
    fs.writeFileSync(seenPath, JSON.stringify(last, null, 2), "utf8");
  }

  function remember(id) {
    if (!id) return false;
    if (seen.has(id)) return true;
    seen.add(id);
    if (seen.size > 1200) {
      const trimmed = [...seen].slice(-1000);
      seen.clear();
      for (const item of trimmed) seen.add(item);
    }
    saveSeen();
    return false;
  }

  function eventLockPath(id) {
    const hash = crypto.createHash("sha256").update(String(id || "")).digest("hex").slice(0, 32);
    return path.join(eventLocksDir, `${hash}.json`);
  }

  function cleanupOldEventLocks() {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    try {
      for (const entry of fs.readdirSync(eventLocksDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const file = path.join(eventLocksDir, entry.name);
        const stat = fs.statSync(file);
        if (stat.mtimeMs < cutoff) fs.rmSync(file, { force: true });
      }
    } catch (error) {
      log("WARN", "event lock cleanup failed", { error: String(error.message || error) });
    }
  }

  function rememberEvent(id, messageId = "") {
    if (!id) return false;
    if (seen.has(id)) return true;

    const file = eventLockPath(id);
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeFileSync(fd, JSON.stringify({
        id,
        messageId,
        pid: processId,
        instance: instanceName,
        createdAt: Date.now(),
      }, null, 2), "utf8");
      fs.closeSync(fd);
    } catch (error) {
      if (error?.code === "EEXIST") return true;
      log("WARN", "event lock failed; falling back to local dedupe", {
        id,
        messageId,
        error: String(error.message || error),
      });
    }

    remember(id);
    return false;
  }

  return {
    cleanupOldEventLocks,
    eventLockPath,
    remember,
    rememberEvent,
    saveSeen,
    seen,
  };
}

function loadSeen(seenPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(seenPath, "utf8"));
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}
