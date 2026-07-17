#!/usr/bin/env node
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  durationConfigLabel,
  hasDuration,
  normalizeRunMode,
  parseDurationMs,
  parseEventKeys,
  parseToolEnv,
  resolveDefaultDataRoot,
  resolveDefaultTools,
  resolveLarkEventLockScope,
  withLarkProfile,
} from "./src/config/env.mjs";
import {
  normalizeUserContent,
  parseCommand as parseCommandInput,
} from "./src/commands/parser.mjs";
import { sameResolvedPath, stripWindowsLongPathPrefix } from "./src/config/paths.mjs";
import {
  chatIdOf,
  eventIdOf,
  eventTypeOf,
  isRecallEvent,
  messageIdOf,
} from "./src/feishu/events.mjs";
import { createLarkClient } from "./src/feishu/lark-cli.mjs";
import { createManagedCardClass } from "./src/feishu/cards/managed-card.mjs";
import {
  cardMarkdownContent,
  idempotencyKey,
  markdown,
  noteMd,
  splitText,
  truncateCardText,
} from "./src/feishu/cards/primitives.mjs";
import { createPendingAttachmentStore } from "./src/attachments/pending.mjs";
import { createLogger } from "./src/logging/logger.mjs";
import {
  FAST_SERVICE_TIER,
  STANDARD_SERVICE_TIER,
  createServiceTierPolicy,
} from "./src/config/service-tier.mjs";
import { AppServerClient } from "./src/codex/app-server-client.mjs";
import { createAppServerProtocol } from "./src/codex/app-server-protocol.mjs";
import {
  codexRuntimeVersionLines,
  readCodexRuntimeVersionStatus,
} from "./src/codex/runtime-version.mjs";
import { createCodexProviderConfig } from "./src/providers/codex-config.mjs";
import { createActiveRunStore } from "./src/runtime/active-runs.mjs";
import { createEventDispatcher } from "./src/runtime/event-dispatcher.mjs";
import { createProcessRunner, isProcessAlive as isProcessAlivePid } from "./src/runtime/process-runner.mjs";
import { createRecalledMessageStore } from "./src/runtime/recalled-messages.mjs";
import { createRunWatchdog as createBaseRunWatchdog } from "./src/runtime/run-watchdog.mjs";
import { createSingleInstanceLock } from "./src/runtime/single-instance-lock.mjs";
import {
  appServerToolStatus,
  createRunActivity,
  markCodexEvent,
  markModelEvent,
  markRunPhase,
  markToolCompleted,
  markToolProgress,
  markToolStarted,
  renderRunActivityMarkdown,
} from "./src/runtime/run-activity.mjs";
import { createSeenEventsStore } from "./src/runtime/seen-events.mjs";
import {
  contextUsageFromTokenUsage,
  maxContextUsage,
  normalizeContextUsage,
  normalizeGoal,
  normalizeTimestamp,
  normalizeTokenUsage,
} from "./src/sessions/normalize.mjs";
import { createSessionStore } from "./src/sessions/store.mjs";
import {
  findDeepKey,
  parseJsonLoose,
  readJsonFile,
  recordsMatchColumns,
  writeJsonFileAtomicSync,
} from "./src/utils/json.mjs";
import {
  classifyCodexFailure,
  emptyCompletionError,
  errorFromFailure,
  errorText,
  failureDetailText,
  failureShortText,
  isNoGoalExistsError,
  normalizeFailure,
  safeJson,
} from "./src/logging/errors.mjs";
import modelReasoning from "./src/config/model-reasoning.cjs";

const { acceptedEfforts, capabilityOutcomeLines, loadRegistry: loadReasoningRegistry, mapReasoningEffort, reviewStatus: reasoningReviewStatus } = modelReasoning;

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOOLS = resolveDefaultTools();
const DEFAULT_DATA_ROOT = resolveDefaultDataRoot();
const LARK_PROFILE = String(process.env.CODEX_FEISHU_LARK_PROFILE || process.env.LARK_CLI_PROFILE || "").trim();
const EVENT_KEYS = parseEventKeys(process.env.CODEX_FEISHU_EVENT_KEYS || process.env.CODEX_FEISHU_EVENT_KEY || "im.message.receive_v1");

const CONFIG = {
  workspace: process.env.CODEX_FEISHU_WORKSPACE || process.cwd(),
  eventKeys: EVENT_KEYS,
  eventKey: EVENT_KEYS[0] || "im.message.receive_v1",
  larkProfile: LARK_PROFILE,
  larkCli: withLarkProfile(parseToolEnv("LARK_CLI_BIN", DEFAULT_TOOLS.larkCli), LARK_PROFILE),
  codexCli: parseToolEnv("CODEX_CLI_BIN", DEFAULT_TOOLS.codexCli),
  runMode: normalizeRunMode(process.env.CODEX_FEISHU_RUN_MODE || "app-server"),
  codexSandbox: process.env.CODEX_FEISHU_SANDBOX || "danger-full-access",
  codexModel: process.env.CODEX_FEISHU_MODEL || "",
  codexReasoning: process.env.CODEX_FEISHU_REASONING || "",
  codexTimeoutMs: parseDurationMs(process.env.CODEX_FEISHU_CODEX_TIMEOUT_MS, 0),
  codexIdleTimeoutMs: parseDurationMs(process.env.CODEX_FEISHU_CODEX_IDLE_TIMEOUT_MS, 60 * 60_000),
  disableMcp: (process.env.CODEX_FEISHU_DISABLE_MCP || "0") !== "0",
  maxConcurrent: Number(process.env.CODEX_FEISHU_MAX_CONCURRENT || "1"),
  maxReplyChars: Number(process.env.CODEX_FEISHU_MAX_REPLY_CHARS || "6000"),
  listLimit: Number(process.env.CODEX_FEISHU_LIST_LIMIT || "100"),
  useCards: (process.env.CODEX_FEISHU_CARD_MODE || "1") !== "0",
  cardThrottleMs: Number(process.env.CODEX_FEISHU_CARD_THROTTLE_MS || "400"),
  debugCards: (process.env.CODEX_FEISHU_CARD_DEBUG || "0") === "1",
  showFinalSteps: (process.env.CODEX_FEISHU_SHOW_FINAL_STEPS || "1") === "1",
  maxRunningToolDetails: Number(process.env.CODEX_FEISHU_CARD_MAX_RUNNING_TOOL_DETAILS || "20"),
  larkDataFileThreshold: Number(process.env.CODEX_FEISHU_LARK_DATA_FILE_THRESHOLD || "8000"),
  replyToMessage: (process.env.CODEX_FEISHU_REPLY_TO_MESSAGE || "0") === "1",
  useThreadReply: (process.env.CODEX_FEISHU_REPLY_IN_THREAD || "0") === "1",
  logDir: process.env.CODEX_FEISHU_LOG_DIR || path.join(DEFAULT_DATA_ROOT, "logs"),
  logMaxBytes: Number(process.env.CODEX_FEISHU_LOG_MAX_BYTES || `${5 * 1024 * 1024}`),
  logMaxBackups: Number(process.env.CODEX_FEISHU_LOG_MAX_BACKUPS || "3"),
  stateDir: process.env.CODEX_FEISHU_STATE_DIR || path.join(DEFAULT_DATA_ROOT, "state"),
  attachmentRelDir: safeRelativePath(
    process.env.CODEX_FEISHU_ATTACHMENT_REL_DIR || ".codex-feishu-attachments",
    ".codex-feishu-attachments",
  ),
  attachmentPendingTtlMs: Number(process.env.CODEX_FEISHU_ATTACHMENT_PENDING_TTL_MS || `${30 * 60_000}`),
  maxPendingAttachments: Number(process.env.CODEX_FEISHU_MAX_PENDING_ATTACHMENTS || "12"),
  maxFileAttachmentBytes: Number(process.env.CODEX_FEISHU_MAX_FILE_ATTACHMENT_BYTES || `${50 * 1024 * 1024}`),
  recalledMessageTtlMs: parseDurationMs(process.env.CODEX_FEISHU_RECALLED_MESSAGE_TTL_MS, 24 * 60 * 60_000),
  deleteConfirmTtlMs: Number(process.env.CODEX_FEISHU_DELETE_CONFIRM_TTL_MS || `${5 * 60_000}`),
  streamRecoveryEnabled: (process.env.CODEX_FEISHU_STREAM_RECOVERY || "1") !== "0",
  streamRecoveryMaxAttempts: Number(process.env.CODEX_FEISHU_STREAM_RECOVERY_MAX_ATTEMPTS || "1"),
  syncSidebar: (process.env.CODEX_FEISHU_SYNC_SIDEBAR || "0") !== "0",
  sidebarReconcileIntervalMs: parseDurationMs(process.env.CODEX_FEISHU_SIDEBAR_RECONCILE_INTERVAL_MS, 60_000),
  syncSessionsFromCodex: (process.env.CODEX_FEISHU_SYNC_SESSIONS_FROM_CODEX || "1") !== "0",
  keepEmptySessionMs: Number(process.env.CODEX_FEISHU_KEEP_EMPTY_SESSION_MS || `${10 * 60_000}`),
  codexHome: path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex")),
  desktopCodexHome: String(process.env.CODEX_FEISHU_DESKTOP_CODEX_HOME || "").trim()
    ? path.resolve(String(process.env.CODEX_FEISHU_DESKTOP_CODEX_HOME).trim())
    : "",
};

const logPath = path.join(CONFIG.logDir, "codex-feishu-bridge.log");
const log = createLogger(logPath, {
  maxBytes: CONFIG.logMaxBytes,
  maxBackups: CONFIG.logMaxBackups,
});
const seenPath = path.join(CONFIG.stateDir, "seen-events.json");
const sessionsPath = path.join(CONFIG.stateDir, "sessions.json");
const activeRunsPath = path.join(CONFIG.stateDir, "active-runs.json");
const pidPath = path.join(CONFIG.stateDir, "bridge.pid");
const lockPath = path.join(CONFIG.stateDir, "bridge.lock.json");
const stopPath = path.join(CONFIG.stateDir, "bridge.stop");
const larkDataTempDir = path.join(CONFIG.stateDir, "tmp");
const eventLockScope = resolveLarkEventLockScope(CONFIG.larkProfile);
const eventLocksDir = path.join(DEFAULT_DATA_ROOT, "event-locks", eventLockScope);
const runtimeDir = path.join(CONFIG.workspace, ".codex-feishu-runtime");
const outputDir = path.join(runtimeDir, "codex-output");
const promptDir = path.join(runtimeDir, "codex-prompts");
const attachmentDir = path.join(CONFIG.workspace, CONFIG.attachmentRelDir);
const codexStateDbPath = path.join(CONFIG.codexHome, "state_5.sqlite");
const codexSessionIndexPath = path.join(CONFIG.codexHome, "session_index.jsonl");
const codexGlobalStatePath = path.join(CONFIG.codexHome, ".codex-global-state.json");
const codexSidebarLockPath = path.join(CONFIG.codexHome, ".codex-feishu-sidebar-sync.lock");
const desktopCodexStateDbPath = CONFIG.desktopCodexHome ? path.join(CONFIG.desktopCodexHome, "state_5.sqlite") : "";
const desktopCodexSessionIndexPath = CONFIG.desktopCodexHome ? path.join(CONFIG.desktopCodexHome, "session_index.jsonl") : "";
const desktopCodexGlobalStatePath = CONFIG.desktopCodexHome ? path.join(CONFIG.desktopCodexHome, ".codex-global-state.json") : "";
const desktopCodexSidebarLockPath = CONFIG.desktopCodexHome ? path.join(CONFIG.desktopCodexHome, ".codex-feishu-sidebar-sync.lock") : "";
const shouldMirrorDesktopCodexHome = Boolean(CONFIG.desktopCodexHome)
  && !sameResolvedPath(CONFIG.desktopCodexHome, CONFIG.codexHome);
fs.mkdirSync(CONFIG.logDir, { recursive: true });
fs.mkdirSync(CONFIG.stateDir, { recursive: true });
fs.mkdirSync(larkDataTempDir, { recursive: true });
fs.mkdirSync(eventLocksDir, { recursive: true });
fs.mkdirSync(outputDir, { recursive: true });
fs.mkdirSync(promptDir, { recursive: true });
fs.mkdirSync(attachmentDir, { recursive: true });
const seenEvents = createSeenEventsStore({
  seenPath,
  eventLocksDir,
  instanceName: process.env.CODEX_FEISHU_INSTANCE_NAME || "",
  log,
});
const { rememberEvent } = seenEvents;
const activeRunStore = createActiveRunStore({
  activeRunsPath,
  bridgePid: process.pid,
  workspace: CONFIG.workspace,
});
const {
  activeRuns,
  clearActiveRun,
  recordActiveRun,
  saveActiveRuns,
  touchActiveRun,
} = activeRunStore;
const pendingAttachmentStore = createPendingAttachmentStore({
  maxPendingAttachments: CONFIG.maxPendingAttachments,
  pendingTtlMs: CONFIG.attachmentPendingTtlMs,
});
const {
  add: addPendingAttachments,
  cleanup: cleanupPendingAttachments,
  dropForMessage: dropPendingAttachmentsForMessage,
  take: takePendingAttachments,
} = pendingAttachmentStore;
const recalledMessageStore = createRecalledMessageStore({
  ttlMs: CONFIG.recalledMessageTtlMs,
});
const {
  has: isMessageRecalled,
  remember: rememberRecalledMessage,
} = recalledMessageStore;
const singleInstanceLock = createSingleInstanceLock({
  lockPath,
  pidPath,
  owner: {
    pid: process.pid,
    instance: process.env.CODEX_FEISHU_INSTANCE_NAME || "",
    workspace: CONFIG.workspace,
    codexHome: CONFIG.codexHome,
    larkProfile: CONFIG.larkProfile || "default",
    startedAt: Date.now(),
  },
  processAlive: isProcessAlivePid,
  log,
});
const {
  acquire: acquireSingleInstanceLock,
  release: releaseSingleInstanceLock,
} = singleInstanceLock;
acquireSingleInstanceLock();
try {
  fs.rmSync(stopPath, { force: true });
} catch {}
fs.writeFileSync(pidPath, String(process.pid), "utf8");

const shutdownCallbacks = new Set();
const activeChildren = new Map();
const activeCodexJobs = new Map();
const activeGoalRuns = new Map();
const pendingDeleteConfirmations = new Map();
const stoppedJobs = new Set();
const processRunner = createProcessRunner({
  activeChildren,
  workspace: CONFIG.workspace,
});
const {
  isProcessAlive,
  runTool,
  terminateProcessTree,
} = processRunner;
const larkClient = createLarkClient({
  larkCli: CONFIG.larkCli,
  runTool,
  delay,
  splitText,
  idempotencyKey,
  maxReplyChars: CONFIG.maxReplyChars,
  useThreadReply: CONFIG.useThreadReply,
  dataFileThreshold: CONFIG.larkDataFileThreshold,
  dataTempDir: larkDataTempDir,
  log,
});
const {
  larkJson,
  larkJsonWithData,
  replyFallback,
  runLark,
  sendMarkdown,
  sendText,
} = larkClient;
const ManagedCard = createManagedCardClass({
  larkJson,
  larkJsonWithData,
  findDeepKey,
  idempotencyKey,
  useThreadReply: CONFIG.useThreadReply,
  cardThrottleMs: CONFIG.cardThrottleMs,
  log,
});
const MODEL_REASONING_REGISTRY = loadReasoningRegistry();
const REASONING_EFFORTS = new Set(MODEL_REASONING_REGISTRY.canonicalEfforts);
const MIN_SIDEBAR_RECONCILE_INTERVAL_MS = 5_000;
const PROVIDER_MODEL_LIST_TIMEOUT_MS = 30_000;
const PROVIDER_MODEL_TEST_TIMEOUT_MS = 60_000;
const CODEX_THREAD_ID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const PROVIDER_BUNDLES = [
  {
    id: "m2c-deepseek",
    name: "mimo2codex / DeepSeek V4 Pro",
    provider: "mimo2codex",
    model: "deepseek-v4-pro",
    reasoning: "medium",
  },
  {
    id: "m2c-deepseek-flash",
    name: "mimo2codex / DeepSeek V4 Flash",
    provider: "mimo2codex",
    model: "deepseek-v4-flash",
    reasoning: "medium",
  },
  {
    id: "m2c-apideepseek",
    name: "mimo2codex / API DeepSeek V4 Pro",
    provider: "mimo2codex-apideepseek",
    model: "deepseek-v4-pro",
    reasoning: "medium",
  },
  {
    id: "m2c-apideepseek-flash",
    name: "mimo2codex / API DeepSeek V4 Flash",
    provider: "mimo2codex-apideepseek",
    model: "deepseek-v4-flash",
    reasoning: "medium",
  },
  {
    id: "m2c-kimi",
    name: "mimo2codex / Kimi",
    provider: "mimo2codex",
    model: "kimi-k2.6",
    reasoning: "medium",
  },
  {
    id: "m2c-glm",
    name: "mimo2codex / GLM",
    provider: "mimo2codex",
    model: "glm-5.2",
    reasoning: "medium",
  },
];
const codexProviderConfig = createCodexProviderConfig({
  codexHome: CONFIG.codexHome,
  providerBundles: PROVIDER_BUNDLES,
});
const {
  findCodexProvider,
  findProviderBundle,
  listCodexProviders,
  providerBundleLabel,
  providerModelsUrl,
  providerResponsesUrl,
  resolveCodexConfigModel,
  resolveCodexConfigValue,
  writeTopLevelCodexConfigValue,
} = codexProviderConfig;
const codexReasoningLabel = CONFIG.codexReasoning || "config";
const codexModelLabel = CONFIG.codexModel || resolveCodexConfigModel() || "默认模型";
const {
  displayServiceTier,
  serviceTierFallbackFailure,
  serviceTierForExecSettings,
  serviceTierForProviderDetail,
  serviceTierForThreadSettings,
  serviceTierForTurnSettings,
  serviceTierPlanForExecSettings,
  serviceTierPlanForTurnSettings,
  shouldRetryWithoutServiceTier,
} = createServiceTierPolicy({ findProvider: findCodexProvider });
let shuttingDown = false;
let sidebarReconcileInFlight = false;
let sidebarReconcileQueuedReason = "";
const sessionStore = createSessionStore({
  sessionsPath,
  createSessionData,
  normalizeSessionData,
  dedupeSessions,
  sessionListLimit,
});
const {
  getChatState,
  getSession,
  resetSession,
  saveSessions,
  sessions,
} = sessionStore;
seenEvents.cleanupOldEventLocks();
const stats = {
  startedAt: Date.now(),
  events: 0,
  commands: 0,
  answered: 0,
  failed: 0,
  recovered: 0,
  failuresByKind: {},
};
const eventDispatcher = createEventDispatcher({
  maxConcurrent: CONFIG.maxConcurrent,
  chatIdOf,
  messageIdOf,
  eventIdOf,
  isRecallEvent,
  isMessageRecalled,
  parseCommand: (event) => parseCommand(event?.content),
  isOutOfBandCommand,
  handleRecallEvent,
  handleOutOfBandCommand,
  handleEvent,
  acknowledgeQueued: (event, ahead) => sendText(
    chatIdOf(event),
    `已加入等待队列：前面还有 ${ahead} 个任务。斜杠命令仍可立即执行；如需停止当前任务，请发送 /stop。`,
    "queued",
    messageIdOf(event),
  ),
  isShuttingDown: () => shuttingDown,
  log,
});
const appServerProtocol = createAppServerProtocol({
  config: CONFIG,
  applySessionThreadOverrides,
  applySessionTurnOverrides,
  userTextFromContent,
  attachmentPromptBlock,
});
const {
  resumeParams: appServerResumeParams,
  startParams: appServerStartParams,
  steerParams: appServerSteerParams,
  turnParams: appServerTurnParams,
} = appServerProtocol;

function cleanOverride(value) {
  const text = String(value || "").trim();
  return text || "";
}

function effectiveSessionSettings(session) {
  const model = cleanOverride(session?.modelOverride) || CONFIG.codexModel || resolveCodexConfigValue("model") || "";
  const provider = cleanOverride(session?.providerOverride) || resolveCodexConfigValue("model_provider") || "openai";
  const requestedReasoning = cleanOverride(session?.reasoningOverride) || CONFIG.codexReasoning || resolveCodexConfigValue("model_reasoning_effort") || MODEL_REASONING_REGISTRY.defaultRequestedEffort;
  const reasoningMapping = mapReasoningEffort({ provider, model, effort: requestedReasoning }, MODEL_REASONING_REGISTRY);
  const reasoning = reasoningMapping.supported ? reasoningMapping.effectiveEffort : "";
  const serviceTier = cleanOverride(session?.serviceTierOverride) || resolveCodexConfigValue("service_tier") || "";
  return { model, provider, requestedReasoning, reasoning, reasoningMapping, serviceTier };
}

function assertReasoningSupported(settings) {
  if (settings.reasoningMapping.supported) return settings;
  const capability = settings.reasoningMapping.capability;
  throw new Error(`${capability.name} 不支持推理强度 ${settings.requestedReasoning}；可接受请求值：${acceptedEfforts(capability, MODEL_REASONING_REGISTRY).join("、") || "无"}`);
}

function settingsSummary(session) {
  const settings = effectiveSessionSettings(session);
  return [
    `provider ${settings.provider || "默认"}`,
    `model ${settings.model || "默认"}`,
    `reasoning ${settings.requestedReasoning || "默认"}${settings.reasoningMapping.mapped ? ` → ${settings.reasoning}` : ""}`,
    `speed ${displayServiceTier(settings.serviceTier) || "默认"}`,
  ].join(" · ");
}

function applySessionThreadOverrides(params, session, options = {}) {
  const settings = effectiveSessionSettings(session);
  const serviceTier = serviceTierForThreadSettings(settings, options);
  if (settings.model) params.model = settings.model;
  if (settings.provider) params.modelProvider = settings.provider;
  if (serviceTier) params.serviceTier = serviceTier;
  return params;
}

function applySessionTurnOverrides(params, session, options = {}) {
  const settings = assertReasoningSupported(effectiveSessionSettings(session));
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
    lastTokenUsage: normalizeTokenUsage(session?.lastTokenUsage),
    lastContextUsage: normalizeContextUsage(session?.lastContextUsage),
    lastContextPeakUsage: normalizeContextUsage(session?.lastContextPeakUsage),
    lastCompactedAt: Number(session?.lastCompactedAt) || null,
    lastThreadStatus: typeof session?.lastThreadStatus === "string" ? session.lastThreadStatus : "",
    lastGoal: normalizeGoal(session?.lastGoal),
    lastFailure: normalizeFailure(session?.lastFailure),
    modelOverride: cleanOverride(session?.modelOverride),
    reasoningOverride: cleanOverride(session?.reasoningOverride),
    providerOverride: cleanOverride(session?.providerOverride),
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
      `limit ${safeLimit};`,
    ].join(" "),
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
  const normalized = dedupeSessions(chatState.sessions.map(normalizeSessionData)).slice(0, sessionListLimit());
  const resumeInfoByThread = await loadCodexThreadResumeInfoMap(
    normalized.map((session) => session.codexThreadId),
  );
  chatState.sessions = normalized.filter((session) => {
    const threadId = String(session.codexThreadId || "").trim();
    if (threadId) return true;
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

function bridgeSessionEntries(chatId, visibleThreadIds = null) {
  const entries = [];
  const chatIds = Object.keys(sessions.chats || {}).sort((a, b) => {
    if (a === chatId && b !== chatId) return -1;
    if (b === chatId && a !== chatId) return 1;
    return a.localeCompare(b);
  });

  if (!chatIds.includes(chatId)) chatIds.unshift(chatId);

  for (const sourceChatId of chatIds) {
    const chatState = sourceChatId === chatId ? getChatState(chatId) : sessions.chats[sourceChatId];
    if (!chatState || !Array.isArray(chatState.sessions)) continue;

    const normalized = dedupeSessions(chatState.sessions.map(normalizeSessionData)).slice(0, sessionListLimit());
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

async function mergedSessionEntries(chatId) {
  const codexThreads = await loadVisibleCodexThreads();
  const entryMap = new Map();

  for (const entry of bridgeSessionEntries(chatId)) {
    mergeThreadInventoryEntry(entryMap, {
      ...entry,
      _sources: ["Bridge绑定"],
      _location: "当前 Bot 运行目录 state/sessions.json",
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
            `limit ${boundedListLimit()};`,
          ].join(" "),
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

  return sortThreadListEntries([...entryMap.values()])
    .slice(0, boundedListLimit());
}

async function listChatSessionsSynced(chatId) {
  await syncChatSessionsWithCodex(chatId);
  const chatState = getChatState(chatId);
  chatState.sessions = dedupeSessions(chatState.sessions.map(normalizeSessionData)).slice(0, sessionListLimit());
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
    lastTokenUsage: null,
    lastContextUsage: null,
    lastContextPeakUsage: null,
    lastCompactedAt: null,
    lastThreadStatus: "",
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

function createRunState(session, event, userContent) {
  const settings = effectiveSessionSettings(session);
  const startedAt = Date.now();
  return {
    blocks: [],
    footer: "thinking",
    terminal: "running",
    startedAt,
    activity: createRunActivity(startedAt),
    session,
    event,
    userContent,
    threadId: "",
    goalMode: false,
    goal: null,
    goalSteerCount: 0,
    errorMsg: "",
    failure: null,
    meta: {
      durationMs: undefined,
      inputTokens: undefined,
      outputTokens: undefined,
      model: settings.model || codexModelLabel,
      contextUsage: session.lastContextUsage || null,
      contextPeakUsage: session.lastContextPeakUsage || null,
      compactedAt: session.lastCompactedAt || null,
    },
  };
}

function appendRunText(state, text) {
  const content = String(text || "");
  if (!content) return false;
  const last = state.blocks[state.blocks.length - 1];
  if (last?.kind === "text" && last.streaming) {
    last.content += content;
  } else {
    state.blocks.push({ kind: "text", content, streaming: true });
  }
  state.footer = "streaming";
  return true;
}

function closeStreamingBlocks(state) {
  for (const block of state.blocks) {
    if (block.kind === "text") block.streaming = false;
  }
}

function ensureToolBlock(state, item) {
  if (!item?.id) return null;
  let block = state.blocks.find((entry) => entry.kind === "tool" && entry.tool.id === item.id);
  if (!block) {
    closeStreamingBlocks(state);
    block = {
      kind: "tool",
      tool: {
        id: item.id,
        source: toolSourceFromAppServerItem(item),
        name: toolNameFromAppServerItem(item),
        input: toolInputFromAppServerItem(item),
        output: "",
        status: "running",
      },
    };
    state.blocks.push(block);
  }
  return block;
}

function updateToolFromAppServerItem(state, item, { completed = false } = {}) {
  const block = ensureToolBlock(state, item);
  if (!block) return false;
  block.tool.source = toolSourceFromAppServerItem(item);
  block.tool.name = toolNameFromAppServerItem(item);
  block.tool.input = toolInputFromAppServerItem(item);
  block.tool.status = appServerToolStatus(item, { completed });
  const output = toolOutputFromAppServerItem(item);
  if (output) block.tool.output = output;
  state.footer = block.tool.status === "running" ? "tool_running" : "thinking";
  return true;
}

function appendToolOutputDelta(state, itemId, delta) {
  if (!itemId || !delta) return false;
  const block = state.blocks.find((entry) => entry.kind === "tool" && entry.tool.id === itemId);
  if (!block) return false;
  block.tool.output = `${block.tool.output || ""}${delta}`;
  state.footer = "tool_running";
  markToolProgress(state, block.tool);
  return true;
}

function reduceCodexJsonEvent(state, raw) {
  if (!raw || typeof raw !== "object") return false;
  const type = raw.type;
  markCodexEvent(state);

  if (type === "thread.started") {
    state.threadId = raw.thread_id || state.threadId;
    markRunPhase(state, "initializing", { connection: "connected" });
    return true;
  }

  if (type === "turn.started") {
    state.footer = "thinking";
    markModelEvent(state, "model_thinking");
    return true;
  }

  if (type === "item.started") {
    const item = raw.item || {};
    const name = item.name || item.type || "tool";
    if (item.type && item.type !== "agent_message") {
      closeStreamingBlocks(state);
      const block = {
        kind: "tool",
        tool: {
          id: item.id || crypto.randomUUID(),
          source: toolSourceFromItem(item),
          name,
          input: toolInputFromItem(item),
          status: "running",
        },
      };
      state.blocks.push(block);
      state.footer = "tool_running";
      markToolStarted(state, block.tool);
      return true;
    }
  }

  if (type === "item.completed") {
    const item = raw.item || {};
    if (item.type === "agent_message" && typeof item.text === "string") {
      markModelEvent(state, "model_streaming");
      return appendRunText(state, item.text);
    }
    if (item.id) {
      for (const block of state.blocks) {
        if (block.kind === "tool" && block.tool.id === item.id) {
          block.tool.status = toolStatusFromItem(item);
          block.tool.output = toolOutputFromItem(item);
          state.footer = "thinking";
          markToolCompleted(state, block.tool);
          return true;
        }
      }
    }
    if (item.type && item.type !== "agent_message") {
      closeStreamingBlocks(state);
      const block = {
        kind: "tool",
        tool: {
          id: item.id || crypto.randomUUID(),
          source: toolSourceFromItem(item),
          name: item.name || item.type || "tool",
          input: toolInputFromItem(item),
          output: toolOutputFromItem(item),
          status: toolStatusFromItem(item),
        },
      };
      state.blocks.push(block);
      state.footer = "thinking";
      markToolCompleted(state, block.tool);
      return true;
    }
  }

  if (type === "turn.completed") {
    closeStreamingBlocks(state);
    // Keep the card open until --output-last-message has been read. Codex can
    // emit turn.completed before the bridge has loaded the final answer file.
    state.footer = "streaming";
    state.meta.durationMs = Date.now() - state.startedAt;
    markModelEvent(state, "finalizing");
    if (raw.usage) {
      state.meta.inputTokens = raw.usage.input_tokens;
      state.meta.outputTokens = raw.usage.output_tokens;
    }
    return true;
  }

  if (type === "turn.failed" || type === "error") {
    closeStreamingBlocks(state);
    state.terminal = "error";
    state.footer = null;
    state.errorMsg = raw.message || raw.error || "Codex 运行失败";
    state.meta.durationMs = Date.now() - state.startedAt;
    markRunPhase(state, "error", { connection: "connected" });
    return true;
  }

  return false;
}

function reduceAppServerEvent(state, raw) {
  if (!raw || typeof raw !== "object") return false;
  const method = raw.method;
  const params = raw.params || {};
  markCodexEvent(state);

  if (method === "thread/started") {
    state.threadId = params.thread?.id || state.threadId;
    markRunPhase(state, "initializing", { connection: "connected" });
    return true;
  }

  if (method === "thread/status/changed") {
    if (params.threadId) state.threadId = params.threadId;
    const statusType = params.status?.type;
    updateSessionThreadStatus(state.session, statusType || "");
    if (statusType === "active") state.footer = state.footer || "thinking";
    markRunPhase(state, state.activity?.phase || "initializing", {
      connection: statusType === "active" ? "connected" : undefined,
      progress: false,
    });
    return true;
  }

  if (method === "thread/goal/updated") {
    if (params.threadId) state.threadId = params.threadId;
    updateSessionGoal(state.session, params.goal || null);
    return true;
  }

  if (method === "thread/goal/cleared") {
    if (params.threadId) state.threadId = params.threadId;
    updateSessionGoal(state.session, null);
    return true;
  }

  if (method === "turn/started") {
    if (params.threadId) state.threadId = params.threadId;
    state.footer = "thinking";
    markModelEvent(state, "model_thinking");
    return true;
  }

  if (method === "item/started") {
    const item = params.item || {};
    if (item.type === "agentMessage") {
      state.footer = "streaming";
      markModelEvent(state, "model_streaming");
      return true;
    }
    if (item.type === "contextCompaction") {
      state.footer = "compacting";
      markModelEvent(state, "compacting");
      return true;
    }
    if (item.type === "userMessage" || item.type === "hookPrompt" || item.type === "reasoning") {
      state.footer = "thinking";
      markModelEvent(state, "model_thinking");
      return true;
    }
    const changed = updateToolFromAppServerItem(state, item);
    const block = state.blocks.find((entry) => entry.kind === "tool" && entry.tool.id === item.id);
    if (block) markToolStarted(state, block.tool);
    return changed;
  }

  if (method === "item/completed") {
    const item = params.item || {};
    if (item.type === "agentMessage" && typeof item.text === "string") {
      closeStreamingBlocks(state);
      const tools = state.blocks.filter((block) => block.kind === "tool");
      state.blocks = item.text.trim()
        ? [{ kind: "text", content: item.text, streaming: false }, ...tools]
        : tools;
      state.footer = "streaming";
      markModelEvent(state, "model_streaming");
      return true;
    }
    if (item.type === "contextCompaction") {
      markSessionCompacted(state.session);
      state.meta.compactedAt = state.session.lastCompactedAt;
      state.meta.contextUsage = null;
      state.footer = "thinking";
      markModelEvent(state, "model_thinking");
      return true;
    }
    if (item.type === "userMessage" || item.type === "hookPrompt" || item.type === "reasoning") {
      state.footer = "thinking";
      markModelEvent(state, "model_thinking");
      return true;
    }
    const changed = updateToolFromAppServerItem(state, item, { completed: true });
    const block = state.blocks.find((entry) => entry.kind === "tool" && entry.tool.id === item.id);
    if (block) markToolCompleted(state, block.tool);
    return changed;
  }

  if (method === "item/agentMessage/delta") {
    markModelEvent(state, "model_streaming");
    return appendRunText(state, params.delta || "");
  }

  if (
    method === "item/commandExecution/outputDelta"
    || method === "command/exec/outputDelta"
    || method === "process/outputDelta"
    || method === "item/fileChange/outputDelta"
  ) {
    return appendToolOutputDelta(state, params.itemId || params.processId, params.delta || "");
  }

  if (method === "item/plan/delta") {
    return appendToolOutputDelta(state, params.itemId, params.delta || "");
  }

  if (method === "item/mcpToolCall/progress") {
    return appendToolOutputDelta(state, params.itemId, params.message ? `${params.message}\n` : "");
  }

  if (method === "thread/tokenUsage/updated") {
    const last = params.tokenUsage?.last || params.tokenUsage?.total || {};
    const total = params.tokenUsage?.total || {};
    state.meta.inputTokens = last.inputTokens;
    state.meta.outputTokens = last.outputTokens;
    state.meta.reasoningOutputTokens = last.reasoningOutputTokens;
    state.meta.totalTokens = total.totalTokens;
    updateSessionTokenUsage(state.session, params.tokenUsage);
    state.meta.contextUsage = state.session.lastContextUsage || null;
    state.meta.contextPeakUsage = state.session.lastContextPeakUsage || null;
    return true;
  }

  if (method === "thread/compacted") {
    markSessionCompacted(state.session);
    state.meta.compactedAt = state.session.lastCompactedAt;
    state.meta.contextUsage = null;
    state.meta.contextPeakUsage = null;
    state.footer = "thinking";
    markModelEvent(state, "model_thinking");
    return true;
  }

  if (method === "turn/completed") {
    closeStreamingBlocks(state);
    state.footer = "streaming";
    state.meta.durationMs = params.turn?.durationMs ?? Date.now() - state.startedAt;
    markModelEvent(state, "finalizing");
    return true;
  }

  if (method === "error") {
    const failure = classifyCodexFailure(params, "Codex app-server 运行失败");
    state.failure = failure;
    state.errorMsg = failureDetailText(failure);
    if (failure.recoverable && params.willRetry === true) {
      closeStreamingBlocks(state);
      state.footer = "reconnecting";
      state.meta.durationMs = Date.now() - state.startedAt;
      markRunPhase(state, "reconnecting", {
        connection: "recovering",
        retryAttempt: Number(state.activity?.retryAttempt || 0) + 1,
      });
      return true;
    }
    closeStreamingBlocks(state);
    state.terminal = "error";
    state.footer = null;
    updateSessionFailure(state.session, failure);
    state.meta.durationMs = Date.now() - state.startedAt;
    markRunPhase(state, "error", { connection: "connected" });
    return true;
  }

  return false;
}

function markRunError(state, error) {
  const failure = classifyCodexFailure(error);
  const disconnected = /app-server\s+(?:exited|ended before)|broken pipe|write after end/i.test(errorText(error));
  closeStreamingBlocks(state);
  state.terminal = "error";
  state.footer = null;
  state.failure = failure;
  state.errorMsg = failureDetailText(failure).slice(0, 1500);
  state.meta.durationMs = Date.now() - state.startedAt;
  updateSessionFailure(state.session, failure);
  markRunPhase(state, "error", {
    connection: disconnected ? "disconnected" : (state.activity?.connection || "connected"),
  });
  return state;
}

function markRunRecovering(state, failure, attempt) {
  closeStreamingBlocks(state);
  state.terminal = "running";
  state.footer = "recovering";
  state.failure = normalizeFailure(failure);
  state.errorMsg = failureDetailText(failure).slice(0, 1500);
  state.meta.durationMs = Date.now() - state.startedAt;
  state.meta.recoveryAttempt = attempt;
  markRunPhase(state, failure?.kind === "stream_disconnect" ? "recovering" : "reconnecting", {
    connection: "recovering",
    retryAttempt: attempt,
  });
  return state;
}

function markRunInterrupted(state) {
  closeStreamingBlocks(state);
  state.terminal = "interrupted";
  state.footer = null;
  state.meta.durationMs = Date.now() - state.startedAt;
  updateSessionFailure(state.session, {
    kind: "user_stop",
    label: "用户停止",
    recoverable: false,
    message: "任务已被用户停止。",
    suggestion: "",
    detail: "",
    at: Date.now(),
  });
  markRunPhase(state, "interrupted", { connection: "disconnected" });
  return state;
}

function ensureRunDone(state, finalText = "") {
  if (state.terminal === "error" || state.terminal === "interrupted") return state;
  const answer = String(finalText || "").trim();
  if (answer) {
    const tools = state.blocks.filter((block) => block.kind === "tool");
    state.blocks = [{ kind: "text", content: answer, streaming: false }, ...tools];
  } else if (state.blocks.length === 0) {
    appendRunText(state, "(Codex 没有返回内容)");
  }
  closeStreamingBlocks(state);
  state.terminal = "done";
  state.footer = null;
  state.meta.durationMs = Date.now() - state.startedAt;
  clearSessionFailure(state.session);
  markRunPhase(state, "done", { connection: "connected" });
  return state;
}

function shouldRecoverCodexRun(failure, attempt) {
  const item = normalizeFailure(failure) || classifyCodexFailure(failure);
  if (!CONFIG.streamRecoveryEnabled) return false;
  if (!item.recoverable || item.kind !== "stream_disconnect") return false;
  const maxAttempts = Math.max(0, Number(CONFIG.streamRecoveryMaxAttempts) || 0);
  return Number(attempt || 0) < maxAttempts;
}

function recoveryEventFromFailure(event, state, failure, attempt) {
  const original = String(state.userContent || userTextFromContent(event.content) || "").trim();
  const partial = resultTextFromState(state);
  const partialBlock = partial
    ? [
      "",
      "上一轮已经输出过以下内容摘要/片段，请不要重复：",
      "",
      partial.slice(-3000),
    ].join("\n")
    : "";
  const prompt = [
    `上一轮 Codex 因「${failure.label}」在完成前中断。现在进行第 ${attempt} 次断点续跑。`,
    "",
    "请先根据当前 thread、工作区和已经完成的操作判断进度，然后从断点继续。",
    "不要重复已经完成的文件修改、网页操作或已输出内容；如果无法安全继续，请直接说明原因并停止。",
    partialBlock,
    "",
    "原始用户请求：",
    "",
    original || "(原始请求为空或只有附件)",
  ].filter(Boolean).join("\n");
  return {
    ...event,
    content: JSON.stringify({ text: prompt }),
    attachments: [],
  };
}

function renderRunCard(state) {
  const elements = [];
  const elapsed = formatDuration(Date.now() - state.startedAt);
  const goal = state.goalMode ? normalizeGoal(state.goal || state.session.lastGoal) : null;

  if (CONFIG.debugCards) {
    elements.push(noteMd(`会话：${state.session.title} (${state.session.id})`));
    elements.push(noteMd(`工作区：${CONFIG.workspace}`));
    if (state.threadId) elements.push(noteMd(`Codex 线程：${state.threadId}`));
  }

  if (goal) {
    elements.push(markdown(goalRunHeaderMarkdown(state, goal, elapsed)));
  }

  if (state.blocks.length === 0 && state.terminal === "running") {
    elements.push(markdown(state.goalMode
      ? "**正在推进目标**\n\nCodex goal 已进入运行态，后续普通消息会作为当前目标的补充指令处理。"
      : "**正在处理**\n\n我已经收到消息，正在整理回复。"));
  }

  const liveStatusElements = state.terminal === "running"
    ? [markdown(renderRunActivityMarkdown(state, Date.now(), displayToolName))]
    : [];
  elements.push(...renderRunBlocks(state.blocks, state.terminal !== "running", liveStatusElements));

  if (state.terminal === "running") {
    elements.push(noteMd(renderFooterText(state.footer, elapsed)));
  } else if (state.terminal === "interrupted") {
    elements.push(noteMd(`已停止 · ${elapsed}`));
  } else if (state.terminal === "error") {
    const failure = state.failure || classifyCodexFailure(state.errorMsg);
    elements.push(noteMd(`${failure.label} · ${elapsed}`));
    elements.push(markdown(`**${failure.message}**${failure.suggestion ? `\n\n${failure.suggestion}` : ""}`));
    if (state.errorMsg) elements.push(markdown(`\`\`\`\n${truncateCardText(state.errorMsg, 1500)}\n\`\`\``));
  } else {
    elements.push(noteMd(renderDoneMeta(state)));
  }

  return {
    schema: "2.0",
    config: {
      streaming_mode: state.terminal === "running",
      summary: { content: cardSummary(state) },
    },
    header: {
      title: { tag: "plain_text", content: cardTitle(state) },
      template: state.terminal === "error" ? "red" : state.terminal === "running" ? "blue" : "default",
    },
    body: { elements },
  };
}

function goalRunHeaderMarkdown(state, goal, elapsed) {
  const parts = [`状态：${goalStatusLabel(goal.status)}`, `运行：${elapsed}`];
  if (goal.tokensUsed) parts.push(`已用 ${formatNumber(goal.tokensUsed)} tokens`);
  if (goal.tokenBudget) parts.push(`预算 ${formatNumber(goal.tokenBudget)} tokens`);
  if (state.goalSteerCount) parts.push(`补充指令 ${formatNumber(state.goalSteerCount)} 条`);
  return [
    `**Codex goal：${goalStatusLabel(goal.status)}**`,
    "",
    truncateCardText(goal.objective, 800),
    "",
    parts.join(" · "),
    "操作：/goal pause · /goal resume · /goal clear · /stop",
  ].join("\n");
}

function staleCardUpdateSequence(record) {
  const recorded = Math.floor(Number(record?.sequence || 0));
  const epochSeconds = Math.floor(Date.now() / 1000);
  return Math.max(1, recorded + 1, epochSeconds);
}

function renderStaleRunCard(record) {
  const startedAt = Number(record?.startedAt || 0);
  const updatedAt = Number(record?.updatedAt || 0);
  return {
    schema: "2.0",
    config: {
      streaming_mode: false,
      summary: { content: "Bridge 已重启，上一轮状态已失效" },
    },
    header: {
      title: { tag: "plain_text", content: "Bridge 已重启" },
      template: "red",
    },
    body: {
      elements: [
        markdown("**上一轮 Codex 任务状态已丢失**\n\nBridge 启动时发现这张卡片仍处于运行状态，但原进程已经不在当前 Bridge 内。为避免误判为仍在执行，已将它标记为中断。"),
        noteMd(`原始消息：${record?.messageId || ""}`),
        noteMd(`会话：${record?.sessionId || ""}`),
        startedAt ? noteMd(`开始时间：${formatTime(startedAt)}`) : null,
        updatedAt ? noteMd(`最后记录：${formatTime(updatedAt)}`) : null,
      ].filter(Boolean),
    },
  };
}

async function updateCardById(cardId, card, { sequence } = {}) {
  if (!cardId) return false;
  const nextSequence = Math.max(1, Math.floor(Number(sequence || 0)));
  await larkJsonWithData([
    "api",
    "PUT",
    `/open-apis/cardkit/v1/cards/${cardId}`,
    "--as",
    "bot",
  ], { card: { type: "card_json", data: JSON.stringify(card) }, sequence: nextSequence }, { timeoutMs: 60_000, attempts: 2 });
  return true;
}

async function repairStaleActiveRunsOnStartup() {
  const entries = Object.values(activeRuns.runs || {});
  if (!entries.length) return;
  log("INFO", "repairing stale active runs", { count: entries.length });
  let repaired = 0;
  const remaining = {};
  for (const record of entries) {
    try {
      if (record?.cardId) {
        await updateCardById(record.cardId, renderStaleRunCard(record), {
          sequence: staleCardUpdateSequence(record),
        });
      }
      repaired += 1;
    } catch (error) {
      const key = String(record?.messageId || "").trim();
      if (key) {
        remaining[key] = {
          ...record,
          repairAttempts: Number(record?.repairAttempts || 0) + 1,
          lastRepairAt: Date.now(),
          lastRepairError: String(error.message || error).slice(0, 1000),
        };
      }
      log("WARN", "stale active run card update failed", {
        messageId: record?.messageId || "",
        cardId: record?.cardId || "",
        error: String(error.message || error).slice(0, 1000),
      });
    }
  }
  activeRuns.runs = remaining;
  saveActiveRuns();
  log("INFO", "stale active runs repaired", { repaired, remaining: Object.keys(remaining).length });
}

function renderRunBlocks(blocks, finalized, beforeFirstTool = []) {
  if (finalized && !CONFIG.debugCards) {
    const elements = [];
    const tools = [];
    for (const block of blocks) {
      if (block.kind === "tool") {
        tools.push(block.tool);
      } else if (block.content.trim()) {
        elements.push(markdown(truncateCardText(block.content, 18_000)));
      }
    }
    if ((CONFIG.debugCards || CONFIG.showFinalSteps) && tools.length > 0) {
      elements.push(...renderToolGroup(tools, true));
    }
    return elements;
  }

  const elements = [];
  let toolBuffer = [];
  let statusInserted = false;
  const flushTools = () => {
    if (toolBuffer.length > 0) {
      if (!statusInserted) {
        elements.push(...beforeFirstTool);
        statusInserted = true;
      }
      elements.push(...renderToolGroup(toolBuffer, finalized));
      toolBuffer = [];
    }
  };

  for (const block of blocks) {
    if (block.kind === "tool") {
      toolBuffer.push(block.tool);
      continue;
    }
    flushTools();
    if (block.content.trim()) {
      elements.push(markdown(truncateCardText(block.content, 18_000)));
    }
  }
  flushTools();
  if (!statusInserted) elements.push(...beforeFirstTool);
  return elements;
}

function renderToolGroup(tools, finalized) {
  const visibleTools = CONFIG.debugCards ? tools : tools.filter(shouldShowToolInCard);
  if (visibleTools.length === 0) return [];
  if (CONFIG.debugCards) {
    return visibleTools.map((tool) => toolCardPanel(tool, tool.status === "running" || tool.status === "error"));
  }
  if (finalized) {
    const detailTools = visibleTools.filter((tool) => tool.status === "error");
    return [
      toolSummaryPanel(visibleTools, true),
      ...detailTools.map((tool) => toolCardPanel(tool, true)),
    ];
  }
  const prior = visibleTools.slice(0, -1);
  const latest = visibleTools[visibleTools.length - 1];
  const elements = [];
  if (prior.length > 0) elements.push(toolSummaryPanel(prior, false, {
    total: visibleTools.length,
    followedByLatest: Boolean(latest),
  }));
  if (latest) elements.push(toolCardPanel(latest, true));
  return elements;
}

function toolSummaryPanel(tools, finalized, options = {}) {
  const counts = toolStatusCounts(tools);
  const total = Number.isFinite(Number(options.total)) ? Number(options.total) : tools.length;
  const visibleRunningTools = finalized ? tools : limitRunningToolDetails(tools);
  const body = finalized
    ? toolSummaryFinalBody(tools, counts)
    : toolSummaryRunningBody(visibleRunningTools, {
        omitted: Math.max(0, tools.length - visibleRunningTools.length),
        followedByLatest: Boolean(options.followedByLatest),
      });
  return {
    tag: "collapsible_panel",
    expanded: !finalized,
    header: panelHeader(`**${toolSummaryTitle(total, counts, finalized)}**`),
    border: { color: counts.error ? "red" : "blue", corner_radius: "5px" },
    vertical_spacing: "8px",
    padding: "8px 8px 8px 8px",
    elements: [{ tag: "markdown", content: cardMarkdownContent(body || "_暂无步骤_"), text_size: "notation" }],
  };
}

function limitRunningToolDetails(tools) {
  const limit = Math.max(1, Math.floor(Number(CONFIG.maxRunningToolDetails || 20)));
  if (tools.length <= limit) return tools;
  return tools.slice(-limit);
}

function toolSummaryRunningBody(tools, { omitted = 0, followedByLatest = false } = {}) {
  const lines = [];
  if (omitted > 0) {
    lines.push(`只显示最近 ${tools.length} 个历史步骤；更早 ${omitted} 个已折叠，完整过程仍在本机日志中。`);
    lines.push("");
  }
  if (followedByLatest) {
    lines.push("当前步骤在下方展开。");
    lines.push("");
  }
  lines.push(...tools.map((tool) => `- ${toolHeaderText(tool, false)}`));
  return lines.join("\n");
}

function toolStatusCounts(tools) {
  return tools.reduce((counts, tool) => {
    if (tool.status === "error") counts.error += 1;
    else if (tool.status === "running") counts.running += 1;
    else counts.done += 1;
    return counts;
  }, { done: 0, error: 0, running: 0 });
}

function toolSummaryTitle(total, counts, finalized) {
  if (!finalized) return `${total} 个步骤已记录`;
  const parts = [`${total} 个步骤已完成`];
  if (counts.error) parts.push(`${counts.error} 个需查看`);
  return parts.join(" · ");
}

function toolSummaryFinalBody(tools, counts) {
  const lines = [`完成 ${counts.done} 个，失败 ${counts.error} 个，运行中 ${counts.running} 个。`];
  const visibleTools = limitRunningToolDetails(tools);
  const omitted = Math.max(0, tools.length - visibleTools.length);
  if (counts.error) {
    lines.push("");
    lines.push("失败步骤已在下方展开；多数探索命令未命中不一定影响最终结论。");
  } else {
    lines.push("");
    lines.push("成功步骤已折叠，保留最终结果和必要元信息。");
  }
  const names = [...new Set(tools.map((tool) => displayToolName(tool)).filter(Boolean))].slice(0, 6);
  if (names.length) lines.push(`工具：${names.join(" · ")}`);
  if (omitted > 0) {
    lines.push(`只显示最近 ${visibleTools.length} 个调用明细；更早 ${omitted} 个已折叠，完整过程仍在本机日志中。`);
  }
  const auditLines = visibleTools.map((tool, index) => `${omitted + index + 1}. ${toolHeaderText(tool, false)}`);
  if (auditLines.length) {
    lines.push("");
    lines.push("调用明细：");
    lines.push(truncateCardText(auditLines.join("\n"), 6000));
  }
  return lines.join("\n");
}

function toolCardPanel(tool, expanded = false) {
  const input = typeof tool.input === "string" ? tool.input : safeJson(tool.input);
  const body = toolBodyMarkdown(tool, input);
  return {
    tag: "collapsible_panel",
    expanded,
    header: panelHeader(toolHeaderText(tool, true)),
    border: { color: tool.status === "error" ? "red" : "grey", corner_radius: "5px" },
    vertical_spacing: "8px",
    padding: "8px 8px 8px 8px",
    elements: [{ tag: "markdown", content: cardMarkdownContent(body), text_size: "notation" }],
  };
}

function panelHeader(content) {
  return {
    title: { tag: "markdown", content: cardMarkdownContent(content) },
    vertical_align: "center",
    icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
    icon_position: "follow_text",
    icon_expanded_angle: -180,
  };
}

function toolHeaderText(tool, includeSummary) {
  const status = tool.status === "done" ? "完成" : tool.status === "error" ? "失败" : "运行中";
  const summary = includeSummary ? summarizeToolInput(tool) : "";
  return summary
    ? `**${displayToolName(tool)}** · ${status} · ${summary}`
    : `**${displayToolName(tool)}** · ${status}`;
}

function toolBodyMarkdown(tool, input) {
  if (!CONFIG.debugCards) {
    const summary = summarizeToolInput(tool);
    const visibleOutput = visibleToolOutput(tool);
    const output = visibleOutput ? `\n\n**输出**\n\`\`\`\n${truncateCardText(visibleOutput, 1200)}\n\`\`\`` : "";
    const emptyNote = tool.output ? "\n\n_输出已隐藏，以保持卡片简洁_" : "\n\n_无输出_";
    if (tool.status === "running") {
      return summary ? `正在执行：\`${summary}\`` : "_正在执行_";
    }
    if (tool.status === "error") {
      return tool.output
        ? `**错误**\n\`\`\`\n${truncateCardText(tool.output, 1200)}\n\`\`\``
        : "_执行失败，详情已写入本机日志_";
    }
    if (summary) return `已执行：\`${summary}\`${output || emptyNote}`;
    return output ? `已完成${output}` : `已完成${emptyNote}`;
  }

  const output = tool.output ? `\n\n**输出**\n\`\`\`\n${truncateCardText(tool.output, 1200)}\n\`\`\`` : "";
  return input ? `**输入**\n\`\`\`\n${truncateCardText(input, 1200)}\n\`\`\`${output}` : (output || "_运行中_");
}

function shouldShowToolInCard(tool) {
  return !isBridgeInternalTool(tool);
}

function visibleToolOutput(tool) {
  if (!tool?.output) return "";
  if (isBridgeInternalTool(tool) || looksLikeBridgePrompt(tool.output)) return "";
  const command = commandTextFromInput(tool?.input);
  const output = String(tool.output);
  if (!shouldShowSuccessfulToolOutput(command, output)) return "";
  if (isVerboseCommand(command) || isVerboseOutput(output)) return "";
  return output;
}

function isBridgeInternalTool(tool) {
  const inputText = [
    commandTextFromInput(tool?.input),
    typeof tool?.input === "string" ? tool.input : safeJson(tool?.input),
  ].join("\n").toLowerCase().replace(/\\/g, "/");
  return inputText.includes(".codex-feishu-runtime/codex-prompts")
    || inputText.includes(".codex-feishu-runtime/codex-output")
    || inputText.includes("/codex-prompts/")
    || inputText.includes("/codex-output/");
}

function looksLikeBridgePrompt(output) {
  const text = String(output || "");
  return text.includes("你是通过飞书消息被唤起的本机 Codex")
    || text.includes("飞书事件信息:")
    || text.includes("当前会话:")
    || text.includes("最近上下文:")
    || text.includes("Local image attachments:");
}

function isVerboseCommand(command) {
  const text = String(command || "").toLowerCase();
  return /\bget-content\b/.test(text)
    || /\bselect-string\b/.test(text)
    || /\brg\b/.test(text)
    || /\btype\b/.test(text)
    || /\bcat\b/.test(text)
    || text.includes("codex-feishu-bridge.mjs")
    || text.includes("start-codex-feishu-bridge.ps1")
    || text.includes("stop-codex-feishu-bridge.ps1")
    || text.includes("watch-codex-feishu-bridge.ps1")
    || text.includes("readme-codex-feishu-bridge.md");
}

function isVerboseOutput(output) {
  const text = String(output || "");
  if (text.length > 900) return true;
  const lines = text.split(/\r?\n/).length;
  if (lines > 18) return true;
  return looksLikeBridgePrompt(text);
}

function shouldShowSuccessfulToolOutput(command, output) {
  const cmd = String(command || "").toLowerCase();
  const text = String(output || "").trim();
  if (!text) return false;
  if (cmd.includes("lark-cli event status")) return true;
  if (cmd.includes("node --check")) return true;
  if (cmd.includes("git status") || cmd.includes("git diff --stat")) return true;
  if (cmd.includes("get-process") || cmd.includes("test-path") || cmd.includes("resolve-path")) return true;
  return text.length <= 360 && text.split(/\r?\n/).length <= 8;
}

function displayToolName(toolOrName) {
  const raw = typeof toolOrName === "object"
    ? String(toolOrName?.name || "tool")
    : String(toolOrName || "tool");
  const source = typeof toolOrName === "object" ? String(toolOrName?.source || "") : "";
  const lower = raw.toLowerCase();
  if (lower === "app_server_fallback") return "Bridge · app_server_fallback";
  if (lower === "command_execution" || lower === "exec_command" || lower === "bash") {
    return `${classifyCommandToolName(commandTextFromInput(toolOrName?.input))} · ${raw}`;
  }
  if (source === "mcp") return `MCP · ${raw}`;
  if (source === "dynamic") return `${dynamicToolDisplayCategory(raw)} · ${raw}`;
  if (source === "collab_agent") return `Agent · ${raw}`;
  if (lower === "read" || lower === "file_read") return `File · ${raw}`;
  if (lower === "write" || lower === "file_write") return `File · ${raw}`;
  if (lower === "edit" || lower === "apply_patch") return `File · ${raw}`;
  if (lower === "plan") return `Plan · ${raw}`;
  if (lower === "web_search") return `Web · ${raw}`;
  if (lower === "image_view") return `Image · ${raw}`;
  if (lower === "image_generation") return `Image · ${raw}`;
  if (lower.includes("mcp") || lower.startsWith("mcp__")) return `MCP · ${raw}`;
  if (lower.startsWith("skill:") || lower.startsWith("skill.")) return `Skill · ${raw}`;
  if (lower.startsWith("plugin:") || lower.startsWith("plugin.")) return `Plugin · ${raw}`;
  if (looksLikeNamespacedTool(raw)) return `${dynamicToolDisplayCategory(raw)} · ${raw}`;
  if (lower.includes("search") || lower === "grep" || lower === "rg") return `Search · ${raw}`;
  return `Tool · ${raw}`;
}

function dynamicToolDisplayCategory(name) {
  const raw = String(name || "tool");
  const lower = raw.toLowerCase();
  const namespace = lower.split(".")[0];
  if (lower.startsWith("mcp__") || namespace.startsWith("mcp__")) return "MCP";
  if (namespace === "web") return "Web";
  if (namespace === "image_gen" || namespace === "imagegen" || namespace === "image") return "Image";
  if (namespace === "functions") return "Developer Tool";
  if (namespace === "multi_tool_use") return "Tool";
  if (namespace === "tool_search") return "Tool Search";
  if (lower.includes("browser")) return "Browser";
  if (lower.includes("desktop")) return "Desktop";
  if (lower.includes("android")) return "Android";
  if (lower.includes("tavily") || lower.includes("context7") || lower.includes("discord")) return "MCP";
  return "Tool";
}

function looksLikeNamespacedTool(name) {
  return /^[A-Za-z0-9_-]+(?:__[A-Za-z0-9_-]+)?\.[A-Za-z0-9_-]+$/.test(String(name || ""));
}

function summarizeToolInput(tool) {
  const input = tool.input;
  if (!input) return "";
  const command = commandTextFromInput(input);
  if (command) return summarizeCommand(command);
  if (typeof input === "string") return summarizeCommand(input);
  if (typeof input !== "object") return "";

  const record = input;
  for (const key of ["cmd", "command", "query", "pattern", "path", "file_path", "url"]) {
    if (typeof record[key] === "string" && record[key].trim()) {
      return key === "cmd" || key === "command"
        ? summarizeCommand(record[key])
        : truncateOneLine(record[key], 80);
    }
  }
  return "";
}

function toolInputFromItem(item) {
  if (item.input !== undefined) return item.input;
  if (item.arguments !== undefined) return item.arguments;
  if (item.command !== undefined) return item.command;
  return "";
}

function toolStatusFromItem(item) {
  const code = Number(item.exit_code);
  if (Number.isFinite(code) && code !== 0) return "error";
  const status = String(item.status || "").toLowerCase();
  if (["error", "failed", "failure"].includes(status)) return "error";
  return "done";
}

function toolOutputFromItem(item) {
  for (const key of ["aggregated_output", "output", "result", "text"]) {
    if (item[key] !== undefined && item[key] !== null && String(item[key]).trim()) {
      return typeof item[key] === "string" ? item[key] : safeJson(item[key]);
    }
  }
  return "";
}

function toolSourceFromItem(item) {
  const type = String(item?.type || "").toLowerCase();
  const name = String(item?.name || "").toLowerCase();
  if (type.includes("mcp") || name.includes("mcp")) return "mcp";
  if (type.includes("command") || type === "bash" || name === "bash") return "command";
  if (type.includes("file") || ["read", "write", "edit", "apply_patch"].includes(name)) return "file";
  if (type.includes("web") || name.startsWith("web_")) return "web";
  if (type.includes("image") || name.startsWith("image_")) return "image";
  if (type.includes("plan") || name === "plan") return "plan";
  if (type.includes("agent")) return "collab_agent";
  return "";
}

function toolSourceFromAppServerItem(item) {
  switch (item?.type) {
    case "commandExecution":
      return "command";
    case "fileChange":
      return "file";
    case "mcpToolCall":
      return "mcp";
    case "dynamicToolCall":
      return "dynamic";
    case "collabAgentToolCall":
      return "collab_agent";
    case "webSearch":
      return "web";
    case "imageView":
    case "imageGeneration":
      return "image";
    case "plan":
      return "plan";
    default:
      return toolSourceFromItem(item || {});
  }
}

function toolNameFromAppServerItem(item) {
  switch (item?.type) {
    case "commandExecution":
      return "command_execution";
    case "fileChange":
      return "apply_patch";
    case "mcpToolCall":
      return [item.server, item.tool].filter(Boolean).join(".") || "mcp_tool_call";
    case "dynamicToolCall":
      return [item.namespace, item.tool].filter(Boolean).join(".") || "dynamic_tool_call";
    case "collabAgentToolCall":
      return item.tool || "collab_agent";
    case "webSearch":
      return "web_search";
    case "imageView":
      return "image_view";
    case "imageGeneration":
      return "image_generation";
    case "plan":
      return "plan";
    default:
      return item?.type || "tool";
  }
}

function toolInputFromAppServerItem(item) {
  switch (item?.type) {
    case "commandExecution":
      return item.command || "";
    case "fileChange":
      return { changes: item.changes || [] };
    case "mcpToolCall":
      return item.arguments ?? "";
    case "dynamicToolCall":
      return item.arguments ?? "";
    case "collabAgentToolCall":
      return item.prompt || item.tool || "";
    case "webSearch":
      return item.query || "";
    case "imageView":
      return item.path || "";
    case "imageGeneration":
      return item.revisedPrompt || item.result || "";
    case "plan":
      return item.text || "";
    default:
      return toolInputFromItem(item || {});
  }
}

function toolOutputFromAppServerItem(item) {
  if (!item || typeof item !== "object") return "";
  if (item.type === "commandExecution") return item.aggregatedOutput || "";
  if (item.type === "mcpToolCall") {
    if (item.error?.message) return item.error.message;
    if (item.result) return mcpResultToText(item.result);
  }
  if (item.type === "dynamicToolCall" && Array.isArray(item.contentItems)) {
    return item.contentItems.map(dynamicToolContentToText).filter(Boolean).join("\n");
  }
  if (item.type === "fileChange") return summarizeFileChanges(item.changes || []);
  if (item.type === "imageGeneration") return item.savedPath || item.result || "";
  return toolOutputFromItem(item);
}

function mcpResultToText(result) {
  if (!result) return "";
  if (Array.isArray(result.content)) {
    const text = result.content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item?.type === "text" && typeof item.text === "string") return item.text;
        return safeJson(item);
      })
      .filter(Boolean)
      .join("\n");
    if (text.trim()) return text;
  }
  if (result.structuredContent) return safeJson(result.structuredContent);
  return "";
}

function dynamicToolContentToText(item) {
  if (!item) return "";
  if (typeof item === "string") return item;
  if (item.type === "inputText") return item.text || "";
  if (item.type === "inputImage") return item.imageUrl || "";
  return safeJson(item);
}

function summarizeFileChanges(changes) {
  if (!Array.isArray(changes) || !changes.length) return "";
  return changes
    .slice(0, 12)
    .map((change) => {
      const pathText = change.path || change.filePath || change.absolutePath || safeJson(change).slice(0, 120);
      const action = change.type || change.kind || "change";
      return `${action}: ${pathText}`;
    })
    .join("\n");
}

function commandTextFromInput(input) {
  if (!input) return "";
  if (Array.isArray(input)) return input.map((part) => String(part)).join(" ");
  if (typeof input === "string") return input;
  if (typeof input !== "object") return "";
  for (const key of ["cmd", "command", "script"]) {
    const value = input[key];
    if (Array.isArray(value)) return value.map((part) => String(part)).join(" ");
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function classifyCommandToolName(command) {
  const text = normalizeCommandForDisplay(command);
  const lower = text.toLowerCase();
  if (/^lark-cli\b/.test(lower)) return "飞书 CLI";
  if (/^node\s+--check\b/.test(lower)) return "Node 检查";
  if (/^node\b/.test(lower)) return "Node.js";
  if (/^git\b/.test(lower)) return "Git";
  if (/^(?:rg\s+--files|fd\b|dir\b|ls\b|get-childitem\b)/i.test(text)) return "Glob";
  if (/^(?:rg|grep|findstr|select-string)\b/i.test(text)) return "搜索";
  if (/^get-content\b/i.test(text)) {
    return lower.includes(".log") || lower.includes("-tail") ? "读取日志" : "读取文件";
  }
  if (/^(?:test-path|resolve-path)\b/i.test(text)) return "路径检查";
  if (/^get-process\b/i.test(text)) return "进程检查";
  if (/\b(?:powershell|pwsh)(?:\.exe)?\b|Set-Content|Remove-Item|New-Item|Start-Process|\$env:/i.test(text)) {
    return "PowerShell";
  }
  return "Shell";
}

function summarizeCommand(command) {
  const text = normalizeCommandForDisplay(command);
  return truncateOneLine(text || "PowerShell 命令", 90);
}

function normalizeCommandForDisplay(command) {
  let text = String(command || "").replace(/\s+/g, " ").trim();
  text = text.replace(/^["']?(?:[A-Z]:)?[\\/]+Windows[\\/]+System32[\\/]+WindowsPowerShell[\\/]+v1\.0[\\/]+powershell(?:\.exe)?["']?\s*/i, "");
  text = text.replace(/^["']?(?:powershell|pwsh)(?:\.exe)?["']?\s*/i, "");
  text = text.replace(/^-NoProfile\s+/i, "");
  text = text.replace(/^-ExecutionPolicy\s+\S+\s+/i, "");
  text = text.replace(/^-Command\s+/i, "");
  text = text.trim();
  const quoted = text.match(/^(['"])([\s\S]*)\1$/);
  return quoted ? quoted[2].trim() : text;
}

function truncateOneLine(text, max) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function renderFooterText(footer, elapsed) {
  if (footer === "compacting") return `正在压缩上下文 · ${elapsed}`;
  if (footer === "recovering") return `正在从断流处继续 · ${elapsed}`;
  if (footer === "reconnecting") return `Codex 连接中断，正在重连 · ${elapsed}`;
  if (footer === "waiting") return `Codex 仍在处理，暂无新输出 · ${elapsed}`;
  if (footer === "tool_running") return `正在调用工具 · ${elapsed}`;
  if (footer === "streaming") return `正在输出 · ${elapsed}`;
  return `正在思考 · ${elapsed}`;
}

function renderDoneMeta(state) {
  const parts = [];
  const context = renderContextUsage(state.meta.contextUsage, "当前窗口");
  if (context) parts.push(context);
  const peak = renderContextUsage(state.meta.contextPeakUsage, "曾达");
  if (peak && isContextUsageHigher(state.meta.contextPeakUsage, state.meta.contextUsage)) parts.push(peak);
  parts.push(state.meta.compactedAt ? `上次压缩 ${formatTime(state.meta.compactedAt)}` : "未压缩");
  return parts.length ? parts.join(" · ") : "已完成";
}

function renderContextUsage(usage, label = "context") {
  const context = normalizeContextUsage(usage);
  if (!context) return "";
  const parts = [];
  if (context.percent !== null && context.percent !== undefined) parts.push(`${context.percent}%`);
  if (context.usedTokens !== null && context.contextWindow) {
    parts.push(`${formatNumber(context.usedTokens)}/${formatNumber(context.contextWindow)} tokens`);
  } else if (context.usedTokens !== null) {
    parts.push(`${formatNumber(context.usedTokens)} tokens`);
  }
  return parts.length ? `${label} ${parts.join(" / ")}` : "";
}

function contextUsageScore(usage) {
  const context = normalizeContextUsage(usage);
  if (!context) return null;
  const percent = Number(context.percent);
  if (Number.isFinite(percent)) return percent;
  const usedTokens = Number(context.usedTokens);
  return Number.isFinite(usedTokens) ? usedTokens : null;
}

function isContextUsageHigher(candidate, baseline) {
  const candidateScore = contextUsageScore(candidate);
  if (candidateScore === null) return false;
  const baselineScore = contextUsageScore(baseline);
  return baselineScore === null || candidateScore > baselineScore;
}

function nativeGoalCardTitle(state) {
  const goal = normalizeGoal(state.goal || state.session.lastGoal);
  if (state.terminal === "error") return "Codex goal 失败";
  if (goal?.status === "complete") return "Codex goal 已完成";
  if (goal?.status === "paused") return "Codex goal 已暂停";
  if (goal?.status === "blocked") return "Codex goal 受阻";
  if (goal?.status === "usageLimited") return "Codex goal 使用量受限";
  if (goal?.status === "budgetLimited") return "Codex goal 预算受限";
  if (goal?.status === "active") return "Codex goal 进行中";
  if (state.terminal === "interrupted") return "Codex goal 已停止";
  if (state.terminal === "done") return "Codex goal 已结束";
  return "Codex goal 进行中";
}

function cardTitle(state) {
  if (state.goalMode) return nativeGoalCardTitle(state);
  if (state.goalMode) {
    const goal = normalizeGoal(state.goal || state.session.lastGoal);
    if (state.terminal === "error") return "Codex goal 失败";
    if (state.terminal === "interrupted") return "Codex goal 已停止";
    if (goal?.status === "complete") return "Codex goal 已完成";
    if (goal?.status === "paused") return "Codex goal 已暂停";
    if (goal?.status === "blocked") return "Codex goal 受阻";
    if (goal?.status === "usageLimited") return "Codex goal 使用量受限";
    if (goal?.status === "budgetLimited") return "Codex goal 预算受限";
    if (state.terminal === "done") return "Codex goal 已结束";
    return "Codex goal 进行中";
  }
  if (state.terminal === "error") return state.failure?.label || "Codex 处理失败";
  if (state.terminal === "interrupted") return "Codex 已停止";
  if (state.terminal === "done") return "Codex 已完成";
  if (state.footer === "recovering") return "Codex 正在续跑";
  if (state.footer === "reconnecting") return "Codex 正在重连";
  if (state.footer === "tool_running") return "Codex 正在执行";
  if (state.footer === "streaming") return "Codex 正在回复";
  return "Codex 正在思考";
}

function cardSummary(state) {
  if (state.goalMode) {
    const goal = normalizeGoal(state.goal || state.session.lastGoal);
    if (state.terminal === "error") return "goal 失败";
    if (state.terminal === "interrupted") return "goal 已停止";
    if (goal?.status) return `goal ${goalStatusLabel(goal.status)}`;
    return state.terminal === "done" ? "goal 已结束" : "goal 进行中";
  }
  if (state.terminal === "interrupted") return "已停止";
  if (state.terminal === "error") return state.failure?.label || "处理失败";
  if (state.terminal === "done") return "已完成";
  if (state.footer === "recovering") return "正在续跑";
  if (state.footer === "reconnecting") return "正在重连";
  if (state.footer === "tool_running") return "正在调用工具";
  if (state.footer === "streaming") return "正在输出";
  return "正在处理";
}

function safeRelativePath(value, fallback) {
  const raw = String(value || "").trim().replace(/\\/g, "/");
  if (!raw || path.isAbsolute(raw) || raw.split("/").includes("..")) return fallback;
  return raw.replace(/^\/+/, "") || fallback;
}

function larkTextIndicatesRecalled(text) {
  return /recalled|message\s+is\s+recalled|230011|撤回|已撤回/i.test(String(text || ""));
}

function messageRecordLooksRecalled(message) {
  if (!message || typeof message !== "object") return false;
  const status = String(
    message.status
      || message.msg_status
      || message.message_status
      || message.state
      || "",
  ).toLowerCase();
  if (["recalled", "recall", "deleted", "removed"].includes(status)) return true;
  return Boolean(message.recalled || message.is_recalled || message.is_recalled_message || message.deleted || message.is_deleted);
}

async function enrichEvent(event) {
  const messageId = messageIdOf(event);
  if (!messageId) return event;

  const result = await runLark([
    "im",
    "+messages-mget",
    "--as",
    "bot",
    "--message-ids",
    messageId,
  ], { timeoutMs: 45_000, attempts: 2 });

  if (result.code !== 0) {
    const detail = `${result.stderr || ""}\n${result.stdout || ""}`;
    if (larkTextIndicatesRecalled(detail)) {
      return {
        ...event,
        recalled: true,
        recallReason: detail.slice(0, 500),
      };
    }
    log("WARN", "message mget failed; using event payload", {
      messageId,
      error: (result.stderr || result.stdout).slice(0, 1000),
    });
    return event;
  }

  try {
    const parsed = JSON.parse(result.stdout);
    const msg = parsed?.data?.messages?.[0];
    if (!msg) return event;
    if (messageRecordLooksRecalled(msg)) {
      return {
        ...event,
        chat_id: msg.chat_id || event.chat_id,
        recalled: true,
        recallReason: "message record is recalled",
      };
    }
    return {
      ...event,
      chat_id: msg.chat_id || event.chat_id,
      content: msg.content ?? event.content,
      message_type: msg.msg_type || event.message_type,
      sender_id: msg.sender?.id || event.sender_id,
    };
  } catch (error) {
    log("WARN", "message mget parse failed", { messageId, error: String(error) });
    return event;
  }
}

function parseMessageContentJson(content) {
  const raw = String(content || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function imageKeysFromContent(content) {
  const keys = new Set();
  const parsed = parseMessageContentJson(content);
  if (parsed?.image_key) keys.add(String(parsed.image_key));
  if (parsed?.content && typeof parsed.content === "string") {
    for (const key of imageKeysFromContent(parsed.content)) keys.add(key);
  }
  for (const match of String(content || "").matchAll(/\b(img_[A-Za-z0-9_:-]+)\b/g)) {
    keys.add(match[1]);
  }
  return [...keys];
}

function decodeXmlAttribute(value) {
  return String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function xmlAttribute(tag, name) {
  const match = String(tag || "").match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return match ? decodeXmlAttribute(match[1] ?? match[2] ?? "") : "";
}

function addFileEntry(entries, seen, fileKey, fileName = "") {
  const key = String(fileKey || "").trim();
  if (!key || seen.has(key)) return;
  seen.add(key);
  entries.push({
    fileKey: key,
    fileName: String(fileName || "").trim() || key,
  });
}

function fileEntriesFromContent(content) {
  const entries = [];
  const seen = new Set();
  const visit = (value) => {
    if (value == null) return;
    if (typeof value === "string") {
      const parsed = parseMessageContentJson(value);
      if (parsed && parsed !== value) visit(parsed);
      for (const match of value.matchAll(/<file\b[^>]*\/?>/gi)) {
        const tag = match[0];
        addFileEntry(entries, seen, xmlAttribute(tag, "key"), xmlAttribute(tag, "name"));
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object") return;
    const fileKey = value.file_key || value.fileKey;
    const fileName = value.file_name || value.fileName || value.name;
    addFileEntry(entries, seen, fileKey, fileName);
    if (value.content) visit(value.content);
    if (value.file) visit(value.file);
    if (value.files) visit(value.files);
  };
  visit(content);
  return entries;
}

function userTextFromContent(content) {
  const parsed = parseMessageContentJson(content);
  if (typeof parsed?.text === "string") return normalizeUserContent(parsed.text);
  if (parsed?.image_key && Object.keys(parsed).every((key) => key === "image_key")) return "";
  if (fileEntriesFromContent(content).length && parsed && !parsed.text && !parsed.content) {
    return "";
  }

  let text = normalizeUserContent(content);
  text = text.replace(/^\s*\[Image:\s+img_[^\]]+\]\s*/gmi, "");
  text = text.replace(/^\s*\[File:\s+file_[^\]]+\]\s*/gmi, "");
  text = text.replace(/<file\b[^>]*\/?>/gi, "");
  if (parsed?.image_key && !text.includes(parsed.image_key)) return text.trim();
  if (parsed?.image_key && text === JSON.stringify(parsed)) return "";
  return text.trim();
}

function relAttachmentPath(messageId, fileKey, index, fileName = "") {
  const date = new Date().toISOString().slice(0, 10);
  const namePart = safeFilePart(fileName || fileKey) || safeFilePart(fileKey);
  return path.posix.join(
    CONFIG.attachmentRelDir.replace(/\\/g, "/"),
    date,
    safeFilePart(messageId),
    `${String(index + 1).padStart(2, "0")}-${namePart}`,
  );
}

async function downloadImageAttachments(event) {
  const messageId = event.message_id || event.id;
  const keys = imageKeysFromContent(event.content);
  if (!messageId || !keys.length) return [];

  const attachments = [];
  for (let index = 0; index < keys.length; index += 1) {
    const fileKey = keys[index];
    const relOutput = relAttachmentPath(messageId, fileKey, index);
    const result = await runLark([
      "im",
      "+messages-resources-download",
      "--as",
      "bot",
      "--message-id",
      messageId,
      "--file-key",
      fileKey,
      "--type",
      "image",
      "--output",
      relOutput,
    ], { timeoutMs: 120_000, attempts: 2 });

    if (result.code !== 0) {
      log("WARN", "image download failed", {
        messageId,
        fileKey,
        error: (result.stderr || result.stdout).slice(0, 1200),
      });
      continue;
    }

    const payload = parseJsonLoose(result.stdout);
    const savedPath = payload?.data?.saved_path || path.join(CONFIG.workspace, relOutput);
    attachments.push({
      type: "image",
      fileKey,
      messageId,
      path: savedPath,
      sizeBytes: payload?.data?.size_bytes,
      receivedAt: Date.now(),
    });
  }

  if (attachments.length) {
    log("INFO", "image attachments downloaded", {
      messageId,
      count: attachments.length,
      paths: attachments.map((item) => item.path),
    });
  }
  return attachments;
}

async function downloadFileAttachments(event) {
  const messageId = event.message_id || event.id;
  const entries = fileEntriesFromContent(event.content);
  if (!messageId || !entries.length) return [];

  const attachments = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const relOutput = relAttachmentPath(messageId, entry.fileKey, index, entry.fileName);
    const result = await runLark([
      "im",
      "+messages-resources-download",
      "--as",
      "bot",
      "--message-id",
      messageId,
      "--file-key",
      entry.fileKey,
      "--type",
      "file",
      "--output",
      relOutput,
    ], { timeoutMs: 180_000, attempts: 2 });

    if (result.code !== 0) {
      log("WARN", "file download failed", {
        messageId,
        fileKey: entry.fileKey,
        fileName: entry.fileName,
        error: (result.stderr || result.stdout).slice(0, 1200),
      });
      continue;
    }

    const payload = parseJsonLoose(result.stdout);
    const savedPath = payload?.data?.saved_path || path.join(CONFIG.workspace, relOutput);
    let sizeBytes = Number(payload?.data?.size_bytes || 0);
    if (!sizeBytes) {
      try {
        sizeBytes = fs.statSync(savedPath).size;
      } catch {
        sizeBytes = 0;
      }
    }
    if (sizeBytes > CONFIG.maxFileAttachmentBytes) {
      try {
        fs.rmSync(savedPath, { force: true });
      } catch {}
      log("WARN", "file attachment skipped because it is too large", {
        messageId,
        fileKey: entry.fileKey,
        fileName: entry.fileName,
        sizeBytes,
        maxBytes: CONFIG.maxFileAttachmentBytes,
      });
      continue;
    }

    attachments.push({
      type: "file",
      fileKey: entry.fileKey,
      fileName: entry.fileName,
      messageId,
      path: savedPath,
      sizeBytes,
      receivedAt: Date.now(),
    });
  }

  if (attachments.length) {
    log("INFO", "file attachments downloaded", {
      messageId,
      count: attachments.length,
      paths: attachments.map((item) => item.path),
    });
  }
  return attachments;
}

function attachmentCounts(attachments) {
  const counts = { image: 0, file: 0 };
  for (const attachment of attachments || []) {
    if (attachment?.type === "image") counts.image += 1;
    else if (attachment?.type === "file") counts.file += 1;
  }
  return counts;
}

function formatAttachmentCounts(attachments) {
  const counts = attachmentCounts(attachments);
  const parts = [];
  if (counts.image) parts.push(`${counts.image} 张图片`);
  if (counts.file) parts.push(`${counts.file} 个文件`);
  return parts.join("和") || "附件";
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

const parseCommand = (content) => parseCommandInput(content, { extractText: userTextFromContent });

function attachmentPromptBlock(attachments) {
  const items = Array.isArray(attachments) ? attachments : [];
  const imageLines = items
    .filter((item) => item?.type === "image" && item.path)
    .map((item, index) => `${index + 1}. ${item.path}`);
  const fileLines = items
    .filter((item) => item?.type === "file" && item.path)
    .map((item, index) => {
      const label = item.fileName || path.basename(item.path);
      const size = formatBytes(item.sizeBytes);
      return `${index + 1}. ${label}: ${item.path}${size ? ` (${size})` : ""}`;
    });

  return [
    imageLines.length
      ? [
          "Local image attachments:",
          ...imageLines,
          "",
          "Use the attached images directly. The image files above were already downloaded locally.",
        ].join("\n")
      : "Local image attachments: none",
    "",
    fileLines.length
      ? [
          "Local file attachments:",
          ...fileLines,
          "",
          "The files above were already downloaded locally. Read these local paths with filesystem tools when needed.",
        ].join("\n")
      : "Local file attachments: none",
  ].join("\n");
}

function buildPrompt(event, session) {
  const content = userTextFromContent(event.content);
  const attachments = Array.isArray(event.attachments) ? event.attachments : [];

  const parts = [];
  if (history) parts.push(`最近上下文：\n${history}`);
  parts.push(content || (attachments.length ? "(attachment only)" : "(empty message)"));
  if (attachments.length) parts.push(attachmentPromptBlock(attachments));
  return parts.join("\n\n");
}

function shellQuote(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function sqliteLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return shellQuote(value);
}

function replaceWindowsLongPathPrefix(value) {
  const text = String(value || "");
  if (process.platform !== "win32") return text;
  if (/^\\\\\?\\UNC\\/i.test(text)) return `\\\\${text.slice(8)}`;
  if (/^\\\\\?\\/i.test(text)) return text.slice(4);
  return text;
}

function normalizeSpaces(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function shorten(value, max = 120) {
  const text = normalizeSpaces(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function feishuSidebarTitle(event, session) {
  const content = userTextFromContent(event.content);
  const body = content || (event.attachments?.length ? "附件消息" : "飞书消息");
  return shorten(`飞书：${session.id} · ${body}`, 120);
}

function extractCodexThreadId(stdoutRaw) {
  for (const line of String(stdoutRaw || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const value = parsed?.thread_id || parsed?.threadId || parsed?.thread?.id || parsed?.conversation_id;
      if (typeof value === "string" && value) return value;
    } catch {}
  }
  return "";
}

const SQLITE3_TOOL = { command: "sqlite3", argsPrefix: [] };
const PYTHON_SQLITE_JSON_SCRIPT = `
import json
import sqlite3
import sys

db_path = sys.argv[1]
sql = sys.stdin.read()
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
try:
    rows = conn.execute(sql).fetchall()
    def safe_value(value):
        if isinstance(value, bytes):
            try:
                return value.decode("utf-8")
            except UnicodeDecodeError:
                return value.hex()
        return value
    print(json.dumps([{key: safe_value(row[key]) for key in row.keys()} for row in rows]))
finally:
    conn.close()
`.trim();
const PYTHON_SQLITE_EXEC_SCRIPT = `
import sqlite3
import sys

db_path = sys.argv[1]
sql = sys.stdin.read()
conn = sqlite3.connect(db_path)
try:
    conn.executescript(sql)
    conn.commit()
finally:
    conn.close()
`.trim();
const PYTHON_SQLITE_THREAD_UPSERT_SCRIPT = `
import json
import sqlite3
import sys

db_path = sys.argv[1]
payload = json.load(sys.stdin)
columns = payload["columns"]
values = payload["values"]
if not columns or "id" not in columns:
    raise SystemExit("invalid columns")

def safe_value(value):
    if isinstance(value, str):
        return value.encode("utf-8", "replace").decode("utf-8")
    return value

values = [safe_value(value) for value in values]

quoted = ['"' + name.replace('"', '""') + '"' for name in columns]
placeholders = ", ".join("?" for _ in columns)
updates = ", ".join(f'{name} = excluded.{name}' for name in quoted if name != '"id"')
sql = (
    f'insert into threads ({", ".join(quoted)}) values ({placeholders}) '
    f'on conflict(id) do update set {updates}'
)

conn = sqlite3.connect(db_path)
try:
    conn.execute("pragma busy_timeout=10000")
    conn.execute("begin immediate")
    conn.execute(sql, values)
    conn.commit()
except Exception:
    conn.rollback()
    raise
finally:
    conn.close()
`.trim();

function pythonSqliteTools() {
  const tools = process.platform === "win32"
    ? [
        { command: "py", argsPrefix: ["-3"] },
        { command: "python", argsPrefix: [] },
        { command: "python3", argsPrefix: [] },
      ]
    : [
        { command: "python3", argsPrefix: [] },
        { command: "python", argsPrefix: [] },
      ];
  return tools;
}

function sqliteFailureText(tool, errorOrResult) {
  const label = toolLabel(tool);
  if (errorOrResult instanceof Error) return `${label}: ${errorOrResult.message}`;
  const code = errorOrResult?.code ?? "unknown";
  const text = String(errorOrResult?.stderr || errorOrResult?.stdout || "").trim();
  return `${label}: exit ${code}${text ? `; ${text.slice(0, 500)}` : ""}`;
}

async function runSqliteJsonTool(tool, dbPath, sql) {
  const args = tool === SQLITE3_TOOL
    ? ["-json", dbPath, sql]
    : ["-c", PYTHON_SQLITE_JSON_SCRIPT, dbPath];
  const options = tool === SQLITE3_TOOL
    ? { timeoutMs: 10_000, attempts: 1 }
    : { stdin: sql, timeoutMs: 10_000, attempts: 1 };
  return await runTool(tool, args, options);
}

async function runSqliteExecTool(tool, dbPath, sql) {
  const args = tool === SQLITE3_TOOL
    ? [dbPath]
    : ["-c", PYTHON_SQLITE_EXEC_SCRIPT, dbPath];
  return await runTool(tool, args, { stdin: sql, timeoutMs: 10_000, attempts: 1 });
}

async function runSqliteThreadUpsertTool(tool, dbPath, payload) {
  if (tool === SQLITE3_TOOL) throw new Error("sqlite3 CLI is not used for parameterized thread upserts");
  return await runTool(tool, ["-c", PYTHON_SQLITE_THREAD_UPSERT_SCRIPT, dbPath], {
    stdin: JSON.stringify(payload),
    timeoutMs: 10_000,
    attempts: 1,
  });
}

async function sqliteJson(dbPath, sql) {
  if (!fs.existsSync(dbPath)) return [];
  const tools = [SQLITE3_TOOL, ...pythonSqliteTools()];
  const failures = [];
  for (const tool of tools) {
    try {
      const result = await runSqliteJsonTool(tool, dbPath, sql);
      if (result.code !== 0) {
        failures.push(sqliteFailureText(tool, result));
        continue;
      }
      const output = result.stdout.trim();
      return output ? JSON.parse(output) : [];
    } catch (error) {
      failures.push(sqliteFailureText(tool, error));
    }
  }
  log("WARN", "sqlite json query failed", { dbPath, failures: failures.slice(0, 5) });
  return [];
}

async function runSqliteExec(dbPath, sql) {
  if (!fs.existsSync(dbPath)) return { ok: false, error: `SQLite database not found: ${dbPath}` };
  const tools = [SQLITE3_TOOL, ...pythonSqliteTools()];
  const failures = [];
  for (const tool of tools) {
    try {
      const result = await runSqliteExecTool(tool, dbPath, sql);
      if (result.code === 0) return { ok: true, result };
      failures.push(sqliteFailureText(tool, result));
    } catch (error) {
      failures.push(sqliteFailureText(tool, error));
    }
  }
  return { ok: false, error: failures.join(" | ") };
}

async function runSqliteThreadUpsert(dbPath, payload) {
  if (!fs.existsSync(dbPath)) return { ok: false, error: `SQLite database not found: ${dbPath}` };
  const tools = pythonSqliteTools();
  const failures = [];
  for (const tool of tools) {
    try {
      const result = await runSqliteThreadUpsertTool(tool, dbPath, payload);
      if (result.code === 0) return { ok: true, result };
      failures.push(sqliteFailureText(tool, result));
    } catch (error) {
      failures.push(sqliteFailureText(tool, error));
    }
  }
  return { ok: false, error: failures.join(" | ") };
}

async function sqliteExec(dbPath, sql) {
  const result = await runSqliteExec(dbPath, sql);
  if (!result.ok) log("WARN", "sqlite exec failed", { dbPath, error: result.error });
  return result.ok;
}

async function sqliteExecChecked(dbPath, sql) {
  const result = await runSqliteExec(dbPath, sql);
  if (!result.ok) throw new Error(result.error);
  return result.result;
}

async function loadCodexThreadRecord(threadId) {
  return await loadCodexThreadRecordFromDb(threadId, codexStateDbPath);
}

async function loadCodexThreadRecordFromDb(threadId, dbPath = codexStateDbPath) {
  const rows = await sqliteJson(
    dbPath,
    [
      "select *",
      "from threads",
      `where id = ${shellQuote(threadId)}`,
      "limit 1;",
    ].join(" "),
  );
  return rows[0] || null;
}

async function updateCodexThreadTitleInDb(threadId, title, dbPath = codexStateDbPath) {
  const id = String(threadId || "").trim();
  const nextTitle = normalizeRenameTitle(title);
  if (!id || !nextTitle || !fs.existsSync(dbPath)) return false;
  const record = await loadCodexThreadRecordFromDb(id, dbPath);
  if (!record) return false;
  const columns = await sqliteTableColumns("threads", dbPath);
  if (!columns.has("title")) return false;
  await sqliteExecChecked(
    dbPath,
    `UPDATE threads SET title = ${shellQuote(nextTitle)} WHERE id = ${shellQuote(id)};`,
  );
  return true;
}

function codexThreadBelongsToThisBridge(record) {
  if (!record) return false;
  const cwd = stripWindowsLongPathPrefix(record.cwd || "");
  const workspace = stripWindowsLongPathPrefix(CONFIG.workspace || "");
  if (!cwd || !workspace) return false;
  const cwdResolved = path.resolve(cwd).toLowerCase();
  const workspaceResolved = path.resolve(workspace).toLowerCase();
  return cwdResolved === workspaceResolved;
}

function codexThreadHasVisibleText(record) {
  return Boolean(String(record?.preview || record?.title || "").trim());
}

function codexThreadTitleForIndex(record, preferredTitle = "") {
  return cleanCodexThreadTitle(preferredTitle)
    || cleanCodexThreadTitle(record?.title)
    || cleanCodexThreadTitle(record?.first_user_message)
    || cleanCodexThreadTitle(record?.preview)
    || "Untitled";
}

function codexThreadUpdatedIso(record) {
  const ms = codexThreadTime(record, "updated") || codexThreadTime(record, "created") || Date.now();
  return new Date(ms).toISOString();
}

function codexWorkspaceRootHint() {
  const workspace = stripWindowsLongPathPrefix(CONFIG.workspace || "");
  const documentsCodex = path.join(os.homedir(), "Documents", "Codex");
  const workspaceRoot = path.join(documentsCodex, "workspaces");
  const resolvedWorkspace = path.resolve(workspace || CONFIG.workspace);
  const relativeToWorkspaceRoot = path.relative(workspaceRoot, resolvedWorkspace);
  if (relativeToWorkspaceRoot && !relativeToWorkspaceRoot.startsWith("..") && !path.isAbsolute(relativeToWorkspaceRoot)) {
    return documentsCodex;
  }
  return path.dirname(resolvedWorkspace);
}

async function withCodexSidebarLock(fn, codexHome = CONFIG.codexHome, lockPath = codexSidebarLockPath) {
  fs.mkdirSync(codexHome, { recursive: true });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    let fd = null;
    try {
      fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf8");
      return await fn();
    } catch (error) {
      if (!["EEXIST", "EACCES", "EPERM"].includes(error?.code)) throw error;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > 30_000) fs.rmSync(lockPath, { force: true });
      } catch {}
      await delay(100);
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {}
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {}
      }
    }
  }
  throw new Error(`timed out waiting for Codex sidebar sync lock: ${lockPath}`);
}

function readCodexSessionIndexTitle(threadId, sessionIndexPath = codexSessionIndexPath) {
  const id = String(threadId || "").trim();
  if (!id || !fs.existsSync(sessionIndexPath)) return "";

  const lines = fs.readFileSync(sessionIndexPath, "utf8")
    .replace(/\r\n/g, "\n")
    .split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.id === id) return cleanCodexThreadTitle(parsed.thread_name);
    } catch {}
  }
  return "";
}

function syncCodexSessionIndex(record, sessionIndexPath = codexSessionIndexPath, options = {}) {
  const id = String(record?.id || "").trim();
  if (!id) return false;

  const entry = JSON.stringify({
    id,
    thread_name: codexThreadTitleForIndex(record, options.threadName || ""),
    updated_at: codexThreadUpdatedIso(record),
  });

  let lines = [];
  if (fs.existsSync(sessionIndexPath)) {
    lines = fs.readFileSync(sessionIndexPath, "utf8")
      .replace(/\r\n/g, "\n")
      .split("\n");
    if (lines.at(-1) === "") lines.pop();
  }

  let replaced = false;
  const nextLines = [];
  for (const line of lines) {
    if (!line.trim()) {
      nextLines.push(line);
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed?.id === id) {
        if (!replaced) {
          nextLines.push(entry);
          replaced = true;
        }
        continue;
      }
    } catch {}
    nextLines.push(line);
  }
  if (!replaced) nextLines.push(entry);

  const next = `${nextLines.join("\n")}\n`;
  const previous = fs.existsSync(sessionIndexPath) ? fs.readFileSync(sessionIndexPath, "utf8") : "";
  if (previous === next) return false;
  fs.writeFileSync(sessionIndexPath, next, "utf8");
  return true;
}

function hasCodexSessionIndexEntry(threadId, sessionIndexPath = codexSessionIndexPath) {
  const id = String(threadId || "").trim();
  if (!id || !fs.existsSync(sessionIndexPath)) return false;
  const lines = fs.readFileSync(sessionIndexPath, "utf8").replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      if (JSON.parse(line)?.id === id) return true;
    } catch {}
  }
  return false;
}

function removeCodexSessionIndexEntry(threadId, sessionIndexPath = codexSessionIndexPath) {
  const id = String(threadId || "").trim();
  if (!id || !fs.existsSync(sessionIndexPath)) return false;

  const previous = fs.readFileSync(sessionIndexPath, "utf8");
  const lines = previous.replace(/\r\n/g, "\n").split("\n");
  const hadTrailingNewline = lines.at(-1) === "";
  if (hadTrailingNewline) lines.pop();

  let changed = false;
  const nextLines = [];
  for (const line of lines) {
    if (!line.trim()) {
      nextLines.push(line);
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed?.id === id) {
        changed = true;
        continue;
      }
    } catch {}
    nextLines.push(line);
  }

  if (!changed) return false;
  const next = `${nextLines.join("\n")}${hadTrailingNewline || nextLines.length ? "\n" : ""}`;
  fs.writeFileSync(sessionIndexPath, next, "utf8");
  return true;
}

function syncCodexGlobalState(record, globalStatePath = codexGlobalStatePath) {
  const id = String(record?.id || "").trim();
  if (!id) return false;

  let state = {};
  if (fs.existsSync(globalStatePath)) {
    const raw = fs.readFileSync(globalStatePath, "utf8").trim();
    if (raw) state = JSON.parse(raw);
  }

  let changed = false;
  if (!Array.isArray(state["projectless-thread-ids"])) {
    state["projectless-thread-ids"] = [];
    changed = true;
  }
  if (!state["projectless-thread-ids"].includes(id)) {
    state["projectless-thread-ids"].push(id);
    changed = true;
  }

  const rootHint = codexWorkspaceRootHint();
  if (!state["thread-workspace-root-hints"] || typeof state["thread-workspace-root-hints"] !== "object") {
    state["thread-workspace-root-hints"] = {};
    changed = true;
  }
  if (state["thread-workspace-root-hints"][id] !== rootHint) {
    state["thread-workspace-root-hints"][id] = rootHint;
    changed = true;
  }

  const outputPath = path.join(stripWindowsLongPathPrefix(CONFIG.workspace), "outputs");
  if (!state["thread-projectless-output-directories"] || typeof state["thread-projectless-output-directories"] !== "object") {
    state["thread-projectless-output-directories"] = {};
    changed = true;
  }
  if (state["thread-projectless-output-directories"][id] !== outputPath) {
    state["thread-projectless-output-directories"][id] = outputPath;
    changed = true;
  }

  if (!changed) return false;
  writeJsonFileAtomicSync(globalStatePath, state, { space: 0 });
  return true;
}

function removeCodexGlobalStateThread(threadId, globalStatePath = codexGlobalStatePath) {
  const id = String(threadId || "").trim();
  if (!id || !fs.existsSync(globalStatePath)) return false;

  const raw = fs.readFileSync(globalStatePath, "utf8").trim();
  if (!raw) return false;
  const state = JSON.parse(raw);
  let changed = false;

  for (const key of ["projectless-thread-ids", "pinned-thread-ids"]) {
    if (!Array.isArray(state[key])) continue;
    const next = state[key].filter((value) => value !== id);
    if (next.length !== state[key].length) {
      state[key] = next;
      changed = true;
    }
  }

  for (const key of ["thread-workspace-root-hints", "thread-projectless-output-directories"]) {
    if (!state[key] || typeof state[key] !== "object" || Array.isArray(state[key])) continue;
    if (Object.prototype.hasOwnProperty.call(state[key], id)) {
      delete state[key][id];
      changed = true;
    }
  }

  if (!changed) return false;
  writeJsonFileAtomicSync(globalStatePath, state, { space: 0 });
  return true;
}

async function removeCodexSidebarIndexesForThread(threadId) {
  const id = String(threadId || "").trim();
  if (!id) return { sessionIndexChanged: false, globalStateChanged: false };

  return await withCodexSidebarLock(async () => ({
    sessionIndexChanged: removeCodexSessionIndexEntry(id),
    globalStateChanged: removeCodexGlobalStateThread(id),
  }));
}

async function mirrorCodexThreadRecordToDesktopHome(record) {
  if (!shouldMirrorDesktopCodexHome) return false;
  if (!record?.id || !fs.existsSync(desktopCodexStateDbPath)) return false;

  const desktopRecord = {
    ...record,
    rollout_path: mirrorCodexRolloutToDesktopHome(record),
  };
  const sourceColumns = Object.keys(record);
  const targetColumns = await sqliteTableColumns("threads", desktopCodexStateDbPath);
  const columns = sourceColumns.filter((name) => targetColumns.has(name));
  if (!columns.includes("id") || !columns.includes("rollout_path")) return false;

  const current = await loadCodexThreadRecordFromDb(record.id, desktopCodexStateDbPath);
  if (recordsMatchColumns(current, desktopRecord, columns)) return false;

  const result = await runSqliteThreadUpsert(desktopCodexStateDbPath, {
    columns,
    values: columns.map((name) => desktopRecord[name] ?? null),
  });
  if (!result.ok) {
    log("WARN", "desktop Codex home thread mirror failed", {
      threadId: record.id,
      sourceCodexHome: CONFIG.codexHome,
      desktopCodexHome: CONFIG.desktopCodexHome,
      desktopCodexStateDbPath,
      error: result.error,
    });
    return false;
  }
  return true;
}

function mirrorCodexRolloutToDesktopHome(record) {
  const sourcePath = replaceWindowsLongPathPrefix(record?.rollout_path || "");
  if (!sourcePath || !path.isAbsolute(sourcePath) || !fs.existsSync(sourcePath)) return record?.rollout_path || "";

  const sourceSessionsRoot = path.join(CONFIG.codexHome, "sessions");
  const sourceRootResolved = fs.existsSync(sourceSessionsRoot)
    ? fs.realpathSync.native(sourceSessionsRoot)
    : path.resolve(sourceSessionsRoot);
  const sourceResolved = fs.realpathSync.native(sourcePath);
  const relative = path.relative(sourceRootResolved, sourceResolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    log("WARN", "desktop Codex home rollout mirror skipped; source rollout outside source sessions", {
      threadId: record?.id || "",
      rolloutPath: sourcePath,
      sourceSessionsRoot,
    });
    return record?.rollout_path || "";
  }

  const targetPath = path.join(CONFIG.desktopCodexHome, "sessions", relative);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const sourceStat = fs.statSync(sourceResolved);
  const targetStat = fs.existsSync(targetPath) ? fs.statSync(targetPath) : null;
  if (!targetStat || targetStat.size !== sourceStat.size || targetStat.mtimeMs < sourceStat.mtimeMs) {
    fs.copyFileSync(sourceResolved, targetPath);
  }
  return targetPath;
}

async function mirrorCodexDesktopSidebarIndexed(record, reason = "app-server") {
  if (!shouldMirrorDesktopCodexHome) return false;
  if (!record?.id) return false;
  if (!fs.existsSync(desktopCodexStateDbPath)) {
    log("WARN", "desktop Codex home mirror skipped; target state database not found", {
      threadId: record.id,
      desktopCodexHome: CONFIG.desktopCodexHome,
      desktopCodexStateDbPath,
    });
    return false;
  }

  try {
    const changed = await withCodexSidebarLock(async () => {
      const threadRecordChanged = await mirrorCodexThreadRecordToDesktopHome(record);
      const desktopRecord = await loadCodexThreadRecordFromDb(record.id, desktopCodexStateDbPath) || record;
      const sourceThreadName = readCodexSessionIndexTitle(record.id, codexSessionIndexPath);
      const sessionIndexChanged = syncCodexSessionIndex(desktopRecord, desktopCodexSessionIndexPath, {
        threadName: sourceThreadName,
      });
      const globalStateChanged = syncCodexGlobalState(desktopRecord, desktopCodexGlobalStatePath);
      return { threadRecordChanged, sessionIndexChanged, globalStateChanged };
    }, CONFIG.desktopCodexHome, desktopCodexSidebarLockPath);

    if (changed.threadRecordChanged || changed.sessionIndexChanged || changed.globalStateChanged) {
      log("INFO", "desktop Codex home sidebar mirror synced", {
        threadId: record.id,
        reason,
        sourceCodexHome: CONFIG.codexHome,
        desktopCodexHome: CONFIG.desktopCodexHome,
        workspace: CONFIG.workspace,
        threadRecordChanged: changed.threadRecordChanged,
        sessionIndexChanged: changed.sessionIndexChanged,
        globalStateChanged: changed.globalStateChanged,
      });
      return true;
    }
  } catch (error) {
    log("WARN", "desktop Codex home sidebar mirror failed", {
      threadId: record.id,
      reason,
      sourceCodexHome: CONFIG.codexHome,
      desktopCodexHome: CONFIG.desktopCodexHome,
      error: String(error?.stack || error),
    });
  }
  return false;
}

async function ensureCodexDesktopSidebarIndexed(threadId, reason = "app-server") {
  const id = String(threadId || "").trim();
  if (!id || !fs.existsSync(codexStateDbPath)) return false;

  const record = await loadCodexThreadRecord(id);
  if (!record) return false;
  if (!codexThreadBelongsToThisBridge(record)) return false;
  if (Number(record.archived || 0) !== 0) return false;
  if (!codexThreadHasVisibleText(record)) return false;

  try {
    const changed = await withCodexSidebarLock(async () => {
      const sessionIndexChanged = syncCodexSessionIndex(record);
      const globalStateChanged = syncCodexGlobalState(record);
      return { sessionIndexChanged, globalStateChanged };
    });
    const mirrored = await mirrorCodexDesktopSidebarIndexed(record, reason);
    if (changed.sessionIndexChanged || changed.globalStateChanged) {
      log("INFO", "codex desktop sidebar index synced", {
        threadId: id,
        reason,
        codexHome: CONFIG.codexHome,
        workspace: CONFIG.workspace,
        sessionIndexChanged: changed.sessionIndexChanged,
        globalStateChanged: changed.globalStateChanged,
      });
      return true;
    }
    if (mirrored) return true;
  } catch (error) {
    log("WARN", "codex desktop sidebar index sync failed", {
      threadId: id,
      reason,
      codexHome: CONFIG.codexHome,
      error: String(error?.stack || error),
    });
  }
  return await mirrorCodexDesktopSidebarIndexed(record, reason);
}

async function ensureAppServerThreadVisible(threadId, reason = "app-server") {
  const id = String(threadId || "").trim();
  if (!id || !fs.existsSync(codexStateDbPath)) return false;

  const record = await loadCodexThreadRecord(id);
  if (!record) return false;
  if (!codexThreadBelongsToThisBridge(record)) return false;
  if (Number(record.archived || 0) !== 0) return false;
  if (!codexThreadHasVisibleText(record)) return false;

  const source = String(record.source || "");
  const threadSource = String(record.thread_source || "");

  let changed = false;
  if (Number(record.has_user_event || 0) !== 1 || source !== "vscode" || threadSource !== "user") {
    const sql = [
      "pragma busy_timeout=10000;",
      "begin immediate;",
      "update threads set",
      "  has_user_event = 1,",
      "  source = 'vscode',",
      "  thread_source = 'user'",
      `where id = ${shellQuote(id)}`,
      "  and archived = 0",
      "  and (preview <> '' or title <> '')",
      `  and cwd = ${shellQuote(record.cwd || "")};`,
      "commit;",
      "",
    ].join("\n");

    if (await sqliteExec(codexStateDbPath, sql)) {
      changed = true;
      log("INFO", "codex app-server thread visibility repaired", {
        threadId: id,
        reason,
        codexHome: CONFIG.codexHome,
        codexStateDbPath,
        workspace: CONFIG.workspace,
        cwd: record.cwd || "",
        previousHasUserEvent: record.has_user_event ?? "",
      });
    }
  }

  const indexChanged = await ensureCodexDesktopSidebarIndexed(id, reason);
  return changed || indexChanged;
}

async function verifyAppServerThreadRegistration(threadId) {
  const id = String(threadId || "").trim();
  if (!id) return;

  const record = await loadCodexThreadRecord(id);
  if (!record) {
    log("WARN", "codex thread missing from target Codex home", {
      threadId: id,
      codexHome: CONFIG.codexHome,
      codexStateDbPath,
      workspace: CONFIG.workspace,
    });
    return;
  }

  const rolloutPath = String(record.rollout_path || "");
  log("INFO", "codex thread registered in target Codex home", {
    threadId: id,
    codexHome: CONFIG.codexHome,
    codexStateDbPath,
    workspace: CONFIG.workspace,
    cwd: record.cwd || "",
    rolloutPath,
    rolloutExists: rolloutPath ? fs.existsSync(stripWindowsLongPathPrefix(rolloutPath)) : false,
    archived: record.archived ?? "",
    hasUserEvent: record.has_user_event ?? "",
    previewLength: String(record.preview || "").length,
  });
}

async function listVisibleCodexThreadRecordsForBridge() {
  if (!fs.existsSync(codexStateDbPath)) return [];

  const cwd = stripWindowsLongPathPrefix(CONFIG.workspace || "");
  if (!cwd) return [];
  const dbCwd = process.platform === "win32" ? `\\\\?\\${cwd}` : cwd;
  const rows = await sqliteJson(
    codexStateDbPath,
    [
      "select *",
      "from threads",
      "where archived = 0",
      "  and (preview <> '' or title <> '')",
      `  and (cwd = ${shellQuote(cwd)} or cwd = ${shellQuote(dbCwd)})`,
      "order by coalesce(updated_at_ms, created_at_ms, 0) desc, updated_at desc",
      `limit ${Math.max(1, CONFIG.listLimit)};`,
    ].join(" "),
  );

  return rows.filter((record) =>
    codexThreadBelongsToThisBridge(record)
    && Number(record.archived || 0) === 0
    && codexThreadHasVisibleText(record)
  );
}

async function reconcileCodexDesktopSidebarIndexes(reason = "startup") {
  if (!fs.existsSync(codexStateDbPath)) return false;
  if (sidebarReconcileInFlight) {
    sidebarReconcileQueuedReason = reason;
    return false;
  }

  sidebarReconcileInFlight = true;
  try {
    const records = await listVisibleCodexThreadRecordsForBridge();
    let changed = false;
    for (const record of records) {
      changed = await ensureCodexDesktopSidebarIndexed(record.id, reason) || changed;
    }
    if (changed || reason === "startup") {
      log("INFO", "codex desktop sidebar indexes reconciled", {
        reason,
        codexHome: CONFIG.codexHome,
        workspace: CONFIG.workspace,
        checked: records.length,
        changed,
      });
    }
    return changed;
  } catch (error) {
    log("WARN", "codex desktop sidebar reconcile failed", {
      reason,
      codexHome: CONFIG.codexHome,
      workspace: CONFIG.workspace,
      error: String(error?.stack || error),
    });
    return false;
  } finally {
    sidebarReconcileInFlight = false;
    const queuedReason = sidebarReconcileQueuedReason;
    sidebarReconcileQueuedReason = "";
    if (queuedReason) {
      setTimeout(() => {
        reconcileCodexDesktopSidebarIndexes(`${queuedReason}/queued`).catch((error) => {
          log("WARN", "queued codex desktop sidebar reconcile failed", { error: String(error?.stack || error) });
        });
      }, 250).unref?.();
    }
  }
}

async function codexTableSet(dbPath = codexStateDbPath) {
  const rows = await sqliteJson(
    dbPath,
    "select name from sqlite_master where type = 'table';",
  );
  return new Set(rows.map((row) => String(row.name || "")).filter(Boolean));
}

async function sqliteTableColumns(tableName, dbPath = codexStateDbPath) {
  const safeName = String(tableName || "").replace(/"/g, "\"\"");
  const rows = await sqliteJson(dbPath, `PRAGMA table_info("${safeName}");`);
  return new Set(rows.map((row) => String(row.name || "")).filter(Boolean));
}

async function deleteByThreadIdIfPossible(statements, tables, tableName, dbPath = codexStateDbPath) {
  if (!tables.has(tableName)) return;
  const columns = await sqliteTableColumns(tableName, dbPath);
  if (columns.has("thread_id")) {
    statements.push(`DELETE FROM ${tableName} WHERE thread_id = ?1;`);
  } else if (columns.has("id")) {
    statements.push(`DELETE FROM ${tableName} WHERE id = ?1;`);
  }
}

function resolveSafeCodexRolloutPath(rolloutPath, threadId, codexHome = CONFIG.codexHome) {
  const raw = stripWindowsLongPathPrefix(rolloutPath);
  if (!raw || !path.isAbsolute(raw)) throw new Error(`invalid rollout_path: ${rolloutPath || ""}`);

  const sessionsRoot = fs.realpathSync.native(path.join(codexHome, "sessions"));
  const resolved = fs.existsSync(raw) ? fs.realpathSync.native(raw) : path.resolve(raw);
  const relative = path.relative(sessionsRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`refusing to delete rollout outside Codex sessions: ${resolved}`);
  }
  if (!path.basename(resolved).includes(threadId)) {
    throw new Error(`refusing to delete rollout without matching thread id: ${resolved}`);
  }
  return resolved;
}

function findRolloutFilesForThread(threadId, codexHome = CONFIG.codexHome) {
  const id = String(threadId || "").trim();
  if (!id) return [];
  return listRolloutFiles(codexHome).filter((filePath) => path.basename(filePath).includes(id));
}

async function deleteCodexThreadRowsFromDb(threadId, dbPath = codexStateDbPath) {
  const id = String(threadId || "").trim();
  if (!id) throw new Error("thread id is required");
  if (!fs.existsSync(dbPath)) throw new Error(`Codex state database not found: ${dbPath}`);

  const tables = await codexTableSet(dbPath);
  if (!tables.has("threads")) throw new Error("Unsupported local storage schema: missing threads table");
  const statements = [
    "PRAGMA busy_timeout = 5000;",
    "BEGIN IMMEDIATE;",
  ];

  if (tables.has("thread_dynamic_tools")) {
    statements.push("DELETE FROM thread_dynamic_tools WHERE thread_id = ?1;");
  }
  await deleteByThreadIdIfPossible(statements, tables, "thread_goals", dbPath);
  await deleteByThreadIdIfPossible(statements, tables, "thread_goal", dbPath);
  if (tables.has("thread_spawn_edges")) {
    statements.push("DELETE FROM thread_spawn_edges WHERE parent_thread_id = ?1 OR child_thread_id = ?1;");
  }
  await deleteByThreadIdIfPossible(statements, tables, "stage1_outputs", dbPath);
  if (tables.has("agent_job_items")) {
    statements.push("UPDATE agent_job_items SET assigned_thread_id = NULL WHERE assigned_thread_id = ?1;");
  }
  if (tables.has("messages")) {
    statements.push("DELETE FROM messages WHERE session_id = ?1;");
  }
  if (tables.has("sessions")) {
    statements.push("DELETE FROM sessions WHERE id = ?1;");
  }
  statements.push("DELETE FROM threads WHERE id = ?1;");
  statements.push("COMMIT;");

  await sqliteExecChecked(
    dbPath,
    statements.join("\n").replace(/\?1/g, shellQuote(id)),
  );
}

function resolveMirroredRolloutPath(record, sourceRolloutPath, targetCodexHome) {
  const sourcePath = replaceWindowsLongPathPrefix(sourceRolloutPath || record?.rollout_path || "");
  if (!sourcePath || !path.isAbsolute(sourcePath)) return "";

  const sourceSessionsRoot = path.join(CONFIG.codexHome, "sessions");
  const sourceRootResolved = fs.existsSync(sourceSessionsRoot)
    ? fs.realpathSync.native(sourceSessionsRoot)
    : path.resolve(sourceSessionsRoot);
  const sourceResolved = fs.existsSync(sourcePath) ? fs.realpathSync.native(sourcePath) : path.resolve(sourcePath);
  const relative = path.relative(sourceRootResolved, sourceResolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return "";
  return path.join(targetCodexHome, "sessions", relative);
}

async function removeDesktopMirrorForThread(threadId, sourceRecord, sourceRolloutPath = "") {
  const id = String(threadId || "").trim();
  const result = {
    enabled: shouldMirrorDesktopCodexHome,
    dbChanged: false,
    rolloutDeleted: false,
    rolloutMissing: false,
    rolloutPath: "",
    sessionIndexChanged: false,
    globalStateChanged: false,
    error: "",
  };
  if (!id || !shouldMirrorDesktopCodexHome) return result;

  try {
    await withCodexSidebarLock(async () => {
      if (fs.existsSync(desktopCodexStateDbPath)) {
        const before = await loadCodexThreadRecordFromDb(id, desktopCodexStateDbPath);
        if (before) {
          await deleteCodexThreadRowsFromDb(id, desktopCodexStateDbPath);
          const after = await loadCodexThreadRecordFromDb(id, desktopCodexStateDbPath);
          if (after) throw new Error(`Desktop mirror thread delete did not remove row: ${id}`);
          result.dbChanged = true;
        }
      }

      result.sessionIndexChanged = removeCodexSessionIndexEntry(id, desktopCodexSessionIndexPath);
      result.globalStateChanged = removeCodexGlobalStateThread(id, desktopCodexGlobalStatePath);
    }, CONFIG.desktopCodexHome, desktopCodexSidebarLockPath);

    const mirrorCandidates = Array.from(new Set([
      resolveMirroredRolloutPath(sourceRecord, sourceRolloutPath, CONFIG.desktopCodexHome),
      ...findRolloutFilesForThread(id, CONFIG.desktopCodexHome),
    ].filter(Boolean)));
    if (mirrorCandidates.length) {
      let missingCount = 0;
      for (const mirrorPath of mirrorCandidates) {
        result.rolloutPath = result.rolloutPath || mirrorPath;
        const safePath = resolveSafeCodexRolloutPath(mirrorPath, id, CONFIG.desktopCodexHome);
        if (fs.existsSync(safePath)) {
          fs.rmSync(safePath, { force: true });
          result.rolloutDeleted = true;
        } else {
          missingCount += 1;
        }
      }
      result.rolloutMissing = !result.rolloutDeleted && missingCount > 0;
    }
  } catch (error) {
    result.error = String(error.message || error);
    log("ERROR", "desktop Codex mirror cleanup failed after db delete", {
      threadId: id,
      desktopCodexHome: CONFIG.desktopCodexHome,
      error: result.error,
    });
  }

  return result;
}

async function deleteCodexLocalThread(threadId) {
  const id = String(threadId || "").trim();
  if (!id) throw new Error("thread id is required");
  let record = fs.existsSync(codexStateDbPath) ? await loadCodexThreadRecord(id) : null;
  const dbChanged = Boolean(record);
  if (record) {
    await deleteCodexThreadRowsFromDb(id, codexStateDbPath);
    const afterDelete = await loadCodexThreadRecord(id);
    if (afterDelete) throw new Error(`Thread delete did not remove local row: ${id}`);
  } else {
    const rolloutPath = findRolloutFilesForThread(id, CONFIG.codexHome)[0] || "";
    record = {
      id,
      title: readCodexSessionIndexTitle(id) || "",
      rollout_path: rolloutPath,
    };
  }

  let rolloutDeleted = false;
  let rolloutMissing = false;
  let rolloutError = "";
  let rolloutPath = "";
  let sidebarIndexChanged = false;
  let globalStateChanged = false;
  let sidebarIndexError = "";
  let desktopMirror = { enabled: false };
  const rolloutCandidates = Array.from(new Set([
    record.rollout_path || "",
    ...findRolloutFilesForThread(id, CONFIG.codexHome),
  ].filter(Boolean)));
  if (rolloutCandidates.length) {
    let missingCount = 0;
    try {
      for (const candidate of rolloutCandidates) {
        const safePath = resolveSafeCodexRolloutPath(candidate, id);
        rolloutPath = rolloutPath || safePath;
        if (fs.existsSync(safePath)) {
          fs.rmSync(safePath, { force: true });
          rolloutDeleted = true;
        } else {
          missingCount += 1;
        }
      }
      rolloutMissing = !rolloutDeleted && missingCount > 0;
    } catch (error) {
      rolloutError = String(error.message || error);
      log("ERROR", "codex rollout delete failed during thread cleanup", { threadId: id, rolloutPath: record.rollout_path, error: rolloutError });
    }
  }
  try {
    const sidebarResult = await removeCodexSidebarIndexesForThread(id);
    sidebarIndexChanged = Boolean(sidebarResult.sessionIndexChanged);
    globalStateChanged = Boolean(sidebarResult.globalStateChanged);
  } catch (error) {
    sidebarIndexError = String(error.message || error);
    log("ERROR", "codex sidebar index cleanup failed after db delete", { threadId: id, error: sidebarIndexError });
  }
  desktopMirror = await removeDesktopMirrorForThread(id, record, rolloutPath || record.rollout_path || "");

  return {
    threadId: id,
    title: record.title || "",
    dbChanged,
    rolloutPath: rolloutPath || record.rollout_path || "",
    rolloutDeleted,
    rolloutMissing,
    rolloutError,
    sidebarIndexChanged,
    globalStateChanged,
    sidebarIndexError,
    desktopMirror,
  };
}

async function findCodexThreadIdForPrompt(promptFile, stdoutRaw) {
  const direct = extractCodexThreadId(stdoutRaw);
  if (direct) return direct;
  if (!promptFile || !fs.existsSync(codexStateDbPath)) return "";
  const rows = await sqliteJson(
    codexStateDbPath,
    [
      "select id from threads",
      `where title like ${shellQuote(`%${promptFile}%`)}`,
      "order by updated_at_ms desc limit 1;",
    ].join(" "),
  );
  return rows[0]?.id || "";
}

function shouldReplacePromptText(text, promptFile) {
  if (typeof text !== "string") return false;
  if (promptFile && text.includes(promptFile)) return true;
  return text.startsWith("读取这个 UTF-8 任务文件");
}

async function patchCodexRolloutForSidebar(threadId, promptFile, title) {
  if (!threadId || !fs.existsSync(codexStateDbPath)) return false;
  const rows = await sqliteJson(
    codexStateDbPath,
    `select rollout_path from threads where id = ${shellQuote(threadId)} limit 1;`,
  );
  const rolloutPath = rows[0]?.rollout_path;
  if (!rolloutPath || !fs.existsSync(rolloutPath)) return false;

  const original = fs.readFileSync(rolloutPath, "utf8");
  const hasTrailingNewline = original.endsWith("\n");
  const normalized = original.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (hasTrailingNewline && lines.at(-1) === "") lines.pop();

  let changed = false;
  const patchedLines = lines.map((line) => {
    if (!line.trim()) return line;

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return line;
    }

    let lineChanged = false;
    if (parsed?.type === "session_meta" && parsed.payload?.id === threadId) {
      if (parsed.payload.source !== "vscode") {
        parsed.payload.source = "vscode";
        lineChanged = true;
      }
      if (parsed.payload.thread_source !== "user") {
        parsed.payload.thread_source = "user";
        lineChanged = true;
      }
    }

    if (parsed?.type === "response_item" && parsed.payload?.type === "message" && parsed.payload?.role === "user") {
      const content = parsed.payload.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part?.type === "input_text" && shouldReplacePromptText(part.text, promptFile)) {
            part.text = title;
            lineChanged = true;
          }
        }
      }
    }

    if (parsed?.type === "event_msg" && parsed.payload?.type === "user_message") {
      if (shouldReplacePromptText(parsed.payload.message, promptFile)) {
        parsed.payload.message = title;
        lineChanged = true;
      }
    }

    if (!lineChanged) return line;
    changed = true;
    return JSON.stringify(parsed);
  });

  if (changed) {
    fs.writeFileSync(rolloutPath, `${patchedLines.join("\n")}${hasTrailingNewline ? "\n" : ""}`, "utf8");
  }
  return changed;
}

async function syncCodexSidebarThread({ event, session, promptFile, outFile, stdoutRaw }) {
  const threadId = await findCodexThreadIdForPrompt(promptFile, stdoutRaw);
  if (!threadId) {
    log("WARN", "sidebar sync skipped; codex thread not found", { messageId: event.message_id || event.id, sessionId: session.id, promptFile });
    return;
  }

  if (!CONFIG.syncSidebar) {
    await ensureAppServerThreadVisible(threadId, "exec/completed");
    return;
  }

  const title = feishuSidebarTitle(event, session);
  const firstUserMessage = userTextFromContent(event.content) || title;
  const preview = [
    `feishuSession=${session.id}`,
    `messageId=${event.message_id || event.id || ""}`,
    `prompt=${promptFile}`,
    `output=${outFile}`,
  ].join(" | ");

  const sql = [
    "pragma busy_timeout=10000;",
    "begin immediate;",
    "update threads set",
    `  title = ${shellQuote(title)},`,
    `  first_user_message = ${shellQuote(firstUserMessage)},`,
    `  preview = ${shellQuote(preview)},`,
    "  source = 'vscode',",
    "  thread_source = 'user'",
    `where id = ${shellQuote(threadId)};`,
    "commit;",
    "",
  ].join("\n");

  if (await sqliteExec(codexStateDbPath, sql)) {
    log("INFO", "sidebar thread synced", { threadId, sessionId: session.id, title, promptFile });
  } else {
    log("WARN", "sidebar sync failed", { threadId, sessionId: session.id, promptFile });
  }

  try {
    const patchedRollout = await patchCodexRolloutForSidebar(threadId, promptFile, title);
    log("INFO", "sidebar rollout patch checked", { threadId, sessionId: session.id, patchedRollout });
  } catch (error) {
    log("WARN", "sidebar rollout patch failed", { threadId, sessionId: session.id, error: String(error?.stack || error) });
  }
  await ensureAppServerThreadVisible(threadId, "exec/completed");
}

function startAppServerClient({ cwd = CONFIG.workspace, label = "codex-app-server" } = {}) {
  return new AppServerClient({
    tool: CONFIG.codexCli,
    codexHome: CONFIG.codexHome,
    workspace: CONFIG.workspace,
    cwd,
    label,
    activeChildren,
    log,
    formatError: errorText,
    terminateProcessTree,
  }).start();
}

function resultTextFromState(state) {
  return state.blocks
    .filter((block) => block.kind === "text")
    .map((block) => block.content)
    .join("")
    .trim();
}

function tokenStringFromState(state) {
  if (!state?.meta) return "";
  if (state.meta.inputTokens === undefined && state.meta.outputTokens === undefined) return "";
  const parts = [
    `input ${formatNumber(state.meta.inputTokens || 0)}`,
    `output ${formatNumber(state.meta.outputTokens || 0)}`,
  ];
  if (state.meta.reasoningOutputTokens) parts.push(`reasoning ${formatNumber(state.meta.reasoningOutputTokens)}`);
  return parts.join(" / ");
}

async function initializeAppServerClient(client) {
  const initialized = await client.request("initialize", {
    clientInfo: { name: "codex-feishu-bridge", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  }, 60_000);
  client.notify("initialized");
  return initialized;
}

function observeAppServerSessionEvent(session, message) {
  if (!session || !message?.method) return;
  const params = message.params || {};
  if (message.method === "thread/status/changed") {
    updateSessionThreadStatus(session, params.status?.type || "");
  } else if (message.method === "thread/tokenUsage/updated") {
    updateSessionTokenUsage(session, params.tokenUsage);
  } else if (message.method === "thread/goal/updated") {
    updateSessionGoal(session, params.goal || null);
  } else if (message.method === "thread/goal/cleared") {
    updateSessionGoal(session, null);
  }
}

async function waitForAppServerNotification(client, predicate, timeoutMs) {
  const useDeadline = hasDuration(timeoutMs);
  const deadline = Date.now() + (useDeadline ? timeoutMs : 0);
  while (!useDeadline || Date.now() < deadline) {
    const remaining = useDeadline ? Math.max(1, deadline - Date.now()) : 1000;
    const message = await client.nextNotification(Math.min(1000, remaining));
    if (!message) {
      if (client.closed) break;
      continue;
    }
    if (message.method === "error") {
      throw errorFromFailure(classifyCodexFailure(message.params, "codex app-server error"));
    }
    if (predicate(message)) return message;
  }
  return null;
}

function createRunWatchdog(label, onTimeout, {
  totalMs = CONFIG.codexTimeoutMs,
  idleMs = CONFIG.codexIdleTimeoutMs,
} = {}) {
  return createBaseRunWatchdog(label, onTimeout, { totalMs, idleMs });
}

async function compactAppServerThread(session) {
  const client = startAppServerClient({ cwd: CONFIG.workspace });
  const startedAt = Date.now();
  const watchdog = createRunWatchdog("codex app-server compaction", () => {
    void client.stop();
    setTimeout(() => terminateProcessTree(client.child?.pid, true), 5000).unref?.();
  });

  try {
    log("INFO", "starting codex app-server compaction", {
      sessionId: session.id,
      threadId: session.codexThreadId || "",
      timeoutMs: CONFIG.codexTimeoutMs,
      idleTimeoutMs: CONFIG.codexIdleTimeoutMs,
    });

    await initializeAppServerClient(client);
    watchdog.touch();
    const resumed = await client.request("thread/resume", appServerResumeParams(session), 60_000);
    watchdog.touch();
    const threadId = resumed?.thread?.id || session.codexThreadId;
    if (threadId && threadId !== session.codexThreadId) {
      session.codexThreadId = threadId;
      session.updatedAt = Date.now();
      saveSessions();
    }

    await client.request("thread/compact/start", { threadId }, 60_000);
    watchdog.touch();
    const compacted = await waitForAppServerNotification(
      client,
      (message) => {
        watchdog.touch();
        observeAppServerSessionEvent(session, message);
        if (message.method === "thread/compacted") {
          return !message.params?.threadId || message.params.threadId === threadId;
        }
        return message.method === "item/completed" && message.params?.item?.type === "contextCompaction";
      },
      hasDuration(CONFIG.codexTimeoutMs) ? CONFIG.codexTimeoutMs : CONFIG.codexIdleTimeoutMs,
    );

    if (watchdog.timedOut || !compacted) {
      throw new Error(watchdog.reason || `codex app-server compaction idle timed out after ${Math.round(CONFIG.codexIdleTimeoutMs / 1000)}s`);
    }

    markSessionCompacted(session);
    return { threadId, durationMs: Date.now() - startedAt };
  } finally {
    watchdog.clear();
    await client.stop();
  }
}

async function withAppServerThread(session, { createIfMissing = true, timeoutMs = 60_000 } = {}, fn) {
  if (CONFIG.runMode === "exec") {
    throw new Error("当前 runMode=exec，没有可管理的 app-server 原生 thread。");
  }
  if (!createIfMissing && !session.codexThreadId) {
    throw new Error("当前会话还没有创建 Codex 原生 thread。");
  }

  const client = startAppServerClient({ cwd: CONFIG.workspace });
  try {
    await initializeAppServerClient(client);
    const threadId = createIfMissing
      ? await startOrResumeAppServerThread(client, session)
      : (await client.request("thread/resume", appServerResumeParams(session), timeoutMs))?.thread?.id || session.codexThreadId;
    if (threadId && threadId !== session.codexThreadId) {
      session.codexThreadId = threadId;
      session.updatedAt = Date.now();
      saveSessions();
    }
    return await fn(client, threadId);
  } finally {
    await client.stop();
  }
}

async function getAppServerGoal(session) {
  if (!session.codexThreadId) return null;
  try {
    return await withAppServerThread(session, { createIfMissing: false }, async (client, threadId) => {
      const result = await client.request("thread/goal/get", { threadId }, 60_000);
      updateSessionGoal(session, result?.goal || null);
      return session.lastGoal;
    });
  } catch (error) {
    if (!isNoGoalExistsError(error)) throw error;
    updateSessionGoal(session, null);
    return null;
  }
}

async function setAppServerGoal(session, goalPatch) {
  try {
    return await withAppServerThread(session, { createIfMissing: true }, async (client, threadId) => {
      const result = await client.request("thread/goal/set", { threadId, ...goalPatch }, 60_000);
      return updateSessionGoal(session, result?.goal || null);
    });
  } catch (error) {
    if (!isNoGoalExistsError(error)) throw error;
    updateSessionGoal(session, null);
    return null;
  }
}

async function clearAppServerGoal(session) {
  if (!session.codexThreadId) return false;
  try {
    return await withAppServerThread(session, { createIfMissing: false }, async (client, threadId) => {
      const result = await client.request("thread/goal/clear", { threadId }, 60_000);
      updateSessionGoal(session, null);
      return Boolean(result?.cleared);
    });
  } catch (error) {
    if (!isNoGoalExistsError(error)) throw error;
    updateSessionGoal(session, null);
    return false;
  }
}

function applyGoalRunNativeState(run, goal) {
  const next = normalizeGoal(goal);
  if (next) {
    run.goalCleared = false;
    run.goal = setRunGoalState(run.state, next);
    updateSessionGoal(run.session, run.goal);
    return run.goal;
  }

  run.goalCleared = true;
  run.goal = null;
  setRunGoalState(run.state, null);
  updateSessionGoal(run.session, null);
  return null;
}

async function getGoalRunNativeState(run) {
  if (!run?.client || !run.threadId) return normalizeGoal(run?.goal || run?.session?.lastGoal);
  try {
    const result = await run.client.request("thread/goal/get", { threadId: run.threadId }, 60_000);
    return applyGoalRunNativeState(run, result?.goal || null);
  } catch (error) {
    if (!isNoGoalExistsError(error)) throw error;
    if (goalStatusIsTerminal(normalizeGoal(run.goal)?.status)) {
      updateSessionGoal(run.session, run.goal);
      return run.goal;
    }
    return applyGoalRunNativeState(run, null);
  }
}

function activeGoalRunForChat(chatId, session = null) {
  const run = activeGoalRuns.get(chatId);
  if (!run || run.done) return null;
  if (session && run.sessionId !== session.id) return null;
  return run;
}

async function refreshGoalRunForNativeState(chatId, session, run) {
  if (!run) return null;
  if (run.done || run.client?.closed) {
    if (activeGoalRuns.get(chatId) === run) activeGoalRuns.delete(chatId);
    return null;
  }
  const nativeGoal = await getGoalRunNativeState(run);
  if (!nativeGoal && run.goalCleared) {
    if (activeGoalRuns.get(chatId) === run) activeGoalRuns.delete(chatId);
    return null;
  }
  if (session && run.sessionId !== session.id) return null;
  return run;
}

function goalStatusIsTerminal(status) {
  const value = String(status || "").trim();
  return Boolean(value && value !== "active");
}

function goalStatusIsActive(status) {
  return String(status || "").trim() === "active";
}

function goalRunTerminal(run) {
  if (run.goalCleared) return true;
  return goalStatusIsTerminal(normalizeGoal(run.goal || run.session.lastGoal)?.status);
}

function previewGoalFromPatch(session, patch) {
  const current = normalizeGoal(session.lastGoal) || {};
  const objective = String(patch.objective ?? current.objective ?? "").trim();
  if (!objective) return null;
  return normalizeGoal({
    ...current,
    ...patch,
    objective,
    status: patch.status || current.status || "active",
    threadId: current.threadId || session.codexThreadId || "",
    updatedAt: Date.now(),
  });
}

function setRunGoalState(state, goal) {
  state.goalMode = true;
  state.goal = normalizeGoal(goal);
  return state.goal;
}

function settleGoalRunReady(run, error = null) {
  if (run.readySettled) return;
  run.readySettled = true;
  if (error) run.readyReject(error);
  else run.readyResolve(run);
}

function nativeGoalRunFinalText(run) {
  const goal = normalizeGoal(run.goal || run.session.lastGoal);
  if (run.goalCleared || !goal) return "Codex goal 已清除。";
  switch (goal.status) {
    case "active":
      return "Codex goal 仍在进行中。后续消息会继续作为当前 goal 的补充指令处理。";
    case "complete":
      return "Codex goal 已完成。";
    case "paused":
      return "Codex goal 已暂停。后续可用 `/goal resume` 继续。";
    case "blocked":
      return "Codex goal 已受阻。";
    case "usageLimited":
      return "Codex goal 因使用量限制停止。";
    case "budgetLimited":
      return "Codex goal 因 token 预算限制停止。";
    default:
      return `Codex goal 当前状态：${goalStatusLabel(goal.status)}。`;
  }
}

function nativeGoalRunHeading(run) {
  const goal = normalizeGoal(run.goal || run.session.lastGoal);
  if (run.goalCleared || !goal) return "Codex goal 已清除";
  if (goal.status === "active") return "Codex goal 进行中";
  if (goal.status === "complete") return "Codex goal 已完成";
  if (goal.status === "paused") return "Codex goal 已暂停";
  if (goal.status === "blocked") return "Codex goal 受阻";
  if (goal.status === "usageLimited") return "Codex goal 使用量受限";
  if (goal.status === "budgetLimited") return "Codex goal 预算受限";
  return "Codex goal 状态";
}

function nativeGoalRunResultMarkdown(run) {
  const text = resultTextFromState(run.state) || nativeGoalRunFinalText(run);
  return [
    `**${nativeGoalRunHeading(run)}**`,
    "",
    run.goal ? goalMarkdown(run.session, run.goal).replace(/^.*?\n\n/s, "") : "当前 goal 已清除。",
    "",
    "---",
    text,
  ].join("\n");
}

function goalRunFinalText(run) {
  return nativeGoalRunFinalText(run);
}

function goalRunResultMarkdown(run) {
  return nativeGoalRunResultMarkdown(run);
}

async function openGoalRunCard(chatId, messageId, state) {
  if (!CONFIG.useCards) return null;
  return await ManagedCard.open(
    chatId,
    CONFIG.replyToMessage || CONFIG.useThreadReply ? messageId : "",
    renderRunCard(state),
    messageId,
  );
}

async function startGoalRun(chatId, event, session, goalPatch, options = {}) {
  const existing = await refreshGoalRunForNativeState(chatId, session, activeGoalRunForChat(chatId, session));
  if (existing) {
    const goal = await updateGoalRunGoal(existing, goalPatch);
    if (options.initialSteer) await queueGoalSteer(existing, options.initialSteer, { quiet: true });
    return { run: existing, goal, started: false };
  }

  const messageId = event.message_id || event.id || crypto.randomUUID();
  const userContent = userTextFromContent(event.content) || goalPatch.objective || session.lastGoal?.objective || "Codex goal";
  const state = createRunState(session, event, userContent);
  state.goalMode = true;
  setRunGoalState(state, previewGoalFromPatch(session, goalPatch));

  let card = null;
  let activeRunRecorded = false;
  let finalCardFlushOk = true;
  try {
    card = await openGoalRunCard(chatId, messageId, state);
    if (card) {
      recordActiveRun({
        chatId,
        messageId,
        sessionId: session.id,
        cardId: card.cardId,
        cardMessageId: card.messageId,
        startedAt: state.startedAt,
      });
      activeRunRecorded = true;
    }
  } catch (error) {
    log("WARN", "goal card open failed; falling back to markdown", {
      messageId,
      error: String(error.message || error).slice(0, 1200),
    });
  }

  if (!card) {
    await sendMarkdown(
      chatId,
      goalMarkdown(session, state.goal, "Codex goal 正在启动"),
      "goal-start",
      messageId,
    );
  }

  const run = {
    chatId,
    messageId,
    rootMessageId: messageId,
    sessionId: session.id,
    session,
    event,
    state,
    card,
    activeRunRecorded,
    finalCardFlushOk,
    client: null,
    threadId: "",
    currentTurnId: "",
    turnActive: false,
    goal: state.goal,
    goalCleared: false,
    detached: false,
    pendingSteers: options.initialSteer ? [options.initialSteer] : [],
    steeringInFlight: null,
    done: false,
    readySettled: false,
    readyResolve: null,
    readyReject: null,
  };
  run.ready = new Promise((resolve, reject) => {
    run.readyResolve = resolve;
    run.readyReject = reject;
  });
  run.updateCard = async () => {
    if (!run.card) return;
    if (run.activeRunRecorded && run.state.terminal === "running") touchActiveRun(run.messageId);
    const rendered = renderRunCard(run.state);
    if (run.state.terminal === "running") {
      run.card.update(rendered);
    } else {
      const ok = await run.card.flush(rendered);
      run.finalCardFlushOk = ok !== false;
      run.card.close();
    }
  };

  activeGoalRuns.set(chatId, run);
  run.promise = runGoalLoop(run, goalPatch).catch((error) => {
    log("ERROR", "goal runner failed unexpectedly", {
      chatId,
      messageId,
      error: String(error.stack || error).slice(0, 2000),
    });
  });

  await run.ready;
  return { run, goal: run.goal, started: true };
}

async function updateGoalRunGoal(run, goalPatch) {
  await run.ready.catch(() => {});
  if (!run.client || !run.threadId || run.done) throw new Error("当前 Codex goal runner 不可用。");
  let result = null;
  try {
    result = await run.client.request("thread/goal/set", { threadId: run.threadId, ...goalPatch }, 60_000);
  } catch (error) {
    if (!isNoGoalExistsError(error)) throw error;
    applyGoalRunNativeState(run, null);
    await run.updateCard?.();
    return null;
  }
  applyGoalRunNativeState(run, result?.goal || previewGoalFromPatch(run.session, goalPatch));
  run.state.footer = "thinking";
  await run.updateCard?.();
  return run.goal;
}

async function clearGoalRun(run) {
  await run.ready.catch(() => {});
  if (!run.client || !run.threadId || run.done) throw new Error("当前 Codex goal runner 不可用。");
  let result = null;
  try {
    result = await run.client.request("thread/goal/clear", { threadId: run.threadId }, 60_000);
  } catch (error) {
    if (!isNoGoalExistsError(error)) throw error;
  }
  applyGoalRunNativeState(run, null);
  run.state.footer = "thinking";
  await run.updateCard?.();
  return Boolean(result?.cleared);
}

async function queueGoalSteer(run, steer, { quiet = false } = {}) {
  run.pendingSteers.push(steer);
  if (!quiet) {
    await sendText(
      run.chatId,
      "已收到，作为当前 Codex goal 的补充指令处理。当前 goal 卡片会继续更新。",
      "goal-steer-ack",
      steer.messageId || steer.event?.message_id || run.messageId,
    );
  }
  await flushGoalSteers(run);
}

async function maybeRouteMessageToGoal(chatId, event, session, userContent, messageId) {
  if (CONFIG.runMode === "exec") return false;
  const steer = { event, userContent, messageId };
  const run = await refreshGoalRunForNativeState(chatId, session, activeGoalRunForChat(chatId, session));
  if (run) {
    const nativeGoal = await getGoalRunNativeState(run);
    if (nativeGoal?.status !== "active") return false;
    await queueGoalSteer(run, steer);
    return true;
  }

  const cachedGoal = normalizeGoal(session.lastGoal);
  if (!goalStatusIsActive(cachedGoal?.status)) return false;

  let goal = null;
  try {
    goal = await getAppServerGoal(session);
  } catch (error) {
    const failure = classifyCodexFailure(error);
    log("WARN", "goal state preflight failed; continuing as normal message", {
      chatId,
      messageId,
      sessionId: session.id,
      kind: failure.kind,
      detail: failure.detail.slice(0, 1000),
    });
    return false;
  }
  if (goal?.status !== "active") return false;
  const job = activeCodexJobs.get(chatId);
  if (job && job.mode !== "app-server-goal") return false;

  try {
    await startGoalRun(chatId, event, session, { status: "active" }, { initialSteer: steer });
  } catch (error) {
    if (!isNoGoalExistsError(error)) throw error;
    updateSessionGoal(session, null);
    return false;
  }
  return true;
}

async function flushGoalSteers(run) {
  if (run.steeringInFlight) return await run.steeringInFlight;
  if (!run.client || !run.threadId || run.done) return;
  run.steeringInFlight = (async () => {
    while (run.pendingSteers.length && !run.done && run.client && run.threadId) {
      const steer = run.pendingSteers.shift();
      const submitted = await submitGoalSteer(run, steer);
      if (submitted === false) {
        run.pendingSteers.unshift(steer);
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

async function submitGoalSteer(run, steer) {
  const event = steer.event;
  const userContent = steer.userContent ?? userTextFromContent(event.content);
  const messageId = steer.messageId || event.message_id || event.id || crypto.randomUUID();
  let submitted = false;

  if (run.turnActive && run.currentTurnId) {
    try {
      const result = await run.client.request(
        "turn/steer",
        appServerSteerParams(run.threadId, run.currentTurnId, event, userContent),
        60_000,
      );
      run.currentTurnId = result?.turnId || run.currentTurnId;
      submitted = true;
    } catch (error) {
      log("WARN", "goal turn steer failed; falling back to turn/start", {
        messageId,
        threadId: run.threadId,
        turnId: run.currentTurnId,
        error: String(error.message || error).slice(0, 1000),
      });
    }
  }

  if (!submitted) {
    try {
      const turn = await run.client.request(
        "turn/start",
        appServerTurnParams(run.threadId, event, userContent, run.session),
        60_000,
      );
      run.currentTurnId = turn?.turn?.id || run.currentTurnId;
      run.turnActive = Boolean(run.currentTurnId);
      submitted = true;
    } catch (error) {
      if (isNoGoalExistsError(error)) {
        applyGoalRunNativeState(run, null);
        await run.updateCard?.();
        return false;
      }
      if (!run.turnActive && isActiveTurnRaceError(error)) {
        log("INFO", "goal steer deferred until active turn notification", {
          messageId,
          threadId: run.threadId,
          error: String(error.message || error).slice(0, 500),
        });
        return false;
      }
      await sendMarkdown(
        run.chatId,
        [
          "**Codex goal 补充指令发送失败**",
          "",
          "```",
          truncateCardText(errorText(error), 1200),
          "```",
        ].join("\n"),
        "goal-steer-error",
        messageId,
      );
      return true;
    }
  }

  if (submitted) {
    run.state.goalSteerCount += 1;
    run.state.footer = "thinking";
    appendHistory(run.session, "user", userContent || `${event.attachments?.length || 0} attachment(s)`);
    await run.updateCard?.();
  }
  return true;
}

function isActiveTurnRaceError(error) {
  const text = errorText(error).toLowerCase();
  return text.includes("active turn")
    || text.includes("in-flight")
    || text.includes("in flight")
    || text.includes("not idle")
    || text.includes("already running")
    || text.includes("turn is active");
}

async function runGoalLoop(run, goalPatch) {
  const { chatId, messageId, session, state } = run;
  const startedAt = Date.now();
  const client = startAppServerClient({ cwd: CONFIG.workspace });
  run.client = client;
  const activeJob = {
    pid: client.child.pid,
    client,
    messageId,
    rootMessageId: run.rootMessageId,
    startedAt,
    sessionId: session.id,
    threadId: "",
    turnId: "",
    mode: "app-server-goal",
  };
  activeCodexJobs.set(chatId, activeJob);

  const watchdog = createRunWatchdog("codex app-server goal", () => {
    void client.stop();
    setTimeout(() => terminateProcessTree(client.child?.pid, true), 5000).unref?.();
  });

  try {
    const initialized = await initializeAppServerClient(client);
    watchdog.touch();
    state.meta.model = initialized.userAgent || state.meta.model;

    const threadId = await startOrResumeAppServerThread(client, session);
    watchdog.touch();
    run.threadId = threadId;
    state.threadId = threadId;
    activeJob.threadId = threadId;

    const result = await client.request("thread/goal/set", { threadId, ...goalPatch }, 60_000);
    watchdog.touch();
    applyGoalRunNativeState(run, result?.goal || previewGoalFromPatch(session, goalPatch));
    log("INFO", "codex goal native state set", {
      chatId,
      messageId,
      threadId,
      status: run.goal?.status || "",
      objectiveLength: String(run.goal?.objective || "").length,
    });
    settleGoalRunReady(run);
    await run.updateCard?.();
    await flushGoalSteers(run);

    while (!watchdog.timedOut) {
      if (stoppedJobs.has(messageId) || stoppedJobs.has(run.rootMessageId)) {
        throw new Error("codex job stopped by user");
      }

      const message = await client.nextNotification(1000);
      if (!message) {
        if (client.closed) {
          if (goalStatusIsActive(normalizeGoal(run.goal || session.lastGoal)?.status)) {
            run.detached = true;
            log("INFO", "codex goal runner detached while native goal remains active", {
              chatId,
              messageId,
              threadId,
              status: normalizeGoal(run.goal || session.lastGoal)?.status || "",
            });
          }
          break;
        }
        await flushGoalSteers(run);
        if (goalRunTerminal(run) && !run.turnActive) break;
        continue;
      }

      watchdog.touch();
      const params = message.params || {};
      if (message.method === "turn/started") {
        run.currentTurnId = params.turn?.id || params.turnId || run.currentTurnId;
        run.turnActive = Boolean(run.currentTurnId);
        activeJob.turnId = run.currentTurnId;
      }

      let stateChanged = false;
      if (message.method === "thread/goal/updated") {
        applyGoalRunNativeState(run, params.goal || null);
        stateChanged = true;
      } else if (message.method === "thread/goal/cleared") {
        applyGoalRunNativeState(run, null);
        stateChanged = true;
      } else if (message.method === "turn/completed") {
        const completedTurnId = params.turn?.id || params.turnId || "";
        if (!completedTurnId || !run.currentTurnId || completedTurnId === run.currentTurnId) {
          run.turnActive = false;
          run.currentTurnId = "";
          activeJob.turnId = "";
        }
      } else if (message.method === "error") {
        const failure = classifyCodexFailure(params, "codex app-server goal error");
        if (failure.recoverable && params.willRetry === true) continue;
        throw errorFromFailure(failure);
      }

      if (reduceAppServerEvent(state, message)) stateChanged = true;
      if (stateChanged) await run.updateCard?.();

      await flushGoalSteers(run);
      if (goalRunTerminal(run) && !run.turnActive) break;
    }

    if (watchdog.timedOut) throw new Error(watchdog.reason || "codex app-server goal timed out");
    if (stoppedJobs.has(messageId) || stoppedJobs.has(run.rootMessageId)) {
      throw new Error("codex job stopped by user");
    }

    if (!client.closed) await getGoalRunNativeState(run);

    const finalText = resultTextFromState(state) || goalRunFinalText(run);
    ensureRunDone(state, finalText);
    state.meta.durationMs = Date.now() - startedAt;
    await run.updateCard?.();
    if (!run.card || !run.finalCardFlushOk) {
      await sendMarkdown(chatId, goalRunResultMarkdown(run), "goal-done", messageId);
    }
    appendHistory(session, "user", `/goal ${goalPatch.objective || run.goal?.objective || ""}`.trim());
    appendHistory(session, "assistant", finalText);
    stats.answered += 1;
  } catch (error) {
    settleGoalRunReady(run, error);
    if (stoppedJobs.has(messageId) || stoppedJobs.has(run.rootMessageId)) {
      markRunInterrupted(state);
      await run.updateCard?.();
      log("INFO", "codex goal stopped by user", { messageId, chatId });
    } else {
      stats.failed += 1;
      const failure = classifyCodexFailure(error);
      recordFailureStats(failure);
      markRunError(state, error);
      await run.updateCard?.();
      if (!run.card || !run.finalCardFlushOk) {
        await sendMarkdown(
          chatId,
          [
            "**Codex goal 运行失败**",
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
  } finally {
    watchdog.clear();
    run.done = true;
    const job = activeCodexJobs.get(chatId);
    if (job?.pid === client.child?.pid) activeCodexJobs.delete(chatId);
    const currentRun = activeGoalRuns.get(chatId);
    if (currentRun === run) activeGoalRuns.delete(chatId);
    if (run.activeRunRecorded) clearActiveRun(messageId);
    await client.stop();
  }
}

async function withConfigClient(fn) {
  const client = startAppServerClient({ cwd: CONFIG.workspace });
  try {
    await initializeAppServerClient(client);
    return await fn(client);
  } finally {
    await client.stop();
  }
}

async function writeCodexConfigValue(keyPath, value) {
  return writeTopLevelCodexConfigValue(keyPath, value);
}

async function listCodexModels() {
  return await withConfigClient(async (client) => {
    const result = await client.request("model/list", { includeHidden: false, limit: 50 }, 60_000);
    return Array.isArray(result?.data) ? result.data : [];
  });
}

async function listCurrentProviderModels(session) {
  const settings = effectiveSessionSettings(session);
  const provider = findCodexProvider(settings.provider);
  if (!provider) {
    throw new Error(`当前 provider 未在 config.toml 中找到：${settings.provider || "默认"}`);
  }
  const url = providerModelsUrl(provider);
  if (!url) {
    if (provider.builtIn || provider.requiresOpenaiAuth) {
      return {
        source: "codex",
        provider,
        settings,
        models: await listCodexModels(),
      };
    }
    throw new Error(`provider ${provider.id} 未配置 base_url，无法查询 /models。`);
  }
  if (provider.envKey && !process.env[provider.envKey]) {
    throw new Error(`当前 Bridge 进程看不到环境变量 ${provider.envKey}；设置后需要重启对应 Bridge。`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_MODEL_LIST_TIMEOUT_MS);
  try {
    const headers = { Accept: "application/json" };
    if (provider.envKey) headers.Authorization = `Bearer ${process.env[provider.envKey]}`;
    const response = await fetch(url, { method: "GET", headers, signal: controller.signal });
    const bodyText = await response.text();
    let body = null;
    if (bodyText.trim()) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        throw new Error(`provider ${provider.id} /models 返回的不是 JSON：${bodyText.slice(0, 300)}`);
      }
    }
    if (!response.ok) {
      const message = body?.error?.message || body?.message || bodyText.slice(0, 300) || response.statusText;
      throw new Error(`provider ${provider.id} /models 失败：HTTP ${response.status} ${message}`);
    }
    return {
      source: "provider",
      provider,
      settings,
      url,
      models: normalizeProviderModels(body),
      rawCount: Array.isArray(body?.data) ? body.data.length : 0,
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`provider ${provider.id} /models 查询超时（${Math.round(PROVIDER_MODEL_LIST_TIMEOUT_MS / 1000)} 秒）。`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeProviderModels(body) {
  const data = Array.isArray(body?.data) ? body.data : [];
  const models = [];
  const seen = new Set();
  for (const item of data) {
    const id = String(
      typeof item === "string"
        ? item
        : item?.id || item?.model || item?.name || "",
    ).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      displayName: String(item?.displayName || item?.display_name || item?.name || id).trim(),
      ownedBy: String(item?.owned_by || item?.ownedBy || "").trim(),
      object: String(item?.object || "").trim(),
    });
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

async function testCurrentProviderModel(session, modelId) {
  const model = cleanOverride(modelId);
  if (!model) throw new Error("缺少模型 ID。用法：/model test <模型ID>");
  const settings = effectiveSessionSettings(session);
  const provider = findCodexProvider(settings.provider);
  if (!provider) {
    throw new Error(`当前 provider 未在 config.toml 中找到：${settings.provider || "默认"}`);
  }
  const url = providerResponsesUrl(provider);
  if (!url) {
    throw new Error(`provider ${provider.id} 未配置 base_url，无法测试 /responses。`);
  }
  if (provider.envKey && !process.env[provider.envKey]) {
    throw new Error(`当前 Bridge 进程看不到环境变量 ${provider.envKey}；设置后需要重启对应 Bridge。`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_MODEL_TEST_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (provider.envKey) headers.Authorization = `Bearer ${process.env[provider.envKey]}`;
    const response = await fetch(url, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model,
        input: "Reply with OK.",
        max_output_tokens: 8,
      }),
    });
    const bodyText = await response.text();
    let body = null;
    if (bodyText.trim()) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = null;
      }
    }
    if (!response.ok) {
      const message = body?.error?.message || body?.message || bodyText.slice(0, 500) || response.statusText;
      throw new Error(`HTTP ${response.status} ${message}`);
    }
    return {
      provider,
      settings,
      model,
      url,
      elapsedMs: Date.now() - startedAt,
      responseId: String(body?.id || "").trim(),
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`provider ${provider.id} /responses 测试超时（${Math.round(PROVIDER_MODEL_TEST_TIMEOUT_MS / 1000)} 秒）。`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function startOrResumeAppServerThread(client, session, options = {}) {
  if (session.codexThreadId) {
    const previousThreadId = session.codexThreadId;
    const resumeInfo = await loadCodexThreadResumeInfo(previousThreadId);
    if (!resumeInfo.resumeable) {
      markSessionResumeFailure(session, resumeInfo);
      session.codexThreadId = "";
      session.updatedAt = Date.now();
      saveSessions();
      log("WARN", "app-server thread binding is not resumable; starting new thread", {
        sessionId: session.id,
        threadId: previousThreadId,
        reason: resumeInfo.reason,
        hasDb: resumeInfo.hasDb,
        hasRollout: resumeInfo.hasRollout,
        rolloutPath: resumeInfo.rolloutPath || "",
      });
    }
  }

  if (session.codexThreadId) {
    const previousThreadId = session.codexThreadId;
    try {
      const resumed = await client.request("thread/resume", appServerResumeParams(session, options), 60_000);
      await verifyAppServerThreadRegistration(resumed.thread.id);
      await ensureAppServerThreadVisible(resumed.thread.id, "thread/resume");
      return resumed.thread.id;
    } catch (error) {
      const failure = classifyCodexFailure(error);
      if (failure.kind === "cloud_config") {
        log("WARN", "app-server thread resume failed; keeping existing thread binding", {
          sessionId: session.id,
          threadId: previousThreadId,
          kind: failure.kind,
          error: String(error.message || error).slice(0, 1000),
        });
        throw errorFromFailure(failure);
      }
      log("WARN", "app-server thread resume failed; trying new thread without clearing old binding", {
        sessionId: session.id,
        threadId: previousThreadId,
        kind: failure.kind,
        error: String(error.message || error).slice(0, 1000),
      });
    }
  }

  const params = appServerStartParams(session, options);
  const started = await client.request("thread/start", params, 60_000);
  session.codexThreadId = started.thread.id;
  session.updatedAt = Date.now();
  saveSessions();
  await verifyAppServerThreadRegistration(started.thread.id);
  await ensureAppServerThreadVisible(started.thread.id, "thread/start");
  return started.thread.id;
}

async function runCodexAppServer(event, session, state = null, onState = null, options = {}) {
  const chatId = event.chat_id;
  const messageId = event.message_id || event.id || crypto.randomUUID();
  const startedAt = Date.now();
  const recoveryAttempt = Number(options.recoveryAttempt || 0);
  const userContent = userTextFromContent(event.content);
  const liveState = state || createRunState(session, event, userContent);
  const client = startAppServerClient({ cwd: CONFIG.workspace });
  const activeJob = {
    pid: client.child.pid,
    client,
    messageId,
    rootMessageId: options.rootMessageId || messageId,
    startedAt,
    sessionId: session.id,
    threadId: "",
    turnId: "",
    mode: "app-server",
  };
  activeCodexJobs.set(chatId, activeJob);

  const flushState = async () => {
    if (state && onState) await onState(state);
  };

  const watchdog = createRunWatchdog("codex app-server", () => {
    void client.stop();
    setTimeout(() => terminateProcessTree(client.child?.pid, true), 5000).unref?.();
  });
  let serviceTierPlan = null;

  try {
    const settings = assertReasoningSupported(effectiveSessionSettings(session));
    serviceTierPlan = serviceTierPlanForTurnSettings(settings, options);
    const serviceTier = serviceTierPlan.serviceTier;
    log("INFO", "starting codex app-server turn", {
      messageId,
      sessionId: session.id,
      existingThreadId: session.codexThreadId || "",
      model: settings.model || "",
      provider: settings.provider || "",
      reasoning: settings.reasoning || "",
      serviceTier,
      requestedServiceTier: settings.serviceTier || "",
      serviceTierPolicy: serviceTierPlan.policy,
      serviceTierAutoFallback: Boolean(serviceTierPlan.autoFallback),
      timeoutMs: CONFIG.codexTimeoutMs,
      idleTimeoutMs: CONFIG.codexIdleTimeoutMs,
      disableMcp: CONFIG.disableMcp,
    });

    const initialized = await initializeAppServerClient(client);
    watchdog.touch();
    markRunPhase(liveState, "initializing", { connection: "connected" });
    liveState.meta.model = initialized.userAgent || liveState.meta.model;

    const threadId = await startOrResumeAppServerThread(client, session, options);
    watchdog.touch();
    liveState.threadId = threadId;
    activeJob.threadId = threadId;
    if (state) {
      await flushState();
    }

    const turn = await client.request("turn/start", appServerTurnParams(threadId, event, userContent, session, options), 60_000);
    watchdog.touch();
    markModelEvent(liveState, "model_thinking");
    const turnId = turn?.turn?.id || "";
    activeJob.turnId = turnId;

    let completed = false;
    let lastWaitingUpdateAt = Date.now();
    while (!completed && !watchdog.timedOut) {
      const message = await client.nextNotification(1000);
      if (!message) {
        if (client.closed) break;
        if (
          state
          && Date.now() - lastWaitingUpdateAt > 60_000
        ) {
          liveState.footer = "waiting";
          liveState.meta.durationMs = Date.now() - startedAt;
          lastWaitingUpdateAt = Date.now();
          await flushState();
        }
        continue;
      }
      watchdog.touch();
      if (reduceAppServerEvent(liveState, message)) await flushState();
      if (message.method === "turn/completed" && (!turnId || message.params?.turn?.id === turnId)) {
        completed = true;
      }
      if (message.method === "error") {
        const failure = classifyCodexFailure(message.params, "codex app-server error");
        if (failure.recoverable && message.params?.willRetry === true) {
          log("WARN", "codex app-server transient error; waiting for native retry", {
            messageId,
            sessionId: session.id,
            kind: failure.kind,
            detail: failure.detail.slice(0, 1000),
          });
          continue;
        }
        throw errorFromFailure(failure);
      }
    }

    if (watchdog.timedOut) throw new Error(watchdog.reason || "codex app-server timed out");
    if (!completed) {
      const error = new Error(`codex app-server ended before turn completed: ${client.stderrText().slice(-2000)}`);
      if (liveState.failure?.recoverable) error.codexFailure = liveState.failure;
      throw error;
    }
    if (stoppedJobs.has(messageId) || stoppedJobs.has(activeJob.rootMessageId)) {
      throw new Error("codex job stopped by user");
    }

    const durationMs = Date.now() - startedAt;
    const finalText = resultTextFromState(liveState);
    if (!finalText) {
      const context = {
        messageId,
        sessionId: session.id,
        threadId,
        turnId,
        durationMs,
        tokens: tokenStringFromState(liveState),
      };
      log("WARN", "codex app-server completed without assistant output", context);
      throw emptyCompletionError(context);
    }
    ensureRunDone(liveState, finalText);
    liveState.meta.durationMs = durationMs;
    await ensureAppServerThreadVisible(threadId, "turn/completed");
    if (state) {
      await flushState();
    }
    return {
      text: finalText || resultTextFromState(liveState) || "(Codex 没有返回内容)",
      durationMs,
      tokens: tokenStringFromState(liveState),
      mode: "app-server",
      threadId,
    };
  } catch (error) {
    if (stoppedJobs.has(messageId) || stoppedJobs.has(activeJob.rootMessageId)) {
      markRunInterrupted(liveState);
    } else {
      const failure = classifyCodexFailure(error);
      if (failure.kind === "empty_completion") {
        liveState.terminal = "running";
        liveState.footer = "thinking";
        liveState.failure = failure;
        liveState.errorMsg = failureDetailText(failure).slice(0, 1500);
        updateSessionFailure(liveState.session, failure);
      } else if (shouldRetryWithoutServiceTier(failure, serviceTierPlan, options)) {
        const fallbackFailure = serviceTierFallbackFailure(failure, serviceTierPlan);
        markRunRecovering(liveState, fallbackFailure, 1);
        if (state) await flushState();
        log("WARN", "retrying codex app-server turn without service_tier", {
          messageId,
          sessionId: session.id,
          provider: effectiveSessionSettings(session).provider || "",
          requestedServiceTier: serviceTierPlan?.requestedServiceTier || "",
          serviceTierPolicy: serviceTierPlan?.policy || "",
          kind: failure.kind,
          detail: failure.detail.slice(0, 1000),
        });
        await client.stop();
        return await runCodexAppServer(event, session, liveState, onState, {
          ...options,
          disableServiceTier: true,
          serviceTierFallbackAttempt: true,
          rootMessageId: activeJob.rootMessageId,
        });
      } else if (shouldRecoverCodexRun(failure, recoveryAttempt)) {
        stats.recovered += 1;
        markRunRecovering(liveState, failure, recoveryAttempt + 1);
        if (state) await flushState();
        log("WARN", "attempting codex stream recovery", {
          messageId,
          sessionId: session.id,
          attempt: recoveryAttempt + 1,
          kind: failure.kind,
          detail: failure.detail.slice(0, 1000),
        });
        const recoveryEvent = recoveryEventFromFailure(event, liveState, failure, recoveryAttempt + 1);
        return await runCodexAppServer(recoveryEvent, session, liveState, onState, {
          recoveryAttempt: recoveryAttempt + 1,
          rootMessageId: activeJob.rootMessageId,
        });
      }
      markRunError(liveState, error);
    }
    if (state) {
      await flushState();
    }
    throw error;
  } finally {
    watchdog.clear();
    const job = activeCodexJobs.get(chatId);
    if (job?.pid === client.child?.pid) activeCodexJobs.delete(chatId);
    await client.stop();
  }
}

async function runCodex(event, session, state = null, onState = null) {
  if (CONFIG.runMode === "app-server" || CONFIG.runMode === "auto") {
    try {
      return await runCodexAppServer(event, session, state, onState);
    } catch (error) {
      const failure = classifyCodexFailure(error);
      const canFallback = CONFIG.runMode === "auto" || failure.kind === "empty_completion";
      if (!canFallback) throw error;
      if (["auth", "quota", "rate_limit", "user_stop"].includes(failure.kind)) throw error;
      if (failure.kind === "empty_completion" && session.codexThreadId) {
        log("WARN", "clearing codex app-server thread after empty completion", {
          messageId: event.message_id || event.id,
          sessionId: session.id,
          threadId: session.codexThreadId,
        });
        session.codexThreadId = "";
        session.updatedAt = Date.now();
        saveSessions();
      }
      log("WARN", "app-server mode failed; falling back to codex exec", {
        messageId: event.message_id || event.id,
        sessionId: session.id,
        kind: failure.kind,
        error: String(error.message || error).slice(0, 1500),
      });
      if (state?.terminal === "running") {
        state.blocks.push({
          kind: "tool",
          tool: {
            id: crypto.randomUUID(),
            name: "app_server_fallback",
            input: "codex app-server",
            output: String(error.message || error).slice(0, 1200),
            status: "error",
          },
        });
        state.footer = "thinking";
        await onState?.(state);
      }
    }
  }

  const chatId = event.chat_id;
  const messageId = event.message_id || event.id || crypto.randomUUID();
  const outFile = path.join(outputDir, `${Date.now()}-${safeFilePart(messageId)}.txt`);
  const promptFile = path.join(promptDir, `${Date.now()}-${safeFilePart(messageId)}.md`);
  fs.writeFileSync(promptFile, buildPrompt(event, session), "utf8");
  const settings = assertReasoningSupported(effectiveSessionSettings(session));
  const serviceTierPlan = serviceTierPlanForExecSettings(settings);
  const serviceTier = serviceTierPlan.serviceTier;

  const args = [
    "exec",
    "-C",
    CONFIG.workspace,
    "--skip-git-repo-check",
    "--sandbox",
    CONFIG.codexSandbox,
    "-c",
    "approval_policy=\"never\"",
    "--json",
    "--output-last-message",
    outFile,
  ];
  if (settings.model) args.push("-m", settings.model);
  if (settings.provider) args.push("-c", `model_provider="${settings.provider}"`);
  if (settings.reasoning) args.push("-c", `model_reasoning_effort="${settings.reasoning}"`);
  if (serviceTier) args.push("-c", `service_tier="${serviceTier}"`);
  for (const attachment of Array.isArray(event.attachments) ? event.attachments : []) {
    if (attachment?.type === "image" && attachment.path && fs.existsSync(attachment.path)) {
      args.push("--image", attachment.path);
    }
  }
  if (CONFIG.disableMcp) args.push("-c", "mcp_servers={}");
  args.push("--");
  args.push(`读取这个 UTF-8 任务文件，并完成用户任务。任务文件：${promptFile}`);

  const startedAt = Date.now();
  log("INFO", "starting codex", {
    messageId,
    sessionId: session.id,
    promptFile,
    outFile,
    model: settings.model || "",
    provider: settings.provider || "",
    reasoning: settings.reasoning || "",
    serviceTier,
    requestedServiceTier: settings.serviceTier || "",
    serviceTierPolicy: serviceTierPlan.policy,
    serviceTierAutoFallback: Boolean(serviceTierPlan.autoFallback),
    timeoutMs: CONFIG.codexTimeoutMs,
    idleTimeoutMs: CONFIG.codexIdleTimeoutMs,
    disableMcp: CONFIG.disableMcp,
  });

  const finalArgs = [...CONFIG.codexCli.argsPrefix, ...args];
  const child = spawn(CONFIG.codexCli.command, finalArgs, {
    cwd: CONFIG.workspace,
    env: {
      ...process.env,
      CODEX_FEISHU_BRIDGE: "1",
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  activeChildren.set(child.pid, { child, label: `${CONFIG.codexCli.command} ${finalArgs.join(" ")}` });
  activeCodexJobs.set(chatId, {
    pid: child.pid,
    messageId,
    startedAt,
    sessionId: session.id,
  });

  let timedOut = false;
  let timeoutReason = "";
  let stdoutRaw = "";
  const stderrChunks = [];
  const watchdog = createRunWatchdog("codex exec", (reason) => {
    timedOut = true;
    timeoutReason = reason;
    terminateProcessTree(child.pid, false);
    setTimeout(() => terminateProcessTree(child.pid, true), 5000).unref?.();
  });

  child.stderr.on("data", (chunk) => {
    watchdog.touch();
    stderrChunks.push(chunk);
  });

  const flushState = async () => {
    if (state && onState) await onState(state);
  };

  if (state) {
    markRunPhase(state, "model_thinking", { connection: "connected" });
    await flushState();
  }

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const streamPromise = (async () => {
    for await (const line of rl) {
      watchdog.touch();
      stdoutRaw += `${line}\n`;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (state && reduceCodexJsonEvent(state, parsed)) {
        await flushState();
      }
    }
  })();

  const closePromise = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });

  let closeResult;
  try {
    closeResult = await closePromise;
    await streamPromise.catch(() => {});
  } finally {
    watchdog.clear();
    rl.close();
    activeChildren.delete(child.pid);
    const job = activeCodexJobs.get(chatId);
    if (job?.pid === child.pid) activeCodexJobs.delete(chatId);
  }

  let finalText = "";
  try {
    finalText = fs.readFileSync(outFile, "utf8").trim();
  } catch {
    finalText = "";
  }

  if (timedOut) {
    if (state) {
      markRunError(state, timeoutReason || "codex exec timed out");
      await flushState();
    }
    throw new Error(timeoutReason || "codex exec timed out");
  }
  if (closeResult.code !== 0) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    const tail = (stderr || stdoutRaw || "").slice(-3000);
    if (state) {
      if (stoppedJobs.has(messageId)) {
        markRunInterrupted(state);
      } else {
        markRunError(state, `codex exec failed (${closeResult.code}): ${tail}`);
      }
      await flushState();
    }
    throw new Error(`codex exec failed (${closeResult.code}): ${tail}`);
  }

  const durationMs = Date.now() - startedAt;
  const tokens = state?.meta?.inputTokens !== undefined || state?.meta?.outputTokens !== undefined
    ? `${state.meta.inputTokens || 0}↑ ${state.meta.outputTokens || 0}↓`
    : parseTokens(stdoutRaw);
  if (state) {
    ensureRunDone(state, finalText);
    state.meta.durationMs = durationMs;
    await flushState();
  }
  await syncCodexSidebarThread({ event, session, promptFile, outFile, stdoutRaw });
  return {
    text: finalText || extractFinalTextFromJsonl(stdoutRaw) || "(Codex 没有返回内容)",
    durationMs,
    tokens,
  };
}

function extractFinalTextFromJsonl(stdout) {
  let text = "";
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.type === "item.completed" && parsed.item?.type === "agent_message" && typeof parsed.item.text === "string") {
        text = parsed.item.text;
      }
    } catch {}
  }
  return text.trim();
}

function parseTokens(stdout) {
  const match = String(stdout || "").match(/tokens used\s*\n?\s*([0-9,]+)/i);
  return match ? match[1] : "";
}

function safeFilePart(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
}

function removePendingEventsByMessageId(messageId) {
  return eventDispatcher.removeByMessageId(messageId);
}

function clearPendingEventsForChat(chatId, { all = false } = {}) {
  return eventDispatcher.clearForChat(chatId, { all });
}

function pendingEventsForChat(chatId) {
  return eventDispatcher.countForChat(chatId);
}

function queueSummary(chatId) {
  return eventDispatcher.summary(chatId);
}

function handleRecallEvent(rawEvent) {
  const messageId = messageIdOf(rawEvent);
  const chatId = chatIdOf(rawEvent);
  const eventId = eventIdOf(rawEvent);
  if (!messageId) {
    log("WARN", "recall event missing message_id", rawEvent);
    return;
  }
  if (eventId && rememberEvent(eventId, messageId)) {
    log("INFO", "duplicate recall event ignored", { eventId, messageId });
    return;
  }
  rememberRecalledMessage(messageId, { chatId, eventId, reason: "recall_event" });
  const removedEvents = removePendingEventsByMessageId(messageId);
  const removedAttachments = dropPendingAttachmentsForMessage(messageId, chatId);
  log("INFO", "message recall handled", {
    eventId,
    messageId,
    chatId,
    removedEvents,
    removedAttachments,
  });
}

function isOutOfBandCommand(command) {
  return Boolean(command?.name);
}

async function handleOutOfBandCommand(rawEvent, command) {
  const messageId = messageIdOf(rawEvent);
  const dedupeId = eventIdOf(rawEvent) || messageId;
  if (!messageId) {
    log("WARN", "out-of-band command missing message_id", rawEvent);
    return;
  }
  if (rememberEvent(dedupeId, messageId)) {
    log("INFO", "duplicate out-of-band command ignored", { dedupeId, messageId });
    return;
  }

  let event = rawEvent;
  if (!event.chat_id) event = await enrichEvent(rawEvent);
  const chatId = event.chat_id;
  if (!chatId) {
    log("WARN", "out-of-band command missing chat_id", event);
    return;
  }

  stats.events += 1;
  stats.commands += 1;
  log("INFO", "out-of-band command received", {
    eventId: event.event_id,
    messageId,
    chatId,
    chatType: event.chat_type,
    senderId: event.sender_id,
    messageType: event.message_type,
    command: command.name,
    commandText: String(command.text || "").slice(0, 200),
    contentPreview: userTextFromContent(event.content).slice(0, 200),
  });
  await handleCommand(event, command);
}

async function handleEvent(rawEvent, dispatchControl = {}) {
  const messageId = messageIdOf(rawEvent);
  const dedupeId = eventIdOf(rawEvent) || messageId;
  if (!messageId) {
    log("WARN", "event missing message_id", rawEvent);
    return;
  }
  if (isMessageRecalled(messageId)) {
    log("INFO", "recalled message skipped before handling", { messageId, eventId: eventIdOf(rawEvent) });
    return;
  }
  if (rememberEvent(dedupeId, messageId)) {
    log("INFO", "duplicate event ignored", { dedupeId, messageId });
    return;
  }

  const event = await enrichEvent(rawEvent);
  if (event?.recalled || isMessageRecalled(messageId)) {
    rememberRecalledMessage(messageId, { chatId: chatIdOf(event), eventId: eventIdOf(event), reason: event?.recallReason || "preflight" });
    dropPendingAttachmentsForMessage(messageId, chatIdOf(event));
    log("INFO", "recalled message skipped after preflight", { messageId, reason: event?.recallReason || "" });
    return;
  }
  if (dispatchControl.isCancelled?.()) {
    log("INFO", "queued message cleared during preflight", { messageId, chatId: chatIdOf(event) });
    return;
  }
  const chatId = event.chat_id;
  if (!chatId) {
    log("WARN", "event missing chat_id", event);
    return;
  }

  const userContent = userTextFromContent(event.content);
  const command = parseCommand(event.content);
  if (command) {
    if (dispatchControl.commit && !dispatchControl.commit()) {
      log("INFO", "queued command cleared during preflight", { messageId, chatId, command: command.name });
      return;
    }
    stats.events += 1;
    log("INFO", "message received", {
      eventId: event.event_id,
      messageId,
      chatId,
      chatType: event.chat_type,
      senderId: event.sender_id,
      contentPreview: userContent.slice(0, 120),
    });
    stats.commands += 1;
    await handleCommand(event, command);
    return;
  }

  const downloadedAttachments = [
    ...(await downloadImageAttachments(event)),
    ...(await downloadFileAttachments(event)),
  ];
  if (dispatchControl.commit && !dispatchControl.commit()) {
    cleanupClearedDownloads(downloadedAttachments);
    log("INFO", "queued message cleared before execution", { messageId, chatId });
    return;
  }

  stats.events += 1;
  log("INFO", "message received", {
    eventId: event.event_id,
    messageId,
    chatId,
    chatType: event.chat_type,
    senderId: event.sender_id,
    contentPreview: userContent.slice(0, 120),
  });

  if (event.message_type === "image" && !userContent) {
    const imageAttachments = downloadedAttachments.filter((item) => item?.type === "image");
    if (!imageAttachments.length) {
      await sendText(chatId, "收到图片消息，但图片下载失败；我还拿不到图片本体。", "image-download-failed", messageId);
      return;
    }
    addPendingAttachments(chatId, downloadedAttachments);
    const total = cleanupPendingAttachments(chatId);
    await sendText(chatId, `已收到 ${formatAttachmentCounts(total)}，请继续发送文字消息来触发处理。`, "attachment-received", messageId);
    return;
  }

  if (event.message_type === "file" && !userContent) {
    const fileAttachments = downloadedAttachments.filter((item) => item?.type === "file");
    if (!fileAttachments.length) {
      await sendText(
        chatId,
        `收到文件消息，但文件下载失败或超过 ${formatBytes(CONFIG.maxFileAttachmentBytes)} 限制；我还拿不到文件本体。`,
        "file-download-failed",
        messageId,
      );
      return;
    }
    addPendingAttachments(chatId, downloadedAttachments);
    const total = cleanupPendingAttachments(chatId);
    await sendText(chatId, `已收到 ${formatAttachmentCounts(total)}，请继续发送文字消息来触发处理。`, "attachment-received", messageId);
    return;
  }

  if (downloadedAttachments.length && !userContent) {
    addPendingAttachments(chatId, downloadedAttachments);
    const total = cleanupPendingAttachments(chatId);
    await sendText(chatId, `已收到 ${formatAttachmentCounts(total)}，请继续发送文字消息来触发处理。`, "attachment-received", messageId);
    return;
  }

  const pendingAttachments = takePendingAttachments(chatId);
  event.attachments = [...pendingAttachments, ...downloadedAttachments];

  if (event.message_type && event.message_type !== "text" && event.message_type !== "post" && !event.attachments.length) {
    await sendText(chatId, `我收到了 ${event.message_type} 消息，但当前桥接版本还不能处理这种类型。`, "unsupported", messageId);
    return;
  }

  await syncChatSessionsWithCodex(chatId);
  const session = getSession(chatId);
  if (await maybeRouteMessageToGoal(chatId, event, session, userContent, messageId)) {
    return;
  }
  const cardState = createRunState(session, event, userContent);
  let card = null;
  let activeRunRecorded = false;
  if (CONFIG.useCards) {
    try {
      card = await ManagedCard.open(
        chatId,
        CONFIG.replyToMessage || CONFIG.useThreadReply ? messageId : "",
        renderRunCard(cardState),
        messageId,
      );
      log("INFO", "card opened", { messageId, cardId: card.cardId, cardMessageId: card.messageId });
      recordActiveRun({
        chatId,
        messageId,
        sessionId: session.id,
        cardId: card.cardId,
        cardMessageId: card.messageId,
        startedAt: cardState.startedAt,
      });
      activeRunRecorded = true;
    } catch (error) {
      log("WARN", "card open failed; falling back to markdown", {
        messageId,
        error: String(error.message || error).slice(0, 1200),
      });
    }
  }

  if (false && !card) {
    await sendMarkdown(
      chatId,
      [
        "**Codex 正在处理**",
        "",
        `会话：${session.title} (${session.id})`,
        `工作区：${CONFIG.workspace}`,
        `设置：${settingsSummary(session)}`,
      ].join("\n"),
      "ack",
      messageId,
    );
  }

  let finalCardFlushOk = true;
  const updateCard = async (state) => {
    if (!card) return;
    if (activeRunRecorded && state.terminal === "running") touchActiveRun(messageId);
    const rendered = renderRunCard(state);
    if (state.terminal === "running") {
      card.update(rendered);
    } else {
      const ok = await card.flush(rendered);
      finalCardFlushOk = ok !== false;
      card.close();
    }
  };

  try {
    const result = await runCodex(event, session, card ? cardState : null, updateCard);
    appendHistory(session, "user", userContent || `${event.attachments?.length || 0} attachment(s)`);
    appendHistory(session, "assistant", result.text);
    stats.answered += 1;
    if (!card || !finalCardFlushOk) {
      await sendMarkdown(
        chatId,
        formatAnswer(result, session),
        "answer",
        messageId,
      );
    }
    log("INFO", "message answered", { messageId, sessionId: session.id, durationMs: result.durationMs });
  } catch (error) {
    if (stoppedJobs.has(messageId)) {
      stoppedJobs.delete(messageId);
      if (card) {
        markRunInterrupted(cardState);
        await updateCard(cardState);
      }
      log("INFO", "codex job stopped by user", { messageId, chatId });
      return;
    }
    stats.failed += 1;
    const failure = classifyCodexFailure(error);
    recordFailureStats(failure);
    if (card) {
      markRunError(cardState, error);
      await updateCard(cardState);
      if (!finalCardFlushOk) {
        await sendMarkdown(
          chatId,
          [
            "**Codex 处理失败**",
            "",
            "动态卡片最终刷新失败，以下是错误兜底：",
            "",
            failureShortText(failure),
            "",
            "```",
            truncateCardText(errorText(error), 1500),
            "```",
          ].join("\n"),
          "error-fallback",
          messageId,
        );
      }
    } else {
      await sendMarkdown(
        chatId,
        [
          "**Codex 处理失败**",
          "",
          failureShortText(failure),
          "",
          "```",
          truncateCardText(errorText(error), 1500),
          "```",
        ].join("\n"),
        "error",
        messageId,
      );
    }
    throw error;
  } finally {
    if (activeRunRecorded) clearActiveRun(messageId);
  }
}

function cleanupClearedDownloads(attachments) {
  const root = path.resolve(attachmentDir);
  for (const attachment of attachments || []) {
    if (!attachment?.path) continue;
    const resolved = path.resolve(attachment.path);
    const relative = path.relative(root, resolved);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    try {
      fs.rmSync(resolved, { force: true });
    } catch (error) {
      log("WARN", "cleared message attachment cleanup failed", {
        messageId: attachment.messageId,
        path: resolved,
        error: String(error?.message || error).slice(0, 1000),
      });
    }
  }
}

async function handleCommand(event, command) {
  const chatId = event.chat_id;
  const messageId = event.message_id || event.id || chatId;
  log("INFO", "command received", { messageId, chatId, command: command.name });

  switch (command.name) {
    case "/help":
      await sendMarkdown(chatId, helpMarkdown(), "help", messageId);
      return;
    case "/status":
      await sendMarkdown(chatId, await statusMarkdown(chatId), "status", messageId);
      return;
    case "/new": {
      const session = resetSession(chatId, command.rest || "新会话");
      await sendText(chatId, `已创建 Codex 会话 (${session.id})`, "new", messageId);
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
    case "/fast":
      await handleFastCommand(chatId, command.rest, messageId);
      return;
    case "/compact":
      await handleCompactCommand(chatId, messageId);
      return;
    case "/stop":
      await stopCurrentJob(chatId, messageId, { clearMode: stopClearMode(command.rest) });
      return;
    case "/queue":
      await sendText(chatId, `当前队列：${queueSummary(chatId)}`, "queue", messageId);
      return;
    case "/clearqueue":
      await clearQueueCommand(chatId, command.rest, messageId);
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
      const session = await resetCurrentSession(chatId);
      await sendText(
        chatId,
        `已清空当前 Codex 会话上下文：${session.title} (${session.id})。下一条普通消息会在当前会话里从空白上下文开始。`,
        "reset",
        messageId,
      );
      return;
    }
    default:
      await sendMarkdown(chatId, `未知命令：\`${command.name}\`\n\n发送 \`/help\` 查看可用命令。`, "unknown-command", messageId);
  }
}

async function handleSwitchCommand(chatId, target, messageId) {
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
  for (const [key, pending] of pendingDeleteConfirmations) {
    if (pending?.threadId === id) pendingDeleteConfirmations.delete(key);
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

function parseDeleteSelectionSpec(value) {
  const text = String(value || "").trim();
  const tokens = text.split(/[\s,，、]+/).filter(Boolean);
  if (!tokens.length) return { error: "empty" };

  const indexes = [];
  const invalid = [];
  const nonNumeric = [];
  let hasRange = false;
  for (const token of tokens) {
    const rangeMatch = token.match(/^(\d+)\s*[-~～]\s*(\d+)$/);
    if (rangeMatch) {
      hasRange = true;
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1 || start > end) {
        invalid.push(token);
        continue;
      }
      for (let index = start; index <= end; index += 1) indexes.push(index);
      continue;
    }

    if (/^\d+$/.test(token)) {
      const index = Number(token);
      if (Number.isInteger(index) && index >= 1) {
        indexes.push(index);
      } else {
        invalid.push(token);
      }
      continue;
    }

    nonNumeric.push(token);
  }

  if (invalid.length) return { error: `无效序号或区间：${invalid.join("、")}` };
  if (nonNumeric.length) {
    if (tokens.length === 1 && !hasRange && indexes.length === 0) return { target: nonNumeric[0] };
    return { error: `批量删除只支持序号和区间，无法混用 ID：${nonNumeric.join("、")}` };
  }

  const unique = [];
  const seenIndexes = new Set();
  for (const index of indexes) {
    if (seenIndexes.has(index)) continue;
    seenIndexes.add(index);
    unique.push(index);
  }
  return { indexes: unique, isBatch: unique.length > 1 || hasRange || tokens.length > 1 };
}

function compressIndexes(indexes) {
  const sorted = [...new Set(indexes)].sort((a, b) => a - b);
  const parts = [];
  let start = null;
  let prev = null;
  for (const index of sorted) {
    if (start === null) {
      start = index;
      prev = index;
      continue;
    }
    if (index === prev + 1) {
      prev = index;
      continue;
    }
    parts.push(start === prev ? String(start) : `${start}-${prev}`);
    start = index;
    prev = index;
  }
  if (start !== null) parts.push(start === prev ? String(start) : `${start}-${prev}`);
  return parts.join(" ");
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
    if (activeJobUsesThread(threadId)) {
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
            entry: { ...items[0], id: items[0].sessionId, codexThreadId: items[0].threadId },
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
  if (activeJobUsesThread(threadId)) {
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
    if (activeJobUsesThread(item.threadId)) busy.push(item.index);
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
      const result = await deleteCodexLocalThread(item.threadId);
      const bridgeRemoved = removeThreadFromBridgeSessions(item.threadId);
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
  await syncChatSessionsWithCodex(chatId);
  const session = getSession(chatId);
  const args = commandArgs(rest);
  const action = String(args[0] || "").toLowerCase();

  if (!args.length || action === "status" || action === "view" || action === "check") {
    await sendMarkdown(chatId, providerStatusMarkdown(session), "provider-status", messageId);
    return;
  }

  if (action === "list") {
    const scope = String(args[1] || "").toLowerCase();
    if (["shortcut", "shortcuts", "bundle", "bundles"].includes(scope)) {
      await sendMarkdown(chatId, providerShortcutListMarkdown(session), "provider-shortcuts", messageId);
    } else {
      await sendMarkdown(chatId, providerListMarkdown(session), "provider-list", messageId);
    }
    return;
  }

  if (["shortcut", "shortcuts", "bundle", "bundles"].includes(action)) {
    await sendMarkdown(chatId, providerShortcutListMarkdown(session), "provider-shortcuts", messageId);
    return;
  }

  if (["clear", "default", "reset"].includes(action)) {
    setSessionOverride(session, "providerOverride", "");
    clearProviderBundleOverride(session);
    saveSessions();
    await sendMarkdown(chatId, providerStatusMarkdown(session, "已清除当前会话的 provider 覆盖，后续使用 Codex 配置默认 provider。"), "provider-clear", messageId);
    return;
  }

  const persist = action === "save";
  const providerId = persist ? args[1] : args[0];
  const bundle = findProviderBundle(providerId);
  const provider = bundle ? findCodexProvider(bundle.provider) : findCodexProvider(providerId);
  if (!provider) {
    await sendMarkdown(chatId, providerListMarkdown(session, `没有找到 provider：\`${providerId || ""}\``), "provider-miss", messageId);
    return;
  }

  try {
    if (bundle) {
      if (persist) {
        await writeCodexConfigValue("model_provider", bundle.provider);
        await writeCodexConfigValue("model", bundle.model);
        if (bundle.reasoning) await writeCodexConfigValue("model_reasoning_effort", bundle.reasoning);
      }
      applyProviderBundleOverride(session, bundle);
    } else {
      if (persist) await writeCodexConfigValue("model_provider", provider.id);
      clearProviderBundleOverride(session);
      setSessionOverride(session, "providerOverride", provider.id);
    }
    await sendMarkdown(
      chatId,
      providerStatusMarkdown(
        session,
        persist
          ? `已切换并写入用户级 config.toml：\`${bundle?.id || provider.id}\`。`
          : `已切换当前飞书会话 provider：\`${bundle?.id || provider.id}\`。`,
      ),
      "provider-set",
      messageId,
    );
  } catch (error) {
    await sendMarkdown(chatId, runtimeCommandErrorMarkdown("provider 操作失败", error), "provider-error", messageId);
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
    `当前 provider：\`${settings.provider || "默认"}\`${session.providerOverride ? "（会话覆盖）" : "（配置默认）"}`,
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
    const marker = provider.id === settings.provider ? " ← 当前" : "";
    lines.push(`- \`${provider.id}\`${marker}：${provider.name || provider.id}；${providerDetailLine(provider)}`);
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
    await sendMarkdown(chatId, modelCapabilityMarkdown(session), "model-capability", messageId);
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
    const model = cleanOverride(args[1]);
    if (!model) {
      await sendText(chatId, "用法：`/model test <模型ID>`，例如 `/model test gpt-5.5`。", "model-test-usage", messageId);
      return;
    }
    try {
      await sendMarkdown(chatId, modelTestMarkdown(await testCurrentProviderModel(session, model)), "model-test", messageId);
    } catch (error) {
      await sendMarkdown(chatId, runtimeCommandErrorMarkdown("provider /responses 测试失败", error), "model-test-error", messageId);
    }
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

function modelCapabilityMarkdown(session, { includeUsage = false } = {}) {
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
  const lines = [
    "**当前模型推理能力**",
    "",
    `provider：\`${settings.provider || "默认"}\``,
    `模型：\`${settings.model || "默认"}\``,
    `规则：\`${capability.name}\` (${capability.id})`,
    `状态：${capability.known ? `${review.stale ? "待复核" : "已收录"} · 核验 ${capability.verifiedAt} · 下次 ${review.reviewDueAt}` : "未收录 · 通用透传"}`,
    `可接受请求值：${supported.map((effort) => `\`${effort}\``).join("、")}`,
    "",
    "实际效果（你的选择 → 模型实际效果）：",
    ...rows,
    "",
    `当前映射：\`${settings.requestedReasoning}\` → \`${mapping.supported ? mapping.effectiveEffort : "不支持"}\` → \`${mapping.supported ? mapping.upstreamValue : "不支持"}\``,
    capability.sourceUrl ? `来源：${capability.sourceUrl}` : "来源：暂无模型专属来源",
    `能力池版本：\`${MODEL_REASONING_REGISTRY.registryVersion}\``,
  ];
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
    result.source === "provider" ? "**当前 provider 模型列表**" : "**Codex model 列表**",
    "",
    `provider：\`${settings.provider || "默认"}\``,
  ];
  if (result.source === "provider") {
    lines.push(`来源：\`${result.url}\``);
    if (result.provider?.envKey) lines.push(`鉴权：\`${result.provider.envKey}\``);
  } else {
    lines.push("来源：Codex app-server `model/list`（当前 provider 无 base_url 或为内置 provider）");
  }
  lines.push("");
  if (!models.length) {
    lines.push("没有拿到模型 ID。");
  }
  for (const model of models.slice(0, 30)) {
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
  if (models.length > 30) {
    lines.push(`- 还有 ${models.length - 30} 个模型未显示。`);
  }
  lines.push("");
  if (result.source === "provider") {
    lines.push("`/model list` 和 `/model refresh` 都会实时查询当前 provider 的 `/models`；这个列表只是发现工具，不是白名单。");
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

async function clearQueueCommand(chatId, rest, messageId) {
  const mode = stopClearMode(rest) === "all" ? "all" : "chat";
  const removed = clearPendingEventsForChat(chatId, { all: mode === "all" });
  await sendText(
    chatId,
    mode === "all"
      ? `已清空全部等待队列：${removed} 条。`
      : `已清空当前聊天等待队列：${removed} 条。当前队列：${queueSummary(chatId)}`,
    "clearqueue",
    messageId,
  );
}

async function stopCurrentJob(chatId, messageId, { clearMode = "" } = {}) {
  const cleared = clearMode ? clearPendingEventsForChat(chatId, { all: clearMode === "all" }) : 0;
  const job = activeCodexJobs.get(chatId);
  if (!job) {
    try {
      await syncChatSessionsWithCodex(chatId);
      const session = getSession(chatId);
      const goal = await getAppServerGoal(session);
      if (goalStatusIsActive(goal?.status)) {
        const paused = await setAppServerGoal(session, { status: "paused" });
        await sendMarkdown(
          chatId,
          goalMarkdown(session, paused || goal, `已暂停 Codex goal${clearMode ? `，并清理等待队列 ${cleared} 条` : ""}`),
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
    await sendText(chatId, `当前没有运行中的 Codex 任务。${clearMode ? `已清理等待队列 ${cleared} 条。` : ""}`, "stop-none", messageId);
    return;
  }
  stoppedJobs.add(job.messageId);
  if (job.rootMessageId) stoppedJobs.add(job.rootMessageId);

  if (job.mode === "app-server-goal" && job.client && job.threadId) {
    try {
      const result = await job.client.request("thread/goal/set", { threadId: job.threadId, status: "paused" }, 15_000);
      const run = activeGoalRuns.get(chatId);
      if (run) applyGoalRunNativeState(run, result?.goal || null);
      else {
        const session = getSession(chatId);
        if (!job.sessionId || session.id === job.sessionId) updateSessionGoal(session, result?.goal || null);
      }
    } catch (error) {
      if (isNoGoalExistsError(error)) {
        const run = activeGoalRuns.get(chatId);
        if (run) applyGoalRunNativeState(run, null);
        else {
          const session = getSession(chatId);
          if (!job.sessionId || session.id === job.sessionId) updateSessionGoal(session, null);
        }
        log("INFO", "codex goal already absent during stop", {
          chatId,
          pid: job.pid,
          threadId: job.threadId,
        });
      } else {
        log("WARN", "codex goal pause during stop failed", {
          chatId,
          pid: job.pid,
          threadId: job.threadId,
          error: String(error.message || error).slice(0, 1000),
        });
      }
    }
  }

  if (job.mode === "app-server" && job.client && job.threadId && job.turnId) {
    try {
      await job.client.request("turn/interrupt", { threadId: job.threadId, turnId: job.turnId }, 15_000);
      setTimeout(() => {
        const current = activeCodexJobs.get(chatId);
        if (current?.pid === job.pid) terminateProcessTree(job.pid, true);
      }, 5000).unref?.();
      await sendText(
        chatId,
        `已请求 Codex 原生停止当前任务；如果没有及时结束，Bridge 会自动兜底强制停止。${clearMode ? `已清理等待队列 ${cleared} 条。` : ""}`,
        "stop",
        messageId,
      );
      return;
    } catch (error) {
      log("WARN", "codex turn interrupt failed; falling back to process termination", {
        chatId,
        pid: job.pid,
        threadId: job.threadId,
        turnId: job.turnId,
        error: String(error.message || error).slice(0, 1000),
      });
    }
  }

  if (job.mode === "app-server-goal" && job.client && job.threadId && job.turnId) {
    try {
      await job.client.request("turn/interrupt", { threadId: job.threadId, turnId: job.turnId }, 15_000);
      setTimeout(() => {
        const current = activeCodexJobs.get(chatId);
        if (current?.pid === job.pid) terminateProcessTree(job.pid, true);
      }, 5000).unref?.();
      await sendText(
        chatId,
        `已暂停 Codex goal 并请求停止当前 turn；如果没有及时结束，Bridge 会自动兜底强制停止。${clearMode ? `已清理等待队列 ${cleared} 条。` : ""}`,
        "stop",
        messageId,
      );
      return;
    } catch (error) {
      log("WARN", "codex goal turn interrupt failed; falling back to process termination", {
        chatId,
        pid: job.pid,
        threadId: job.threadId,
        turnId: job.turnId,
        error: String(error.message || error).slice(0, 1000),
      });
    }
  }

  terminateProcessTree(job.pid, false);
  setTimeout(() => terminateProcessTree(job.pid, true), 5000).unref?.();
  await sendText(chatId, `已停止当前 Codex 任务。${clearMode ? `已清理等待队列 ${cleared} 条。` : ""}`, "stop", messageId);
}

async function handleCompactCommand(chatId, messageId) {
  await syncChatSessionsWithCodex(chatId);
  const session = getSession(chatId);
  const job = activeCodexJobs.get(chatId);
  if (job) {
    await sendText(chatId, "当前 Codex 任务还在运行，等这一轮结束后再发送 /compact。", "compact-busy", messageId);
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
    "`/fast on|off|status` — 切换或查看 Codex Fast 速度模式",
    "`/compact` — 触发当前原生 thread 的上下文压缩",
    "`/sessions` — 列出飞书会话和 Codex 侧边栏可见会话",
    "`/switch <序号或ID>` — 切换到已有 Codex 会话",
    "`/rename 新标题` / `/rename <序号> 新标题` — 修改当前会话或 /list 指定会话标题",
    "`/delete <序号或ID>` — 删除 Codex 本地会话；支持 `1 2 3`、`1-18`、`3-7 8-12`，需 `/confirm delete <序号或区间>` 确认",
    "`/reset` — 清空当前会话上下文",
    "`/stop` — 停止当前 Codex 任务",
    "`/stop queue` — 停止当前任务，并清空当前聊天的等待队列",
    "`/stop all` — 停止当前任务，并清空本 Bot 全部等待队列",
    "`/queue` — 查看等待队列",
    "`/clearqueue [all]` — 清空当前聊天或全部等待队列",
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
  const [eventStatus, authStatus, codexRuntimeStatus] = await Promise.all([
    readEventStatus(),
    readAuthSummary(),
    readCodexRuntimeVersionStatus({ codexCli: CONFIG.codexCli, runTool }),
  ]);
  const job = activeCodexJobs.get(chatId);
  const context = sessionContextSummary(session);
  return [
    "**Codex Feishu Bot 状态**",
    "",
    `桥接进程：PID ${process.pid}，已运行 ${formatDuration(Date.now() - stats.startedAt)}`,
    `飞书事件：${eventStatus}`,
    `登录授权：${authStatus}`,
    `当前聊天绑定：${session.title || "未命名会话"} (${session.id})`,
    `原生 thread：${session.codexThreadId ? `\`${session.codexThreadId}\`` : "未创建"}`,
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
  const fullList = await listChatSessionsSynced(chatId);
  const mode = parseSessionsListMode(rest);
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
    "**Codex 已完成**",
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

function startConsumer() {
  log("INFO", "starting bridge", {
    workspace: CONFIG.workspace,
    codexHome: CONFIG.codexHome,
    desktopCodexHome: CONFIG.desktopCodexHome || "",
    eventKeys: CONFIG.eventKeys,
    larkProfile: CONFIG.larkProfile || "default",
    larkCli: toolLabel(CONFIG.larkCli),
    codexCli: toolLabel(CONFIG.codexCli),
    runMode: CONFIG.runMode,
    sandbox: CONFIG.codexSandbox,
    reasoning: codexReasoningLabel,
    codexTimeoutMs: CONFIG.codexTimeoutMs,
    codexIdleTimeoutMs: CONFIG.codexIdleTimeoutMs,
    listLimit: CONFIG.listLimit,
    disableMcp: CONFIG.disableMcp,
    maxConcurrent: CONFIG.maxConcurrent,
    cardMode: CONFIG.useCards,
    cardThrottleMs: CONFIG.cardThrottleMs,
    debugCards: CONFIG.debugCards,
    showFinalSteps: CONFIG.showFinalSteps,
    maxRunningToolDetails: CONFIG.maxRunningToolDetails,
    larkDataFileThreshold: CONFIG.larkDataFileThreshold,
    replyToMessage: CONFIG.replyToMessage,
    replyInThread: CONFIG.useThreadReply,
    sidebarReconcileIntervalMs: CONFIG.sidebarReconcileIntervalMs,
  });

  startSidebarReconciler();
  for (const eventKey of CONFIG.eventKeys) startEventConsumer(eventKey);

  const stopTimer = setInterval(() => {
    if (fs.existsSync(stopPath)) {
      log("INFO", "stop file detected");
      try {
        fs.rmSync(stopPath, { force: true });
      } catch {}
      shutdown(0);
    }
  }, 1000);
  stopTimer.unref?.();
  shutdownCallbacks.add(() => clearInterval(stopTimer));
}

function startSidebarReconciler() {
  reconcileCodexDesktopSidebarIndexes("startup").catch((error) => {
    log("WARN", "startup codex desktop sidebar reconcile failed", { error: String(error?.stack || error) });
  });

  const intervalMs = Math.max(
    MIN_SIDEBAR_RECONCILE_INTERVAL_MS,
    Number(CONFIG.sidebarReconcileIntervalMs || 0),
  );
  if (intervalMs > 0) {
    const timer = setInterval(() => {
      reconcileCodexDesktopSidebarIndexes("interval").catch((error) => {
        log("WARN", "interval codex desktop sidebar reconcile failed", { error: String(error?.stack || error) });
      });
    }, intervalMs);
    timer.unref?.();
    shutdownCallbacks.add(() => clearInterval(timer));
  }

  watchCodexGlobalStateForSidebarReconcile(codexGlobalStatePath, "codex-home");
  if (shouldMirrorDesktopCodexHome) {
    watchCodexGlobalStateForSidebarReconcile(desktopCodexGlobalStatePath, "desktop-codex-home");
  }
}

function watchCodexGlobalStateForSidebarReconcile(globalStatePath, label) {
  if (!globalStatePath || !fs.existsSync(path.dirname(globalStatePath))) return;
  try {
    const watcher = fs.watch(globalStatePath, { persistent: false }, () => {
      setTimeout(() => {
        reconcileCodexDesktopSidebarIndexes(`global-state/${label}`).catch((error) => {
          log("WARN", "global-state codex desktop sidebar reconcile failed", {
            label,
            globalStatePath,
            error: String(error?.stack || error),
          });
        });
      }, 500).unref?.();
    });
    shutdownCallbacks.add(() => watcher.close());
  } catch (error) {
    log("WARN", "codex global state watcher unavailable", {
      label,
      globalStatePath,
      error: String(error?.stack || error),
    });
  }
}

function startEventConsumer(eventKey) {
  const eventArgs = [...CONFIG.larkCli.argsPrefix, "event", "consume", eventKey, "--as", "bot"];
  const child = spawn(CONFIG.larkCli.command, eventArgs, {
    cwd: CONFIG.workspace,
    env: process.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  activeChildren.set(child.pid, { child, label: `${CONFIG.larkCli.command} ${eventArgs.join(" ")}` });

  shutdownCallbacks.add(() => {
    try {
      child.stdin.end();
    } catch {}
    try {
      child.kill("SIGTERM");
    } catch {}
    setTimeout(() => terminateProcessTree(child.pid, true), 5000).unref?.();
  });

  const stdoutRl = readline.createInterface({ input: child.stdout });
  stdoutRl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      eventDispatcher.enqueue(JSON.parse(trimmed));
    } catch (error) {
      log("WARN", "failed to parse event line", { line: trimmed.slice(0, 1000), error: String(error) });
    }
  });

  const stderrRl = readline.createInterface({ input: child.stderr });
  stderrRl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.includes("[event] ready")) {
      log("INFO", "event consumer ready", { eventKey, line: trimmed });
    } else if (trimmed.includes("[event] exited")) {
      log("INFO", "event consumer exited", { eventKey, line: trimmed });
    } else {
      log("WARN", "event consumer stderr", { eventKey, line: trimmed });
    }
  });

  child.on("error", (error) => {
    log("ERROR", "event consumer spawn failed", { eventKey, error: String(error.stack || error) });
    shutdown(1);
  });

  child.on("close", (code) => {
    activeChildren.delete(child.pid);
    if (!shuttingDown) {
      log("ERROR", "event consumer stopped unexpectedly", { eventKey, code });
      shutdown(code || 1);
    }
  });
}

function toolLabel(tool) {
  return [tool.command, ...tool.argsPrefix].join(" ");
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("INFO", "shutting down bridge", { code });
  for (const callback of shutdownCallbacks) callback();
  for (const [pid, info] of activeChildren) {
    log("INFO", "terminating child process", { pid, label: info.label.slice(0, 300) });
    terminateProcessTree(pid, false);
    setTimeout(() => terminateProcessTree(pid, true), 5000).unref?.();
  }
  try {
    if (fs.existsSync(pidPath) && fs.readFileSync(pidPath, "utf8").trim() === String(process.pid)) {
      fs.rmSync(pidPath, { force: true });
    }
  } catch {}
  try {
    fs.rmSync(stopPath, { force: true });
  } catch {}
  releaseSingleInstanceLock();
  setTimeout(() => process.exit(code), 500).unref?.();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("uncaughtException", (error) => {
  log("ERROR", "uncaught exception", { error: String(error.stack || error) });
  shutdown(1);
});
process.on("unhandledRejection", (error) => {
  log("ERROR", "unhandled rejection", { error: String(error?.stack || error) });
  shutdown(1);
});
process.on("exit", () => {
  try {
    if (fs.existsSync(pidPath) && fs.readFileSync(pidPath, "utf8").trim() === String(process.pid)) {
      fs.rmSync(pidPath, { force: true });
    }
  } catch {}
  try {
    fs.rmSync(stopPath, { force: true });
  } catch {}
  releaseSingleInstanceLock();
});

repairStaleActiveRunsOnStartup()
  .catch((error) => log("WARN", "stale active run repair failed", { error: String(error.stack || error) }))
  .finally(() => startConsumer());
