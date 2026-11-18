const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function catalogPath(dataRoot) { return path.join(dataRoot, 'claude-providers.json'); }

function readCatalog(dataRoot) {
  try {
    const data = JSON.parse(fs.readFileSync(catalogPath(dataRoot), 'utf8'));
    if (data.schemaVersion !== 1 || !Array.isArray(data.providers)) throw new Error('配置格式无效');
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, providers: [] };
    throw new Error(`Claude Provider 配置无法读取：${error.message}`);
  }
}

function writeCatalog(dataRoot, value) {
  fs.mkdirSync(dataRoot, { recursive: true });
  const target = catalogPath(dataRoot);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, target);
}

function normalizeClaudeProvider(raw = {}) {
  const id = String(raw.id || '').trim();
  if (!ID.test(id)) throw new Error('Claude Provider 标识只能包含小写字母、数字、下划线和短横线');
  const url = new URL(String(raw.baseUrl || '').trim());
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Claude Provider 地址必须是不含凭据或查询参数的 HTTP(S) 地址');
  }
  const baseUrl = url.toString().replace(/\/+$/, '').replace(/\/v1$/, '');
  const auth = String(raw.auth || 'bearer');
  if (!['bearer', 'x-api-key'].includes(auth)) throw new Error('Claude 鉴权方式无效');
  const effort = String(raw.effort || 'high');
  if (!EFFORTS.has(effort)) throw new Error('Claude 思考强度无效');
  const model = String(raw.model || '').trim();
  if (!model || /[\r\n\0]/.test(model)) throw new Error('Claude 默认模型不能为空');
  return { id, name: String(raw.name || id).trim().slice(0, 120), baseUrl, auth, model, effort,
    envKey: `CLAUDE_PROVIDER_${crypto.createHash('sha256').update(id).digest('hex').slice(0, 24).toUpperCase()}_API_KEY`,
    models: Array.isArray(raw.models) ? raw.models.filter((m) => typeof m === 'string') : [] };
}

function inspectClaudeProviders(dataRoot, env = process.env) {
  try {
    return { configPath: catalogPath(dataRoot), providers: readCatalog(dataRoot).providers.map((provider) => ({
      ...provider, engine: 'claude', wireApi: 'anthropic-messages', credentialAvailable: Boolean(env[provider.envKey]),
    })), error: '' };
  } catch (error) { return { configPath: catalogPath(dataRoot), providers: [], error: error.message }; }
}

function resolveClaudeProvider(dataRoot, id, env = process.env) {
  const provider = readCatalog(dataRoot).providers.find((item) => item.id === id);
  if (!provider) throw new Error(`Claude Provider 不存在：${id}`);
  const apiKey = String(env[provider.envKey] || '');
  if (!apiKey) throw new Error(`Claude Provider ${id} 的 API Key 不可用`);
  return { ...provider, apiKey };
}

async function request(provider, apiKey, endpoint, body, options = {}) {
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error('Claude API Key 不能为空或含换行');
  const headers = { 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
  headers[provider.auth === 'x-api-key' ? 'x-api-key' : 'authorization'] = provider.auth === 'x-api-key' ? apiKey : `Bearer ${apiKey}`;
  let response;
  try {
    response = await (options.fetchImpl || fetch)(`${provider.baseUrl}/v1/${endpoint}`, {
      method: body ? 'POST' : 'GET', headers, redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs || 30_000),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 1200)}`);
    return JSON.parse(text);
  } catch (error) {
    throw new Error(String(error.message || error).replaceAll(apiKey, '[redacted]').slice(0, 1500));
  }
}

async function listClaudeModels(raw, options) {
  const provider = normalizeClaudeProvider(raw);
  const apiKey = String(raw.apiKey || options.env?.[provider.envKey] || process.env[provider.envKey] || '');
  const body = await request(provider, apiKey, 'models', null, options);
  const models = (Array.isArray(body.data) ? body.data : []).map((item) => String(item.id || '')).filter(Boolean);
  return { provider: provider.id, models: [...new Set(models)] };
}

async function probeClaudeProvider(raw, options) {
  const provider = normalizeClaudeProvider(raw);
  const apiKey = String(raw.apiKey || options.env?.[provider.envKey] || process.env[provider.envKey] || '');
  const startedAt = Date.now();
  const body = await request(provider, apiKey, 'messages', {
    model: provider.model, max_tokens: 128, messages: [{ role: 'user', content: 'Reply with OK only.' }],
  }, options);
  if (body.type !== 'message' || body.role !== 'assistant' || !Array.isArray(body.content)
      || !body.content.some((item) => item.type === 'text' && item.text)) throw new Error('Claude 测试没有收到有效的模型回复');
  return { ok: true, provider: provider.id, model: body.model || provider.model,
    elapsedMs: Date.now() - startedAt, responseId: String(body.id || ''), scope: 'text' };
}

const mutations = new Map();
function saveClaudeProvider(raw, options) {
  const key = path.resolve(options.dataRoot);
  const previous = mutations.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => saveClaudeProviderOnce(raw, options));
  mutations.set(key, pending);
  const clear = () => { if (mutations.get(key) === pending) mutations.delete(key); };
  pending.then(clear, clear);
  return pending;
}

async function saveClaudeProviderOnce(raw, options) {
  const provider = normalizeClaudeProvider(raw);
  const catalog = readCatalog(options.dataRoot);
  const previous = catalog.providers.find((item) => item.id === provider.id);
  if (previous && previous.envKey !== provider.envKey) throw new Error('Provider 凭据引用不一致');
  const apiKey = String(raw.apiKey || await options.readCredential(provider.envKey) || '');
  const discovery = await listClaudeModels({ ...provider, apiKey }, options);
  if (!discovery.models.includes(provider.model)) throw new Error('默认模型不在该密钥的模型列表中');
  const oldKey = await options.readCredential(provider.envKey);
  await options.setCredential(provider.envKey, apiKey);
  provider.models = discovery.models;
  provider.updatedAt = new Date().toISOString();
  try {
    catalog.providers = [...catalog.providers.filter((item) => item.id !== provider.id), provider];
    writeCatalog(options.dataRoot, catalog);
  } catch (error) {
    await options.setCredential(provider.envKey, oldKey || null);
    throw error;
  }
  return { provider: { ...provider, credentialAvailable: true }, keyChanged: oldKey !== apiKey };
}

async function replaceClaudeProviderKey(raw, options) {
  const provider = readCatalog(options.dataRoot).providers.find((item) => item.id === raw.id);
  if (!provider) throw new Error('Claude Provider 不存在');
  if (!raw.apiKey) throw new Error('新 API Key 不能为空');
  return saveClaudeProvider({ ...provider, apiKey: raw.apiKey }, options);
}

module.exports = { EFFORTS, catalogPath, inspectClaudeProviders, listClaudeModels, normalizeClaudeProvider,
  probeClaudeProvider, readCatalog, replaceClaudeProviderKey, resolveClaudeProvider, saveClaudeProvider, writeCatalog };
