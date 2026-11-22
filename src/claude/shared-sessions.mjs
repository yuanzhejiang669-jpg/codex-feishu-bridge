import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonFileAtomicSync } from '../utils/json.mjs';
import nativeLock from '../sessions/native-lock.cjs';
const { lockDirectory } = nativeLock;

const clone = (value) => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const homeKey = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
function read(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

// Catalog writes and per-session execution have separate locks. Only a dead
// process's lock may be recovered; a quiet but live agent is never interrupted.

export function createSharedClaudeSessionStore({ config, sessionsPath, createSessionData,
  normalizeSessionData = (s) => ({ ...s }), sources: configuredSources }) {
  const isAntigravity = config.engine === 'antigravity';
  const engine = isAntigravity ? 'antigravity' : 'claude';
  const label = isAntigravity ? 'Antigravity' : 'Claude';
  const homeField = isAntigravity ? 'antigravityHome' : 'claudeSessionHome';
  const workspaceField = isAntigravity ? 'antigravityWorkspace' : 'claudeWorkspace';
  const originField = isAntigravity ? 'antigravityOriginBot' : 'claudeOriginBot';
  const nativeField = isAntigravity ? 'antigravitySessionId' : 'claudeSessionId';
  const configuredHome = isAntigravity ? config.antigravityHome : config.claudeHome;
  const root = path.resolve(isAntigravity ? config.antigravitySharedSessionsRoot : config.claudeSharedSessionsRoot);
  if (root === path.parse(root).root) throw new Error('Claude 共享会话库不能是磁盘根目录');
  const catalogFile = path.join(root, 'sessions.json');
  const instancesRoot = path.dirname(path.dirname(config.stateDir));
  const local = read(sessionsPath, { chats: {} });
  local.chats ||= {};
  const baselines = new WeakMap();
  const source = { bot: config.larkProfile, home: path.resolve(configuredHome),
    workspace: path.resolve(config.workspace), stateFile: sessionsPath };

  function sources() {
    if (configuredSources) return [source, ...configuredSources];
    const values = [source];
    const managed = path.join(path.dirname(root), 'managed-bots');
    if (!fs.existsSync(managed)) return values;
    for (const dir of fs.readdirSync(managed, { withFileTypes: true })) {
      if (!dir.isDirectory() || dir.isSymbolicLink()) continue;
      const bot = read(path.join(managed, dir.name, 'bot.json'), null);
      if (bot?.engine !== engine || !(isAntigravity ? bot.antigravityHome : bot.claudeHome) || !bot.workspace) continue;
      values.push({ bot: bot.name, home: path.resolve(isAntigravity ? bot.antigravityHome : bot.claudeHome), workspace: path.resolve(bot.workspace),
        stateFile: path.join(instancesRoot, bot.name, 'state', 'sessions.json') });
    }
    return values;
  }
  const knownSources = sources();
  const allowedHomes = new Set(knownSources.map((s) => homeKey(s.home)));
  function readCatalog() {
    const pool = read(catalogFile, { schemaVersion: 1, sessions: {}, deleted: {} });
    if (pool.schemaVersion !== 1 || !pool.sessions || Array.isArray(pool.sessions) || !pool.deleted) throw new Error('Claude 共享会话库格式无效，已停止写入');
    return pool;
  }
  function withCatalog(work) {
    const release = lockDirectory(path.join(root, '.catalog.lock'), { bot: config.larkProfile, purpose: 'catalog' }, 2_000);
    try {
      const pool = readCatalog();
      const result = work(pool);
      writeJsonFileAtomicSync(catalogFile, pool);
      return result;
    } finally { release(); }
  }
  function normalized(session, origin = source) {
    return { ...normalizeSessionData(session), engine,
      [homeField]: session[homeField] || origin.home,
      [workspaceField]: session[workspaceField] || origin.workspace,
      [originField]: session[originField] || origin.bot };
  }
  function nativeKey(s) { return s[nativeField] ? `${homeKey(s[homeField])}\0${s[nativeField]}` : ''; }
  function attach(target, value) {
    for (const key of Object.keys(target)) if (!(key in value)) delete target[key];
    Object.assign(target, value);
    return target;
  }
  function changes(before, after) {
    const delta = {};
    for (const [key, value] of Object.entries(after)) if (!same(before?.[key], value)) delta[key] = value;
    return delta;
  }
  function refresh(chat, pool) {
    const existing = new Map((chat.sessions || []).map((s) => [s.id, s]));
    chat.sessions = Object.values(pool.sessions).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0) || a.id.localeCompare(b.id)).map((remote) => {
      const item = existing.get(remote.id) || {};
      const baseline = baselines.get(item);
      const dirty = baseline ? changes(baseline, item) : {};
      const value = normalized(remote);
      attach(item, { ...clone(value), ...dirty });
      baselines.set(item, clone(value));
      return item;
    });
    if (!chat.sessions.some((s) => s.id === chat.currentSessionId)) chat.currentSessionId = chat.sessions[0]?.id || '';
    return chat;
  }

  // Import bindings only. Native JSONL records and all workspace files stay put.
  withCatalog((pool) => {
    for (const origin of knownSources) {
      const state = read(origin.stateFile, { chats: {} });
      for (const chat of Object.values(state.chats || {})) for (const original of chat.sessions || (chat.id ? [chat] : [])) {
        if (original.engine && original.engine !== engine) continue;
        const item = normalized(original, origin);
        if (pool.deleted[item.id] || (item[homeField] && !allowedHomes.has(homeKey(item[homeField])))) continue;
        const key = nativeKey(item);
        const match = key && Object.values(pool.sessions).find((s) => nativeKey(s) === key);
        if (match || (pool.sessions[item.id] && homeKey(pool.sessions[item.id][homeField]) === homeKey(item[homeField]))) continue;
        if (pool.sessions[item.id]) item.id = crypto.createHash('sha256').update(`${item[homeField]}\0${item.id}`).digest('hex').slice(0, 12);
        pool.sessions[item.id] = item;
      }
    }
  });
  for (const chat of Object.values(local.chats)) refresh(chat, readCatalog());

  function saveSessions() {
    const pool = withCatalog((current) => {
      for (const chat of Object.values(local.chats)) for (const item of chat.sessions || []) {
        if (current.deleted[item.id]) continue;
        const baseline = baselines.get(item);
        const value = normalized(item);
        if (!current.sessions[item.id]) current.sessions[item.id] = value;
        else if (baseline) {
          const delta = changes(baseline, value);
          // Ownership is fixed at creation; selecting a session never migrates it.
          for (const key of ['id', homeField, workspaceField, originField]) delete delta[key];
          Object.assign(current.sessions[item.id], delta);
        }
      }
      return current;
    });
    for (const chat of Object.values(local.chats)) refresh(chat, pool);
    writeJsonFileAtomicSync(sessionsPath, local);
  }
  function getChatState(chatId) {
    const chat = local.chats[chatId] ||= { currentSessionId: '', sessions: [] };
    return refresh(chat, readCatalog());
  }
  function getSession(chatId) {
    const chat = getChatState(chatId);
    let current = chat.sessions.find((s) => s.id === chat.currentSessionId);
    if (!current) {
      current = normalized(createSessionData('默认会话'));
      chat.sessions.unshift(current); chat.currentSessionId = current.id; saveSessions();
    }
    return current;
  }
  function resetSession(chatId, title = '新会话') {
    const chat = getChatState(chatId);
    const current = normalized(createSessionData(title || '新会话'));
    chat.sessions.unshift(current); chat.currentSessionId = current.id; saveSessions();
    return current;
  }
  function sessionHome(session) {
    const home = path.resolve(session[homeField] || configuredHome);
    if (!allowedHomes.has(homeKey(home))) for (const origin of sources()) allowedHomes.add(homeKey(origin.home));
    if (!allowedHomes.has(homeKey(home))) throw new Error(`共享会话的原生 Home 不属于已配置 ${label} Bot`);
    return home;
  }
  function busy(session, { ignoreDeleteLease = false } = {}) {
    const directory = path.join(root, 'leases', session.id);
    const lease = read(path.join(directory, 'owner.json'), null);
    if (lease && alive(lease.pid) && !(ignoreDeleteLease && lease.pid === process.pid && lease.purpose === 'delete')) return lease;
    // During idle rollout an old Bridge can still be running without a lease.
    if (fs.existsSync(instancesRoot)) for (const entry of fs.readdirSync(instancesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const state = path.join(instancesRoot, entry.name, 'state');
      if (path.resolve(state) === path.resolve(config.stateDir)) continue;
      const bridge = read(path.join(state, 'bridge.lock.json'), null);
      if (!bridge || !alive(bridge.pid)) continue;
      const runs = read(path.join(state, 'active-runs.json'), { runs: {} });
      if (Object.values(runs.runs || {}).some((r) => r && (r.sessionId === session.id || (session[nativeField] && r.threadId === session[nativeField])))) return { bot: entry.name, pid: bridge.pid, purpose: 'run' };
    }
    return null;
  }
  function assertIdle(session, options) {
    const owner = busy(session, options);
    if (owner) throw new Error(`该共享会话正在 ${owner.bot || '其他 Bot'} 中运行，请等待任务结束或在该 Bot 中 /stop。`);
  }
  function acquire(session, purpose = 'run') {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(session.id)) throw new Error('共享会话 ID 无效');
    assertIdle(session);
    const release = lockDirectory(path.join(root, 'leases', session.id), { bot: config.larkProfile, purpose });
    try {
      const current = readCatalog().sessions[session.id];
      if (!current || current[nativeField] !== session[nativeField]) throw new Error('共享会话已变化，请重新 /list 并选择会话');
      return release;
    } catch (error) { release(); throw error; }
  }
  function acquireMany(items) {
    const releases = [];
    try {
      for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
        const current = readCatalog().sessions[item.id];
        if (!current) throw new Error('共享会话已删除，请重新 /list');
        releases.push(acquire(current, 'delete'));
      }
      return () => { for (const release of releases.reverse()) release(); };
    } catch (error) { for (const release of releases.reverse()) release(); throw error; }
  }
  function remove(ids) {
    withCatalog((pool) => {
      for (const id of ids) { delete pool.sessions[id]; pool.deleted[id] = Date.now(); }
    });
  }
  return { sessions: local, getChatState, getSession, resetSession, saveSessions,
    shared: { catalogFile, sessionHome, acquire, acquireMany, assertIdle, busy, remove } };
}
