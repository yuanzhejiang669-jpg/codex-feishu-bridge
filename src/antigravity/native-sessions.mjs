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

export function listAntigravityNativeConversations({ geminiDir, appDataDir = 'antigravity', limit = 100 } = {}) {
  if (!geminiDir) return [];
  const resolvedDir = path.resolve(geminiDir);
  const dbPath = path.join(resolvedDir, appDataDir, 'conversation_summaries.db');
  if (!fs.existsSync(dbPath)) return [];
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
      .map((row) => ({
        conversationId: row.conversation_id.trim(),
        title: String(row.title || '').trim() || String(row.preview || '').trim().slice(0, 80) || row.conversation_id.slice(0, 8),
        cwd: decodeWorkspaceUri(row.workspace_uris),
        updatedAt: parseTimestamp(row.last_modified_time),
        notFullyIdle: Boolean(Number(row.not_fully_idle)),
        stepCount: Number(row.step_count || 0),
        status: String(row.status || '').trim(),
        geminiDir: resolvedDir,
        appDataDir: String(row.app_data_dir || appDataDir).trim() || appDataDir,
      }));
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch {}
  }
}

export function isAntigravityConversationBusy({ geminiDir, appDataDir = 'antigravity', conversationId } = {}) {
  if (!geminiDir || !conversationId) return false;
  const dbPath = path.join(path.resolve(geminiDir), appDataDir, 'conversation_summaries.db');
  if (!fs.existsSync(dbPath)) return false;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000;');
    const row = db.prepare('SELECT not_fully_idle FROM conversation_summaries WHERE conversation_id = ? LIMIT 1').get(String(conversationId));
    return Boolean(row && Number(row.not_fully_idle));
  } catch {
    return false;
  } finally {
    try { db?.close(); } catch {}
  }
}
