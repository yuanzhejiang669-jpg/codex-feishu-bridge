const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const TOML = require("smol-toml");

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ENV_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;

function hasInlineSecret(value) {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nested]) => (
    (/secret|password|token|api[_-]?key|authorization|credential/i.test(key) && key !== "env_key")
    || hasInlineSecret(nested)
  ));
}

function normalizeProviderInput(raw = {}, botName = "bot") {
  const mode = String(raw.mode || "custom").trim().toLowerCase();
  if (mode === "current") return { mode };
  if (mode === "global") {
    const id = String(raw.id || "").trim();
    const model = String(raw.model || "").trim();
    if (!ID_PATTERN.test(id)) throw new Error("请选择有效的全局 Provider");
    if (!model) throw new Error("模型名称不能为空");
    return { mode, id, model, reasoning: String(raw.reasoning || "medium").trim() || "medium" };
  }
  if (mode !== "custom") throw new Error("Provider 模式无效");
  const id = String(raw.id || "").trim();
  if (!ID_PATTERN.test(id)) throw new Error("Provider 标识只能包含字母、数字、点、下划线和连字符");
  const model = String(raw.model || "").trim();
  if (!model) throw new Error("模型名称不能为空");
  const baseUrl = String(raw.baseUrl || "").trim().replace(/\/+$/, "");
  let parsedUrl;
  try { parsedUrl = new URL(baseUrl); } catch { throw new Error("Provider Base URL 格式无效"); }
  if (!new Set(["http:", "https:"]).has(parsedUrl.protocol)) throw new Error("Provider Base URL 必须使用 HTTP 或 HTTPS");
  const generatedEnvKey = `CODEX_FEISHU_${String(botName).replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_API_KEY`;
  const envKey = String(raw.envKey || generatedEnvKey).trim().toUpperCase();
  if (!ENV_PATTERN.test(envKey)) throw new Error("Provider 环境变量名称格式无效");
  const apiKey = String(raw.apiKey || "").trim();
  if (!apiKey) throw new Error("Provider API Key 不能为空");
  return {
    mode,
    id,
    name: String(raw.name || id).trim().slice(0, 120) || id,
    baseUrl,
    model,
    envKey,
    apiKey,
    wireApi: "responses",
    reasoning: String(raw.reasoning || "medium").trim() || "medium",
  };
}

function parseConfig(configPath) {
  try {
    return TOML.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`无法解析 Codex 配置：${error.message}`);
  }
}

function inspectProvider(codexHome, env = process.env) {
  const configPath = path.join(codexHome, "config.toml");
  try {
    const config = parseConfig(configPath);
    const id = String(config.model_provider || "").trim();
    const provider = id ? config.model_providers?.[id] : null;
    const envKey = String(provider?.env_key || "").trim();
    const thirdParty = Boolean(id && id !== "openai" && provider);
    return {
      configured: Boolean(id && (provider || id === "openai")),
      id,
      name: String(provider?.name || id || "").trim(),
      model: String(config.model || "").trim(),
      baseUrl: String(provider?.base_url || "").trim(),
      envKey,
      credentialAvailable: envKey ? Object.prototype.hasOwnProperty.call(env, envKey) && Boolean(env[envKey]) : null,
      requiresOpenaiAuth: id === "openai" || Boolean(provider?.requires_openai_auth),
      thirdParty,
      configPath,
      error: "",
    };
  } catch (error) {
    return { configured: false, id: "", name: "", model: "", baseUrl: "", envKey: "", credentialAvailable: null, requiresOpenaiAuth: false, thirdParty: false, configPath, error: error.message };
  }
}

function prepareProviderConfiguration(bot, raw, options) {
  if (!raw || typeof raw !== "object" || !Object.keys(raw).length) return null;
  const provider = normalizeProviderInput(raw, bot.name);
  if (provider.mode === "current") {
    if (bot.codexHomeMode !== "shared") throw new Error("使用当前 Provider 时必须共享当前 Codex Home");
    return null;
  }
  if (provider.mode === "global") {
    if (bot.codexHomeMode !== "isolated") throw new Error("全局 Provider 引用必须写入隔离 Codex Home");
    const sourcePath = path.join(options.sourceCodexHome, "config.toml");
    const source = parseConfig(sourcePath);
    const definition = source.model_providers?.[provider.id];
    if (!definition) throw new Error(`全局 Provider 不存在：${provider.id}`);
    if (hasInlineSecret(definition)) {
      throw new Error(`全局 Provider ${provider.id} 包含内联敏感字段`);
    }
    const envKey = String(definition.env_key || "").trim();
    if (!envKey || !(options.env || process.env)[envKey]) throw new Error(`全局 Provider 环境变量不可用：${envKey || "未配置"}`);
    const configPath = path.join(bot.codexHome, "config.toml");
    const originalExists = fs.existsSync(configPath);
    const original = originalExists ? fs.readFileSync(configPath) : null;
    const config = parseConfig(configPath);
    config.model = provider.model;
    config.model_provider = provider.id;
    config.model_reasoning_effort = provider.reasoning;
    config.model_providers ||= {};
    config.model_providers[provider.id] = structuredClone(definition);
    const temporaryConfig = `${configPath}.cfb-${crypto.randomUUID()}.tmp`;
    const backupConfig = `${configPath}.cfb-${crypto.randomUUID()}.bak`;
    let committed = false;
    return {
      publicConfig: {
        mode: "global",
        id: provider.id,
        name: String(definition.name || provider.id),
        baseUrl: String(definition.base_url || ""),
        model: provider.model,
        envKey,
        wireApi: String(definition.wire_api || "responses"),
        reasoning: provider.reasoning,
        credentialStorage: "windows-user-environment",
      },
      commit() {
        fs.mkdirSync(bot.codexHome, { recursive: true });
        fs.writeFileSync(temporaryConfig, `${TOML.stringify(config).trim()}\n`, "utf8");
        if (originalExists) fs.renameSync(configPath, backupConfig);
        fs.renameSync(temporaryConfig, configPath);
        committed = true;
        fs.rmSync(backupConfig, { force: true });
      },
      rollback() {
        fs.rmSync(temporaryConfig, { force: true });
        if (fs.existsSync(backupConfig)) {
          fs.rmSync(configPath, { force: true });
          fs.renameSync(backupConfig, configPath);
        } else if (committed) {
          if (original) fs.writeFileSync(configPath, original);
          else fs.rmSync(configPath, { force: true });
        }
      },
    };
  }
  if (bot.codexHomeMode !== "isolated") throw new Error("自定义 Provider 必须使用隔离 Codex Home");
  if (typeof options.encryptSecret !== "function") throw new Error("Windows 安全存储不可用，不能保存 Provider API Key");

  const configPath = path.join(bot.codexHome, "config.toml");
  const originalExists = fs.existsSync(configPath);
  const original = originalExists ? fs.readFileSync(configPath) : null;
  const config = parseConfig(configPath);
  config.model = provider.model;
  config.model_provider = provider.id;
  config.model_reasoning_effort = provider.reasoning;
  config.model_providers ||= {};
  config.model_providers[provider.id] = {
    name: provider.name,
    base_url: provider.baseUrl,
    wire_api: provider.wireApi,
    env_key: provider.envKey,
    requires_openai_auth: false,
  };
  const secretPath = path.join(options.transactionRoot, "provider-secret.bin");
  const encrypted = options.encryptSecret(provider.apiKey);
  if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new Error("Provider API Key 加密失败");
  fs.writeFileSync(secretPath, encrypted);
  const temporaryConfig = `${configPath}.cfb-${crypto.randomUUID()}.tmp`;
  const backupConfig = `${configPath}.cfb-${crypto.randomUUID()}.bak`;
  let committed = false;

  return {
    publicConfig: {
      mode: provider.mode,
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      model: provider.model,
      envKey: provider.envKey,
      wireApi: provider.wireApi,
      reasoning: provider.reasoning,
      credentialStorage: "windows-dpapi",
    },
    commit() {
      fs.mkdirSync(bot.codexHome, { recursive: true });
      fs.writeFileSync(temporaryConfig, `${TOML.stringify(config).trim()}\n`, "utf8");
      if (originalExists) fs.renameSync(configPath, backupConfig);
      fs.renameSync(temporaryConfig, configPath);
      committed = true;
      fs.rmSync(backupConfig, { force: true });
    },
    rollback() {
      fs.rmSync(temporaryConfig, { force: true });
      if (fs.existsSync(backupConfig)) {
        fs.rmSync(configPath, { force: true });
        fs.renameSync(backupConfig, configPath);
      } else if (committed) {
        if (original) fs.writeFileSync(configPath, original);
        else fs.rmSync(configPath, { force: true });
      }
    },
  };
}

function providerResponsesUrl(baseUrl) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}/responses`;
}

async function testProvider(raw, options = {}) {
  const provider = normalizeProviderInput(raw, options.botName || "test");
  if (provider.mode !== "custom") throw new Error("当前 Provider 模式不需要单独测试");
  const timeoutMs = Number(options.timeoutMs || 30_000);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await (options.fetchImpl || fetch)(providerResponsesUrl(provider.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        input: "Reply with OK only.",
        max_output_tokens: 16,
        store: false,
      }),
      signal: abort.signal,
    });
    const responseText = await response.text();
    if (!response.ok) {
      const safeText = responseText.replaceAll(provider.apiKey, "[redacted]").slice(0, 500);
      throw new Error(`Provider 请求失败（HTTP ${response.status}）：${safeText || response.statusText}`);
    }
    let parsed = null;
    try { parsed = JSON.parse(responseText); } catch { parsed = null; }
    return {
      ok: true,
      status: response.status,
      provider: provider.id,
      model: provider.model,
      responseId: String(parsed?.id || ""),
    };
  } catch (error) {
    if (abort.signal.aborted) throw new Error(`Provider 请求超过 ${Math.round(timeoutMs / 1000)} 秒`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  inspectProvider,
  normalizeProviderInput,
  prepareProviderConfiguration,
  providerResponsesUrl,
  testProvider,
};
