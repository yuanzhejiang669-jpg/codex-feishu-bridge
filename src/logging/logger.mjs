import fs from "node:fs";
import { safeJson } from "./errors.mjs";

export function nowIso() {
  return new Date().toISOString();
}

export function createLogger(logPath) {
  return function log(level, message, meta = undefined) {
    const line = meta === undefined
      ? `${nowIso()} ${level} ${message}`
      : `${nowIso()} ${level} ${message} ${safeJson(meta)}`;
    fs.appendFileSync(logPath, `${line}\n`, "utf8");
    const stream = level === "ERROR" ? process.stderr : process.stdout;
    stream.write(`${line}\n`);
  };
}
