export function normalizeNativeInputs(value) {
  return (Array.isArray(value) ? value : []).filter(x => x && typeof x.messageId === 'string' && typeof x.text === 'string')
    .map(x => ({ messageId: x.messageId, text: x.text, state: ['submitting', 'submitted'].includes(x.state) ? x.state : 'received',
      turnId: typeof x.turnId === 'string' ? x.turnId : '', at: Number(x.at) || 0,
      attachments: (Array.isArray(x.attachments) ? x.attachments : []).filter(a => a && typeof a.path === 'string') }));
}
export function receiveNativeInput(session, messageId, text, attachments = []) {
  session.pendingNativeInputs ||= [];
  if (!session.pendingNativeInputs.some(x => x.messageId === messageId)) session.pendingNativeInputs.push({ messageId, text, attachments, state: 'received', turnId: '', at: Date.now() });
}
export function nativeInputContext(session, messageId) {
  const pending = (session.pendingNativeInputs || []).filter(x => x.messageId !== messageId && x.state === 'received');
  return {
    text: pending.length ? '此前尚未提交给模型的用户信息（仅补充上下文；不要重放已完成的工具，本轮以最后一条消息为准）：\n' + pending.map(x => x.text).join('\n\n') + '\n\n本轮消息：\n' : '',
    attachments: pending.flatMap(x => x.attachments || []),
    messageIds: pending.map(x => x.messageId),
  };
}
export function markNativeInputSubmitting(session, messageId) {
  const input = session.pendingNativeInputs?.find(x => x.messageId === messageId);
  if (input) input.state = 'submitting';
}
export function acknowledgeNativeInput(session, messageId, includedIds = []) {
  const ids = new Set([messageId, ...includedIds]);
  session.pendingNativeInputs = (session.pendingNativeInputs || []).filter(x => !ids.has(x.messageId));
}
