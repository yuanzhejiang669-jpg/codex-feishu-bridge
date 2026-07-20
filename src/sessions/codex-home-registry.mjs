import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizedPath(value) {
  const raw = String(value || "").trim();
  if (/[<>]/.test(raw) || raw.includes("{{")) return "";
  return raw ? path.resolve(raw) : "";
}

function pathKey(value) {
  const resolved = normalizedPath(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function instancesRootFromStateDir(stateDir) {
  const resolved = normalizedPath(stateDir);
  if (!resolved) return "";
  const instanceRoot = path.dirname(resolved);
  const instancesRoot = path.dirname(instanceRoot);
  return path.basename(instancesRoot).toLowerCase() === "instances" ? instancesRoot : "";
}

function addInstancesRoot(roots, value) {
  const resolved = normalizedPath(value);
  if (resolved) roots.set(pathKey(resolved), resolved);
}

function addHome(homes, value, source) {
  const resolved = normalizedPath(value);
  if (!resolved) return;
  const key = pathKey(resolved);
  const current = homes.get(key) || { codexHome: resolved, sources: [] };
  if (source && !current.sources.includes(source)) current.sources.push(source);
  homes.set(key, current);
}

function addLaunchConfig(registry, launchConfigPath) {
  const config = readJson(launchConfigPath);
  if (!config) return;
  addHome(registry.homes, config.codexHome, "launch-config:codexHome");
  addHome(registry.homes, config.desktopCodexHome, "launch-config:desktopCodexHome");
  const stateDir = path.dirname(launchConfigPath);
  registry.stateDirs.set(pathKey(stateDir), stateDir);
}

function scanInstancesRoot(registry, instancesRoot) {
  if (!instancesRoot || !fs.existsSync(instancesRoot)) return;
  let entries = [];
  try {
    entries = fs.readdirSync(instancesRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const stateDir = path.join(instancesRoot, entry.name, "state");
    const launchConfigPath = path.join(stateDir, "launch-config.json");
    if (fs.existsSync(launchConfigPath)) addLaunchConfig(registry, launchConfigPath);
  }
}

function addInstancesConfig(registry, configPath, instancesRoots) {
  const config = readJson(configPath);
  if (!config) return;
  addHome(registry.homes, config.defaults?.codexHome, "instances-config:defaults");
  addHome(registry.homes, config.defaults?.desktopCodexHome, "instances-config:defaults-desktop");
  for (const instance of Array.isArray(config.instances) ? config.instances : []) {
    addHome(registry.homes, instance?.codexHome, "instances-config:codexHome");
    addHome(registry.homes, instance?.desktopCodexHome, "instances-config:desktopCodexHome");
    const runtimeRoot = normalizedPath(instance?.runtimeRoot);
    if (!runtimeRoot) continue;
    const stateDir = path.join(runtimeRoot, "state");
    registry.stateDirs.set(pathKey(stateDir), stateDir);
    const instancesRoot = path.dirname(runtimeRoot);
    if (path.basename(instancesRoot).toLowerCase() === "instances") addInstancesRoot(instancesRoots, instancesRoot);
  }
}

export function discoverCodexHomeRegistry({
  currentCodexHome = "",
  desktopCodexHome = "",
  stateDir = "",
  engineRoot = "",
  defaultDataRoot = "",
  localAppData = process.env.LOCALAPPDATA || "",
  appData = process.env.APPDATA || "",
  homeDir = os.homedir(),
  extraInstancesRoots = [],
  extraConfigPaths = [],
} = {}) {
  const registry = {
    homes: new Map(),
    stateDirs: new Map(),
  };
  const instancesRoots = new Map();

  addHome(registry.homes, currentCodexHome, "current");
  addHome(registry.homes, desktopCodexHome, "desktop");
  addInstancesRoot(instancesRoots, instancesRootFromStateDir(stateDir));
  addInstancesRoot(instancesRoots, defaultDataRoot ? path.join(defaultDataRoot, "instances") : "");

  if (process.platform === "win32") {
    const localRoot = normalizedPath(localAppData) || path.join(homeDir, "AppData", "Local");
    addInstancesRoot(instancesRoots, path.join(localRoot, "CodexFeishuBridge", "instances"));
    addInstancesRoot(instancesRoots, path.join(localRoot, "CodexFeishuBridgeDesktop", "runtime-localappdata", "CodexFeishuBridge", "instances"));
  } else if (process.platform === "darwin") {
    const applicationSupport = normalizedPath(appData) || path.join(homeDir, "Library", "Application Support");
    addInstancesRoot(instancesRoots, path.join(applicationSupport, "CodexFeishuBridge", "instances"));
    addInstancesRoot(instancesRoots, path.join(applicationSupport, "CodexFeishuBridgeDesktop", "runtime-localappdata", "CodexFeishuBridge", "instances"));
  }
  for (const root of extraInstancesRoots) addInstancesRoot(instancesRoots, root);

  const configPaths = [
    engineRoot ? path.join(engineRoot, "bridge.instances.local.json") : "",
    engineRoot ? path.join(engineRoot, "bridge.instances.json") : "",
    ...extraConfigPaths,
  ].filter(Boolean);
  for (const configPath of configPaths) addInstancesConfig(registry, configPath, instancesRoots);
  for (const root of instancesRoots.values()) scanInstancesRoot(registry, root);

  return {
    homes: [...registry.homes.values()],
    stateDirs: [...registry.stateDirs.values()],
    instancesRoots: [...instancesRoots.values()],
  };
}

export function loadRegisteredBridgeBindings(stateDirs = []) {
  const bindings = [];
  const seenFiles = new Set();
  for (const stateDir of stateDirs) {
    const resolvedStateDir = normalizedPath(stateDir);
    if (!resolvedStateDir) continue;
    const sessionsPath = path.join(resolvedStateDir, "sessions.json");
    const key = pathKey(sessionsPath);
    if (seenFiles.has(key)) continue;
    seenFiles.add(key);
    const persisted = readJson(sessionsPath);
    if (!persisted?.chats || typeof persisted.chats !== "object") continue;
    for (const [chatId, chatState] of Object.entries(persisted.chats)) {
      if (!Array.isArray(chatState?.sessions)) continue;
      for (const session of chatState.sessions) {
        const threadId = String(session?.codexThreadId || "").trim();
        if (!threadId) continue;
        bindings.push({
          stateDir: resolvedStateDir,
          sessionsPath,
          chatId,
          currentSessionId: String(chatState.currentSessionId || ""),
          session,
          threadId,
        });
      }
    }
  }
  return bindings;
}
