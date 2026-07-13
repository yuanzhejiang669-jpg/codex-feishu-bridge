export function createEventQueue({ chatIdOf, messageIdOf } = {}) {
  if (typeof chatIdOf !== "function" || typeof messageIdOf !== "function") {
    throw new Error("Event queue requires chatIdOf and messageIdOf accessors");
  }
  const events = [];

  return {
    get length() {
      return events.length;
    },
    enqueue(event) {
      events.push(event);
    },
    dequeue() {
      return events.shift();
    },
    removeByMessageId(messageId) {
      const target = String(messageId || "").trim();
      if (!target) return 0;
      return removeMatching(events, (event) => messageIdOf(event) === target);
    },
    clearForChat(chatId, { all = false } = {}) {
      const target = String(chatId || "").trim();
      return removeMatching(events, (event) => all || (target && chatIdOf(event) === target));
    },
    countForChat(chatId) {
      const target = String(chatId || "").trim();
      if (!target) return 0;
      return events.filter((event) => chatIdOf(event) === target).length;
    },
    summary(chatId) {
      const target = String(chatId || "").trim();
      const parts = [`总队列 ${events.length}`];
      if (target) parts.push(`当前聊天 ${events.filter((event) => chatIdOf(event) === target).length}`);
      const unknown = events.filter((event) => !chatIdOf(event)).length;
      if (unknown) parts.push(`未知聊天 ${unknown}`);
      return parts.join("，");
    },
  };
}

function removeMatching(events, predicate) {
  let removed = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (!predicate(events[index])) continue;
    events.splice(index, 1);
    removed += 1;
  }
  return removed;
}
