export function createPendingAttachmentStore({
  maxPendingAttachments = 12,
  pendingTtlMs = 30 * 60_000,
} = {}) {
  const pendingAttachmentsByChat = new Map();

  function attachmentIdentity(item) {
    return [
      String(item?.type || ""),
      String(item?.messageId || ""),
      String(item?.fileKey || ""),
      String(item?.path || ""),
    ].join("\u0000");
  }

  function add(chatId, attachments) {
    if (!chatId || !attachments.length) return;
    cleanup(chatId);
    const current = pendingAttachmentsByChat.get(chatId) || [];
    const byIdentity = new Map();
    for (const item of [...current, ...attachments]) {
      byIdentity.set(attachmentIdentity(item), item);
    }
    const next = [...byIdentity.values()].slice(-maxPendingAttachments);
    pendingAttachmentsByChat.set(chatId, next);
  }

  function cleanup(chatId) {
    const current = pendingAttachmentsByChat.get(chatId);
    if (!current?.length) return [];
    const cutoff = Date.now() - pendingTtlMs;
    const next = current.filter((item) => Number(item.receivedAt || 0) >= cutoff);
    if (next.length) pendingAttachmentsByChat.set(chatId, next);
    else pendingAttachmentsByChat.delete(chatId);
    return next;
  }

  function take(chatId) {
    const current = cleanup(chatId);
    pendingAttachmentsByChat.delete(chatId);
    return current;
  }

  function dropForMessage(messageId, chatId = "") {
    const target = String(messageId || "").trim();
    if (!target) return 0;
    let removed = 0;
    for (const [key, items] of pendingAttachmentsByChat) {
      if (chatId && key !== chatId) continue;
      const next = (items || []).filter((item) => {
        const keep = String(item?.messageId || "") !== target;
        if (!keep) removed += 1;
        return keep;
      });
      if (next.length) pendingAttachmentsByChat.set(key, next);
      else pendingAttachmentsByChat.delete(key);
    }
    return removed;
  }

  return {
    add,
    cleanup,
    dropForMessage,
    pendingAttachmentsByChat,
    take,
  };
}
