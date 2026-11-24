import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

function parseTimestamp(raw) {
  const text = String(raw || '').trim();
  if (!text) return 0;
  const normalized = text
    .replace(' ', 'T')
    .replace(/(\.\d{3})\d+/, '$1');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : 0;
}

export function decodeWorkspaceUri(rawUris) {
  const text = String(rawUris || '').trim();
  if (!text) return '';
  let candidates = [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) candidates = parsed.map((item) => String(item || '').trim()).filter(Boolean);
    } catch {}
  }
  if (!candidates.length) {
    candidates = text.split(/[\r\n,;]+/).map((item) => item.trim()).filter(Boolean);
  }
  for (const candidate of candidates) {
    if (/^file:\/\//i.test(candidate)) {
      try {
        return fileURLToPath(candidate);
      } catch {}
    }
    if (path.isAbsolute(candidate)) return candidate;
  }
  return '';
}

function isStatusRunning(status) {
  return /^(?:cascade_run_status_)?running$/i.test(String(status || '').trim());
}

function hasConversationStoreFile(baseDir, conversationId) {
  const convDir = path.join(baseDir, 'conversations');
  return fs.existsSync(path.join(convDir, `${conversationId}.db`))
    || fs.existsSync(path.join(convDir, `${conversationId}.pb`));
}

export function listAntigravityNativeConversations({ geminiDir, appDataDir = 'antigravity', limit = 100 } = {}) {
  if (!geminiDir) return [];
  const resolvedDir = path.resolve(geminiDir);
  const baseDir = path.join(resolvedDir, appDataDir);
  const dbPath = path.join(baseDir, 'conversation_summaries.db');
  if (!fs.existsSync(dbPath)) return [];
  const hasConversationsDir = fs.existsSync(path.join(baseDir, 'conversations'));
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 3000;');
    const rows = db.prepare(`
      SELECT conversation_id, title, preview, step_count, last_modified_time,
             workspace_uris, status, not_fully_idle, killed, parent_conversation_id, app_data_dir
      FROM conversation_summaries
      WHERE coalesce(killed, 0) = 0
        AND coalesce(parent_conversation_id, '') = ''
      ORDER BY last_modified_time DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(500, Number(limit) || 100)));
    return rows
      .filter((row) => row && typeof row.conversation_id === 'string' && row.conversation_id.trim())
      .filter((row) => !hasConversationsDir || hasConversationStoreFile(baseDir, row.conversation_id.trim()))
      .map((row) => {
        const status = String(row.status || '').trim();
        const notFullyIdle = Boolean(Number(row.not_fully_idle));
        const running = status ? isStatusRunning(status) : notFullyIdle;
        return {
          conversationId: row.conversation_id.trim(),
          title: String(row.title || '').trim() || String(row.preview || '').trim().slice(0, 80) || row.conversation_id.slice(0, 8),
          cwd: decodeWorkspaceUri(row.workspace_uris),
          updatedAt: parseTimestamp(row.last_modified_time),
          running,
          notFullyIdle,
          stepCount: Number(row.step_count || 0),
          status,
          geminiDir: resolvedDir,
          appDataDir: String(row.app_data_dir || appDataDir).trim() || appDataDir,
        };
      });
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch {}
  }
}

const UUID_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function isInsideRoot(root, target) {
  const rel = path.relative(root, target);
  return Boolean(rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export function getAntigravityConversationState({ geminiDir, appDataDir = 'antigravity', conversationId } = {}) {
  const empty = { exists: false, status: '', running: false, notFullyIdle: false, updatedAt: 0 };
  if (!geminiDir || !conversationId) return empty;
  const dbPath = path.join(path.resolve(geminiDir), appDataDir, 'conversation_summaries.db');
  if (!fs.existsSync(dbPath)) return empty;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000;');
    const row = db.prepare(
      'SELECT status, not_fully_idle, last_modified_time FROM conversation_summaries WHERE conversation_id = ? LIMIT 1',
    ).get(String(conversationId));
    if (!row) return empty;
    const status = String(row.status || '').trim();
    const notFullyIdle = Boolean(Number(row.not_fully_idle));
    // Antigravity writes status=CASCADE_RUN_STATUS_IDLE with not_fully_idle=1 when a turn ends with
    // uncollected background tasks; treating IDLE+not_fully_idle as "busy" permanently deadlocks a
    // conversation after the ACP worker exits. Only an explicit RUNNING status counts as busy.
    const running = status ? isStatusRunning(status) : notFullyIdle;
    return {
      exists: true,
      status,
      running,
      notFullyIdle,
      updatedAt: parseTimestamp(row.last_modified_time),
    };
  } catch {
    return empty;
  } finally {
    try { db?.close(); } catch {}
  }
}

export function isAntigravityConversationBusy({ geminiDir, appDataDir = 'antigravity', conversationId } = {}) {
  return getAntigravityConversationState({ geminiDir, appDataDir, conversationId }).running;
}

export function antigravityNativeArtifacts({ geminiDir, appDataDir = 'antigravity', conversationId } = {}) {
  const id = String(conversationId || '').trim();
  if (!geminiDir || !id || !UUID_RE.test(id)) return [];
  const baseDir = path.join(path.resolve(geminiDir), appDataDir);
  if (!fs.existsSync(baseDir)) return [];
  const root = fs.realpathSync(baseDir);
  const candidates = [
    path.join(root, 'conversations', `${id}.db`),
    path.join(root, 'conversations', `${id}.db-wal`),
    path.join(root, 'conversations', `${id}.db-shm`),
    path.join(root, 'conversations', `${id}.db-journal`),
    path.join(root, 'conversations', `${id}.pb`),
    path.join(root, 'conversations', `${id}.pb.bak`),
    path.join(root, 'annotations', `${id}.pbtxt`),
    path.join(root, 'annotations', `${id}.pb`),
    path.join(root, 'brain', id),
    path.join(root, 'implicit', `${id}.pb`),
    path.join(root, 'implicit', `${id}.db`),
  ];
  const found = [];
  for (const target of candidates) {
    try {
      const st = fs.lstatSync(target);
      if (st.isSymbolicLink() || !isInsideRoot(root, target)) continue;
      found.push(target);
    } catch {}
  }
  return found;
}

export function deleteAntigravityNativeConversation({ geminiDir, appDataDir = 'antigravity', conversationId } = {}) {
  const id = String(conversationId || '').trim();
  if (!geminiDir || !id || !UUID_RE.test(id)) {
    throw new Error(`Antigravity 原生会话 ID 无效，已拒绝删除：${id}`);
  }
  if (isAntigravityConversationBusy({ geminiDir, appDataDir, conversationId: id })) {
    throw new Error(`对话 ${id.slice(0, 8)} 正在 Antigravity 客户端中运行，请等待结束后再删除。`);
  }
  const baseDir = path.join(path.resolve(geminiDir), appDataDir);
  const dbPath = path.join(baseDir, 'conversation_summaries.db');
  const artifacts = antigravityNativeArtifacts({ geminiDir, appDataDir, conversationId: id });
  const removedPaths = [];
  for (const target of artifacts) {
    const isPrimaryStore = target.endsWith(`${path.sep}conversations${path.sep}${id}.db`)
      || target.endsWith(`${path.sep}conversations${path.sep}${id}.pb`);
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      removedPaths.push(target);
    } catch (error) {
      if (isPrimaryStore) {
        throw new Error(`对话 ${id.slice(0, 8)} 的会话文件正被 Antigravity 客户端占用，无法删除（${error?.code || error?.message || error}）`);
      }
    }
  }
  let db;
  if (fs.existsSync(dbPath)) {
    try {
      db = new DatabaseSync(dbPath);
      db.exec('PRAGMA busy_timeout = 3000;');
      const tables = new Set(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name)),
      );
      db.exec('BEGIN IMMEDIATE;');
      if (tables.has('conversation_summaries')) {
        db.prepare('DELETE FROM conversation_summaries WHERE conversation_id = ?').run(id);
      }
      if (tables.has('conversations_fts')) {
        try {
          db.prepare('DELETE FROM conversations_fts WHERE conversation_id = ?').run(id);
        } catch {}
      }
      if (tables.has('conversation_parents')) {
        db.prepare('DELETE FROM conversation_parents WHERE conversation_id = ? OR parent_id = ?').run(id, id);
      }
      db.exec('COMMIT;');
    } catch (error) {
      try { db?.exec('ROLLBACK;'); } catch {}
      throw new Error(`清理 Antigravity 会话索引失败：${error?.message || error}`);
    } finally {
      try { db?.close(); } catch {}
    }
  }
  return { deleted: true, conversationId: id, removedPaths };
}
