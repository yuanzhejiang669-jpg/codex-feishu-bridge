import path from "node:path";
import { parse as parseToml } from "smol-toml";

const SHARED_TEMPLATE_PATTERN = /\$\{(?:CLAUDE_CONFIG_DIR|PLAYWRIGHT_MCP_USER_DATA_DIR|PLAYWRIGHT_MCP_OUTPUT_DIR)(?::-[^}]*)?\}/;
const SHARED_DEFAULT_PATH_PATTERN = /(?:^|\/)(?:browser-(?:profiles|artifacts|output)\/)?cloakbrowser\/default$/i;

export function resolveCloakBrowserDirs(config, env = process.env) {
  const stateDir = String(config?.stateDir || "").trim();
  const userDataDir = String(env?.PLAYWRIGHT_MCP_USER_DATA_DIR || "").trim()
    || (stateDir ? path.join(stateDir, "browser-profiles", "cloakbrowser") : "");
  const outputDir = String(env?.PLAYWRIGHT_MCP_OUTPUT_DIR || "").trim()
    || (stateDir ? path.join(stateDir, "browser-output", "cloakbrowser") : "");
  return { userDataDir, outputDir };
}

export function shouldOverrideCloakBrowserPath(rawValue) {
  const value = String(rawValue ?? "").trim();
  if (!value) return true;
  if (SHARED_TEMPLATE_PATTERN.test(value)) return true;
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return SHARED_DEFAULT_PATH_PATTERN.test(normalized);
}

export function applyCloakBrowserIsolationToServer(server, dirs) {
  if (!server || typeof server !== "object" || server.disabled === true || server.enabled === false) return server;
  const currentEnv = server.env && typeof server.env === "object" && !Array.isArray(server.env) ? server.env : {};
  const nextEnv = { ...currentEnv };
  let changed = false;
  if (dirs?.userDataDir && shouldOverrideCloakBrowserPath(currentEnv.PLAYWRIGHT_MCP_USER_DATA_DIR)) {
    nextEnv.PLAYWRIGHT_MCP_USER_DATA_DIR = dirs.userDataDir;
    changed = true;
  }
  if (dirs?.outputDir && shouldOverrideCloakBrowserPath(currentEnv.PLAYWRIGHT_MCP_OUTPUT_DIR)) {
    nextEnv.PLAYWRIGHT_MCP_OUTPUT_DIR = dirs.outputDir;
    changed = true;
  }
  return changed ? { ...server, env: nextEnv } : server;
}

export function applyCloakBrowserIsolationToMcpConfig(mcpObject, dirs) {
  if (!mcpObject || typeof mcpObject !== "object" || Array.isArray(mcpObject)) return { mcp: mcpObject, changed: false };
  const servers = mcpObject.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers) || !servers.cloakbrowser) return { mcp: mcpObject, changed: false };
  const current = servers.cloakbrowser;
  const updated = applyCloakBrowserIsolationToServer(current, dirs);
  if (updated === current) return { mcp: mcpObject, changed: false };
  return { mcp: { ...mcpObject, mcpServers: { ...servers, cloakbrowser: updated } }, changed: true };
}

export function codexCloakBrowserArgs(codexConfigText, config, env = process.env) {
  if (config?.disableMcp) return [];
  const text = String(codexConfigText || "").replace(/^\uFEFF/, "").trim();
  if (!text) return [];
  let parsed;
  try { parsed = parseToml(text); } catch { return []; }
  const cloak = parsed?.mcp_servers?.cloakbrowser;
  if (!cloak || typeof cloak !== "object" || Array.isArray(cloak)) return [];
  if (cloak.enabled === false || cloak.disabled === true) return [];
  if (!String(cloak.command || "").trim() && !String(cloak.url || "").trim()) return [];
  const dirs = resolveCloakBrowserDirs(config, env);
  const cloakEnv = cloak.env && typeof cloak.env === "object" && !Array.isArray(cloak.env) ? cloak.env : {};
  const args = [];
  if (dirs.userDataDir && shouldOverrideCloakBrowserPath(cloakEnv.PLAYWRIGHT_MCP_USER_DATA_DIR)) {
    args.push("-c", `mcp_servers.cloakbrowser.env.PLAYWRIGHT_MCP_USER_DATA_DIR=${JSON.stringify(dirs.userDataDir)}`);
  }
  if (dirs.outputDir && shouldOverrideCloakBrowserPath(cloakEnv.PLAYWRIGHT_MCP_OUTPUT_DIR)) {
    args.push("-c", `mcp_servers.cloakbrowser.env.PLAYWRIGHT_MCP_OUTPUT_DIR=${JSON.stringify(dirs.outputDir)}`);
  }
  return args;
}
