const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { normalizeEngine } = require("./agent-engines.cjs");
const { readCatalog: readClaudeCatalog, EFFORTS: CLAUDE_EFFORTS } = require("./claude-providers.cjs");
const { queueClaudeReconfiguration } = require("./claude-reconfiguration.cjs");
const { queueCodexBotReload } = require("./codex-reconfiguration.cjs");

const sourceEngineRoot = process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, "engine", "src", "antigravity", "configuration.cjs"))
  ? path.join(process.resourcesPath, "engine")
  : path.resolve(__dirname, "../../../../..");
const antigravityConfig = require(path.join(sourceEngineRoot, "src", "antigravity", "configuration.cjs"));

const CLAUDE_PERMISSION_MODES = new Set(["bypassPermissions", "manual"]);
const CODEX_EFFORTS = new Set(["", "none", "minimal", "low", "medium", "high", "xhigh", "max"]);

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(temp, filePath);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function readJsonOptional(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function updateManagedBotConfig(input = {}, options = {}) {
  const name = String(input.name || "").trim();
  if (!name) throw new Error("请指定要更新的 Bot 名称");
  const configPath = path.join(options.dataRoot, "managed-bots", name, "bot.json");
  if (!fs.existsSync(configPath)) throw new Error(`找不到受管 Bot：${name}`);

  const originalRaw = fs.readFileSync(configPath, "utf8");
  const current = JSON.parse(originalRaw.replace(/^\uFEFF/, ""));
  const engine = normalizeEngine(current.engine);
  const next = structuredClone(current);

  if (Object.prototype.hasOwnProperty.call(input, "label") && input.label !== undefined) {
    const label = String(input.label || "").trim();
    if (!label) throw new Error("Bot 显示名称不能为空");
    next.label = label.slice(0, 100);
  }

  let claudeSettingsWrite = null;

  if (engine === "antigravity") {
    if (Object.prototype.hasOwnProperty.call(input, "permissionMode") && input.permissionMode !== undefined) {
      const mode = String(input.permissionMode || "").trim();
      if (!antigravityConfig.NATIVE_MODES.has(mode)) {
        throw new Error(`Antigravity 权限模式无效：${mode}`);
      }
      next.antigravity = { ...(next.antigravity || {}), permissionMode: mode };
    }
    const targetProviderId = Object.prototype.hasOwnProperty.call(input, "providerId") && input.providerId !== undefined
      ? String(input.providerId || "").trim() || "official"
      : (next.provider?.id || "official");
    const providerDef = antigravityConfig.selectProvider(options.dataRoot, targetProviderId);
    const targetModel = Object.prototype.hasOwnProperty.call(input, "model") && input.model !== undefined
      ? String(input.model || "").trim()
      : (targetProviderId !== next.provider?.id ? (providerDef.model || "") : (next.provider?.model || ""));
    const targetReasoning = Object.prototype.hasOwnProperty.call(input, "reasoning") && input.reasoning !== undefined
      ? String(input.reasoning || "").trim()
      : (targetProviderId !== next.provider?.id ? (providerDef.effort || "") : (next.provider?.reasoning || ""));
    if (targetReasoning && !antigravityConfig.EFFORTS.has(targetReasoning)) {
      throw new Error(`Antigravity 思考强度无效：${targetReasoning}`);
    }
    next.provider = {
      ...(next.provider || {}),
      mode: "antigravity",
      id: providerDef.id,
      name: providerDef.name,
      model: targetModel,
      reasoning: targetReasoning,
      accountId: providerDef.accountId || "",
    };
  } else if (engine === "claude") {
    if (Object.prototype.hasOwnProperty.call(input, "permissionMode") && input.permissionMode !== undefined) {
      const mode = String(input.permissionMode || "").trim();
      if (!CLAUDE_PERMISSION_MODES.has(mode)) {
        throw new Error(`Claude 权限模式无效：${mode}`);
      }
      next.claude = { ...(next.claude || {}), permissionMode: mode };
    }
    const providerChanged = Object.prototype.hasOwnProperty.call(input, "providerId") && input.providerId !== undefined;
    const modelChanged = Object.prototype.hasOwnProperty.call(input, "model") && input.model !== undefined;
    const reasoningChanged = Object.prototype.hasOwnProperty.call(input, "reasoning") && input.reasoning !== undefined;
    if (providerChanged || modelChanged || reasoningChanged) {
      const targetProviderId = providerChanged
        ? String(input.providerId || "").trim()
        : String(next.provider?.id || "").trim();
      const catalog = readClaudeCatalog(options.dataRoot);
      const providerDef = catalog.providers.find((item) => item.id === targetProviderId);
      if (!providerDef) throw new Error(`找不到 Claude 渠道：${targetProviderId || "(空)"}`);
      const targetModel = modelChanged
        ? String(input.model || "").trim()
        : (providerChanged && targetProviderId !== next.provider?.id ? providerDef.model : (next.provider?.model || providerDef.model));
      if (!targetModel || (Array.isArray(providerDef.models) && providerDef.models.length && !providerDef.models.includes(targetModel))) {
        throw new Error(`模型不在渠道 ${providerDef.id} 列表中：${targetModel}`);
      }
      const targetReasoning = reasoningChanged
        ? String(input.reasoning || "").trim()
        : (providerChanged && targetProviderId !== next.provider?.id ? (providerDef.effort || "high") : (next.provider?.reasoning || providerDef.effort || "high"));
      if (!CLAUDE_EFFORTS.has(targetReasoning)) {
        throw new Error(`Claude 思考强度无效：${targetReasoning}`);
      }
      next.provider = {
        mode: "claude",
        id: providerDef.id,
        name: providerDef.name,
        model: targetModel,
        reasoning: targetReasoning,
        envKey: providerDef.envKey,
        baseUrl: providerDef.baseUrl,
        wireApi: "anthropic-messages",
      };
      if (next.claudeHome) {
        const settingsPath = path.join(next.claudeHome, "settings.json");
        const originalNative = readJsonOptional(settingsPath);
        const updatedNative = structuredClone(originalNative || {});
        updatedNative.model = targetModel;
        updatedNative.modelSettings = {
          ...(updatedNative.modelSettings || {}),
          [targetModel]: {
            ...(updatedNative.modelSettings?.[targetModel] || {}),
            effortLevel: targetReasoning,
          },
        };
        claudeSettingsWrite = { settingsPath, originalNative, updatedNative };
      }
    }
  } else {
    if (Object.prototype.hasOwnProperty.call(input, "reasoning") && input.reasoning !== undefined) {
      const targetReasoning = String(input.reasoning || "").trim();
      if (!CODEX_EFFORTS.has(targetReasoning)) throw new Error(`Codex 推理强度无效：${targetReasoning}`);
      next.provider = { ...(next.provider || {}), reasoning: targetReasoning };
    }
    if (Object.prototype.hasOwnProperty.call(input, "model") && input.model !== undefined) {
      next.provider = { ...(next.provider || {}), model: String(input.model || "").trim() };
    }
  }

  next.configurationChangedAt = new Date().toISOString();

  if (claudeSettingsWrite) {
    atomicWriteJson(claudeSettingsWrite.settingsPath, claudeSettingsWrite.updatedNative);
  }
  try {
    if (typeof options.writeBotConfig === "function") {
      options.writeBotConfig(configPath, next);
    } else {
      atomicWriteJson(configPath, next);
    }
  } catch (error) {
    if (claudeSettingsWrite) {
      if (claudeSettingsWrite.originalNative) atomicWriteJson(claudeSettingsWrite.settingsPath, claudeSettingsWrite.originalNative);
      else fs.rmSync(claudeSettingsWrite.settingsPath, { force: true });
    }
    fs.writeFileSync(configPath, originalRaw, "utf8");
    throw error;
  }

  const bots = typeof options.inspectBots === "function" ? await options.inspectBots() : [];
  const runtimeBot = bots.find((item) => item.name === name);
  if (!runtimeBot || !runtimeBot.online) {
    return { ok: true, bot: { ...next, configPath }, applied: "saved-offline" };
  }
  if (Number(runtimeBot.activeRunCount || 0) > 0) {
    if (engine === "claude" || engine === "antigravity") {
      queueClaudeReconfiguration(options.dataRoot, [name], engine);
    } else {
      queueCodexBotReload(options.dataRoot, [name]);
    }
    return { ok: true, bot: { ...next, configPath }, applied: "queued-idle-reload" };
  }
  if (typeof options.stopBot === "function" && typeof options.startBot === "function") {
    try {
      await options.stopBot(name);
      await options.startBot(name);
      return { ok: true, bot: { ...next, configPath }, applied: "restarted" };
    } catch (error) {
      if (error?.code === "BOT_ACTIVE") {
        if (engine === "claude" || engine === "antigravity") {
          queueClaudeReconfiguration(options.dataRoot, [name], engine);
        } else {
          queueCodexBotReload(options.dataRoot, [name]);
        }
        return { ok: true, bot: { ...next, configPath }, applied: "queued-idle-reload" };
      }
      throw error;
    }
  }
  return { ok: true, bot: { ...next, configPath }, applied: "restarted" };
}

module.exports = {
  CLAUDE_PERMISSION_MODES,
  updateManagedBotConfig,
};
