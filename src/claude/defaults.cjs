const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(fallback);
    return structuredClone(fallback);
  }
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

function claudeDataRootFromConfig(config = {}) {
  if (config.claudeDataRoot) return String(config.claudeDataRoot);
  if (config.claudeProviderCatalog) return path.dirname(String(config.claudeProviderCatalog));
  if (config.claudeBotConfig) {
    const botDir = path.dirname(String(config.claudeBotConfig));
    const parent = path.dirname(botDir);
    if (path.basename(parent).toLowerCase() === 'managed-bots') return path.dirname(parent);
    return botDir;
  }
  return '';
}

function claudeDefaultsPath(dataRoot) {
  return path.join(dataRoot, 'claude-defaults.json');
}

function readClaudeEngineDefaults(dataRoot) {
  if (!dataRoot) {
    return { schemaVersion: 1, provider: '', model: '', modelProvider: '', reasoning: '', updatedAt: '' };
  }
  const raw = readJsonSafe(claudeDefaultsPath(dataRoot), {});
  const reasoning = typeof raw?.reasoning === 'string' ? raw.reasoning.trim().toLowerCase() : '';
  return {
    schemaVersion: 1,
    provider: typeof raw?.provider === 'string' ? raw.provider.trim() : '',
    model: typeof raw?.model === 'string' ? raw.model.trim() : '',
    modelProvider: typeof raw?.modelProvider === 'string' ? raw.modelProvider.trim() : '',
    reasoning: EFFORTS.has(reasoning) ? reasoning : '',
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt.trim() : '',
  };
}

function syncClaudeHomeSettings(claudeHome, model, reasoning) {
  if (!claudeHome || !model) return;
  const nativePath = path.join(claudeHome, 'settings.json');
  const native = readJsonSafe(nativePath, {});
  native.model = model;
  native.modelSettings = {
    ...(native.modelSettings && typeof native.modelSettings === 'object' ? native.modelSettings : {}),
    [model]: {
      ...(native.modelSettings?.[model] && typeof native.modelSettings[model] === 'object' ? native.modelSettings[model] : {}),
      effortLevel: reasoning || 'high',
    },
  };
  atomicJson(nativePath, native);
}

function writeClaudeEngineDefaults(
  dataRoot,
  patch = {},
  { currentBotConfig = '', propagateManagedBots = true, providerMeta = null, nowIso = new Date().toISOString() } = {},
) {
  if (!dataRoot) return null;
  const prev = readClaudeEngineDefaults(dataRoot);
  const nextProviderId = patch.provider !== undefined
    ? String(patch.provider || '').trim()
    : (patch.id !== undefined ? String(patch.id || '').trim() : prev.provider);
  const nextModel = patch.model !== undefined ? String(patch.model || '').trim() : prev.model;
  const nextModelProvider = patch.model !== undefined
    ? String(patch.modelProvider ?? patch.provider ?? patch.id ?? prev.modelProvider ?? '').trim()
    : prev.modelProvider;
  const rawReasoning = patch.reasoning !== undefined ? String(patch.reasoning || '').trim().toLowerCase() : prev.reasoning;
  const nextReasoning = EFFORTS.has(rawReasoning) ? rawReasoning : prev.reasoning;
  const saved = {
    schemaVersion: 1,
    provider: nextProviderId,
    model: nextModel,
    modelProvider: nextModelProvider,
    reasoning: nextReasoning,
    updatedAt: nowIso,
  };
  atomicJson(claudeDefaultsPath(dataRoot), saved);

  if (propagateManagedBots) {
    const managedRoot = path.join(dataRoot, 'managed-bots');
    if (fs.existsSync(managedRoot)) {
      const resolvedCurrent = currentBotConfig ? path.resolve(currentBotConfig).toLowerCase() : '';
      const applyProvider = patch.provider !== undefined || patch.id !== undefined;
      for (const entry of fs.readdirSync(managedRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const file = path.join(managedRoot, entry.name, 'bot.json');
        if (resolvedCurrent && path.resolve(file).toLowerCase() === resolvedCurrent) continue;
        try {
          const bot = readJsonSafe(file, null);
          if (!bot || bot.engine !== 'claude') continue;
          const botProviderId = bot.provider?.id || '';
          const applyModel = patch.model !== undefined
            && (applyProvider || !saved.modelProvider || botProviderId === saved.modelProvider);
          const applyReasoning = patch.reasoning !== undefined && Boolean(saved.reasoning);
          if (!applyProvider && !applyModel && !applyReasoning) continue;
          const nextProvider = {
            ...(bot.provider || {}),
            ...(applyProvider && providerMeta ? {
              mode: 'claude',
              id: providerMeta.id,
              name: providerMeta.name,
              baseUrl: providerMeta.baseUrl,
              envKey: providerMeta.envKey,
              wireApi: 'anthropic-messages',
            } : {}),
            ...(applyModel ? { model: saved.model } : {}),
            ...(applyReasoning ? { reasoning: saved.reasoning } : {}),
          };
          atomicJson(file, { ...bot, provider: nextProvider, configurationChangedAt: nowIso });
          if (bot.claudeHome && nextProvider.model) {
            syncClaudeHomeSettings(bot.claudeHome, nextProvider.model, nextProvider.reasoning || 'high');
          }
        } catch {}
      }
    }
  }
  return saved;
}

module.exports = {
  EFFORTS,
  claudeDataRootFromConfig,
  claudeDefaultsPath,
  readClaudeEngineDefaults,
  writeClaudeEngineDefaults,
  syncClaudeHomeSettings,
};
