import crypto from 'node:crypto';

const clean = value => typeof value === 'string' ? value : '';
export function normalizeThreadContinuity(session) {
  const transition = session?.codexThreadTransition;
  return {
    codexThreadProvider: clean(session?.codexThreadProvider),
    codexThreadLineage: (Array.isArray(session?.codexThreadLineage) ? session.codexThreadLineage : [])
      .filter(x => x && typeof x.threadId === 'string')
      .map(x => ({ threadId: x.threadId, provider: clean(x.provider), fromThreadId: clean(x.fromThreadId), at: Number(x.at) || 0 })),
    codexThreadTransition: transition && transition.sourceThreadId && transition.targetProvider ? {
      id: clean(transition.id), sourceThreadId: clean(transition.sourceThreadId), sourceProvider: clean(transition.sourceProvider),
      targetProvider: clean(transition.targetProvider), targetKey: clean(transition.targetKey), candidateThreadId: clean(transition.candidateThreadId),
      sourceRevision: clean(transition.sourceRevision),
      phase: ['preparing', 'prepared', 'uncertain'].includes(transition.phase) ? transition.phase : 'uncertain', at: Number(transition.at) || 0,
    } : null,
  };
}

function uncertain(message) {
  return Object.assign(new Error(message), { code: 'PROVIDER_HANDOFF_UNCERTAIN' });
}

// This prepares a binding, without changing session settings/current thread.
// The persisted transition lets an interrupted client reuse a known candidate.
export async function prepareThreadContinuation({ client, session, params, save, targetKey = params.modelProvider, timeoutMs = 60000, isBusy = () => false }) {
  const provider = params.modelProvider || 'openai';
  const source = session.codexThreadId;
  if (!source) {
    const started = await client.request('thread/start', params, timeoutMs);
    return { threadId: started.thread.id, provider: started.modelProvider || provider, lineage: session.codexThreadLineage || [] };
  }
  let sourceProvider = session.codexThreadProvider;
  if (!sourceProvider) {
    const read = await client.request('thread/read', { threadId: source, includeTurns: false }, timeoutMs);
    sourceProvider = read.thread.modelProvider;
    if (!sourceProvider) throw new Error('原生会话没有返回 Provider，已保留原绑定');
  }
  if (sourceProvider === provider) {
    const resumed = await client.request('thread/resume', { ...params, threadId: source, excludeTurns: true }, timeoutMs);
    if (resumed.modelProvider && resumed.modelProvider !== provider) throw new Error('恢复结果的 Provider 与目标不一致');
    return { threadId: resumed.thread.id, provider, lineage: session.codexThreadLineage || [], transition: session.codexThreadTransition };
  }
  if (isBusy(source)) throw new Error('原生会话仍有活动任务，已拒绝切换 Provider');
  let pending = session.codexThreadTransition;
  const latest = await client.request('thread/turns/list', { threadId: source, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' }, timeoutMs);
  const sourceRevision = `${latest.data?.[0]?.id || 'empty'}:${session.lastCompactedAt || 0}`;
  if (pending?.phase === 'prepared' && pending.sourceRevision !== sourceRevision) {
    session.codexThreadLineage = [...(session.codexThreadLineage || []), {
      threadId: pending.candidateThreadId, provider: pending.targetProvider, fromThreadId: pending.sourceThreadId, at: pending.at,
    }];
    pending = null;
  }
  if (pending && (pending.sourceThreadId !== source || pending.targetKey !== targetKey)) {
    if (pending.phase !== 'prepared') throw uncertain('另一项接续请求的结果尚未确定，已保留原绑定');
    // Retain a prepared but abandoned candidate in lineage so /list does not
    // rediscover it as a new user session. No native record is deleted.
    session.codexThreadLineage = [...(session.codexThreadLineage || []), {
      threadId: pending.candidateThreadId, provider: pending.targetProvider, fromThreadId: pending.sourceThreadId, at: pending.at,
    }];
    pending = null;
  }
  if (pending && !pending.candidateThreadId) {
    // Do not blindly retry a fork after timeout/crash. Read every candidate's
    // metadata because native thread/list does not always populate forkedFromId.
    const listed = await client.request('thread/list', { modelProviders: [provider], cwd: params.cwd, limit: 100 }, timeoutMs);
    const candidates = [];
    for (const item of listed.data || []) {
      const created = Number(item.createdAt) * (Number(item.createdAt) < 1e12 ? 1000 : 1);
      if (created && created + 2000 < pending.at) continue;
      const read = await client.request('thread/read', { threadId: item.id, includeTurns: false }, timeoutMs);
      if (read.thread.forkedFromId === source && read.thread.modelProvider === provider) candidates.push(item.id);
    }
    if (candidates.length !== 1) throw uncertain('无法唯一核实此前接续请求的结果；原会话未更换，不会重复创建分支');
    pending.candidateThreadId = candidates[0]; pending.phase = 'prepared'; session.codexThreadTransition = pending; save();
  }
  if (!pending) {
    pending = { id: crypto.randomUUID(), sourceThreadId: source, sourceProvider, sourceRevision, targetProvider: provider,
      targetKey, candidateThreadId: '', phase: 'preparing', at: Date.now() };
    session.codexThreadTransition = pending;
    save(); // Never send the fork if the journal could not be persisted.
    try {
      const { threadId: ignored, serviceName: ignoredName, ...overrides } = params;
      const result = await client.request('thread/fork', { ...overrides, threadId: source, excludeTurns: true, deferGoalContinuation: true }, timeoutMs);
      if (!result.thread?.id) throw uncertain('接续未返回新 thread ID');
      pending.candidateThreadId = result.thread.id;
      if ((result.modelProvider || result.thread.modelProvider) !== provider) throw uncertain('接续返回的 Provider 与目标不一致');
      pending.phase = 'prepared'; session.codexThreadTransition = pending; save();
    } catch (error) {
      if (typeof error.code === 'number' && !pending.candidateThreadId) session.codexThreadTransition = null;
      else { if (pending.phase !== 'prepared') pending.phase = 'uncertain'; session.codexThreadTransition = pending; }
      save();
      throw error;
    }
  }
  if (pending.phase !== 'prepared') throw uncertain('接续候选状态尚未核实，原绑定已保留');
  const resumed = await client.request('thread/resume', { ...params, threadId: pending.candidateThreadId, excludeTurns: true }, timeoutMs);
  if ((resumed.modelProvider || resumed.thread.modelProvider) !== provider) throw uncertain('候选会话没有使用目标 Provider');
  const lineage = [...(session.codexThreadLineage || [])];
  for (const binding of [
    { threadId: source, provider: sourceProvider, fromThreadId: '', at: pending.at },
    { threadId: pending.candidateThreadId, provider, fromThreadId: source, at: pending.at },
  ]) if (!lineage.some(x => x.threadId === binding.threadId)) lineage.push(binding);
  return { threadId: resumed.thread.id, provider, lineage };
}

export function commitThreadBinding(session, binding, save) {
  const previous = { ...normalizeThreadContinuity(session), codexThreadId: session.codexThreadId, updatedAt: session.updatedAt };
  Object.assign(session, { codexThreadId: binding.threadId, codexThreadProvider: binding.provider,
    codexThreadLineage: binding.lineage, codexThreadTransition: binding.transition || null, updatedAt: Date.now() });
  try { save(); } catch (error) { Object.assign(session, previous); throw error; }
  return binding.threadId;
}

export function collapseContinuationEntries(entries, bindings) {
  const owners = new Map();
  for (const session of bindings.filter(Boolean)) {
    const pending = session.codexThreadTransition?.candidateThreadId;
    const internal = [...(session.codexThreadLineage || []), ...(pending ? [{ threadId: pending }] : [])];
    for (const native of internal) if (native.threadId && native.threadId !== session.codexThreadId) {
      if (!owners.has(native.threadId)) owners.set(native.threadId, new Set());
      owners.get(native.threadId).add(session.id);
    }
  }
  return entries.filter(entry => !owners.has(entry.codexThreadId)
    || entry._codexOnly === false && entry.id && !owners.get(entry.codexThreadId).has(entry.id));
}
