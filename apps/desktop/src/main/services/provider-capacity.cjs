const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const TOML = require("smol-toml");

const MAX_CATALOG_BYTES = 1024 * 1024;
// Codex's ModelInfo default when a catalog omits this optional field.
const CODEX_DEFAULT_EFFECTIVE_PERCENT = 95;
const checks = new Map();
const versions = new Map();

function checkKey(codexHome, id) {
  return `${path.resolve(codexHome)}\0${id}`;
}

function catalogUrl(value, baseUrl) {
  const url = new URL(value || `${String(baseUrl).replace(/\/+$/, "")}/models`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("模型目录地址必须是 HTTP/HTTPS 地址，且不能包含用户名、密码或片段");
  }
  return url.toString();
}

async function clientVersion(options) {
  const explicit = String(options.clientVersion || "").match(/\b\d+\.\d+\.\d+\b/)?.[0];
  if (explicit) return explicit;
  if (!options.codexPath) return "";
  if (!versions.has(options.codexPath)) {
    versions.set(options.codexPath, new Promise((resolve) => {
      execFile(options.codexPath, ["--version"], { windowsHide: true, timeout: 5000, maxBuffer: 32768 }, (error, stdout) => {
        resolve(error ? "" : String(stdout).match(/\b\d+\.\d+\.\d+\b/)?.[0] || "");
      });
    }));
  }
  return versions.get(options.codexPath);
}

function normalizeCatalog(body) {
  if (!Array.isArray(body?.models) || !body.models.length) {
    throw new Error("接口未提供 Codex 模型目录；普通模型名称列表不包含完整容量资料");
  }
  const seen = new Set();
  return body.models.map((model) => {
    if (typeof model?.slug !== "string" || !model.slug.trim() || seen.has(model.slug)
      || typeof model.display_name !== "string" || !Array.isArray(model.supported_reasoning_levels)
      || typeof model.shell_type !== "string" || typeof model.visibility !== "string"
      || typeof model.supported_in_api !== "boolean" || !Number.isInteger(model.priority)
      || typeof model.support_verbosity !== "boolean" || !Array.isArray(model.experimental_supported_tools)
      || typeof model.truncation_policy?.mode !== "string" || !Number.isInteger(model.truncation_policy?.limit)
      || (typeof model.base_instructions !== "string" && !model.model_instructions && !model.model_messages)) {
      throw new Error("模型目录缺少完整 Codex 模型定义或包含重复名称，未自动接入");
    }
    seen.add(model.slug);
    const window = model.context_window;
    const percent = model.effective_context_window_percent ?? CODEX_DEFAULT_EFFECTIVE_PERCENT;
    if ((window != null && (!Number.isSafeInteger(window) || window <= 0))
      || !Number.isInteger(percent) || percent <= 0 || percent > 100) {
      throw new Error("模型目录中的窗口大小或可用比例无效，未自动接入");
    }
    return {
      id: model.slug,
      contextWindow: window ?? null,
      effectivePercent: percent,
      percentSource: model.effective_context_window_percent == null ? "codex-default" : "provider",
      usableWindow: window == null ? null : Math.floor(window * percent / 100),
    };
  });
}

async function boundedJson(response) {
  if (Number(response.headers?.get?.("content-length")) > MAX_CATALOG_BYTES) {
    await response.body?.cancel();
    throw new Error("模型目录超过 Codex 允许的 1 MiB");
  }
  let text;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_CATALOG_BYTES) throw new Error("模型目录超过 Codex 允许的 1 MiB");
        chunks.push(Buffer.from(value));
      }
      text = Buffer.concat(chunks).toString("utf8");
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } else {
    text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_CATALOG_BYTES) throw new Error("模型目录超过 Codex 允许的 1 MiB");
  }
  try { return JSON.parse(text); } catch { throw new Error("模型目录返回的不是有效 JSON"); }
}

async function discoverProviderCapacity(provider, options = {}) {
  const version = await clientVersion(options);
  if (!version) return { status: "unchecked", reason: "尚未确认 Codex 版本，未检测容量目录", models: [] };
  if (provider.wireApi === "chat") return { status: "unsupported", reason: "Chat 协议代理未提供 Codex 容量目录", models: [] };
  let url;
  try { url = catalogUrl(provider.modelCatalogUrl, provider.baseUrl); }
  catch (error) { return { status: "unavailable", reason: error.message, models: [] }; }
  const requestUrl = new URL(url);
  for (const [name, value] of Object.entries(provider.queryParams || {})) requestUrl.searchParams.set(name, String(value));
  requestUrl.searchParams.set("client_version", version);
  const abort = new AbortController();
  const timeoutMs = options.catalogTimeoutMs || options.timeoutMs || 15000;
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  timer.unref?.();
  try {
    const headers = { accept: "application/json", ...(provider.httpHeaders || {}) };
    if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
    for (const [name, envKey] of Object.entries(provider.envHttpHeaders || {})) {
      const value = (options.env || process.env)[envKey];
      if (!value) throw new Error("容量目录所需的环境变量凭据不可用");
      headers[name] = value;
    }
    const response = await (options.fetchImpl || fetch)(requestUrl.toString(), {
      method: "GET", headers, redirect: "error", signal: abort.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`容量目录请求失败（HTTP ${response.status}）`);
    }
    const models = normalizeCatalog(await boundedJson(response));
    return { status: "remote", url, clientVersion: version, checkedAt: new Date().toISOString(), models };
  } catch (error) {
    // Do not expose response bodies, headers, network errors or credentials to IPC/logs.
    const safeMessage = /^(模型目录|接口未提供|容量目录)/.test(error.message) ? error.message : "容量目录连接失败或返回了重定向";
    return { status: "unavailable", url, checkedAt: new Date().toISOString(), models: [], reason: abort.signal.aborted ? "容量目录检测超时" : safeMessage };
  } finally { clearTimeout(timer); }
}

function inspectProviderCapacity(codexHome, id, config) {
  const definition = config.model_providers?.[id] || {};
  const checked = checks.get(checkKey(codexHome, id));
  const url = String(definition.model_catalog_url || "");
  const base = { models: [], ...(checked?.baseUrl === definition.base_url ? checked.result : {}), configuredUrl: url };
  if (config.model_context_window != null) return { ...base, status: "manual", configuredWindow: config.model_context_window, reason: "使用此 Codex Home 手动配置的窗口大小" };
  if (config.model_catalog_json) return { ...base, status: "local", reason: "使用手动配置的本地模型目录，优先于远程目录" };
  if (config.features?.api_key_model_discovery === false) return { ...base, status: "disabled", reason: "Codex 配置关闭了 API Key 模型目录发现" };
  if (url && base.status !== "unavailable") return { ...base, status: base.status === "remote" && base.url === url ? "remote" : "configured" };
  return { ...base, status: base.status === "remote" && !url ? "unchecked" : base.status || "unchecked" };
}

function rememberCapacity(codexHome, id, baseUrl, result) {
  checks.set(checkKey(codexHome, id), { baseUrl, result });
}

function setProviderCatalogUrl(text, id, url) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const names = [`model_providers.${id}`, `model_providers.${JSON.stringify(id)}`, `model_providers.'${id}'`];
  const start = lines.findIndex((line) => names.includes(line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/)?.[1]?.trim()));
  if (start < 0) throw new Error("未找到 Provider 配置表，未写入容量目录");
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  const existing = lines.findIndex((line, index) => index > start && index < end && /^\s*model_catalog_url\s*=/.test(line));
  const assignment = `model_catalog_url = ${JSON.stringify(url)}`;
  if (existing >= 0) lines[existing] = assignment;
  else lines.splice(start + 1, 0, assignment);
  const next = lines.join(eol);
  if (TOML.parse(next.replace(/^\uFEFF/, "")).model_providers?.[id]?.model_catalog_url !== url) {
    throw new Error("容量目录配置校验失败，未写入");
  }
  return next;
}

async function checkProviderCapacity(raw, options) {
  const configPath = path.join(options.codexHome, "config.toml");
  const config = TOML.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
  const definition = config.model_providers?.[raw.id];
  if (!definition) throw new Error("Provider 不存在");
  if (config.model_catalog_json || config.features?.api_key_model_discovery === false) {
    return { id: raw.id, changed: false, capacity: inspectProviderCapacity(options.codexHome, raw.id, config) };
  }
  const apiKey = await options.readKey?.(definition.env_key, options.codexHome);
  let result;
  if (!apiKey || definition.requires_openai_auth || definition.auth) {
    result = { status: "unsupported", models: [], reason: "当前凭据方式无法自动检测；可继续使用已有目录配置" };
  } else {
    result = await discoverProviderCapacity({
      baseUrl: definition.base_url,
      modelCatalogUrl: raw.modelCatalogUrl || definition.model_catalog_url,
      wireApi: definition.wire_api,
      apiKey,
      queryParams: definition.query_params,
      httpHeaders: definition.http_headers,
      envHttpHeaders: definition.env_http_headers,
    }, options);
  }
  rememberCapacity(options.codexHome, raw.id, definition.base_url, result);
  let changed = false;
  if (result.status === "remote") {
    // Re-read after the request: preserve unrelated concurrent edits and never change selection.
    const currentText = fs.readFileSync(configPath, "utf8");
    const current = TOML.parse(currentText.replace(/^\uFEFF/, ""));
    const latest = current.model_providers?.[raw.id];
    if (!latest || JSON.stringify(latest) !== JSON.stringify(definition)
      || current.model_catalog_json || current.features?.api_key_model_discovery === false) {
      throw new Error("检测期间配置发生变化，请重新检测容量");
    }
    if (latest.model_catalog_url !== result.url) {
      if (typeof options.writeTextAtomic !== "function") throw new Error("容量目录配置写入器不可用");
      options.writeTextAtomic(configPath, setProviderCatalogUrl(currentText, raw.id, result.url));
      changed = true;
    }
    current.model_providers[raw.id].model_catalog_url = result.url;
    return { id: raw.id, changed, capacity: inspectProviderCapacity(options.codexHome, raw.id, current) };
  }
  return { id: raw.id, changed, capacity: inspectProviderCapacity(options.codexHome, raw.id, config) };
}

module.exports = {
  catalogUrl, checkProviderCapacity, clientVersion, discoverProviderCapacity, inspectProviderCapacity,
  normalizeCatalog, rememberCapacity, setProviderCatalogUrl,
};
