import fs from 'node:fs';
import path from 'node:path';
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
  now = Date.now, sharedSessions }) {
  const lists = new Map();
  const pending = new Map();
  const ttl = Number(config.deleteConfirmTtlMs) > 0 ? Number(config.deleteConfirmTtlMs) : 5 * 60_000;
  const keyFor = (event) => JSON.stringify([event.chat_id, event.sender_id || '']);
  const snapshot = (items) => items.map((item, i) => ({ index: i + 1, id: item.id,
    nativeId: item.claudeSessionId || '', title: item.title || '未命名会话', engine: item.engine }));
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
    const chat = getChatState(event.chat_id);
    const allChats = getChats ? getChats() : { [event.chat_id]: chat };
    const selected = new Set(items.map((item) => item.id));
    const activePath = config.stateDir && path.join(config.stateDir, 'active-runs.json');
    const active = activePath && optionalStat(activePath) ? JSON.parse(fs.readFileSync(activePath, 'utf8')) : null;
    const runs = [...activeJobs.values(), ...Object.values(active?.runs || {}).filter(Boolean)];
    return items.map((item) => {
      const current = chat.sessions.find((row) => row.id === item.id);
      if (!current || (current.claudeSessionId || '') !== item.nativeId) throw new Error('会话绑定已变化，请重新 /list 并 /delete 预览');
      if (current.engine && current.engine !== 'claude') throw new Error('所选会话不属于 Claude，已拒绝删除');
      if (runs.some((run) => run.sessionId === item.id || (item.nativeId && run.threadId === item.nativeId))) {
        throw new Error('所选会话正在运行中，请等待任务结束或先 /stop');
      }
      sharedSessions?.assertIdle(current, { ignoreDeleteLease: true });
      if (item.nativeId && !sharedSessions) for (const [chatId, state] of Object.entries(allChats)) {
        if (state.sessions?.some((row) => row.claudeSessionId === item.nativeId
          && (chatId !== event.chat_id || !selected.has(row.id)))) {
          throw new Error('原生会话仍被其他会话绑定，已拒绝删除');
        }
      }
      const home = sharedSessions ? sharedSessions.sessionHome(current) : config.claudeHome;
      return { ...item, home, artifacts: claudeSessionArtifacts(home, item.nativeId) };
    });
  }
  async function handle(event, command, reply) {
    if (!['/delete', '/del', '/rm', '/confirm'].includes(command.name)) return false;
    cleanup();
    const key = keyFor(event);
    let releaseDelete;
    try {
      if (command.name !== '/confirm') {
        pending.delete(key);
        if (!command.rest.trim()) {
          await reply('用法：/delete <序号或ID>，支持 /delete 1 2、/delete 1-3。先 /list 查看会话，删除需要按预览二次确认。'); return true;
        }
        const parsed = selection(command.rest);
        const list = lists.get(key)?.items || snapshot(getChatState(event.chat_id).sessions);
        const items = parsed.indexes ? parsed.indexes.map((index) => list[index - 1])
          : list.filter((item) => item.id === parsed.target || item.nativeId === parsed.target);
        if (!items.length || items.some((item) => !item)) throw new Error('没有找到所选会话，请重新 /list 查看序号或 ID');
        const checked = precheck(event, items);
        const confirmText = compressIndexes(items.map((item) => item.index));
        const expiresAt = now() + ttl;
        pending.set(key, { items, confirmText, expiresAt });
        await reply(['**Claude 会话删除确认**', '',
          sharedSessions
            ? '确认后将从所有 Claude Bot 的共享会话库删除所选会话，并删除其原生聊天记录及会话数据目录。各 Bot 将无法再续接这些会话。工作区文件保留。'
            : '确认后将删除所选 Bridge 会话绑定、当前 Bot Claude Home 中对应的原生聊天记录及其会话数据目录。工作区文件保留。',
          `待删除：${items.length} 条；本地会话记录路径：${new Set(checked.flatMap((item) => item.artifacts)).size} 个`,
          ...items.map((item) => `${item.index}. ${item.title} (${item.id})${item.id === getChatState(event.chat_id).currentSessionId ? ' · 当前会话' : ''}`),
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
      releaseDelete = sharedSessions?.acquireMany(confirmation.items);
      const checked = precheck(event, confirmation.items);
      // No awaits between final precheck, file removal and binding persistence.
      // Other incoming messages cannot start a turn inside this critical section.
      const failures = [];
      const removed = new Set();
      for (const item of checked) {
        try {
          for (const artifact of item.artifacts) {
            checkTree(fs.realpathSync(item.home), artifact);
            fs.rmSync(artifact, { recursive: true, force: true });
          }
          removed.add(item.id);
        } catch (error) { failures.push(`${item.id}：${error.message}`); }
      }
      sharedSessions?.remove([...removed]);
      const chat = getChatState(event.chat_id);
      chat.sessions = chat.sessions.filter((item) => !removed.has(item.id));
      if (!chat.sessions.some((item) => item.id === chat.currentSessionId)) chat.currentSessionId = chat.sessions[0]?.id || '';
      saveSessions();
      pending.delete(key); lists.delete(key);
      releaseDelete?.(); releaseDelete = null;
      await reply([`已删除 ${removed.size} 条 Claude 会话。`,
        chat.sessions.length ? '可用 /list 查看剩余会话。' : '下一次对话将创建新会话。',
        ...failures.map((error) => `未完成删除：${error}`)].join('\n'));
    } catch (error) { await reply(error.message); }
    finally { releaseDelete?.(); }
    return true;
  }
  return { handle, rememberList, close: () => { lists.clear(); pending.clear(); } };
}
