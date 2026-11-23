import fs from 'node:fs';
import path from 'node:path';

const UUID_JSONL_RE = /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/i;

function extractTextSnippet(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        return block.text.trim();
      }
    }
  }
  return '';
}

function summarizeClaudeTranscript(filePath, sessionId) {
  const result = {
    sessionId,
    title: '',
    cwd: '',
    updatedAt: 0,
  };
  let stat;
  try {
    stat = fs.statSync(filePath);
    result.updatedAt = stat.mtimeMs || 0;
  } catch {
    return result;
  }
  const size = stat.size || 0;
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const headLen = Math.min(size, 64 * 1024);
    const headBuf = Buffer.alloc(headLen);
    const headRead = headLen > 0 ? fs.readSync(fd, headBuf, 0, headLen, 0) : 0;
    const headLines = headBuf.toString('utf8', 0, headRead).split(/\r?\n/);

    let tailLines = [];
    if (size > headLen) {
      const tailLen = Math.min(size - headLen, 32 * 1024);
      const tailBuf = Buffer.alloc(tailLen);
      const tailRead = tailLen > 0 ? fs.readSync(fd, tailBuf, 0, tailLen, size - tailLen) : 0;
      tailLines = tailBuf.toString('utf8', 0, tailRead).split(/\r?\n/);
    }

    let firstUserText = '';
    let customTitle = '';
    for (const line of [...headLines, ...tailLines]) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      let parsed;
      try { parsed = JSON.parse(trimmed); } catch { continue; }
      if (!result.cwd && typeof parsed.cwd === 'string' && parsed.cwd.trim()) {
        result.cwd = parsed.cwd.trim();
      }
      if (parsed.type === 'custom-title' && typeof parsed.customTitle === 'string' && parsed.customTitle.trim()) {
        customTitle = parsed.customTitle.trim();
      }
      if (!firstUserText && parsed.type === 'user' && parsed.message?.role === 'user') {
        const snippet = extractTextSnippet(parsed.message.content).replace(/[\r\n]+/g, ' ').trim();
        if (snippet && !snippet.startsWith('<command-')) {
          firstUserText = snippet.slice(0, 80);
        }
      }
    }
    result.title = customTitle || firstUserText || sessionId.slice(0, 8);
  } catch {
    result.title = sessionId.slice(0, 8);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  return result;
}

export function listClaudeNativeSessions({ claudeHome, limit = 100 } = {}) {
  if (!claudeHome) return [];
  const resolvedHome = path.resolve(claudeHome);
  const projectsDir = path.join(resolvedHome, 'projects');
  if (!fs.existsSync(projectsDir)) return [];
  const candidates = [];
  let projectEntries = [];
  try {
    projectEntries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const project of projectEntries) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue;
    const projectPath = path.join(projectsDir, project.name);
    let files = [];
    try {
      files = fs.readdirSync(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile()) continue;
      const match = file.name.match(UUID_JSONL_RE);
      if (!match) continue;
      const fullPath = path.join(projectPath, file.name);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(fullPath).mtimeMs || 0; } catch { continue; }
      candidates.push({ sessionId: match[1], fullPath, mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const capped = candidates.slice(0, Math.max(1, Math.min(300, Number(limit) || 100)));
  return capped.map((item) => ({
    ...summarizeClaudeTranscript(item.fullPath, item.sessionId),
    claudeHome: resolvedHome,
    transcriptPath: item.fullPath,
  }));
}
