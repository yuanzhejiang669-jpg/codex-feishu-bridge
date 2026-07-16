const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const TOML = require("smol-toml");
const { readManagedBots } = require("./bot-setup.cjs");

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ENV_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;

function configPathFor(codexHome) {
  return path.join(codexHome, "config.toml");
}

function readConfig(configPath) {
  try {
    const text = fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
    return { text, config: TOML.parse(text) };
  } catch (error) {
    if (error?.code === "ENOENT") return { text: "", config: {} };
    throw new Error(`无法读取 Codex 配置：${error.message}`);
  }
}

function normalizeDefinition(raw = {}) {
  const id = String(raw.id || "").trim();
  if (!ID_PATTERN.test(id)) throw new Error("Provider 标识格式无效");
  const baseUrl = String(raw.baseUrl || raw.base_url || "").trim().replace(/\/+$/, "");
  let parsed;
  try { parsed = new URL(baseUrl); } catch { throw new Error("Provider Base URL 格式无效"); }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) throw new Error("Provider Base URL 必须使用 HTTP 或 HTTPS");
  const envKey = String(raw.envKey || raw.env_key || "").trim().toUpperCase();
  if (!ENV_PATTERN.test(envKey)) throw new Error("Provider 环境变量名称格式无效");
  const wireApi = String(raw.wireApi || raw.wire_api || "responses").trim();
  if (wireApi !== "responses") throw new Error("当前 Provider 中心只支持 Responses 兼容接口");
  return {
    id,
    name: String(raw.name || id).trim().slice(0, 120) || id,
    baseUrl,
    envKey,
    wireApi,
    serviceTierPassthrough: raw.serviceTierPassthrough === true || raw.service_tier_passthrough === true,
  };
}

function publicProvider(id, raw = {}, selectedId = "", env = process.env) {
  const envKey = String(raw.env_key || "").trim();
  return {
    id,
    name: String(raw.name || id),
    baseUrl: String(raw.base_url || ""),
    wireApi: String(raw.wire_api || ""),
    envKey,
    credentialAvailable: envKey ? Boolean(env[envKey]) : null,
    serviceTierPassthrough: raw.service_tier_passthrough === true || raw.supports_service_tier === true,
    selected: id === selectedId,
  };
}

function inspectProviderCatalog(codexHome, env = process.env) {
  const configPath = configPathFor(codexHome);
  try {
    const { config } = readConfig(configPath);
    const selectedId = String(config.model_provider || "");
    const definitions = config.model_providers && typeof config.model_providers === "object"
      ? config.model_providers
      : {};
    return {
      configPath,
      selectedId,
      selectedModel: String(config.model || ""),
      providers: Object.entries(definitions)
        .map(([id, raw]) => publicProvider(id, raw, selectedId, env))
        .sort((left, right) => left.id.localeCompare(right.id)),
      error: "",
    };
  } catch (error) {
    return { configPath, selectedId: "", selectedModel: "", providers: [], error: error.message };
  }
}

function providerBlock(provider) {
  const value = (input) => JSON.stringify(String(input));
  return [
    `[model_providers.${provider.id}]`,
    `name = ${value(provider.name)}`,
    `base_url = ${value(provider.baseUrl)}`,
    `wire_api = ${value(provider.wireApi)}`,
    `env_key = ${value(provider.envKey)}`,
    ...(provider.serviceTierPassthrough ? ["service_tier_passthrough = true"] : []),
  ].join("\n");
}

function writeTextAtomic(destination, text) {
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  const backup = `${destination}.${crypto.randomUUID()}.bak`;
  const existed = fs.existsSync(destination);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.writeFileSync(temporary, text, "utf8");
    if (existed) fs.renameSync(destination, backup);
    fs.renameSync(temporary, destination);
    fs.rmSync(backup, { force: true });
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    if (fs.existsSync(backup)) {
      fs.rmSync(destination, { force: true });
      fs.renameSync(backup, destination);
    }
    throw error;
  }
}

function runPowerShell(script, env = process.env) {
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      timeout: 15_000,
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      env,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || stdout || error.message).trim()));
      else resolve(String(stdout || "").trim());
    });
  });
}

async function readUserEnvironmentVariable(name) {
  const output = await runPowerShell("[Console]::Out.Write([Environment]::GetEnvironmentVariable($env:CFB_ENV_NAME, 'User'))", {
    ...process.env,
    CFB_ENV_NAME: name,
  });
  return output;
}

async function setUserEnvironmentVariable(name, value) {
  await runPowerShell("if ($env:CFB_ENV_REMOVE -eq '1') { [Environment]::SetEnvironmentVariable($env:CFB_ENV_NAME, $null, 'User') } else { [Environment]::SetEnvironmentVariable($env:CFB_ENV_NAME, $env:CFB_ENV_VALUE, 'User') }", {
    ...process.env,
    CFB_ENV_NAME: name,
    CFB_ENV_VALUE: value == null ? "" : String(value),
    CFB_ENV_REMOVE: value == null ? "1" : "0",
  });
  if (value == null || value === "") delete process.env[name];
  else process.env[name] = String(value);
}

function secretFrom(raw) {
  const value = String(raw?.apiKey || "").trim();
  if (!value) throw new Error("API Key 不能为空");
  if (/\r|\n/.test(value)) throw new Error("API Key 不能包含换行");
  return value;
}

function fetchWithTimeout(url, init, options = {}) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), Number(options.timeoutMs || 30_000));
  timer.unref?.();
  return (options.fetchImpl || fetch)(url, { ...init, signal: abort.signal }).finally(() => clearTimeout(timer));
}

async function listProviderModels(raw, options = {}) {
  const provider = normalizeDefinition(raw);
  const key = secretFrom(raw);
  const response = await fetchWithTimeout(`${provider.baseUrl}/models`, {
    method: "GET",
    headers: { authorization: `Bearer ${key}` },
  }, options);
  const body = await response.text();
  if (!response.ok) throw new Error(`GET /models 失败（HTTP ${response.status}）：${body.replaceAll(key, "[redacted]").slice(0, 400)}`);
  let parsed;
  try { parsed = JSON.parse(body); } catch { throw new Error("GET /models 返回的不是 JSON"); }
  return {
    provider: provider.id,
    models: (Array.isArray(parsed?.data) ? parsed.data : [])
      .map((item) => ({ id: String(item?.id || ""), ownedBy: String(item?.owned_by || item?.ownedBy || "") }))
      .filter((item) => item.id),
  };
}

async function probeProvider(raw, options = {}) {
  const provider = normalizeDefinition(raw);
  const key = secretFrom(raw);
  const model = String(raw?.model || "").trim();
  if (!model) throw new Error("测试模型不能为空");
  const startedAt = Date.now();
  const response = await fetchWithTimeout(`${provider.baseUrl}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, input: "Reply with OK only.", max_output_tokens: 16, store: false }),
  }, options);
  const body = await response.text();
  if (!response.ok) throw new Error(`POST /responses 失败（HTTP ${response.status}）：${body.replaceAll(key, "[redacted]").slice(0, 400)}`);
  let parsed = {};
  try { parsed = JSON.parse(body); } catch { parsed = {}; }
  return { ok: true, provider: provider.id, model, status: response.status, elapsedMs: Date.now() - startedAt, responseId: String(parsed?.id || "") };
}

async function addGlobalProvider(raw, options) {
  const provider = normalizeDefinition(raw);
  const key = secretFrom(raw);
  const configPath = configPathFor(options.codexHome);
  const { text, config } = readConfig(configPath);
  if (config.model_providers?.[provider.id]) throw new Error(`Provider 已存在：${provider.id}`);
  const readUserEnv = options.readUserEnvironmentVariable || readUserEnvironmentVariable;
  const setUserEnv = options.setUserEnvironmentVariable || setUserEnvironmentVariable;
  const writeConfig = options.writeTextAtomic || writeTextAtomic;
  const previous = await readUserEnv(provider.envKey);
  await setUserEnv(provider.envKey, key);
  try {
    const prefix = text.trimEnd();
    writeConfig(configPath, `${prefix ? `${prefix}\n\n` : ""}${providerBlock(provider)}\n`);
  } catch (error) {
    await setUserEnv(provider.envKey, previous || null).catch(() => {});
    throw error;
  }
  return { provider: publicProvider(provider.id, {
    name: provider.name, base_url: provider.baseUrl, wire_api: provider.wireApi, env_key: provider.envKey,
    service_tier_passthrough: provider.serviceTierPassthrough,
  }, "", { [provider.envKey]: "available" }), configPath };
}

async function replaceGlobalProviderKey(raw, options) {
  const id = String(raw?.id || "").trim();
  const key = secretFrom(raw);
  const catalog = inspectProviderCatalog(options.codexHome);
  const provider = catalog.providers.find((item) => item.id === id);
  if (!provider) throw new Error(`找不到 Provider：${id}`);
  const definition = { ...provider, apiKey: key, model: raw.model };
  const models = await listProviderModels(definition, options);
  const probe = await probeProvider(definition, options);
  const setUserEnv = options.setUserEnvironmentVariable || setUserEnvironmentVariable;
  await setUserEnv(provider.envKey, key);
  return { provider: { ...provider, credentialAvailable: true }, modelCount: models.models.length, probe };
}

function hasInlineSecret(value) {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nested]) => (
    (/secret|password|token|api[_-]?key|authorization|credential/i.test(key) && key !== "env_key")
    || hasInlineSecret(nested)
  ));
}

function comparable(value) {
  return JSON.stringify(value || {}, Object.keys(value || {}).sort());
}

function providerSyncPlan(options, apply = false) {
  const sourcePath = configPathFor(options.codexHome);
  const source = readConfig(sourcePath).config;
  const definitions = source.model_providers && typeof source.model_providers === "object" ? source.model_providers : {};
  const safeDefinitions = Object.fromEntries(Object.entries(definitions).filter(([, value]) => !hasInlineSecret(value)));
  const bots = readManagedBots(options.dataRoot).filter((bot) => bot.codexHomeMode === "isolated");
  const targets = [];
  const pendingWrites = [];
  const writeConfig = options.writeTextAtomic || writeTextAtomic;
  for (const bot of bots) {
    const targetPath = configPathFor(bot.codexHome);
    const targetRead = readConfig(targetPath);
    const target = targetRead.config;
    target.model_providers ||= {};
    const added = [];
    const updated = [];
    const unchanged = [];
    for (const [id, definition] of Object.entries(safeDefinitions)) {
      if (!target.model_providers[id]) added.push(id);
      else if (comparable(target.model_providers[id]) === comparable(definition)) unchanged.push(id);
      else updated.push(id);
    }
    if (added.length || updated.length) {
      for (const id of [...added, ...updated]) target.model_providers[id] = safeDefinitions[id];
      pendingWrites.push({
        targetPath,
        originalText: targetRead.text,
        existed: fs.existsSync(targetPath),
        nextText: `${TOML.stringify(target).trim()}\n`,
      });
    }
    targets.push({ name: bot.name, codexHome: bot.codexHome, configPath: targetPath, added, updated, unchanged, written: false });
  }
  if (apply) {
    const completed = [];
    try {
      for (const pending of pendingWrites) {
        writeConfig(pending.targetPath, pending.nextText);
        completed.push(pending);
        const target = targets.find((item) => item.configPath === pending.targetPath);
        if (target) target.written = true;
      }
    } catch (error) {
      const rollbackErrors = [];
      for (const pending of completed.reverse()) {
        try {
          if (pending.existed) writeConfig(pending.targetPath, pending.originalText);
          else fs.rmSync(pending.targetPath, { force: true });
        } catch (rollbackError) {
          rollbackErrors.push(`${pending.targetPath}: ${rollbackError.message}`);
        }
      }
      const suffix = rollbackErrors.length ? `；回滚失败：${rollbackErrors.join("；")}` : "；已回滚先前写入";
      throw new Error(`Provider 同步失败：${error.message}${suffix}`);
    }
  }
  return {
    applied: apply,
    sourcePath,
    providerCount: Object.keys(safeDefinitions).length,
    skippedProviderCount: Object.keys(definitions).length - Object.keys(safeDefinitions).length,
    targetCount: targets.length,
    addCount: targets.reduce((sum, item) => sum + item.added.length, 0),
    updateCount: targets.reduce((sum, item) => sum + item.updated.length, 0),
    writtenCount: targets.filter((item) => item.written).length,
    targets,
  };
}

module.exports = {
  addGlobalProvider,
  inspectProviderCatalog,
  listProviderModels,
  normalizeDefinition,
  probeProvider,
  providerSyncPlan,
  replaceGlobalProviderKey,
};
