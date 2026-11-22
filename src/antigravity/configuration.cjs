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
function prepareNativeProfile(geminiDir, provider = {}) {
  if (!geminiDir) return 'antigravity-cli';
  if (provider.mode !== 'gemini-api') {
    const settings = readJson(path.join(geminiDir, 'antigravity-cli', 'settings.json'), {});
    if (settings.modelProvider === 'gemini') throw new Error('官方渠道的原生目录被设置为 Gemini API 模式，请在客户端使用独立渠道目录');
    return 'antigravity-cli';
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
module.exports = { CURRENT, ID, MODES, EFFORTS, NATIVE_MODES, catalogPath, accountCatalogPath,
  atomicJson, readJson, readCatalog, normalizeProvider, selectProvider, readAccounts, assertOfficialAccount, prepareNativeProfile };
