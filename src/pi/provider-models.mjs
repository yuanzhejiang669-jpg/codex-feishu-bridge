import fs from "node:fs";
import path from "node:path";

import { writeJsonFileAtomicSync } from "../utils/json.mjs";
import { piThinkingLevelsFromMetadata, resolvePiModelThinkingMetadata } from "./model-metadata.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ENV_REFERENCE = /^\$([A-Z_][A-Z0-9_]{0,127})$/;
const MODELS_FILE_LOCKS = new Map();

export function listConfiguredPiProviders({ modelsPath } = {}) {
  const config = readPiModelsConfig(modelsPath);
  return Object.entries(config.providers).map(([id, provider]) => ({
    id,
    name: String(provider?.name || id),
    defaultModel: String(provider?.models?.[0]?.id || ""),
    registeredModels: Array.isArray(provider?.models) ? provider.models.length : 0,
  }));
}

export async function listPiProviderModels({
  modelsPath,
  provider,
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
} = {}) {
  const providerId = safeId(provider, "Pi provider id");
  const config = readPiModelsConfig(modelsPath);
  const definition = config.providers[providerId];
  if (!definition) throw new Error(`Pi Provider is not configured: ${providerId}`);
  const credential = resolveProviderCredential(providerId, definition, env);
  const url = providerModelsUrl(definition.baseUrl, providerId);
  if (typeof fetchImpl !== "function") throw new Error("Pi Provider model discovery requires fetch");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), positiveTimeout(timeoutMs));
  timeout.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${credential}` },
      signal: controller.signal,
    });
    const bodyText = await response.text();
    const body = parseResponseJson(bodyText, providerId);
    if (!response.ok) {
      const message = body?.error?.message || body?.message || bodyText.slice(0, 300) || response.statusText;
      throw new Error(`Pi Provider ${providerId} /models failed: HTTP ${response.status} ${message}`);
    }
    const models = normalizeLiveModels(providerId, body, definition.models);
    if (!models.length) throw new Error(`Pi Provider ${providerId} /models returned no models`);
    return { provider: providerId, providerName: String(definition.name || providerId), url, models };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Pi Provider ${providerId} /models timed out after ${positiveTimeout(timeoutMs)}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function registerPiProviderModel({ modelsPath, provider, modelId, ...options } = {}) {
  const providerId = safeId(provider, "Pi provider id");
  const requestedModel = safeId(modelId, "Pi model id");
  const target = resolveModelsPath(modelsPath);
  const listing = await listPiProviderModels({ modelsPath: target, provider: providerId, ...options });
  const selected = listing.models.find((model) => model.id === requestedModel);
  if (!selected) {
    throw new Error(`Model ${requestedModel} is not in Pi Provider ${providerId} live /models response`);
  }

  return withModelsFileLock(target, async () => {
    const config = readPiModelsConfig(target);
    const definition = config.providers[providerId];
    if (!definition) throw new Error(`Pi Provider is not configured: ${providerId}`);
    const models = Array.isArray(definition.models) ? definition.models : [];
    const existing = models.find((model) => model?.id === requestedModel);
    const inferred = resolvePiModelThinkingMetadata(providerId, requestedModel);
    if (existing) {
      const changed = applyThinkingMetadata(existing, inferred);
      if (changed) {
        assertNoInlineProviderSecrets(config);
        writeJsonFileAtomicSync(target, config);
      }
      return { ...selected, ...(inferred || {}), thinkingLevels: piThinkingLevelsFromMetadata(inferred || existing), configChanged: changed };
    }

    definition.models = [...models, { id: requestedModel, name: selected.name, ...(inferred || {}) }];
    assertNoInlineProviderSecrets(config);
    writeJsonFileAtomicSync(target, config);
    return {
      ...selected,
      ...(inferred || {}),
      thinkingLevels: piThinkingLevelsFromMetadata(inferred),
      registered: true,
      metadataSource: inferred ? "inferred" : "pi-default",
      configChanged: true,
    };
  });
}

async function withModelsFileLock(target, callback) {
  const previous = MODELS_FILE_LOCKS.get(target) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  MODELS_FILE_LOCKS.set(target, current);
  await previous;
  try {
    return await callback();
  } finally {
    release();
    if (MODELS_FILE_LOCKS.get(target) === current) MODELS_FILE_LOCKS.delete(target);
  }
}

function normalizeLiveModels(providerId, body, registeredModels = []) {
  const registered = new Map((Array.isArray(registeredModels) ? registeredModels : [])
    .filter((model) => model?.id)
    .map((model) => [String(model.id), model]));
  const data = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  const seen = new Set();
  const models = [];
  for (const item of data) {
    const id = String(typeof item === "string" ? item : item?.id || item?.model || "").trim();
    if (!SAFE_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    const configured = registered.get(id);
    const inferred = resolvePiModelThinkingMetadata(providerId, id);
    const thinking = inferred || configured;
    models.push({
      provider: providerId,
      id,
      name: normalizeDisplayName(item?.displayName || item?.display_name || item?.name || configured?.name, id),
      ownedBy: String(item?.owned_by || item?.ownedBy || "").trim(),
      registered: Boolean(configured),
      metadataSource: configured ? "configured" : "unknown",
      reasoning: thinking?.reasoning === true,
      thinkingLevels: piThinkingLevelsFromMetadata(thinking),
      input: Array.isArray(configured?.input) ? configured.input.map(String) : [],
      contextWindow: optionalPositiveInteger(configured?.contextWindow),
      maxTokens: optionalPositiveInteger(configured?.maxTokens),
    });
  }
  return models.sort((left, right) => left.id.localeCompare(right.id));
}

function applyThinkingMetadata(model, metadata) {
  if (!metadata) return false;
  const nextMap = metadata.thinkingLevelMap;
  const sameMap = JSON.stringify(model.thinkingLevelMap ?? null) === JSON.stringify(nextMap ?? null);
  if (model.reasoning === metadata.reasoning && sameMap) return false;
  model.reasoning = metadata.reasoning;
  if (nextMap) model.thinkingLevelMap = { ...nextMap };
  else delete model.thinkingLevelMap;
  return true;
}

function readPiModelsConfig(modelsPath) {
  const target = resolveModelsPath(modelsPath);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(target, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Unable to read Pi models.json: ${error?.message || error}`, { cause: error });
  }
  if (!parsed?.providers || typeof parsed.providers !== "object" || Array.isArray(parsed.providers)) {
    throw new Error("Pi models.json has no provider map");
  }
  return parsed;
}

function resolveModelsPath(modelsPath) {
  const target = path.resolve(String(modelsPath || ""));
  if (!modelsPath || target === path.parse(target).root || path.basename(target).toLowerCase() !== "models.json") {
    throw new Error("Pi models.json path is invalid");
  }
  return target;
}

function resolveProviderCredential(providerId, definition, env) {
  const match = ENV_REFERENCE.exec(String(definition?.apiKey || "").trim());
  if (!match) throw new Error(`Pi Provider ${providerId} must reference an environment variable`);
  const credential = String(env?.[match[1]] || "").trim();
  if (!credential) throw new Error(`Pi Provider key is unavailable: ${match[1]}`);
  return credential;
}

function providerModelsUrl(baseUrl, providerId) {
  let url;
  try {
    url = new URL(String(baseUrl || ""));
  } catch {
    throw new Error(`Pi Provider ${providerId} has an invalid base URL`);
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error(`Pi Provider ${providerId} base URL must be http(s)`);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function parseResponseJson(bodyText, providerId) {
  if (!bodyText.trim()) return {};
  try {
    return JSON.parse(bodyText);
  } catch {
    throw new Error(`Pi Provider ${providerId} /models returned invalid JSON: ${bodyText.slice(0, 300)}`);
  }
}

function assertNoInlineProviderSecrets(config) {
  for (const [providerId, definition] of Object.entries(config.providers || {})) {
    if (!ENV_REFERENCE.test(String(definition?.apiKey || "").trim())) {
      throw new Error(`Pi Provider ${providerId} must reference an environment variable`);
    }
  }
}

function safeId(value, label) {
  const text = String(value || "").trim();
  if (!SAFE_ID.test(text)) throw new Error(`${label} is invalid: ${value}`);
  return text;
}

function positiveTimeout(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 30_000;
}

function optionalPositiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function normalizeDisplayName(value, fallback) {
  const text = String(value || "").replace(/[\u0000-\u001F\u007F\s]+/g, " ").trim();
  return (text || fallback).slice(0, 160);
}
