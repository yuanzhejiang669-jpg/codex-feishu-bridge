import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TRANSIENT_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const RENAME_RETRY_DELAYS_MS = [25, 50, 100, 200, 300, 400, 500, 750];
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeJsonFileAtomicSync(file, value, { space = 2 } = {}) {
  const json = JSON.stringify(value, null, space);
  if (json === undefined) throw new TypeError("JSON value is not serializable");

  const directory = path.dirname(file);
  const tempFile = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let fd = null;
  try {
    fs.mkdirSync(directory, { recursive: true });
    const mode = existingFileMode(file);
    fd = fs.openSync(tempFile, "wx", mode);
    fs.writeFileSync(fd, json, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    renameWithRetrySync(tempFile, file);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      fs.rmSync(tempFile, { force: true });
    } catch {}
  }
}

function renameWithRetrySync(source, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(source, destination);
      return;
    } catch (error) {
      const delayMs = RENAME_RETRY_DELAYS_MS[attempt];
      if (!TRANSIENT_RENAME_CODES.has(error?.code) || delayMs === undefined) throw error;
      Atomics.wait(SLEEP_BUFFER, 0, 0, delayMs);
    }
  }
}

export function recordsMatchColumns(current, expected, columns) {
  if (!current || !expected) return false;
  return [...columns].every((column) => {
    const currentValue = current[column] ?? null;
    const expectedValue = expected[column] ?? null;
    return Object.is(currentValue, expectedValue);
  });
}

export function parseJsonLoose(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {}
  }
  return null;
}

export function findDeepKey(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDeepKey(item, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const item of Object.values(value)) {
    const found = findDeepKey(item, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function existingFileMode(file) {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return 0o600;
  }
}
