import fs from "node:fs";

export function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
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
