export function createRecalledMessageStore({ ttlMs = 24 * 60 * 60_000 } = {}) {
  const recalledMessages = new Map();

  function cleanup() {
    if (!hasDuration(ttlMs)) return;
    const cutoff = Date.now() - ttlMs;
    for (const [messageId, record] of recalledMessages) {
      if (Number(record?.at || 0) < cutoff) recalledMessages.delete(messageId);
    }
  }

  function remember(messageId, record = {}) {
    const id = String(messageId || "").trim();
    if (!id) return false;
    cleanup();
    recalledMessages.set(id, {
      messageId: id,
      chatId: String(record.chatId || ""),
      eventId: String(record.eventId || ""),
      at: Number(record.at || 0) || Date.now(),
      reason: String(record.reason || "recall"),
    });
    return true;
  }

  function has(messageId) {
    cleanup();
    return recalledMessages.has(String(messageId || "").trim());
  }

  return {
    cleanup,
    has,
    recalledMessages,
    remember,
  };
}

function hasDuration(ms) {
  return Number.isFinite(ms) && ms > 0;
}
