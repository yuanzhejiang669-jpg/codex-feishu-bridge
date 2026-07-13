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
  const queue = createEventQueue({ chatIdOf, messageIdOf });
  const concurrency = Math.max(1, Number(maxConcurrent) || 1);
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

    if (activeJobs >= concurrency || queue.length) {
      void acknowledgeQueued(event, queue.length + activeJobs)
        .catch((error) => log("WARN", "queue ack failed", {
          messageId,
          chatId: chatIdOf(event),
          error: String(error?.message || error).slice(0, 1000),
        }));
    }
    queue.enqueue({ ...event, queuedAt: now() });
    drain();
  }

  function drain() {
    if (isShuttingDown()) return;
    while (activeJobs < concurrency && queue.length) {
      const event = queue.dequeue();
      activeJobs += 1;
      handleEvent(event)
        .catch((error) => log("ERROR", "event handling failed", {
          error: String(error?.stack || error),
        }))
        .finally(() => {
          activeJobs -= 1;
          drain();
        });
    }
  }

  return {
    enqueue,
    drain,
    removeByMessageId: (messageId) => queue.removeByMessageId(messageId),
    clearForChat: (chatId, options) => queue.clearForChat(chatId, options),
    countForChat: (chatId) => queue.countForChat(chatId),
    summary: (chatId) => queue.summary(chatId),
    get activeJobs() {
      return activeJobs;
    },
    get pendingCount() {
      return queue.length;
    },
  };
}
