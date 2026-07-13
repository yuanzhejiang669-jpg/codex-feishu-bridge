import fs from "node:fs";

export function createSingleInstanceLock({
  lockPath,
  pidPath,
  owner,
  processAlive,
  log = () => {},
  onDuplicate = () => process.exit(0),
} = {}) {
  const lockOwner = { ...owner };

  function acquire() {
    for (;;) {
      try {
        const fd = fs.openSync(lockPath, "wx");
        try {
          fs.writeFileSync(fd, JSON.stringify(lockOwner, null, 2), "utf8");
        } finally {
          fs.closeSync(fd);
        }
        return true;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const current = readJsonFile(lockPath);
        if (isActive(current)) {
          log("ERROR", "another bridge instance is already running for this state dir", {
            currentPid: current.pid,
            currentInstance: current.instance || "",
            currentWorkspace: current.workspace || "",
            pid: lockOwner.pid,
            lockPath,
          });
          onDuplicate(current);
          return false;
        }
        try {
          fs.rmSync(lockPath, { force: true });
        } catch (removeError) {
          throw new Error(`Unable to remove stale Bridge lock: ${lockPath}`, { cause: removeError });
        }
      }
    }
  }

  function release() {
    try {
      const current = readJsonFile(lockPath);
      if (String(current?.pid || "") === String(lockOwner.pid)) {
        fs.rmSync(lockPath, { force: true });
        return true;
      }
    } catch {}
    return false;
  }

  function isActive(current) {
    if (!current?.pid || !processAlive(current.pid)) return false;
    try {
      return fs.existsSync(pidPath)
        && fs.readFileSync(pidPath, "utf8").trim() === String(current.pid);
    } catch {
      return false;
    }
  }

  return { acquire, isActive, release };
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}
