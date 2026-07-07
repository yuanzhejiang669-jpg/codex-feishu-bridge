import { execFileSync } from "node:child_process";

export function normalizeEnvName(name) {
  return String(name || "").trim();
}

export function readWindowsUserEnvironmentVariables() {
  if (process.platform !== "win32") return {};
  try {
    const raw = execFileSync(
      "reg.exe",
      ["query", "HKCU\\Environment"],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const result = {};
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([^\s]+)\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/);
      if (!match) continue;
      result[match[1].toUpperCase()] = match[2];
    }
    return result;
  } catch {
    return {};
  }
}

export function userEnvironmentVariable(name) {
  const key = normalizeEnvName(name);
  if (!key) return "";
  const env = readWindowsUserEnvironmentVariables();
  return env[key.toUpperCase()] || "";
}

export function environmentVariableValue(name) {
  const key = normalizeEnvName(name);
  if (!key) return "";
  return process.env[key] || userEnvironmentVariable(key) || "";
}

export function environmentVariableSource(name) {
  const key = normalizeEnvName(name);
  if (!key) return "";
  if (process.env[key]) return "process";
  if (userEnvironmentVariable(key)) return "user";
  return "";
}
