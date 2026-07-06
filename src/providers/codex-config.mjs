import fs from "node:fs";
import path from "node:path";

export function createCodexProviderConfig({
  codexHome,
  providerBundles = [],
} = {}) {
  const providerBundleById = new Map(providerBundles.map((item) => [item.id, item]));

  function codexUserConfigPath() {
    return path.join(codexHome, "config.toml");
  }

  function readCodexConfigText() {
    try {
      return fs.readFileSync(codexUserConfigPath(), "utf8");
    } catch {
      return "";
    }
  }

  function resolveCodexConfigModel() {
    return resolveCodexConfigValue("model");
  }

  function resolveCodexConfigValue(key) {
    const text = readCodexConfigText();
    if (!text) return "";
    const escaped = escapeRegExp(key);
    const match = text.match(new RegExp(`^\\s*${escaped}\\s*=\\s*(["'])(.*?)\\1\\s*(?:#.*)?$`, "m"));
    return match?.[2]?.trim() || "";
  }

  function listCodexProviders() {
    const providers = new Map();
    const add = (info) => {
      const item = compactProviderInfo(info);
      if (item?.id) providers.set(item.id, item);
    };
    add({ id: "openai", name: "OpenAI", requiresOpenaiAuth: true, builtIn: true });
    add({ id: "ollama", name: "Ollama", builtIn: true });
    add({ id: "lmstudio", name: "LM Studio", builtIn: true });
    add({ id: "amazon-bedrock", name: "Amazon Bedrock", builtIn: true });

    const text = readCodexConfigText();
    const tableRe = /^\s*\[model_providers\.([A-Za-z0-9_.-]+)\]\s*$/gm;
    const matches = [...text.matchAll(tableRe)];
    for (let i = 0; i < matches.length; i += 1) {
      const id = matches[i][1];
      const start = matches[i].index + matches[i][0].length;
      const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
      const body = text.slice(start, end);
      add({
        id,
        name: tomlStringValue(body, "name") || id,
        baseUrl: tomlStringValue(body, "base_url"),
        envKey: tomlStringValue(body, "env_key"),
        requiresOpenaiAuth: tomlBooleanValue(body, "requires_openai_auth"),
        serviceTierPassthrough:
          tomlBooleanValue(body, "service_tier_passthrough")
          || tomlBooleanValue(body, "supports_service_tier"),
        builtIn: false,
      });
    }
    return [...providers.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  function findCodexProvider(id) {
    const target = String(id || "").trim();
    if (!target) return null;
    return listCodexProviders().find((item) => item.id === target) || null;
  }

  function findProviderBundle(id) {
    const target = String(id || "").trim();
    if (!target) return null;
    return providerBundleById.get(target) || null;
  }

  function writeTopLevelCodexConfigValue(keyPath, value) {
    const key = String(keyPath || "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`只支持写入顶层 config.toml 字符串键：${keyPath}`);
    }
    const configPath = codexUserConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const original = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
    const lines = original.replace(/\r\n/g, "\n").split("\n");
    const replacement = `${key} = ${tomlStringLiteral(value)}`;
    let replaced = false;
    let inTopLevel = true;
    const nextLines = lines.map((line) => {
      if (/^\s*\[/.test(line)) inTopLevel = false;
      if (inTopLevel && new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(line)) {
        replaced = true;
        return replacement;
      }
      return line;
    });
    if (!replaced) {
      let insertAt = nextLines.findIndex((line) => /^\s*\[/.test(line));
      if (insertAt < 0) insertAt = nextLines.length;
      while (insertAt > 0 && nextLines[insertAt - 1] === "") insertAt -= 1;
      nextLines.splice(insertAt, 0, replacement);
    }
    fs.writeFileSync(configPath, `${nextLines.join("\n").replace(/\n+$/g, "")}\n`, "utf8");
    return { path: configPath, keyPath: key, value };
  }

  return {
    findCodexProvider,
    findProviderBundle,
    listCodexProviders,
    providerBundleLabel,
    providerModelsUrl,
    providerResponsesUrl,
    readCodexConfigText,
    resolveCodexConfigModel,
    resolveCodexConfigValue,
    writeTopLevelCodexConfigValue,
  };
}

function compactProviderInfo(info) {
  if (!info) return null;
  const envKey = String(info.envKey || "").trim();
  return {
    id: String(info.id || "").trim(),
    name: String(info.name || info.id || "").trim(),
    baseUrl: String(info.baseUrl || "").trim(),
    envKey,
    requiresOpenaiAuth: Boolean(info.requiresOpenaiAuth),
    serviceTierPassthrough: Boolean(info.serviceTierPassthrough),
    envVisible: envKey ? Object.prototype.hasOwnProperty.call(process.env, envKey) : null,
    builtIn: Boolean(info.builtIn),
  };
}

function providerBundleLabel(bundle) {
  if (!bundle) return "";
  const parts = [`provider ${bundle.provider}`, `model ${bundle.model}`];
  if (bundle.reasoning) parts.push(`reasoning ${bundle.reasoning}`);
  return parts.join("；");
}

function providerApiUrl(provider, route) {
  const baseUrl = String(provider?.baseUrl || "").trim();
  if (!baseUrl) return "";
  try {
    return new URL(route, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
  } catch {
    return "";
  }
}

function providerModelsUrl(provider) {
  return providerApiUrl(provider, "models");
}

function providerResponsesUrl(provider) {
  return providerApiUrl(provider, "responses");
}

function tomlStringValue(text, key) {
  const match = String(text || "").match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(["'])(.*?)\\1\\s*(?:#.*)?$`, "m"));
  return match?.[2]?.trim() || "";
}

function tomlBooleanValue(text, key) {
  const match = String(text || "").match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(true|false)\\s*(?:#.*)?$`, "mi"));
  return match ? match[1].toLowerCase() === "true" : false;
}

function tomlStringLiteral(value) {
  return `"${String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
