import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createEventDispatcher } from "../src/runtime/event-dispatcher.mjs";
import { parseCommand } from "../src/commands/parser.mjs";
import { createPendingAttachmentStore } from "../src/attachments/pending.mjs";
import {
  STEER_CANCELLED_BY_CLEARQUEUE_REPLY,
  clearQueuedWorkAndAdvanceGeneration,
  createChatCommandQueue,
  ensureSteerEntry,
  flushGoalSteersWithGeneration,
  formatClearQueueReply,
  isSteerEntryCancelled,
  markSteerEntryDispatched,
  registerPendingSteerOnEnqueue,
  removeSteerEntry,
} from "../src/runtime/steer-generation.mjs";
import { createClaudeBridge } from "../src/claude/bridge-runner.mjs";
import { createAntigravityBridge } from "../src/antigravity/bridge-runner.mjs";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("waitFor timed out");
    await delay(5);
  }
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// =========================================================================
// SCHED-001 & SCHED-002: Dispatcher queuing, preflight cancel, attachment lock, serial chat queue
// =========================================================================

test("SCHED-001: multi-concurrent dispatcher marks second message in same busy chat as queued and cancels uncommitted preflight", async () => {
  const queuedAcks = [];
  const firstEntered = createDeferred();
  const firstGate = createDeferred();
  const otherChatPreflightEntered = createDeferred();
  const otherChatPreflightGate = createDeferred();
  const committedIds = [];

  const dispatcher = createEventDispatcher({
    maxConcurrent: 3,
    chatIdOf: (event) => event.chat_id,
    messageIdOf: (event) => event.message_id,
    acknowledgeQueued: async (event) => {
      queuedAcks.push(event.message_id);
    },
    handleEvent: async (event, control) => {
      if (event.message_id === "a-1") {
        assert.equal(control.commit(), true);
        committedIds.push("a-1");
        firstEntered.resolve();
        await firstGate.promise;
        return;
      }
      if (event.message_id === "b-1") {
        otherChatPreflightEntered.resolve();
        await otherChatPreflightGate.promise;
        if (control.commit()) committedIds.push("b-1");
        return;
      }
      if (control.commit()) committedIds.push(event.message_id);
    },
  });

  // chat-a starts running (1 of 3 slots used)
  dispatcher.enqueue({ chat_id: "chat-a", message_id: "a-1" });
  await firstEntered.promise;
  assert.equal(dispatcher.isChatBusy("chat-a"), true);

  // Second message in same chat-a MUST be marked queued even though activeJobs (1) < maxConcurrent (3)
  dispatcher.enqueue({ chat_id: "chat-a", message_id: "a-2" });
  await delay(10);
  assert.deepEqual(queuedAcks, ["a-2"]);

  // First message in chat-b enters preflight (not queued!) and is cancelled by clearForChat BEFORE commit
  dispatcher.enqueue({ chat_id: "chat-b", message_id: "b-1" });
  await otherChatPreflightEntered.promise;
  const clearedB = dispatcher.clearForChat("chat-b");
  assert.deepEqual(clearedB, { removedQueued: 0, cancelledPreflight: 1 });
  otherChatPreflightGate.resolve();

  const clearedA = dispatcher.clearForChat("chat-a");
  assert.deepEqual(clearedA, { removedQueued: 1, cancelledPreflight: 0 });

  firstGate.resolve();
  await waitFor(() => dispatcher.activeJobs === 0);
  assert.deepEqual(committedIds, ["a-1"]);
});

test("SCHED-002: attachment lock serializes take/restore/recall and cleans up recalled temp files", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-sched-att-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const fileA = path.join(tmpDir, "a.png");
  const fileB = path.join(tmpDir, "b.png");
  fs.writeFileSync(fileA, "a");
  fs.writeFileSync(fileB, "b");

  const store = createPendingAttachmentStore({ maxPendingAttachments: 12, pendingTtlMs: 60_000 });
  const now = Date.now();
  store.add("chat-1", [
    { type: "image", messageId: "m-1", fileKey: "k-1", path: fileA, receivedAt: now },
    { type: "image", messageId: "m-2", fileKey: "k-2", path: fileB, receivedAt: now + 10 },
  ]);

  const order = [];
  const p1 = store.withAttachmentLock("chat-1", async () => {
    order.push("lock1-start");
    await delay(25);
    const items = store.take("chat-1");
    // Simulate failed steer restoring attachments
    store.restore("chat-1", items);
    order.push("lock1-end");
  });
  const p2 = store.dropByMessageId("m-1", "chat-1", (removed) => {
    order.push(`recall-drop-${removed.length}`);
    for (const item of removed) fs.rmSync(item.path, { force: true });
  });
  await Promise.all([p1, p2]);

  assert.deepEqual(order, ["lock1-start", "lock1-end", "recall-drop-1"]);
  assert.equal(fs.existsSync(fileA), false);
  assert.equal(fs.existsSync(fileB), true);
  const remaining = await store.takePendingAttachments("chat-1");
  assert.deepEqual(remaining.map((item) => item.messageId), ["m-2"]);
});

test("SCHED-002: chatCommandQueue serializes Level B commands per chat without blocking other chats", async () => {
  const queue = createChatCommandQueue();
  const events = [];
  const gate = createDeferred();

  const c1First = queue.enqueue("chat-1", async () => {
    events.push("c1-1-start");
    await gate.promise;
    events.push("c1-1-end");
  });
  const c1Second = queue.enqueue("chat-1", async () => {
    events.push("c1-2");
  });
  const c2First = queue.enqueue("chat-2", async () => {
    events.push("c2-1");
  });

  await c2First;
  assert.deepEqual(events, ["c1-1-start", "c2-1"]);
  gate.resolve();
  await Promise.all([c1First, c1Second]);
  assert.deepEqual(events, ["c1-1-start", "c2-1", "c1-1-end", "c1-2"]);
});

// =========================================================================
// SCHED-003: Mandatory 8 regression cases from V2 T-009
// =========================================================================

function createCodexHarness({ maxConcurrent = 2, preflightHook = null, steerRpcHook = null } = {}) {
  const activeJobs = new Map();
  const activeGoalRuns = new Map();
  const pendingAttachments = createPendingAttachmentStore({ maxPendingAttachments: 12, pendingTtlMs: 60_000 });
  const chatCommands = createChatCommandQueue();
  const replies = [];
  const executed = [];
  const steeredPayloads = [];
  const cleanedDownloads = [];
  const jobGates = new Map();

  const LEVEL_A = new Set(["/clearqueue", "/clearqueueall", "/stop", "/stopall", "/queue", "/status", "/help"]);

  const dispatcher = createEventDispatcher({
    maxConcurrent,
    chatIdOf: (event) => event.chat_id,
    messageIdOf: (event) => event.message_id,
    parseCommand: (event) => parseCommand(event.content, { engine: "codex" }),
    isOutOfBandCommand: (cmd) => Boolean(cmd?.name),
    onOutOfBandEnqueued: (event, command) => registerPendingSteerOnEnqueue({
      event,
      command,
      activeJobs,
      chatIdOf: (e) => e.chat_id,
      messageIdOf: (e) => e.message_id,
    }),
    handleOutOfBandCommand: async (event, command) => {
      const chatId = event.chat_id;
      const run = async () => {
        if (command.name === "/clearqueue" || command.name === "/clearqueueall") {
          const all = command.name === "/clearqueueall" || command.rest.trim().toLowerCase() === "all";
          const cleared = clearQueuedWorkAndAdvanceGeneration({
            chatId,
            all,
            clearEvents: (id, opts) => dispatcher.clearForChat(id, opts),
            activeJobs,
            activeGoalRuns,
            cleanupDownloads: (items) => cleanedDownloads.push(...items),
          });
          replies.push({
            chatId,
            messageId: event.message_id,
            kind: "clearqueue",
            cleared,
            text: formatClearQueueReply({ all, ...cleared, queueSummaryText: dispatcher.summary(chatId) }),
          });
          return;
        }
        if (command.name === "/steer") {
          const directAttachments = Array.isArray(event.attachments) ? event.attachments : [];
          if (preflightHook) await preflightHook(event, command);
          const capturedJob = event._steerJob || activeJobs.get(chatId);
          const entry = capturedJob ? ensureSteerEntry({ event, job: capturedJob, chatId, messageId: event.message_id }) : null;
          if (entry && isSteerEntryCancelled(capturedJob, entry)) {
            removeSteerEntry(capturedJob, entry);
            cleanedDownloads.push(...directAttachments);
            replies.push({ chatId, messageId: event.message_id, kind: "steer-cancelled", text: STEER_CANCELLED_BY_CLEARQUEUE_REPLY });
            return;
          }
          const job = activeJobs.get(chatId);
          if (!job || (capturedJob && job !== capturedJob)) {
            if (entry) { entry.state = "failed"; removeSteerEntry(capturedJob, entry); }
            replies.push({ chatId, messageId: event.message_id, kind: "steer-ended", text: "当前任务已结束，未追加任何内容。" });
            return;
          }
          let outcome = "sent";
          const prev = job.steerInFlight || Promise.resolve();
          const cur = prev.catch(() => {}).then(async () => {
            if (entry && isSteerEntryCancelled(job, entry)) {
              outcome = "cancelled";
              cleanedDownloads.push(...directAttachments);
              return;
            }
            if (activeJobs.get(chatId) !== job) {
              outcome = "ended";
              return;
            }
            const taken = await pendingAttachments.takePendingAttachments(chatId);
            if (entry && isSteerEntryCancelled(job, entry)) {
              outcome = "cancelled";
              if (taken.length) await pendingAttachments.restorePendingAttachments(chatId, taken);
              cleanedDownloads.push(...directAttachments);
              return;
            }
            markSteerEntryDispatched(job, entry);
            const payload = { chatId, messageId: event.message_id, text: command.rest, attachments: [...taken, ...directAttachments] };
            steeredPayloads.push(payload);
            if (steerRpcHook) await steerRpcHook(payload, job);
          });
          job.steerInFlight = cur;
          try {
            await cur;
            replies.push({
              chatId,
              messageId: event.message_id,
              kind: outcome === "cancelled" ? "steer-cancelled" : outcome === "ended" ? "steer-ended" : "steer-done",
              text: outcome === "cancelled" ? STEER_CANCELLED_BY_CLEARQUEUE_REPLY : outcome === "ended" ? "当前任务已结束，未追加任何内容。" : "ok",
            });
          } finally {
            if (entry) removeSteerEntry(job, entry);
            if (job.steerInFlight === cur) job.steerInFlight = null;
          }
        }
      };
      if (LEVEL_A.has(command.name) || command.name === "/steer") await run();
      else await chatCommands.enqueue(chatId, run);
    },
    handleEvent: async (event, control) => {
      if (!control.commit()) return;
      const gate = createDeferred();
      const job = {
        chatId: event.chat_id,
        messageId: event.message_id,
        mode: "app-server",
        clearGeneration: 0,
        pendingSteerEntries: [],
        steerInFlight: null,
      };
      activeJobs.set(event.chat_id, job);
      jobGates.set(event.message_id, gate);
      executed.push(event.message_id);
      try {
        await gate.promise;
      } finally {
        if (activeJobs.get(event.chat_id) === job) activeJobs.delete(event.chat_id);
      }
    },
  });

  return {
    dispatcher,
    activeJobs,
    activeGoalRuns,
    pendingAttachments,
    replies,
    executed,
    steeredPayloads,
    cleanedDownloads,
    finishJob: (messageId) => jobGates.get(messageId)?.resolve(),
  };
}

test("SCHED-003 Case 1: Codex app-server real sequence A running -> B queued -> /clearqueue all -> new /steer 1 -> new C runs after A", async () => {
  const h = createCodexHarness({ maxConcurrent: 1 });

  // A starts running
  h.dispatcher.enqueue({ chat_id: "chat-1", message_id: "A", content: "run task A" });
  await waitFor(() => h.activeJobs.has("chat-1"));

  // B enters queue
  h.dispatcher.enqueue({ chat_id: "chat-1", message_id: "B", content: "run task B" });
  assert.equal(h.dispatcher.pendingCount, 1);

  // /clearqueue all
  h.dispatcher.enqueue({ chat_id: "chat-1", message_id: "cq-1", content: "/clearqueue all" });
  await waitFor(() => h.replies.some((r) => r.messageId === "cq-1"));
  const cqReply = h.replies.find((r) => r.messageId === "cq-1");
  assert.deepEqual(cqReply.cleared, { removedQueued: 1, cancelledPreflight: 0, cancelledPendingSteers: 0 });
  assert.match(cqReply.text, /已清空全部等待队列：1 条，取消尚未提交的任务：0 条，取消尚未发送的补充指令：0 条。正在运行的任务不受影响，后续新消息与新 \/steer 可正常提交。/);

  // New /steer 1 MUST succeed on still-running A
  h.dispatcher.enqueue({ chat_id: "chat-1", message_id: "st-1", content: "/steer 1" });
  await waitFor(() => h.replies.some((r) => r.messageId === "st-1"));
  assert.equal(h.replies.find((r) => r.messageId === "st-1").kind, "steer-done");
  assert.deepEqual(h.steeredPayloads.map((p) => p.text), ["1"]);

  // New task C queues and executes after A finishes; B NEVER executes
  h.dispatcher.enqueue({ chat_id: "chat-1", message_id: "C", content: "run task C" });
  assert.equal(h.dispatcher.pendingCount, 1);
  h.finishJob("A");
  await waitFor(() => h.executed.includes("C"));
  h.finishJob("C");
  await waitFor(() => h.dispatcher.activeJobs === 0);
  assert.deepEqual(h.executed, ["A", "C"]);
});

test("SCHED-003 Case 2: dispatched s0 not retracted, pending s1 cancelled during preflight/queue, post-clear s2 succeeds", async () => {
  const s0RpcEntered = createDeferred();
  const s0RpcGate = createDeferred();
  const s1PreflightEntered = createDeferred();
  const s1PreflightGate = createDeferred();

  const h = createCodexHarness({
    maxConcurrent: 1,
    steerRpcHook: async (payload) => {
      if (payload.messageId === "s0") {
        s0RpcEntered.resolve();
        await s0RpcGate.promise;
      }
    },
    preflightHook: async (event) => {
      if (event.message_id === "s1") {
        s1PreflightEntered.resolve();
        await s1PreflightGate.promise;
      }
    },
  });

  h.pendingAttachments.add("chat-1", [{ type: "image", messageId: "p-att", fileKey: "k", path: "keep.png", receivedAt: Date.now() }]);
  h.dispatcher.enqueue({ chat_id: "chat-1", message_id: "A", content: "task A" });
  await waitFor(() => h.activeJobs.has("chat-1"));

  // s0 reaches turn/steer RPC (dispatched)
  h.dispatcher.enqueue({ chat_id: "chat-1", message_id: "s0", content: "/steer zero" });
  await s0RpcEntered.promise;

  // Put another pending attachment after s0 consumed the first one
  h.pendingAttachments.add("chat-1", [{ type: "image", messageId: "p-att-2", fileKey: "k2", path: "keep2.png", receivedAt: Date.now() }]);

  // s1 arrives before /clearqueue and waits in steerInFlight behind s0 (or preflight)
  h.dispatcher.enqueue({
    chat_id: "chat-1",
    message_id: "s1",
    content: "/steer one",
    attachments: [{ type: "file", messageId: "s1", path: "s1-direct.txt" }],
  });
  await s1PreflightEntered.promise;

  // /clearqueue executes while s0 is in RPC and s1 is still pending
  h.dispatcher.enqueue({ chat_id: "chat-1", message_id: "cq", content: "/clearqueue" });
  await waitFor(() => h.replies.some((r) => r.messageId === "cq"));
  const cq = h.replies.find((r) => r.messageId === "cq");
  // s0 was already dispatched -> NOT counted; s1 was pending -> cancelledPendingSteers = 1
  assert.deepEqual(cq.cleared, { removedQueued: 0, cancelledPreflight: 0, cancelledPendingSteers: 1 });

  // Release s0 and s1
  s0RpcGate.resolve();
  s1PreflightGate.resolve();
  await waitFor(() => h.replies.some((r) => r.messageId === "s1"));
  const s1Reply = h.replies.find((r) => r.messageId === "s1");
  assert.equal(s1Reply.kind, "steer-cancelled");
  assert.equal(s1Reply.text, STEER_CANCELLED_BY_CLEARQUEUE_REPLY);
  // s1 direct attachment cleaned up, independent pending attachment preserved
  assert.deepEqual(h.cleanedDownloads.map((item) => item.path), ["s1-direct.txt"]);
  assert.equal(h.pendingAttachments.cleanup("chat-1").length, 1);

  // s2 arrives AFTER /clearqueue -> succeeds and picks up preserved pending attachment
  h.dispatcher.enqueue({ chat_id: "chat-1", message_id: "s2", content: "/steer two" });
  await waitFor(() => h.replies.some((r) => r.messageId === "s2"));
  assert.equal(h.replies.find((r) => r.messageId === "s2").kind, "steer-done");
  assert.deepEqual(h.steeredPayloads.map((p) => p.messageId), ["s0", "s2"]);
  assert.deepEqual(h.steeredPayloads[1].attachments.map((a) => a.path), ["keep2.png"]);

  h.finishJob("A");
  await waitFor(() => h.dispatcher.activeJobs === 0);
});

test("SCHED-003 Case 3: Codex Goal flushGoalSteers drops cancelled pendingSteers and prevents g0 unshift resurrection", async () => {
  const g0Entered = createDeferred();
  const g0Gate = createDeferred();
  const delivered = [];
  const activeGoalRuns = new Map();
  const activeJobs = new Map();

  const run = {
    chatId: "chat-goal",
    client: {},
    threadId: "thread-1",
    done: false,
    clearGeneration: 0,
    pendingSteers: [
      { messageId: "g0", userContent: "steer-0", capturedGeneration: 0 },
      { messageId: "g1", userContent: "steer-1", capturedGeneration: 0, directAttachments: [{ path: "g1.tmp" }] },
    ],
    steeringInFlight: null,
  };
  activeGoalRuns.set("chat-goal", run);
  const cleaned = [];

  const flushPromise = flushGoalSteersWithGeneration(run, async (_run, steer) => {
    if (steer.messageId === "g0") {
      g0Entered.resolve();
      await g0Gate.promise;
      // Simulate isActiveTurnRaceError -> returns false (would normally unshift!)
      return false;
    }
    delivered.push(steer.messageId);
    return true;
  });

  await g0Entered.promise;
  // /clearqueue runs while g0 is awaiting submitGoalSteer and g1 is in pendingSteers
  const cleared = clearQueuedWorkAndAdvanceGeneration({
    chatId: "chat-goal",
    all: false,
    clearEvents: () => ({ removedQueued: 0, cancelledPreflight: 0 }),
    activeJobs,
    activeGoalRuns,
    cleanupDownloads: (items) => cleaned.push(...items),
  });
  assert.equal(cleared.cancelledPendingSteers, 1); // g1 was in pendingSteers
  assert.equal(run.clearGeneration, 1);
  assert.deepEqual(cleaned.map((i) => i.path), ["g1.tmp"]);

  g0Gate.resolve();
  await flushPromise;
  // g0 MUST NOT resurrect into pendingSteers!
  assert.equal(run.pendingSteers.length, 0);

  // Post-clear new Goal steer with generation 1 delivers cleanly
  run.pendingSteers.push({ messageId: "g2", userContent: "steer-2", capturedGeneration: run.clearGeneration });
  await flushGoalSteersWithGeneration(run, async (_run, steer) => {
    delivered.push(steer.messageId);
    return true;
  });
  assert.deepEqual(delivered, ["g2"]);
});

test("SCHED-003 Case 4: repeated /clearqueue all returns 0/0/0 on second call and allows new /steer and C", async () => {
  const h = createCodexHarness({ maxConcurrent: 1 });
  h.dispatcher.enqueue({ chat_id: "chat-1", message_id: "A", content: "A" });
  await waitFor(() => h.activeJobs.has("chat-1"));
  h.dispatcher.enqueue({ chat_id: "chat-1", message_id: "B", content: "B" });

  h.dispatcher.enqueue({ chat_id: "chat-1", message_id: "cq-1", content: "/clearqueue all" });
  await waitFor(() => h.replies.some((r) => r.messageId === "cq-1"));
  assert.deepEqual(h.replies.find((r) => r.messageId === "cq-1").cleared, {
    removedQueued: 1, cancelledPreflight: 0, cancelledPendingSteers: 0,
  });

  h.dispatcher.enqueue({ chat_id: "chat-1", message_id: "cq-2", content: "/clearqueue all" });
  await waitFor(() => h.replies.some((r) => r.messageId === "cq-2"));
  assert.deepEqual(h.replies.find((r) => r.messageId === "cq-2").cleared, {
    removedQueued: 0, cancelledPreflight: 0, cancelledPendingSteers: 0,
  });
  assert.equal(h.activeJobs.get("chat-1").clearGeneration, 2);

  h.dispatcher.enqueue({ chat_id: "chat-1", message_id: "st-after", content: "/steer after-two-clears" });
  await waitFor(() => h.replies.some((r) => r.messageId === "st-after"));
  assert.equal(h.replies.find((r) => r.messageId === "st-after").kind, "steer-done");

  h.dispatcher.enqueue({ chat_id: "chat-1", message_id: "C", content: "C" });
  h.finishJob("A");
  await waitFor(() => h.executed.includes("C"));
  h.finishJob("C");
  await waitFor(() => h.dispatcher.activeJobs === 0);
  assert.deepEqual(h.executed, ["A", "C"]);
});

test("SCHED-003 Case 5: cross-chat isolation for /clearqueue vs global scope for /clearqueue all", async () => {
  const s2Gate = createDeferred();
  const s2Entered = createDeferred();
  const h = createCodexHarness({
    maxConcurrent: 2,
    preflightHook: async (event) => {
      if (event.message_id === "st-chat2") {
        s2Entered.resolve();
        await s2Gate.promise;
      }
    },
  });

  h.dispatcher.enqueue({ chat_id: "chat-1", message_id: "A1", content: "A1" });
  h.dispatcher.enqueue({ chat_id: "chat-2", message_id: "A2", content: "A2" });
  await waitFor(() => h.activeJobs.has("chat-1") && h.activeJobs.has("chat-2"));

  h.dispatcher.enqueue({ chat_id: "chat-1", message_id: "B1", content: "B1" });
  h.dispatcher.enqueue({ chat_id: "chat-2", message_id: "B2", content: "B2" });
  h.dispatcher.enqueue({ chat_id: "chat-2", message_id: "st-chat2", content: "/steer keep-chat2" });
  await s2Entered.promise;

  // Single-chat /clearqueue in chat-1 must NOT affect chat-2
  h.dispatcher.enqueue({ chat_id: "chat-1", message_id: "cq-c1", content: "/clearqueue" });
  await waitFor(() => h.replies.some((r) => r.messageId === "cq-c1"));
  assert.deepEqual(h.replies.find((r) => r.messageId === "cq-c1").cleared, {
    removedQueued: 1, cancelledPreflight: 0, cancelledPendingSteers: 0,
  });
  assert.equal(h.activeJobs.get("chat-1").clearGeneration, 1);
  assert.equal(h.activeJobs.get("chat-2").clearGeneration, 0);
  assert.equal(h.dispatcher.countForChat("chat-2"), 1);

  // Release chat-2's pending steer -> MUST succeed!
  s2Gate.resolve();
  await waitFor(() => h.replies.some((r) => r.messageId === "st-chat2"));
  assert.equal(h.replies.find((r) => r.messageId === "st-chat2").kind, "steer-done");

  // Now queue one item in chat-1 and run /clearqueue all from chat-1
  h.dispatcher.enqueue({ chat_id: "chat-1", message_id: "B1-2", content: "B1-2" });
  h.dispatcher.enqueue({ chat_id: "chat-1", message_id: "cq-all", content: "/clearqueue all" });
  await waitFor(() => h.replies.some((r) => r.messageId === "cq-all"));
  assert.deepEqual(h.replies.find((r) => r.messageId === "cq-all").cleared, {
    removedQueued: 2, cancelledPreflight: 0, cancelledPendingSteers: 0,
  });
  assert.equal(h.activeJobs.get("chat-1").clearGeneration, 2);
  assert.equal(h.activeJobs.get("chat-2").clearGeneration, 1);

  // Both chats can still submit new steers and new tasks C1, C2
  h.dispatcher.enqueue({ chat_id: "chat-1", message_id: "st-c1-new", content: "/steer c1-ok" });
  h.dispatcher.enqueue({ chat_id: "chat-2", message_id: "st-c2-new", content: "/steer c2-ok" });
  await waitFor(() => h.replies.some((r) => r.messageId === "st-c1-new") && h.replies.some((r) => r.messageId === "st-c2-new"));
  assert.equal(h.replies.find((r) => r.messageId === "st-c1-new").kind, "steer-done");
  assert.equal(h.replies.find((r) => r.messageId === "st-c2-new").kind, "steer-done");

  h.dispatcher.enqueue({ chat_id: "chat-1", message_id: "C1", content: "C1" });
  h.dispatcher.enqueue({ chat_id: "chat-2", message_id: "C2", content: "C2" });
  h.finishJob("A1");
  h.finishJob("A2");
  await waitFor(() => h.executed.includes("C1") && h.executed.includes("C2"));
  h.finishJob("C1");
  h.finishJob("C2");
  await waitFor(() => h.dispatcher.activeJobs === 0);
  assert.deepEqual(h.executed.sort(), ["A1", "A2", "C1", "C2"]);
});

test("SCHED-003 Case 6: Claude Code active job cancels preflight /steer s1 via /clearqueue and delivers post-clear /steer 1 + task C", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-sched-claude-"));
  const envKey = `CFB_SCHED_CLAUDE_${process.pid}_${Math.random().toString(16).slice(2)}`;
  process.env[envKey] = "fixture-key";
  t.after(() => { delete process.env[envKey]; fs.rmSync(root, { recursive: true, force: true }); });

  const catalog = path.join(root, "providers.json");
  const botConfig = path.join(root, "bot.json");
  fs.writeFileSync(catalog, JSON.stringify({ providers: [{ id: "p1", envKey, model: "claude-test", effort: "high", models: ["claude-test"] }] }));
  fs.writeFileSync(botConfig, JSON.stringify({ engine: "claude", provider: { id: "p1", model: "claude-test", reasoning: "high" } }));

  const session = { id: "s1", engine: "claude", title: "S1", messages: [] };
  const chat = { currentSessionId: "s1", sessions: [session] };
  const activeJobs = new Map();
  const activeChildren = new Map();
  const pendingAttachments = createPendingAttachmentStore({ maxPendingAttachments: 12, pendingTtlMs: 60_000 });
  const replies = [];
  const steered = [];
  const cleaned = [];
  const runGates = new Map();
  const runStarted = new Map();
  const s1PreflightEntered = createDeferred();
  const s1PreflightGate = createDeferred();

  const bridge = createClaudeBridge({
    config: {
      claudeProviderCatalog: catalog,
      claudeProviderId: "p1",
      claudeBotConfig: botConfig,
      claudeCli: { command: "claude" },
      claudeHome: root,
      workspace: root,
      stateDir: root,
      larkProfile: "claude-1",
    },
    getSession: () => session,
    getChatState: () => chat,
    resetSession: () => session,
    saveSessions: () => {},
    userText: (c) => c,
    activeJobs,
    activeChildren,
    appendText: () => {},
    reduceEvent: () => {},
    markPhase: () => {},
    ensureDone: () => {},
    markInterrupted: () => {},
    markError: () => {},
    sendMarkdown: async (chatId, text, _kind, messageId) => { replies.push({ chatId, text, messageId }); },
    pendingAttachments,
    cleanupClearedDownloads: (items) => cleaned.push(...items),
    createClient: (options) => ({
      child: { pid: 999 },
      steer: (content) => { steered.push(content); },
      async run(content) {
        const label = content[0]?.text || "";
        const gate = createDeferred();
        runGates.set(label, gate);
        options.onStarted({ pid: 999 });
        runStarted.get(label)?.resolve();
        try {
          await gate.promise;
          return { result: `done:${label}` };
        } finally {
          options.onClosed({ pid: 999 });
        }
      },
    }),
  });
  t.after(() => bridge.close());

  const executed = [];
  const chatCommands = createChatCommandQueue();
  const LEVEL_A = new Set(["/clearqueue", "/clearqueueall"]);
  const dispatcher = createEventDispatcher({
    maxConcurrent: 1,
    chatIdOf: (e) => e.chat_id,
    messageIdOf: (e) => e.message_id,
    parseCommand: (e) => parseCommand(e.content, { engine: "claude" }),
    isOutOfBandCommand: (cmd) => Boolean(cmd?.name),
    onOutOfBandEnqueued: (event, command) => registerPendingSteerOnEnqueue({
      event, command, activeJobs, chatIdOf: (e) => e.chat_id, messageIdOf: (e) => e.message_id,
    }),
    handleOutOfBandCommand: async (event, command) => {
      const exec = async () => {
        if (command.name === "/clearqueue") {
          const cleared = clearQueuedWorkAndAdvanceGeneration({
            chatId: event.chat_id,
            all: false,
            clearEvents: (id, opts) => dispatcher.clearForChat(id, opts),
            activeJobs,
            cleanupDownloads: (items) => cleaned.push(...items),
          });
          replies.push({ chatId: event.chat_id, messageId: event.message_id, cleared, text: formatClearQueueReply({ all: false, ...cleared, queueSummaryText: dispatcher.summary(event.chat_id) }) });
          return;
        }
        if (event.message_id === "s1") {
          s1PreflightEntered.resolve();
          await s1PreflightGate.promise;
        }
        await bridge.handleCommand(event, command);
      };
      if (LEVEL_A.has(command.name)) await exec();
      else await chatCommands.enqueue(event.chat_id, exec);
    },
    handleEvent: async (event, control) => {
      if (!control.commit()) return;
      executed.push(event.message_id);
      await bridge.run(event, session, null, null);
    },
  });

  runStarted.set("task-A", createDeferred());
  runStarted.set("task-C", createDeferred());
  dispatcher.enqueue({ chat_id: "chat-c", sender_id: "u1", message_id: "A", content: "task-A" });
  await runStarted.get("task-A").promise;

  // B queued + old /steer s1 stuck in attachment download preflight
  dispatcher.enqueue({ chat_id: "chat-c", sender_id: "u1", message_id: "B", content: "task-B" });
  dispatcher.enqueue({
    chat_id: "chat-c",
    sender_id: "u1",
    message_id: "s1",
    content: "/steer stale-steer",
    attachments: [{ type: "file", messageId: "s1", path: "s1-claude.tmp" }],
  });
  await s1PreflightEntered.promise;

  // /clearqueue cancels B and s1
  dispatcher.enqueue({ chat_id: "chat-c", sender_id: "u1", message_id: "cq", content: "/clearqueue" });
  await waitFor(() => replies.some((r) => r.messageId === "cq"));
  assert.deepEqual(replies.find((r) => r.messageId === "cq").cleared, {
    removedQueued: 1, cancelledPreflight: 0, cancelledPendingSteers: 1,
  });

  s1PreflightGate.resolve();
  await waitFor(() => replies.some((r) => r.messageId === "s1"));
  assert.equal(replies.find((r) => r.messageId === "s1").text, STEER_CANCELLED_BY_CLEARQUEUE_REPLY);
  assert.deepEqual(cleaned.map((i) => i.path), ["s1-claude.tmp"]);
  assert.equal(steered.length, 0);

  // Post-clear /steer 1 succeeds and invokes client.steer(...)
  dispatcher.enqueue({ chat_id: "chat-c", sender_id: "u1", message_id: "s2", content: "/steer 1" });
  await waitFor(() => replies.some((r) => r.messageId === "s2"));
  assert.equal(steered.length, 1);
  assert.equal(steered[0][0].text, "1");

  // New task C executes after A finishes; B never executes
  dispatcher.enqueue({ chat_id: "chat-c", sender_id: "u1", message_id: "C", content: "task-C" });
  runGates.get("task-A").resolve();
  await runStarted.get("task-C").promise;
  runGates.get("task-C").resolve();
  await waitFor(() => dispatcher.activeJobs === 0);
  assert.deepEqual(executed, ["A", "C"]);
});

test("SCHED-003 Case 7: Antigravity /steer joins the running native turn out-of-band without queuing, while /clearqueue + C work", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-sched-agy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const session = { id: "ag-1", engine: "antigravity", title: "AG1" };
  const chat = { currentSessionId: "ag-1", sessions: [session] };
  const activeJobs = new Map();
  const replies = [];
  const executed = [];
  const jobGates = new Map();
  const steered = [];

  const agBridge = createAntigravityBridge({
    config: {
      stateDir: root,
      workspace: root,
      antigravityHome: root,
      antigravityCatalogRoot: root,
      antigravityProviderId: "official",
    },
    getSession: () => session,
    getChatState: () => chat,
    getChats: () => ({ "chat-ag": chat }),
    resetSession: () => session,
    saveSessions: () => {},
    userText: (c) => c,
    sendMarkdown: async (chatId, text, _kind, messageId) => { replies.push({ chatId, text, messageId }); },
    activeChildren: new Map(),
    activeJobs,
    appendText: () => {},
    reduceEvent: () => {},
    markPhase: () => {},
    ensureDone: () => {},
    markInterrupted: () => {},
    markError: () => {},
    queueSummary: () => "0",
  });
  t.after(() => agBridge.close());

  const dispatcher = createEventDispatcher({
    maxConcurrent: 1,
    chatIdOf: (e) => e.chat_id,
    messageIdOf: (e) => e.message_id,
    parseCommand: (e) => parseCommand(e.content, { engine: "antigravity" }),
    isOutOfBandCommand: (cmd) => Boolean(cmd?.name),
    handleOutOfBandCommand: async (event, command) => {
      if (command.name === "/clearqueue") {
        const cleared = clearQueuedWorkAndAdvanceGeneration({
          chatId: event.chat_id,
          all: false,
          clearEvents: (id, opts) => dispatcher.clearForChat(id, opts),
          activeJobs,
        });
        replies.push({ chatId: event.chat_id, messageId: event.message_id, cleared, text: formatClearQueueReply({ all: false, ...cleared, queueSummaryText: dispatcher.summary(event.chat_id) }) });
        return;
      }
      await agBridge.handleCommand(event, command);
    },
    handleEvent: async (event, control) => {
      if (!control.commit()) return;
      const gate = createDeferred();
      const client = { canSteer: () => true, steer: (payload) => { steered.push(payload); } };
      const job = { chatId: event.chat_id, mode: "antigravity", client, sessionId: "ag-1", clearGeneration: 0, pendingSteerEntries: [], steerInFlight: null };
      activeJobs.set(event.chat_id, job);
      jobGates.set(event.message_id, gate);
      executed.push(event.message_id);
      try {
        await gate.promise;
      } finally {
        if (activeJobs.get(event.chat_id) === job) activeJobs.delete(event.chat_id);
      }
    },
  });

  dispatcher.enqueue({ chat_id: "chat-ag", sender_id: "u1", message_id: "A", content: "task A" });
  await waitFor(() => activeJobs.has("chat-ag"));
  dispatcher.enqueue({ chat_id: "chat-ag", sender_id: "u1", message_id: "B", content: "task B" });

  // /clearqueue removes B; cancelledPendingSteers is always 0
  dispatcher.enqueue({ chat_id: "chat-ag", sender_id: "u1", message_id: "cq", content: "/clearqueue" });
  await waitFor(() => replies.some((r) => r.messageId === "cq"));
  assert.deepEqual(replies.find((r) => r.messageId === "cq").cleared, {
    removedQueued: 1, cancelledPreflight: 0, cancelledPendingSteers: 0,
  });

  // /steer is an out-of-band command: it joins the running native turn and is NEVER queued
  dispatcher.enqueue({ chat_id: "chat-ag", sender_id: "u1", message_id: "st-1", content: "/steer 另外把测试也跑一下" });
  await waitFor(() => replies.some((r) => r.messageId === "st-1"));
  assert.match(replies.find((r) => r.messageId === "st-1").text, /已将补充指令并入当前 Antigravity 任务/);
  assert.deepEqual(steered, [[{ type: "text", text: "另外把测试也跑一下" }]]);
  assert.deepEqual(session.messages.map((m) => m.content), ["另外把测试也跑一下"]);
  assert.equal(dispatcher.pendingCount, 0);

  // /fast also returns [原生限制] without queuing; /goal and /compact pass through natively to agy ACP
  dispatcher.enqueue({ chat_id: "chat-ag", sender_id: "u1", message_id: "f1", content: "/fast on" });
  await waitFor(() => replies.some((r) => r.messageId === "f1"));
  assert.match(replies.find((r) => r.messageId === "f1").text, /\[原生限制\]/);
  assert.equal(parseCommand("/goal finish x", { engine: "antigravity" }), null);
  assert.equal(parseCommand("/compact", { engine: "antigravity" }), null);

  // New task C queues and executes after A finishes
  dispatcher.enqueue({ chat_id: "chat-ag", sender_id: "u1", message_id: "C", content: "task C" });
  jobGates.get("A").resolve();
  await waitFor(() => executed.includes("C"));
  jobGates.get("C").resolve();
  await waitFor(() => dispatcher.activeJobs === 0);
  assert.deepEqual(executed, ["A", "C"]);
});

test("SCHED-003 Case 8: stale steer fails cleanly after task A finishes and next task C starts with clean clearGeneration=0", async () => {
  const preflightEntered = createDeferred();
  const preflightGate = createDeferred();
  const h = createCodexHarness({
    maxConcurrent: 1,
    preflightHook: async (event) => {
      if (event.message_id === "st-late") {
        preflightEntered.resolve();
        await preflightGate.promise;
      }
    },
  });

  h.dispatcher.enqueue({ chat_id: "chat-1", message_id: "A", content: "A" });
  await waitFor(() => h.activeJobs.has("chat-1"));
  h.dispatcher.enqueue({ chat_id: "chat-1", message_id: "cq", content: "/clearqueue" });
  await waitFor(() => h.replies.some((r) => r.messageId === "cq"));
  assert.equal(h.activeJobs.get("chat-1").clearGeneration, 1);

  // st-late starts preflight while A is still running
  h.dispatcher.enqueue({ chat_id: "chat-1", message_id: "st-late", content: "/steer late" });
  await preflightEntered.promise;

  // Task A ends while st-late is in preflight
  h.finishJob("A");
  await waitFor(() => !h.activeJobs.has("chat-1"));

  // Release st-late -> MUST report task ended without polluting next task
  preflightGate.resolve();
  await waitFor(() => h.replies.some((r) => r.messageId === "st-late"));
  assert.equal(h.replies.find((r) => r.messageId === "st-late").kind, "steer-ended");
  assert.match(h.replies.find((r) => r.messageId === "st-late").text, /已结束/);

  // Task C starts with fresh clearGeneration === 0
  h.dispatcher.enqueue({ chat_id: "chat-1", message_id: "C", content: "C" });
  await waitFor(() => h.activeJobs.has("chat-1"));
  assert.equal(h.activeJobs.get("chat-1").clearGeneration, 0);
  assert.deepEqual(h.activeJobs.get("chat-1").pendingSteerEntries, []);

  // Steer on C succeeds immediately
  h.dispatcher.enqueue({ chat_id: "chat-1", message_id: "st-c", content: "/steer on-C" });
  await waitFor(() => h.replies.some((r) => r.messageId === "st-c"));
  assert.equal(h.replies.find((r) => r.messageId === "st-c").kind, "steer-done");
  assert.deepEqual(h.steeredPayloads.map((p) => p.text), ["on-C"]);

  h.finishJob("C");
  await waitFor(() => h.dispatcher.activeJobs === 0);
});
