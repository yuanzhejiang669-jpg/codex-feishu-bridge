import fs from "node:fs";
import { safeJson } from "./errors.mjs";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_BACKUPS = 3;

export function nowIso() {
  return new Date().toISOString();
}

export function createLogger(logPath, options = {}) {
  const maxBytes = nonNegativeInteger(options.maxBytes, DEFAULT_MAX_BYTES);
  const maxBackups = nonNegativeInteger(options.maxBackups, DEFAULT_MAX_BACKUPS);
  const mirrorToConsole = options.mirrorToConsole !== false;
  let currentBytes = fileSize(logPath);

  return function log(level, message, meta = undefined) {
    const line = meta === undefined
      ? `${nowIso()} ${level} ${message}`
      : `${nowIso()} ${level} ${message} ${safeJson(meta)}`;
    const output = `${line}\n`;
    const outputBytes = Buffer.byteLength(output, "utf8");
    if (maxBytes > 0 && currentBytes > 0 && currentBytes + outputBytes > maxBytes) {
      rotateLogFiles(logPath, maxBackups);
      currentBytes = 0;
    }
    fs.appendFileSync(logPath, output, "utf8");
    currentBytes += outputBytes;
    if (mirrorToConsole) {
      const stream = level === "ERROR" ? process.stderr : process.stdout;
      stream.write(output);
    }
  };
}

function rotateLogFiles(logPath, maxBackups) {
  if (!fs.existsSync(logPath)) return;
  if (maxBackups === 0) {
    fs.truncateSync(logPath, 0);
    return;
  }

  for (let index = maxBackups; index >= 2; index -= 1) {
    const source = `${logPath}.${index - 1}`;
    const target = `${logPath}.${index}`;
    if (!fs.existsSync(source)) continue;
    fs.rmSync(target, { force: true });
    fs.renameSync(source, target);
  }
  const firstBackup = `${logPath}.1`;
  fs.rmSync(firstBackup, { force: true });
  fs.renameSync(logPath, firstBackup);
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function nonNegativeInteger(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}
