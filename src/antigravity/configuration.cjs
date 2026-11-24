const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const MODES = new Set(['official', 'gemini-api']);
const EFFORTS = new Set(['', 'low', 'medium', 'high', 'xhigh', 'max']);
const NATIVE_MODES = new Set(['default', 'accept-edits', 'auto', 'plan', 'always-proceed']);
const CURRENT = Object.freeze({ id: 'official', name: '官方 Google 当前账号', mode: 'official', accountId: 'current', model: '', effort: '' });

function catalogPath(dataRoot) { return path.join(dataRoot, 'antigravity-providers.json'); }
function accountCatalogPath(dataRoot) { return path.join(dataRoot, 'antigravity-accounts.json'); }
function defaultsPath(dataRoot) { return path.join(dataRoot, 'antigravity-defaults.json'); }
function readEngineDefaults(dataRoot) {
  if (!dataRoot) return { schemaVersion: 1, provider: '', model: '', modelProvider: '', reasoning: '', updatedAt: '' };
  const raw = readJson(defaultsPath(dataRoot), {});
  return {
    schemaVersion: 1,
    provider: typeof raw?.provider === 'string' ? raw.provider.trim() : '',
    model: typeof raw?.model === 'string' ? raw.model.trim() : '',
    modelProvider: typeof raw?.modelProvider === 'string' ? raw.modelProvider.trim() : '',
    reasoning: typeof raw?.reasoning === 'string' ? raw.reasoning.trim().toLowerCase() : '',
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt.trim() : '',
  };
}
function writeEngineDefaults(dataRoot, patch = {}, { currentBotConfig = '', propagateManagedBots = true } = {}) {
  const nowIso = new Date().toISOString();
  let saved = null;
  if (dataRoot) {
    const prev = readEngineDefaults(dataRoot);
    saved = {
      schemaVersion: 1,
      provider: patch.provider !== undefined ? String(patch.provider || '').trim() : prev.provider,
      model: patch.model !== undefined ? String(patch.model || '').trim() : prev.model,
      modelProvider: patch.model !== undefined
        ? String(patch.modelProvider ?? patch.provider ?? prev.modelProvider ?? '').trim()
        : prev.modelProvider,
      reasoning: patch.reasoning !== undefined ? String(patch.reasoning || '').trim().toLowerCase() : prev.reasoning,
      updatedAt: nowIso,
    };
    atomicJson(defaultsPath(dataRoot), saved);
    if (propagateManagedBots) {
      const managedRoot = path.join(dataRoot, 'managed-bots');
      if (fs.existsSync(managedRoot)) {
        const resolvedCurrent = currentBotConfig ? path.resolve(currentBotConfig).toLowerCase() : '';
        for (const entry of fs.readdirSync(managedRoot, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          const file = path.join(managedRoot, entry.name, 'bot.json');
          if (resolvedCurrent && path.resolve(file).toLowerCase() === resolvedCurrent) continue;
          try {
            const bot = readJson(file, null);
            if (!bot || bot.engine !== 'antigravity') continue;
            const botProviderId = bot.provider?.id || 'official';
            const applyModel = patch.model !== undefined
              && (patch.provider !== undefined || !saved.modelProvider || botProviderId === saved.modelProvider);
            const applyProvider = patch.provider !== undefined;
            const applyReasoning = patch.reasoning !== undefined;
            if (!applyProvider && !applyModel && !applyReasoning) continue;
            const nextProvider = {
              ...(bot.provider || { mode: 'antigravity', id: 'official', name: CURRENT.name, accountId: 'current' }),
              ...(applyProvider ? { id: saved.provider || 'official' } : {}),
              ...(applyModel ? { model: saved.model } : {}),
              ...(applyReasoning ? { reasoning: saved.reasoning } : {}),
            };
            atomicJson(file, { ...bot, provider: nextProvider, configurationChangedAt: nowIso });
          } catch {}
        }
      }
    }
  }
  return saved;
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return structuredClone(fallback); throw error; }
}
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}
function readCatalog(dataRoot) {
  const data = readJson(catalogPath(dataRoot), { schemaVersion: 1, providers: [] });
  if (data.schemaVersion !== 1 || !Array.isArray(data.providers)) throw new Error('Antigravity Provider 配置格式无效');
  return { ...data, providers: [CURRENT, ...data.providers.filter((item) => item.id !== CURRENT.id)] };
}
function normalizeProvider(raw) {
  const id = String(raw.id || '').trim().toLowerCase();
  if (!ID.test(id) || id === 'official') throw new Error('渠道 ID 无效或为保留名称');
  const mode = String(raw.mode || 'gemini-api');
  if (!MODES.has(mode)) throw new Error('仅支持官方账号或 Gemini API 协议');
  const effort = String(raw.effort || '');
  if (!EFFORTS.has(effort)) throw new Error('思考强度无效');
  const model = String(raw.model || '').trim();
  if (/[\r\n\0]/.test(model)) throw new Error('模型名称无效');
  const provider = { id, name: String(raw.name || id).trim().slice(0, 100), mode, model, effort };
  if (mode === 'official') {
    const accountId = String(raw.accountId || 'current');
    if (accountId !== 'current' && !ID.test(accountId)) throw new Error('官方账号标识无效');
    return { ...provider, accountId };
  }
  const url = new URL(String(raw.baseUrl || 'https://generativelanguage.googleapis.com'));
  if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) throw new Error('渠道 URL 不应包含凭据、查询参数或片段');
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('远程渠道必须使用 HTTPS');
  return { ...provider, baseUrl: url.href.replace(/\/+$/, ''),
    wireApi: 'gemini-generate-content', envKey: `CFB_ANTIGRAVITY_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${crypto.createHash('sha256').update(id).digest('hex').slice(0, 8).toUpperCase()}_KEY` };
}
function selectProvider(dataRoot, id) {
  const provider = readCatalog(dataRoot).providers.find((item) => item.id === (id || 'official'));
  if (!provider) throw new Error(`Antigravity 渠道不存在：${id}`);
  return provider;
}
function readAccounts(dataRoot) {
  return readJson(accountCatalogPath(dataRoot), { schemaVersion: 1, activeId: '', accounts: [] });
}
function assertOfficialAccount(dataRoot, provider) {
  if (provider.mode !== 'official' || !provider.accountId || provider.accountId === 'current') return;
  const accounts = readAccounts(dataRoot);
  if (accounts.activeId !== provider.accountId) throw new Error(`请先在客户端切换官方账号到 ${provider.accountId}。Antigravity 使用 Windows 共享登录槽位，Bridge 不会自动轮换账号。`);
}
function prepareNativeProfile(geminiDir, provider = {}, options = {}) {
  const officialAppDataDir = String(options?.officialAppDataDir || 'antigravity-cli').trim() || 'antigravity-cli';
  if (!geminiDir) return officialAppDataDir;
  if (provider.mode !== 'gemini-api') {
    const settings = readJson(path.join(geminiDir, officialAppDataDir, 'settings.json'), {});
    if (settings.modelProvider === 'gemini') throw new Error('官方渠道的原生目录被设置为 Gemini API 模式，请在客户端使用独立渠道目录');
    return officialAppDataDir;
  }
  if (!ID.test(provider.id || '')) throw new Error('Gemini API 渠道 ID 无效');
  // Native authentication mode is selected by settings.json, not by API-key
  // environment variables alone. Separate directories prevent concurrent
  // official/API channels from overwriting each other's native settings.
  const appDataDir = `antigravity-api-${provider.id}`;
  const file = path.join(geminiDir, appDataDir, 'settings.json');
  const settings = readJson(file, {});
  if (settings.modelProvider !== 'gemini') atomicJson(file, { ...settings, modelProvider: 'gemini' });
  return appDataDir;
}
module.exports = { CURRENT, ID, MODES, EFFORTS, NATIVE_MODES, catalogPath, accountCatalogPath, defaultsPath,
  atomicJson, readJson, readCatalog, readEngineDefaults, writeEngineDefaults, normalizeProvider, selectProvider, readAccounts, assertOfficialAccount, prepareNativeProfile };
