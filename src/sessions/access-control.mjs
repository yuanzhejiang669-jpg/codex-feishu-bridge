import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const OWNER_OPEN_ID_PATTERN = /^ou_[A-Za-z0-9]+$/;
export const OWNER_UNION_ID_PATTERN = /^on_[A-Za-z0-9]+$/;
export const OWNER_ID_PATTERN = /^(?:ou|on)_[A-Za-z0-9]+$/;

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
  const rawUnionId = String(
    event?.sender_union_id
      || event?.senderUnionId
      || event?.event?.sender?.sender_id?.union_id
      || event?.sender?.sender_id?.union_id
      || '',
  ).trim();
  const senderUnionId = OWNER_UNION_ID_PATTERN.test(rawUnionId) ? rawUnionId : '';
  const scopeType = chatType === 'p2p' ? 'dm' : chatType ? 'group' : '';
  return { chatId, chatType, senderId, senderUnionId, scopeType };
}

export function readPrimaryOwnerRecord(ownerFile) {
  if (!ownerFile) return { primaryOwnerOpenId: '', primaryOwnerUnionId: '', boundAt: '' };
  try {
    const parsed = JSON.parse(fs.readFileSync(ownerFile, 'utf8').replace(/^\uFEFF/, ''));
    const openCandidate = String(parsed?.primaryOwnerOpenId || '').trim();
    const unionCandidate = String(parsed?.primaryOwnerUnionId || '').trim();
    return {
      primaryOwnerOpenId: OWNER_OPEN_ID_PATTERN.test(openCandidate) ? openCandidate : '',
      primaryOwnerUnionId: OWNER_UNION_ID_PATTERN.test(unionCandidate) ? unionCandidate : '',
      boundAt: String(parsed?.boundAt || '').trim(),
    };
  } catch {
    return { primaryOwnerOpenId: '', primaryOwnerUnionId: '', boundAt: '' };
  }
}

export function readPrimaryOwnerFile(ownerFile) {
  const record = readPrimaryOwnerRecord(ownerFile);
  return record.primaryOwnerOpenId || record.primaryOwnerUnionId || '';
}

export function upgradePrimaryOwnerUnionId(ownerFile, {
  primaryOwnerOpenId = '',
  primaryOwnerUnionId = '',
  log = () => {},
} = {}) {
  const unionId = String(primaryOwnerUnionId || '').trim();
  if (!ownerFile || !OWNER_UNION_ID_PATTERN.test(unionId)) return false;
  const existing = readPrimaryOwnerRecord(ownerFile);
  if (existing.primaryOwnerUnionId) return existing.primaryOwnerUnionId === unionId;
  const expectedOpenId = String(primaryOwnerOpenId || '').trim();
  if (expectedOpenId && existing.primaryOwnerOpenId && existing.primaryOwnerOpenId !== expectedOpenId) {
    return false;
  }
  const openId = existing.primaryOwnerOpenId || (OWNER_OPEN_ID_PATTERN.test(expectedOpenId) ? expectedOpenId : '');
  const now = new Date().toISOString();
  const payload = {
    schemaVersion: 2,
    ...(openId ? { primaryOwnerOpenId: openId } : {}),
    primaryOwnerUnionId: unionId,
    boundAt: existing.boundAt || now,
    updatedAt: now,
  };
  try {
    fs.mkdirSync(path.dirname(ownerFile), { recursive: true });
    if (!existing.primaryOwnerOpenId && !existing.primaryOwnerUnionId) {
      fs.writeFileSync(ownerFile, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
    } else {
      const tmp = `${ownerFile}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        });
        fs.renameSync(tmp, ownerFile);
      } catch (error) {
        try { fs.rmSync(tmp, { force: true }); } catch {}
        throw error;
      }
    }
    log('INFO', 'upgraded primary owner record with union_id', {
      ownerFile,
      primaryOwnerOpenId: openId,
      primaryOwnerUnionId: unionId,
    });
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') {
      return readPrimaryOwnerRecord(ownerFile).primaryOwnerUnionId === unionId;
    }
    log('WARN', 'failed to upgrade primary owner union_id', {
      ownerFile,
      error: String(error?.message || error),
    });
    return false;
  }
}

export function readOrBindPrimaryOwnerIdentity({
  ownerFile = '',
  configuredOwnerOpenId = '',
  configuredOwnerUnionId = '',
  event = null,
  log = () => {},
} = {}) {
  const configured = String(configuredOwnerOpenId || '').trim();
  const configuredUnion = String(configuredOwnerUnionId || '').trim();
  if (OWNER_UNION_ID_PATTERN.test(configured)) {
    return { primaryOwnerOpenId: '', primaryOwnerUnionId: configured };
  }
  if (configured) {
    return {
      primaryOwnerOpenId: configured,
      primaryOwnerUnionId: OWNER_UNION_ID_PATTERN.test(configuredUnion) ? configuredUnion : '',
    };
  }
  if (OWNER_UNION_ID_PATTERN.test(configuredUnion)) {
    return { primaryOwnerOpenId: '', primaryOwnerUnionId: configuredUnion };
  }

  const existing = readPrimaryOwnerRecord(ownerFile);
  const scope = event ? extractScopeFromEvent(event) : null;
  if (existing.primaryOwnerUnionId) {
    return {
      primaryOwnerOpenId: existing.primaryOwnerOpenId,
      primaryOwnerUnionId: existing.primaryOwnerUnionId,
    };
  }
  if (existing.primaryOwnerOpenId) {
    // Auto-upgrade legacy owner.json when the originally bound owner sends a DM with resolved union_id.
    if (
      ownerFile
      && scope
      && scope.chatType === 'p2p'
      && scope.senderId === existing.primaryOwnerOpenId
      && OWNER_UNION_ID_PATTERN.test(scope.senderUnionId)
    ) {
      if (upgradePrimaryOwnerUnionId(ownerFile, {
        primaryOwnerOpenId: existing.primaryOwnerOpenId,
        primaryOwnerUnionId: scope.senderUnionId,
        log,
      })) {
        return {
          primaryOwnerOpenId: existing.primaryOwnerOpenId,
          primaryOwnerUnionId: scope.senderUnionId,
        };
      }
    }
    return {
      primaryOwnerOpenId: existing.primaryOwnerOpenId,
      primaryOwnerUnionId: '',
    };
  }

  if (!ownerFile || !scope) return { primaryOwnerOpenId: '', primaryOwnerUnionId: '' };
  const validOpenId = OWNER_OPEN_ID_PATTERN.test(scope.senderId) ? scope.senderId : '';
  const validUnionId = OWNER_UNION_ID_PATTERN.test(scope.senderUnionId) ? scope.senderUnionId : '';
  if (scope.chatType !== 'p2p' || (!validOpenId && !validUnionId)) {
    return { primaryOwnerOpenId: '', primaryOwnerUnionId: '' };
  }

  try {
    fs.mkdirSync(path.dirname(ownerFile), { recursive: true });
    const payload = {
      schemaVersion: validUnionId ? 2 : 1,
      ...(validOpenId ? { primaryOwnerOpenId: validOpenId } : {}),
      ...(validUnionId ? { primaryOwnerUnionId: validUnionId } : {}),
      boundAt: new Date().toISOString(),
    };
    fs.writeFileSync(ownerFile, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    log('INFO', 'bound primary owner identity from first DM', {
      ownerFile,
      primaryOwnerOpenId: validOpenId,
      primaryOwnerUnionId: validUnionId,
    });
    return { primaryOwnerOpenId: validOpenId, primaryOwnerUnionId: validUnionId };
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const raced = readPrimaryOwnerRecord(ownerFile);
      return {
        primaryOwnerOpenId: raced.primaryOwnerOpenId,
        primaryOwnerUnionId: raced.primaryOwnerUnionId,
      };
    }
    log('WARN', 'failed to bind primary owner identity', {
      ownerFile,
      error: String(error?.message || error),
    });
    return { primaryOwnerOpenId: '', primaryOwnerUnionId: '' };
  }
}

export function readOrBindPrimaryOwner(options = {}) {
  const identity = readOrBindPrimaryOwnerIdentity(options);
  return identity.primaryOwnerOpenId || identity.primaryOwnerUnionId || '';
}

export function buildAccessContext(event, options = {}) {
  const scope = extractScopeFromEvent(event);
  const configuredOwnerOpenId = String(
    options.configuredOwnerOpenId
      ?? options.config?.ownerOpenId
      ?? process.env.CODEX_FEISHU_OWNER_OPEN_ID
      ?? '',
  ).trim();
  const configuredOwnerUnionId = String(
    options.configuredOwnerUnionId
      ?? options.config?.ownerUnionId
      ?? process.env.CODEX_FEISHU_OWNER_UNION_ID
      ?? '',
  ).trim();
  const { primaryOwnerOpenId, primaryOwnerUnionId } = readOrBindPrimaryOwnerIdentity({
    ownerFile: options.ownerFile || '',
    configuredOwnerOpenId,
    configuredOwnerUnionId,
    event,
    log: options.log,
  });
  return {
    chatId: scope.chatId,
    chatType: scope.chatType,
    senderId: scope.senderId,
    senderUnionId: scope.senderUnionId,
    scopeType: scope.scopeType,
    primaryOwnerOpenId,
    primaryOwnerUnionId,
  };
}

export function isOwnerDmContext(ctx) {
  if (!ctx || ctx.chatType !== 'p2p') return false;
  if (!ctx.senderId && !ctx.senderUnionId) return false;
  if (ctx.primaryOwnerUnionId && ctx.senderUnionId) {
    return ctx.senderUnionId === ctx.primaryOwnerUnionId;
  }
  if (ctx.primaryOwnerOpenId && ctx.senderId) {
    return ctx.senderId === ctx.primaryOwnerOpenId;
  }
  return false;
}

export function canAccessSession(session, ctx) {
  if (!session || !ctx || !ctx.chatId) return false;
  const scopeType = session.scopeType || 'dm';
  const originChatId = String(session.originChatId || '');
  const ownerOpenId = String(session.ownerOpenId || '');
  const ownerUnionId = String(session.ownerUnionId || '');

  // Fail-closed: if chatType or sender identity is missing, only allow exact originChatId match.
  if (!ctx.chatType || (!ctx.senderId && !ctx.senderUnionId)) {
    return Boolean(originChatId) && originChatId === ctx.chatId;
  }

  // Group chat (non-p2p): strictly isolated to this group's own sessions.
  if (ctx.chatType !== 'p2p') {
    return scopeType === 'group' && originChatId === ctx.chatId;
  }

  // DM (p2p): only allow dm sessions owned by this sender.
  if (scopeType !== 'dm') return false;

  // Cross-Bot union_id match when both session and caller carry a verified union_id.
  if (ownerUnionId && ctx.senderUnionId) {
    return ownerUnionId === ctx.senderUnionId;
  }

  // Pre-union_id / legacy DM sessions belonging to the bound primary owner remain accessible across Bots.
  if (isOwnerDmContext(ctx) && !ownerUnionId) {
    if (!ownerOpenId) return true;
    if (ctx.primaryOwnerOpenId && ownerOpenId === ctx.primaryOwnerOpenId) return true;
  }

  // Single-Bot fallback when union_id is unavailable on either side.
  if (ownerOpenId && ctx.senderId && (!ownerUnionId || !ctx.senderUnionId)) {
    return ownerOpenId === ctx.senderId;
  }

  // Legacy v1 sessions with empty ownerOpenId & ownerUnionId: only visible to bound primary owner in DM.
  if (!ownerOpenId && !ownerUnionId) {
    return isOwnerDmContext(ctx);
  }

  return false;
}
