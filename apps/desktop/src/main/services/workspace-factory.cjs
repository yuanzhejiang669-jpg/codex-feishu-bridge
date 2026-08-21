const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const TOML = require("smol-toml");
const { readManagedBots } = require("./bot-setup.cjs");
const { normalizeReasoningEffort, resolveReasoningSelection } = require("./reasoning-effort.cjs");

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,59}$/;
const NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,62}[A-Za-z0-9])?$/;

function queuePath(dataRoot) {
  return path.join(dataRoot, "workspace-factory.json");
}

function atomicWrite(destination, text) {
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(temporary, text, "utf8");
  fs.renameSync(temporary, destination);
}

function readQueue(dataRoot) {
  try {
    const state = JSON.parse(fs.readFileSync(queuePath(dataRoot), "utf8"));
    state.bots = (state.bots || []).map((bot) => bot.status === "registering" ? {
      ...bot,
      status: "failed",
      error: "上次扫码注册被客户端退出中断；请先检查飞书后台是否留下未完成应用",
    } : bot);
    return state;
  }
  catch (error) {
    if (error?.code === "ENOENT") return { schemaVersion: 1, status: "empty", bots: [] };
    throw new Error(`无法读取工作空间创建队列：${error.message}`);
  }
}

function hasInlineSecret(value) {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nested]) => (
    (/secret|password|token|api[_-]?key|authorization|credential/i.test(key) && key !== "env_key")
    || hasInlineSecret(nested)
  ));
}

function sourceProvider(sourceCodexHome, providerId, env = process.env) {
  const configPath = path.join(sourceCodexHome, "config.toml");
  let config;
  try { config = TOML.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")); }
  catch (error) { throw new Error(`无法读取全局 Provider：${error.message}`); }
  const definition = config.model_providers?.[providerId];
  if (!definition) throw new Error(`全局 Provider 不存在：${providerId}`);
  if (hasInlineSecret(definition)) throw new Error(`Provider ${providerId} 包含内联敏感字段，不能用于空间工厂`);
  const envKey = String(definition.env_key || "").trim();
  if (!envKey || !env[envKey]) throw new Error(`Provider 环境变量不可用：${envKey || "未配置"}`);
  return { definition: structuredClone(definition), envKey, configPath };
}

function renderPattern(pattern, index, values) {
  return String(pattern)
    .replaceAll("{index2}", String(index).padStart(2, "0"))
    .replaceAll("{index}", String(index))
    .replaceAll("{slug}", values.slug)
    .replaceAll("{space}", values.spaceName);
}

function normalizeFactory(raw = {}, options = {}) {
  const engine = String(raw.engine || "codex").trim().toLowerCase();
  if (!new Set(["codex", "pi"]).has(engine)) throw new Error("Agent 引擎无效");
  const piPreset = engine === "pi";
  const spaceName = String(piPreset ? "pi-general" : raw.spaceName || "").trim().slice(0, 80);
  if (!spaceName) throw new Error("空间名称不能为空");
  const slug = String(piPreset ? "pi-general" : raw.slug || "").trim().toLowerCase();
  if (!SLUG_PATTERN.test(slug)) throw new Error("空间 slug 只能包含小写字母、数字和短横线");
  const count = piPreset ? 5 : Number(raw.count);
  const baseIndex = piPreset ? 1 : Number(raw.baseIndex);
  if (!Number.isInteger(count) || count < 1 || count > 16) throw new Error("Bot 数量必须是 1-16 的整数");
  if (!Number.isInteger(baseIndex) || baseIndex < 1 || baseIndex > 999) throw new Error("起始序号必须是 1-999 的整数");
  const namePattern = String(piPreset ? "pi-agent-{index2}" : raw.namePattern || `codex-assistant-{index}-${slug}`).trim();
  const labelPattern = String(piPreset ? "Pi Agent {index2}" : raw.labelPattern || `Codex助手{index}-${spaceName}`).trim();
  if (!/\{index2?\}/.test(namePattern) || !/\{index2?\}/.test(labelPattern)) throw new Error("Bot 标识和显示名称模板必须包含 {index} 或 {index2}");
  const providerId = String(raw.providerId || "").trim();
  const model = String(raw.model || "").trim();
  if (!providerId || !model) throw new Error("请选择 Provider 并填写模型");
  const codexHomeName = String(raw.codexHomeName || `codex-space-${slug}`).trim();
  if (!NAME_PATTERN.test(codexHomeName)) throw new Error("Codex Home 目录名格式无效");
  const initializeAgents = !piPreset && (raw.initializeAgents === true
    || new Set(["1", "true", "on", "yes"]).has(String(raw.initializeAgents || "").trim().toLowerCase()));
  const reuseExistingHome = !piPreset && (raw.reuseExistingHome === true
    || new Set(["1", "true", "on", "yes"]).has(String(raw.reuseExistingHome || "").trim().toLowerCase()));
  const codexHome = piPreset
    ? path.resolve(options.defaultCodexHome || options.sourceCodexHome)
    : path.resolve(options.codexHomeRoot, codexHomeName);
  const reasoning = normalizeReasoningEffort(raw.reasoning);
  const reasoningPlan = resolveReasoningSelection({ provider: providerId, model, effort: reasoning });
  return {
    engine, piPreset, spaceName, slug, count, baseIndex, namePattern, labelPattern, providerId, model,
    reasoning,
    reasoningPlan,
    brand: String(raw.brand || "feishu").trim().toLowerCase(),
    codexHome,
    initializeAgents,
    reuseExistingHome,
    agentsSource: path.join(options.sourceCodexHome, "AGENTS.md"),
    agentsTarget: path.join(codexHome, "AGENTS.md"),
    ...(piPreset ? {
      configurationSpace: {
        id: "pi-general",
        home: path.resolve(options.piConfigurationSpaceRoot, "pi-general"),
      },
    } : {}),
  };
}

function previewWorkspaceFactory(raw, options) {
  const factory = normalizeFactory(raw, options);
  if (!new Set(["feishu", "lark"]).has(factory.brand)) throw new Error("平台只能是 feishu 或 lark");
  const known = new Set([...(options.existingNames || []), ...readManagedBots(options.dataRoot).map((bot) => bot.name)]);
  const generated = new Set();
  const bots = [];
  for (let offset = 0; offset < factory.count; offset += 1) {
    const index = factory.baseIndex + offset;
    const name = renderPattern(factory.namePattern, index, factory);
    if (!NAME_PATTERN.test(name)) throw new Error(`生成的 Bot 标识格式无效：${name}`);
    if (generated.has(name)) throw new Error(`Bot 标识模板生成了重复值：${name}`);
    generated.add(name);
    const workspace = path.resolve(options.workspaceRoot, `feishu-bridge-${name}`);
    const conflicts = [];
    if (known.has(name)) conflicts.push("Bot 标识已存在");
    if (fs.existsSync(workspace)) conflicts.push("工作空间已存在");
    bots.push({
      engine: factory.engine,
      index,
      name,
      profile: name,
      label: renderPattern(factory.labelPattern, index, factory).slice(0, 100),
      brand: factory.brand,
      workspace,
      codexHome: factory.codexHome,
      codexHomeMode: factory.piPreset ? "shared" : "isolated",
      ...(factory.piPreset ? {
        agentHome: path.resolve(options.piAgentHomeRoot, name),
        sessionDir: path.resolve(options.piAgentHomeRoot, name, "sessions"),
        configurationSpace: factory.configurationSpace,
      } : {}),
      conflicts,
    });
  }
  const configExists = !factory.piPreset && fs.existsSync(path.join(factory.codexHome, "config.toml"));
  const trustedHomes = new Set((options.trustedCodexHomes || []).map((item) => path.resolve(item).toLowerCase()));
  const reusable = factory.reuseExistingHome && configExists
    && trustedHomes.has(path.resolve(factory.codexHome).toLowerCase());
  if (factory.piPreset) {
    // Pi Bots share only the authoritative pi-general capability configuration.
  } else if (factory.reuseExistingHome && !reusable) {
    bots.forEach((bot) => bot.conflicts.push("只能复用已纳入客户端管理且包含 config.toml 的 Codex Home"));
  } else if (configExists && !reusable) {
    bots.forEach((bot) => bot.conflicts.push("空间 Codex Home 已存在"));
  }
  if (factory.initializeAgents && !fs.existsSync(factory.agentsSource) && !reusable) {
    bots.forEach((bot) => bot.conflicts.push("全局 AGENTS.md 不存在"));
  }
  if (factory.initializeAgents && fs.existsSync(factory.agentsTarget) && !reusable) {
    bots.forEach((bot) => bot.conflicts.push("目标 AGENTS.md 已存在"));
  }
  return { factory: { ...factory, reusingExistingHome: reusable }, bots, available: bots.every((bot) => bot.conflicts.length === 0) };
}

function createWorkspaceFactoryQueue(raw, options) {
  const current = readQueue(options.dataRoot);
  if ((current.bots || []).some((bot) => !new Set(["created", "failed"]).has(bot.status))) {
    throw new Error("已有未完成的空间 Bot 创建队列，请先完成当前队列");
  }
  const preview = previewWorkspaceFactory(raw, options);
  if (!preview.available) throw new Error("创建方案存在冲突，请先查看预览");
  const provider = sourceProvider(options.sourceCodexHome, preview.factory.providerId, options.env);
  const configPath = path.join(preview.factory.codexHome, "config.toml");
  const queueFile = queuePath(options.dataRoot);
  const codexHomeExisted = preview.factory.piPreset || fs.existsSync(preview.factory.codexHome);
  const agentsTargetExisted = fs.existsSync(preview.factory.agentsTarget);
  const configExisted = fs.existsSync(configPath);
  try {
    if (!preview.factory.piPreset) fs.mkdirSync(preview.factory.codexHome, { recursive: true });
    if (preview.factory.piPreset) {
      // Pi runtime configuration is created transactionally after each app registration.
    } else if (preview.factory.reusingExistingHome) {
      const existing = TOML.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
      if (!existing.model_providers?.[preview.factory.providerId]) {
        throw new Error(`现有空间未包含所选 Provider：${preview.factory.providerId}`);
      }
    } else {
      atomicWrite(configPath, `${TOML.stringify({
        model: preview.factory.model,
        model_provider: preview.factory.providerId,
        model_reasoning_effort: preview.factory.reasoningPlan.effectiveEffort,
        service_tier: "standard",
        model_providers: { [preview.factory.providerId]: provider.definition },
      }).trim()}\n`);
    }
    if (preview.factory.initializeAgents && !preview.factory.reusingExistingHome) {
      if (!fs.existsSync(preview.factory.agentsSource)) throw new Error("全局 AGENTS.md 不存在，请取消迁移或先创建源文件");
      if (agentsTargetExisted) throw new Error("目标 AGENTS.md 已存在，已拒绝覆盖");
      atomicWrite(preview.factory.agentsTarget, fs.readFileSync(preview.factory.agentsSource, "utf8"));
    }
    const now = new Date().toISOString();
    const state = {
      schemaVersion: 1,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      factory: {
        ...preview.factory,
        providerReference: {
          mode: "global",
          id: preview.factory.providerId,
          name: String(provider.definition.name || preview.factory.providerId),
          baseUrl: String(provider.definition.base_url || ""),
          model: preview.factory.model,
          envKey: provider.envKey,
          wireApi: String(provider.definition.wire_api || "responses"),
          reasoning: preview.factory.reasoning,
          effectiveReasoning: preview.factory.reasoningPlan.effectiveEffort,
          upstreamReasoning: preview.factory.reasoningPlan.upstreamValue,
          reasoningCapability: preview.factory.reasoningPlan.capabilityName,
        },
      },
      sourceProviderConfig: provider.configPath,
      bots: preview.bots.map((bot) => ({ ...bot, conflicts: undefined, status: "pending", error: "", createdBot: null })),
    };
    atomicWrite(queueFile, `${JSON.stringify(state, null, 2)}\n`);
    return state;
  } catch (error) {
    fs.rmSync(queueFile, { force: true });
    if (!preview.factory.piPreset && !configExisted) fs.rmSync(configPath, { force: true });
    if (!preview.factory.piPreset && !agentsTargetExisted) fs.rmSync(preview.factory.agentsTarget, { force: true });
    if (!codexHomeExisted) {
      try { if (fs.readdirSync(preview.factory.codexHome).length === 0) fs.rmdirSync(preview.factory.codexHome); } catch {}
    }
    throw error;
  }
}

async function registerFactoryBot(name, options, onProgress = () => {}) {
  const state = readQueue(options.dataRoot);
  const bot = state.bots?.find((item) => item.name === name);
  if (!bot) throw new Error(`创建队列中找不到 Bot：${name}`);
  const retryingFailedBot = bot.status === "failed" && options.retryFailed === true;
  if (bot.status !== "pending" && !retryingFailedBot) throw new Error(`Bot 当前不能创建：${bot.status}`);
  bot.status = "registering";
  bot.error = "";
  state.updatedAt = new Date().toISOString();
  atomicWrite(queuePath(options.dataRoot), `${JSON.stringify(state, null, 2)}\n`);
  try {
    const created = await options.registerBot({ ...bot, provider: state.factory.providerReference }, options.registrationOptions, (progress) => (
      onProgress({ ...progress, botName: bot.name, botLabel: bot.label })
    ));
    const createdConfig = JSON.parse(fs.readFileSync(created.configPath, "utf8"));
    createdConfig.provider = state.factory.providerReference;
    createdConfig.workspaceFactory = { spaceName: state.factory.spaceName, slug: state.factory.slug };
    atomicWrite(created.configPath, `${JSON.stringify(createdConfig, null, 2)}\n`);
    bot.status = "created";
    bot.createdBot = { name: created.name, label: created.label, configPath: created.configPath };
    state.status = state.bots.every((item) => item.status === "created") ? "complete" : "pending";
    state.updatedAt = new Date().toISOString();
    atomicWrite(queuePath(options.dataRoot), `${JSON.stringify(state, null, 2)}\n`);
    return state;
  } catch (error) {
    bot.status = /取消或超时/.test(error.message) ? "pending" : "failed";
    bot.error = error.message;
    state.status = "pending";
    state.updatedAt = new Date().toISOString();
    atomicWrite(queuePath(options.dataRoot), `${JSON.stringify(state, null, 2)}\n`);
    throw error;
  }
}

module.exports = {
  createWorkspaceFactoryQueue,
  previewWorkspaceFactory,
  readWorkspaceFactoryQueue: readQueue,
  registerFactoryBot,
};
