import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  sameResolvedPath,
  stripWindowsLongPathPrefix,
} from "../config/paths.mjs";
import openaiAccounts from "../codex/openai-accounts.cjs";
import { collapseContinuationEntries, normalizeThreadContinuity } from "../codex/thread-continuity.mjs";
import { normalizeProviderSwitch } from "../providers/session-switch.mjs";
import { normalizeNativeInputs } from "./native-inputs.mjs";
import {
  contextUsageFromTokenUsage,
  maxContextUsage,
  normalizeContextUsage,
  normalizeGoal,
  normalizeTokenUsage,
} from "./normalize.mjs";
import { normalizeThreadHealth } from "./thread-health.mjs";
import {
  loadRegisteredBridgeBindings,
  stateDirsForCodexHome,
} from "./codex-home-registry.mjs";
import {
  classifyCodexFailure,
  normalizeFailure,
} from "../logging/errors.mjs";

export function createSessionInventory(deps = {}) {
  const {
    acceptedEfforts,
    mapReasoningEffort,
    CONFIG,
    log,
    lockPath,
    codexStateDbPath,
    codexSessionIndexPath,
    codexGlobalStatePath,
    codexSidebarLockPath,
    desktopCodexStateDbPath,
    desktopCodexSessionIndexPath,
    desktopCodexGlobalStatePath,
    desktopCodexSidebarLockPath,
    shouldMirrorDesktopCodexHome,
    MODEL_REASONING_REGISTRY,
    CODEX_THREAD_ID_PATTERN,
    resolveCodexConfigValue,
    displayServiceTier,
    serviceTierForThreadSettings,
    serviceTierForTurnSettings,
    getChatState,
    getSession,
    saveSessions,
    sessions,
    chatEventContexts,
    stats,
    isOwnerDm,
  } = deps;
  const claudeBridge = deps.claudeBridge;
  const antigravityBridge = deps.antigravityBridge;

  const shorten = (...args) => deps.shorten(...args);
  const sqliteJson = (...args) => deps.sqliteJson(...args);
  const loadCodexThreadRecord = (...args) => deps.loadCodexThreadRecord(...args);
  const loadCodexThreadRecordFromDb = (...args) => deps.loadCodexThreadRecordFromDb(...args);
  const updateCodexThreadTitleInDb = (...args) => deps.updateCodexThreadTitleInDb(...args);
  const withCodexSidebarLock = (...args) => deps.withCodexSidebarLock(...args);
  const registeredCodexHomeRegistry = (...args) => deps.registeredCodexHomeRegistry(...args);
  const loadDeletedThreadIds = (...args) => deps.loadDeletedThreadIds(...args);
  const isCodexThreadDeletedForBridge = (...args) => deps.isCodexThreadDeletedForBridge(...args);
  const syncCodexSessionIndex = (...args) => deps.syncCodexSessionIndex(...args);
  const hasCodexSessionIndexEntry = (...args) => deps.hasCodexSessionIndexEntry(...args);
  const normalizeSessionIdentity = (...args) => deps.normalizeSessionIdentity(...args);
  const formatTime = (...args) => deps.formatTime(...args);

  function cleanOverride(value) {
    const text = String(value || "").trim();
    return text || "";
  }

  function effectiveSessionSettings(session) {
    if (CONFIG.engine === 'antigravity') return antigravityBridge.settings(session);
    if (CONFIG.engine === 'claude') return claudeBridge.settings(session);
    const model = cleanOverride(session?.modelOverride) || CONFIG.codexModel || resolveCodexConfigValue("model") || "";
    const provider = cleanOverride(session?.providerOverride) || (process.env.CODEX_FEISHU_OPENAI_DEFAULT_ACCOUNT ? "openai" : resolveCodexConfigValue("model_provider")) || "openai";
    const requestedReasoning = cleanOverride(session?.reasoningOverride) || CONFIG.codexReasoning || resolveCodexConfigValue("model_reasoning_effort") || MODEL_REASONING_REGISTRY.defaultRequestedEffort;
    const reasoningMapping = mapReasoningEffort({ provider, model, effort: requestedReasoning }, MODEL_REASONING_REGISTRY);
    const reasoning = reasoningMapping.supported ? reasoningMapping.effectiveEffort : "";
    const serviceTier = cleanOverride(session?.serviceTierOverride) || resolveCodexConfigValue("service_tier") || "";
    const accountAlias = provider === "openai"
      ? cleanOverride(session?.openaiAccountOverride) || (!session?.providerOverride ? process.env.CODEX_FEISHU_OPENAI_DEFAULT_ACCOUNT || openaiAccounts.defaultAccount(CONFIG.codexHome) : "") : "";
    return { model, provider, accountAlias, requestedReasoning, reasoning, reasoningMapping, serviceTier };
  }

  function assertReasoningSupported(settings) {
    if (settings.reasoningMapping.supported) return settings;
    const capability = settings.reasoningMapping.capability;
    throw new Error(`${capability.name} 不支持推理强度 ${settings.requestedReasoning}；可接受请求值：${acceptedEfforts(capability, MODEL_REASONING_REGISTRY).join("、") || "无"}`);
  }

  function settingsSummary(session) {
    const settings = effectiveSessionSettings(session);
    if (CONFIG.engine === 'antigravity') return `Antigravity CLI · provider ${settings.provider} · model ${settings.model || '官方默认'} · effort ${settings.reasoning || '官方默认'}`;
    if (CONFIG.engine === 'claude') return `Claude Code CLI · provider ${settings.provider} · model ${settings.model} · effort ${settings.reasoning}`;
    return [
      `provider ${settings.accountAlias || settings.provider || "默认"}`,
      `model ${settings.model || "默认"}`,
      `reasoning ${settings.requestedReasoning || "默认"}${settings.reasoningMapping.mapped ? ` → ${settings.reasoning}` : ""}`,
      `speed ${displayServiceTier(settings.serviceTier) || "默认"}`,
    ].join(" · ");
  }

  function applySessionThreadOverrides(params, session, options = {}) {
    const settings = options.settings || effectiveSessionSettings(session);
    const serviceTier = serviceTierForThreadSettings(settings, options);
    if (settings.model) params.model = settings.model;
    if (settings.provider) params.modelProvider = settings.provider;
    if (serviceTier) params.serviceTier = serviceTier;
    return params;
  }

  function applySessionTurnOverrides(params, session, options = {}) {
    const settings = assertReasoningSupported(options.settings || effectiveSessionSettings(session));
    const serviceTier = serviceTierForTurnSettings(settings, options);
    if (settings.model) params.model = settings.model;
    if (serviceTier) params.serviceTier = serviceTier;
    if (settings.reasoning) params.effort = settings.reasoning;
    return params;
  }

  function setSessionOverride(session, key, value) {
    session[key] = cleanOverride(value);
    session.updatedAt = Date.now();
    saveSessions();
  }

  function clearProviderBundleOverride(session) {
    if (!session?.providerBundleOverride) return;
    session.providerBundleOverride = "";
    session.modelOverride = "";
    session.reasoningOverride = "";
    session.updatedAt = Date.now();
  }

  function applyProviderBundleOverride(session, bundle) {
    session.providerBundleOverride = bundle.id;
    session.providerOverride = bundle.provider;
    session.modelOverride = bundle.model;
    if (bundle.reasoning) session.reasoningOverride = bundle.reasoning;
    session.updatedAt = Date.now();
    saveSessions();
  }

  function recordFailureStats(failure) {
    const item = normalizeFailure(failure) || classifyCodexFailure(failure);
    stats.failuresByKind[item.kind] = (stats.failuresByKind[item.kind] || 0) + 1;
  }

  async function resetCurrentSession(chatId) {
    await syncChatSessionsWithCodex(chatId);
    const session = getSession(chatId);
    session.messages = [];
    session.codexThreadId = "";
    session.lastTokenUsage = null;
    session.lastContextUsage = null;
    session.lastContextPeakUsage = null;
    session.lastCompactedAt = null;
    session.lastThreadStatus = "";
    session.threadHealth = null;
    session.updatedAt = Date.now();
    saveSessions();
    return session;
  }

  function normalizeSessionData(session) {
    const now = Date.now();
    return {
      id: session?.id || crypto.randomBytes(4).toString("hex"),
      title: session?.title || "未命名会话",
      createdAt: Number(session?.createdAt) || now,
      updatedAt: Number(session?.updatedAt) || Number(session?.createdAt) || now,
      messages: Array.isArray(session?.messages) ? session.messages : [],
      codexThreadId: typeof session?.codexThreadId === "string" ? session.codexThreadId : "",
      ...normalizeThreadContinuity(session),
      providerSwitchTransaction: normalizeProviderSwitch(session?.providerSwitchTransaction),
      pendingNativeInputs: normalizeNativeInputs(session?.pendingNativeInputs),
      engine: session?.engine || 'codex',
      claudeSessionId: typeof session?.claudeSessionId === 'string' ? session.claudeSessionId : '',
      antigravitySessionId: typeof session?.antigravitySessionId === 'string' ? session.antigravitySessionId : '',
      antigravitySourceId: typeof session?.antigravitySourceId === 'string' ? session.antigravitySourceId : '',
      antigravityHome: typeof session?.antigravityHome === 'string' ? session.antigravityHome : '',
      antigravityWorkspace: typeof session?.antigravityWorkspace === 'string' ? session.antigravityWorkspace : '',
      antigravityOriginBot: typeof session?.antigravityOriginBot === 'string' ? session.antigravityOriginBot : '',
      userRenamed: session?.userRenamed === true,
      claudeSessionHome: typeof session?.claudeSessionHome === 'string' ? session.claudeSessionHome : '',
      claudeWorkspace: typeof session?.claudeWorkspace === 'string' ? session.claudeWorkspace : '',
      claudeOriginBot: typeof session?.claudeOriginBot === 'string' ? session.claudeOriginBot : '',
      lastTokenUsage: normalizeTokenUsage(session?.lastTokenUsage),
      lastContextUsage: normalizeContextUsage(session?.lastContextUsage),
      lastContextPeakUsage: normalizeContextUsage(session?.lastContextPeakUsage),
      lastCompactedAt: Number(session?.lastCompactedAt) || null,
      lastThreadStatus: typeof session?.lastThreadStatus === "string" ? session.lastThreadStatus : "",
      threadHealth: normalizeThreadHealth(session?.threadHealth, session?.codexThreadId),
      lastGoal: normalizeGoal(session?.lastGoal),
      lastFailure: normalizeFailure(session?.lastFailure),
      modelOverride: cleanOverride(session?.modelOverride),
      reasoningOverride: cleanOverride(session?.reasoningOverride),
      providerOverride: cleanOverride(session?.providerOverride),
      openaiAccountOverride: cleanOverride(session?.openaiAccountOverride),
      providerBundleOverride: cleanOverride(session?.providerBundleOverride),
      serviceTierOverride: cleanOverride(session?.serviceTierOverride),
    };
  }

  function normalizeRenameTitle(value) {
    return shorten(String(value || "").replace(/\r\n/g, "\n").replace(/\n+/g, " "), 120);
  }

  function updateSessionTokenUsage(session, tokenUsage) {
    if (!session) return null;
    const usage = normalizeTokenUsage(tokenUsage);
    if (!usage) return null;
    session.lastTokenUsage = usage;
    session.lastContextUsage = contextUsageFromTokenUsage(usage);
    session.lastContextPeakUsage = maxContextUsage(session.lastContextPeakUsage, session.lastContextUsage);
    session.updatedAt = Date.now();
    saveSessions();
    return usage;
  }

  function updateSessionThreadStatus(session, status) {
    if (!session) return;
    session.lastThreadStatus = String(status || "");
    session.updatedAt = Date.now();
    saveSessions();
  }

  function updateSessionGoal(session, goal) {
    if (!session) return null;
    session.lastGoal = normalizeGoal(goal);
    session.updatedAt = Date.now();
    saveSessions();
    return session.lastGoal;
  }

  function updateSessionFailure(session, failure) {
    if (!session) return null;
    session.lastFailure = normalizeFailure(failure);
    session.updatedAt = Date.now();
    saveSessions();
    return session.lastFailure;
  }

  function clearSessionFailure(session) {
    if (!session) return;
    if (!session.lastFailure) return;
    session.lastFailure = null;
    session.updatedAt = Date.now();
    saveSessions();
  }

  function markSessionCompacted(session) {
    if (!session) return;
    session.lastCompactedAt = Date.now();
    session.lastContextUsage = null;
    session.lastContextPeakUsage = null;
    session.updatedAt = Date.now();
    saveSessions();
  }

  function dedupeSessions(items) {
    const seenIds = new Set();
    const result = [];
    for (const item of items) {
      if (!item?.id || seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      result.push(item);
    }
    return result.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  }

  function listChatSessions(chatId) {
    const chatState = getChatState(chatId);
    chatState.sessions = dedupeSessions(chatState.sessions).slice(0, sessionListLimit());
    saveSessions();
    return chatState.sessions;
  }

  function boundedListLimit(value = CONFIG.listLimit) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return 100;
    return Math.max(1, Math.min(200, Math.floor(number)));
  }

  function sessionListLimit() {
    return boundedListLimit(CONFIG.listLimit);
  }

  function codexThreadLink(threadId) {
    const id = String(threadId || "").trim();
    return id ? `codex://threads/${id}` : "未创建 thread";
  }

  function cleanCodexThreadTitle(value) {
    let text = String(value || "").replace(/\r\n/g, "\n").trim();
    if (!text) return "";
    text = text.split(/\n---\n来源：飞书消息/)[0];
    text = text.split(/\n---\n来源: 飞书消息/)[0];
    text = text.replace(/^飞书：[0-9a-f]{8}\s*·\s*/i, "");
    return shorten(text, 80);
  }

  function codexThreadTime(row, field) {
    const ms = Number(row?.[`${field}_at_ms`]);
    if (Number.isFinite(ms) && ms > 0) return ms;
    const seconds = Number(row?.[`${field}_at`]);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    return 0;
  }

  async function loadVisibleCodexThreads(limit = CONFIG.listLimit) {
    if (!CONFIG.syncSessionsFromCodex || !fs.existsSync(codexStateDbPath)) return null;
    const safeLimit = boundedListLimit(limit);
    return await sqliteJson(
      codexStateDbPath,
      [
        "select id, substr(title, 1, 240) as title,",
        "substr(first_user_message, 1, 240) as first_user_message,",
        "substr(preview, 1, 240) as preview,",
        "created_at, updated_at, created_at_ms, updated_at_ms,",
        "rollout_path",
        "from threads",
        "where coalesce(archived, 0) = 0",
        "order by coalesce(updated_at_ms, updated_at * 1000, created_at_ms, created_at * 1000, 0) desc",
        "limit ?;",
      ].join(" "),
      [safeLimit],
    );
  }

  async function loadVisibleCodexThreadIds() {
    const rows = await loadVisibleCodexThreads(200);
    if (!rows) return null;
    return new Set(rows.map((row) => String(row.id || "").trim()).filter(Boolean));
  }

  function codexThreadResumeInfoFromRecord(threadId, record) {
    const id = String(threadId || record?.id || "").trim();
    const hasDb = Boolean(record);
    const archived = hasDb && Number(record.archived || 0) !== 0;
    const rolloutPath = hasDb ? stripWindowsLongPathPrefix(record.rollout_path || "") : "";
    const hasRollout = Boolean(rolloutPath && fs.existsSync(rolloutPath));
    let reason = "";
    if (!id) reason = "missing-thread-id";
    else if (!hasDb) reason = "missing-db";
    else if (archived) reason = "archived";
    else if (!rolloutPath) reason = "missing-rollout-path";
    else if (!hasRollout) reason = "missing-rollout-file";

    return {
      threadId: id,
      record: record || null,
      hasDb,
      archived,
      rolloutPath,
      hasRollout,
      resumeable: Boolean(id && hasDb && !archived && hasRollout),
      reason,
    };
  }

  async function loadCodexThreadResumeInfo(threadId) {
    const id = String(threadId || "").trim();
    if (!id) return codexThreadResumeInfoFromRecord("", null);
    const record = fs.existsSync(codexStateDbPath) ? await loadCodexThreadRecord(id) : null;
    return codexThreadResumeInfoFromRecord(id, record);
  }

  async function loadCodexThreadResumeInfoMap(threadIds) {
    const ids = [...new Set((threadIds || []).map((value) => String(value || "").trim()).filter(Boolean))];
    const map = new Map();
    for (const id of ids) {
      map.set(id, await loadCodexThreadResumeInfo(id));
    }
    return map;
  }

  function missingRolloutFailureForThread(threadId, reason = "") {
    const suffix = reason ? ` (${reason})` : "";
    return classifyCodexFailure(new Error(`no rollout found for thread id ${threadId}${suffix}`));
  }

  function markSessionResumeFailure(session, info) {
    if (!session) return;
    const threadId = String(session.codexThreadId || info?.threadId || "").trim();
    if (!threadId) return;
    session.lastFailure = normalizeFailure(missingRolloutFailureForThread(threadId, info?.reason || ""));
    session.lastThreadStatus = "missing_rollout";
  }

  function sessionHasRunnableCodexBinding(session, resumeInfoByThread = null) {
    const threadId = String(session?.codexThreadId || "").trim();
    if (!threadId) return true;
    if (!resumeInfoByThread) return true;
    return Boolean(resumeInfoByThread.get(threadId)?.resumeable);
  }

  function shouldKeepEmptyCurrentSession(session, chatState) {
    if (!session || session.id !== chatState.currentSessionId) return false;
    if (String(session.codexThreadId || "").trim()) return false;
    if (Array.isArray(session.messages) && session.messages.length > 0) return true;
    const createdAt = Number(session.createdAt || session.updatedAt || 0);
    const ageMs = Date.now() - createdAt;
    return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= CONFIG.keepEmptySessionMs;
  }

  function ensureRunnableCurrentSession(chatId, chatState, resumeInfoByThread, reason = "sync") {
    if (!chatState || !Array.isArray(chatState.sessions)) return { changed: false, session: null };

    const current = chatState.sessions.find((session) => session.id === chatState.currentSessionId) || null;
    if (current && sessionHasRunnableCodexBinding(current, resumeInfoByThread)) {
      return { changed: false, session: current };
    }

    if (current) {
      markSessionResumeFailure(current, resumeInfoByThread?.get(String(current.codexThreadId || "").trim()));
    }

    let fallback = current
      ? null
      : chatState.sessions.find((session) => sessionHasRunnableCodexBinding(session, resumeInfoByThread));
    let createdNew = false;
    if (!fallback) {
      fallback = createSessionData(current?.title || "新会话");
      chatState.sessions.unshift(fallback);
      createdNew = true;
    }

    const previousSessionId = chatState.currentSessionId || "";
    const previousThreadId = String(current?.codexThreadId || "").trim();
    chatState.currentSessionId = fallback.id;
    chatState.sessions = dedupeSessions(chatState.sessions).slice(0, sessionListLimit());
    log("WARN", "current session is not resumable; switched current session", {
      chatId,
      reason,
      previousSessionId,
      previousThreadId,
      nextSessionId: fallback.id,
      nextThreadId: fallback.codexThreadId || "",
      createdNew,
    });
    return { changed: true, session: fallback, previous: current, createdNew };
  }

  async function syncChatSessionsWithCodex(chatId, options = {}) {
    const keepEmptyCurrent = options.keepEmptyCurrent !== false;
    const ensureRunnableCurrent = options.ensureRunnableCurrent !== false;
    if (!CONFIG.syncSessionsFromCodex) return sessions.chats[chatId]?.sessions || [];
    const chatState = sessions.chats[chatId];
    if (!chatState || !Array.isArray(chatState.sessions)) return [];

    const before = chatState.sessions.length;
    const beforeCurrent = chatState.currentSessionId || "";
    const normalized = dedupeSessions(chatState.sessions.map(normalizeSessionIdentity)).slice(0, sessionListLimit());
    const resumeInfoByThread = await loadCodexThreadResumeInfoMap(
      normalized.map((session) => session.codexThreadId),
    );
    chatState.sessions = normalized.filter((session) => {
      const threadId = String(session.codexThreadId || "").trim();
      if (threadId) return !isCodexThreadDeletedForBridge(threadId);
      return keepEmptyCurrent && shouldKeepEmptyCurrentSession(session, chatState);
    });

    if (!chatState.sessions.some((session) => session.id === chatState.currentSessionId)) {
      chatState.currentSessionId = chatState.sessions[0]?.id || "";
    }

    const runnableCurrent = ensureRunnableCurrent
      ? ensureRunnableCurrentSession(chatId, chatState, resumeInfoByThread, options.reason || "sync")
      : { changed: false };

    const changed = before !== chatState.sessions.length
      || beforeCurrent !== (chatState.currentSessionId || "")
      || normalized.length !== before
      || runnableCurrent.changed;
    if (changed) {
      saveSessions();
      log("INFO", "synced feishu sessions from codex state", {
        chatId,
        before,
        after: chatState.sessions.length,
      });
    }
    return chatState.sessions;
  }

  function titleFromCodexThread(row) {
    return cleanCodexThreadTitle(row?.title)
      || cleanCodexThreadTitle(row?.first_user_message)
      || cleanCodexThreadTitle(row?.preview)
      || "未命名会话";
  }

  function uniqueThreadDisplayId(threadId, allThreadIds = []) {
    const id = String(threadId || "").trim();
    if (!id) return "";
    const peers = Array.isArray(allThreadIds)
      ? allThreadIds.map((value) => String(value || "").trim()).filter((value) => value && value !== id)
      : [];
    for (let length = 8; length <= id.length; length += 1) {
      const prefix = id.slice(0, length);
      if (!peers.some((peer) => peer.startsWith(prefix))) return prefix;
    }
    return id;
  }

  function sessionEntryFromCodexThread(row, allThreadIds = []) {
    const threadId = String(row?.id || "").trim();
    const createdAt = codexThreadTime(row, "created") || Date.now();
    const updatedAt = codexThreadTime(row, "updated") || createdAt;
    return {
      ...normalizeSessionData({
        id: uniqueThreadDisplayId(threadId, allThreadIds),
        title: titleFromCodexThread(row),
        createdAt,
        updatedAt,
        messages: [],
        codexThreadId: threadId,
      }),
      _codexOnly: true,
      _sourceChatId: "",
      _rank: 3,
      _isCurrent: false,
    };
  }

  function normalizeThreadSource(value) {
    return String(value || "").trim();
  }

  function threadSourcesText(entry) {
    const threadId = String(entry?.codexThreadId || "").trim();
    const flags = threadSourceFlags(entry);
    if (!threadId && flags.hasBridge) return "Bridge 本地空会话";
    if (flags.hasPrimaryDb && flags.hasPrimaryRollout) {
      const parts = [shouldMirrorDesktopCodexHome ? "源空间完整" : "全局 Codex Home 完整"];
      if (flags.hasBridge) parts.push("Bridge绑定");
      if (shouldMirrorDesktopCodexHome) {
        if (flags.hasDesktopDb && flags.hasDesktopRollout) parts.push("桌面镜像完整");
        else if (flags.hasDesktopAny) parts.push("桌面镜像不完整");
        else parts.push("桌面镜像缺失");
      }
      return parts.join(" + ");
    }
    if (flags.hasBridge && !flags.hasPrimaryDb && !flags.hasPrimaryRollout) return "Bridge 悬空绑定";
    if (flags.hasBridge && flags.hasPrimaryDb && !flags.hasPrimaryRollout) return "Bridge绑定 + Codex DB + 缺 rollout";
    if (flags.hasBridge && !flags.hasPrimaryDb && flags.hasPrimaryRollout) return "Bridge绑定 + rollout + 缺 Codex DB";
    if (flags.hasPrimaryDb && !flags.hasPrimaryRollout) return "Codex DB + 缺 rollout";
    if (!flags.hasPrimaryDb && flags.hasPrimaryRollout) return "rollout 残留";
    if (flags.hasSourceSidebar && !flags.hasDesktopAny) return "侧边栏残留";
    if (flags.hasDesktopAny && !flags.hasAnyPrimary) {
      if (flags.hasDesktopDb && flags.hasDesktopRollout) return "桌面镜像完整（源空间缺失）";
      return "桌面镜像残留";
    }
    const sources = [...threadSourceSet(entry)].filter(Boolean);
    return sources.length ? sources.join("+") : "Bridge";
  }

  function threadSourceSet(entry) {
    const sources = [
      ...(Array.isArray(entry?._sources) ? entry._sources : []),
      ...(Array.isArray(entry?.sources) ? entry.sources : []),
    ];
    return new Set(sources.map((value) => String(value || "").trim()).filter(Boolean));
  }

  function threadHasSource(entry, pattern) {
    const regex = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), "i");
    for (const source of threadSourceSet(entry)) {
      if (regex.test(source)) return true;
    }
    return false;
  }

  function rolloutPathExists(entry) {
    const rolloutPath = stripWindowsLongPathPrefix(entry?._rolloutPath || entry?.rolloutPath || "");
    return Boolean(rolloutPath && fs.existsSync(rolloutPath));
  }

  function threadSourceFlags(entry) {
    const sources = [...threadSourceSet(entry)];
    const hasBridge = sources.some((source) => /Bridge|绑定/i.test(source));
    const hasPrimaryDb = sources.some((source) => /^Codex DB$/i.test(source));
    const hasPrimaryRolloutListing = sources.some((source) => /^rollout-only$/i.test(source));
    const hasPrimaryRollout = hasPrimaryRolloutListing || (hasPrimaryDb && rolloutPathExists(entry));
    const hasSourceIndex = sources.some((source) => /^session_index$/i.test(source));
    const hasSourceGlobalState = sources.some((source) => /^global-state$/i.test(source));
    const hasSourceSidebar = hasSourceIndex || hasSourceGlobalState;
    const hasDesktopDb = sources.some((source) => /^desktop DB mirror$/i.test(source));
    const hasDesktopRollout = sources.some((source) => /^desktop rollout mirror$/i.test(source));
    const hasDesktopIndex = sources.some((source) => /^desktop session_index mirror$/i.test(source));
    const hasDesktopGlobalState = sources.some((source) => /^desktop global-state mirror$/i.test(source));
    const hasDesktopAny = hasDesktopDb || hasDesktopRollout || hasDesktopIndex || hasDesktopGlobalState;
    const hasAnyPrimary = hasPrimaryDb || hasPrimaryRollout || hasSourceSidebar;
    return {
      hasBridge,
      hasPrimaryDb,
      hasPrimaryRollout,
      hasSourceIndex,
      hasSourceGlobalState,
      hasSourceSidebar,
      hasDesktopDb,
      hasDesktopRollout,
      hasDesktopIndex,
      hasDesktopGlobalState,
      hasDesktopAny,
      hasAnyPrimary,
    };
  }

  function threadListGroup(entry) {
    if (entry?._isCurrent) return "current";

    const flags = threadSourceFlags(entry);

    if (flags.hasBridge && (!flags.hasPrimaryDb || !flags.hasPrimaryRollout)) return "broken";
    if (flags.hasPrimaryDb && !flags.hasPrimaryRollout) return "broken";
    if (flags.hasPrimaryDb && flags.hasPrimaryRollout) return "normal";
    if (flags.hasPrimaryRollout || flags.hasSourceSidebar || flags.hasDesktopAny || flags.hasPrimaryDb) return "residue";
    return "residue";
  }

  function threadListGroupRank(entry) {
    switch (threadListGroup(entry)) {
      case "current": return 0;
      case "normal": return 1;
      case "broken": return 2;
      case "residue": return 3;
      default: return 9;
    }
  }

  function threadListGroupTitle(group) {
    switch (group) {
      case "current": return "当前会话";
      case "normal": return "正常会话";
      case "broken": return "异常会话";
      case "residue": return "残留记录";
      default: return "其他记录";
    }
  }

  function threadEntryIsRunnable(entry) {
    const threadId = String(entry?.codexThreadId || "").trim();
    if (!threadId) return true;
    const flags = threadSourceFlags(entry);
    return Boolean(flags.hasPrimaryDb && flags.hasPrimaryRollout);
  }

  function threadListStatusText(entry) {
    const group = threadListGroup(entry);
    const flags = threadSourceFlags(entry);
    const threadId = String(entry?.codexThreadId || "").trim();

    if (group === "current") {
      if (!threadId) return "当前：尚未创建 Codex thread，下一条普通消息会创建";
      if (flags.hasBridge && (!flags.hasPrimaryDb || !flags.hasPrimaryRollout)) return "当前异常：Codex 原生记录或 rollout 缺失";
      if (shouldMirrorDesktopCodexHome && flags.hasPrimaryDb && flags.hasPrimaryRollout && !(flags.hasDesktopDb && flags.hasDesktopRollout)) return "当前：桌面镜像告警";
      return "当前";
    }
    if (group === "normal") {
      if (shouldMirrorDesktopCodexHome && !(flags.hasDesktopDb && flags.hasDesktopRollout)) return "正常：桌面镜像告警";
      return "正常";
    }
    if (group === "broken") {
      if (flags.hasBridge && !flags.hasPrimaryDb && !flags.hasPrimaryRollout) return "异常：Bridge 悬空绑定";
      if (!flags.hasPrimaryRollout) return "异常：缺 rollout，不能续接";
      if (!flags.hasPrimaryDb) return "异常：缺 Codex DB 记录";
      return "异常";
    }
    if (flags.hasPrimaryRollout && !flags.hasPrimaryDb) return "残留：rollout 文件";
    if (flags.hasSourceIndex) return "残留：侧边栏索引";
    if (flags.hasSourceGlobalState) return "残留：侧边栏状态";
    if (flags.hasDesktopAny) return "残留：桌面端镜像";
    if (flags.hasPrimaryDb && !flags.hasBridge) return "残留：Codex DB only";
    return "残留";
  }

  function threadLocationText(entry) {
    return entry?._location ? `；位置：${entry._location}` : "";
  }

  function threadDeleteStateText(entry) {
    if (!entry?.codexThreadId) return "不可删除：无 threadId";
    return entry?._deletable === false ? `不可删除：${entry._deleteBlockReason || "来源信息不足"}` : "可删除";
  }

  function addThreadSource(entry, source) {
    const value = normalizeThreadSource(source);
    if (!value) return;
    if (!Array.isArray(entry._sources)) entry._sources = [];
    if (!entry._sources.includes(value)) entry._sources.push(value);
  }

  function threadEntryUpdatedAt(entry) {
    return Number(entry?.updatedAt || entry?._updatedAt || entry?.createdAt || 0);
  }

  function normalizeThreadTime(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  function latestSessionMessageTime(messages) {
    if (!Array.isArray(messages)) return 0;
    let latest = 0;
    for (const message of messages) {
      latest = Math.max(latest, normalizeThreadTime(message?.at));
    }
    return latest;
  }

  function threadEntryConversationUpdatedAt(entry) {
    const explicit = normalizeThreadTime(entry?._conversationUpdatedAt);
    if (explicit) return explicit;
    const messageTime = latestSessionMessageTime(entry?.messages);
    if (messageTime) return messageTime;
    const sources = threadSourceSet(entry);
    if (sources.has("Codex DB") || sources.has("rollout-only")) {
      return normalizeThreadTime(entry?.updatedAt) || normalizeThreadTime(entry?.createdAt);
    }
    return 0;
  }

  function threadEntryLastSeenAt(entry) {
    return normalizeThreadTime(entry?._lastSeenAt)
      || threadEntryConversationUpdatedAt(entry)
      || normalizeThreadTime(entry?.updatedAt)
      || normalizeThreadTime(entry?.createdAt);
  }

  function threadListSortTime(entry) {
    return threadEntryConversationUpdatedAt(entry) || threadEntryLastSeenAt(entry);
  }

  function sortThreadListEntries(entries) {
    return [...entries].sort((a, b) => {
      const groupDelta = threadListGroupRank(a) - threadListGroupRank(b);
      if (groupDelta) return groupDelta;
      const timeDelta = threadListSortTime(b) - threadListSortTime(a);
      if (timeDelta) return timeDelta;
      return String(a.title || a.id || a.codexThreadId || "").localeCompare(String(b.title || b.id || b.codexThreadId || ""));
    });
  }

  function threadListTimeLabel(entry) {
    const value = threadListSortTime(entry);
    return value > 0 ? formatTime(value) : "未知";
  }

  function threadListTimeLabelName(entry) {
    return threadEntryConversationUpdatedAt(entry) ? "最近对话" : "最近记录";
  }

  function mergeThreadInventoryEntry(map, entry) {
    const threadId = String(entry?.codexThreadId || "").trim();
    const sessionKey = entry?._sourceChatId && entry?.id ? `${entry._sourceChatId}:${entry.id}` : "";
    const key = threadId ? `thread:${threadId}` : `session:${sessionKey || entry?.id || crypto.randomBytes(4).toString("hex")}`;
    const current = map.get(key);
    if (!current) {
      const conversationUpdatedAt = threadEntryConversationUpdatedAt(entry);
      const lastSeenAt = threadEntryLastSeenAt(entry);
      const next = {
        ...entry,
        _sources: Array.isArray(entry?._sources) ? [...entry._sources] : [],
        _conversationUpdatedAt: conversationUpdatedAt,
        _lastSeenAt: Math.max(conversationUpdatedAt, lastSeenAt),
        _deletable: entry?._deletable !== false,
        _deleteBlockReason: entry?._deleteBlockReason || "",
        _rank: Number(entry?._rank ?? 9),
      };
      map.set(key, next);
      return next;
    }

    for (const source of entry._sources || []) addThreadSource(current, source);
    if (!current.title || current.title === "未命名会话" || current.title === "Untitled") current.title = entry.title || current.title;
    if (!current.id && entry.id) current.id = entry.id;
    if (!current.codexThreadId && entry.codexThreadId) current.codexThreadId = entry.codexThreadId;
    if (!current._sourceChatId && entry._sourceChatId) current._sourceChatId = entry._sourceChatId;
    if (entry._isCurrent) current._isCurrent = true;
    if (entry._codexOnly === false) current._codexOnly = false;
    if (entry._rolloutPath && !current._rolloutPath) current._rolloutPath = entry._rolloutPath;
    if (entry._dbRecord && !current._dbRecord) current._dbRecord = entry._dbRecord;
    if (entry._location && !current._location) current._location = entry._location;
    if (Number(entry._rank ?? 9) < Number(current._rank ?? 9)) current._rank = entry._rank;
    const conversationUpdatedAt = threadEntryConversationUpdatedAt(entry);
    if (conversationUpdatedAt > normalizeThreadTime(current._conversationUpdatedAt)) current._conversationUpdatedAt = conversationUpdatedAt;
    const lastSeenAt = threadEntryLastSeenAt(entry);
    if (lastSeenAt > normalizeThreadTime(current._lastSeenAt)) current._lastSeenAt = lastSeenAt;
    if (threadEntryUpdatedAt(entry) > threadEntryUpdatedAt(current)) current.updatedAt = entry.updatedAt || current.updatedAt;
    if (entry._deletable === false) {
      current._deletable = false;
      current._deleteBlockReason = entry._deleteBlockReason || current._deleteBlockReason;
    }
    return current;
  }

  function threadIdFromPath(filePath) {
    const match = String(filePath || "").match(CODEX_THREAD_ID_PATTERN);
    return match ? match[0] : "";
  }

  function readRolloutSummary(rolloutPath) {
    const result = {
      threadId: threadIdFromPath(rolloutPath),
      title: "",
      createdAt: 0,
      updatedAt: 0,
    };
    if (!rolloutPath || !fs.existsSync(rolloutPath)) return result;
    try {
      const stat = fs.statSync(rolloutPath);
      result.updatedAt = stat.mtimeMs || 0;
      result.createdAt = stat.birthtimeMs || result.updatedAt;
    } catch {}
    try {
      const fd = fs.openSync(rolloutPath, "r");
      const buffer = Buffer.alloc(128 * 1024);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      fs.closeSync(fd);
      const lines = buffer.toString("utf8", 0, bytes).split(/\r?\n/).filter(Boolean).slice(0, 60);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          const payload = parsed?.payload || parsed;
          const threadId = payload?.id || payload?.thread_id || payload?.threadId || parsed?.thread_id || parsed?.threadId;
          if (!result.threadId && typeof threadId === "string" && CODEX_THREAD_ID_PATTERN.test(threadId)) result.threadId = threadId;
          const title = payload?.title || payload?.cwd || payload?.working_dir || parsed?.title || "";
          if (!result.title && title) result.title = cleanCodexThreadTitle(title);
        } catch {}
        if (result.threadId && result.title) break;
      }
    } catch {}
    return result;
  }

  function listRolloutFiles(codexHome = CONFIG.codexHome) {
    const root = path.join(codexHome, "sessions");
    const files = [];
    if (!fs.existsSync(root)) return files;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const item of entries) {
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
          stack.push(fullPath);
        } else if (item.isFile() && item.name.endsWith(".jsonl") && item.name.includes("rollout")) {
          files.push(fullPath);
        }
      }
    }
    return files;
  }

  function loadSessionIndexEntries(sessionIndexPath = codexSessionIndexPath) {
    if (!fs.existsSync(sessionIndexPath)) return [];
    const entries = [];
    const lines = fs.readFileSync(sessionIndexPath, "utf8").replace(/\r\n/g, "\n").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        const id = String(parsed?.id || "").trim();
        if (!id) continue;
        entries.push({
          id,
          title: cleanCodexThreadTitle(parsed.thread_name || parsed.title || ""),
          updatedAt: Date.parse(parsed.updated_at || parsed.updatedAt || "") || 0,
        });
      } catch {}
    }
    return entries;
  }

  function loadGlobalStateThreadEntries(globalStatePath = codexGlobalStatePath) {
    if (!fs.existsSync(globalStatePath)) return [];
    try {
      const raw = fs.readFileSync(globalStatePath, "utf8").trim();
      if (!raw) return [];
      const state = JSON.parse(raw);
      const ids = new Set();
      for (const key of ["projectless-thread-ids", "pinned-thread-ids"]) {
        if (Array.isArray(state[key])) {
          for (const id of state[key]) {
            const value = String(id || "").trim();
            if (value) ids.add(value);
          }
        }
      }
      for (const key of ["thread-workspace-root-hints", "thread-projectless-output-directories"]) {
        if (state[key] && typeof state[key] === "object" && !Array.isArray(state[key])) {
          for (const id of Object.keys(state[key])) {
            if (id) ids.add(id);
          }
        }
      }
      return [...ids].map((id) => ({
        id,
        title: "",
        updatedAt: 0,
      }));
    } catch {
      return [];
    }
  }

  function bridgeSessionEntries(chatId, visibleThreadIds = null, { restrictToChat = false } = {}) {
    const entries = [];
    const chatIds = restrictToChat
      ? [chatId]
      : Object.keys(sessions.chats || {}).sort((a, b) => {
          if (a === chatId && b !== chatId) return -1;
          if (b === chatId && a !== chatId) return 1;
          return a.localeCompare(b);
        });

    if (!chatIds.includes(chatId)) chatIds.unshift(chatId);

    for (const sourceChatId of chatIds) {
      const chatState = sourceChatId === chatId ? getChatState(chatId, chatEventContexts.get(chatId)) : sessions.chats[sourceChatId];
      if (!chatState || !Array.isArray(chatState.sessions)) continue;

      const normalized = dedupeSessions(chatState.sessions.map(normalizeSessionIdentity)).slice(0, sessionListLimit());
      if (sourceChatId === chatId) chatState.sessions = normalized;

      for (const session of normalized) {
        const threadId = String(session.codexThreadId || "").trim();
        if (threadId && visibleThreadIds && !visibleThreadIds.has(threadId)) continue;
        if (!threadId && !(sourceChatId === chatId && shouldKeepEmptyCurrentSession(session, chatState))) continue;

        const isCurrent = sourceChatId === chatId && session.id === chatState.currentSessionId;
        entries.push({
          ...session,
          _codexOnly: false,
          _sourceChatId: sourceChatId,
          _rank: sourceChatId === chatId ? (isCurrent ? 0 : 1) : 2,
          _isCurrent: isCurrent,
        });
      }
    }

    return entries;
  }

  async function mergedSessionEntries(chatId, options = {}) {
    const allowExternalThreads = options.allowExternalThreads ?? isOwnerDm(chatId, options.event);
    const entryMap = new Map();

    for (const entry of bridgeSessionEntries(chatId, null, { restrictToChat: !allowExternalThreads })) {
      mergeThreadInventoryEntry(entryMap, {
        ...entry,
        _sources: ["Bridge绑定"],
        _location: "当前 Bot 运行目录 state/sessions.json",
      });
    }

    if (!allowExternalThreads) {
      const deletedThreadIds = loadDeletedThreadIds(CONFIG.codexHome);
      if (CONFIG.desktopCodexHome) {
        for (const id of loadDeletedThreadIds(CONFIG.desktopCodexHome)) deletedThreadIds.add(id);
      }
      const localSessions = sessions.chats[chatId]?.sessions || [];
      return sortThreadListEntries(collapseContinuationEntries([...entryMap.values()], localSessions))
        .filter((entry) => !deletedThreadIds.has(String(entry.codexThreadId || "").trim()))
        .slice(0, boundedListLimit());
    }

    const codexThreads = await loadVisibleCodexThreads();

    const registry = registeredCodexHomeRegistry();
    const sameHomeStateDirs = stateDirsForCodexHome(registry, CONFIG.codexHome);
    const registeredBindings = loadRegisteredBridgeBindings(sameHomeStateDirs);
    for (const binding of registeredBindings) {
      if (sameResolvedPath(binding.stateDir, CONFIG.stateDir)) continue;
      const session = normalizeSessionData(binding.session);
      mergeThreadInventoryEntry(entryMap, {
        ...session,
        codexThreadId: binding.threadId,
        _codexOnly: false,
        _sourceChatId: binding.chatId,
        _rank: 3,
        _isCurrent: false,
        _sources: ["Bridge 跨实例绑定"],
        _location: binding.sessionsPath,
      });
    }

    if (Array.isArray(codexThreads)) {
      const allThreadIds = codexThreads.map((row) => String(row?.id || "").trim()).filter(Boolean);
      for (const row of codexThreads) {
        const threadId = String(row?.id || "").trim();
        if (!threadId) continue;
        mergeThreadInventoryEntry(entryMap, {
          ...sessionEntryFromCodexThread(row, allThreadIds),
          _sources: ["Codex DB"],
          _dbRecord: row,
          _rolloutPath: row.rollout_path || "",
          _location: "当前 Codex Home",
        });
      }
    }

    for (const rolloutPath of listRolloutFiles(CONFIG.codexHome)) {
      const summary = readRolloutSummary(rolloutPath);
      if (!summary.threadId) continue;
      mergeThreadInventoryEntry(entryMap, {
        id: uniqueThreadDisplayId(summary.threadId, []),
        title: summary.title || "rollout-only 会话",
        createdAt: summary.createdAt || summary.updatedAt || Date.now(),
        updatedAt: summary.updatedAt || summary.createdAt || Date.now(),
        messages: [],
        codexThreadId: summary.threadId,
        _codexOnly: true,
        _sourceChatId: "",
        _rank: 4,
        _isCurrent: false,
        _sources: ["rollout-only"],
        _rolloutPath: rolloutPath,
        _location: "当前 Codex Home sessions",
      });
    }

    for (const item of loadSessionIndexEntries(codexSessionIndexPath)) {
      mergeThreadInventoryEntry(entryMap, {
        id: uniqueThreadDisplayId(item.id, []),
        title: item.title || "session_index 残留",
        createdAt: item.updatedAt || Date.now(),
        updatedAt: item.updatedAt || Date.now(),
        messages: [],
        codexThreadId: item.id,
        _codexOnly: true,
        _sourceChatId: "",
        _rank: 5,
        _isCurrent: false,
        _sources: ["session_index"],
        _location: "当前 Codex Home session_index.jsonl",
      });
    }

    for (const item of loadGlobalStateThreadEntries(codexGlobalStatePath)) {
      mergeThreadInventoryEntry(entryMap, {
        id: uniqueThreadDisplayId(item.id, []),
        title: "侧边栏状态残留",
        createdAt: item.updatedAt || Date.now(),
        updatedAt: item.updatedAt || Date.now(),
        messages: [],
        codexThreadId: item.id,
        _codexOnly: true,
        _sourceChatId: "",
        _rank: 6,
        _isCurrent: false,
        _sources: ["global-state"],
        _location: "当前 Codex Home .codex-global-state.json",
      });
    }

    if (shouldMirrorDesktopCodexHome) {
      const desktopThreads = fs.existsSync(desktopCodexStateDbPath)
        ? await sqliteJson(
            desktopCodexStateDbPath,
            [
              "select id, substr(title, 1, 240) as title,",
              "substr(first_user_message, 1, 240) as first_user_message,",
              "substr(preview, 1, 240) as preview,",
              "created_at, updated_at, created_at_ms, updated_at_ms, cwd,",
              "rollout_path",
              "from threads",
              "where coalesce(archived, 0) = 0",
              "order by coalesce(updated_at_ms, updated_at * 1000, created_at_ms, created_at * 1000, 0) desc",
              "limit ?;",
            ].join(" "),
            [boundedListLimit()],
          )
        : [];
      const workspace = path.resolve(stripWindowsLongPathPrefix(CONFIG.workspace || "")).toLowerCase();
      const allThreadIds = desktopThreads.map((row) => String(row?.id || "").trim()).filter(Boolean);
      for (const row of desktopThreads) {
        const threadId = String(row?.id || "").trim();
        if (!threadId) continue;
        const cwd = path.resolve(stripWindowsLongPathPrefix(row.cwd || "") || CONFIG.workspace).toLowerCase();
        if (cwd !== workspace && !entryMap.has(`thread:${threadId}`)) continue;
        mergeThreadInventoryEntry(entryMap, {
          ...sessionEntryFromCodexThread(row, allThreadIds),
          _sources: ["desktop DB mirror"],
          _dbRecord: row,
          _rolloutPath: row.rollout_path || "",
          _location: "desktopCodexHome 镜像",
        });
      }

      for (const rolloutPath of listRolloutFiles(CONFIG.desktopCodexHome)) {
        const summary = readRolloutSummary(rolloutPath);
        if (!summary.threadId) continue;
        if (!entryMap.has(`thread:${summary.threadId}`)) continue;
        mergeThreadInventoryEntry(entryMap, {
          id: uniqueThreadDisplayId(summary.threadId, []),
          title: summary.title || "desktop rollout 镜像",
          createdAt: summary.createdAt || summary.updatedAt || Date.now(),
          updatedAt: summary.updatedAt || summary.createdAt || Date.now(),
          messages: [],
          codexThreadId: summary.threadId,
          _codexOnly: true,
          _sourceChatId: "",
          _rank: 7,
          _isCurrent: false,
          _sources: ["desktop rollout mirror"],
          _rolloutPath: rolloutPath,
          _location: "desktopCodexHome sessions 镜像",
        });
      }

      for (const item of loadSessionIndexEntries(desktopCodexSessionIndexPath)) {
        if (!entryMap.has(`thread:${item.id}`)) continue;
        mergeThreadInventoryEntry(entryMap, {
          id: uniqueThreadDisplayId(item.id, []),
          title: item.title || "desktop session_index 镜像",
          createdAt: item.updatedAt || Date.now(),
          updatedAt: item.updatedAt || Date.now(),
          messages: [],
          codexThreadId: item.id,
          _codexOnly: true,
          _sourceChatId: "",
          _rank: 8,
          _isCurrent: false,
          _sources: ["desktop session_index mirror"],
          _location: "desktopCodexHome session_index.jsonl",
        });
      }

      for (const item of loadGlobalStateThreadEntries(desktopCodexGlobalStatePath)) {
        if (!entryMap.has(`thread:${item.id}`)) continue;
        mergeThreadInventoryEntry(entryMap, {
          id: uniqueThreadDisplayId(item.id, []),
          title: "desktop 侧边栏状态镜像",
          createdAt: item.updatedAt || Date.now(),
          updatedAt: item.updatedAt || Date.now(),
          messages: [],
          codexThreadId: item.id,
          _codexOnly: true,
          _sourceChatId: "",
          _rank: 8,
          _isCurrent: false,
          _sources: ["desktop global-state mirror"],
          _location: "desktopCodexHome .codex-global-state.json",
        });
      }
    }

    const deletedThreadIds = loadDeletedThreadIds(CONFIG.codexHome);
    if (CONFIG.desktopCodexHome) {
      for (const id of loadDeletedThreadIds(CONFIG.desktopCodexHome)) deletedThreadIds.add(id);
    }
    const logicalBindings = [...Object.values(sessions.chats).flatMap(chat => chat.sessions || []), ...registeredBindings.map(binding => binding.session)];
    return sortThreadListEntries(collapseContinuationEntries([...entryMap.values()], logicalBindings))
      .filter((entry) => !deletedThreadIds.has(String(entry.codexThreadId || "").trim()))
      .slice(0, boundedListLimit());
  }

  async function listChatSessionsSynced(chatId) {
    await syncChatSessionsWithCodex(chatId);
    const chatState = getChatState(chatId);
    chatState.sessions = dedupeSessions(chatState.sessions.map(normalizeSessionIdentity)).slice(0, sessionListLimit());
    saveSessions();
    return await mergedSessionEntries(chatId);
  }

  async function findSessionEntry(chatId, target) {
    const sessionsList = await listChatSessionsSynced(chatId);
    const raw = String(target || "").trim();
    const index = Number(raw);
    const matchIndex = Number.isInteger(index) && index >= 1 && index <= sessionsList.length
      ? index - 1
      : sessionsList.findIndex((item) => (
          item.id === raw
          || item.id.startsWith(raw)
          || item.codexThreadId === raw
          || item.codexThreadId?.startsWith(raw)
          || codexThreadLink(item.codexThreadId) === raw
        ));
    if (matchIndex < 0) return null;
    return {
      entry: sessionsList[matchIndex],
      index: matchIndex + 1,
      list: sessionsList,
    };
  }

  function uniqueSessionId(chatState, preferred = "") {
    const existing = new Set((chatState.sessions || []).map((session) => session.id));
    const normalized = String(preferred || "").replace(/[^a-f0-9]/gi, "").slice(0, 8).toLowerCase();
    if (normalized.length === 8 && !existing.has(normalized)) return normalized;
    for (;;) {
      const id = crypto.randomBytes(4).toString("hex");
      if (!existing.has(id)) return id;
    }
  }

  function materializeSessionForChat(chatId, entry) {
    const chatState = getChatState(chatId);
    let match = null;
    if (entry?._sourceChatId === chatId && entry.id) {
      match = chatState.sessions.find((session) => session.id === entry.id);
    }
    if (!match && entry?.codexThreadId) {
      match = chatState.sessions.find((session) => session.codexThreadId === entry.codexThreadId);
    }
    if (!match) {
      match = normalizeSessionData({
        id: uniqueSessionId(chatState, entry?.id || String(entry?.codexThreadId || "").slice(0, 8)),
        title: entry?.title || "未命名会话",
        createdAt: Number(entry?.createdAt) || Date.now(),
        updatedAt: Date.now(),
        messages: [],
        codexThreadId: entry?.codexThreadId || "",
        lastTokenUsage: entry?.lastTokenUsage || null,
        lastContextUsage: entry?.lastContextUsage || null,
        lastContextPeakUsage: entry?.lastContextPeakUsage || null,
        lastCompactedAt: entry?.lastCompactedAt || null,
        lastThreadStatus: entry?.lastThreadStatus || "",
        threadHealth: entry?.threadHealth || null,
      });
      chatState.sessions.unshift(match);
    }

    chatState.currentSessionId = match.id;
    match.updatedAt = Date.now();
    chatState.sessions = dedupeSessions(chatState.sessions).slice(0, sessionListLimit());
    saveSessions();
    return match;
  }

  function renameBridgeSessionsForThread(chatId, entry, title) {
    const nextTitle = normalizeRenameTitle(title);
    const threadId = String(entry?.codexThreadId || "").trim();
    let changed = false;
    let renamed = 0;

    for (const [sourceChatId, chatState] of Object.entries(sessions.chats || {})) {
      if (!chatState || !Array.isArray(chatState.sessions)) continue;
      for (const session of chatState.sessions) {
        const sameEntry = sourceChatId === chatId && entry?.id && session.id === entry.id;
        const sameThread = threadId && String(session.codexThreadId || "").trim() === threadId;
        if (!sameEntry && !sameThread) continue;
        if (session.title !== nextTitle) {
          session.title = nextTitle;
          changed = true;
        }
        renamed += 1;
      }
    }

    if (changed) saveSessions();
    return { changed, renamed };
  }

  async function renameCodexThreadInHome(threadId, title, paths) {
    const id = String(threadId || "").trim();
    const nextTitle = normalizeRenameTitle(title);
    const result = {
      dbChanged: false,
      sessionIndexChanged: false,
      dbRecordFound: false,
      sessionIndexFound: false,
    };
    if (!id || !nextTitle) return result;

    const dbPath = paths?.dbPath || "";
    const sessionIndexPath = paths?.sessionIndexPath || "";
    const codexHome = paths?.codexHome || "";
    const lockPath = paths?.lockPath || "";

    const apply = async () => {
      let record = null;
      if (dbPath && fs.existsSync(dbPath)) {
        record = await loadCodexThreadRecordFromDb(id, dbPath);
        result.dbRecordFound = Boolean(record);
        if (record) {
          result.dbChanged = await updateCodexThreadTitleInDb(id, nextTitle, dbPath);
          record = { ...record, title: nextTitle };
        }
      }

      if (sessionIndexPath && fs.existsSync(sessionIndexPath)) {
        result.sessionIndexFound = hasCodexSessionIndexEntry(id, sessionIndexPath);
        if (result.sessionIndexFound || record) {
          const indexEntry = record
            ? null
            : loadSessionIndexEntries(sessionIndexPath).find((item) => item.id === id);
          result.sessionIndexChanged = syncCodexSessionIndex(
            record || { id, title: nextTitle, updated_at_ms: indexEntry?.updatedAt || Date.now() },
            sessionIndexPath,
            { threadName: nextTitle },
          );
        }
      }
    };

    if (codexHome && lockPath) await withCodexSidebarLock(apply, codexHome, lockPath);
    else await apply();
    return result;
  }

  async function renameCodexThreadEverywhere(threadId, title) {
    const source = await renameCodexThreadInHome(threadId, title, {
      codexHome: CONFIG.codexHome,
      dbPath: codexStateDbPath,
      sessionIndexPath: codexSessionIndexPath,
      lockPath: codexSidebarLockPath,
    });
    const desktop = shouldMirrorDesktopCodexHome
      ? await renameCodexThreadInHome(threadId, title, {
          codexHome: CONFIG.desktopCodexHome,
          dbPath: desktopCodexStateDbPath,
          sessionIndexPath: desktopCodexSessionIndexPath,
          lockPath: desktopCodexSidebarLockPath,
        })
      : null;
    return { source, desktop };
  }

  async function switchSession(chatId, target) {
    const match = await findSessionEntry(chatId, target);
    if (!match) return null;
    return materializeSessionForChat(chatId, match.entry);
  }

  function createSessionData(title) {
    const now = Date.now();
    return {
      id: crypto.randomBytes(4).toString("hex"),
      title,
      createdAt: now,
      updatedAt: now,
      messages: [],
      codexThreadId: "",
      engine: CONFIG.engine,
      claudeSessionId: '',
      lastTokenUsage: null,
      lastContextUsage: null,
      lastContextPeakUsage: null,
      lastCompactedAt: null,
      lastThreadStatus: "",
      threadHealth: null,
      providerBundleOverride: "",
    };
  }

  function appendHistory(session, role, content) {
    session.messages.push({
      role,
      content: String(content || "").slice(0, 4000),
      at: Date.now(),
    });
    session.messages = session.messages.slice(-20);
    session.updatedAt = Date.now();
    saveSessions();
  }

  return {
    cleanOverride,
    effectiveSessionSettings,
    assertReasoningSupported,
    settingsSummary,
    applySessionThreadOverrides,
    applySessionTurnOverrides,
    setSessionOverride,
    clearProviderBundleOverride,
    applyProviderBundleOverride,
    recordFailureStats,
    resetCurrentSession,
    normalizeSessionData,
    normalizeRenameTitle,
    updateSessionTokenUsage,
    updateSessionThreadStatus,
    updateSessionGoal,
    updateSessionFailure,
    clearSessionFailure,
    markSessionCompacted,
    dedupeSessions,
    listChatSessions,
    boundedListLimit,
    sessionListLimit,
    codexThreadLink,
    cleanCodexThreadTitle,
    codexThreadTime,
    loadVisibleCodexThreads,
    loadVisibleCodexThreadIds,
    codexThreadResumeInfoFromRecord,
    loadCodexThreadResumeInfo,
    loadCodexThreadResumeInfoMap,
    missingRolloutFailureForThread,
    markSessionResumeFailure,
    sessionHasRunnableCodexBinding,
    shouldKeepEmptyCurrentSession,
    ensureRunnableCurrentSession,
    syncChatSessionsWithCodex,
    titleFromCodexThread,
    uniqueThreadDisplayId,
    sessionEntryFromCodexThread,
    normalizeThreadSource,
    threadSourcesText,
    threadSourceSet,
    threadHasSource,
    rolloutPathExists,
    threadSourceFlags,
    threadListGroup,
    threadListGroupRank,
    threadListGroupTitle,
    threadEntryIsRunnable,
    threadListStatusText,
    threadLocationText,
    threadDeleteStateText,
    addThreadSource,
    threadEntryUpdatedAt,
    normalizeThreadTime,
    latestSessionMessageTime,
    threadEntryConversationUpdatedAt,
    threadEntryLastSeenAt,
    threadListSortTime,
    sortThreadListEntries,
    threadListTimeLabel,
    threadListTimeLabelName,
    mergeThreadInventoryEntry,
    threadIdFromPath,
    readRolloutSummary,
    listRolloutFiles,
    loadSessionIndexEntries,
    loadGlobalStateThreadEntries,
    bridgeSessionEntries,
    mergedSessionEntries,
    listChatSessionsSynced,
    findSessionEntry,
    uniqueSessionId,
    materializeSessionForChat,
    renameBridgeSessionsForThread,
    renameCodexThreadInHome,
    renameCodexThreadEverywhere,
    switchSession,
    createSessionData,
    appendHistory,
  };
}
