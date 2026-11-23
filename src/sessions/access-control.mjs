import fs from 'node:fs';
import path from 'node:path';

export const OWNER_OPEN_ID_PATTERN = /^ou_[A-Za-z0-9]+$/;

export function extractScopeFromEvent(event) {
  const chatId = String(
    event?.chat_id
      || event?.chatId
      || event?.event?.message?.chat_id
      || '',
  ).trim();
  const chatType = String(
    event?.chat_type
      || event?.chatType
      || event?.event?.message?.chat_type
      || '',
  ).trim().toLowerCase();
  const senderId = String(
    event?.sender_id
      || event?.senderId
      || event?.event?.sender?.sender_id?.open_id
      || '',
  ).trim();
  const scopeType = chatType === 'p2p' ? 'dm' : chatType ? 'group' : '';
  return { chatId, chatType, senderId, scopeType };
}

export function readPrimaryOwnerFile(ownerFile) {
  if (!ownerFile) return '';
  try {
    const parsed = JSON.parse(fs.readFileSync(ownerFile, 'utf8').replace(/^\uFEFF/, ''));
    const candidate = String(parsed?.primaryOwnerOpenId || '').trim();
    return OWNER_OPEN_ID_PATTERN.test(candidate) ? candidate : '';
  } catch {
    return '';
  }
}

export function readOrBindPrimaryOwner({
  ownerFile = '',
  configuredOwnerOpenId = '',
  event = null,
  log = () => {},
} = {}) {
  const configured = String(configuredOwnerOpenId || '').trim();
  if (configured) return configured;

  const existing = readPrimaryOwnerFile(ownerFile);
  if (existing) return existing;

  if (!ownerFile || !event) return '';
  const scope = extractScopeFromEvent(event);
  if (scope.chatType !== 'p2p' || !OWNER_OPEN_ID_PATTERN.test(scope.senderId)) return '';

  try {
    fs.mkdirSync(path.dirname(ownerFile), { recursive: true });
    const payload = {
      schemaVersion: 1,
      primaryOwnerOpenId: scope.senderId,
      boundAt: new Date().toISOString(),
    };
    fs.writeFileSync(ownerFile, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    log('INFO', 'bound primary owner open_id from first DM', {
      ownerFile,
      primaryOwnerOpenId: scope.senderId,
    });
    return scope.senderId;
  } catch (error) {
    if (error?.code === 'EEXIST') {
      return readPrimaryOwnerFile(ownerFile);
    }
    log('WARN', 'failed to bind primary owner open_id', {
      ownerFile,
      error: String(error?.message || error),
    });
    return '';
  }
}

export function buildAccessContext(event, options = {}) {
  const scope = extractScopeFromEvent(event);
  const configuredOwnerOpenId = String(
    options.configuredOwnerOpenId
      ?? options.config?.ownerOpenId
      ?? process.env.CODEX_FEISHU_OWNER_OPEN_ID
      ?? '',
  ).trim();
  const primaryOwnerOpenId = readOrBindPrimaryOwner({
    ownerFile: options.ownerFile || '',
    configuredOwnerOpenId,
    event,
    log: options.log,
  });
  return {
    chatId: scope.chatId,
    chatType: scope.chatType,
    senderId: scope.senderId,
    scopeType: scope.scopeType,
    primaryOwnerOpenId,
  };
}

export function canAccessSession(session, ctx) {
  if (!session || !ctx || !ctx.chatId) return false;
  const scopeType = session.scopeType || 'dm';
  const originChatId = String(session.originChatId || '');
  const ownerOpenId = String(session.ownerOpenId || '');

  // Fail-closed: if chatType or senderId is missing, only allow exact originChatId match.
  if (!ctx.chatType || !ctx.senderId) {
    return Boolean(originChatId) && originChatId === ctx.chatId;
  }

  // Group chat (non-p2p): strictly isolated to this group's own sessions.
  if (ctx.chatType !== 'p2p') {
    return scopeType === 'group' && originChatId === ctx.chatId;
  }

  // DM (p2p): only allow dm sessions owned by this sender.
  if (scopeType !== 'dm') return false;
  if (ownerOpenId) return ownerOpenId === ctx.senderId;

  // Legacy v1 sessions with empty ownerOpenId: only visible to bound primaryOwnerOpenId in DM.
  return Boolean(ctx.primaryOwnerOpenId) && ctx.senderId === ctx.primaryOwnerOpenId;
}

export function isOwnerDmContext(ctx) {
  if (!ctx || ctx.chatType !== 'p2p' || !ctx.senderId) return false;
  return Boolean(ctx.primaryOwnerOpenId) && ctx.senderId === ctx.primaryOwnerOpenId;
}
