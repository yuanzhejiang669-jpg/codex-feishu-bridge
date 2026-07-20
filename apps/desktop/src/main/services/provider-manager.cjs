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
  if (!new Set(["responses", "chat"]).has(wireApi)) throw new Error("Provider 接口只能是 Responses 或 Chat Completions");
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

function providerTablePaths(id) {
  return [
    `model_providers.${id}`,
    `model_providers.${JSON.stringify(id)}`,
    `model_providers.'${String(id).replaceAll("'", "''")}'`,
  ];
}

function removeTopLevelAssignment(lines, name) {
  let insideTable = false;
  return lines.filter((line) => {
    if (/^\s*\[/.test(line)) insideTable = true;
    return insideTable || !new RegExp(`^\\s*${name}\\s*=`).test(line);
  });
}

function removeProviderDefinition(text, id, clearSelection = false) {
  const paths = providerTablePaths(id);
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  let start = -1;
  let end = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (!match) continue;
    const tablePath = match[1].trim();
    if (start < 0 && paths.includes(tablePath)) {
      start = index;
      continue;
    }
    if (start >= 0 && !paths.some((item) => tablePath === item || tablePath.startsWith(`${item}.`))) {
      end = index;
      break;
    }
  }
  if (start < 0) throw new Error(`无法安全定位 Provider 配置段：${id}`);
  let next = [...lines.slice(0, start), ...lines.slice(end)];
  while (start > 0 && next[start - 1] === "" && next[start] === "") next.splice(start, 1);
  if (clearSelection) {
    next = removeTopLevelAssignment(next, "model_provider");
    next = removeTopLevelAssignment(next, "model");
  }
  return `${next.join("\n").trimEnd()}\n`;
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
  const chat = provider.wireApi === "chat";
  const response = await fetchWithTimeout(`${provider.baseUrl}/${chat ? "chat/completions" : "responses"}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(chat
      ? { model, messages: [{ role: "user", content: "Reply with OK only." }], max_tokens: 16, stream: false }
      : { model, input: "Reply with OK only.", max_output_tokens: 16, store: false }),
  }, options);
  const body = await response.text();
  if (!response.ok) throw new Error(`POST /${chat ? "chat/completions" : "responses"} 失败（HTTP ${response.status}）：${body.replaceAll(key, "[redacted]").slice(0, 400)}`);
  let parsed = {};
  try { parsed = JSON.parse(body); } catch { parsed = {}; }
  if (chat && !Array.isArray(parsed?.choices)) throw new Error("Chat Completions 测试响应缺少 choices");
  return { ok: true, provider: provider.id, model, wireApi: provider.wireApi, status: response.status, elapsedMs: Date.now() - startedAt, responseId: String(parsed?.id || "") };
}

async function addGlobalProvider(raw, options) {
  const provider = normalizeDefinition(raw);
  const key = secretFrom(raw);
  let discoveredModels = [];
  let defaultModel = String(raw?.model || "").trim();
  if (provider.wireApi === "chat") {
    discoveredModels = (await listProviderModels(raw, options)).models;
    defaultModel ||= discoveredModels[0]?.id || "";
    await probeProvider({ ...raw, model: defaultModel }, options);
  }
  const configPath = configPathFor(options.codexHome);
  const { text, config } = readConfig(configPath);
  if (config.model_providers?.[provider.id]) throw new Error(`Provider 已存在：${provider.id}`);
  const readUserEnv = options.readUserEnvironmentVariable || readUserEnvironmentVariable;
  const setUserEnv = options.setUserEnvironmentVariable || setUserEnvironmentVariable;
  const writeConfig = options.writeTextAtomic || writeTextAtomic;
  const proxyTransaction = provider.wireApi === "chat"
    ? await options.prepareProtocolProxyProvider?.(provider, defaultModel, discoveredModels)
    : null;
  if (provider.wireApi === "chat" && !proxyTransaction) throw new Error("客户端托管协议代理不可用");
  const codexProvider = proxyTransaction?.codexProvider || provider;
  const previous = await readUserEnv(provider.envKey);
  await setUserEnv(provider.envKey, key);
  let configWritten = false;
  try {
    const prefix = text.trimEnd();
    writeConfig(configPath, `${prefix ? `${prefix}\n\n` : ""}${providerBlock(codexProvider)}\n`);
    configWritten = true;
    await proxyTransaction?.commit();
  } catch (error) {
    if (configWritten) {
      try { writeConfig(configPath, text); } catch {}
    }
    await proxyTransaction?.rollback().catch(() => {});
    await setUserEnv(provider.envKey, previous || null).catch(() => {});
    throw error;
  }
  return { provider: publicProvider(provider.id, {
    name: provider.name, base_url: provider.baseUrl, wire_api: provider.wireApi, env_key: provider.envKey,
    service_tier_passthrough: provider.serviceTierPassthrough,
  }, "", { [provider.envKey]: "available" }), managedProxy: provider.wireApi === "chat", configPath };
}

async function replaceGlobalProviderKey(raw, options) {
  const id = String(raw?.id || "").trim();
  const key = secretFrom(raw);
  const rawCatalog = inspectProviderCatalog(options.codexHome);
  const catalog = options.decorateProviderCatalog?.(rawCatalog) || rawCatalog;
  const provider = catalog.providers.find((item) => item.id === id);
  if (!provider) throw new Error(`找不到 Provider：${id}`);
  const readUserEnv = options.readUserEnvironmentVariable || readUserEnvironmentVariable;
  const setUserEnv = options.setUserEnvironmentVariable || setUserEnvironmentVariable;
  const previous = await readUserEnv(provider.envKey);
  await setUserEnv(provider.envKey, key);
  try {
    if (provider.managedProxy) await options.restartProtocolProxy?.(provider.id);
  } catch (error) {
    await setUserEnv(provider.envKey, previous || null).catch(() => {});
    await options.restartProtocolProxy?.(provider.id).catch(() => {});
    throw error;
  }
  return {
    provider: { ...provider, credentialAvailable: true },
    validation: "not-requested",
    requiresBotRestart: !provider.managedProxy,
  };
}

function uniqueManagedHomes(dataRoot) {
  const homes = new Map();
  for (const bot of readManagedBots(dataRoot).filter((item) => item.codexHomeMode === "isolated" && item.codexHome)) {
    const resolved = path.resolve(bot.codexHome);
    const key = resolved.toLowerCase();
    if (!homes.has(key)) homes.set(key, { codexHome: resolved, bots: [] });
    homes.get(key).bots.push(bot);
  }
  return [...homes.values()];
}

function previewGlobalProviderRemoval(raw, options) {
  const id = String(raw?.id || raw || "").trim();
  const rawCatalog = inspectProviderCatalog(options.codexHome);
  if (rawCatalog.error) throw new Error(rawCatalog.error);
  const catalog = options.decorateProviderCatalog?.(rawCatalog) || rawCatalog;
  const provider = catalog.providers.find((item) => item.id === id);
  if (!provider) throw new Error(`找不到 Provider：${id}`);
  const managedBots = readManagedBots(options.dataRoot);
  const homes = uniqueManagedHomes(options.dataRoot).map((home) => {
    const configPath = configPathFor(home.codexHome);
    const read = readConfig(configPath);
    const definitions = read.config.model_providers && typeof read.config.model_providers === "object"
      ? read.config.model_providers
      : {};
    return {
      ...home,
      configPath,
      containsProvider: Object.hasOwn(definitions, id),
      selected: String(read.config.model_provider || "") === id,
      envReferences: Object.entries(definitions)
        .filter(([providerId, definition]) => providerId !== id && String(definition?.env_key || "") === provider.envKey)
        .map(([providerId]) => providerId),
    };
  });
  const otherGlobalReferences = catalog.providers
    .filter((item) => item.id !== id && item.envKey && item.envKey === provider.envKey)
    .map((item) => item.id);
  const otherEnvironmentReferences = [...new Set([
    ...otherGlobalReferences,
    ...homes.flatMap((home) => home.envReferences),
  ])];
  const referencedBotNames = new Set([
    ...managedBots.filter((bot) => String(bot.provider?.id || "") === id).map((bot) => bot.name),
    ...managedBots.filter((bot) => (
      provider.selected === true
      && bot.codexHomeMode === "shared"
      && path.resolve(bot.codexHome || options.codexHome).toLowerCase() === path.resolve(options.codexHome).toLowerCase()
      && (String(bot.provider?.mode || "current") === "current" || !bot.provider?.id)
    )).map((bot) => bot.name),
    ...homes.filter((home) => home.selected).flatMap((home) => home.bots.map((bot) => bot.name)),
  ]);
  const referencedBots = managedBots.filter((bot) => referencedBotNames.has(bot.name));
  return {
    id,
    provider,
    configPath: rawCatalog.configPath,
    selected: provider.selected === true,
    managedProxy: provider.managedProxy === true,
    referencedBots: referencedBots.map((bot) => ({ name: bot.name, label: bot.label || bot.name, codexHome: bot.codexHome })),
    managedSpaces: homes.filter((home) => home.containsProvider).map((home) => ({
      codexHome: home.codexHome,
      configPath: home.configPath,
      selected: home.selected,
      bots: home.bots.map((bot) => bot.name),
    })),
    envKey: provider.envKey,
    otherEnvironmentReferences,
    canDeleteApiKey: Boolean(provider.envKey) && otherEnvironmentReferences.length === 0,
    blockers: referencedBots.length
      ? [`仍有 ${referencedBots.length} 个客户端 Bot 引用该 Provider，请先迁移或删除这些 Bot`]
      : [],
    defaults: {
      removeFromManagedSpaces: true,
      deleteApiKey: Boolean(provider.envKey) && otherEnvironmentReferences.length === 0,
    },
  };
}

async function applyGlobalProviderRemoval(raw, options) {
  const preview = previewGlobalProviderRemoval(raw, options);
  if (preview.blockers.length) throw new Error(preview.blockers.join("；"));
  const removeFromManagedSpaces = raw?.removeFromManagedSpaces !== false;
  const deleteApiKey = raw?.deleteApiKey === true;
  if (deleteApiKey && !preview.canDeleteApiKey) {
    throw new Error(`环境变量 ${preview.envKey} 仍被其他 Provider 引用：${preview.otherEnvironmentReferences.join("、")}`);
  }
  if (deleteApiKey && !removeFromManagedSpaces && preview.managedSpaces.length) {
    throw new Error("保留隔离空间 Provider 时不能删除对应 API Key");
  }

  const writeConfig = options.writeTextAtomic || writeTextAtomic;
  const source = readConfig(preview.configPath);
  const writes = [{
    path: preview.configPath,
    original: source.text,
    next: removeProviderDefinition(source.text, preview.id, preview.selected),
  }];
  if (removeFromManagedSpaces) {
    for (const space of preview.managedSpaces) {
      const target = readConfig(space.configPath);
      writes.push({
        path: space.configPath,
        original: target.text,
        next: removeProviderDefinition(target.text, preview.id, space.selected),
      });
    }
  }
  const proxyTransaction = preview.managedProxy
    ? options.prepareProtocolProxyRemoval?.(preview.id)
    : null;
  if (preview.managedProxy && !proxyTransaction) throw new Error("托管协议代理删除事务不可用");
  const readUserEnv = options.readUserEnvironmentVariable || readUserEnvironmentVariable;
  const setUserEnv = options.setUserEnvironmentVariable || setUserEnvironmentVariable;
  const previousKey = deleteApiKey ? await readUserEnv(preview.envKey) : "";
  const completed = [];
  let proxyCommitted = false;
  let keyDeleted = false;
  try {
    for (const item of writes) {
      writeConfig(item.path, item.next);
      completed.push(item);
    }
    await proxyTransaction?.commit();
    proxyCommitted = Boolean(proxyTransaction);
    if (deleteApiKey) {
      await setUserEnv(preview.envKey, null);
      keyDeleted = true;
    }
  } catch (error) {
    const rollbackErrors = [];
    if (keyDeleted) await setUserEnv(preview.envKey, previousKey || null).catch((rollback) => rollbackErrors.push(rollback.message));
    if (proxyCommitted) await proxyTransaction.rollback().catch((rollback) => rollbackErrors.push(rollback.message));
    for (const item of completed.reverse()) {
      try { writeConfig(item.path, item.original); } catch (rollback) { rollbackErrors.push(`${item.path}: ${rollback.message}`); }
    }
    throw new Error(`Provider 删除失败：${error.message}${rollbackErrors.length ? `；回滚失败：${rollbackErrors.join("；")}` : "；已回滚"}`);
  }
  return {
    ok: true,
    id: preview.id,
    removedFromManagedSpaces: removeFromManagedSpaces ? preview.managedSpaces.length : 0,
    apiKeyDeleted: deleteApiKey,
    envKey: preview.envKey,
    proxyRemoved: preview.managedProxy,
    selectionCleared: preview.selected,
  };
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
  applyGlobalProviderRemoval,
  inspectProviderCatalog,
  listProviderModels,
  normalizeDefinition,
  probeProvider,
  previewGlobalProviderRemoval,
  providerSyncPlan,
  readUserEnvironmentVariable,
  removeProviderDefinition,
  replaceGlobalProviderKey,
};
