import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import crypto from "node:crypto";

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
    return String(parseToml(text)[key] || "").trim();
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
    const definitions = text.trim() ? parseToml(text).model_providers || {} : {};
    for (const [id, body] of Object.entries(definitions)) {
      if (!body || typeof body !== "object" || !body.base_url && !body.name) continue;
      add({
        id,
        name: body.name || id,
        baseUrl: body.base_url,
        envKey: body.env_key,
        requiresOpenaiAuth: body.requires_openai_auth === true,
        serviceTierPassthrough:
          body.service_tier_passthrough === true || body.supports_service_tier === true,
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

  function writeTopLevelCodexConfigValue(key, value) {
    writeTopLevelCodexConfigValues({ [key]: value });
    return { path: codexUserConfigPath(), keyPath: key, value };
  }

  function writeTopLevelCodexConfigValues(values) {
    const configPath = codexUserConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    let text = readCodexConfigText();
    for (const [key, value] of Object.entries(values)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Invalid top-level configuration key');
      const lines = text.replace(/\r\n/g, '\n').split('\n');
      let inTopLevel = true, found = false;
      const next = [];
      for (const line of lines) {
        if (/^\s*\[/.test(line)) inTopLevel = false;
        if (inTopLevel && new RegExp('^\\s*' + escapeRegExp(key) + '\\s*=').test(line)) {
          found = true;
          if (value !== null) next.push(key + ' = ' + JSON.stringify(String(value)));
        } else next.push(line);
      }
      if (!found && value !== null) {
        const firstTable = next.findIndex(line => /^\s*\[/.test(line));
        next.splice(firstTable < 0 ? next.length : firstTable, 0, key + ' = ' + JSON.stringify(String(value)));
      }
      text = next.join('\n').replace(/\n+$/g, '') + '\n';
    }
    parseToml(text);
    const temporary = configPath + '.' + crypto.randomUUID() + '.tmp';
    try { fs.writeFileSync(temporary, text, 'utf8'); fs.renameSync(temporary, configPath); }
    finally { fs.rmSync(temporary, { force: true }); }
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
    writeTopLevelCodexConfigValues,
    readTopLevelValues: keys => { const config = parseToml(readCodexConfigText() || ''); return Object.fromEntries(keys.map(key => [key, config[key] ?? null])); },
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
