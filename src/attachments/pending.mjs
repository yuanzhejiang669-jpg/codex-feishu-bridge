export function createPendingAttachmentStore({
  maxPendingAttachments = 12,
  pendingTtlMs = 30 * 60_000,
} = {}) {
  const pendingAttachmentsByChat = new Map();
  const chatLocks = new Map();

  function attachmentIdentity(item) {
    return [
      String(item?.type || ""),
      String(item?.messageId || ""),
      String(item?.fileKey || ""),
      String(item?.path || ""),
    ].join("\u0000");
  }

  function withAttachmentLock(chatId, fn) {
    const key = String(chatId || "__global__");
    const previous = chatLocks.get(key) || Promise.resolve();
    const result = previous.catch(() => {}).then(() => fn());
    const tail = result.finally(() => {
      if (chatLocks.get(key) === tail) chatLocks.delete(key);
    });
    chatLocks.set(key, tail);
    return result;
  }

  function add(chatId, attachments) {
    if (!chatId || !Array.isArray(attachments) || !attachments.length) return;
    cleanup(chatId);
    const current = pendingAttachmentsByChat.get(chatId) || [];
    const byIdentity = new Map();
    for (const item of [...current, ...attachments]) {
      byIdentity.set(attachmentIdentity(item), item);
    }
    const next = [...byIdentity.values()]
      .sort((a, b) => Number(a?.receivedAt || 0) - Number(b?.receivedAt || 0))
      .slice(-maxPendingAttachments);
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

  function restore(chatId, attachments) {
    add(chatId, attachments);
  }

  function dropItemsForMessage(messageId, chatId = "") {
    const target = String(messageId || "").trim();
    if (!target) return [];
    const dropped = [];
    for (const [key, items] of pendingAttachmentsByChat) {
      if (chatId && key !== chatId) continue;
      const next = [];
      for (const item of items || []) {
        if (String(item?.messageId || "") === target) dropped.push(item);
        else next.push(item);
      }
      if (next.length) pendingAttachmentsByChat.set(key, next);
      else pendingAttachmentsByChat.delete(key);
    }
    return dropped;
  }

  function dropForMessage(messageId, chatId = "") {
    return dropItemsForMessage(messageId, chatId).length;
  }

  async function takePendingAttachments(chatId) {
    return withAttachmentLock(chatId, () => take(chatId));
  }

  async function restorePendingAttachments(chatId, attachments) {
    return withAttachmentLock(chatId, () => {
      restore(chatId, attachments);
      return cleanup(chatId);
    });
  }

  async function dropByMessageId(messageId, chatId = "", onRemoved = null) {
    const targetChat = String(chatId || "").trim();
    if (targetChat) {
      return withAttachmentLock(targetChat, () => {
        const dropped = dropItemsForMessage(messageId, targetChat);
        if (dropped.length && typeof onRemoved === "function") onRemoved(dropped);
        return dropped;
      });
    }
    const keys = [...pendingAttachmentsByChat.keys()];
    const allDropped = [];
    for (const key of keys) {
      const dropped = await withAttachmentLock(key, () => {
        const items = dropItemsForMessage(messageId, key);
        if (items.length && typeof onRemoved === "function") onRemoved(items);
        return items;
      });
      allDropped.push(...dropped);
    }
    return allDropped;
  }

  return {
    add,
    cleanup,
    dropByMessageId,
    dropForMessage,
    dropItemsForMessage,
    pendingAttachmentsByChat,
    restore,
    restorePendingAttachments,
    take,
    takePendingAttachments,
    withAttachmentLock,
  };
}
