import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeJsonFileAtomicSync } from "../utils/json.mjs";
import { createPiCapabilitiesConfig, writePiCapabilitiesConfig } from "./capabilities/config.mjs";
import { resolvePiDirectories, writePiRuntimeConfig } from "./config.mjs";

export const PI_GLOBAL_BOT_PRESETS = Object.freeze([
  Object.freeze({ name: "pi-global-01", label: "Pi Global 01", defaultProvider: "deepseek-direct", defaultModel: "deepseek-chat" }),
  Object.freeze({ name: "pi-global-02", label: "Pi Global 02", defaultProvider: "backup-api", defaultModel: "gpt-5.6-sol" }),
  Object.freeze({ name: "pi-global-03", label: "Pi Global 03", defaultProvider: "backup-api", defaultModel: "gpt-5.6-sol" }),
]);

export function provisionPiGlobalBots({
  bridgeRoot,
  documentsRoot = path.join(resolveRealUserHome(), "Documents"),
  providers,
  presets = PI_GLOBAL_BOT_PRESETS,
  skillPaths = [path.join(resolveRealUserHome(), ".codex", "skills"), path.join(resolveRealUserHome(), ".agents", "skills")],
  pythonPath = process.env.CODEX_FEISHU_PYTHON || "C:/Program Files/Python311/python.exe",
  powershellPath = process.env.CODEX_FEISHU_PWSH || "pwsh.exe",
} = {}) {
  const root = path.resolve(String(bridgeRoot || ""));
  if (!bridgeRoot || !fs.existsSync(path.join(root, "codex-feishu-bridge.mjs"))) {
    throw new Error("Bridge root is invalid");
  }
  const providerList = Array.isArray(providers) ? providers : [];
  if (!providerList.length) throw new Error("Standalone Pi providers are required");
  const providerIds = new Set(providerList.map((item) => String(item?.id || "").trim()));
  const resolvedSkills = [...new Set(skillPaths.map((item) => path.resolve(item)))];
  for (const skillPath of resolvedSkills) assertDirectory(skillPath, "Pi Skill root");

  const extensionPath = path.join(root, "extensions", "pi-capabilities.ts");
  assertFile(extensionPath, "Pi capability extension");
  const first = resolvePiDirectories({ documentsRoot, botName: presets[0]?.name || "pi-global-01" });
  fs.mkdirSync(first.configurationSpaceHome, { recursive: true });
  const capabilitiesPath = path.join(first.configurationSpaceHome, "capabilities.json");
  writePiCapabilitiesConfig(capabilitiesPath, createPiCapabilitiesConfig({
    bridgeRoot: root,
    mineruRoot: path.join(path.resolve(documentsRoot), "Codex", "tools", "mineru"),
    nodePath: process.execPath,
    pythonPath,
    powershellPath,
    mcpDataRoot: path.join(path.resolve(documentsRoot), "Codex", "mcp-data"),
  }));

  return presets.map((preset) => {
    if (!providerIds.has(preset.defaultProvider)) {
      throw new Error(`Default Pi provider is not configured for ${preset.name}: ${preset.defaultProvider}`);
    }
    const selected = providerList.find((item) => item.id === preset.defaultProvider);
    if (!selected || selected.model !== preset.defaultModel) {
      throw new Error(`Default Pi model is not configured for ${preset.name}: ${preset.defaultModel}`);
    }
    const directories = resolvePiDirectories({ documentsRoot, botName: preset.name });
    fs.mkdirSync(directories.workspace, { recursive: true });
    fs.mkdirSync(directories.sessionDir, { recursive: true });
    writePiRuntimeConfig({ directories, providers: providerList });
    const manifestPath = path.join(directories.agentHome, "bridge.json");
    const manifest = {
      schemaVersion: 1,
      engine: "pi",
      name: preset.name,
      label: preset.label,
      larkProfile: preset.name,
      workspace: directories.workspace,
      configurationSpaceHome: directories.configurationSpaceHome,
      agentHome: directories.agentHome,
      sessionDir: directories.sessionDir,
      modelsPath: directories.modelsPath,
      settingsPath: directories.settingsPath,
      defaultProvider: preset.defaultProvider,
      defaultModel: preset.defaultModel,
      thinking: "medium",
      providerEnvKeys: providerList.map((item) => item.envKey),
      extensionPaths: [extensionPath],
      skillPaths: resolvedSkills,
      capabilitiesPath,
    };
    assertNoSecretFields(manifest);
    writeJsonFileAtomicSync(manifestPath, manifest);
    return { ...manifest, manifestPath };
  });
}

function resolveRealUserHome() {
  const codexHome = String(process.env.CODEX_HOME || "").trim();
  if (codexHome && path.basename(codexHome).toLowerCase() === ".codex") return path.dirname(path.resolve(codexHome));
  return os.homedir();
}

function assertDirectory(target, label) {
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error(`${label} is unavailable: ${target}`);
}

function assertFile(target, label) {
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error(`${label} is unavailable: ${target}`);
}

function assertNoSecretFields(value) {
  const serialized = JSON.stringify(value);
  if (/(appSecret|accessToken|apiKey|deviceCode|authorization)"\s*:/i.test(serialized)) {
    throw new Error("Standalone Pi manifest contains a secret field");
  }
}
