import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonFileAtomicSync } from '../utils/json.mjs';
import nativeLock from '../sessions/native-lock.cjs';
import {
  buildAccessContext,
  canAccessSession,
  readOrBindPrimaryOwnerIdentity,
} from '../sessions/access-control.mjs';
const { lockDirectory, lockDirectoryAsync } = nativeLock;

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
  const ownerFile = path.join(root, 'owner.json');
  const instancesRoot = path.dirname(path.dirname(config.stateDir));
  const local = read(sessionsPath, { chats: {} });
  local.chats ||= {};
  const baselines = new WeakMap();
  const chatContexts = new Map();
  const source = { bot: config.larkProfile, home: path.resolve(configuredHome),
    workspace: path.resolve(config.workspace), stateFile: sessionsPath };

  function resolveAccessContext(chatId, accessCtx = null) {
    const id = String(chatId || accessCtx?.chatId || '').trim();
    const configuredOwnerOpenId = config.ownerOpenId ?? process.env.CODEX_FEISHU_OWNER_OPEN_ID ?? '';
    const configuredOwnerUnionId = config.ownerUnionId ?? process.env.CODEX_FEISHU_OWNER_UNION_ID ?? '';
    if (accessCtx && typeof accessCtx === 'object') {
      const eventLike = {
        chat_id: accessCtx.chatId || accessCtx.chat_id || id,
        chat_type: accessCtx.chatType ?? accessCtx.chat_type ?? '',
        sender_id: accessCtx.senderId ?? accessCtx.sender_id ?? '',
        sender_union_id: accessCtx.senderUnionId ?? accessCtx.sender_union_id ?? '',
      };
      const fileBound = accessCtx.primaryOwnerUnionId
        ? { primaryOwnerOpenId: '', primaryOwnerUnionId: '' }
        : readOrBindPrimaryOwnerIdentity({
            ownerFile,
            configuredOwnerOpenId,
            configuredOwnerUnionId,
            event: eventLike,
          });
      const resolved = {
        chatId: eventLike.chat_id,
        chatType: String(eventLike.chat_type || '').trim().toLowerCase(),
        senderId: String(eventLike.sender_id || '').trim(),
        senderUnionId: String(eventLike.sender_union_id || '').trim(),
        scopeType: String(eventLike.chat_type || '').trim().toLowerCase() === 'p2p' ? 'dm' : eventLike.chat_type ? 'group' : '',
        primaryOwnerOpenId: String(accessCtx.primaryOwnerOpenId || fileBound.primaryOwnerOpenId || '').trim(),
        primaryOwnerUnionId: String(accessCtx.primaryOwnerUnionId || fileBound.primaryOwnerUnionId || '').trim(),
      };
      if (id) chatContexts.set(id, resolved);
      return resolved;
    }
    const bound = readOrBindPrimaryOwnerIdentity({
      ownerFile,
      configuredOwnerOpenId,
      configuredOwnerUnionId,
    });
    return {
      chatId: id,
      chatType: '',
      senderId: '',
      senderUnionId: '',
      scopeType: '',
      primaryOwnerOpenId: bound.primaryOwnerOpenId,
      primaryOwnerUnionId: bound.primaryOwnerUnionId,
    };
  }

  function accessContextForEvent(event) {
    return buildAccessContext(event, {
      ownerFile,
      configuredOwnerOpenId: config.ownerOpenId ?? process.env.CODEX_FEISHU_OWNER_OPEN_ID ?? '',
      configuredOwnerUnionId: config.ownerUnionId ?? process.env.CODEX_FEISHU_OWNER_UNION_ID ?? '',
    });
  }

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
  if (isAntigravity && config.antigravityDesktopGeminiDir) {
    allowedHomes.add(homeKey(config.antigravityDesktopGeminiDir));
  }
  if (!isAntigravity && config.claudeDesktopHome) {
    allowedHomes.add(homeKey(config.claudeDesktopHome));
  }
  function readCatalog() {
    const pool = read(catalogFile, { schemaVersion: 2, sessions: {}, deleted: {} });
    if (![1, 2].includes(pool.schemaVersion) || !pool.sessions || Array.isArray(pool.sessions) || !pool.deleted) {
      throw new Error('Claude 共享会话库格式无效，已停止写入');
    }
    pool.schemaVersion = 2;
    return pool;
  }
  function withCatalog(work) {
    const release = lockDirectory(path.join(root, '.catalog.lock'), { bot: config.larkProfile, purpose: 'catalog' }, 2_000);
    try {
      const pool = readCatalog();
      pool.schemaVersion = 2;
      const result = work(pool);
      writeJsonFileAtomicSync(catalogFile, pool);
      return result;
    } finally { release(); }
  }
  async function withCatalogAsync(work) {
    const release = await lockDirectoryAsync(path.join(root, '.catalog.lock'), { bot: config.larkProfile, purpose: 'catalog' }, 2_000);
    try {
      const pool = readCatalog();
      pool.schemaVersion = 2;
      const result = await work(pool);
      writeJsonFileAtomicSync(catalogFile, pool);
      return result;
    } finally { release(); }
  }
  function normalized(session, origin = source, scope = null) {
    const base = { ...normalizeSessionData(session) };
    const rawScopeType = String(base.scopeType || session?.scopeType || '').trim();
    const scopeType = rawScopeType || (scope?.chatType ? (scope.chatType === 'p2p' ? 'dm' : 'group') : 'dm');
    const ownerOpenId = String(base.ownerOpenId || session?.ownerOpenId || scope?.senderId || '').trim();
    const ownerUnionId = String(base.ownerUnionId || session?.ownerUnionId || scope?.senderUnionId || '').trim();
    const originChatId = String(base.originChatId || session?.originChatId || scope?.chatId || '').trim();
    return { ...base, engine,
      scopeType,
      ownerOpenId,
      ownerUnionId,
      originChatId,
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
  function hasVerifiedCallerScope(accessCtx) {
    return Boolean(accessCtx && accessCtx.chatType && (accessCtx.senderId || accessCtx.senderUnionId));
  }

  function refresh(chat, pool, accessCtx = null) {
    const existing = new Map((chat.sessions || []).map((s) => [s.id, s]));
    const visible = Object.values(pool.sessions)
      .filter((remote) => (accessCtx ? canAccessSession(remote, accessCtx) : true))
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0) || a.id.localeCompare(b.id));
    chat.sessions = visible.map((remote) => {
      const item = existing.get(remote.id) || {};
      const baseline = baselines.get(item);
      const dirty = baseline ? changes(baseline, item) : {};
      const value = normalized(remote);
      attach(item, { ...clone(value), ...dirty });
      baselines.set(item, clone(value));
      return item;
    });
    if (!chat.sessions.some((s) => s.id === chat.currentSessionId)) {
      const keepUnverifiedCrossBotSelection = Boolean(
        accessCtx
        && !hasVerifiedCallerScope(accessCtx)
        && chat.currentSessionId
        && pool.sessions[chat.currentSessionId]
        && !pool.deleted?.[chat.currentSessionId],
      );
      if (!keepUnverifiedCrossBotSelection) {
        chat.currentSessionId = chat.sessions[0]?.id || '';
      }
    }
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
  for (const [chatId, chat] of Object.entries(local.chats)) {
    refresh(chat, readCatalog(), resolveAccessContext(chatId));
  }

  function applyLocalSessionsToCatalog(current) {
    for (const chat of Object.values(local.chats)) for (const item of chat.sessions || []) {
      if (current.deleted[item.id]) continue;
      const baseline = baselines.get(item);
      const value = normalized(item);
      if (!current.sessions[item.id]) current.sessions[item.id] = value;
      else if (baseline) {
        const delta = changes(baseline, value);
        const allowInitialHomeBind = !current.sessions[item.id][nativeField]
          && delta[homeField]
          && allowedHomes.has(homeKey(delta[homeField]));
        // Ownership and access-control scope are fixed at creation; selecting a session never migrates them.
        for (const key of ['id', 'scopeType', 'ownerOpenId', 'ownerUnionId', 'originChatId', workspaceField, originField]) delete delta[key];
        if (!allowInitialHomeBind) delete delta[homeField];
        Object.assign(current.sessions[item.id], delta);
      }
    }
    return current;
  }
  function saveSessions() {
    const pool = withCatalog(applyLocalSessionsToCatalog);
    for (const [chatId, chat] of Object.entries(local.chats)) {
      refresh(chat, pool, chatContexts.get(chatId) || resolveAccessContext(chatId));
    }
    writeJsonFileAtomicSync(sessionsPath, local);
  }
  async function saveSessionsAsync() {
    const pool = await withCatalogAsync(applyLocalSessionsToCatalog);
    for (const [chatId, chat] of Object.entries(local.chats)) {
      refresh(chat, pool, chatContexts.get(chatId) || resolveAccessContext(chatId));
    }
    writeJsonFileAtomicSync(sessionsPath, local);
  }
  function getChatState(chatId, accessCtx = null) {
    const chat = local.chats[chatId] ||= { currentSessionId: '', sessions: [] };
    const ctx = resolveAccessContext(chatId, accessCtx);
    return refresh(chat, readCatalog(), ctx);
  }
  function getSession(chatId, accessCtx = null) {
    const ctx = resolveAccessContext(chatId, accessCtx);
    const chat = getChatState(chatId, ctx);
    let current = chat.sessions.find((s) => s.id === chat.currentSessionId);
    if (!current) {
      current = normalized(createSessionData('默认会话'), source, ctx);
      chat.sessions.unshift(current); chat.currentSessionId = current.id; saveSessions();
    }
    return current;
  }
  function resetSession(chatId, title = '新会话', accessCtx = null) {
    const ctx = resolveAccessContext(chatId, accessCtx);
    const chat = getChatState(chatId, ctx);
    const current = normalized(createSessionData(title || '新会话'), source, ctx);
    chat.sessions.unshift(current); chat.currentSessionId = current.id; saveSessions();
    return current;
  }
  function sessionHome(session) {
    const home = path.resolve(session[homeField] || configuredHome);
    if (!allowedHomes.has(homeKey(home))) for (const origin of sources()) allowedHomes.add(homeKey(origin.home));
    if (isAntigravity && config.antigravityDesktopGeminiDir) allowedHomes.add(homeKey(config.antigravityDesktopGeminiDir));
    if (!isAntigravity && config.claudeDesktopHome) allowedHomes.add(homeKey(config.claudeDesktopHome));
    if (!allowedHomes.has(homeKey(home))) throw new Error(`共享会话的原生 Home 不属于已配置 ${label} Bot`);
    return home;
  }
  function bindNativeSession(chatId, seed = {}, accessCtx = null) {
    const ctx = resolveAccessContext(chatId, accessCtx);
    const chat = getChatState(chatId, ctx);
    const nativeId = String(seed[nativeField] || '').trim();
    const targetHome = path.resolve(seed[homeField] || configuredHome);
    if (targetHome && !allowedHomes.has(homeKey(targetHome))) {
      throw new Error(`目标原生会话 Home 未受信任：${targetHome}`);
    }
    if (nativeId) {
      const existing = chat.sessions.find((item) => item[nativeField] === nativeId);
      if (existing) {
        chat.currentSessionId = existing.id;
        saveSessions();
        return existing;
      }
    }
    const base = createSessionData(seed.title || `原生 ${label} 会话`);
    const merged = normalized({
      ...base,
      ...seed,
      id: base.id,
      [homeField]: targetHome,
      [workspaceField]: path.resolve(seed[workspaceField] || config.workspace),
      [originField]: seed[originField] || source.bot,
    }, source, ctx);
    chat.sessions.unshift(merged);
    chat.currentSessionId = merged.id;
    saveSessions();
    return chat.sessions.find((item) => item.id === merged.id) || merged;
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
  async function acquireAsync(session, purpose = 'run') {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(session.id)) throw new Error('共享会话 ID 无效');
    assertIdle(session);
    const release = await lockDirectoryAsync(path.join(root, 'leases', session.id), { bot: config.larkProfile, purpose }, 0);
    try {
      const current = readCatalog().sessions[session.id];
      if (!current || current[nativeField] !== session[nativeField]) throw new Error('共享会话已变化，请重新 /list 并选择会话');
      return release;
    } catch (error) { release(); throw error; }
  }
  async function acquireManyAsync(items) {
    const releases = [];
    try {
      for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
        const current = readCatalog().sessions[item.id];
        if (!current) throw new Error('共享会话已删除，请重新 /list');
        releases.push(await acquireAsync(current, 'delete'));
      }
      return () => { for (const release of releases.reverse()) release(); };
    } catch (error) { for (const release of releases.reverse()) release(); throw error; }
  }
  function remove(ids, accessCtx = null) {
    const ctx = resolveAccessContext(accessCtx?.chatId || accessCtx?.chat_id || '', accessCtx);
    withCatalog((pool) => {
      for (const id of ids) {
        const existing = pool.sessions[id];
        if (existing && !canAccessSession(existing, ctx)) {
          throw new Error('无权删除不属于当前作用域的会话');
        }
      }
      for (const id of ids) { delete pool.sessions[id]; pool.deleted[id] = Date.now(); }
    });
  }
  async function removeAsync(ids, accessCtx = null) {
    const ctx = resolveAccessContext(accessCtx?.chatId || accessCtx?.chat_id || '', accessCtx);
    await withCatalogAsync((pool) => {
      for (const id of ids) {
        const existing = pool.sessions[id];
        if (existing && !canAccessSession(existing, ctx)) {
          throw new Error('无权删除不属于当前作用域的会话');
        }
      }
      for (const id of ids) { delete pool.sessions[id]; pool.deleted[id] = Date.now(); }
    });
  }
  return {
    sessions: local, getChatState, getSession, resetSession, saveSessions, saveSessionsAsync,
    shared: {
      catalogFile, ownerFile, accessContextForEvent, sessionHome, bindNativeSession,
      withCatalog, withCatalogAsync, saveSessionsAsync,
      acquire, acquireAsync, acquireMany, acquireManyAsync,
      assertIdle, busy, remove, removeAsync,
    },
  };
}
