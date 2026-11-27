import fs from 'node:fs';
import path from 'node:path';
import { isOwnerDmContext } from '../sessions/access-control.mjs';
import { compressIndexes, parseDeleteSelectionSpec } from '../sessions/delete-selection.mjs';

const NATIVE_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function optionalStat(file) {
  try { return fs.lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function checkTree(root, target) {
  const stat = optionalStat(target);
  if (!stat) return;
  for (let parent = path.dirname(target); parent !== root; parent = path.dirname(parent)) {
    if (!inside(root, parent) || fs.lstatSync(parent).isSymbolicLink()) throw new Error('Claude 会话路径包含链接或超出当前 Claude Home，已拒绝删除');
  }
  if (!inside(root, target) || stat.isSymbolicLink() || !inside(root, fs.realpathSync(target))) {
    throw new Error('Claude 会话路径包含链接或超出当前 Claude Home，已拒绝删除');
  }
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(target)) checkTree(root, path.join(target, name));
  } else if (!stat.isFile()) throw new Error('Claude 会话路径不是普通文件或目录');
}

// Discover only exact UUID artifacts in this Bot's private Home. Never accept a
// transcript path supplied by a message or delete a project/workspace directory.
export function claudeSessionArtifacts(home, nativeId) {
  if (!nativeId) return [];
  if (!NATIVE_ID.test(nativeId)) throw new Error('Claude 原生会话 ID 无效，已拒绝删除');
  const root = fs.realpathSync(home);
  const artifacts = [];
  const projects = path.join(root, 'projects');
  const projectsStat = optionalStat(projects);
  if (projectsStat) {
    if (!projectsStat.isDirectory() || projectsStat.isSymbolicLink()) throw new Error('Claude projects 路径异常');
    for (const project of fs.readdirSync(projects, { withFileTypes: true })) {
      if (!project.isDirectory() || project.isSymbolicLink()) continue;
      for (const name of [`${nativeId}.jsonl`, nativeId]) {
        const target = path.join(projects, project.name, name);
        if (optionalStat(target)) { checkTree(root, target); artifacts.push(target); }
      }
    }
  }
  const environment = path.join(root, 'session-env', nativeId);
  if (optionalStat(environment)) { checkTree(root, environment); artifacts.push(environment); }
  return artifacts;
}

export function createClaudeSessionDeletion({ config, getChatState, getChats, saveSessions, activeJobs,
  now = Date.now, sharedSessions, accessContextFor, collectNativeSessions = null, onBeforeDelete = null }) {
  const lists = new Map();
  const pending = new Map();
  const ttl = Number(config.deleteConfirmTtlMs) > 0 ? Number(config.deleteConfirmTtlMs) : 5 * 60_000;
  const keyFor = (event) => JSON.stringify([event.chat_id, event.sender_id || '']);
  const ctxFor = (event) => (accessContextFor ? accessContextFor(event) : sharedSessions?.accessContextForEvent?.(event));
  const sameRealPath = (a, b) => {
    if (!a || !b) return false;
    try {
      const ra = fs.realpathSync(a);
      const rb = fs.realpathSync(b);
      return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
    } catch {
      return false;
    }
  };
  const snapshot = (items) => items.map((item, i) => {
    if (item?.kind === 'native') {
      const native = item.native || item;
      const nativeId = String(native.sessionId || native.nativeId || '').trim();
      return {
        index: i + 1,
        kind: 'native',
        id: nativeId.slice(0, 8),
        nativeId,
        title: native.title || nativeId.slice(0, 8) || '未命名会话',
        engine: 'claude',
        home: String(native.claudeHome || native.home || '').trim(),
      };
    }
    const session = item?.kind === 'bridge' && item.session ? item.session : item;
    return {
      index: i + 1,
      kind: 'bridge',
      id: session.id,
      nativeId: session.claudeSessionId || '',
      title: session.title || '未命名会话',
      engine: session.engine,
    };
  });
  function cleanup() {
    for (const map of [lists, pending]) for (const [key, item] of map) if (item.expiresAt <= now()) map.delete(key);
  }
  function rememberList(event, items) {
    cleanup(); lists.set(keyFor(event), { items: snapshot(items), expiresAt: now() + ttl });
  }
  function selection(text) {
    // Bound range expansion before calling the shared parser, including confirms
    // whose original indices may no longer exist in the current list.
    for (const token of String(text || '').split(/[\s,，、]+/)) {
      if (/^\d+(?:[-~～]\d+)?$/.test(token) && token.split(/[-~～]/).some((part) => Number(part) > 10_000)) {
        throw new Error('会话序号超出范围');
      }
    }
    const parsed = parseDeleteSelectionSpec(text);
    if (parsed.error) throw new Error(parsed.error === 'empty' ? '请输入会话序号或 ID' : parsed.error);
    return parsed;
  }
  function precheck(event, items) {
    const accessCtx = ctxFor(event);
    const chat = getChatState(event.chat_id, accessCtx);
    const allChats = getChats ? getChats() : { [event.chat_id]: chat };
    const selectedBridgeIds = new Set(items.filter((item) => item.kind !== 'native').map((item) => item.id));
    const activePath = config.stateDir && path.join(config.stateDir, 'active-runs.json');
    const active = activePath && optionalStat(activePath) ? JSON.parse(fs.readFileSync(activePath, 'utf8')) : null;
    const runs = [...activeJobs.values(), ...Object.values(active?.runs || {}).filter(Boolean)];
    return items.map((item) => {
      if (item.kind === 'native') {
        if (!isOwnerDmContext(accessCtx)) {
          throw new Error('仅主用户私聊允许删除本机原生 Claude CLI 会话');
        }
        if (!item.nativeId || !NATIVE_ID.test(item.nativeId)) {
          throw new Error('Claude 原生会话 ID 无效，已拒绝删除');
        }
        if (runs.some((run) => run.threadId === item.nativeId)) {
          throw new Error('所选会话正在运行中，请等待任务结束或先 /stop');
        }
        for (const state of Object.values(allChats)) {
          if (state.sessions?.some((row) => row.claudeSessionId === item.nativeId && !selectedBridgeIds.has(row.id))) {
            throw new Error('原生会话已被其他会话绑定，请重新 /list all 并 /delete 预览');
          }
        }
        const home = item.home || config.claudeDesktopHome || '';
        if (!home || !config.claudeDesktopHome || !sameRealPath(home, config.claudeDesktopHome)) {
          throw new Error('原生 Claude 会话目录无效，已拒绝删除');
        }
        return { ...item, home, artifacts: claudeSessionArtifacts(home, item.nativeId) };
      }
      const current = chat.sessions.find((row) => row.id === item.id);
      if (!current || (current.claudeSessionId || '') !== item.nativeId) throw new Error('会话绑定已变化，请重新 /list 并 /delete 预览');
      if (current.engine && current.engine !== 'claude') throw new Error('所选会话不属于 Claude，已拒绝删除');
      if (runs.some((run) => run.sessionId === item.id || (item.nativeId && run.threadId === item.nativeId))) {
        throw new Error('所选会话正在运行中，请等待任务结束或先 /stop');
      }
      sharedSessions?.assertIdle(current, { ignoreDeleteLease: true });
      if (item.nativeId && !sharedSessions) for (const [chatId, state] of Object.entries(allChats)) {
        if (state.sessions?.some((row) => row.claudeSessionId === item.nativeId
          && (chatId !== event.chat_id || !selectedBridgeIds.has(row.id)))) {
          throw new Error('原生会话仍被其他会话绑定，已拒绝删除');
        }
      }
      const home = sharedSessions ? sharedSessions.sessionHome(current) : config.claudeHome;
      return { ...item, home, artifacts: claudeSessionArtifacts(home, item.nativeId) };
    });
  }
  async function handle(event, command, reply) {
    if (!['/delete', '/del', '/rm', '/confirm'].includes(command.name)) return false;
    if (activeJobs.has(event.chat_id)) {
      await reply('当前聊天有任务正在运行，请先 /stop 或等待结束后再执行 /delete。');
      return true;
    }
    cleanup();
    const key = keyFor(event);
    let releaseDelete;
    try {
      if (command.name !== '/confirm') {
        pending.delete(key);
        if (!command.rest.trim()) {
          await reply('用法：/delete <序号或ID>，支持 /delete 1 2、/delete 1-3。先 /list 或 /list all 查看会话，删除需要按预览二次确认。'); return true;
        }
        const parsed = selection(command.rest);
        const accessCtx = ctxFor(event);
        const visibleChat = getChatState(event.chat_id, accessCtx);
        const visibleIds = new Set(visibleChat.sessions.map((row) => row.id));
        const rawList = lists.get(key)?.items || snapshot(visibleChat.sessions);
        const canAccessNative = isOwnerDmContext(accessCtx);
        const list = rawList.filter((item) => (item.kind === 'native' ? canAccessNative : visibleIds.has(item.id)));
        let items;
        if (parsed.indexes) {
          items = parsed.indexes.map((index) => {
            const entry = rawList[index - 1];
            if (!entry) return undefined;
            if (entry.kind === 'native') return canAccessNative ? entry : undefined;
            return visibleIds.has(entry.id) ? entry : undefined;
          });
        } else {
          items = list.filter((item) => item.id === parsed.target || item.nativeId === parsed.target
            || (item.kind === 'native' && parsed.target.length >= 6 && item.nativeId.startsWith(parsed.target)));
          if (!items.length && canAccessNative && typeof collectNativeSessions === 'function') {
            const nativeList = collectNativeSessions(visibleChat, accessCtx) || [];
            const matchIdx = nativeList.findIndex((item) => item.sessionId === parsed.target
              || (parsed.target.length >= 6 && item.sessionId.startsWith(parsed.target)));
            if (matchIdx >= 0) {
              const matched = nativeList[matchIdx];
              items = [{
                index: visibleChat.sessions.length + matchIdx + 1,
                kind: 'native',
                id: matched.sessionId.slice(0, 8),
                nativeId: matched.sessionId,
                title: matched.title || matched.sessionId.slice(0, 8) || '未命名会话',
                engine: 'claude',
                home: String(matched.claudeHome || config.claudeDesktopHome || '').trim(),
              }];
            }
          }
        }
        if (!items.length || items.some((item) => !item)) throw new Error(`未找到可访问的会话：${command.rest.trim()}，请先发送 /list 或 /list all 查看可用序号。`);
        const checked = precheck(event, items);
        const confirmText = compressIndexes(items.map((item) => item.index));
        const expiresAt = now() + ttl;
        pending.set(key, { items, confirmText, expiresAt });
        const hasNative = items.some((item) => item.kind === 'native');
        const hasBridge = items.some((item) => item.kind !== 'native');
        const desc = hasNative && !hasBridge
          ? '确认后将删除所选本机原生 Claude CLI 对话记录及其会话数据目录（无法恢复）。工作区文件保留。'
          : sharedSessions
            ? (hasNative
              ? '确认后将从所有 Claude Bot 的共享会话库删除所选共享会话，并删除所选共享会话与本机原生 CLI 会话对应的本地聊天记录及会话数据目录。工作区文件保留。'
              : '确认后将从所有 Claude Bot 的共享会话库删除所选会话，并删除其原生聊天记录及会话数据目录。各 Bot 将无法再续接这些会话。工作区文件保留。')
            : '确认后将删除所选 Bridge 会话绑定、对应原生聊天记录及其会话数据目录。工作区文件保留。';
        await reply(['**Claude 会话删除确认**', '',
          desc,
          `待删除：${items.length} 条；本地会话记录路径：${new Set(checked.flatMap((item) => item.artifacts)).size} 个`,
          ...items.map((item) => `${item.index}. ${item.title} (${item.id})${item.kind === 'native' ? ' · 原生 CLI' : (item.id === visibleChat.currentSessionId ? ' · 当前会话' : '')}`),
          '', `确认有效期：${new Date(expiresAt).toLocaleString('zh-CN')}`,
          `确认删除请输入：\`/confirm delete ${confirmText}\``].join('\n'));
        return true;
      }
      const match = command.rest.trim().match(/^delete\s+(.+)$/i);
      if (!match) throw new Error('用法：/confirm delete <预览中的序号或区间>，请先 /delete 预览');
      const parsed = selection(match[1]);
      const confirmation = pending.get(key);
      if (!confirmation || !parsed.indexes || compressIndexes(parsed.indexes) !== confirmation.confirmText) {
        throw new Error('删除确认不存在、已过期或与预览不一致，请重新 /delete 预览');
      }
      const accessCtx = ctxFor(event);
      const bridgeItems = confirmation.items.filter((item) => item.kind !== 'native');
      releaseDelete = bridgeItems.length && sharedSessions
        ? (sharedSessions.acquireManyAsync ? await sharedSessions.acquireManyAsync(bridgeItems) : sharedSessions.acquireMany(bridgeItems))
        : null;
      const checked = precheck(event, confirmation.items);
      if (typeof onBeforeDelete === 'function') {
        await onBeforeDelete({
          sessionIds: bridgeItems.map((item) => item.id),
          nativeIds: checked.map((item) => item.nativeId).filter(Boolean),
        });
      }
      // No awaits between final precheck, file removal and binding persistence.
      // Other incoming messages cannot start a turn inside this critical section.
      const failures = [];
      const removedBridge = new Set();
      let removedNativeCount = 0;
      for (const item of checked) {
        try {
          for (const artifact of item.artifacts) {
            checkTree(fs.realpathSync(item.home), artifact);
            fs.rmSync(artifact, { recursive: true, force: true });
          }
          if (item.kind === 'native') removedNativeCount += 1;
          else removedBridge.add(item.id);
        } catch (error) { failures.push(`${item.id}：${error.message}`); }
      }
      if (removedBridge.size) {
        sharedSessions?.remove([...removedBridge], accessCtx);
        const chat = getChatState(event.chat_id, accessCtx);
        chat.sessions = chat.sessions.filter((item) => !removedBridge.has(item.id));
        if (!chat.sessions.some((item) => item.id === chat.currentSessionId)) chat.currentSessionId = chat.sessions[0]?.id || '';
        saveSessions();
      }
      const chatAfter = getChatState(event.chat_id, accessCtx);
      const totalRemoved = removedBridge.size + removedNativeCount;
      pending.delete(key); lists.delete(key);
      releaseDelete?.(); releaseDelete = null;
      const summarySuffix = removedNativeCount > 0 && removedBridge.size > 0
        ? `（共享会话 ${removedBridge.size} 条，原生 CLI 会话 ${removedNativeCount} 条）`
        : (removedNativeCount > 0 ? '（原生 CLI 会话，本地记录已清理）' : '');
      await reply([`已删除 ${totalRemoved} 条 Claude 会话${summarySuffix}。`,
        chatAfter.sessions.length ? '可用 /list 或 /list all 查看剩余会话。' : '下一次对话将创建新会话。',
        ...failures.map((error) => `未完成删除：${error}`)].join('\n'));
    } catch (error) { await reply(error.message); }
    finally { releaseDelete?.(); }
    return true;
  }
  return { handle, rememberList, close: () => { lists.clear(); pending.clear(); } };
}
