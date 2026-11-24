#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import agentEngine from "./src/agents/engine.cjs";
import { createClaudeBridge } from "./src/claude/bridge-runner.mjs";
import { createAntigravityBridge } from "./src/antigravity/bridge-runner.mjs";
import { fileURLToPath } from "node:url";
import {
  normalizeRunMode,
  parseDurationMs,
  parseEventKeys,
  parseToolEnv,
  resolveDefaultDataRoot,
  resolveDefaultTools,
  resolveLarkEventLockScope,
  resolveLarkProfileHome,
  withLarkProfile,
} from "./src/config/env.mjs";
import { sameResolvedPath } from "./src/config/paths.mjs";
import {
  chatIdOf,
  eventIdOf,
  isRecallEvent,
  messageIdOf,
} from "./src/feishu/events.mjs";
import { createLarkClient } from "./src/feishu/lark-cli.mjs";
import {
  parseEventCommand,
  prepareCardEvent,
} from "./src/feishu/card-content.mjs";
import { createManagedCardClass } from "./src/feishu/cards/managed-card.mjs";
import { createFormulaImageService } from "./src/feishu/cards/formula-renderer.mjs";
import {
  idempotencyKey,
  markdown,
  splitText,
  truncateCardText,
} from "./src/feishu/cards/primitives.mjs";
import { createPendingAttachmentStore } from "./src/attachments/pending.mjs";
import { createLogger } from "./src/logging/logger.mjs";
import { createServiceTierPolicy } from "./src/config/service-tier.mjs";
import openaiAccounts from "./src/codex/openai-accounts.cjs";
import { createAppServerPool } from "./src/codex/app-server-pool.mjs";
import { createAppServerProtocol } from "./src/codex/app-server-protocol.mjs";
import { createVerifiedModelStore } from "./src/providers/verified-models.mjs";
import { createProviderSwitchController } from "./src/providers/session-switch.mjs";
import { createCodexProviderConfig } from "./src/providers/codex-config.mjs";
import { createActiveRunStore } from "./src/runtime/active-runs.mjs";
import { createEventDispatcher } from "./src/runtime/event-dispatcher.mjs";
import { createEventReplayGuard } from "./src/runtime/event-replay-guard.mjs";
import { createProcessRunner } from "./src/runtime/process-runner.mjs";
import bridgeProcessIdentity from "./src/runtime/bridge-process-identity.cjs";
import { createRecalledMessageStore } from "./src/runtime/recalled-messages.mjs";
import { createSingleInstanceLock } from "./src/runtime/single-instance-lock.mjs";
import { markRunPhase } from "./src/runtime/run-activity.mjs";
import { createSeenEventsStore } from "./src/runtime/seen-events.mjs";
import {
  createChatCommandQueue,
  registerPendingSteerOnEnqueue,
} from "./src/runtime/steer-generation.mjs";
import { createSessionStore } from "./src/sessions/store.mjs";
import { createSharedClaudeSessionStore } from "./src/claude/shared-sessions.mjs";
import {
  buildAccessContext,
  extractScopeFromEvent,
  isOwnerDmContext,
} from "./src/sessions/access-control.mjs";
import { findDeepKey } from "./src/utils/json.mjs";
import {
  classifyCodexFailure,
  errorText,
  failureShortText,
} from "./src/logging/errors.mjs";
import modelReasoning from "./src/config/model-reasoning.cjs";
import { createAttachmentManager } from "./src/feishu/attachments.mjs";
import { createCodexSidebarSync } from "./src/codex/sidebar-sync.mjs";
import { createSessionInventory } from "./src/sessions/inventory.mjs";
import { createRunCardRenderer } from "./src/feishu/cards/run-card.mjs";
import { createCodexRunner } from "./src/codex/runner.mjs";
import { createCommandRouter } from "./src/commands/router.mjs";
import { createBridgeLifecycle } from "./src/runtime/lifecycle.mjs";

function safeRelativePath(value, fallback) {
  const raw = String(value || "").trim().replace(/\\/g, "/");
  if (!raw || path.isAbsolute(raw) || raw.split("/").includes("..")) return fallback;
  return raw.replace(/^\/+/, "") || fallback;
}

const { acceptedEfforts, capabilityOutcomeLines, loadRegistry: loadReasoningRegistry, mapReasoningEffort, reviewStatus: reasoningReviewStatus } = modelReasoning;

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOOLS = resolveDefaultTools();
const DEFAULT_DATA_ROOT = resolveDefaultDataRoot();
const LARK_PROFILE = String(process.env.CODEX_FEISHU_LARK_PROFILE || process.env.LARK_CLI_PROFILE || "").trim();
const LARK_PROFILE_HOME = resolveLarkProfileHome(process.env);
const EVENT_KEYS = parseEventKeys(process.env.CODEX_FEISHU_EVENT_KEYS || process.env.CODEX_FEISHU_EVENT_KEY || "im.message.receive_v1");
const CODEX_HOME_PATH = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
const CONFIGURED_DESKTOP_CODEX_HOME = String(process.env.CODEX_FEISHU_DESKTOP_CODEX_HOME || "").trim();
const DESKTOP_CODEX_HOME_PATH = CONFIGURED_DESKTOP_CODEX_HOME
  && sameResolvedPath(CONFIGURED_DESKTOP_CODEX_HOME, CODEX_HOME_PATH)
  ? CODEX_HOME_PATH
  : "";

const CONFIG = {
  engine: agentEngine.normalizeEngine(process.env.CODEX_FEISHU_ENGINE),
  antigravityCli: parseToolEnv('ANTIGRAVITY_CLI_BIN', { command: process.platform === 'win32' ? 'agy.exe' : 'agy', argsPrefix: [] }),
  antigravityHome: process.env.ANTIGRAVITY_CONFIG_DIR || path.join(os.homedir(), '.gemini'),
  antigravityDesktopGeminiDir: (() => {
    const raw = process.env.ANTIGRAVITY_DESKTOP_GEMINI_DIR;
    if (raw !== undefined) return String(raw).trim();
    const candidate = path.join(os.homedir(), '.gemini');
    return fs.existsSync(path.join(candidate, 'antigravity', 'conversation_summaries.db')) ? candidate : '';
  })(),
  antigravityDataRoot: process.env.ANTIGRAVITY_BRIDGE_DATA_ROOT || path.join(os.homedir(), '.antigravity-feishu'),
  antigravityBotConfig: process.env.ANTIGRAVITY_BOT_CONFIG || '',
  antigravityMcpConfig: process.env.ANTIGRAVITY_MCP_CONFIG || '',
  antigravityToolsRoot: process.env.ANTIGRAVITY_TOOLS_ROOT || '',
  antigravitySharedSessionsRoot: process.env.ANTIGRAVITY_SHARED_SESSIONS_ROOT || '',
  claudeCli: parseToolEnv('CLAUDE_CLI_BIN', { command: process.platform === 'win32' ? 'claude.exe' : 'claude', argsPrefix: [] }),
  claudeHome: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
  claudeDesktopHome: (() => {
    const raw = process.env.CLAUDE_DESKTOP_HOME;
    if (raw !== undefined) return String(raw).trim();
    const candidate = path.join(os.homedir(), '.claude');
    return fs.existsSync(candidate) ? candidate : '';
  })(),
  claudeProviderCatalog: process.env.CLAUDE_FEISHU_PROVIDER_CATALOG || '',
  claudeProviderId: process.env.CLAUDE_FEISHU_PROVIDER_ID || '',
  claudeBotConfig: process.env.CLAUDE_FEISHU_BOT_CONFIG || '',
  claudePermissionMode: process.env.CLAUDE_FEISHU_PERMISSION_MODE || 'bypassPermissions',
  claudeToolsRoot: process.env.CLAUDE_FEISHU_TOOLS_ROOT || '',
  claudeSharedSessionsRoot: process.env.CLAUDE_FEISHU_SHARED_SESSIONS_ROOT
    || (process.env.CODEX_FEISHU_ENGINE === 'claude' && process.env.CLAUDE_FEISHU_TOOLS_ROOT
      ? path.join(path.dirname(process.env.CLAUDE_FEISHU_TOOLS_ROOT), 'claude-shared-sessions') : ''),
  workspace: process.env.CODEX_FEISHU_WORKSPACE || process.cwd(),
  eventKeys: EVENT_KEYS,
  eventKey: EVENT_KEYS[0] || "im.message.receive_v1",
  larkProfile: LARK_PROFILE,
  larkProfileHome: LARK_PROFILE_HOME,
  ownerOpenId: String(process.env.CODEX_FEISHU_OWNER_OPEN_ID || "").trim(),
  larkCli: withLarkProfile(parseToolEnv("LARK_CLI_BIN", DEFAULT_TOOLS.larkCli), LARK_PROFILE),
  codexCli: parseToolEnv("CODEX_CLI_BIN", DEFAULT_TOOLS.codexCli),
  runMode: normalizeRunMode(process.env.CODEX_FEISHU_RUN_MODE || "app-server"),
  codexSandbox: process.env.CODEX_FEISHU_SANDBOX || "danger-full-access",
  codexModel: process.env.CODEX_FEISHU_MODEL || "",
  codexReasoning: process.env.CODEX_FEISHU_REASONING || "",
  codexTimeoutMs: parseDurationMs(process.env.CODEX_FEISHU_CODEX_TIMEOUT_MS, 0),
  codexIdleTimeoutMs: parseDurationMs(process.env.CODEX_FEISHU_CODEX_IDLE_TIMEOUT_MS, 60 * 60_000),
  appServerIdleTtlMs: parseDurationMs(process.env.CODEX_FEISHU_APP_SERVER_IDLE_TTL_MS, 15 * 60_000),
  appServerPoolSize: Number(process.env.CODEX_FEISHU_APP_SERVER_POOL_SIZE || process.env.CODEX_FEISHU_MAX_CONCURRENT || "1"),
  disableMcp: (process.env.CODEX_FEISHU_DISABLE_MCP || "0") !== "0",
  maxConcurrent: Number(process.env.CODEX_FEISHU_MAX_CONCURRENT || "1"),
  maxReplyChars: Number(process.env.CODEX_FEISHU_MAX_REPLY_CHARS || "6000"),
  listLimit: Number(process.env.CODEX_FEISHU_LIST_LIMIT || "100"),
  useCards: (process.env.CODEX_FEISHU_CARD_MODE || "1") !== "0",
  cardThrottleMs: Number(process.env.CODEX_FEISHU_CARD_THROTTLE_MS || "400"),
  debugCards: (process.env.CODEX_FEISHU_CARD_DEBUG || "0") === "1",
  showFinalSteps: (process.env.CODEX_FEISHU_SHOW_FINAL_STEPS || "1") === "1",
  maxRunningToolDetails: Number(process.env.CODEX_FEISHU_CARD_MAX_RUNNING_TOOL_DETAILS || "20"),
  formulaRendering: (process.env.CODEX_FEISHU_FORMULA_RENDERING || "1") !== "0",
  formulaBrowserBin: process.env.CODEX_FEISHU_FORMULA_BROWSER_BIN || "",
  formulaMaxImages: Number(process.env.CODEX_FEISHU_FORMULA_MAX_IMAGES || "8"),
  formulaMaxParagraphChars: Number(process.env.CODEX_FEISHU_FORMULA_MAX_PARAGRAPH_CHARS || "1400"),
  formulaRenderTimeoutMs: parseDurationMs(process.env.CODEX_FEISHU_FORMULA_RENDER_TIMEOUT_MS, 15_000),
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
  eventReplayGraceMs: parseDurationMs(process.env.CODEX_FEISHU_EVENT_REPLAY_GRACE_MS, 2 * 60_000),
  deleteConfirmTtlMs: Number(process.env.CODEX_FEISHU_DELETE_CONFIRM_TTL_MS || `${5 * 60_000}`),
  streamRecoveryEnabled: (process.env.CODEX_FEISHU_STREAM_RECOVERY || "1") !== "0",
  streamRecoveryMaxAttempts: Number(process.env.CODEX_FEISHU_STREAM_RECOVERY_MAX_ATTEMPTS || "1"),
  syncSidebar: !['claude', 'antigravity'].includes(process.env.CODEX_FEISHU_ENGINE) && (process.env.CODEX_FEISHU_SYNC_SIDEBAR || "0") !== "0",
  sidebarReconcileIntervalMs: parseDurationMs(process.env.CODEX_FEISHU_SIDEBAR_RECONCILE_INTERVAL_MS, 60_000),
  syncSessionsFromCodex: !['claude', 'antigravity'].includes(process.env.CODEX_FEISHU_ENGINE) && (process.env.CODEX_FEISHU_SYNC_SESSIONS_FROM_CODEX || "1") !== "0",
  keepEmptySessionMs: Number(process.env.CODEX_FEISHU_KEEP_EMPTY_SESSION_MS || `${10 * 60_000}`),
  threadHealthReminder: !['claude', 'antigravity'].includes(process.env.CODEX_FEISHU_ENGINE) && (process.env.CODEX_FEISHU_THREAD_HEALTH_REMINDER || "1") !== "0",
  threadHealthWarningBytes: Number(process.env.CODEX_FEISHU_THREAD_HEALTH_WARNING_MB || "120") * 1_000_000,
  threadHealthCriticalBytes: Number(process.env.CODEX_FEISHU_THREAD_HEALTH_CRITICAL_MB || "200") * 1_000_000,
  threadHealthWarningResumeMs: parseDurationMs(process.env.CODEX_FEISHU_THREAD_HEALTH_WARNING_RESUME_MS, 15_000),
  threadHealthPersistentResumeMs: parseDurationMs(process.env.CODEX_FEISHU_THREAD_HEALTH_PERSISTENT_RESUME_MS, 30_000),
  threadHealthCriticalResumeMs: parseDurationMs(process.env.CODEX_FEISHU_THREAD_HEALTH_CRITICAL_RESUME_MS, 60_000),
  codexHome: CODEX_HOME_PATH,
  desktopCodexHome: DESKTOP_CODEX_HOME_PATH,
};

const { engineDisplayName } = agentEngine;
const ENGINE_LABEL = engineDisplayName(CONFIG.engine);
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
const formulaTempDir = path.join(CONFIG.stateDir, "tmp", "formulas");
const eventLockScope = resolveLarkEventLockScope(CONFIG.larkProfile, { larkProfileHome: CONFIG.larkProfileHome });
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
const deletedThreadsFileName = ".codex-feishu-deleted-threads.json";
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
  log,
});
const {
  activeRuns,
  clearActiveRun,
  recordActiveRun,
  saveActiveRuns,
  touchActiveRun,
} = activeRunStore;

function clearActiveRunSafely(messageId, reason) {
  try {
    clearActiveRun(messageId);
    return true;
  } catch (error) {
    log("WARN", "active run cleanup deferred after local state write failure", {
      messageId,
      reason,
      error: String(error?.message || error).slice(0, 1000),
    });
    return false;
  }
}

function recordActiveRunSafely(record, reason) {
  try {
    recordActiveRun(record);
    return true;
  } catch (error) {
    log("WARN", "active run registration skipped after local state write failure", {
      messageId: record?.messageId,
      reason,
      error: String(error?.message || error).slice(0, 1000),
    });
    return false;
  }
}

function touchActiveRunSafely(messageId) {
  try {
    touchActiveRun(messageId);
  } catch (error) {
    log("WARN", "active run heartbeat skipped after local state write failure", {
      messageId,
      error: String(error?.message || error).slice(0, 1000),
    });
  }
}
const pendingAttachmentStore = createPendingAttachmentStore({
  maxPendingAttachments: CONFIG.maxPendingAttachments,
  pendingTtlMs: CONFIG.attachmentPendingTtlMs,
});
const {
  add: addPendingAttachments,
  cleanup: cleanupPendingAttachments,
  dropByMessageId: dropPendingAttachmentsByMessageId,
  dropForMessage: dropPendingAttachmentsForMessage,
  take: takePendingAttachments,
  withAttachmentLock,
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
    entryPath: path.resolve(process.argv[1]),
    processStartTime: bridgeProcessIdentity.ownProcessStartTime(),
  },
  processAlive: bridgeProcessIdentity.isBridgeOwnerAlive,
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
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const larkClient = createLarkClient({
  larkCli: CONFIG.larkCli,
  larkProfileHome: CONFIG.larkProfileHome,
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
  uploadImage,
} = larkClient;
const formulaImageService = createFormulaImageService({
  enabled: CONFIG.formulaRendering && CONFIG.useCards,
  browserExecutable: CONFIG.formulaBrowserBin,
  tempDir: formulaTempDir,
  uploadImage,
  maxImages: CONFIG.formulaMaxImages,
  maxParagraphChars: CONFIG.formulaMaxParagraphChars,
  renderTimeoutMs: CONFIG.formulaRenderTimeoutMs,
  log,
});
shutdownCallbacks.add(() => void formulaImageService.close?.());
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
    id: "deepseek-direct-flash",
    name: "DeepSeek Official Responses / V4 Flash",
    provider: "deepseek-direct",
    model: "deepseek-v4-flash",
    reasoning: "high",
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
const {
  createSessionData,
  normalizeSessionData,
  dedupeSessions,
  sessionListLimit,
} = createSessionInventory({ CONFIG });
const sessionStore = ((CONFIG.engine === 'claude' && CONFIG.claudeSharedSessionsRoot) || (CONFIG.engine === 'antigravity' && CONFIG.antigravitySharedSessionsRoot) ? createSharedClaudeSessionStore : createSessionStore)({
  config: CONFIG,
  preserveSessionIdentity: true,
  sessionsPath,
  createSessionData,
  normalizeSessionData,
  dedupeSessions,
  sessionListLimit,
  log,
});
const {
  getChatState,
  getSession,
  resetSession,
  saveSessions,
  sessions,
} = sessionStore;
const chatEventContexts = new Map();

function eventAccessContext(event, fallbackChatId = "") {
  const chatId = String(event?.chat_id || fallbackChatId || "").trim();
  const baseEvent = event ? { ...event, chat_id: chatId } : { chat_id: chatId };
  return buildAccessContext(baseEvent, {
    configuredOwnerOpenId: CONFIG.ownerOpenId,
    ownerFile: sessionStore.shared?.ownerFile || path.join(CONFIG.stateDir, "owner.json"),
    log,
  });
}

function recordChatScope(chatId, event) {
  if (!chatId || !event) return null;
  const ctx = eventAccessContext(event, chatId);
  chatEventContexts.set(chatId, ctx);
  const scope = extractScopeFromEvent(event);
  if (scope.chatType) {
    const chatState = sessions.chats[chatId] ||= { currentSessionId: "", sessions: [] };
    chatState.chatType = scope.chatType;
    if (scope.chatType === "p2p" && scope.senderId) {
      chatState.ownerOpenId = scope.senderId;
    }
  }
  return ctx;
}

function isOwnerDm(chatId, event = null) {
  if (event) {
    const ctx = eventAccessContext(event, chatId);
    return isOwnerDmContext(ctx);
  }
  const remembered = chatEventContexts.get(chatId);
  if (remembered) return isOwnerDmContext(remembered);
  const chatState = sessions.chats[chatId];
  if (!chatState?.chatType) return false;
  const ctx = eventAccessContext({
    chat_id: chatId,
    chat_type: chatState.chatType,
    sender_id: chatState.ownerOpenId || "",
  }, chatId);
  return isOwnerDmContext(ctx);
}
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
const eventReplayGuard = createEventReplayGuard({
  startedAt: stats.startedAt,
  graceMs: CONFIG.eventReplayGraceMs,
});
const chatCommandQueue = createChatCommandQueue();
const LEVEL_A_COMMANDS = new Set([
  "/help", "/status", "/now", "/how", "/queue",
  "/clearqueue", "/clearqueueall", "/stop", "/stopall",
  "/approve", "/deny",
]);
const eventDispatcher = createEventDispatcher({
  maxConcurrent: CONFIG.maxConcurrent,
  chatIdOf,
  messageIdOf,
  eventIdOf,
  isRecallEvent,
  isMessageRecalled,
  parseCommand: (event) => parseEventCommand(event, (content) => bridgeRuntime.parseCommand(content)),
  isOutOfBandCommand,
  onOutOfBandEnqueued: (event, command) => registerPendingSteerOnEnqueue({
    event,
    command,
    activeJobs: activeCodexJobs,
    chatIdOf,
    messageIdOf,
  }),
  handleRecallEvent,
  handleOutOfBandCommand,
  handleEvent,
  acknowledgeQueued: (event, ahead) => sendText(
    chatIdOf(event),
    `已加入等待队列：前面还有 ${ahead} 个任务。斜杠命令仍可立即执行；如需停止当前任务，请发送 /stop。`,
    "queued",
    messageIdOf(event),
  ),
  isShuttingDown: () => Boolean(bridgeRuntime.isShuttingDown?.()),
  log,
});

const bridgeRuntime = {
  acceptedEfforts, capabilityOutcomeLines, loadReasoningRegistry, mapReasoningEffort, reasoningReviewStatus,
  ROOT, DEFAULT_TOOLS, DEFAULT_DATA_ROOT, LARK_PROFILE, LARK_PROFILE_HOME, EVENT_KEYS,
  CODEX_HOME_PATH, CONFIGURED_DESKTOP_CODEX_HOME, DESKTOP_CODEX_HOME_PATH, CONFIG, engineDisplayName, ENGINE_LABEL,
  logPath, log, seenPath, sessionsPath, activeRunsPath, pidPath, lockPath, stopPath,
  larkDataTempDir, formulaTempDir, eventLockScope, eventLocksDir, runtimeDir, outputDir, promptDir, attachmentDir,
  codexStateDbPath, codexSessionIndexPath, codexGlobalStatePath, codexSidebarLockPath,
  desktopCodexStateDbPath, desktopCodexSessionIndexPath, desktopCodexGlobalStatePath, desktopCodexSidebarLockPath,
  deletedThreadsFileName, shouldMirrorDesktopCodexHome,
  seenEvents, rememberEvent, activeRunStore, activeRuns, clearActiveRun, recordActiveRun, saveActiveRuns, touchActiveRun,
  clearActiveRunSafely, recordActiveRunSafely, touchActiveRunSafely, eventAccessContext, recordChatScope, isOwnerDm,
  pendingAttachmentStore, addPendingAttachments, cleanupPendingAttachments, dropPendingAttachmentsByMessageId,
  dropPendingAttachmentsForMessage, takePendingAttachments, withAttachmentLock,
  recalledMessageStore, isMessageRecalled, rememberRecalledMessage,
  singleInstanceLock, acquireSingleInstanceLock, releaseSingleInstanceLock,
  shutdownCallbacks, activeChildren, activeCodexJobs, activeGoalRuns, pendingDeleteConfirmations, stoppedJobs,
  processRunner, isProcessAlive, runTool, terminateProcessTree,
  larkClient, larkJson, larkJsonWithData, replyFallback, runLark, sendMarkdown, sendText, uploadImage, delay,
  formulaImageService, ManagedCard,
  MODEL_REASONING_REGISTRY, REASONING_EFFORTS, MIN_SIDEBAR_RECONCILE_INTERVAL_MS,
  PROVIDER_MODEL_LIST_TIMEOUT_MS, PROVIDER_MODEL_TEST_TIMEOUT_MS, CODEX_THREAD_ID_PATTERN, PROVIDER_BUNDLES,
  codexProviderConfig, findCodexProvider, findProviderBundle, listCodexProviders, providerBundleLabel,
  providerModelsUrl, providerResponsesUrl, resolveCodexConfigModel, resolveCodexConfigValue, writeTopLevelCodexConfigValue,
  codexReasoningLabel, codexModelLabel,
  displayServiceTier, serviceTierFallbackFailure, serviceTierForExecSettings, serviceTierForProviderDetail,
  serviceTierForThreadSettings, serviceTierForTurnSettings, serviceTierPlanForExecSettings, serviceTierPlanForTurnSettings,
  shouldRetryWithoutServiceTier,
  sessionStore, getChatState, getSession, resetSession, saveSessions, sessions, chatEventContexts,
  stats, eventReplayGuard, chatCommandQueue, LEVEL_A_COMMANDS, eventDispatcher,
  safeRelativePath, parseTokens, safeFilePart, removePendingEventsByMessageId, clearPendingEventsForChat,
  pendingEventsForChat, cancelQueuedExecution, queueSummary, handleRecallEvent, isLevelCCommand,
  isOutOfBandCommand, handleOutOfBandCommand, handleEvent, cleanupClearedDownloads,
};

const attachments = createAttachmentManager(bridgeRuntime);
Object.assign(bridgeRuntime, attachments);
const {
  enrichEvent, userTextFromContent, downloadImageAttachments, downloadFileAttachments,
  formatAttachmentCounts, prepareCommandAttachments, formatBytes, parseCommand, attachmentPromptBlock,
} = attachments;

const sidebarSync = createCodexSidebarSync(bridgeRuntime);
Object.assign(bridgeRuntime, sidebarSync);

const runCard = createRunCardRenderer(bridgeRuntime);
Object.assign(bridgeRuntime, runCard);
const {
  createRunState, appendRunText, reduceCodexJsonEvent, markRunError, markRunInterrupted,
  ensureRunDone, renderRunCard, repairStaleActiveRunsOnStartup,
} = runCard;

const appServerProtocol = createAppServerProtocol({
  config: CONFIG,
  applySessionThreadOverrides: (...args) => bridgeRuntime.applySessionThreadOverrides(...args),
  applySessionTurnOverrides: (...args) => bridgeRuntime.applySessionTurnOverrides(...args),
  userTextFromContent,
  attachmentPromptBlock,
});
const {
  resumeParams: appServerResumeParams,
  startParams: appServerStartParams,
  steerParams: appServerSteerParams,
  turnParams: appServerTurnParams,
} = appServerProtocol;
const appServerPool = createAppServerPool({
  createClient: (options) => bridgeRuntime.startAppServerClient(options),
  maxSize: CONFIG.appServerPoolSize,
  idleTtlMs: CONFIG.appServerIdleTtlMs,
  log,
});
const verifiedModels = createVerifiedModelStore(path.join(CONFIG.stateDir, 'verified-provider-models.json'));
const providerSwitcher = createProviderSwitchController({
  save: saveSessions,
  prepare: (...args) => bridgeRuntime.prepareProviderBinding(...args),
  validate: session => {
    if (!Object.values(sessions.chats).some(chat => chat.currentSessionId === session.id && chat.sessions?.includes(session))) {
      throw new Error('准备期间当前逻辑会话已变化，原会话的 Provider 绑定未更换');
    }
  },
  snapshotDefaults: defaults => ({
    values: codexProviderConfig.readTopLevelValues(Object.keys(defaults.values)),
    account: openaiAccounts.defaultAccount(CONFIG.codexHome),
  }),
  applyDefaults: (defaults, before) => {
    if (before) bridgeRuntime.assertDefaultValuesUnchanged(before.values, defaults.values);
    if (before && ![before.account, defaults.account].includes(openaiAccounts.defaultAccount(CONFIG.codexHome))) throw new Error('默认账号已被其他操作修改');
    codexProviderConfig.writeTopLevelCodexConfigValues(defaults.values);
    openaiAccounts.setDefaultAccount(CONFIG.codexHome, defaults.account);
  },
  restoreDefaults: (before, desired) => {
    bridgeRuntime.assertDefaultValuesUnchanged(desired.values, before.values);
    if (![before.account, desired.account].includes(openaiAccounts.defaultAccount(CONFIG.codexHome))) throw new Error('默认账号已被其他操作修改');
    codexProviderConfig.writeTopLevelCodexConfigValues(before.values);
    openaiAccounts.setDefaultAccount(CONFIG.codexHome, before.account);
  },
});
shutdownCallbacks.add(() => {
  void appServerPool.closeAll("bridge-shutdown");
});

const claudeBridge = CONFIG.engine === 'claude' ? createClaudeBridge({
  config: CONFIG, getSession, getChatState, getChats: () => sessions.chats, resetSession, saveSessions, userText: userTextFromContent,
  sendText, sendMarkdown, activeChildren, activeJobs: activeCodexJobs,
  appendText: appendRunText, reduceEvent: reduceCodexJsonEvent, markPhase: markRunPhase,
  ensureDone: ensureRunDone, markInterrupted: markRunInterrupted, markError: markRunError,
  terminateProcessTree, log, queueSummary,
  sharedSessions: sessionStore.shared,
  pendingAttachments: pendingAttachmentStore,
  cleanupClearedDownloads,
}) : null;
shutdownCallbacks.add(() => claudeBridge?.close());
const antigravityBridge = CONFIG.engine === 'antigravity' ? createAntigravityBridge({
  config: CONFIG, getSession, getChatState, getChats: () => sessions.chats, resetSession, saveSessions, userText: userTextFromContent,
  sendMarkdown, activeChildren, activeJobs: activeCodexJobs, appendText: appendRunText,
  reduceEvent: reduceCodexJsonEvent, markPhase: markRunPhase, ensureDone: ensureRunDone,
  markInterrupted: markRunInterrupted, markError: markRunError, queueSummary, sharedSessions: sessionStore.shared,
  pendingAttachments: pendingAttachmentStore,
  cleanupClearedDownloads,
}) : null;
shutdownCallbacks.add(() => antigravityBridge?.close());
Object.assign(bridgeRuntime, {
  appServerProtocol, appServerResumeParams, appServerStartParams, appServerSteerParams, appServerTurnParams,
  appServerPool, verifiedModels, providerSwitcher, claudeBridge, antigravityBridge,
});

const sessionInventory = createSessionInventory(bridgeRuntime);
Object.assign(bridgeRuntime, sessionInventory);
const { recordFailureStats, syncChatSessionsWithCodex, appendHistory } = sessionInventory;

const codexRunner = createCodexRunner(bridgeRuntime);
Object.assign(bridgeRuntime, codexRunner);
const { maybeRouteMessageToGoal, runCodex } = codexRunner;

const commandRouter = createCommandRouter(bridgeRuntime);
Object.assign(bridgeRuntime, commandRouter);
const { handleCommand, formatAnswer, maybeSendThreadHealthReminder } = commandRouter;

const lifecycle = createBridgeLifecycle(bridgeRuntime);
Object.assign(bridgeRuntime, lifecycle);
const { startConsumer, shutdown } = lifecycle;

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

function cancelQueuedExecution(chatId, { all = false } = {}) {
  return eventDispatcher.cancelForChat(chatId, { all });
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
  void dropPendingAttachmentsByMessageId(messageId, chatId, cleanupClearedDownloads)
    .then((removedItems) => {
      log("INFO", "message recall handled", {
        eventId,
        messageId,
        chatId,
        removedEvents,
        removedAttachments: removedItems.length,
      });
    })
    .catch((error) => {
      log("WARN", "message recall attachment cleanup failed", {
        eventId,
        messageId,
        chatId,
        error: String(error?.message || error).slice(0, 1000),
      });
    });
}

function isLevelCCommand(command) {
  if (!command?.name) return false;
  if (CONFIG.engine === 'claude') {
    return command.name === '/compact'
      || (command.name === '/model' && /^test(?:\s|$)/i.test(String(command.rest || '').trim()));
  }
  if (CONFIG.engine === 'codex') {
    return command.name === '/compact'
      || (command.name === '/model' && /^(?:test|check)(?:\s|$)/i.test(String(command.rest || '').trim()));
  }
  return false;
}

function isOutOfBandCommand(command, event = null) {
  if (!command?.name) return false;
  if (isLevelCCommand(command)) {
    const chatId = event ? chatIdOf(event) : '';
    return Boolean(chatId && activeCodexJobs.has(chatId));
  }
  return true;
}

async function handleOutOfBandCommand(rawEvent, command) {
  const messageId = messageIdOf(rawEvent);
  const dedupeId = eventIdOf(rawEvent) || messageId;
  if (!messageId) {
    log("WARN", "out-of-band command missing message_id", rawEvent);
    return;
  }
  if (!rawEvent._alreadyRemembered && rememberEvent(dedupeId, messageId)) {
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
  const executeCommand = async () => {
    try {
      await prepareCommandAttachments(event, command);
      await handleCommand(event, command);
    } catch (error) {
      log("ERROR", "out-of-band command execution failed", {
        messageId,
        chatId,
        command: command?.name || "",
        error: String(error?.stack || error),
      });
      const detail = truncateCardText(errorText(error), 1200);
      await sendText(chatId, `${ENGINE_LABEL} 指令失败（${command?.name || "/command"}）：${detail}`, "command-error-outer", messageId).catch(() => {});
    }
  };
  if (LEVEL_A_COMMANDS.has(command.name) || command.name === "/steer") {
    await executeCommand();
  } else {
    await chatCommandQueue.enqueue(chatId, executeCommand);
  }
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
  if (!rawEvent._alreadyRemembered && rememberEvent(dedupeId, messageId)) {
    log("INFO", "duplicate event ignored", { dedupeId, messageId });
    return;
  }

  const event = prepareCardEvent(await enrichEvent(rawEvent));
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
  const command = parseEventCommand(event, parseCommand);
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
    try {
      await prepareCommandAttachments(event, command);
      await handleCommand(event, command);
    } catch (error) {
      log("ERROR", "queued command execution failed", {
        messageId,
        chatId,
        command: command?.name || "",
        error: String(error?.stack || error),
      });
      const detail = truncateCardText(errorText(error), 1200);
      await sendText(chatId, `${ENGINE_LABEL} 指令失败（${command?.name || "/command"}）：${detail}`, "command-error-queued", messageId).catch(() => {});
    }
    return;
  }

  if (event.cardReference && !event.cardReadable) {
    await sendText(chatId, "收到了卡片，但飞书没有返回可读取的正文。请复制卡片文字，或发送卡片截图后再告诉我要做什么。", "card-unreadable", messageId);
    return;
  }

  const downloadedAttachments = event.cardReference ? [] : [
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
    const total = await withAttachmentLock(chatId, () => {
      addPendingAttachments(chatId, downloadedAttachments);
      return cleanupPendingAttachments(chatId);
    });
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
    const total = await withAttachmentLock(chatId, () => {
      addPendingAttachments(chatId, downloadedAttachments);
      return cleanupPendingAttachments(chatId);
    });
    await sendText(chatId, `已收到 ${formatAttachmentCounts(total)}，请继续发送文字消息来触发处理。`, "attachment-received", messageId);
    return;
  }

  if (downloadedAttachments.length && !userContent) {
    const total = await withAttachmentLock(chatId, () => {
      addPendingAttachments(chatId, downloadedAttachments);
      return cleanupPendingAttachments(chatId);
    });
    await sendText(chatId, `已收到 ${formatAttachmentCounts(total)}，请继续发送文字消息来触发处理。`, "attachment-received", messageId);
    return;
  }

  const pendingAttachments = await withAttachmentLock(chatId, () => takePendingAttachments(chatId));
  event.attachments = [...pendingAttachments, ...downloadedAttachments];

  if (event.message_type && event.message_type !== "text" && event.message_type !== "post" && !event.cardReadable && !event.attachments.length) {
    await sendText(chatId, `我收到了 ${event.message_type} 消息，但当前桥接版本还不能处理这种类型。`, "unsupported", messageId);
    return;
  }

  await syncChatSessionsWithCodex(chatId, { ensureRunnableCurrent: false, reason: "message-preflight", event });
  const accessCtx = recordChatScope(chatId, event);
  const session = getSession(chatId, accessCtx);
  if (await maybeRouteMessageToGoal(chatId, event, session, userContent, messageId)) {
    return;
  }
  const cardState = createRunState(session, event, userContent);
  let card = null;
  let activeRunRecorded = recordActiveRunSafely({
    chatId,
    messageId,
    sessionId: session.id,
    cardId: "",
    cardMessageId: "",
    startedAt: cardState.startedAt,
  }, "message-start");
  let finalCardFlushOk = true;
  let latestCardState = cardState;
  const updateCard = async (state) => {
    latestCardState = state;
    if (!card) return;
    if (activeRunRecorded && state.terminal === "running") touchActiveRunSafely(messageId);
    if (state.terminal === "done" && !state.formulaRenderComplete) {
      if (!state.formulaRenderPromise) {
        state.formulaRenderPromise = (async () => {
          const formulaStartedAt = Date.now();
          const result = await formulaImageService.enrichBlocks(state.blocks);
          state.blocks = result.blocks;
          state.formulaSources = result.sources;
          state.formulaRenderStats = result.stats;
          state.formulaRenderComplete = true;
          log("INFO", "formula rendering completed", {
            messageId,
            durationMs: Date.now() - formulaStartedAt,
            ...result.stats,
          });
        })().catch((error) => {
          state.formulaRenderComplete = true;
          state.formulaRenderStats = { failed: true };
          log("WARN", "formula rendering pipeline failed; preserving original markdown", {
            messageId,
            error: String(error?.message || error).slice(0, 1200),
          });
        });
      }
      await state.formulaRenderPromise;
    }
    if (card.closed) return;
    const rendered = renderRunCard(state);
    if (state.terminal === "running") {
      card.update(rendered);
    } else {
      const ok = await card.flush(rendered);
      finalCardFlushOk = ok !== false;
      card.close();
    }
  };

  const cardOpenPromise = (async () => {
    if (!CONFIG.useCards) return null;
    const cardOpenStartedAt = Date.now();
    try {
      card = await ManagedCard.open(
        chatId,
        CONFIG.replyToMessage || CONFIG.useThreadReply ? messageId : "",
        renderRunCard(cardState),
        messageId,
      );
      log("INFO", "card opened", {
        messageId,
        cardId: card.cardId,
        cardMessageId: card.messageId,
        cardOpenMs: Date.now() - cardOpenStartedAt,
        parallelWithCodex: true,
      });
      activeRunRecorded = recordActiveRunSafely({
        chatId,
        messageId,
        sessionId: session.id,
        cardId: card.cardId,
        cardMessageId: card.messageId,
        startedAt: cardState.startedAt,
      }, "card-open") || activeRunRecorded;
      await updateCard(latestCardState);
      return card;
    } catch (error) {
      log("WARN", "card open failed; falling back to markdown", {
        messageId,
        cardOpenMs: Date.now() - cardOpenStartedAt,
        error: String(error.message || error).slice(0, 1200),
      });
      return null;
    }
  })();

  try {
    appendHistory(session, "user", userContent || `${event.attachments?.length || 0} attachment(s)`);
    const result = await runCodex(event, session, cardState, updateCard);
    await cardOpenPromise;
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
    if (activeRunRecorded) clearActiveRunSafely(messageId, "answer-completed");
    await maybeSendThreadHealthReminder(chatId, messageId, session, result);
    log("INFO", "message answered", { messageId, sessionId: session.id, durationMs: result.durationMs });
  } catch (error) {
    if (stoppedJobs.has(messageId)) {
      stoppedJobs.delete(messageId);
      markRunInterrupted(cardState);
      await updateCard(cardState);
      await cardOpenPromise;
      log("INFO", "codex job stopped by user", { messageId, chatId });
      return;
    }
    stats.failed += 1;
    if (error && typeof error === "object" && !error.engine && CONFIG.engine) {
      error.engine = CONFIG.engine;
    }
    const failure = classifyCodexFailure(error);
    recordFailureStats(failure);
    markRunError(cardState, error);
    await updateCard(cardState);
    await cardOpenPromise;
    if (card) {
      if (!finalCardFlushOk) {
        await sendMarkdown(
          chatId,
          [
            `**${ENGINE_LABEL} 处理失败**`,
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
          `**${ENGINE_LABEL} 处理失败**`,
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
    await cardOpenPromise;
    if (activeRunRecorded) clearActiveRunSafely(messageId, "message-finally");
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
