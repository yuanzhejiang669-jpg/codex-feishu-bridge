import fs from "node:fs";
import path from "node:path";
import { durationConfigLabel } from "../config/env.mjs";
import {
  markdown,
  truncateCardText,
} from "../feishu/cards/primitives.mjs";
import {
  FAST_SERVICE_TIER,
  STANDARD_SERVICE_TIER,
} from "../config/service-tier.mjs";
import openaiAccounts from "../codex/openai-accounts.cjs";
import { normalizeProviderTarget } from "./provider-target.mjs";
import { codexRuntimeVersionLines, readCodexRuntimeVersionStatus } from "../codex/runtime-version.mjs";
import { isProcessAlive as isProcessAlivePid } from "../runtime/process-runner.mjs";
import {
  STEER_CANCELLED_BY_CLEARQUEUE_REPLY,
  clearQueuedWorkAndAdvanceGeneration,
  ensureSteerEntry,
  formatClearQueueReply,
  isSteerEntryCancelled,
  markSteerEntryDispatched,
  removeSteerEntry,
} from "../runtime/steer-generation.mjs";
import {
  normalizeGoal,
  normalizeTokenUsage,
} from "../sessions/normalize.mjs";
import {
  compressIndexes,
  parseDeleteSelectionSpec,
} from "../sessions/delete-selection.mjs";
import {
  evaluateThreadHealth,
  markThreadHealthNotified,
  recordThreadHealthSample,
} from "../sessions/thread-health.mjs";
import { readThreadMetrics } from "../sessions/thread-metrics.mjs";
import {
  removeThreadFromRegisteredBridgeSessions,
  stateDirsForCodexHome,
} from "../sessions/codex-home-registry.mjs";
import { readJsonFile } from "../utils/json.mjs";
import {
  classifyCodexFailure,
  errorText,
  failureShortText,
  isNoGoalExistsError,
} from "../logging/errors.mjs";

export function createCommandRouter(deps = {}) {
  const {
    acceptedEfforts,
    capabilityOutcomeLines,
    mapReasoningEffort,
    reasoningReviewStatus,
    CONFIG,
    ENGINE_LABEL,
    log,
    addPendingAttachments,
    cleanupPendingAttachments,
    takePendingAttachments,
    withAttachmentLock,
    activeCodexJobs,
    activeGoalRuns,
    pendingDeleteConfirmations,
    stoppedJobs,
    runTool,
    terminateProcessTree,
    runLark,
    sendMarkdown,
    sendText,
    MODEL_REASONING_REGISTRY,
    REASONING_EFFORTS,
    PROVIDER_BUNDLES,
    findCodexProvider,
    findProviderBundle,
    listCodexProviders,
    providerBundleLabel,
    codexModelLabel,
    displayServiceTier,
    serviceTierForProviderDetail,
    getSession,
    resetSession,
    saveSessions,
    sessions,
    stats,
    eventDispatcher,
    recordChatScope,
    clearPendingEventsForChat,
    queueSummary,
    cleanupClearedDownloads,
  } = deps;
  const appServerSteerParams = (...args) => deps.appServerSteerParams(...args);
  const verifiedModels = deps.verifiedModels;
  const providerSwitcher = deps.providerSwitcher;
  const claudeBridge = deps.claudeBridge;
  const antigravityBridge = deps.antigravityBridge;

  const formatAttachmentCounts = (...args) => deps.formatAttachmentCounts(...args);
  const prepareCommandAttachments = (...args) => deps.prepareCommandAttachments(...args);
  const loadCodexThreadRecord = (...args) => deps.loadCodexThreadRecord(...args);
  const registeredCodexHomeRegistry = (...args) => deps.registeredCodexHomeRegistry(...args);
  const loadDeletedThreadIds = (...args) => deps.loadDeletedThreadIds(...args);
  const readCodexSessionIndexTitle = (...args) => deps.readCodexSessionIndexTitle(...args);
  const deleteCodexLocalThread = (...args) => deps.deleteCodexLocalThread(...args);
  const cleanOverride = (...args) => deps.cleanOverride(...args);
  const effectiveSessionSettings = (...args) => deps.effectiveSessionSettings(...args);
  const settingsSummary = (...args) => deps.settingsSummary(...args);
  const setSessionOverride = (...args) => deps.setSessionOverride(...args);
  const clearProviderBundleOverride = (...args) => deps.clearProviderBundleOverride(...args);
  const resetCurrentSession = (...args) => deps.resetCurrentSession(...args);
  const normalizeRenameTitle = (...args) => deps.normalizeRenameTitle(...args);
  const updateSessionGoal = (...args) => deps.updateSessionGoal(...args);
  const codexThreadLink = (...args) => deps.codexThreadLink(...args);
  const loadCodexThreadResumeInfo = (...args) => deps.loadCodexThreadResumeInfo(...args);
  const syncChatSessionsWithCodex = (...args) => deps.syncChatSessionsWithCodex(...args);
  const threadSourcesText = (...args) => deps.threadSourcesText(...args);
  const threadListGroup = (...args) => deps.threadListGroup(...args);
  const threadListGroupTitle = (...args) => deps.threadListGroupTitle(...args);
  const threadEntryIsRunnable = (...args) => deps.threadEntryIsRunnable(...args);
  const threadListStatusText = (...args) => deps.threadListStatusText(...args);
  const threadLocationText = (...args) => deps.threadLocationText(...args);
  const threadDeleteStateText = (...args) => deps.threadDeleteStateText(...args);
  const threadListTimeLabel = (...args) => deps.threadListTimeLabel(...args);
  const threadListTimeLabelName = (...args) => deps.threadListTimeLabelName(...args);
  const listChatSessionsSynced = (...args) => deps.listChatSessionsSynced(...args);
  const findSessionEntry = (...args) => deps.findSessionEntry(...args);
  const materializeSessionForChat = (...args) => deps.materializeSessionForChat(...args);
  const renameBridgeSessionsForThread = (...args) => deps.renameBridgeSessionsForThread(...args);
  const renameCodexThreadEverywhere = (...args) => deps.renameCodexThreadEverywhere(...args);
  const appendHistory = (...args) => deps.appendHistory(...args);
  const renderContextUsage = (...args) => deps.renderContextUsage(...args);
  const runtimeOptionsForSession = (...args) => deps.runtimeOptionsForSession(...args);
  const compactAppServerThread = (...args) => deps.compactAppServerThread(...args);
  const getAppServerGoal = (...args) => deps.getAppServerGoal(...args);
  const setAppServerGoal = (...args) => deps.setAppServerGoal(...args);
  const clearAppServerGoal = (...args) => deps.clearAppServerGoal(...args);
  const applyGoalRunNativeState = (...args) => deps.applyGoalRunNativeState(...args);
  const getGoalRunNativeState = (...args) => deps.getGoalRunNativeState(...args);
  const activeGoalRunForChat = (...args) => deps.activeGoalRunForChat(...args);
  const refreshGoalRunForNativeState = (...args) => deps.refreshGoalRunForNativeState(...args);
  const goalStatusIsActive = (...args) => deps.goalStatusIsActive(...args);
  const startGoalRun = (...args) => deps.startGoalRun(...args);
  const updateGoalRunGoal = (...args) => deps.updateGoalRunGoal(...args);
  const clearGoalRun = (...args) => deps.clearGoalRun(...args);
  const isActiveTurnRaceError = (...args) => deps.isActiveTurnRaceError(...args);
  const writeCodexConfigValue = (...args) => deps.writeCodexConfigValue(...args);
  const listCurrentProviderModels = (...args) => deps.listCurrentProviderModels(...args);
  const testCurrentProviderModel = (...args) => deps.testCurrentProviderModel(...args);
  const assertCurrentProviderModelAvailable = (...args) => deps.assertCurrentProviderModelAvailable(...args);

  async function handleCommand(event, command) {
    const chatId = event.chat_id;
    const messageId = event.message_id || event.id || chatId;
    try {
      const accessCtx = recordChatScope(chatId, event);
      if (CONFIG.engine === 'antigravity' && await antigravityBridge.handleCommand(event, command)) return;
      log("INFO", "command received", { messageId, chatId, command: command.name });
      if (CONFIG.engine === 'claude' && await claudeBridge.handleCommand(event, command)) return;

      switch (command.name) {
      case "/help":
        await sendMarkdown(chatId, helpMarkdown(), "help", messageId);
        return;
      case "/status":
        await sendMarkdown(chatId, await statusMarkdown(chatId), "status", messageId);
        return;
      case "/new": {
        if (activeCodexJobs.has(chatId)) {
          await sendText(chatId, "当前会话正在执行任务，请等待完成或先发送 /stop 后再执行 /new。", "new-busy", messageId);
          return;
        }
        const session = resetSession(chatId, command.rest || "新会话", accessCtx);
        await sendText(chatId, `已创建 ${ENGINE_LABEL} 会话 (${session.id})`, "new", messageId);
        return;
      }
      case "/how":
      case "/now":
        await sendMarkdown(chatId, await nowMarkdown(chatId), "now", messageId);
        return;
      case "/context":
        await sendMarkdown(chatId, await contextMarkdown(chatId), "context", messageId);
        return;
      case "/goal":
        await handleGoalCommand(chatId, command.rest, messageId);
        return;
      case "/provider":
        await handleProviderCommand(chatId, command.rest, messageId);
        return;
      case "/model":
        await handleModelCommand(chatId, command.rest, messageId);
        return;
      case "/effort":
        await handleEffortCommand(chatId, command.rest, messageId);
        return;
      case "/fast":
        await handleFastCommand(chatId, command.rest, messageId);
        return;
      case "/compact":
        await handleCompactCommand(chatId, messageId);
        return;
      case "/steer":
        await handleSteerCommand(event, command.rest, messageId);
        return;
      case "/stop":
        await stopCurrentJob(chatId, messageId, {
          clearMode: stopClearMode(command.rest),
        });
        return;
      case "/stopall":
        await stopAllActiveJobs(chatId, messageId);
        return;
      case "/queue":
        await sendText(chatId, `当前队列：${queueSummary(chatId)}`, "queue", messageId);
        return;
      case "/clearqueue":
      case "/clearqueueall":
        await clearQueueCommand(chatId, command.name === "/clearqueueall" ? "all" : command.rest, messageId);
        return;
      case "/sessions":
      case "/list": {
        const markdown = await sessionsMarkdown(chatId, command.rest);
        log("INFO", "sessions command rendered", { messageId, chatId, chars: markdown.length });
        await sendMarkdown(chatId, markdown, "sessions", messageId);
        log("INFO", "sessions command sent", { messageId, chatId });
        return;
      }
      case "/delete":
      case "/del":
      case "/rm":
        await handleDeleteCommand(chatId, command.rest, messageId);
        return;
      case "/confirm":
        await handleConfirmCommand(chatId, command.rest, messageId);
        return;
      case "/switch":
        await handleSwitchCommand(chatId, command.rest, messageId);
        return;
      case "/rename":
        await handleRenameCommand(chatId, command.rest, messageId);
        return;
      case "/reset": {
        if (activeCodexJobs.has(chatId)) {
          await sendText(chatId, "当前聊天有任务正在运行，请等待完成或先发送 /stop 后再执行 /reset。", "reset-busy", messageId);
          return;
        }
        const session = await resetCurrentSession(chatId);
        await sendText(
          chatId,
          `已清空当前 ${ENGINE_LABEL} 会话上下文：${session.title} (${session.id})。下一条普通消息会在当前会话里从空白上下文开始。`,
          "reset",
          messageId,
        );
        return;
      }
      default:
        await sendMarkdown(chatId, `未知命令：\`${command.name}\`\n\n发送 \`/help\` 查看可用命令。`, "unknown-command", messageId);
      }
    } catch (error) {
      log("ERROR", "command handling failed", {
        messageId,
        chatId,
        command: command?.name || "",
        error: String(error?.stack || error),
      });
      const detail = truncateCardText(errorText(error), 1200);
      const replyMd = `**${ENGINE_LABEL} 指令失败（\`${command?.name || "/command"}\`）**\n\n${detail}`;
      try {
        await sendMarkdown(chatId, replyMd, "command-error", messageId);
      } catch {
        try {
          await sendText(chatId, `${ENGINE_LABEL} 指令失败（${command?.name || "/command"}）：${detail}`, "command-error-fallback", messageId);
        } catch {}
      }
    }
  }

  async function handleSwitchCommand(chatId, target, messageId) {
    if (activeCodexJobs.has(chatId)) {
      await sendText(chatId, "当前聊天有任务正在运行，请等待完成或先发送 /stop 后再切换会话。", "switch-busy", messageId);
      return;
    }
    if (!target) {
      await sendText(chatId, "用法：/switch <序号或ID>。先发送 /sessions 查看可切换的会话。", "switch-usage", messageId);
      return;
    }
    await syncChatSessionsWithCodex(chatId);
    const match = await findSessionEntry(chatId, target);
    if (!match) {
      await sendText(chatId, "没有找到这个会话。发送 /sessions 查看可切换的会话。", "switch-miss", messageId);
      return;
    }
    if (!threadEntryIsRunnable(match.entry)) {
      await sendMarkdown(
        chatId,
        [
          "**会话不能续接**",
          "",
          `序号：${match.index}`,
          `会话：${match.entry.title || "未命名会话"} (${match.entry.id})`,
          `Thread：${codexThreadLink(match.entry.codexThreadId)}`,
          `状态：${threadListStatusText(match.entry)}`,
          "",
          "这个条目是异常绑定或残留记录，不能切成当前可运行会话。需要继续对话请用 `/new`；需要清理请用 `/delete <序号或ID>` 后按预览确认。",
        ].join("\n"),
        "switch-not-runnable",
        messageId,
      );
      return;
    }
    const session = materializeSessionForChat(chatId, match.entry);
    await sendText(chatId, `已切换到：${session.title || "未命名会话"} (${session.id})`, "switch", messageId);
  }

  function parseRenameCommand(rest) {
    const text = String(rest || "").trim();
    if (!text) return { title: "", target: "" };
    if (/^\d+$/.test(text)) return { title: "", target: text };
    const match = text.match(/^(\d+)\s+(.+)$/s);
    if (match) {
      return {
        target: match[1],
        title: normalizeRenameTitle(match[2]),
      };
    }
    return {
      target: "",
      title: normalizeRenameTitle(text),
    };
  }

  async function handleRenameCommand(chatId, rest, messageId) {
    if (activeCodexJobs.has(chatId)) {
      await sendText(chatId, "当前会话正在运行，请等待本轮结束后再重命名。", "rename-busy", messageId);
      return;
    }
    const parsed = parseRenameCommand(rest);
    if (!parsed.title) {
      await sendText(chatId, "用法：/rename 新标题；或 /rename <list序号> 新标题。", "rename-usage", messageId);
      return;
    }

    await syncChatSessionsWithCodex(chatId);
    let entry = null;
    let index = 0;
    if (parsed.target) {
      const match = await findSessionEntry(chatId, parsed.target);
      if (!match) {
        await sendText(chatId, "没有找到这个会话。先发送 /list 查看可改名的会话序号。", "rename-miss", messageId);
        return;
      }
      entry = match.entry;
      index = match.index;
    } else {
      const current = getSession(chatId);
      entry = {
        ...current,
        _sourceChatId: chatId,
        _isCurrent: true,
      };
    }

    const oldTitle = entry.title || "";
    const threadId = String(entry.codexThreadId || "").trim();
    const bridgeResult = renameBridgeSessionsForThread(chatId, entry, parsed.title);
    const codexResult = threadId
      ? await renameCodexThreadEverywhere(threadId, parsed.title)
      : { source: null, desktop: null };

    log("INFO", "session renamed", {
      chatId,
      messageId,
      target: parsed.target || "current",
      index,
      sessionId: entry.id || "",
      threadId,
      oldTitle,
      newTitle: parsed.title,
      bridge: bridgeResult,
      codex: codexResult,
    });

    const changedParts = [];
    if (bridgeResult.changed) changedParts.push(`Bridge绑定 ${bridgeResult.renamed} 条`);
    if (codexResult.source?.dbChanged) changedParts.push("当前 Codex Home DB");
    if (codexResult.source?.sessionIndexChanged) changedParts.push("当前 Codex Home session_index");
    if (codexResult.desktop?.dbChanged) changedParts.push("桌面镜像 DB");
    if (codexResult.desktop?.sessionIndexChanged) changedParts.push("桌面镜像 session_index");

    await sendMarkdown(
      chatId,
      [
        "**会话已改名**",
        "",
        `原标题：${oldTitle || "未命名会话"}`,
        `新标题：${parsed.title}`,
        parsed.target ? `序号：${index}` : "目标：当前会话",
        `Bridge会话：${entry.id || "未知"}`,
        `Codex thread：${threadId ? `\`${threadId}\`` : "尚未创建"}`,
        "",
        `已更新：${changedParts.length ? changedParts.join("、") : "仅确认标题，无可写入位置变化"}`,
      ].join("\n"),
      "rename",
      messageId,
    );
  }

  function cleanupPendingDeleteConfirmations() {
    const now = Date.now();
    for (const [key, pending] of pendingDeleteConfirmations) {
      if (!pending?.expiresAt || pending.expiresAt <= now) pendingDeleteConfirmations.delete(key);
    }
  }

  function deleteConfirmationKey(chatId, index) {
    return `${String(chatId || "")}\n${String(index || "").trim()}`;
  }

  function forgetDeleteConfirmationsForThread(threadId) {
    const id = String(threadId || "").trim();
    if (!id) return;
    for (const [key, pending] of pendingDeleteConfirmations) {
      if (
        pending?.threadId === id
        || (Array.isArray(pending?.items) && pending.items.some((item) => item?.threadId === id))
      ) {
        pendingDeleteConfirmations.delete(key);
      }
    }
  }

  function activeJobUsesThread(threadId) {
    const id = String(threadId || "").trim();
    if (!id) return false;
    for (const [jobChatId, job] of activeCodexJobs) {
      if (job?.threadId === id) return true;
      const chatState = sessions.chats[jobChatId];
      const jobSession = chatState?.sessions?.find((session) => session.id === job?.sessionId);
      if (String(jobSession?.codexThreadId || "").trim() === id) return true;
    }
    return false;
  }

  function persistedActiveRunUsesThread(threadId) {
    const id = String(threadId || "").trim();
    if (!id) return false;
    for (const stateDir of registeredCodexHomeRegistry().stateDirs) {
      const active = readJsonFile(path.join(stateDir, "active-runs.json"));
      const runs = active?.runs && typeof active.runs === "object" ? Object.values(active.runs).filter(Boolean) : [];
      if (!runs.length) continue;
      const persistedSessions = readJsonFile(path.join(stateDir, "sessions.json"));
      for (const run of runs) {
        const bridgePid = Number(run?.bridgePid || 0);
        if (bridgePid > 0 && !isProcessAlivePid(bridgePid)) continue;
        const sessionId = String(run?.sessionId || "").trim();
        if (!sessionId) continue;
        for (const chatState of Object.values(persistedSessions?.chats || {})) {
          const session = Array.isArray(chatState?.sessions)
            ? chatState.sessions.find((item) => String(item?.id || "").trim() === sessionId)
            : null;
          if (String(session?.codexThreadId || "").trim() === id) return true;
        }
      }
    }
    return false;
  }

  function threadIsActiveAnywhere(threadId) {
    return activeJobUsesThread(threadId) || persistedActiveRunUsesThread(threadId);
  }

  function removeThreadFromBridgeSessions(threadId) {
    const id = String(threadId || "").trim();
    let removed = 0;
    let changed = false;
    for (const chatState of Object.values(sessions.chats || {})) {
      if (!chatState || !Array.isArray(chatState.sessions)) continue;
      const before = chatState.sessions.length;
      chatState.sessions = chatState.sessions.filter((session) => String(session.codexThreadId || "").trim() !== id);
      removed += before - chatState.sessions.length;
      if (!chatState.sessions.some((session) => session.id === chatState.currentSessionId)) {
        chatState.currentSessionId = chatState.sessions[0]?.id || "";
      }
      if (before !== chatState.sessions.length) changed = true;
    }
    if (changed) saveSessions();
    return removed;
  }

  function removeDeletedThreadsFromBridgeSessions() {
    const deletedThreadIds = loadDeletedThreadIds(CONFIG.codexHome);
    if (CONFIG.desktopCodexHome) {
      for (const id of loadDeletedThreadIds(CONFIG.desktopCodexHome)) deletedThreadIds.add(id);
    }
    if (!deletedThreadIds.size) return 0;
    let removed = 0;
    for (const threadId of deletedThreadIds) removed += removeThreadFromBridgeSessions(threadId);
    return removed;
  }

  function deletePreviewMarkdown({ entry, record, index, expiresAt }) {
    const threadId = String(entry.codexThreadId || record.id || "").trim();
    const status = threadListStatusText(entry);
    const currentNote = entry._isCurrent ? "是。删除后会清理当前 Bridge 绑定，下一条普通消息会创建新会话。" : "否";
    return [
      "**Codex 会话删除确认**",
      "",
      "这会执行 Codex++ 等价的本地删除：删除 Codex 本地索引记录、清理关联表、删除 rollout 会话文件，并移除飞书绑定。",
      "",
      `序号：${index}`,
      `标题：${entry.title || record.title || "未命名会话"}`,
      `Thread：${codexThreadLink(threadId)}`,
      `本地会话：${entry.id || ""}`,
      `状态：${status}`,
      `是否当前会话：${currentNote}`,
      `来源：${threadSourcesText(entry)}`,
      `Rollout：\`${record.rollout_path || "未记录"}\``,
      `确认有效期：${formatTime(expiresAt)}`,
      "",
      `确认删除请输入：\`/confirm delete ${index}\``,
    ].join("\n");
  }

  async function resolveDeleteItemsByIndexes(chatId, indexes) {
    const list = await listChatSessionsSynced(chatId);
    const items = [];
    const errors = [];
    for (const index of indexes) {
      if (index < 1 || index > list.length) {
        errors.push(`序号 ${index} 超出当前列表范围。`);
        continue;
      }

      const entry = list[index - 1];
      const threadId = String(entry.codexThreadId || "").trim();
      if (!threadId) {
        errors.push(`序号 ${index} 还没有 Codex 原生 thread。`);
        continue;
      }
      if (entry._deletable === false) {
        errors.push(`序号 ${index} 不可删除：${entry._deleteBlockReason || "来源信息不足"}`);
        continue;
      }
      if (threadIsActiveAnywhere(threadId)) {
        errors.push(`序号 ${index} 正在运行中。`);
        continue;
      }

      const record = await loadCodexThreadRecord(threadId);

      items.push({
        index,
        threadId,
        sessionId: entry.id || "",
        title: entry.title || record?.title || "",
        rolloutPath: record?.rollout_path || entry._rolloutPath || "",
        sources: Array.isArray(entry._sources) ? [...entry._sources] : [],
        status: threadListStatusText(entry),
        group: threadListGroup(entry),
        isCurrent: Boolean(entry._isCurrent),
      });
    }

    return { items, errors, list };
  }

  function deleteBatchPreviewMarkdown({ items, expiresAt, confirmText }) {
    const groupCounts = new Map();
    for (const item of items) {
      groupCounts.set(item.group || "unknown", (groupCounts.get(item.group || "unknown") || 0) + 1);
    }
    const summary = ["current", "normal", "broken", "residue"]
      .map((group) => {
        const count = groupCounts.get(group) || 0;
        return count ? `${threadListGroupTitle(group)} ${count}` : "";
      })
      .filter(Boolean)
      .join("；");
    const lines = [
      "**Codex 会话批量删除确认**",
      "",
      "这会执行 Codex++ 等价的本地删除：删除 Codex 本地索引记录、清理关联表、删除 rollout 会话文件，并移除飞书绑定。",
      "",
      `待删除：${items.length} 条`,
      summary ? `分类：${summary}` : "",
      items.some((item) => item.isCurrent) ? "包含当前会话：是。确认后会清理当前 Bridge 绑定，下一条普通消息会创建新会话。" : "",
      `确认有效期：${formatTime(expiresAt)}`,
      "",
      ...items.map((item) => `${item.index}. ${item.title || "未命名会话"} · ${codexThreadLink(item.threadId)} · ${item.status || ""} · 来源：${threadSourcesText(item)}`),
      "",
      `确认删除请输入：\`/confirm delete ${confirmText}\``,
    ].filter((line) => line !== "");
    return lines.join("\n");
  }

  function pendingDeleteItems(pending) {
    if (Array.isArray(pending?.items) && pending.items.length) return pending.items;
    if (pending?.threadId) {
      return [{
        index: pending.index,
        threadId: pending.threadId,
        sessionId: pending.sessionId || "",
        title: pending.title || "",
        rolloutPath: pending.rolloutPath || "",
        sources: Array.isArray(pending.sources) ? [...pending.sources] : [],
        status: pending.status || "",
        group: pending.group || "",
        isCurrent: Boolean(pending.isCurrent),
      }];
    }
    return [];
  }

  async function handleDeleteCommand(chatId, target, messageId) {
    if (activeCodexJobs.has(chatId)) {
      await sendText(chatId, "当前聊天有任务正在运行，请先 /stop 或等待结束后再执行 /delete。", "delete-busy", messageId);
      return;
    }
    if (!target) {
      await sendText(chatId, "用法：/delete <序号或ID>、/delete 1 2 3、/delete 1-18、/delete 3-7 8-12。先发送 /list 查看会话；删除需要二次确认。", "delete-usage", messageId);
      return;
    }

    await syncChatSessionsWithCodex(chatId);
    const selection = parseDeleteSelectionSpec(target);
    if (selection.error) {
      await sendText(chatId, selection.error, "delete-selection-error", messageId);
      return;
    }

    if (selection.indexes) {
      const { items, errors } = await resolveDeleteItemsByIndexes(chatId, selection.indexes);
      if (errors.length || items.length !== selection.indexes.length) {
        await sendMarkdown(
          chatId,
          [
            "**Codex 会话删除预检失败**",
            "",
            ...errors.map((line) => `- ${line}`),
            "",
            "请重新发送 `/list` 确认序号后再删除。",
          ].join("\n"),
          "delete-precheck-error",
          messageId,
        );
        return;
      }

      const expiresAt = Date.now() + CONFIG.deleteConfirmTtlMs;
      const confirmText = compressIndexes(items.map((item) => item.index));
      const key = deleteConfirmationKey(chatId, confirmText);
      cleanupPendingDeleteConfirmations();
      pendingDeleteConfirmations.set(key, {
        chatId,
        index: confirmText,
        items,
        createdAt: Date.now(),
        expiresAt,
      });

      await sendMarkdown(
        chatId,
        items.length === 1
          ? deletePreviewMarkdown({
              entry: { ...items[0], id: items[0].sessionId, codexThreadId: items[0].threadId, _isCurrent: Boolean(items[0].isCurrent) },
              record: { id: items[0].threadId, title: items[0].title, rollout_path: items[0].rolloutPath },
              index: items[0].index,
              expiresAt,
            })
          : deleteBatchPreviewMarkdown({ items, expiresAt, confirmText }),
        "delete-preview",
        messageId,
      );
      return;
    }

    const match = await findSessionEntry(chatId, selection.target);
    if (!match) {
      await sendText(chatId, "没有找到这个会话。发送 /list 查看可删除的会话。", "delete-miss", messageId);
      return;
    }

    const entry = match.entry;
    const threadId = String(entry.codexThreadId || "").trim();
    if (!threadId) {
      await sendText(chatId, "这个条目还没有 Codex 原生 thread，不能执行 Codex++ 等价删除。", "delete-no-thread", messageId);
      return;
    }
    if (entry._deletable === false) {
      await sendText(chatId, `这个条目不可删除：${entry._deleteBlockReason || "来源信息不足"}`, "delete-blocked", messageId);
      return;
    }
    if (threadIsActiveAnywhere(threadId)) {
      await sendText(chatId, "这个会话正在运行中，先 /stop 或等待任务结束后再删除。", "delete-busy", messageId);
      return;
    }

    const record = await loadCodexThreadRecord(threadId) || {
      id: threadId,
      title: entry.title || readCodexSessionIndexTitle(threadId) || "",
      rollout_path: entry._rolloutPath || "",
    };

    cleanupPendingDeleteConfirmations();
    const expiresAt = Date.now() + CONFIG.deleteConfirmTtlMs;
    pendingDeleteConfirmations.set(deleteConfirmationKey(chatId, match.index), {
      chatId,
      threadId,
      sessionId: entry.id || "",
      index: match.index,
      title: entry.title || record.title || "",
      rolloutPath: record.rollout_path || entry._rolloutPath || "",
      sources: Array.isArray(entry._sources) ? [...entry._sources] : [],
      status: threadListStatusText(entry),
      group: threadListGroup(entry),
      isCurrent: Boolean(entry._isCurrent),
      createdAt: Date.now(),
      expiresAt,
    });

    await sendMarkdown(
      chatId,
      deletePreviewMarkdown({ entry, record, index: match.index, expiresAt }),
      "delete-preview",
      messageId,
    );
  }

  async function handleConfirmCommand(chatId, rest, messageId) {
    if (activeCodexJobs.has(chatId)) {
      await sendText(chatId, "当前聊天有任务正在运行，请先 /stop 或等待结束后再执行 /delete。", "confirm-busy", messageId);
      return;
    }
    const [actionRaw, ...targetParts] = String(rest || "").trim().split(/\s+/);
    const action = String(actionRaw || "").toLowerCase();
    const targetText = targetParts.join(" ").trim();
    const selection = parseDeleteSelectionSpec(targetText);
    const confirmText = selection.indexes ? compressIndexes(selection.indexes) : targetText;
    if (action !== "delete" || !confirmText || selection.error || selection.target) {
      await sendText(chatId, "用法：/confirm delete <序号或区间>。先用 /delete <序号或区间> 发起删除确认。", "confirm-usage", messageId);
      return;
    }

    cleanupPendingDeleteConfirmations();
    const key = deleteConfirmationKey(chatId, confirmText);
    const pending = pendingDeleteConfirmations.get(key);
    if (!pending || pending.chatId !== chatId) {
      await sendText(chatId, "删除确认不存在或已过期。请重新发送 /delete <序号或区间>。", "confirm-miss", messageId);
      return;
    }

    const items = pendingDeleteItems(pending);
    if (!items.length) {
      pendingDeleteConfirmations.delete(key);
      await sendText(chatId, "删除确认内容为空或损坏。请重新发送 /delete。", "confirm-miss", messageId);
      return;
    }

    const busy = [];
    for (const item of items) {
      if (threadIsActiveAnywhere(item.threadId)) busy.push(item.index);
    }
    if (busy.length) {
      await sendText(chatId, `这些会话正在运行中，先 /stop 或等待任务结束后再删除：${busy.join("、")}`, "confirm-busy", messageId);
      return;
    }

    const successes = [];
    const failures = [];
    let bridgeRemovedTotal = 0;
    for (const item of items) {
      try {
        if (threadIsActiveAnywhere(item.threadId)) {
          throw new Error(`会话已开始运行，已跳过删除：${item.threadId}`);
        }
        const result = await deleteCodexLocalThread(item.threadId);
        const registry = registeredCodexHomeRegistry();
        const sameHomeStateDirs = stateDirsForCodexHome(registry, CONFIG.codexHome);
        const externalBindings = removeThreadFromRegisteredBridgeSessions(
          sameHomeStateDirs,
          item.threadId,
          { excludeStateDirs: [CONFIG.stateDir] },
        );
        const bridgeRemoved = removeThreadFromBridgeSessions(item.threadId) + externalBindings.removed;
        bridgeRemovedTotal += bridgeRemoved;
        forgetDeleteConfirmationsForThread(item.threadId);
        successes.push({ item, result, bridgeRemoved });
        log("INFO", "codex local thread deleted", {
          chatId,
          threadId: item.threadId,
          rolloutDeleted: result.rolloutDeleted,
          rolloutMissing: result.rolloutMissing,
          rolloutError: result.rolloutError,
          bridgeRemoved,
        });
      } catch (error) {
        failures.push({ item, error });
      }
    }
    pendingDeleteConfirmations.delete(key);

    if (failures.length && !successes.length) {
      await sendMarkdown(
        chatId,
        [
          "**Codex 会话删除失败**",
          "",
          ...failures.map(({ item, error }) => `${item.index}. ${item.title || "未命名会话"} · ${codexThreadLink(item.threadId)}\n\`\`\`\n${String(error.message || error).slice(0, 1000)}\n\`\`\``),
        ].join("\n"),
        "delete-error",
        messageId,
      );
      return;
    }

    const single = successes.length === 1 && failures.length === 0;
    const status = single && successes[0].result.rolloutError
      ? "Codex 会话已从本地库删除，但 rollout 文件删除失败"
      : single && successes[0].result.sidebarIndexError
        ? "Codex 会话已从本地库删除，但侧边栏辅助索引清理失败"
      : single
        ? "Codex 会话已删除"
        : failures.length
          ? "Codex 会话批量删除部分完成"
          : "Codex 会话批量删除完成";
    await sendMarkdown(
      chatId,
      single
        ? [
            `**${status}**`,
            "",
            `标题：${successes[0].item.title || successes[0].result.title || "未命名会话"}`,
            `Thread：${codexThreadLink(successes[0].item.threadId)}`,
            successes[0].item.status ? `删除前状态：${successes[0].item.status}` : "",
            `飞书绑定清理：${successes[0].bridgeRemoved} 条`,
            successes[0].item.isCurrent ? "当前会话绑定：已清理；下一条普通消息会创建新会话。" : "",
            `Rollout：${successes[0].result.rolloutDeleted ? "已删除" : successes[0].result.rolloutMissing ? "原本不存在" : successes[0].result.rolloutError ? "删除失败" : "未记录"}`,
            `侧边栏索引：session_index ${successes[0].result.sidebarIndexChanged ? "已清理" : "无对应项"}；global-state ${successes[0].result.globalStateChanged ? "已清理" : "无对应项"}`,
            successes[0].result.desktopMirror?.enabled ? `桌面端镜像：DB ${successes[0].result.desktopMirror.dbChanged ? "已清理" : "无对应项"}；session_index ${successes[0].result.desktopMirror.sessionIndexChanged ? "已清理" : "无对应项"}；global-state ${successes[0].result.desktopMirror.globalStateChanged ? "已清理" : "无对应项"}；rollout ${successes[0].result.desktopMirror.rolloutDeleted ? "已删除" : successes[0].result.desktopMirror.rolloutMissing ? "原本不存在" : "未记录"}` : "",
            successes[0].result.rolloutPath ? `路径：\`${successes[0].result.rolloutPath}\`` : "",
            successes[0].result.desktopMirror?.rolloutPath ? `桌面端镜像 Rollout：\`${successes[0].result.desktopMirror.rolloutPath}\`` : "",
            successes[0].result.rolloutError ? ["", "```", successes[0].result.rolloutError.slice(0, 1200), "```"].join("\n") : "",
            successes[0].result.sidebarIndexError ? ["", "```", successes[0].result.sidebarIndexError.slice(0, 1200), "```"].join("\n") : "",
            successes[0].result.desktopMirror?.error ? ["", "```", successes[0].result.desktopMirror.error.slice(0, 1200), "```"].join("\n") : "",
          ].filter(Boolean).join("\n")
        : [
            `**${status}**`,
            "",
            `成功：${successes.length} 条`,
            `失败：${failures.length} 条`,
            `飞书绑定清理：${bridgeRemovedTotal} 条`,
            successes.some(({ item }) => item.isCurrent) ? "当前会话绑定：已清理；下一条普通消息会创建新会话。" : "",
            `侧边栏索引清理：session_index ${successes.filter(({ result }) => result.sidebarIndexChanged).length} 条；global-state ${successes.filter(({ result }) => result.globalStateChanged).length} 条`,
            `桌面端镜像清理：DB ${successes.filter(({ result }) => result.desktopMirror?.dbChanged).length} 条；session_index ${successes.filter(({ result }) => result.desktopMirror?.sessionIndexChanged).length} 条；global-state ${successes.filter(({ result }) => result.desktopMirror?.globalStateChanged).length} 条；rollout ${successes.filter(({ result }) => result.desktopMirror?.rolloutDeleted).length} 条`,
            "",
            ...successes.map(({ item }) => `- 已删除 ${item.index}. ${item.title || "未命名会话"} · ${compactThreadId(item.threadId)}`),
            failures.length ? "" : "",
            ...failures.map(({ item, error }) => `- 删除失败 ${item.index}. ${item.title || "未命名会话"} · ${compactThreadId(item.threadId)}：${String(error.message || error).slice(0, 300)}`),
          ].filter(Boolean).join("\n"),
      "delete-done",
      messageId,
    );
  }

  async function handleGoalCommand(chatId, rest, messageId) {
    await syncChatSessionsWithCodex(chatId);
    const session = getSession(chatId);
    const text = String(rest || "").trim();
    const action = text.toLowerCase();
    let activeRun = await refreshGoalRunForNativeState(chatId, session, activeGoalRunForChat(chatId, session));
    log("INFO", "codex goal command received", {
      chatId,
      sessionId: session.id,
      action: action || "status",
      hasActiveRun: Boolean(activeRun),
      textLength: text.length,
    });

    try {
      if (!text || action === "status" || action === "view") {
        const goal = activeRun ? await getGoalRunNativeState(activeRun) : await getAppServerGoal(session);
        await sendMarkdown(chatId, goalMarkdown(session, goal), "goal-status", messageId);
        return;
      }

      if (action === "clear" || action === "delete" || action === "remove") {
        const cleared = activeRun ? await clearGoalRun(activeRun) : await clearAppServerGoal(session);
        await sendText(chatId, cleared ? "已清除当前 Codex goal。" : "当前会话没有可清除的 Codex goal。", "goal-clear", messageId);
        return;
      }

      if (action === "pause") {
        const current = activeRun ? await getGoalRunNativeState(activeRun) : await getAppServerGoal(session);
        if (!current) {
          await sendText(chatId, "当前会话还没有 Codex goal，先用 /goal <目标> 设置。", "goal-pause-none", messageId);
          return;
        }
        const goal = activeRun
          ? await updateGoalRunGoal(activeRun, { status: "paused" })
          : await setAppServerGoal(session, { status: "paused" });
        await sendMarkdown(chatId, goalMarkdown(session, goal, "已暂停 Codex goal"), "goal-pause", messageId);
        return;
      }

      if (action === "resume") {
        const current = activeRun ? await getGoalRunNativeState(activeRun) : await getAppServerGoal(session);
        if (!current) {
          await sendText(chatId, "当前会话还没有 Codex goal，先用 /goal <目标> 设置。", "goal-resume-none", messageId);
          return;
        }
        const goal = activeRun
          ? await updateGoalRunGoal(activeRun, { status: "active" })
          : (await startGoalRun(chatId, { chat_id: chatId, message_id: messageId, id: messageId, content: JSON.stringify({ text: `/goal resume` }) }, session, { status: "active" })).goal;
        if (activeRun) await sendMarkdown(chatId, goalMarkdown(session, goal, "已恢复 Codex goal"), "goal-resume", messageId);
        return;
      }

      if (text.length > 4000) {
        await sendText(chatId, "Goal 目标最长 4000 字。更长说明请放到文件里，再在 goal 里引用文件路径。", "goal-too-long", messageId);
        return;
      }

      const job = activeCodexJobs.get(chatId);
      if (job && job.mode !== "app-server-goal") {
        await sendText(chatId, "当前 Codex 任务还在运行，等这一轮结束后再设置 goal，或先发送 /stop。", "goal-busy", messageId);
        return;
      }

      let goal = null;
      if (activeRun) {
        goal = await updateGoalRunGoal(activeRun, { objective: text, status: "active" });
        if (!goal && activeRun.goalCleared) {
          if (activeGoalRuns.get(chatId) === activeRun) activeGoalRuns.delete(chatId);
          activeRun = null;
        }
      }
      if (!activeRun) {
        goal = (await startGoalRun(chatId, { chat_id: chatId, message_id: messageId, id: messageId, content: JSON.stringify({ text: `/goal ${text}` }) }, session, { objective: text, status: "active" })).goal;
      }
      if (activeRun) await sendMarkdown(chatId, goalMarkdown(session, goal, "已更新 Codex goal"), "goal-set", messageId);
    } catch (error) {
      const failure = classifyCodexFailure(error);
      await sendMarkdown(
        chatId,
        [
          "**Codex goal 操作失败**",
          "",
          failureShortText(failure),
          "",
          "```",
          truncateCardText(errorText(error), 1500),
          "```",
        ].join("\n"),
        "goal-error",
        messageId,
      );
    }
  }

  function commandArgs(rest) {
    return String(rest || "").trim().split(/\s+/).filter(Boolean);
  }

  async function handleProviderCommand(chatId, rest, messageId) {
    const args = commandArgs(rest);
    const action = String(args[0] || '').toLowerCase();
    if (!args.length || ['status', 'view', 'check', 'list', 'shortcut', 'shortcuts', 'bundle', 'bundles'].includes(action)) {
      const session = getSession(chatId);
      if (action === 'list') {
        const shortcuts = ['shortcut', 'shortcuts', 'bundle', 'bundles'].includes(String(args[1] || '').toLowerCase());
        await sendMarkdown(chatId, shortcuts ? providerShortcutListMarkdown(session) : providerListMarkdown(session), shortcuts ? 'provider-shortcuts' : 'provider-list', messageId);
      }
      else if (['shortcut', 'shortcuts', 'bundle', 'bundles'].includes(action)) await sendMarkdown(chatId, providerShortcutListMarkdown(session), 'provider-shortcuts', messageId);
      else await sendMarkdown(chatId, providerStatusMarkdown(session), 'provider-status', messageId);
      return;
    }
    if (activeCodexJobs.has(chatId) || eventDispatcher.isChatActive(chatId, messageId)) {
      await sendText(chatId, '当前会话有任务正在执行，请在任务结束后切换账号或 Provider。', 'provider-busy', messageId); return;
    }
    await openaiAccounts.discoverAccount(openaiAccounts.accountsRoot(), CONFIG.codexHome);
    await syncChatSessionsWithCodex(chatId, { ensureRunnableCurrent: false });
    const session = getSession(chatId);
    const target = { ...session };
    const persist = action === 'save';
    const id = normalizeProviderTarget(persist ? args.slice(1).join(' ') : args.join(' '));
    let defaults = null;
    try {
      if (['clear', 'default', 'reset'].includes(action)) {
        target.providerOverride = ''; target.openaiAccountOverride = '';
        clearProviderBundleOverride(target);
      } else {
        const savedAccount = openaiAccounts.listAccounts(openaiAccounts.accountsRoot()).find(account => account.alias === id);
        const bundle = savedAccount ? null : findProviderBundle(id);
        const provider = savedAccount ? { id: 'openai' } : findCodexProvider(bundle?.provider || id);
        if (!provider) { await sendMarkdown(chatId, providerListMarkdown(session, '没有找到 provider：' + id), 'provider-miss', messageId); return; }
        if (savedAccount) openaiAccounts.readAccountAuth(openaiAccounts.accountsRoot(), savedAccount.alias);
        clearProviderBundleOverride(target);
        target.providerOverride = provider.id;
        target.openaiAccountOverride = savedAccount?.alias || '';
        if (bundle) {
          target.providerBundleOverride = bundle.id; target.modelOverride = bundle.model;
          if (bundle.reasoning) target.reasoningOverride = bundle.reasoning;
        }
        if (persist) defaults = { values: { model_provider: provider.id,
          ...(bundle ? { model: bundle.model, ...(bundle.reasoning ? { model_reasoning_effort: bundle.reasoning } : {}) } : {}) }, account: savedAccount?.alias || '' };
      }
      await providerSwitcher.switch(session, target, defaults);
      await sendMarkdown(chatId, providerStatusMarkdown(session, persist ? '已接续当前会话，并保存默认设置。' : '已接续当前会话，历史与工作区保留。'), 'provider-set', messageId);
    } catch (error) {
      await sendMarkdown(chatId, runtimeCommandErrorMarkdown('Provider 切换未完成，原绑定保留', error), 'provider-error', messageId);
    }
  }

  function providerStatusMarkdown(session, title = "Codex provider") {
    const settings = effectiveSessionSettings(session);
    const provider = findCodexProvider(settings.provider);
    const bundle = findProviderBundle(session.providerBundleOverride);
    const lines = [
      `**${title}**`,
      "",
      `当前会话：\`${session.title || "未命名会话"}\` (${session.id})`,
      session.providerSwitchTransaction ? '切换准备中；当前显示的仍是已生效设置。' : '',
      session.codexThreadTransition?.phase === 'uncertain' ? '此前接续结果尚待核实，原会话绑定保留。' : '',
      `当前 provider：\`${settings.accountAlias || settings.provider || "默认"}\`${session.providerOverride ? "（会话覆盖）" : "（配置默认）"}`,
      bundle ? `当前组合：\`${bundle.id}\`；${providerBundleLabel(bundle)}` : "",
      provider ? providerDetailLine(provider) : "provider 未在当前 config.toml 中找到；如果它来自 profile 或外部配置，请确认 Bridge 启动参数也选择了对应配置。",
      "",
      `当前运行设置：${settingsSummary(session)}`,
      "",
      "用法：`/provider list`、`/provider shortcuts`、`/provider <providerId>`、`/provider save <providerId>`、`/provider clear`",
    ];
    return lines.join("\n");
  }

  function providerListMarkdown(session, title = "Codex provider 列表") {
    const settings = effectiveSessionSettings(session);
    const providers = listCodexProviders();
    const lines = [`**${title}**`, ""];
    for (const provider of providers) {
      const marker = !settings.accountAlias && provider.id === settings.provider ? " ← 当前" : "";
      lines.push(`- \`${provider.id}\`${marker}：${provider.name || provider.id}；${providerDetailLine(provider)}`);
    }
    for (const account of openaiAccounts.listAccounts(openaiAccounts.accountsRoot())) {
      const marker = account.alias === settings.accountAlias ? " ← 当前" : "";
      lines.push(`- \`${account.alias}\`${marker}：OpenAI 官方账号；${account.state === "saved" ? "已保存登录" : "需要重新登录"}`);
    }
    if (settings.accountAlias && !openaiAccounts.listAccounts(openaiAccounts.accountsRoot()).some((item) => item.alias === settings.accountAlias)) {
      lines.push(`- \`${settings.accountAlias}\` ← 当前：账号已移除或不可用；请重新选择，不会自动使用其他账号`);
    }
    lines.push("");
    lines.push("只切当前飞书会话：`/provider <providerId>`");
    lines.push("同时写入用户级 config.toml：`/provider save <providerId>`");
    lines.push("查看旧组合快捷方式：`/provider shortcuts`");
    return lines.join("\n");
  }

  function providerShortcutListMarkdown(session, title = "Codex provider 快捷组合") {
    const lines = [`**${title}**`, ""];
    if (!PROVIDER_BUNDLES.length) {
      lines.push("当前没有配置快捷组合。");
      return lines.join("\n");
    }
    for (const bundle of PROVIDER_BUNDLES) {
      const marker = bundle.id === session.providerBundleOverride ? " ← 当前" : "";
      const exists = findCodexProvider(bundle.provider);
      const availability = exists ? "" : "；底层 provider 未配置";
      lines.push(`- \`${bundle.id}\`${marker}：${bundle.name}；${providerBundleLabel(bundle)}${availability}`);
    }
    lines.push("");
    lines.push("快捷组合仍可直接使用，例如：`/provider m2c-kimi`。");
    lines.push("它会同时设置 provider、model 和 reasoning；默认 `/provider list` 只显示真实 Codex provider。");
    return lines.join("\n");
  }

  function providerDetailLine(provider) {
    if (!provider) return "";
    const parts = [];
    if (provider.baseUrl) parts.push(`base_url ${provider.baseUrl}`);
    if (provider.requiresOpenaiAuth) parts.push("使用 OpenAI 登录/API key");
    if (provider.envKey) {
      parts.push(`${provider.envKey} ${provider.envVisible ? "当前 Bridge 进程可见" : "当前 Bridge 进程不可见，设置环境变量后需要重启 Bridge"}`);
    } else if (!provider.requiresOpenaiAuth) {
      parts.push("未配置 env_key");
    }
    parts.push(serviceTierForProviderDetail(provider));
    if (provider.builtIn) parts.push("内置");
    return parts.join("；") || "无额外信息";
  }

  async function handleModelCommand(chatId, rest, messageId) {
    await syncChatSessionsWithCodex(chatId);
    const session = getSession(chatId);
    let args = commandArgs(rest);
    const action = String(args[0] || "").toLowerCase();

    if (!args.length || action === "status" || action === "view") {
      await sendMarkdown(chatId, modelStatusMarkdown(session), "model-status", messageId);
      return;
    }

    if (action === "capability" || action === "capabilities") {
      let liveLookup = null;
      try {
        const listed = await listCurrentProviderModels(session);
        const activeModel = effectiveSessionSettings(session).model;
        const matched = (listed.models || []).find((item) => (item.id || item.model) === activeModel) || null;
        liveLookup = {
          ok: true,
          source: listed.source,
          totalModels: (listed.models || []).length,
          matched,
        };
      } catch (error) {
        liveLookup = {
          ok: false,
          error: String(error?.message || error).slice(0, 160),
        };
      }
      await sendMarkdown(chatId, modelCapabilityMarkdown(session, { liveLookup }), "model-capability", messageId);
      return;
    }

    if (action === "list" || action === "refresh") {
      try {
        await sendMarkdown(chatId, await modelListMarkdown(session), "model-list", messageId);
      } catch (error) {
        await sendMarkdown(chatId, runtimeCommandErrorMarkdown("provider /models 查询失败", error), "model-list-error", messageId);
      }
      return;
    }

    if (action === "test" || action === "check") {
      if (activeCodexJobs.has(chatId)) {
        await sendText(chatId, "当前任务运行中不能测试模型，请等待完成或 /stop 后再执行 /model test。", "model-test-busy", messageId);
        return;
      }
      const model = cleanOverride(args[1]);
      if (!model) {
        await sendText(chatId, "用法：`/model test <模型ID>`，例如 `/model test gpt-5.5`。", "model-test-usage", messageId);
        return;
      }
      try {
        await sendMarkdown(chatId, modelTestMarkdown(await testCurrentProviderModel(session, model)), "model-test", messageId);
      } catch (error) {
        await sendMarkdown(chatId, runtimeCommandErrorMarkdown("Provider 原生模型验证失败", error), "model-test-error", messageId);
      }
      return;
    }

    if (activeCodexJobs.has(chatId)) {
      await sendText(chatId, "当前任务运行中不能切换模型，请等待完成或 /stop 后再执行 /model。", "model-busy", messageId);
      return;
    }

    if (["clear", "default", "reset"].includes(action)) {
      session.modelOverride = "";
      session.reasoningOverride = "";
      session.updatedAt = Date.now();
      saveSessions();
      await sendMarkdown(chatId, modelStatusMarkdown(session, "已清除当前会话的 model/reasoning 覆盖。"), "model-clear", messageId);
      return;
    }

    const persist = action === "save";
    if (persist) args = args.slice(1);
    const first = String(args[0] || "").toLowerCase();

    try {
      if (first === "effort" || first === "reasoning") {
        const effort = normalizeReasoningEffort(args[1]);
        if (!effort) {
          await sendMarkdown(chatId, modelCapabilityMarkdown(session, { includeUsage: true }), "model-effort-usage", messageId);
          return;
        }
        validateReasoningSelection(effectiveSessionSettings(session).provider, effectiveSessionSettings(session).model, effort);
        if (persist) await writeCodexConfigValue("model_reasoning_effort", effort);
        setSessionOverride(session, "reasoningOverride", effort);
        await sendMarkdown(chatId, modelStatusMarkdown(session, persist ? "已切换并保存 reasoning。" : "已切换当前会话 reasoning。"), "model-effort", messageId);
        return;
      }

      const model = cleanOverride(args[0]);
      const effort = normalizeReasoningEffort(args[1]);
      if (!model) {
        await sendText(chatId, "用法：`/model <模型ID> [推理强度]`，例如 `/model gpt-5.6-sol max`。", "model-usage", messageId);
        return;
      }
      if (args[1] && !effort) {
        await sendText(chatId, "推理强度只能是：`none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。", "model-effort-invalid", messageId);
        return;
      }
      await assertCurrentProviderModelAvailable(session, model);
      if (effort) validateReasoningSelection(effectiveSessionSettings(session).provider, model, effort);

      if (model.toLowerCase() === "default") {
        session.modelOverride = "";
      } else {
        session.modelOverride = model;
        if (persist) await writeCodexConfigValue("model", model);
      }
      session.providerBundleOverride = "";
      if (effort) {
        session.reasoningOverride = effort;
        if (persist) await writeCodexConfigValue("model_reasoning_effort", effort);
      }
      session.updatedAt = Date.now();
      saveSessions();
      await sendMarkdown(chatId, modelStatusMarkdown(session, persist ? "已切换并保存 model 设置。" : "已切换当前会话 model 设置。"), "model-set", messageId);
    } catch (error) {
      await sendMarkdown(chatId, runtimeCommandErrorMarkdown("model 操作失败", error), "model-error", messageId);
    }
  }

  async function handleEffortCommand(chatId, rest, messageId) {
    const trimmed = String(rest || "").trim();
    const lower = trimmed.toLowerCase();
    if (!trimmed || lower === "status" || lower === "view") {
      await syncChatSessionsWithCodex(chatId);
      const session = getSession(chatId);
      await sendMarkdown(chatId, modelCapabilityMarkdown(session, { includeUsage: true }), "effort-status", messageId);
      return;
    }
    if (["clear", "default", "reset"].includes(lower)) {
      if (activeCodexJobs.has(chatId)) {
        await sendText(chatId, "当前任务运行中不能修改推理强度，请等待完成或 /stop 后再执行 /effort clear。", "effort-busy", messageId);
        return;
      }
      await syncChatSessionsWithCodex(chatId);
      const session = getSession(chatId);
      session.reasoningOverride = "";
      session.updatedAt = Date.now();
      saveSessions();
      await sendMarkdown(chatId, modelStatusMarkdown(session, "已清除当前会话的推理强度覆盖，恢复默认。"), "effort-clear", messageId);
      return;
    }
    await handleModelCommand(chatId, `effort ${trimmed}`, messageId);
  }

  function normalizeReasoningEffort(value) {
    const text = String(value || "").trim().toLowerCase();
    return REASONING_EFFORTS.has(text) ? text : "";
  }

  function validateReasoningSelection(provider, model, effort) {
    const mapping = mapReasoningEffort({ provider, model, effort }, MODEL_REASONING_REGISTRY);
    if (!mapping.supported) {
      throw new Error(`${mapping.capability.name} 不支持推理强度 ${mapping.requestedEffort}；可接受请求值：${acceptedEfforts(mapping.capability, MODEL_REASONING_REGISTRY).join("、") || "无"}`);
    }
    return mapping;
  }

  function modelStatusMarkdown(session, title = "Codex model") {
    const settings = effectiveSessionSettings(session);
    const mapping = settings.reasoningMapping;
    const capability = mapping.capability;
    const review = reasoningReviewStatus(capability, MODEL_REASONING_REGISTRY);
    return [
      `**${title}**`,
      "",
      `当前会话：\`${session.title || "未命名会话"}\` (${session.id})`,
      `模型：\`${settings.model || "默认"}\`${session.modelOverride ? "（会话覆盖）" : "（配置默认）"}`,
      `请求推理强度：\`${settings.requestedReasoning || "默认"}\`${session.reasoningOverride ? "（会话覆盖）" : "（配置默认）"}`,
      `实际 Codex 参数：\`${mapping.supported ? mapping.effectiveEffort : "不支持"}\``,
      `上游语义：\`${mapping.supported ? mapping.upstreamValue : "不支持"}\``,
      `能力规则：${capability.known ? `\`${capability.name}\` · ${review.stale ? `待复核（应于 ${review.reviewDueAt} 前复核）` : "已收录"}` : "未收录，按 Codex 通用值透传"}`,
      `provider：\`${settings.provider || "默认"}\``,
      `速度：\`${displayServiceTier(settings.serviceTier) || "默认"}\``,
      "",
      "用法：`/model list`、`/model capability`、`/model test <模型ID>`、`/model <模型ID> [推理强度]`、`/model effort <强度>`、`/model save <模型ID> [强度]`、`/model clear`",
    ].join("\n");
  }

  function modelCapabilityMarkdown(session, { includeUsage = false, liveLookup = null } = {}) {
    const settings = effectiveSessionSettings(session);
    const mapping = settings.reasoningMapping;
    const capability = mapping.capability;
    const review = reasoningReviewStatus(capability, MODEL_REASONING_REGISTRY);
    const supported = acceptedEfforts(capability, MODEL_REASONING_REGISTRY);
    const rows = capabilityOutcomeLines({
      provider: settings.provider,
      model: settings.model,
      currentEffort: settings.requestedReasoning,
    }, MODEL_REASONING_REGISTRY);
    const liveLines = [];
    if (liveLookup?.ok && liveLookup.matched) {
      const liveEfforts = Array.isArray(liveLookup.matched.supportedReasoningEfforts)
        ? liveLookup.matched.supportedReasoningEfforts
          .map((item) => (typeof item === "string" ? item : item?.reasoningEffort))
          .filter(Boolean)
        : [];
      const liveTiers = Array.isArray(liveLookup.matched.serviceTiers)
        ? liveLookup.matched.serviceTiers.map((tier) => `${tier.name || tier.id}(${tier.id})`).filter(Boolean)
        : [];
      if (liveEfforts.length) {
        const srcLabel = liveLookup.source === "openai-account" ? "官方账号实时查询" : "Codex app-server 实时查询";
        liveLines.push(`实时上游支持档位：${liveEfforts.map((effort) => `\`${effort}\``).join("、")}（来源：${srcLabel}）`);
        if (liveTiers.length) liveLines.push(`实时速度档：${liveTiers.join("、")}`);
      } else {
        liveLines.push(`实时渠道核验：\`${settings.model}\` 在当前渠道实时目录中可见（共 ${liveLookup.totalModels} 个模型；接口未返回档位元数据，下方使用本地规则表）`);
      }
    } else if (liveLookup?.ok && !liveLookup.matched && settings.model) {
      liveLines.push(`实时渠道核验：⚠️ \`${settings.model}\` 未出现在当前实时目录中（共 ${liveLookup.totalModels} 个模型）`);
    } else if (liveLookup && !liveLookup.ok) {
      liveLines.push(`实时核验：暂不可用（${liveLookup.error}），以下展示本地规则表`);
    }
    const lines = [
      "**当前模型推理能力**",
      "",
      `provider：\`${settings.provider || "默认"}\``,
      `模型：\`${settings.model || "默认"}\``,
      ...liveLines,
      `规则：\`${capability.name}\` (${capability.id})`,
      `状态：${capability.known ? `${review.stale ? "待复核" : "已收录"} · 核验 ${capability.verifiedAt} · 下次 ${review.reviewDueAt}` : "未收录 · 通用透传"}`,
      `可接受请求值：${supported.map((effort) => `\`${effort}\``).join("、")}`,
      "",
      "实际效果（你的选择 → 模型实际效果）：",
      ...rows,
      "",
      `当前映射：\`${settings.requestedReasoning}\` → \`${mapping.supported ? mapping.effectiveEffort : "不支持"}\` → \`${mapping.supported ? mapping.upstreamValue : "不支持"}\``,
      capability.sourceUrl ? `来源：${capability.sourceUrl}` : "来源：暂无模型专属来源",
      capability.verificationNote ? `核验说明：${capability.verificationNote}` : "",
      `能力池版本：\`${MODEL_REASONING_REGISTRY.registryVersion}\``,
    ].filter(Boolean);
    if (includeUsage) {
      lines.push(
        "",
        "切换当前会话：`/model effort <请求值>`",
        `例如：\`/model effort ${settings.requestedReasoning || MODEL_REASONING_REGISTRY.defaultRequestedEffort}\``,
      );
    }
    return lines.join("\n");
  }

  function modelTestMarkdown(result) {
    return [
      "**模型测活成功**",
      "",
      `provider：\`${result.settings.provider || "默认"}\``,
      `model：\`${result.model}\``,
      `接口：\`${result.url}\``,
      result.provider?.envKey ? `鉴权：\`${result.provider.envKey}\`` : "",
      result.responseId ? `response id：\`${result.responseId}\`` : "",
      `耗时：${result.elapsedMs} ms`,
      "",
      "这次测试只确认当前 provider + model 能完成一次轻量 `/responses` 请求，不会切换会话模型，也不会写入 config.toml。",
    ].filter(Boolean).join("\n");
  }

  async function modelListMarkdown(session) {
    const settings = effectiveSessionSettings(session);
    const result = await listCurrentProviderModels(session);
    const models = result.models;
    const lines = [
      result.source === "codex" ? "**Codex model 目录**" : "**当前 provider 实时模型列表**",
      "",
      `provider：\`${settings.accountAlias || settings.provider || "默认"}\``,
    ];
    if (result.source !== "codex") {
      lines.push(`来源：\`${result.url}\``);
      if (result.provider?.envKey) lines.push(`鉴权：\`${result.provider.envKey}\``);
      if (result.checkedAt) lines.push(`查询时间：${result.checkedAt}；全部 ${models.length} 个可选模型`);
    } else {
      lines.push("来源：Codex app-server `model/list`（可能使用缓存或内置目录，不代表实时权限清单）");
    }
    lines.push("");
    if (!models.length) {
      lines.push("没有拿到模型 ID。");
    }
    for (const model of models) {
      const id = model.id || model.model || "";
      if (!id) continue;
      const marker = id === settings.model ? " ← 当前" : model.isDefault ? " ← 默认" : "";
      if (result.source === "provider") {
        const detail = [
          model.displayName && model.displayName !== id ? model.displayName : "",
          model.ownedBy ? `owned_by ${model.ownedBy}` : "",
        ].filter(Boolean).join("；");
        lines.push(`- \`${id}\`${marker}${detail ? `：${detail}` : ""}`);
      } else {
        const efforts = Array.isArray(model.supportedReasoningEfforts)
          ? model.supportedReasoningEfforts.map((item) => item.reasoningEffort).filter(Boolean).join("/")
          : "";
        const fast = Array.isArray(model.serviceTiers) && model.serviceTiers.length
          ? `；速度档：${model.serviceTiers.map((tier) => `${tier.name || tier.id}(${tier.id})`).join(", ")}`
          : "";
        lines.push(`- \`${id}\`${marker}：${model.displayName || id}${efforts ? `；推理 ${efforts}` : ""}${fast}`);
      }
    }
    lines.push("");
    if (result.source === "provider") {
      const listed = new Set(models.map(model => model.id || model.model));
      const extra = verifiedModels.list(runtimeOptionsForSession(session).verificationIdentity).filter(model => !listed.has(model.model));
      if (extra.length) {
        lines.push('**目录外实测通过（当前渠道与凭据）**');
        for (const model of extra) lines.push('- \x60' + model.model + '\x60' + (model.model === settings.model ? ' ← 当前' : '') + '；验证时间：' + new Date(model.verifiedAt).toISOString());
        lines.push('');
      }
      lines.push('上方目录实时查询当前渠道 /models；额外验证结果单独显示。明确输入目录外模型时，会先通过当前渠道完成一次轻量验证再允许选择。');
    } else if (result.source === "openai-account") {
      lines.push("`/model list` 和 `/model refresh` 每次都实时查询当前官方账号；不合并本地旧目录，隐藏的内部模型不展示。目录可见不保证每次请求都有可用额度。");
    }
    lines.push("切当前会话：`/model <模型ID> [推理强度]`，例如 `/model gpt-5.6-sol max`");
    lines.push("保存为全局默认：`/model save <模型ID> [推理强度]`");
    return lines.join("\n");
  }

  async function handleFastCommand(chatId, rest, messageId) {
    await syncChatSessionsWithCodex(chatId);
    const session = getSession(chatId);
    const args = commandArgs(rest);
    let action = String(args[0] || "").toLowerCase();
    let persist = false;
    if (action === "save") {
      persist = true;
      action = String(args[1] || "").toLowerCase();
    }

    if (!action || action === "status" || action === "view") {
      await sendMarkdown(chatId, fastStatusMarkdown(session), "fast-status", messageId);
      return;
    }

    if (activeCodexJobs.has(chatId)) {
      await sendText(chatId, "当前任务运行中不能切换 Fast 模式，请等待完成或 /stop 后再执行 /fast。", "fast-busy", messageId);
      return;
    }

    try {
      if (action === "on") {
        if (persist) await writeCodexConfigValue("service_tier", FAST_SERVICE_TIER);
        setSessionOverride(session, "serviceTierOverride", FAST_SERVICE_TIER);
        await sendMarkdown(chatId, fastStatusMarkdown(session, persist ? "已开启并保存 Fast 模式。" : "已开启当前会话 Fast 模式。"), "fast-on", messageId);
        return;
      }

      if (action === "off") {
        if (persist) await writeCodexConfigValue("service_tier", STANDARD_SERVICE_TIER);
        setSessionOverride(session, "serviceTierOverride", STANDARD_SERVICE_TIER);
        await sendMarkdown(chatId, fastStatusMarkdown(session, persist ? "已关闭并保存 Fast 模式。" : "已关闭当前会话 Fast 模式。"), "fast-off", messageId);
        return;
      }

      if (action === "clear" || action === "default" || action === "reset") {
        setSessionOverride(session, "serviceTierOverride", "");
        await sendMarkdown(chatId, fastStatusMarkdown(session, "已清除当前会话速度覆盖，后续使用 Codex 配置默认值。"), "fast-clear", messageId);
        return;
      }

      if (action === "tier") {
        const tier = cleanOverride(args[persist ? 2 : 1]);
        if (!tier) {
          await sendText(chatId, "用法：`/fast tier <serviceTier>`，例如 `/fast tier priority`。", "fast-tier-usage", messageId);
          return;
        }
        setSessionOverride(session, "serviceTierOverride", tier);
        await sendMarkdown(chatId, fastStatusMarkdown(session, `已切换当前会话 serviceTier：\`${tier}\`。`), "fast-tier", messageId);
        return;
      }

      await sendText(chatId, "用法：`/fast on`、`/fast off`、`/fast status`、`/fast clear`。", "fast-usage", messageId);
    } catch (error) {
      await sendMarkdown(chatId, runtimeCommandErrorMarkdown("fast 操作失败", error), "fast-error", messageId);
    }
  }

  function fastStatusMarkdown(session, title = "Codex Fast 模式") {
    const settings = effectiveSessionSettings(session);
    const tier = displayServiceTier(settings.serviceTier);
    const fastOn = tier === "fast";
    return [
      `**${title}**`,
      "",
      `当前会话：\`${session.title || "未命名会话"}\` (${session.id})`,
      `速度：\`${tier || "默认"}\`${session.serviceTierOverride ? "（会话覆盖）" : "（配置默认）"}`,
      `状态：${fastOn ? "Fast 开启" : tier === "standard" ? "Standard 关闭 Fast" : "跟随 Codex 配置"}`,
      "说明：Fast 是 Codex 官方 1.5x 速度模式，会消耗更多额度；API key provider 走标准 API 计费，不能使用 ChatGPT Fast credits。",
      "",
      "用法：`/fast on`、`/fast off`、`/fast status`、`/fast save on`、`/fast clear`",
    ].join("\n");
  }

  function runtimeCommandErrorMarkdown(title, error) {
    return [
      `**${title}**`,
      "",
      "```",
      truncateCardText(errorText(error), 1500),
      "```",
    ].join("\n");
  }

  function stopClearMode(rest) {
    const text = String(rest || "").trim().toLowerCase();
    if (!text) return "";
    if (["queue", "queued", "clear", "current"].includes(text)) return "chat";
    if (["all", "queues", "clearall", "clear-all"].includes(text)) return "all";
    return "";
  }

  function clearQueuedWorkForChat(chatId, { all = false } = {}) {
    return clearQueuedWorkAndAdvanceGeneration({
      chatId,
      all,
      clearEvents: clearPendingEventsForChat,
      activeJobs: activeCodexJobs,
      activeGoalRuns,
      cleanupDownloads: cleanupClearedDownloads,
    });
  }

  async function clearQueueCommand(chatId, rest, messageId) {
    const all = stopClearMode(rest) === "all";
    const cleared = clearQueuedWorkForChat(chatId, { all });
    await sendText(
      chatId,
      formatClearQueueReply({
        all,
        ...cleared,
        queueSummaryText: all ? "" : queueSummary(chatId),
      }),
      "clearqueue",
      messageId,
    );
  }

  async function interruptSingleActiveJob(targetChatId, job) {
    stoppedJobs.add(job.messageId);
    if (job.rootMessageId) stoppedJobs.add(job.rootMessageId);

    if (['claude', 'antigravity'].includes(job.mode) && job.client) {
      job.client.interrupt();
      setTimeout(() => {
        if (activeCodexJobs.get(targetChatId) === job && job.pid) terminateProcessTree(job.pid, true);
      }, 5000).unref?.();
      if (job.finished) await Promise.race([job.finished, delay(15_000)]);
      return activeCodexJobs.get(targetChatId) !== job;
    }

    if (job.mode === "app-server-goal" && job.client && job.threadId) {
      try {
        const result = await job.client.request("thread/goal/set", { threadId: job.threadId, status: "paused" }, 15_000);
        const run = activeGoalRuns.get(targetChatId);
        if (run) applyGoalRunNativeState(run, result?.goal || null);
        else {
          const session = getSession(targetChatId);
          if (!job.sessionId || session.id === job.sessionId) updateSessionGoal(session, result?.goal || null);
        }
      } catch (error) {
        if (isNoGoalExistsError(error)) {
          const run = activeGoalRuns.get(targetChatId);
          if (run) applyGoalRunNativeState(run, null);
          else {
            const session = getSession(targetChatId);
            if (!job.sessionId || session.id === job.sessionId) updateSessionGoal(session, null);
          }
          log("INFO", "codex goal already absent during stop", {
            chatId: targetChatId,
            pid: job.pid,
            threadId: job.threadId,
          });
        } else {
          log("WARN", "codex goal pause during stop failed", {
            chatId: targetChatId,
            pid: job.pid,
            threadId: job.threadId,
            error: String(error.message || error).slice(0, 1000),
          });
        }
      }
    }

    if (["app-server", "app-server-goal"].includes(job.mode) && job.client && job.threadId && job.turnId) {
      try {
        await job.client.request("turn/interrupt", { threadId: job.threadId, turnId: job.turnId }, 15_000);
        setTimeout(() => {
          const current = activeCodexJobs.get(targetChatId);
          if (current?.pid === job.pid) terminateProcessTree(job.pid, true);
        }, 5000).unref?.();
        if (job.finished) await Promise.race([job.finished, delay(15_000)]);
        return activeCodexJobs.get(targetChatId) !== job;
      } catch (error) {
        log("WARN", "codex turn interrupt failed; falling back to process termination", {
          chatId: targetChatId,
          pid: job.pid,
          threadId: job.threadId,
          turnId: job.turnId,
          error: String(error.message || error).slice(0, 1000),
        });
      }
    }

    terminateProcessTree(job.pid, false);
    setTimeout(() => terminateProcessTree(job.pid, true), 5000).unref?.();
    if (job.finished) await Promise.race([job.finished, delay(15_000)]);
    return activeCodexJobs.get(targetChatId) !== job;
  }

  async function stopAllActiveJobs(chatId, messageId) {
    const cleared = clearQueuedWorkForChat(chatId, { all: true });
    const clearedTotal = cleared.removedQueued + cleared.cancelledPreflight + cleared.cancelledPendingSteers;
    const targets = [...activeCodexJobs.entries()];
    if (CONFIG.engine === "claude") await claudeBridge?.retireWarm?.(chatId, { all: true });
    const stoppedBg = CONFIG.engine === "antigravity"
      ? Number((await antigravityBridge?.stopBackground?.(chatId, { all: true })) || 0)
      : 0;
    if (!targets.length) {
      if (stoppedBg > 0) {
        await sendText(
          chatId,
          `已停止 ${stoppedBg} 个后台保活等待唤醒的 Antigravity 会话。已清空全部等待队列：${cleared.removedQueued} 条，取消尚未提交的任务：${cleared.cancelledPreflight} 条，取消尚未发送的补充指令：${cleared.cancelledPendingSteers} 条。`,
          "stopall-bg",
          messageId,
        );
        return;
      }
      if (CONFIG.engine === "codex") {
        try {
          await syncChatSessionsWithCodex(chatId);
          const session = getSession(chatId);
          const goal = await getAppServerGoal(session);
          if (goalStatusIsActive(goal?.status)) {
            const paused = await setAppServerGoal(session, { status: "paused" });
            await sendMarkdown(
              chatId,
              goalMarkdown(session, paused || goal, `已暂停 Codex goal，并清理全部等待队列 ${cleared.removedQueued} 条、未提交 ${cleared.cancelledPreflight} 条、未发送补充 ${cleared.cancelledPendingSteers} 条`),
              "stopall-goal-pause",
              messageId,
            );
            return;
          }
        } catch (error) {
          if (!isNoGoalExistsError(error)) {
            log("WARN", "native goal pause without active job failed", {
              chatId,
              error: String(error.message || error).slice(0, 1000),
            });
          }
        }
      }
      await sendText(
        chatId,
        `当前全实例没有运行中的 ${ENGINE_LABEL} 任务。已清空全部等待队列：${cleared.removedQueued} 条，取消尚未提交的任务：${cleared.cancelledPreflight} 条，取消尚未发送的补充指令：${cleared.cancelledPendingSteers} 条。`,
        "stopall-none",
        messageId,
      );
      return;
    }

    await sendText(chatId, `Stopping ${targets.length} active job(s)...`, "stopall-start", messageId);
    const results = await Promise.all(targets.map(async ([targetChatId, job]) => {
      try {
        const ended = await interruptSingleActiveJob(targetChatId, job);
        return { chatId: targetChatId, ended, error: "" };
      } catch (error) {
        return { chatId: targetChatId, ended: false, error: String(error?.message || error).slice(0, 300) };
      }
    }));
    const stoppedCount = results.filter((item) => item.ended).length;
    const failed = results.filter((item) => !item.ended);
    const clearText = `已清空全部等待队列：${cleared.removedQueued} 条，取消尚未提交：${cleared.cancelledPreflight} 条，取消未发送补充：${cleared.cancelledPendingSteers} 条（合计 ${clearedTotal} 条）。`;
    if (!failed.length) {
      await sendText(chatId, `已停止全部 ${stoppedCount} 个运行中聊天任务。${clearText}`, "stopall", messageId);
    } else {
      await sendText(
        chatId,
        `已停止 ${stoppedCount}/${targets.length} 个运行中聊天任务（仍有 ${failed.length} 个未结束：${failed.map((item) => item.chatId).join("、")}）。${clearText}`,
        "stopall-partial",
        messageId,
      );
    }
  }

  async function stopCurrentJob(chatId, messageId, { clearMode = "" } = {}) {
    const cleared = clearMode ? clearQueuedWorkForChat(chatId, { all: clearMode === "all" }) : null;
    const clearedText = cleared
      ? `等待队列 ${cleared.removedQueued} 条、未提交 ${cleared.cancelledPreflight} 条、未发送补充 ${cleared.cancelledPendingSteers} 条`
      : "";
    const job = activeCodexJobs.get(chatId);
    if (!job) {
      if (CONFIG.engine === "claude") await claudeBridge?.retireWarm?.(chatId);
      if (CONFIG.engine === "antigravity" && antigravityBridge?.hasBackground?.(chatId)) {
        await antigravityBridge.stopBackground(chatId);
        await sendText(
          chatId,
          `已停止后台保活等待唤醒的 Antigravity 会话。${clearMode ? `已清理${clearedText}。` : ""}`,
          "stop-bg",
          messageId,
        );
        return;
      }
      if (CONFIG.engine === "antigravity") await antigravityBridge?.retireWarm?.(chatId);
      if (CONFIG.engine === "codex") {
        try {
          await syncChatSessionsWithCodex(chatId);
          const session = getSession(chatId);
          const goal = await getAppServerGoal(session);
          if (goalStatusIsActive(goal?.status)) {
            const paused = await setAppServerGoal(session, { status: "paused" });
            await sendMarkdown(
              chatId,
              goalMarkdown(session, paused || goal, `已暂停 Codex goal${clearMode ? `，并清理${clearedText}` : ""}`),
              "stop-goal-pause",
              messageId,
            );
            return;
          }
        } catch (error) {
          if (!isNoGoalExistsError(error)) {
            log("WARN", "native goal pause without active job failed", {
              chatId,
              error: String(error.message || error).slice(0, 1000),
            });
          }
        }
      }
      await sendText(chatId, `当前没有运行中的 ${ENGINE_LABEL} 任务。${clearMode ? `已清理${clearedText}。` : ""}`, "stop-none", messageId);
      return;
    }
    await sendText(chatId, "Stopping", "stop-start", messageId);
    const ended = await interruptSingleActiveJob(chatId, job);
    await sendText(
      chatId,
      ended
        ? `Stopped${clearMode ? `；已清理${clearedText}。` : "。"}`
        : `停止失败：当前 ${job.mode === "app-server-goal" ? "Codex goal" : `${ENGINE_LABEL} 任务`}仍未结束。`,
      "stop",
      messageId,
    );
  }

  async function handleSteerCommand(event, rest, messageId) {
    const chatId = event.chat_id;
    const userContent = String(rest || "").trim();
    const directAttachments = Array.isArray(event.attachments) ? event.attachments : [];
    const capturedJob = event._steerJob || activeCodexJobs.get(chatId);
    const steerEntry = capturedJob ? ensureSteerEntry({ event, job: capturedJob, chatId, messageId }) : null;

    // Checkpoint 1: cancelled before reaching steerInFlight (e.g. during prepareCommandAttachments)
    if (steerEntry && isSteerEntryCancelled(capturedJob, steerEntry)) {
      removeSteerEntry(capturedJob, steerEntry);
      cleanupClearedDownloads(directAttachments);
      await sendText(chatId, STEER_CANCELLED_BY_CLEARQUEUE_REPLY, "steer-cancelled", messageId);
      return;
    }

    const downloadFailures = Number(event.attachmentDownload?.failed?.image || 0)
      + Number(event.attachmentDownload?.failed?.file || 0);
    if (downloadFailures) {
      if (steerEntry) { steerEntry.state = "failed"; removeSteerEntry(capturedJob, steerEntry); }
      if (directAttachments.length) {
        await withAttachmentLock(chatId, () => addPendingAttachments(chatId, directAttachments));
      }
      const failedParts = [];
      if (event.attachmentDownload.failed.image) {
        failedParts.push(`${event.attachmentDownload.failed.image} 张图片`);
      }
      if (event.attachmentDownload.failed.file) {
        failedParts.push(`${event.attachmentDownload.failed.file} 个文件`);
      }
      await sendText(
        chatId,
        `附件下载不完整（${failedParts.join("、")}失败），本次补充指令没有追加。`
          + (directAttachments.length
            ? ` 已成功下载的${formatAttachmentCounts(directAttachments)}已暂存，重试 /steer 时会自动带上。`
            : " 请重新发送附件后再试。"),
        "steer-attachment-download-failed",
        messageId,
      );
      return;
    }

    const pendingPreview = cleanupPendingAttachments(chatId);
    if (!userContent && !directAttachments.length && !pendingPreview.length) {
      if (steerEntry) { steerEntry.state = "failed"; removeSteerEntry(capturedJob, steerEntry); }
      await sendText(chatId, "用法：/steer <要追加到当前任务的补充指令>", "steer-usage", messageId);
      return;
    }

    const job = activeCodexJobs.get(chatId);
    if (!job || (capturedJob && job !== capturedJob)) {
      if (steerEntry) { steerEntry.state = "failed"; removeSteerEntry(capturedJob, steerEntry); }
      if (directAttachments.length) {
        await withAttachmentLock(chatId, () => addPendingAttachments(chatId, directAttachments));
      }
      await sendText(
        chatId,
        capturedJob && job !== capturedJob
          ? "当前任务已结束，未追加任何内容。"
          : `当前没有正在运行的 ${ENGINE_LABEL} 任务，未追加任何内容。`,
        "steer-no-job",
        messageId,
      );
      return;
    }
    if (
      !job.client
      || !job.threadId
      || !job.turnId
      || !["app-server", "app-server-goal"].includes(job.mode)
    ) {
      if (steerEntry) { steerEntry.state = "failed"; removeSteerEntry(job, steerEntry); }
      if (directAttachments.length) {
        await withAttachmentLock(chatId, () => addPendingAttachments(chatId, directAttachments));
      }
      await sendText(
        chatId,
        "当前任务尚未进入可追加指令的原生 Codex turn，未追加任何内容。请稍后重试。"
          + (directAttachments.length ? " 已下载附件会为下次 /steer 暂存。" : ""),
        "steer-not-ready",
        messageId,
      );
      return;
    }

    let steerAttachments = [];
    let outcome = "sent";
    const previous = job.steerInFlight || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      // Checkpoint 2: inside serial steerInFlight slot, before touching pendingAttachments or RPC
      if (steerEntry && isSteerEntryCancelled(job, steerEntry)) {
        outcome = "cancelled";
        cleanupClearedDownloads(directAttachments);
        return;
      }
      if (
        activeCodexJobs.get(chatId) !== job
        || !job.client
        || job.client.closed
        || !job.threadId
        || !job.turnId
      ) {
        outcome = "ended";
        if (directAttachments.length) {
          await withAttachmentLock(chatId, () => addPendingAttachments(chatId, directAttachments));
        }
        return;
      }

      const pendingTaken = await withAttachmentLock(chatId, () => takePendingAttachments(chatId));
      steerAttachments = [...pendingTaken, ...directAttachments];
      event.attachments = steerAttachments;

      // Re-check generation right before irreversible dispatch
      if (steerEntry && isSteerEntryCancelled(job, steerEntry)) {
        outcome = "cancelled";
        if (pendingTaken.length) {
          await withAttachmentLock(chatId, () => addPendingAttachments(chatId, pendingTaken));
        }
        cleanupClearedDownloads(directAttachments);
        steerAttachments = [];
        return;
      }

      // Irreversible point of no return: transition to dispatched synchronously right before RPC
      markSteerEntryDispatched(job, steerEntry);
      const result = await job.client.request(
        "turn/steer",
        appServerSteerParams(job.threadId, job.turnId, event, userContent),
        60_000,
      );
      job.turnId = result?.turnId || job.turnId;

      const session = sessions.chats[chatId]?.sessions?.find((item) => item.id === job.sessionId);
      if (session) {
        appendHistory(
          session,
          "user",
          userContent || `${event.attachments?.length || 0} attachment(s)`,
        );
      }

      const run = activeGoalRuns.get(chatId);
      if (job.mode === "app-server-goal" && run?.client === job.client) {
        run.currentTurnId = job.turnId;
        run.state.goalSteerCount += 1;
        run.state.footer = "thinking";
        await run.updateCard?.();
      }
    });
    job.steerInFlight = current;

    try {
      await current;
      if (outcome === "cancelled") {
        await sendText(chatId, STEER_CANCELLED_BY_CLEARQUEUE_REPLY, "steer-cancelled", messageId);
      } else if (outcome === "ended") {
        await sendText(chatId, `当前 ${ENGINE_LABEL} turn 已结束，未追加任何内容。`, "steer-ended", messageId);
      } else {
        await sendText(
          chatId,
          `已将补充指令${steerAttachments.length ? `（含${formatAttachmentCounts(steerAttachments)}）` : ""}`
            + `追加到当前正在运行的 ${ENGINE_LABEL} 任务，不会创建新任务。`,
          "steer-done",
          messageId,
        );
      }
    } catch (error) {
      if (steerEntry && steerEntry.state === "pending") steerEntry.state = "failed";
      if (steerAttachments.length) {
        await withAttachmentLock(chatId, () => addPendingAttachments(chatId, steerAttachments));
      }
      const detail = isActiveTurnRaceError(error)
        ? `当前 ${ENGINE_LABEL} turn 已经结束或正在切换，未追加任何内容。`
        : `追加指令失败，未创建新任务：${String(error.message || error).slice(0, 500)}`;
      log("WARN", "explicit turn steer failed", {
        chatId,
        messageId,
        threadId: job.threadId,
        turnId: job.turnId,
        error: String(error.message || error).slice(0, 1000),
      });
      await sendText(
        chatId,
        detail + (steerAttachments.length ? " 附件已暂存，可在下一次 /steer 中重试。" : ""),
        "steer-error",
        messageId,
      );
    } finally {
      if (steerEntry) removeSteerEntry(job, steerEntry);
      delete event._steerEntry;
      delete event._steerJob;
      if (job.steerInFlight === current) job.steerInFlight = null;
    }
  }

  async function handleCompactCommand(chatId, messageId) {
    await syncChatSessionsWithCodex(chatId);
    const session = getSession(chatId);
    const job = activeCodexJobs.get(chatId);
    if (job) {
      await sendText(chatId, `当前 ${ENGINE_LABEL} 任务还在运行，等这一轮结束后再发送 /compact。`, "compact-busy", messageId);
      return;
    }

    if (CONFIG.runMode === "exec") {
      await sendText(chatId, "当前 runMode=exec，没有可压缩的 app-server 原生 thread。", "compact-exec-mode", messageId);
      return;
    }

    if (!session.codexThreadId) {
      await sendText(chatId, "当前会话还没有创建 Codex 原生 thread。先发送一条普通消息，再用 /compact。", "compact-no-thread", messageId);
      return;
    }

    await sendText(chatId, `开始压缩当前 Codex 原生 thread：${session.codexThreadId}`, "compact-start", messageId);
    try {
      const result = await compactAppServerThread(session);
      await sendMarkdown(
        chatId,
        [
          "**Codex 上下文已压缩**",
          "",
          `本地会话：${session.title || "未命名会话"} (${session.id})`,
          `原生 thread：\`${result.threadId}\``,
          `耗时：${formatDuration(result.durationMs)}`,
          `时间：${formatTime(session.lastCompactedAt)}`,
          "",
          contextStatusBlock(session).join("\n"),
        ].join("\n"),
        "compact-done",
        messageId,
      );
    } catch (error) {
      log("ERROR", "codex app-server compaction failed", {
        sessionId: session.id,
        threadId: session.codexThreadId,
        error: String(error.stack || error).slice(0, 2000),
      });
      await sendMarkdown(
        chatId,
        [
          "**Codex 上下文压缩失败**",
          "",
          "```",
          String(error.message || error).slice(0, 1500),
          "```",
        ].join("\n"),
        "compact-error",
        messageId,
      );
    }
  }

  function helpMarkdown() {
    return [
      "**Codex Bot 命令**",
      "",
      "`/help` — 显示帮助",
      "`/status` — 查看 bot、登录、事件监听、当前绑定状态",
      "`/new [标题]` — 创建新的本地会话上下文",
      "`/now` — 查看当前状态（工作区、会话、任务、队列）",
      "`/how` — 同 `/now`",
      "`/context` — 查看当前 Codex 原生 thread、token 和压缩状态",
      "`/goal [目标]` — 查看或启动原生 Codex Goal mode；运行中普通消息会作为当前 goal 的补充指令；支持 `/goal pause`、`/goal resume`、`/goal clear`",
      "`/provider [id]` — 查看或切换当前会话 provider；`/provider list` 列出真实 provider；`/provider shortcuts` 列出旧快捷组合",
      "`/model [模型ID] [推理强度]` — 查看或切换当前会话模型；`/model list` 查询当前 provider 的 /models；`/model test <id>` 测活",
      "`/effort [档位|clear]` — 查看、独立切换或清除当前会话推理强度（同 `/model effort`）",
      "`/fast on|off|status` — 切换或查看 Codex Fast 速度模式",
      "`/compact` — 触发当前原生 thread 的上下文压缩",
      "`/steer <补充内容>` — 将补充指令追加到当前正在运行的 Codex turn；不会创建新任务",
      "`/sessions` / `/list [all]` — 列出飞书会话和 Codex 侧边栏会话（`/list all` 包含全部工作区与残留记录）",
      "`/switch <序号或ID>` — 切换到已有 Codex 会话",
      "`/rename 新标题` / `/rename <序号> 新标题` — 修改当前会话或 /list 指定会话标题",
      "`/delete <序号或ID>` — 删除 Codex 本地会话；支持 `1 2 3`、`1-18`、`3-7 8-12`，需 `/confirm delete <序号或区间>` 确认",
      "`/reset` — 清空当前会话上下文",
      "`/stop` — 停止当前 Codex 任务",
      "`/stop queue` — 停止当前任务，并清空当前聊天的等待队列",
      "`/stop all` / `/stopall` — 停止当前任务，并清空本 Bot 全部等待队列",
      "`/queue` — 查看等待队列",
      "`/clearqueue [all]` / `/clearqueueall` — 清空当前聊天或全部等待队列",
      "`/list` — 同 `/sessions`",
      "",
      "直接发送文本会进入当前会话。群聊里可以 @codex助手 后发送文本。",
    ].join("\n");
  }

  function goalStatusLabel(status) {
    switch (String(status || "")) {
      case "active": return "进行中";
      case "paused": return "已暂停";
      case "blocked": return "受阻";
      case "usageLimited": return "使用量受限";
      case "budgetLimited": return "预算受限";
      case "complete": return "已完成";
      default: return status || "未知";
    }
  }

  function goalSummary(goal) {
    const item = normalizeGoal(goal);
    if (!item) return "未设置";
    const objective = item.objective.length > 80 ? `${item.objective.slice(0, 80)}...` : item.objective;
    const budget = item.tokenBudget ? ` · 预算 ${formatNumber(item.tokenBudget)} tokens` : "";
    const used = item.tokensUsed ? ` · 已用 ${formatNumber(item.tokensUsed)} tokens` : "";
    return `${goalStatusLabel(item.status)} · ${objective}${used}${budget}`;
  }

  function goalMarkdown(session, goal, title = "Codex goal") {
    const item = normalizeGoal(goal);
    if (!item) {
      return [
        `**${title}**`,
        "",
        "当前会话还没有设置 Codex goal。",
        "",
        `会话：${session.title || "未命名会话"} (${session.id})`,
        `原生 thread：${session.codexThreadId ? `\`${session.codexThreadId}\`` : "未创建"}`,
        "",
        "用法：`/goal <目标>`、`/goal pause`、`/goal resume`、`/goal clear`",
      ].join("\n");
    }

    return [
      `**${title}**`,
      "",
      `状态：${goalStatusLabel(item.status)}`,
      `目标：${item.objective}`,
      `原生 thread：\`${item.threadId || session.codexThreadId || ""}\``,
      item.tokenBudget ? `预算：${formatNumber(item.tokenBudget)} tokens` : "",
      item.tokensUsed ? `已用：${formatNumber(item.tokensUsed)} tokens` : "",
      item.updatedAt ? `更新：${formatTime(item.updatedAt)}` : "",
      "",
      "可用操作：`/goal pause`、`/goal resume`、`/goal clear`",
    ].filter(Boolean).join("\n");
  }

  async function statusMarkdown(chatId) {
    await syncChatSessionsWithCodex(chatId);
    const session = getSession(chatId);
    const [eventStatus, authStatus, codexRuntimeStatus, threadInfo] = await Promise.all([
      readEventStatus(),
      readAuthSummary(),
      readCodexRuntimeVersionStatus({ codexCli: CONFIG.codexCli, runTool }),
      session.codexThreadId ? loadCodexThreadResumeInfo(session.codexThreadId) : null,
    ]);
    const job = activeCodexJobs.get(chatId);
    const context = sessionContextSummary(session);
    const threadMetrics = readThreadMetrics(threadInfo?.rolloutPath || "");
    const firstTokenSummary = threadMetrics.firstTokenSamplesMs.length
      ? threadMetrics.firstTokenSamplesMs.map((value) => formatDuration(value)).join("、")
      : "暂无";
    return [
      "**Codex Feishu Bot 状态**",
      "",
      `桥接进程：PID ${process.pid}，已运行 ${formatDuration(Date.now() - stats.startedAt)}`,
      `飞书事件：${eventStatus}`,
      `登录授权：${authStatus}`,
      `当前聊天绑定：${session.title || "未命名会话"} (${session.id})`,
      `原生 thread：${session.codexThreadId ? `\`${session.codexThreadId}\`` : "未创建"}`,
      `线程文件大小：${formatThreadHealthMegabytes(threadMetrics.rolloutBytes)}`,
      `近 ${threadMetrics.firstTokenSamplesMs.length || 3} 次首 Token 延迟：${firstTokenSummary}`,
      `Goal：${goalSummary(session.lastGoal)}`,
      `上下文：${context}`,
      `运行中：${job ? `是，已运行 ${formatDuration(Date.now() - job.startedAt)}` : "否"}`,
      `队列：${queueSummary(chatId)}`,
      `最近失败：${session.lastFailure ? `${session.lastFailure.label} (${formatTime(session.lastFailure.at)})` : "无"}`,
      `失败统计：${failureStatsSummary()}`,
      "",
      `工作区：\`${CONFIG.workspace}\``,
      `Codex Home：\`${CONFIG.codexHome}\``,
      ...codexRuntimeVersionLines(codexRuntimeStatus),
      `设置：${settingsSummary(session)}`,
      `运行模式：\`${CONFIG.runMode}\` · 沙箱：\`${CONFIG.codexSandbox}\` · MCP：${CONFIG.disableMcp ? "禁用" : "启用"}`,
      `超时：总时长 ${durationConfigLabel(CONFIG.codexTimeoutMs)} · 无进展 ${durationConfigLabel(CONFIG.codexIdleTimeoutMs)}`,
    ].join("\n");
  }

  function failureStatsSummary() {
    const entries = Object.entries(stats.failuresByKind || {}).filter(([, count]) => Number(count) > 0);
    if (!entries.length) return "无";
    return entries
      .map(([kind, count]) => `${failureKindLabel(kind)} ${count}`)
      .join(" · ");
  }

  function failureKindLabel(kind) {
    switch (kind) {
      case "auth": return "鉴权";
      case "quota": return "额度";
      case "rate_limit": return "限流";
      case "stream_disconnect": return "断流";
      case "feishu_card": return "飞书卡片";
      case "timeout": return "超时";
      case "app_server": return "app-server";
      case "empty_completion": return "empty";
      case "user_stop": return "用户停止";
      default: return kind || "未知";
    }
  }

  function sessionContextSummary(session) {
    const parts = [];
    const usage = renderContextUsage(session.lastContextUsage, "本轮");
    if (usage) parts.push(usage);
    const peak = renderContextUsage(session.lastContextPeakUsage, "压缩后峰值");
    if (peak) parts.push(peak);
    if (parts.length) return parts.join("；");
    if (session.lastCompactedAt) return `已压缩 (${formatTime(session.lastCompactedAt)})`;
    return "暂无 tokenUsage";
  }

  function compactThreadId(threadId) {
    return threadId ? `${threadId.slice(0, 8)}...${threadId.slice(-6)}` : "";
  }

  function tokenUsageSummary(tokenUsage) {
    const usage = normalizeTokenUsage(tokenUsage);
    if (!usage) return "暂无";
    const total = usage.total || {};
    const last = usage.last || {};
    const window = usage.modelContextWindow ? ` / window ${formatNumber(usage.modelContextWindow)}` : "";
    return `累计 ${formatNumber(total.totalTokens)}；本轮 ${formatNumber(last.totalTokens)}${window}`;
  }

  function contextStatusBlock(session) {
    return [
      `原生 thread：${session.codexThreadId ? `已绑定 (${compactThreadId(session.codexThreadId)})` : "未创建"}`,
      `设置：${settingsSummary(session)}`,
      `模式：${CONFIG.runMode} · MCP：${CONFIG.disableMcp ? "禁用" : "启用"}`,
      `状态：${session.lastThreadStatus || "未知"}`,
      `Goal：${goalSummary(session.lastGoal)}`,
      `上下文：${sessionContextSummary(session)}`,
      `token：${tokenUsageSummary(session.lastTokenUsage)}`,
      `最近失败：${session.lastFailure ? `${session.lastFailure.label} (${formatTime(session.lastFailure.at)})` : "无"}`,
    ];
  }

  async function contextMarkdown(chatId) {
    await syncChatSessionsWithCodex(chatId);
    const session = getSession(chatId);
    const lines = [
      "**Codex 会话上下文**",
      "",
      `本地会话：${session.title || "未命名会话"} (${session.id})`,
      ...contextStatusBlock(session),
      `上次压缩：${session.lastCompactedAt ? formatTime(session.lastCompactedAt) : "无记录"}`,
    ];
    return lines.join("\n");
  }

  async function readEventStatus() {
    const result = await runLark(["event", "status", "--json"], { attempts: 1, timeoutMs: 15_000 });
    if (result.code !== 0) return `查询失败 (${result.code})`;
    try {
      const parsed = JSON.parse(result.stdout);
      const app = Array.isArray(parsed.apps) ? parsed.apps[0] : null;
      if (!app) return "未发现运行中的应用事件总线";
      const consumers = Array.isArray(app.consumers)
        ? app.consumers.map((item) => `${item.event_key || "unknown"}#${item.pid || "?"}`).join(", ")
        : "无 consumer";
      return `${app.status || (app.running ? "running" : "unknown")}，App ${app.app_id || "unknown"}，consumer：${consumers}`;
    } catch {
      return result.stdout.trim().slice(0, 300) || "未知";
    }
  }

  async function readAuthSummary() {
    const result = await runLark(["auth", "list"], { attempts: 1, timeoutMs: 15_000 });
    if (result.code !== 0) return `查询失败 (${result.code})`;
    try {
      const parsed = JSON.parse(result.stdout);
      const users = Array.isArray(parsed) ? parsed : [];
      if (!users.length) return "未发现已登录用户";
      return users
        .map((item) => {
          const name = item.userName || "未知用户";
          const token = item.tokenStatus || "unknown";
          const app = item.appId || "unknown-app";
          return `${name} / ${token} / ${app}`;
        })
        .join("; ");
    } catch {
      return result.stdout.trim().split(/\r?\n/).slice(0, 3).join(" ").slice(0, 300) || "未知";
    }
  }

  async function nowMarkdown(chatId) {
    await syncChatSessionsWithCodex(chatId);
    const session = getSession(chatId);
    const job = activeCodexJobs.get(chatId);
    return [
      "**Codex Bot 状态**",
      "",
      `工作区：\`${CONFIG.workspace}\``,
      `Codex Home：\`${CONFIG.codexHome}\``,
      `会话：\`${session.title}\` (${session.id})`,
      `原生 thread：${session.codexThreadId ? `\`${session.codexThreadId}\`` : "未创建"}`,
      `Goal：${goalSummary(session.lastGoal)}`,
      `上下文：${sessionContextSummary(session)}`,
      `历史：${session.messages.length} 条`,
      `运行中：${job ? `是，已运行 ${formatDuration(Date.now() - job.startedAt)}` : "否"}`,
      `队列：${queueSummary(chatId)}`,
      `设置：${settingsSummary(session)}`,
      `运行模式：\`${CONFIG.runMode}\` · 沙箱：\`${CONFIG.codexSandbox}\` · MCP：${CONFIG.disableMcp ? "禁用" : "启用"}`,
      `超时：总时长 ${durationConfigLabel(CONFIG.codexTimeoutMs)} · 无进展 ${durationConfigLabel(CONFIG.codexIdleTimeoutMs)}`,
      "",
      `本轮启动后：事件 ${stats.events} · 命令 ${stats.commands} · 完成 ${stats.answered} · 失败 ${stats.failed} · 断流续跑 ${stats.recovered}`,
    ].join("\n");
  }

  function listMarkdown(chatId) {
    const session = getSession(chatId);
    return [
      "**当前 Codex 会话**",
      "",
      `标题：${session.title}`,
      `ID：\`${session.id}\``,
      `创建：${formatTime(session.createdAt)}`,
      `更新：${formatTime(session.updatedAt)}`,
      `历史：${session.messages.length} 条`,
      "",
      "当前桥接版本维护每个聊天一个本地上下文；发送 `/new [标题]` 可重置。",
    ].join("\n");
  }

  function parseSessionsListMode(rest = "") {
    const mode = String(rest || "").trim().split(/\s+/)[0]?.toLowerCase() || "";
    if (["all", "full"].includes(mode)) return "all";
    if (["residue", "residues", "trash"].includes(mode)) return "residue";
    return "default";
  }

  function visibleSessionItemsForListMode(list, mode) {
    return list
      .map((session, index) => ({ session, index: index + 1 }))
      .filter(({ session }) => {
        if (mode === "all") return true;
        if (mode === "residue") return threadListGroup(session) === "residue";
        return threadListGroup(session) !== "residue";
      });
  }

  async function sessionsMarkdown(chatId, rest = "") {
    const mode = parseSessionsListMode(rest);
    const fullList = await listChatSessionsSynced(chatId, { includeAllWorkspaces: mode === "all" });
    const visibleItems = visibleSessionItemsForListMode(fullList, mode);
    const hiddenResidue = mode === "default" ? fullList.length - visibleItems.length : 0;
    const currentId = sessions.chats[chatId]?.currentSessionId || "";
    if (!fullList.length) {
      return [
        "**Codex 会话列表**",
        "",
        "当前没有与 Codex 侧边栏同步的可见会话。",
        "直接发送普通消息，或使用 `/new [标题]` 创建新的飞书 Codex 会话。",
      ].join("\n");
    }
    if (!visibleItems.length) {
      return [
        "**Codex 会话列表**",
        "",
        mode === "residue" ? "当前没有残留记录。" : "当前没有可显示的会话。",
        hiddenResidue ? `已隐藏 ${hiddenResidue} 条残留记录；发送 \`/list all\` 查看全部，或 \`/list residue\` 只看残留。` : "",
      ].filter(Boolean).join("\n");
    }
    const countText = hiddenResidue ? `共 ${visibleItems.length} 个，隐藏残留 ${hiddenResidue} 个` : `共 ${visibleItems.length} 个`;
    const lines = [`**Codex 会话列表（${countText}）**`, ""];
    if (mode === "all") lines.push("模式：全部记录（包含侧边栏/镜像残留）。", "");
    if (mode === "residue") lines.push("模式：只看残留记录。", "");
    let previousGroup = "";
    visibleItems.forEach(({ session, index }) => {
      const marker = session._isCurrent || session.id === currentId ? " ← 当前" : "";
      const thread = codexThreadLink(session.codexThreadId);
      const group = threadListGroup(session);
      if (group !== previousGroup) {
        if (previousGroup) lines.push("");
        lines.push(`**${threadListGroupTitle(group)}**`);
        previousGroup = group;
      }
      lines.push(
        `${index}. ${session.title || "未命名会话"} (${session.id}) · ${thread} · ${threadListStatusText(session)} · 来源：${threadSourcesText(session)} · ${threadDeleteStateText(session)}${threadLocationText(session)} · ${threadListTimeLabelName(session)}：${threadListTimeLabel(session)} · ${session.messages.length} 条${marker}`,
      );
    });
    lines.push("");
    if (hiddenResidue) {
      lines.push(`已隐藏 ${hiddenResidue} 条侧边栏/镜像残留；发送 \`/list all\` 查看全部，或 \`/list residue\` 只看残留。`);
      lines.push("");
    }
    lines.push("使用 `/switch <序号或ID>` 切换会话；使用 `/rename 新标题` 或 `/rename <序号> 新标题` 改名；使用 `/delete <序号或ID>`、`/delete 1 2 3`、`/delete 1-18`、`/delete 3-7 8-12` 删除会话；删除需按预览里的 `/confirm delete <序号或区间>` 确认；使用 `/new [标题]` 创建新会话。");
    return lines.join("\n");
  }

  function formatAnswer(result, session) {
    const settings = effectiveSessionSettings(session);
    const meta = [
      formatDuration(result.durationMs),
      result.tokens ? `${result.tokens} tokens` : "",
      result.mode ? `mode ${result.mode}` : "",
      result.threadId ? `thread ${result.threadId}` : "",
      settings.model || codexModelLabel,
      settings.provider ? `provider ${settings.provider}` : "",
      settings.serviceTier ? `speed ${displayServiceTier(settings.serviceTier)}` : "",
      `会话 ${session.id}`,
    ].filter(Boolean).join(" · ");
    return [
      `**${ENGINE_LABEL} 已完成**`,
      "",
      result.text,
      "",
      "---",
      meta,
    ].join("\n");
  }

  function formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  }

  function threadHealthThresholds() {
    return {
      warningBytes: CONFIG.threadHealthWarningBytes,
      criticalBytes: CONFIG.threadHealthCriticalBytes,
      warningResumeMs: CONFIG.threadHealthWarningResumeMs,
      persistentResumeMs: CONFIG.threadHealthPersistentResumeMs,
      criticalResumeMs: CONFIG.threadHealthCriticalResumeMs,
    };
  }

  function formatThreadHealthMegabytes(bytes) {
    if (bytes === null || bytes === undefined || bytes === "") return "未知";
    const value = Number(bytes);
    return Number.isFinite(value) && value >= 0 ? `${(value / 1_000_000).toFixed(1)} MB` : "未知";
  }

  function threadHealthReminderMarkdown(assessment) {
    const samples = assessment.samples.map((value) => `${Math.round(value / 1000)} 秒`).join("、");
    const urgent = assessment.level >= 2;
    const persistentOnly = assessment.reason === "warning_persistent_resume";
    return [
      urgent ? "**当前会话建议切换**" : "**会话健康提醒**",
      "",
      `线程记录：${formatThreadHealthMegabytes(assessment.rolloutBytes)}`,
      samples ? `最近 ${assessment.samples.length} 次本地线程恢复：${samples}` : "",
      "",
      urgent
        ? "当前线程已经达到建议切换的级别。这个时间只统计本地线程恢复，不包含模型生成和 Provider 网络耗时。"
        : persistentOnly
          ? "最近几次本地线程恢复持续偏慢，即使线程记录尚未达到大小阈值，也建议留意后续速度。"
          : "线程记录和本地线程恢复时间已同时达到提醒阈值，后续可能继续变慢。",
      "",
      "建议在合适的时候发送 `/new` 开启新会话。",
      "旧会话不会删除，之后仍可通过 `/list` 和 `/switch` 返回。",
      urgent ? "达到新的提醒级别前，本线程不会重复提示。" : "本线程进入更高提醒级别前不会重复提示。",
    ].filter(Boolean).join("\n");
  }

  async function maybeSendThreadHealthReminder(chatId, messageId, session, result) {
    if (!CONFIG.threadHealthReminder || result?.mode !== "app-server") return;
    const threadId = String(result?.threadId || session?.codexThreadId || "").trim();
    const resumeMs = Number(result?.threadResumeMs);
    if (!threadId || !Number.isFinite(resumeMs) || resumeMs < 0) return;

    let rolloutBytes;
    try {
      const info = await loadCodexThreadResumeInfo(threadId);
      if (info.rolloutPath && fs.existsSync(info.rolloutPath)) {
        rolloutBytes = fs.statSync(info.rolloutPath).size;
      }
    } catch (error) {
      log("WARN", "thread health rollout inspection failed", {
        messageId,
        sessionId: session.id,
        threadId,
        error: String(error?.message || error).slice(0, 1000),
      });
    }

    const thresholds = threadHealthThresholds();
    session.threadHealth = recordThreadHealthSample(session.threadHealth, {
      threadId,
      resumeMs,
      rolloutBytes,
    }, thresholds);
    saveSessions();
    const assessment = evaluateThreadHealth(session.threadHealth, thresholds);
    log("INFO", "thread health evaluated", {
      messageId,
      sessionId: session.id,
      threadId,
      rolloutBytes: assessment.rolloutBytes,
      resumeMs,
      medianResumeMs: assessment.medianResumeMs,
      level: assessment.level,
      notifiedLevel: assessment.notifiedLevel,
      reason: assessment.reason,
    });
    if (!assessment.shouldNotify) return;

    try {
      await sendMarkdown(
        chatId,
        threadHealthReminderMarkdown(assessment),
        `thread-health-${assessment.level}`,
        messageId,
      );
      session.threadHealth = markThreadHealthNotified(session.threadHealth, assessment.level);
      saveSessions();
      log("INFO", "thread health reminder sent", {
        messageId,
        sessionId: session.id,
        threadId,
        level: assessment.level,
        reason: assessment.reason,
      });
    } catch (error) {
      log("WARN", "thread health reminder failed", {
        messageId,
        sessionId: session.id,
        threadId,
        level: assessment.level,
        error: String(error?.message || error).slice(0, 1000),
      });
    }
  }

  function formatNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString("en-US") : "";
  }

  function formatTime(ms) {
    return new Date(ms).toLocaleString("zh-CN", { hour12: false });
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  return {
    handleCommand,
    handleSwitchCommand,
    parseRenameCommand,
    handleRenameCommand,
    cleanupPendingDeleteConfirmations,
    deleteConfirmationKey,
    forgetDeleteConfirmationsForThread,
    activeJobUsesThread,
    persistedActiveRunUsesThread,
    threadIsActiveAnywhere,
    removeThreadFromBridgeSessions,
    removeDeletedThreadsFromBridgeSessions,
    deletePreviewMarkdown,
    resolveDeleteItemsByIndexes,
    deleteBatchPreviewMarkdown,
    pendingDeleteItems,
    handleDeleteCommand,
    handleConfirmCommand,
    handleGoalCommand,
    commandArgs,
    handleProviderCommand,
    providerStatusMarkdown,
    providerListMarkdown,
    providerShortcutListMarkdown,
    providerDetailLine,
    handleModelCommand,
    normalizeReasoningEffort,
    validateReasoningSelection,
    modelStatusMarkdown,
    modelCapabilityMarkdown,
    modelTestMarkdown,
    modelListMarkdown,
    handleFastCommand,
    fastStatusMarkdown,
    runtimeCommandErrorMarkdown,
    stopClearMode,
    clearQueuedWorkForChat,
    clearQueueCommand,
    interruptSingleActiveJob,
    stopAllActiveJobs,
    stopCurrentJob,
    handleSteerCommand,
    handleCompactCommand,
    helpMarkdown,
    goalStatusLabel,
    goalSummary,
    goalMarkdown,
    statusMarkdown,
    failureStatsSummary,
    failureKindLabel,
    sessionContextSummary,
    compactThreadId,
    tokenUsageSummary,
    contextStatusBlock,
    contextMarkdown,
    readEventStatus,
    readAuthSummary,
    nowMarkdown,
    listMarkdown,
    parseSessionsListMode,
    visibleSessionItemsForListMode,
    sessionsMarkdown,
    formatAnswer,
    formatDuration,
    threadHealthThresholds,
    formatThreadHealthMegabytes,
    threadHealthReminderMarkdown,
    maybeSendThreadHealthReminder,
    formatNumber,
    formatTime,
    delay,
  };
}
