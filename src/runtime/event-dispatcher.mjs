import { createEventQueue } from "./event-queue.mjs";

export function createEventDispatcher({
  maxConcurrent = 1,
  chatIdOf,
  messageIdOf,
  eventIdOf = () => "",
  isRecallEvent = () => false,
  isMessageRecalled = () => false,
  parseCommand = () => null,
  isOutOfBandCommand = () => false,
  handleRecallEvent = () => {},
  handleOutOfBandCommand = async () => {},
  handleEvent = async () => {},
  acknowledgeQueued = async () => {},
  isShuttingDown = () => false,
  log = () => {},
  now = Date.now,
} = {}) {
  const queue = createEventQueue({
    chatIdOf: (entry) => chatIdOf(entry.event),
    messageIdOf: (entry) => messageIdOf(entry.event),
  });
  const concurrency = Math.max(1, Number(maxConcurrent) || 1);
  const inFlight = new Set();
  let activeJobs = 0;

  function enqueue(event) {
    if (isRecallEvent(event)) {
      handleRecallEvent(event);
      return;
    }

    const messageId = messageIdOf(event);
    if (messageId && isMessageRecalled(messageId)) {
      log("INFO", "recalled message ignored before enqueue", {
        messageId,
        eventId: eventIdOf(event),
      });
      return;
    }

    const command = parseCommand(event);
    if (isOutOfBandCommand(command)) {
      void handleOutOfBandCommand(event, command)
        .catch((error) => log("ERROR", "out-of-band command handling failed", {
          error: String(error?.stack || error),
        }));
      return;
    }

    const wasQueued = activeJobs >= concurrency || queue.length > 0;
    if (wasQueued) {
      void acknowledgeQueued(event, queue.length + activeJobs)
        .catch((error) => log("WARN", "queue ack failed", {
          messageId,
          chatId: chatIdOf(event),
          error: String(error?.message || error).slice(0, 1000),
        }));
    }
    queue.enqueue({
      event: { ...event, queuedAt: now() },
      wasQueued,
    });
    drain();
  }

  function drain() {
    if (isShuttingDown()) return;
    while (activeJobs < concurrency && queue.length) {
      const entry = queue.dequeue();
      const state = {
        event: entry.event,
        wasQueued: entry.wasQueued,
        cancelled: false,
        committed: false,
      };
      inFlight.add(state);
      activeJobs += 1;
      handleEvent(state.event, {
        isCancelled: () => state.cancelled,
        commit: () => {
          if (state.cancelled) return false;
          state.committed = true;
          return true;
        },
      })
        .catch((error) => log("ERROR", "event handling failed", {
          error: String(error?.stack || error),
        }))
        .finally(() => {
          inFlight.delete(state);
          activeJobs -= 1;
          drain();
        });
    }
  }

  function cancelInFlight(predicate, { queuedOnly = false } = {}) {
    let cancelled = 0;
    for (const state of inFlight) {
      if (state.cancelled || state.committed) continue;
      if (queuedOnly && !state.wasQueued) continue;
      if (!predicate(state.event)) continue;
      state.cancelled = true;
      cancelled += 1;
    }
    return cancelled;
  }

  function removeByMessageId(messageId) {
    const target = String(messageId || "").trim();
    if (!target) return 0;
    return queue.removeByMessageId(target)
      + cancelInFlight((event) => messageIdOf(event) === target);
  }

  function clearForChat(chatId, { all = false } = {}) {
    const target = String(chatId || "").trim();
    const matches = (event) => all || (target && chatIdOf(event) === target);
    return queue.clearForChat(target, { all })
      + cancelInFlight(matches, { queuedOnly: true });
  }

  return {
    enqueue,
    drain,
    removeByMessageId,
    clearForChat,
    countForChat: (chatId) => queue.countForChat(chatId),
    workCountForChat: (chatId) => {
      const target = String(chatId || "").trim();
      let count = queue.countForChat(target);
      for (const state of inFlight) {
        if (!state.cancelled && target && chatIdOf(state.event) === target) count += 1;
      }
      return count;
    },
    summary: (chatId) => queue.summary(chatId),
    get activeJobs() {
      return activeJobs;
    },
    get pendingCount() {
      return queue.length;
    },
  };
}
