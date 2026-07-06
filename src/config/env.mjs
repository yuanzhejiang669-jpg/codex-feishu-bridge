import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolveDefaultTools() {
  if (process.platform !== "win32") {
    return {
      larkCli: { command: "lark-cli", argsPrefix: [] },
      codexCli: { command: "codex", argsPrefix: [] },
    };
  }

  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const npmRoot = path.join(appData, "npm", "node_modules");
  const larkEntry = path.join(npmRoot, "@larksuite", "cli", "scripts", "run.js");
  const codexEntry = path.join(npmRoot, "@openai", "codex", "bin", "codex.js");
  return {
    larkCli: fs.existsSync(larkEntry)
      ? { command: process.execPath, argsPrefix: [larkEntry] }
      : { command: "cmd.exe", argsPrefix: ["/d", "/s", "/c", "lark-cli.cmd"] },
    codexCli: fs.existsSync(codexEntry)
      ? { command: process.execPath, argsPrefix: [codexEntry] }
      : { command: "cmd.exe", argsPrefix: ["/d", "/s", "/c", "codex.cmd"] },
  };
}

export function resolveDefaultDataRoot() {
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "CodexFeishuBridge",
    );
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "CodexFeishuBridge");
  }

  return path.join(
    process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
    "codex-feishu-bridge",
  );
}

export function parseToolEnv(envName, fallback) {
  const value = process.env[envName];
  if (!value) return fallback;
  if (process.platform === "win32") {
    const lower = value.toLowerCase();
    if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
      return { command: "cmd.exe", argsPrefix: ["/d", "/s", "/c", value] };
    }
    if (lower.endsWith(".ps1")) {
      return {
        command: "powershell.exe",
        argsPrefix: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", value],
      };
    }
  }
  return { command: value, argsPrefix: [] };
}

export function parseEventKeys(value) {
  const keys = String(value || "")
    .split(/[,\s;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const unique = [...new Set(keys)];
  return unique.length ? unique : ["im.message.receive_v1"];
}

export function parseDurationMs(value, fallbackMs) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return fallbackMs;
  if (["0", "none", "never", "infinite", "infinity", "off", "disabled", "false"].includes(raw)) return 0;
  const match = raw.match(/^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h)?$/);
  if (!match) return fallbackMs;
  const number = Number(match[1]);
  if (!Number.isFinite(number) || number < 0) return fallbackMs;
  const unit = match[2] || "ms";
  const factor = unit === "h" ? 60 * 60_000 : unit === "m" ? 60_000 : unit === "s" ? 1000 : 1;
  return Math.round(number * factor);
}

export function hasDuration(ms) {
  return Number.isFinite(ms) && ms > 0;
}

export function durationConfigLabel(ms) {
  return hasDuration(ms) ? `${Math.round(ms / 1000)}s` : "disabled";
}

export function clearTimer(timer) {
  if (timer) clearTimeout(timer);
}

export function withLarkProfile(tool, profile) {
  const name = String(profile || "").trim();
  if (!name) return tool;
  return { ...tool, argsPrefix: [...(tool.argsPrefix || []), "--profile", name] };
}

export function resolveLarkEventLockScope(profile) {
  const appId = resolveLarkConfigAppId(profile);
  const raw = appId ? `app-${appId}` : `profile-${String(profile || "default").trim() || "default"}`;
  return raw.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 96) || "default";
}

export function resolveLarkConfigAppId(profile) {
  const wanted = String(profile || "").trim();
  try {
    const configPath = path.join(os.homedir(), ".lark-cli", "config.json");
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const apps = Array.isArray(parsed?.apps) ? parsed.apps : [];
    const app = wanted
      ? apps.find((item) => String(item?.name || "").trim() === wanted)
      : (apps.find((item) => !String(item?.name || "").trim()) || apps[0]);
    return String(app?.appId || app?.app_id || "").trim();
  } catch {
    return "";
  }
}

export function normalizeRunMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (["exec", "cli"].includes(mode)) return "exec";
  if (["app-server", "appserver", "native", "native-app"].includes(mode)) return "app-server";
  if (["auto", "fallback"].includes(mode)) return "auto";
  return "app-server";
}
