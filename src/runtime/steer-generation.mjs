export const STEER_CANCELLED_BY_CLEARQUEUE_REPLY =
  "本次补充指令在发送前已被 /clearqueue 取消，未追加到当前任务。";

export function initJobSteerFields(job = {}) {
  job.clearGeneration = Number(job.clearGeneration || 0);
  if (!Array.isArray(job.pendingSteerEntries)) job.pendingSteerEntries = [];
  if (!("steerInFlight" in job)) job.steerInFlight = null;
  return job;
}

export function registerPendingSteerOnEnqueue({
  event,
  command,
  activeJobs,
  chatIdOf = (item) => String(item?.chat_id || item?.chatId || "").trim(),
  messageIdOf = (item) => String(item?.message_id || item?.messageId || item?.id || "").trim(),
} = {}) {
  if (command?.name !== "/steer") return null;
  const chatId = chatIdOf(event);
  const messageId = messageIdOf(event);
  const job = chatId && activeJobs ? activeJobs.get(chatId) : null;
  if (!job) return null;
  initJobSteerFields(job);
  const entry = {
    id: messageId,
    chatId,
    capturedGeneration: Number(job.clearGeneration || 0),
    state: "pending",
    cancelReason: "",
  };
  job.pendingSteerEntries.push(entry);
  event._steerEntry = entry;
  event._steerJob = job;
  return entry;
}

export function ensureSteerEntry({ event, job, chatId, messageId }) {
  if (!job) return null;
  initJobSteerFields(job);
  if (event?._steerEntry && event?._steerJob === job) {
    return event._steerEntry;
  }
  const entry = {
    id: String(messageId || event?.message_id || event?.id || ""),
    chatId: String(chatId || event?.chat_id || ""),
    capturedGeneration: Number(job.clearGeneration || 0),
    state: "pending",
    cancelReason: "",
  };
  job.pendingSteerEntries.push(entry);
  if (event && typeof event === "object") {
    event._steerEntry = entry;
    event._steerJob = job;
  }
  return entry;
}

export function removeSteerEntry(job, entry) {
  if (!job || !entry || !Array.isArray(job.pendingSteerEntries)) return;
  const index = job.pendingSteerEntries.indexOf(entry);
  if (index >= 0) job.pendingSteerEntries.splice(index, 1);
}

export function isSteerEntryCancelled(job, entry) {
  if (!entry) return false;
  if (entry.state === "cancelled") return true;
  if (!job) return false;
  return Number(job.clearGeneration || 0) !== Number(entry.capturedGeneration ?? 0);
}

export function markSteerEntryDispatched(job, entry) {
  if (!entry) return;
  entry.state = "dispatched";
  removeSteerEntry(job, entry);
}

export function clearQueuedWorkAndAdvanceGeneration({
  chatId,
  all = false,
  clearEvents,
  activeJobs,
  activeGoalRuns = null,
  cleanupDownloads = null,
} = {}) {
  const cleared = typeof clearEvents === "function"
    ? clearEvents(chatId, { all })
    : { removedQueued: 0, cancelledPreflight: 0 };
  const removedQueued = Number(cleared?.removedQueued || 0);
  const cancelledPreflight = Number(cleared?.cancelledPreflight || 0);

  const targetChats = all
    ? [
        ...new Set([
          ...(activeGoalRuns ? activeGoalRuns.keys() : []),
          ...(activeJobs ? activeJobs.keys() : []),
        ]),
      ]
    : [chatId].filter(Boolean);

  let cancelledPendingSteers = 0;
  for (const targetChatId of targetChats) {
    const job = activeJobs?.get(targetChatId);
    if (job) {
      job.clearGeneration = Number(job.clearGeneration || 0) + 1;
      const entries = Array.isArray(job.pendingSteerEntries)
        ? job.pendingSteerEntries.splice(0)
        : [];
      for (const entry of entries) {
        if (entry?.state === "pending") {
          entry.state = "cancelled";
          entry.cancelReason = "cleared_by_clearqueue";
          cancelledPendingSteers += 1;
        }
      }
    }
    const run = activeGoalRuns?.get(targetChatId);
    if (run) {
      run.clearGeneration = Number(run.clearGeneration || 0) + 1;
      const dropped = Array.isArray(run.pendingSteers) ? run.pendingSteers.splice(0) : [];
      cancelledPendingSteers += dropped.length;
      if (typeof cleanupDownloads === "function") {
        for (const steer of dropped) {
          if (Array.isArray(steer?.directAttachments) && steer.directAttachments.length) {
            cleanupDownloads(steer.directAttachments);
          }
        }
      }
    }
  }

  return { removedQueued, cancelledPreflight, cancelledPendingSteers };
}

export function formatClearQueueReply({
  all = false,
  removedQueued = 0,
  cancelledPreflight = 0,
  cancelledPendingSteers = 0,
  queueSummaryText = "",
} = {}) {
  if (all) {
    return `已清空全部等待队列：${removedQueued} 条，取消尚未提交的任务：${cancelledPreflight} 条，取消尚未发送的补充指令：${cancelledPendingSteers} 条。正在运行的任务不受影响，后续新消息与新 /steer 可正常提交。`;
  }
  return `已清空当前聊天等待队列：${removedQueued} 条，取消尚未提交的任务：${cancelledPreflight} 条，取消尚未发送的补充指令：${cancelledPendingSteers} 条。当前队列：${queueSummaryText}。正在运行的任务不受影响，后续新消息与新 /steer 可正常提交。`;
}

export function createChatCommandQueue() {
  const queues = new Map();
  function enqueue(chatId, fn) {
    const key = String(chatId || "__default__");
    const previous = queues.get(key) || Promise.resolve();
    const run = previous.catch(() => {}).then(() => fn());
    const tail = run.finally(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    queues.set(key, tail);
    return run;
  }
  return {
    enqueue,
    pendingChats: () => queues.size,
  };
}

export async function flushGoalSteersWithGeneration(run, submitGoalSteer) {
  if (!run) return;
  if (run.steeringInFlight) return await run.steeringInFlight;
  if (!run.client || !run.threadId || run.done) return;
  run.steeringInFlight = (async () => {
    while (run.pendingSteers.length && !run.done && run.client && run.threadId) {
      const steer = run.pendingSteers.shift();
      const gen = steer?.capturedGeneration ?? Number(run.clearGeneration || 0);
      if (gen !== Number(run.clearGeneration || 0)) continue;
      const submitted = await submitGoalSteer(run, steer);
      if (submitted === false) {
        if (gen === Number(run.clearGeneration || 0) && !run.done) {
          run.pendingSteers.unshift(steer);
        }
        break;
      }
    }
  })();
  try {
    await run.steeringInFlight;
  } finally {
    run.steeringInFlight = null;
  }
}
