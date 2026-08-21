import path from "node:path";

import { writeJsonFileAtomicSync } from "../utils/json.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function safeId(value, label) {
  const text = String(value || "").trim();
  if (!SAFE_ID.test(text)) throw new Error(`${label} is invalid: ${value}`);
  return text;
}

export function resolvePiDirectories({ documentsRoot, botName, spaceId = "pi-general" } = {}) {
  const root = path.resolve(String(documentsRoot || ""));
  if (!documentsRoot || root === path.parse(root).root) throw new Error("documentsRoot must be a non-root directory");
  const name = safeId(botName, "Pi bot name");
  const space = safeId(spaceId, "Pi configuration space id");
  const codexRoot = path.join(root, "Codex");
  const agentHome = path.join(codexRoot, "pi-homes", name);
  return {
    workspace: path.join(codexRoot, "workspaces", `feishu-bridge-${name}`),
    configurationSpaceHome: path.join(codexRoot, "pi-spaces", space),
    agentHome,
    sessionDir: path.join(agentHome, "sessions"),
    settingsPath: path.join(agentHome, "settings.json"),
    modelsPath: path.join(agentHome, "models.json"),
    skillsPath: path.join(agentHome, "skills"),
    extensionsPath: path.join(agentHome, "extensions"),
  };
}

export function piApiFromWireApi(value) {
  const normalized = String(value || "responses").trim().toLowerCase();
  if (["responses", "openai-responses"].includes(normalized)) return "openai-responses";
  if (["chat", "completions", "openai-completions"].includes(normalized)) return "openai-completions";
  throw new Error(`Unsupported Pi provider wire API: ${value}`);
}

function createPiProviderConfig(provider = {}) {
  const id = safeId(provider.id, "Pi provider id");
  const modelId = String(provider.model || "").trim();
  const baseUrl = String(provider.baseUrl || "").trim().replace(/\/+$/, "");
  const envKey = String(provider.envKey || "").trim();
  if (!modelId) throw new Error("Pi provider model is required");
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error("Pi provider base URL must be http(s)");
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(envKey)) throw new Error("Pi provider environment key is invalid");
  const contextWindow = Math.max(1, Number(provider.contextWindow) || 258_400);
  const maxTokens = Math.max(1, Number(provider.maxTokens) || 32_000);
  return [id, {
    baseUrl,
    api: piApiFromWireApi(provider.wireApi),
    apiKey: `$${envKey}`,
    authHeader: true,
    models: [{
      id: modelId,
      name: String(provider.name || modelId),
      reasoning: provider.reasoning !== false,
      input: provider.input || ["text", "image"],
      contextWindow,
      maxTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  }];
}

export function createPiModelsConfig(providerOrProviders = {}) {
  const definitions = Array.isArray(providerOrProviders) ? providerOrProviders : [providerOrProviders];
  if (!definitions.length) throw new Error("At least one Pi provider is required");
  const providers = {};
  for (const definition of definitions) {
    const [id, config] = createPiProviderConfig(definition);
    if (providers[id]) throw new Error(`Duplicate Pi provider id: ${id}`);
    providers[id] = config;
  }
  return { providers };
}

export function createPiSettings({ shellPath = "", enableInstallTelemetry = false } = {}) {
  return {
    defaultProjectTrust: "always",
    enableInstallTelemetry,
    ...(shellPath ? { shellPath: path.resolve(shellPath).replaceAll("\\", "/") } : {}),
  };
}

export function writePiRuntimeConfig({ directories, provider, providers, settings = {} } = {}) {
  if (!directories?.modelsPath || !directories?.settingsPath) {
    throw new Error("Pi runtime config paths are required");
  }
  const definitions = providers || provider;
  const models = createPiModelsConfig(definitions);
  const renderedSettings = createPiSettings(settings);
  const serialized = JSON.stringify(models);
  const providerList = Array.isArray(definitions) ? definitions : [definitions];
  for (const definition of providerList) {
    const envKey = String(definition?.envKey || "").trim();
    const secret = envKey ? String(process.env[envKey] || "") : "";
    if (secret && serialized.includes(secret)) throw new Error("Pi models config contains a provider secret");
  }
  writeJsonFileAtomicSync(directories.modelsPath, models);
  writeJsonFileAtomicSync(directories.settingsPath, renderedSettings);
  return { models, settings: renderedSettings };
}

export function buildPiRpcArguments({
  entryPath,
  provider,
  model,
  thinking = "medium",
  sessionDir,
  sessionFile = "",
  extensionPaths = [],
  skillPaths = [],
} = {}) {
  const args = [
    path.resolve(entryPath),
    "--mode", "rpc",
    "--approve",
    "--provider", safeId(provider, "Pi provider id"),
    "--model", String(model || "").trim(),
    "--thinking", String(thinking || "medium").trim(),
    "--session-dir", path.resolve(sessionDir),
  ];
  if (!model) throw new Error("Pi model is required");
  if (sessionFile) args.push("--session", path.resolve(sessionFile));
  for (const extensionPath of extensionPaths) args.push("--extension", path.resolve(extensionPath));
  for (const skillPath of skillPaths) args.push("--skill", path.resolve(skillPath));
  return args;
}
