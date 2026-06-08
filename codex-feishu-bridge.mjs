#!/usr/bin/env node
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

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
  codexReasoning: process.env.CODEX_FEISHU_REASONING || "xhigh",
  codexTimeoutMs: parseDurationMs(process.env.CODEX_FEISHU_CODEX_TIMEOUT_MS, 0),
  codexIdleTimeoutMs: parseDurationMs(process.env.CODEX_FEISHU_CODEX_IDLE_TIMEOUT_MS, 60 * 60_000),
  disableMcp: (process.env.CODEX_FEISHU_DISABLE_MCP || "0") !== "0",
  maxConcurrent: Number(process.env.CODEX_FEISHU_MAX_CONCURRENT || "1"),
  maxReplyChars: Number(process.env.CODEX_FEISHU_MAX_REPLY_CHARS || "6000"),
  listLimit: Number(process.env.CODEX_FEISHU_LIST_LIMIT || "30"),
  useCards: (process.env.CODEX_FEISHU_CARD_MODE || "1") !== "0",
  cardThrottleMs: Number(process.env.CODEX_FEISHU_CARD_THROTTLE_MS || "400"),
  debugCards: (process.env.CODEX_FEISHU_CARD_DEBUG || "0") === "1",
  showFinalSteps: (process.env.CODEX_FEISHU_SHOW_FINAL_STEPS || "1") === "1",
  replyToMessage: (process.env.CODEX_FEISHU_REPLY_TO_MESSAGE || "0") === "1",
  useThreadReply: (process.env.CODEX_FEISHU_REPLY_IN_THREAD || "0") === "1",
  logDir: process.env.CODEX_FEISHU_LOG_DIR || path.join(DEFAULT_DATA_ROOT, "logs"),
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
  syncSessionsFromCodex: (process.env.CODEX_FEISHU_SYNC_SESSIONS_FROM_CODEX || "1") !== "0",
  keepEmptySessionMs: Number(process.env.CODEX_FEISHU_KEEP_EMPTY_SESSION_MS || `${10 * 60_000}`),
  codexHome: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
};

const logPath = path.join(CONFIG.logDir, "codex-feishu-bridge.log");
const seenPath = path.join(CONFIG.stateDir, "seen-events.json");
const sessionsPath = path.join(CONFIG.stateDir, "sessions.json");
const activeRunsPath = path.join(CONFIG.stateDir, "active-runs.json");
const pidPath = path.join(CONFIG.stateDir, "bridge.pid");
const lockPath = path.join(CONFIG.stateDir, "bridge.lock.json");
const stopPath = path.join(CONFIG.stateDir, "bridge.stop");
const eventLocksDir = path.join(CONFIG.stateDir, "event-locks");
const runtimeDir = path.join(CONFIG.workspace, ".codex-feishu-runtime");
const outputDir = path.join(runtimeDir, "codex-output");
const promptDir = path.join(runtimeDir, "codex-prompts");
const attachmentDir = path.join(CONFIG.workspace, CONFIG.attachmentRelDir);
const codexStateDbPath = path.join(CONFIG.codexHome, "state_5.sqlite");
const codexReasoningLabel = CONFIG.codexReasoning || "config";
const codexModelLabel = CONFIG.codexModel || resolveCodexConfigModel() || "默认模型";

fs.mkdirSync(CONFIG.logDir, { recursive: true });
fs.mkdirSync(CONFIG.stateDir, { recursive: true });
fs.mkdirSync(eventLocksDir, { recursive: true });
fs.mkdirSync(outputDir, { recursive: true });
fs.mkdirSync(promptDir, { recursive: true });
fs.mkdirSync(attachmentDir, { recursive: true });
acquireSingleInstanceLock();
try {
  fs.rmSync(stopPath, { force: true });
} catch {}
fs.writeFileSync(pidPath, String(process.pid), "utf8");

const shutdownCallbacks = new Set();
const activeChildren = new Map();
const activeCodexJobs = new Map();
const pendingAttachmentsByChat = new Map();
const pendingDeleteConfirmations = new Map();
const stoppedJobs = new Set();
const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const FAST_SERVICE_TIER = "fast";
const STANDARD_SERVICE_TIER = "standard";
let shuttingDown = false;
let activeJobs = 0;
const pendingEvents = [];
const recalledMessages = new Map();
const seen = loadSeen();
const sessions = loadSessions();
const activeRuns = loadActiveRuns();
cleanupOldEventLocks();
const stats = {
  startedAt: Date.now(),
  events: 0,
  commands: 0,
  answered: 0,
  failed: 0,
  recovered: 0,
  failuresByKind: {},
};

function resolveDefaultTools() {
  if (process.platform !== "win32") {
    return {
      larkCli: { command: "lark-cli", argsPrefix: [] },
      codexCli: { command: "codex", argsPrefix: [] },
    };
  }

  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const npmRoot = path.join(appData, "npm", "node_modules");
  const larkEntry = path.join(npmRoot, "@larksuite", "cli", "scripts", "run.js");
  const codexEntry = path.join(npmRoot, "@openai", "codex", "bin", "codex.js");
  return {
    larkCli: fs.existsSync(larkEntry)
      ? { command: process.execPath, argsPrefix: [larkEntry] }
      : { command: "cmd.exe", argsPrefix: ["/d", "/s", "/c", "lark-cli.cmd"] },
    codexCli: fs.existsSync(codexEntry)
      ? { command: process.execPath, argsPrefix: [codexEntry] }
      : { command: "cmd.exe", argsPrefix: ["/d", "/s", "/c", "codex.cmd"] },
  };
}

function resolveDefaultDataRoot() {
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "CodexFeishuBridge",
    );
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "CodexFeishuBridge");
  }

  return path.join(
    process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
    "codex-feishu-bridge",
  );
}

function parseToolEnv(envName, fallback) {
  const value = process.env[envName];
  if (!value) return fallback;
  if (process.platform === "win32") {
    const lower = value.toLowerCase();
    if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
      return { command: "cmd.exe", argsPrefix: ["/d", "/s", "/c", value] };
    }
    if (lower.endsWith(".ps1")) {
      return {
        command: "powershell.exe",
        argsPrefix: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", value],
      };
    }
  }
  return { command: value, argsPrefix: [] };
}

function parseEventKeys(value) {
  const keys = String(value || "")
    .split(/[,\s;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const unique = [...new Set(keys)];
  return unique.length ? unique : ["im.message.receive_v1"];
}

function parseDurationMs(value, fallbackMs) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return fallbackMs;
  if (["0", "none", "never", "infinite", "infinity", "off", "disabled", "false"].includes(raw)) return 0;
  const match = raw.match(/^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h)?$/);
  if (!match) return fallbackMs;
  const number = Number(match[1]);
  if (!Number.isFinite(number) || number < 0) return fallbackMs;
  const unit = match[2] || "ms";
  const factor = unit === "h" ? 60 * 60_000 : unit === "m" ? 60_000 : unit === "s" ? 1000 : 1;
  return Math.round(number * factor);
}

function hasDuration(ms) {
  return Number.isFinite(ms) && ms > 0;
}

function durationConfigLabel(ms) {
  return hasDuration(ms) ? `${Math.round(ms / 1000)}s` : "disabled";
}

function clearTimer(timer) {
  if (timer) clearTimeout(timer);
}

function withLarkProfile(tool, profile) {
  const name = String(profile || "").trim();
  if (!name) return tool;
  return { ...tool, argsPrefix: [...(tool.argsPrefix || []), "--profile", name] };
}

function normalizeRunMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (["exec", "cli"].includes(mode)) return "exec";
  if (["app-server", "appserver", "native", "native-app"].includes(mode)) return "app-server";
  if (["auto", "fallback"].includes(mode)) return "auto";
  return "app-server";
}

function codexUserConfigPath() {
  return path.join(CONFIG.codexHome, "config.toml");
}

function readCodexConfigText() {
  try {
    return fs.readFileSync(codexUserConfigPath(), "utf8");
  } catch {
    return "";
  }
}

function resolveCodexConfigModel() {
  return resolveCodexConfigValue("model");
}

function resolveCodexConfigValue(key) {
  const text = readCodexConfigText();
  if (!text) return "";
  const escaped = escapeRegExp(key);
  const match = text.match(new RegExp(`^\\s*${escaped}\\s*=\\s*([\"'])(.*?)\\1\\s*(?:#.*)?$`, "m"));
  return match?.[2]?.trim() || "";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compactProviderInfo(info) {
  if (!info) return null;
  const envKey = String(info.envKey || "").trim();
  return {
    id: String(info.id || "").trim(),
    name: String(info.name || info.id || "").trim(),
    baseUrl: String(info.baseUrl || "").trim(),
    envKey,
    requiresOpenaiAuth: Boolean(info.requiresOpenaiAuth),
    envVisible: envKey ? Object.prototype.hasOwnProperty.call(process.env, envKey) : null,
    builtIn: Boolean(info.builtIn),
  };
}

function listCodexProviders() {
  const providers = new Map();
  const add = (info) => {
    const item = compactProviderInfo(info);
    if (item?.id) providers.set(item.id, item);
  };
  add({ id: "openai", name: "OpenAI", requiresOpenaiAuth: true, builtIn: true });
  add({ id: "ollama", name: "Ollama", builtIn: true });
  add({ id: "lmstudio", name: "LM Studio", builtIn: true });
  add({ id: "amazon-bedrock", name: "Amazon Bedrock", builtIn: true });

  const text = readCodexConfigText();
  const tableRe = /^\s*\[model_providers\.([A-Za-z0-9_-]+)\]\s*$/gm;
  const matches = [...text.matchAll(tableRe)];
  for (let i = 0; i < matches.length; i += 1) {
    const id = matches[i][1];
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const body = text.slice(start, end);
    add({
      id,
      name: tomlStringValue(body, "name") || id,
      baseUrl: tomlStringValue(body, "base_url"),
      envKey: tomlStringValue(body, "env_key"),
      requiresOpenaiAuth: tomlBooleanValue(body, "requires_openai_auth"),
      builtIn: false,
    });
  }
  return [...providers.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function findCodexProvider(id) {
  const target = String(id || "").trim();
  if (!target) return null;
  return listCodexProviders().find((item) => item.id === target) || null;
}

function tomlStringValue(text, key) {
  const match = String(text || "").match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*([\"'])(.*?)\\1\\s*(?:#.*)?$`, "m"));
  return match?.[2]?.trim() || "";
}

function tomlBooleanValue(text, key) {
  const match = String(text || "").match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(true|false)\\s*(?:#.*)?$`, "mi"));
  return match ? match[1].toLowerCase() === "true" : false;
}

function cleanOverride(value) {
  const text = String(value || "").trim();
  return text || "";
}

function effectiveSessionSettings(session) {
  const model = cleanOverride(session?.modelOverride) || CONFIG.codexModel || resolveCodexConfigValue("model") || "";
  const provider = cleanOverride(session?.providerOverride) || resolveCodexConfigValue("model_provider") || "openai";
  const reasoning = cleanOverride(session?.reasoningOverride) || CONFIG.codexReasoning || resolveCodexConfigValue("model_reasoning_effort") || "";
  const serviceTier = cleanOverride(session?.serviceTierOverride) || resolveCodexConfigValue("service_tier") || "";
  return { model, provider, reasoning, serviceTier };
}

function settingsSummary(session) {
  const settings = effectiveSessionSettings(session);
  return [
    `provider \`${settings.provider || "默认"}\``,
    `model \`${settings.model || "默认"}\``,
    `reasoning \`${settings.reasoning || "默认"}\``,
    `speed \`${displayServiceTier(settings.serviceTier) || "默认"}\``,
  ].join(" · ");
}

function displayServiceTier(value) {
  const tier = cleanOverride(value);
  if (!tier) return "";
  if (tier === FAST_SERVICE_TIER || tier === "priority") return "fast";
  if (tier === STANDARD_SERVICE_TIER) return "standard";
  return tier;
}

function applySessionThreadOverrides(params, session) {
  const settings = effectiveSessionSettings(session);
  if (settings.model) params.model = settings.model;
  if (settings.provider) params.modelProvider = settings.provider;
  if (settings.serviceTier) params.serviceTier = settings.serviceTier;
  return params;
}

function applySessionTurnOverrides(params, session) {
  const settings = effectiveSessionSettings(session);
  if (settings.model) params.model = settings.model;
  if (settings.serviceTier) params.serviceTier = settings.serviceTier;
  if (settings.reasoning) params.effort = settings.reasoning;
  return params;
}

function setSessionOverride(session, key, value) {
  session[key] = cleanOverride(value);
  session.updatedAt = Date.now();
  saveSessions();
}

function nowIso() {
  return new Date().toISOString();
}

function log(level, message, meta = undefined) {
  const line = meta === undefined
    ? `${nowIso()} ${level} ${message}`
    : `${nowIso()} ${level} ${message} ${safeJson(meta)}`;
  fs.appendFileSync(logPath, `${line}\n`, "utf8");
  const stream = level === "ERROR" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorText(value, fallback = "Codex 运行失败") {
  if (value instanceof Error) return value.message || fallback;
  if (typeof value === "string") return value || fallback;
  if (!value || typeof value !== "object") return String(value || fallback);

  const parts = [];
  const message = value.message;
  if (typeof message === "string") parts.push(message);
  else if (message && typeof message === "object") parts.push(errorText(message, ""));

  const error = value.error;
  if (typeof error === "string") parts.push(error);
  else if (error && typeof error === "object") parts.push(errorText(error, ""));

  if (typeof value.additionalDetails === "string") parts.push(value.additionalDetails);
  if (value.codexErrorInfo) parts.push(`codexErrorInfo: ${safeJson(value.codexErrorInfo)}`);
  if (value.threadId) parts.push(`threadId: ${value.threadId}`);
  if (value.turnId) parts.push(`turnId: ${value.turnId}`);
  if (value.willRetry !== undefined) parts.push(`willRetry: ${value.willRetry}`);

  const text = parts.filter(Boolean).join("\n");
  return text || safeJson(value) || fallback;
}

function classifyCodexFailure(value, fallback = "Codex 运行失败") {
  if (value?.codexFailure) return normalizeFailure(value.codexFailure);

  const detail = errorText(value, fallback);
  const lower = detail.toLowerCase();
  const httpStatus = httpStatusFromText(detail);
  const base = {
    kind: "unknown",
    label: "未知错误",
    recoverable: false,
    message: "Codex 运行失败，但 Bridge 无法明确判断原因。",
    suggestion: "查看日志中的原始错误；如果是偶发问题，可以手动重试。",
    detail,
    at: Date.now(),
  };

  if (lower.includes("stopped by user") || lower.includes("已停止") || lower.includes("interrupted")) {
    return { ...base, kind: "user_stop", label: "用户停止", message: "任务已被用户停止。", suggestion: "" };
  }

  if (
    httpStatus === 401
    || lower.includes("invalid_api_key")
    || lower.includes("invalid api key")
    || lower.includes("unauthorized")
    || lower.includes("not logged in")
    || lower.includes("authentication")
  ) {
    return {
      ...base,
      kind: "auth",
      label: "Codex 鉴权失败",
      message: "Codex 登录或 API Key 鉴权失败。",
      suggestion: "这类失败不自动续跑；需要先修复 Codex 登录/API Key。",
    };
  }

  if (
    lower.includes("insufficient_quota")
    || lower.includes("quota")
    || lower.includes("billing")
    || lower.includes("credit")
    || lower.includes("usage limit")
    || lower.includes("budget")
  ) {
    return {
      ...base,
      kind: "quota",
      label: "Codex 额度不足",
      message: "Codex 额度、账单或预算限制导致任务停止。",
      suggestion: "这类失败不自动续跑；需要补充额度或调整账号限制后再继续。",
    };
  }

  if (httpStatus === 429 || lower.includes("rate limit") || lower.includes("rate_limit") || lower.includes("too many requests")) {
    return {
      ...base,
      kind: "rate_limit",
      label: "Codex 限流",
      message: "Codex 上游限流，当前不适合立即自动续跑。",
      suggestion: "稍后手动重试，或降低并发。",
    };
  }

  if (lower.includes("card update failed") || lower.includes("cardkit") || lower.includes("lark-cli failed")) {
    return {
      ...base,
      kind: "feishu_card",
      label: "飞书卡片更新失败",
      message: "Codex 可能仍在运行，但飞书动态卡片刷新失败。",
      suggestion: "这类问题应重试发卡或看日志，不应该重跑 Codex 任务。",
    };
  }

  if (lower.includes("timed out")) {
    return {
      ...base,
      kind: "timeout",
      label: "Bridge 超时",
      message: "Bridge 等待 Codex 任务超过配置时限。",
      suggestion: "如果任务确实很长，可以调大超时；否则查看 Codex 是否卡住。",
    };
  }

  if (
    lower.includes("responsestreamdisconnected")
    || lower.includes("responsesstreamdisconnected")
    || lower.includes("stream disconnected before completion")
    || lower.includes("transport error")
    || lower.includes("network error")
    || lower.includes("error decoding response body")
  ) {
    return {
      ...base,
      kind: "stream_disconnect",
      label: "Codex 流式连接断开",
      recoverable: true,
      message: "Codex 原生输出流在完成前断开。",
      suggestion: "Bridge 会等待原生重连；如果最终仍失败，仅对这类断流尝试一次断点续跑。",
    };
  }

  if (lower.includes("ended before turn completed") || lower.includes("app-server exited")) {
    return {
      ...base,
      kind: "app_server",
      label: "Codex app-server 提前结束",
      message: "Codex app-server 在 turn 完成前结束。",
      suggestion: "查看 app-server stderr；如果前面出现过断流，可尝试手动继续。",
    };
  }

  return base;
}

function httpStatusFromText(text) {
  const value = String(text || "");
  const match = value.match(/httpStatusCode["']?\s*[:=]\s*(\d{3})/i)
    || value.match(/\b(\d{3})\s+(?:Unauthorized|Too Many Requests|Forbidden|Payment Required)\b/i);
  return match ? Number(match[1]) : null;
}

function failureDetailText(failure) {
  const item = normalizeFailure(failure) || classifyCodexFailure(failure);
  const parts = [
    `类型：${item.label}`,
    item.message,
    item.suggestion ? `建议：${item.suggestion}` : "",
    "",
    item.detail,
  ].filter((line) => line !== "");
  return parts.join("\n");
}

function failureShortText(failure) {
  const item = normalizeFailure(failure) || classifyCodexFailure(failure);
  return item.suggestion ? `${item.label}：${item.message} ${item.suggestion}` : `${item.label}：${item.message}`;
}

function errorFromFailure(failure) {
  const item = normalizeFailure(failure) || classifyCodexFailure(failure);
  const error = new Error(failureDetailText(item));
  error.codexFailure = item;
  return error;
}

function recordFailureStats(failure) {
  const item = normalizeFailure(failure) || classifyCodexFailure(failure);
  stats.failuresByKind[item.kind] = (stats.failuresByKind[item.kind] || 0) + 1;
}

function loadSeen() {
  try {
    const parsed = JSON.parse(fs.readFileSync(seenPath, "utf8"));
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function saveSeen() {
  const last = [...seen].slice(-1000);
  fs.writeFileSync(seenPath, JSON.stringify(last, null, 2), "utf8");
}

function loadActiveRuns() {
  try {
    const parsed = JSON.parse(fs.readFileSync(activeRunsPath, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.runs && typeof parsed.runs === "object") return parsed;
  } catch {}
  return { runs: {} };
}

function saveActiveRuns() {
  fs.writeFileSync(activeRunsPath, JSON.stringify(activeRuns, null, 2), "utf8");
}

function remember(id) {
  if (!id) return false;
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > 1200) {
    const trimmed = [...seen].slice(-1000);
    seen.clear();
    for (const item of trimmed) seen.add(item);
  }
  saveSeen();
  return false;
}

function eventLockPath(id) {
  const hash = crypto.createHash("sha256").update(String(id || "")).digest("hex").slice(0, 32);
  return path.join(eventLocksDir, `${hash}.json`);
}

function cleanupOldEventLocks() {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  try {
    for (const entry of fs.readdirSync(eventLocksDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const file = path.join(eventLocksDir, entry.name);
      const stat = fs.statSync(file);
      if (stat.mtimeMs < cutoff) fs.rmSync(file, { force: true });
    }
  } catch (error) {
    log("WARN", "event lock cleanup failed", { error: String(error.message || error) });
  }
}

function rememberEvent(id, messageId = "") {
  if (!id) return false;
  if (seen.has(id)) return true;

  const file = eventLockPath(id);
  try {
    const fd = fs.openSync(file, "wx");
    fs.writeFileSync(fd, JSON.stringify({
      id,
      messageId,
      pid: process.pid,
      instance: process.env.CODEX_FEISHU_INSTANCE_NAME || "",
      createdAt: Date.now(),
    }, null, 2), "utf8");
    fs.closeSync(fd);
  } catch (error) {
    if (error?.code === "EEXIST") return true;
    log("WARN", "event lock failed; falling back to local dedupe", {
      id,
      messageId,
      error: String(error.message || error),
    });
  }

  remember(id);
  return false;
}

function eventTypeOf(event) {
  return String(
    event?.event_type
      || event?.type
      || event?.header?.event_type
      || event?.event?.event_type
      || findDeepKey(event, "event_type")
      || "",
  ).trim();
}

function eventIdOf(event) {
  return String(
    event?.event_id
      || event?.header?.event_id
      || event?.event?.event_id
      || findDeepKey(event, "event_id")
      || "",
  ).trim();
}

function messageIdOf(event) {
  return String(
    event?.message_id
      || event?.event?.message_id
      || event?.message?.message_id
      || findDeepKey(event, "message_id")
      || findDeepKey(event, "messageId")
      || event?.id
      || "",
  ).trim();
}

function chatIdOf(event) {
  return String(
    event?.chat_id
      || event?.event?.chat_id
      || event?.message?.chat_id
      || findDeepKey(event, "chat_id")
      || findDeepKey(event, "chatId")
      || "",
  ).trim();
}

function isRecallEvent(event) {
  const type = eventTypeOf(event);
  return type === "im.message.recalled_v1" || Boolean(event?.recall_time || event?.event?.recall_time);
}

function isProcessAlive(pid) {
  const number = Number(pid);
  if (!Number.isInteger(number) || number <= 0) return false;
  try {
    process.kill(number, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function acquireSingleInstanceLock() {
  const owner = {
    pid: process.pid,
    instance: process.env.CODEX_FEISHU_INSTANCE_NAME || "",
    workspace: CONFIG.workspace,
    larkProfile: CONFIG.larkProfile || "default",
    startedAt: Date.now(),
  };

  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, JSON.stringify(owner, null, 2), "utf8");
      fs.closeSync(fd);
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const current = readJsonFile(lockPath);
      if (current?.pid && isProcessAlive(current.pid)) {
        log("ERROR", "another bridge instance is already running for this state dir", {
          currentPid: current.pid,
          currentInstance: current.instance || "",
          currentWorkspace: current.workspace || "",
          pid: process.pid,
          lockPath,
        });
        process.exit(0);
      }
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {}
    }
  }
}

function releaseSingleInstanceLock() {
  try {
    const current = readJsonFile(lockPath);
    if (String(current?.pid || "") === String(process.pid)) {
      fs.rmSync(lockPath, { force: true });
    }
  } catch {}
}

function loadSessions() {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.chats) return parsed;
  } catch {}
  return { chats: {} };
}

function saveSessions() {
  fs.writeFileSync(sessionsPath, JSON.stringify(sessions, null, 2), "utf8");
}

function getSession(chatId) {
  const chatState = getChatState(chatId);
  let session = chatState.sessions.find((item) => item.id === chatState.currentSessionId);
  if (!session) {
    session = chatState.sessions[0] || createSessionData("默认会话");
    if (!chatState.sessions.includes(session)) chatState.sessions.unshift(session);
    chatState.currentSessionId = session.id;
    saveSessions();
  }
  return session;
}

function resetSession(chatId, title = "") {
  const session = createSessionData(title || "新会话");
  const chatState = getChatState(chatId);
  chatState.currentSessionId = session.id;
  chatState.sessions.unshift(session);
  chatState.sessions = dedupeSessions(chatState.sessions).slice(0, 20);
  saveSessions();
  return session;
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

function getChatState(chatId) {
  const current = sessions.chats[chatId];
  if (!current) {
    const session = createSessionData("默认会话");
    sessions.chats[chatId] = {
      currentSessionId: session.id,
      sessions: [session],
    };
    saveSessions();
    return sessions.chats[chatId];
  }

  if (Array.isArray(current.sessions)) {
    current.sessions = dedupeSessions(current.sessions.map(normalizeSessionData)).slice(0, 20);
    if (!current.currentSessionId && current.sessions[0]) current.currentSessionId = current.sessions[0].id;
    return current;
  }

  if (current.id) {
    const migrated = normalizeSessionData(current);
    sessions.chats[chatId] = {
      currentSessionId: migrated.id,
      sessions: [migrated],
    };
    saveSessions();
    return sessions.chats[chatId];
  }

  const session = createSessionData("默认会话");
  sessions.chats[chatId] = {
    currentSessionId: session.id,
    sessions: [session],
  };
  saveSessions();
  return sessions.chats[chatId];
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
    serviceTierOverride: cleanOverride(session?.serviceTierOverride),
  };
}

function normalizeGoal(value) {
  if (!value || typeof value !== "object") return null;
  const objective = String(value.objective || "").trim();
  if (!objective) return null;
  const status = String(value.status || "active");
  return {
    threadId: String(value.threadId || ""),
    objective,
    status,
    tokenBudget: Number.isFinite(Number(value.tokenBudget)) ? Number(value.tokenBudget) : null,
    tokensUsed: Number(value.tokensUsed) || 0,
    timeUsedSeconds: Number(value.timeUsedSeconds) || 0,
    createdAt: normalizeTimestamp(value.createdAt),
    updatedAt: normalizeTimestamp(value.updatedAt) || Date.now(),
  };
}

function normalizeTimestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number < 10_000_000_000 ? number * 1000 : number;
}

function normalizeFailure(value) {
  if (!value || typeof value !== "object") return null;
  const kind = String(value.kind || "").trim();
  if (!kind) return null;
  return {
    kind,
    label: String(value.label || kind),
    recoverable: Boolean(value.recoverable),
    message: String(value.message || ""),
    suggestion: String(value.suggestion || ""),
    detail: String(value.detail || ""),
    at: Number(value.at) || Date.now(),
  };
}

function normalizeTokenUsage(value) {
  if (!value || typeof value !== "object") return null;
  const total = normalizeTokenUsageBreakdown(value.total);
  const last = normalizeTokenUsageBreakdown(value.last);
  const modelContextWindow = Number(value.modelContextWindow);
  return {
    total,
    last,
    modelContextWindow: Number.isFinite(modelContextWindow) && modelContextWindow > 0 ? modelContextWindow : null,
  };
}

function normalizeTokenUsageBreakdown(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    totalTokens: Number(source.totalTokens) || 0,
    inputTokens: Number(source.inputTokens) || 0,
    cachedInputTokens: Number(source.cachedInputTokens) || 0,
    outputTokens: Number(source.outputTokens) || 0,
    reasoningOutputTokens: Number(source.reasoningOutputTokens) || 0,
  };
}

function normalizeContextUsage(value) {
  if (!value || typeof value !== "object") return null;
  const usedTokens = Number(value.usedTokens);
  const contextWindow = Number(value.contextWindow);
  const percent = Number(value.percent);
  if (!Number.isFinite(usedTokens) && !Number.isFinite(contextWindow) && !Number.isFinite(percent)) return null;
  return {
    usedTokens: Number.isFinite(usedTokens) ? usedTokens : null,
    contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null,
    percent: Number.isFinite(percent) ? percent : null,
    updatedAt: Number(value.updatedAt) || Date.now(),
  };
}

function contextUsageFromTokenUsage(value) {
  const usage = normalizeTokenUsage(value);
  if (!usage) return null;
  const last = usage.last || {};
  const contextWindow = Number(usage.modelContextWindow) || 0;
  const rawUsedTokens = Number(last.totalTokens) || Number(last.inputTokens) + Number(last.outputTokens) || 0;
  const usedTokens = contextWindow > 0 ? Math.min(rawUsedTokens, contextWindow) : rawUsedTokens;
  const percent = contextWindow > 0 ? Math.round((usedTokens / contextWindow) * 1000) / 10 : null;
  return normalizeContextUsage({
    usedTokens,
    contextWindow: contextWindow || null,
    percent,
    updatedAt: Date.now(),
  });
}

function maxContextUsage(current, candidate) {
  const currentUsage = normalizeContextUsage(current);
  const candidateUsage = normalizeContextUsage(candidate);
  if (!candidateUsage) return currentUsage;
  if (!currentUsage) return candidateUsage;

  const currentScore = Number.isFinite(Number(currentUsage.percent))
    ? Number(currentUsage.percent)
    : Number(currentUsage.usedTokens) || 0;
  const candidateScore = Number.isFinite(Number(candidateUsage.percent))
    ? Number(candidateUsage.percent)
    : Number(candidateUsage.usedTokens) || 0;
  return candidateScore >= currentScore ? candidateUsage : currentUsage;
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
  chatState.sessions = dedupeSessions(chatState.sessions).slice(0, 20);
  saveSessions();
  return chatState.sessions;
}

function boundedListLimit(value = CONFIG.listLimit) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 30;
  return Math.max(1, Math.min(200, Math.floor(number)));
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
      "select id, title, first_user_message, preview, rollout_path,",
      "created_at, updated_at, created_at_ms, updated_at_ms,",
      "tokens_used, source, model_provider, thread_source",
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

function shouldKeepEmptyCurrentSession(session, chatState) {
  if (!session || session.id !== chatState.currentSessionId) return false;
  if (String(session.codexThreadId || "").trim()) return false;
  if (Array.isArray(session.messages) && session.messages.length > 0) return false;
  const createdAt = Number(session.createdAt || session.updatedAt || 0);
  const ageMs = Date.now() - createdAt;
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= CONFIG.keepEmptySessionMs;
}

async function syncChatSessionsWithCodex(chatId, options = {}) {
  const keepEmptyCurrent = options.keepEmptyCurrent !== false;
  if (!CONFIG.syncSessionsFromCodex) return sessions.chats[chatId]?.sessions || [];
  const chatState = sessions.chats[chatId];
  if (!chatState || !Array.isArray(chatState.sessions)) return [];

  const visibleThreadIds = await loadVisibleCodexThreadIds();
  if (!visibleThreadIds) return chatState.sessions;

  const before = chatState.sessions.length;
  const beforeCurrent = chatState.currentSessionId || "";
  const normalized = dedupeSessions(chatState.sessions.map(normalizeSessionData)).slice(0, 20);
  chatState.sessions = normalized.filter((session) => {
    const threadId = String(session.codexThreadId || "").trim();
    if (threadId) return visibleThreadIds.has(threadId);
    return keepEmptyCurrent && shouldKeepEmptyCurrentSession(session, chatState);
  });

  if (!chatState.sessions.some((session) => session.id === chatState.currentSessionId)) {
    chatState.currentSessionId = chatState.sessions[0]?.id || "";
  }

  const changed = before !== chatState.sessions.length
    || beforeCurrent !== (chatState.currentSessionId || "")
    || normalized.length !== before;
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

function sessionEntryFromCodexThread(row) {
  const threadId = String(row?.id || "").trim();
  const createdAt = codexThreadTime(row, "created") || Date.now();
  const updatedAt = codexThreadTime(row, "updated") || createdAt;
  return {
    ...normalizeSessionData({
      id: threadId.slice(0, 8),
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

    const normalized = dedupeSessions(chatState.sessions.map(normalizeSessionData)).slice(0, 20);
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
  const visibleThreadIds = codexThreads
    ? new Set(codexThreads.map((row) => String(row.id || "").trim()).filter(Boolean))
    : null;
  const entries = bridgeSessionEntries(chatId, visibleThreadIds);
  const seenThreads = new Set(entries.map((session) => String(session.codexThreadId || "").trim()).filter(Boolean));
  const seenSessionKeys = new Set(entries.map((session) => `${session._sourceChatId}:${session.id}`));

  if (Array.isArray(codexThreads)) {
    for (const row of codexThreads) {
      const threadId = String(row?.id || "").trim();
      if (!threadId || seenThreads.has(threadId)) continue;
      const entry = sessionEntryFromCodexThread(row);
      const key = `${entry._sourceChatId}:${entry.id}`;
      if (seenSessionKeys.has(key)) continue;
      seenThreads.add(threadId);
      seenSessionKeys.add(key);
      entries.push(entry);
    }
  }

  return entries
    .sort((a, b) => (a._rank - b._rank) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .slice(0, boundedListLimit());
}

async function listChatSessionsSynced(chatId) {
  await syncChatSessionsWithCodex(chatId);
  const chatState = getChatState(chatId);
  chatState.sessions = dedupeSessions(chatState.sessions.map(normalizeSessionData)).slice(0, 20);
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
  chatState.sessions = dedupeSessions(chatState.sessions).slice(0, 20);
  saveSessions();
  return match;
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

function runTool(tool, args, options = {}) {
  const finalArgs = [...tool.argsPrefix, ...args];
  const child = spawn(tool.command, finalArgs, {
    cwd: options.cwd || CONFIG.workspace,
    env: { ...process.env, ...(options.env || {}) },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  activeChildren.set(child.pid, { child, label: `${tool.command} ${finalArgs.join(" ")}` });
  options.onSpawn?.(child);

  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

  if (options.stdin) {
    child.stdin.end(options.stdin);
  } else {
    child.stdin.end();
  }

  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          terminateProcessTree(child.pid, false);
          setTimeout(() => terminateProcessTree(child.pid, true), 5000).unref?.();
        }, options.timeoutMs)
      : null;

    child.on("error", reject);
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      activeChildren.delete(child.pid);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      resolve({ code, stdout, stderr, timedOut, pid: child.pid });
    });
  });
}

async function runLark(args, options = {}) {
  const attempts = options.attempts ?? 3;
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await runTool(CONFIG.larkCli, args, { timeoutMs: options.timeoutMs || 60_000 });
    if (last.code === 0) return last;
    if (attempt < attempts && isTransientLarkError(last)) {
      await delay(1500 * attempt);
      continue;
    }
    return last;
  }
  return last;
}

function isTransientLarkError(result) {
  const text = `${result?.stderr || ""}\n${result?.stdout || ""}`;
  return /connectex|ECONN|ETIMEDOUT|open\.feishu\.cn|tenant_access_token|socket/i.test(text);
}

function terminateProcessTree(pid, force) {
  if (!pid) return;
  if (process.platform === "win32") {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    const killer = spawn("taskkill.exe", args, {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => {});
    return;
  }
  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
  } catch {}
}

async function sendText(chatId, text, idempotencySuffix, baseId = chatId) {
  const chunks = splitText(text, CONFIG.maxReplyChars);
  for (let i = 0; i < chunks.length; i += 1) {
    const result = await runLark([
      "im",
      "+messages-send",
      "--as",
      "bot",
      "--chat-id",
      chatId,
      "--text",
      chunks[i],
      "--idempotency-key",
      idempotencyKey(baseId, `${idempotencySuffix}-text-${i}`),
    ]);
    if (result.code !== 0) throw new Error(`lark-cli send failed (${result.code}): ${result.stderr || result.stdout}`);
  }
}

async function sendMarkdown(chatId, markdown, idempotencySuffix, baseId = chatId) {
  const chunks = splitText(markdown, CONFIG.maxReplyChars);
  for (let i = 0; i < chunks.length; i += 1) {
    const result = await runLark([
      "im",
      "+messages-send",
      "--as",
      "bot",
      "--chat-id",
      chatId,
      "--markdown",
      chunks[i],
      "--idempotency-key",
      idempotencyKey(baseId, `${idempotencySuffix}-md-${i}`),
    ]);
    if (result.code !== 0) throw new Error(`lark-cli markdown send failed (${result.code}): ${result.stderr || result.stdout}`);
  }
}

async function replyFallback(messageId, text, idempotencySuffix) {
  const chunks = splitText(text, CONFIG.maxReplyChars);
  for (let i = 0; i < chunks.length; i += 1) {
    const args = [
      "im",
      "+messages-reply",
      "--as",
      "bot",
      "--message-id",
      messageId,
      "--text",
      chunks[i],
      "--idempotency-key",
      idempotencyKey(messageId, `${idempotencySuffix}-${i}`),
    ];
    if (CONFIG.useThreadReply) args.push("--reply-in-thread");
    const result = await runLark(args);
    if (result.code !== 0) throw new Error(`lark-cli reply failed (${result.code}): ${result.stderr || result.stdout}`);
  }
}

function parseJsonLoose(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function findDeepKey(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDeepKey(item, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const item of Object.values(value)) {
    const found = findDeepKey(item, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function larkJson(args, options = {}) {
  const result = await runLark(args, options);
  if (result.code !== 0) {
    throw new Error(`lark-cli failed (${result.code}): ${result.stderr || result.stdout}`);
  }
  return parseJsonLoose(result.stdout) || {};
}

class ManagedCard {
  constructor(cardId, messageId) {
    this.cardId = cardId;
    this.messageId = messageId;
    this.sequence = 0;
    this.pendingCard = null;
    this.pendingTimer = null;
    this.inFlight = null;
    this.closed = false;
    this.lastFlushOk = true;
  }

  static async open(chatId, replyToMessageId, initialCard, idempotencyBase) {
    const created = await larkJson([
      "api",
      "POST",
      "/open-apis/cardkit/v1/cards",
      "--as",
      "bot",
      "--data",
      JSON.stringify({ type: "card_json", data: JSON.stringify(initialCard) }),
    ], { timeoutMs: 60_000, attempts: 2 });

    const cardId = findDeepKey(created, "card_id");
    if (!cardId) {
      throw new Error(`CardKit create returned no card_id: ${JSON.stringify(created).slice(0, 500)}`);
    }

    const content = JSON.stringify({ type: "card", data: { card_id: cardId } });
    let sent;
    if (replyToMessageId) {
      const args = [
        "im",
        "+messages-reply",
        "--as",
        "bot",
        "--message-id",
        replyToMessageId,
        "--msg-type",
        "interactive",
        "--content",
        content,
        "--idempotency-key",
        idempotencyKey(idempotencyBase, "card-reply"),
      ];
      if (CONFIG.useThreadReply) args.push("--reply-in-thread");
      try {
        sent = await larkJson(args, { timeoutMs: 60_000, attempts: 2 });
      } catch (error) {
        log("WARN", "card reply failed; falling back to chat send", { error: String(error.message || error) });
      }
    }

    if (!sent) {
      sent = await larkJson([
        "im",
        "+messages-send",
        "--as",
        "bot",
        "--chat-id",
        chatId,
        "--msg-type",
        "interactive",
        "--content",
        content,
        "--idempotency-key",
        idempotencyKey(idempotencyBase, "card-send"),
      ], { timeoutMs: 60_000, attempts: 2 });
    }

    const messageId = findDeepKey(sent, "message_id") || "";
    return new ManagedCard(cardId, messageId);
  }

  update(card) {
    if (this.closed) return;
    this.pendingCard = card;
    if (this.pendingTimer || this.inFlight) return;
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      void this.flush();
    }, CONFIG.cardThrottleMs);
  }

  async flush(card) {
    if (this.closed) return;
    if (card) this.pendingCard = card;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (this.inFlight) {
      await this.inFlight.catch(() => {});
    }
    if (!this.pendingCard) return true;

    const next = this.pendingCard;
    this.pendingCard = null;
    const sequence = ++this.sequence;
    this.inFlight = (async () => {
      try {
        await larkJson([
          "api",
          "PUT",
          `/open-apis/cardkit/v1/cards/${this.cardId}`,
          "--as",
          "bot",
          "--data",
          JSON.stringify({
            card: { type: "card_json", data: JSON.stringify(next) },
            sequence,
          }),
        ], { timeoutMs: 60_000, attempts: 2 });
        this.lastFlushOk = true;
        return true;
      } catch (error) {
        this.lastFlushOk = false;
        log("WARN", "card update failed", {
          cardId: this.cardId,
          sequence,
          error: String(error.message || error).slice(0, 1000),
        });
        return false;
      }
    })();
    const ok = await this.inFlight;
    this.inFlight = null;
    if (this.pendingCard && !this.closed) this.update(this.pendingCard);
    return ok;
  }

  close() {
    this.closed = true;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
  }
}

function createRunState(session, event, userContent) {
  const settings = effectiveSessionSettings(session);
  return {
    blocks: [],
    footer: "thinking",
    terminal: "running",
    startedAt: Date.now(),
    session,
    event,
    userContent,
    threadId: "",
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

function updateToolFromAppServerItem(state, item) {
  const block = ensureToolBlock(state, item);
  if (!block) return false;
  block.tool.name = toolNameFromAppServerItem(item);
  block.tool.input = toolInputFromAppServerItem(item);
  block.tool.status = toolStatusFromAppServerItem(item);
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
  return true;
}

function reduceCodexJsonEvent(state, raw) {
  if (!raw || typeof raw !== "object") return false;
  const type = raw.type;

  if (type === "thread.started") {
    state.threadId = raw.thread_id || state.threadId;
    return true;
  }

  if (type === "turn.started") {
    state.footer = "thinking";
    return true;
  }

  if (type === "item.started") {
    const item = raw.item || {};
    const name = item.name || item.type || "tool";
    if (item.type && item.type !== "agent_message") {
      closeStreamingBlocks(state);
      state.blocks.push({
        kind: "tool",
        tool: {
          id: item.id || crypto.randomUUID(),
          name,
          input: toolInputFromItem(item),
          status: "running",
        },
      });
      state.footer = "tool_running";
      return true;
    }
  }

  if (type === "item.completed") {
    const item = raw.item || {};
    if (item.type === "agent_message" && typeof item.text === "string") {
      return appendRunText(state, item.text);
    }
    if (item.id) {
      for (const block of state.blocks) {
        if (block.kind === "tool" && block.tool.id === item.id) {
          block.tool.status = toolStatusFromItem(item);
          block.tool.output = toolOutputFromItem(item);
          state.footer = "thinking";
          return true;
        }
      }
    }
    if (item.type && item.type !== "agent_message") {
      closeStreamingBlocks(state);
      state.blocks.push({
        kind: "tool",
        tool: {
          id: item.id || crypto.randomUUID(),
          name: item.name || item.type || "tool",
          input: toolInputFromItem(item),
          output: toolOutputFromItem(item),
          status: toolStatusFromItem(item),
        },
      });
      state.footer = "thinking";
      return true;
    }
  }

  if (type === "turn.completed") {
    closeStreamingBlocks(state);
    // Keep the card open until --output-last-message has been read. Codex can
    // emit turn.completed before the bridge has loaded the final answer file.
    state.footer = "streaming";
    state.meta.durationMs = Date.now() - state.startedAt;
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
    return true;
  }

  return false;
}

function reduceAppServerEvent(state, raw) {
  if (!raw || typeof raw !== "object") return false;
  const method = raw.method;
  const params = raw.params || {};

  if (method === "thread/started") {
    state.threadId = params.thread?.id || state.threadId;
    return true;
  }

  if (method === "thread/status/changed") {
    if (params.threadId) state.threadId = params.threadId;
    const statusType = params.status?.type;
    updateSessionThreadStatus(state.session, statusType || "");
    if (statusType === "active") state.footer = state.footer || "thinking";
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
    return true;
  }

  if (method === "item/started") {
    const item = params.item || {};
    if (item.type === "agentMessage") {
      state.footer = "streaming";
      return true;
    }
    if (item.type === "contextCompaction") {
      state.footer = "compacting";
      return true;
    }
    if (item.type === "userMessage" || item.type === "hookPrompt" || item.type === "reasoning") {
      state.footer = "thinking";
      return true;
    }
    return updateToolFromAppServerItem(state, item);
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
      return true;
    }
    if (item.type === "contextCompaction") {
      markSessionCompacted(state.session);
      state.meta.compactedAt = state.session.lastCompactedAt;
      state.meta.contextUsage = null;
      state.footer = "thinking";
      return true;
    }
    if (item.type === "userMessage" || item.type === "hookPrompt" || item.type === "reasoning") {
      state.footer = "thinking";
      return true;
    }
    return updateToolFromAppServerItem(state, item);
  }

  if (method === "item/agentMessage/delta") {
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
    return true;
  }

  if (method === "turn/completed") {
    closeStreamingBlocks(state);
    state.footer = "streaming";
    state.meta.durationMs = params.turn?.durationMs ?? Date.now() - state.startedAt;
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
      return true;
    }
    closeStreamingBlocks(state);
    state.terminal = "error";
    state.footer = null;
    updateSessionFailure(state.session, failure);
    state.meta.durationMs = Date.now() - state.startedAt;
    return true;
  }

  return false;
}

function markRunError(state, error) {
  const failure = classifyCodexFailure(error);
  closeStreamingBlocks(state);
  state.terminal = "error";
  state.footer = null;
  state.failure = failure;
  state.errorMsg = failureDetailText(failure).slice(0, 1500);
  state.meta.durationMs = Date.now() - state.startedAt;
  updateSessionFailure(state.session, failure);
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

  if (CONFIG.debugCards) {
    elements.push(noteMd(`会话：${state.session.title} (${state.session.id})`));
    elements.push(noteMd(`工作区：${CONFIG.workspace}`));
    if (state.threadId) elements.push(noteMd(`Codex 线程：${state.threadId}`));
  }

  if (state.blocks.length === 0 && state.terminal === "running") {
    elements.push(markdown("**正在处理**\n\n我已经收到消息，正在整理回复。"));
  }

  elements.push(...renderRunBlocks(state.blocks, state.terminal !== "running"));

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

function markdown(content) {
  return { tag: "markdown", content };
}

function noteMd(content) {
  return { tag: "markdown", content, text_size: "notation" };
}

function activeRunKey(messageId) {
  return String(messageId || "").trim();
}

function recordActiveRun(record) {
  const key = activeRunKey(record?.messageId);
  if (!key) return;
  activeRuns.runs[key] = {
    messageId: key,
    chatId: String(record.chatId || ""),
    sessionId: String(record.sessionId || ""),
    cardId: String(record.cardId || ""),
    cardMessageId: String(record.cardMessageId || ""),
    startedAt: Number(record.startedAt || 0) || Date.now(),
    updatedAt: Date.now(),
    bridgePid: process.pid,
    workspace: CONFIG.workspace,
  };
  saveActiveRuns();
}

function touchActiveRun(messageId) {
  const key = activeRunKey(messageId);
  if (!key || !activeRuns.runs[key]) return;
  if (Date.now() - Number(activeRuns.runs[key].updatedAt || 0) < 10_000) return;
  activeRuns.runs[key].updatedAt = Date.now();
  saveActiveRuns();
}

function clearActiveRun(messageId) {
  const key = activeRunKey(messageId);
  if (!key || !activeRuns.runs[key]) return;
  delete activeRuns.runs[key];
  saveActiveRuns();
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

async function updateCardById(cardId, card) {
  if (!cardId) return false;
  await larkJson([
    "api",
    "PUT",
    `/open-apis/cardkit/v1/cards/${cardId}`,
    "--as",
    "bot",
    "--data",
    JSON.stringify({ card: { type: "card_json", data: JSON.stringify(card) } }),
  ], { timeoutMs: 60_000, attempts: 2 });
  return true;
}

async function repairStaleActiveRunsOnStartup() {
  const entries = Object.values(activeRuns.runs || {});
  if (!entries.length) return;
  log("INFO", "repairing stale active runs", { count: entries.length });
  let repaired = 0;
  for (const record of entries) {
    try {
      if (record?.cardId) {
        await updateCardById(record.cardId, renderStaleRunCard(record));
      }
      repaired += 1;
    } catch (error) {
      log("WARN", "stale active run card update failed", {
        messageId: record?.messageId || "",
        cardId: record?.cardId || "",
        error: String(error.message || error).slice(0, 1000),
      });
    }
  }
  activeRuns.runs = {};
  saveActiveRuns();
  log("INFO", "stale active runs repaired", { repaired });
}

function renderRunBlocks(blocks, finalized) {
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
  const flushTools = () => {
    if (toolBuffer.length > 0) {
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
  if (prior.length > 0) elements.push(toolSummaryPanel(prior, false));
  if (latest) elements.push(toolCardPanel(latest, true));
  return elements;
}

function toolSummaryPanel(tools, finalized) {
  const counts = toolStatusCounts(tools);
  const body = finalized
    ? toolSummaryFinalBody(tools, counts)
    : tools.map((tool) => `- ${toolHeaderText(tool, false)}`).join("\n");
  return {
    tag: "collapsible_panel",
    expanded: !finalized,
    header: panelHeader(`**${toolSummaryTitle(tools.length, counts, finalized)}**`),
    border: { color: counts.error ? "red" : "blue", corner_radius: "5px" },
    vertical_spacing: "8px",
    padding: "8px 8px 8px 8px",
    elements: [{ tag: "markdown", content: body || "_暂无步骤_", text_size: "notation" }],
  };
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
  if (!finalized) return `${total} 个步骤已执行`;
  const parts = [`${total} 个步骤已完成`];
  if (counts.error) parts.push(`${counts.error} 个需查看`);
  return parts.join(" · ");
}

function toolSummaryFinalBody(tools, counts) {
  const lines = [`完成 ${counts.done} 个，失败 ${counts.error} 个，运行中 ${counts.running} 个。`];
  if (counts.error) {
    lines.push("");
    lines.push("失败步骤已在下方展开；多数探索命令未命中不一定影响最终结论。");
  } else {
    lines.push("");
    lines.push("成功步骤已折叠，保留最终结果和必要元信息。");
  }
  const names = [...new Set(tools.map((tool) => displayToolName(tool)).filter(Boolean))].slice(0, 6);
  if (names.length) lines.push(`工具：${names.join(" · ")}`);
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
    elements: [{ tag: "markdown", content: body, text_size: "notation" }],
  };
}

function panelHeader(content) {
  return {
    title: { tag: "markdown", content },
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
  const lower = raw.toLowerCase();
  if (lower === "app_server_fallback") return "原生通道回退";
  if (lower === "command_execution" || lower === "exec_command" || lower === "bash") {
    return classifyCommandToolName(commandTextFromInput(toolOrName?.input));
  }
  if (lower === "read" || lower === "file_read") return "读取文件";
  if (lower === "write" || lower === "file_write") return "写入文件";
  if (lower === "edit" || lower === "apply_patch") return "修改文件";
  if (lower === "plan") return "更新计划";
  if (lower === "web_search") return "网页搜索";
  if (lower === "image_view") return "查看图片";
  if (lower === "image_generation") return "生成图片";
  if (lower.includes("mcp")) return "MCP 工具";
  if (lower.includes("search") || lower === "grep" || lower === "rg") return "搜索";
  return raw.replace(/_/g, " ");
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

function toolStatusFromAppServerItem(item) {
  const status = String(item?.status || "").toLowerCase();
  if (!status || status === "inprogress" || status === "pending") return "running";
  if (["failed", "declined", "error", "cancelled", "canceled"].includes(status)) return "error";
  if (item?.exitCode !== undefined && item.exitCode !== null && Number(item.exitCode) !== 0) return "error";
  if (item?.success === false) return "error";
  return "done";
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

function cardTitle(state) {
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
  if (state.terminal === "interrupted") return "已停止";
  if (state.terminal === "error") return state.failure?.label || "处理失败";
  if (state.terminal === "done") return "已完成";
  if (state.footer === "recovering") return "正在续跑";
  if (state.footer === "reconnecting") return "正在重连";
  if (state.footer === "tool_running") return "正在调用工具";
  if (state.footer === "streaming") return "正在输出";
  return "正在处理";
}

function truncateCardText(text, max) {
  const value = String(text || "");
  return value.length > max ? `${value.slice(0, max)}\n\n...(已截断)` : value;
}

function splitText(text, maxChars) {
  const normalized = String(text || "").trim() || "(Codex 没有返回内容)";
  if (normalized.length <= maxChars) return [normalized];

  const chunks = [];
  let rest = normalized;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf("\n", maxChars);
    if (cut < maxChars * 0.5) cut = maxChars;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function idempotencyKey(baseId, suffix) {
  return crypto
    .createHash("sha256")
    .update(`${baseId}:${suffix}`)
    .digest("hex")
    .slice(0, 32);
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

function addPendingAttachments(chatId, attachments) {
  if (!chatId || !attachments.length) return;
  cleanupPendingAttachments(chatId);
  const current = pendingAttachmentsByChat.get(chatId) || [];
  const next = [...current, ...attachments].slice(-CONFIG.maxPendingAttachments);
  pendingAttachmentsByChat.set(chatId, next);
}

function cleanupPendingAttachments(chatId) {
  const current = pendingAttachmentsByChat.get(chatId);
  if (!current?.length) return [];
  const cutoff = Date.now() - CONFIG.attachmentPendingTtlMs;
  const next = current.filter((item) => Number(item.receivedAt || 0) >= cutoff);
  if (next.length) pendingAttachmentsByChat.set(chatId, next);
  else pendingAttachmentsByChat.delete(chatId);
  return next;
}

function takePendingAttachments(chatId) {
  const current = cleanupPendingAttachments(chatId);
  pendingAttachmentsByChat.delete(chatId);
  return current;
}

function normalizeUserContent(content) {
  return String(content || "")
    .replace(/^@\S+\s*/u, "")
    .trim();
}

function parseCommand(content) {
  const text = userTextFromContent(content) || normalizeUserContent(content);
  if (!text.startsWith("/")) return null;
  const [nameRaw, ...rest] = text.split(/\s+/);
  return {
    name: nameRaw.toLowerCase(),
    rest: rest.join(" ").trim(),
    text,
  };
}

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
  const history = session.messages
    .slice(-12)
    .map((msg) => `${msg.role === "user" ? "用户" : "助手"}：${msg.content}`)
    .join("\n\n");

  return [
    "你是通过飞书消息被唤起的本机 Codex。请以接近 Codex 原生 Agent 的方式完成用户任务，而不是只做轻量聊天回复。",
    "",
    "执行准则：",
    "- 默认使用中文，除非用户明确要求其他语言。",
    "- 对需要检查、研究、网页核验、文件处理、代码修改或多步骤推进的任务，要主动使用可用的工具、MCP、Skills、浏览器控制和本地脚本，而不是只凭记忆回答。",
    "- 先读取相关 Skill/AGENTS/项目文件，遵循现有流程和工作区约定；尤其是百科、飞书、浏览器、文档、图片等任务，要优先使用对应 Skill 或本地工具链。",
    "- 需要事实核验时保留可追溯证据；不要把未逐条核验的结论说成已确认。",
    "- 可以在当前工作区创建、修改、下载或生成任务需要的文件；改动要小而清晰，并在最终回复列出文件变化。",
    "- 长任务可以分阶段推进，但每一轮都要尽量完成一个可验证节点，不要只给计划。",
    "- 不要调用 lark-cli、飞书 API 或任何工具把最终答案发回飞书；桥接器会负责发送你的最终回复。",
    "- 不要在最终回复中描述桥接器流程、读取任务文件、飞书 IM skill 或发送方式；可以简洁说明你使用了哪些用户可理解的工具/Skill/MCP 来完成任务。",
    "- 如果用户只是打招呼或闲聊，直接自然回复，不要执行额外检查。",
    "- 不要泄露本机密钥、token、配置文件秘密或飞书 app secret。",
    "- 如果需要危险写操作、删除、群发、读取大量私人数据，先要求用户明确确认。",
    "- 最终回复要适合发回飞书：结果优先、证据和文件变化清楚、避免冗长内部日志。",
    "",
    "当前会话：",
    `- id: ${session.id}`,
    `- title: ${session.title}`,
    `- workspace: ${CONFIG.workspace}`,
    "",
    history ? `最近上下文：\n${history}` : "最近上下文：无",
    "",
    "飞书事件信息：",
    `- chat_type: ${event.chat_type || ""}`,
    `- chat_id: ${event.chat_id || ""}`,
    `- sender_id: ${event.sender_id || ""}`,
    `- message_id: ${event.message_id || event.id || ""}`,
    `- message_type: ${event.message_type || ""}`,
    "",
    attachmentPromptBlock(attachments),
    "",
    "用户消息：",
    content || (attachments.length ? "(attachment only)" : "(empty message)"),
  ].join("\n");
}

function shellQuote(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
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
    print(json.dumps([dict(row) for row in rows]))
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
  const rows = await sqliteJson(
    codexStateDbPath,
    [
      "select id, title, rollout_path, cwd, model_provider, archived,",
      "created_at, updated_at, created_at_ms, updated_at_ms",
      "from threads",
      `where id = ${shellQuote(threadId)}`,
      "limit 1;",
    ].join(" "),
  );
  return rows[0] || null;
}

async function codexTableSet() {
  const rows = await sqliteJson(
    codexStateDbPath,
    "select name from sqlite_master where type = 'table';",
  );
  return new Set(rows.map((row) => String(row.name || "")).filter(Boolean));
}

async function sqliteTableColumns(tableName) {
  const safeName = String(tableName || "").replace(/"/g, "\"\"");
  const rows = await sqliteJson(codexStateDbPath, `PRAGMA table_info("${safeName}");`);
  return new Set(rows.map((row) => String(row.name || "")).filter(Boolean));
}

async function deleteByThreadIdIfPossible(statements, tables, tableName) {
  if (!tables.has(tableName)) return;
  const columns = await sqliteTableColumns(tableName);
  if (columns.has("thread_id")) {
    statements.push(`DELETE FROM ${tableName} WHERE thread_id = ?1;`);
  } else if (columns.has("id")) {
    statements.push(`DELETE FROM ${tableName} WHERE id = ?1;`);
  }
}

function stripWindowsLongPathPrefix(value) {
  let text = String(value || "");
  if (process.platform === "win32") {
    text = text.replace(/^\\\\\?\\UNC\\/i, "\\\\");
    text = text.replace(/^\\\\\?\\/i, "");
  }
  return text;
}

function resolveSafeCodexRolloutPath(rolloutPath, threadId) {
  const raw = stripWindowsLongPathPrefix(rolloutPath);
  if (!raw || !path.isAbsolute(raw)) throw new Error(`invalid rollout_path: ${rolloutPath || ""}`);

  const sessionsRoot = fs.realpathSync.native(path.join(CONFIG.codexHome, "sessions"));
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

async function deleteCodexLocalThread(threadId) {
  const id = String(threadId || "").trim();
  if (!id) throw new Error("thread id is required");
  if (!fs.existsSync(codexStateDbPath)) throw new Error(`Codex state database not found: ${codexStateDbPath}`);

  const record = await loadCodexThreadRecord(id);
  if (!record) throw new Error(`Thread not found in local storage: ${id}`);

  const tables = await codexTableSet();
  if (!tables.has("threads")) throw new Error("Unsupported local storage schema: missing threads table");
  const statements = [
    "PRAGMA busy_timeout = 5000;",
    "BEGIN IMMEDIATE;",
  ];

  if (tables.has("thread_dynamic_tools")) {
    statements.push("DELETE FROM thread_dynamic_tools WHERE thread_id = ?1;");
  }
  await deleteByThreadIdIfPossible(statements, tables, "thread_goals");
  await deleteByThreadIdIfPossible(statements, tables, "thread_goal");
  if (tables.has("thread_spawn_edges")) {
    statements.push("DELETE FROM thread_spawn_edges WHERE parent_thread_id = ?1 OR child_thread_id = ?1;");
  }
  await deleteByThreadIdIfPossible(statements, tables, "stage1_outputs");
  if (tables.has("agent_job_items")) {
    statements.push("UPDATE agent_job_items SET assigned_thread_id = NULL WHERE assigned_thread_id = ?1;");
  }
  if (tables.has("messages")) {
    statements.push("DELETE FROM messages WHERE session_id = ?1;");
  }
  if (tables.has("sessions")) {
    statements.push("DELETE FROM sessions WHERE id = ?1;");
  }
  if (tables.has("threads")) {
    statements.push("DELETE FROM threads WHERE id = ?1;");
  }
  statements.push("COMMIT;");

  await sqliteExecChecked(
    codexStateDbPath,
    statements.join("\n").replace(/\?1/g, shellQuote(id)),
  );
  const afterDelete = await loadCodexThreadRecord(id);
  if (afterDelete) throw new Error(`Thread delete did not remove local row: ${id}`);

  let rolloutDeleted = false;
  let rolloutMissing = false;
  let rolloutError = "";
  let rolloutPath = "";
  if (record.rollout_path) {
    try {
      rolloutPath = resolveSafeCodexRolloutPath(record.rollout_path, id);
      if (fs.existsSync(rolloutPath)) {
        fs.rmSync(rolloutPath, { force: true });
        rolloutDeleted = true;
      } else {
        rolloutMissing = true;
      }
    } catch (error) {
      rolloutError = String(error.message || error);
      log("ERROR", "codex rollout delete failed after db delete", { threadId: id, rolloutPath: record.rollout_path, error: rolloutError });
    }
  }

  return {
    threadId: id,
    title: record.title || "",
    rolloutPath: rolloutPath || record.rollout_path || "",
    rolloutDeleted,
    rolloutMissing,
    rolloutError,
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
  if (!CONFIG.syncSidebar) return;
  const threadId = await findCodexThreadIdForPrompt(promptFile, stdoutRaw);
  if (!threadId) {
    log("WARN", "sidebar sync skipped; codex thread not found", { messageId: event.message_id || event.id, sessionId: session.id, promptFile });
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
}

class AppServerClient {
  constructor({ cwd = CONFIG.workspace, label = "codex-app-server" } = {}) {
    this.cwd = cwd;
    this.label = label;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.notifications = [];
    this.notificationWaiters = [];
    this.stderrChunks = [];
    this.closed = false;
  }

  start() {
    const args = [...CONFIG.codexCli.argsPrefix, "app-server", "--listen", "stdio://"];
    this.child = spawn(CONFIG.codexCli.command, args, {
      cwd: this.cwd,
      env: {
        ...process.env,
        CODEX_FEISHU_BRIDGE: "1",
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    activeChildren.set(this.child.pid, { child: this.child, label: `${CONFIG.codexCli.command} ${args.join(" ")}` });
    this.child.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk) => this.stderrChunks.push(Buffer.from(chunk)));
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("close", (code, signal) => {
      this.closed = true;
      activeChildren.delete(this.child?.pid);
      const error = new Error(`codex app-server exited (${code ?? signal ?? "unknown"})`);
      this.rejectAll(error);
      for (const waiter of this.notificationWaiters.splice(0)) waiter(null);
    });
    return this;
  }

  onStdout(chunk) {
    this.buffer += chunk.toString("utf8");
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) break;
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        log("WARN", "app-server emitted non-json line", { line: line.slice(0, 1000), error: String(error) });
        continue;
      }
      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (Object.prototype.hasOwnProperty.call(message, "error")) {
        pending.reject(new Error(errorText(message.error, "codex app-server request failed")));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      this.respondToServerRequest(message);
      return;
    }

    if (message.method) {
      if (this.notificationWaiters.length) {
        const waiter = this.notificationWaiters.shift();
        waiter(message);
      } else {
        this.notifications.push(message);
      }
    }
  }

  respondToServerRequest(message) {
    const method = message.method;
    let result;
    if (method === "item/commandExecution/requestApproval") {
      result = { decision: "accept" };
    } else if (method === "item/fileChange/requestApproval") {
      result = { decision: "accept" };
    } else if (method === "item/permissions/requestApproval") {
      result = {
        permissions: {
          network: { enabled: true },
          fileSystem: { read: null, write: [CONFIG.workspace] },
        },
        scope: "turn",
      };
    } else if (method === "applyPatchApproval" || method === "execCommandApproval") {
      result = { decision: "approved" };
    } else if (method === "item/tool/requestUserInput") {
      result = { answers: {} };
    } else if (method === "mcpServer/elicitation/request") {
      result = { action: "cancel", content: null, _meta: null };
    } else if (method === "item/tool/call") {
      result = { contentItems: [{ type: "inputText", text: "Dynamic tool calls are not handled by the Feishu bridge client." }], success: false };
    } else {
      result = {};
    }
    this.write({ id: message.id, result });
  }

  write(message) {
    if (!this.child || this.closed) throw new Error("codex app-server is not running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }

  request(method, params = undefined, timeoutMs = 60_000) {
    const id = this.nextId++;
    this.write(params === undefined ? { id, method } : { id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params = undefined) {
    this.write(params === undefined ? { method } : { method, params });
  }

  nextNotification(timeoutMs = 1000) {
    if (this.notifications.length) return Promise.resolve(this.notifications.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = this.notificationWaiters.indexOf(waiter);
        if (index >= 0) this.notificationWaiters.splice(index, 1);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      const waiter = (message) => {
        clearTimeout(timer);
        resolve(message);
      };
      this.notificationWaiters.push(waiter);
    });
  }

  async stop() {
    if (!this.child || this.closed) return;
    try {
      this.child.stdin.end();
    } catch {}
    try {
      this.child.kill("SIGTERM");
    } catch {}
    setTimeout(() => terminateProcessTree(this.child?.pid, true), 5000).unref?.();
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  stderrText() {
    return Buffer.concat(this.stderrChunks).toString("utf8");
  }
}

function appServerThreadConfig() {
  const config = {};
  if (CONFIG.disableMcp) config.mcp_servers = {};
  return Object.keys(config).length ? config : null;
}

function appServerStartParams(session) {
  const params = {
    cwd: CONFIG.workspace,
    approvalPolicy: "never",
    sandbox: CONFIG.codexSandbox,
    threadSource: "user",
    config: appServerThreadConfig(),
    serviceName: "codex-feishu-bridge",
  };
  return applySessionThreadOverrides(params, session);
}

function appServerResumeParams(session) {
  const params = {
    threadId: session.codexThreadId,
    cwd: CONFIG.workspace,
    approvalPolicy: "never",
    sandbox: CONFIG.codexSandbox,
    config: appServerThreadConfig(),
  };
  return applySessionThreadOverrides(params, session);
}

function appServerTurnParams(threadId, event, userContent, session) {
  const input = [];
  const text = appServerUserText(event, userContent);
  if (text) input.push({ type: "text", text, text_elements: [] });
  for (const attachment of Array.isArray(event.attachments) ? event.attachments : []) {
    if (attachment?.type === "image" && attachment.path && fs.existsSync(attachment.path)) {
      input.push({ type: "localImage", path: attachment.path });
    }
  }
  if (!input.length) input.push({ type: "text", text: "(attachment only)", text_elements: [] });

  const params = {
    threadId,
    input,
    cwd: CONFIG.workspace,
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
  };
  return applySessionTurnOverrides(params, session);
}

function appServerUserText(event, userContent) {
  const text = String(userContent || userTextFromContent(event.content) || "").trim();
  const attachments = Array.isArray(event.attachments) ? event.attachments : [];
  if (!text && !attachments.length) return "";
  const marker = [
    "",
    "---",
    "来源：飞书消息。请直接按用户意图完成任务，最终回复适合发回飞书；不要调用 lark-cli 或飞书 API 发送最终答案。",
    `message_id: ${event.message_id || event.id || ""}`,
  ].join("\n");
  const parts = [];
  if (text) parts.push(text);
  if (attachments.length) parts.push(attachmentPromptBlock(attachments));
  parts.push(marker.trimStart());
  return parts.join("\n\n");
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
  let timedOut = false;
  let reason = "";
  let totalTimer = null;
  let idleTimer = null;

  const fire = (message) => {
    if (timedOut) return;
    timedOut = true;
    reason = message;
    onTimeout?.(message);
  };

  const armIdleTimer = () => {
    clearTimer(idleTimer);
    idleTimer = null;
    if (!hasDuration(idleMs)) return;
    idleTimer = setTimeout(() => {
      fire(`${label} idle timed out after ${Math.round(idleMs / 1000)}s without progress`);
    }, idleMs);
    idleTimer.unref?.();
  };

  if (hasDuration(totalMs)) {
    totalTimer = setTimeout(() => {
      fire(`${label} timed out after ${Math.round(totalMs / 1000)}s`);
    }, totalMs);
    totalTimer.unref?.();
  }
  armIdleTimer();

  return {
    touch: armIdleTimer,
    get timedOut() {
      return timedOut;
    },
    get reason() {
      return reason;
    },
    clear() {
      clearTimer(totalTimer);
      clearTimer(idleTimer);
    },
  };
}

async function compactAppServerThread(session) {
  const client = new AppServerClient({ cwd: CONFIG.workspace }).start();
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

  const client = new AppServerClient({ cwd: CONFIG.workspace }).start();
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
  return await withAppServerThread(session, { createIfMissing: false }, async (client, threadId) => {
    const result = await client.request("thread/goal/get", { threadId }, 60_000);
    updateSessionGoal(session, result?.goal || null);
    return session.lastGoal;
  });
}

async function setAppServerGoal(session, goalPatch) {
  return await withAppServerThread(session, { createIfMissing: true }, async (client, threadId) => {
    const result = await client.request("thread/goal/set", { threadId, ...goalPatch }, 60_000);
    return updateSessionGoal(session, result?.goal || null);
  });
}

async function clearAppServerGoal(session) {
  if (!session.codexThreadId) return false;
  return await withAppServerThread(session, { createIfMissing: false }, async (client, threadId) => {
    const result = await client.request("thread/goal/clear", { threadId }, 60_000);
    updateSessionGoal(session, null);
    return Boolean(result?.cleared);
  });
}

async function withConfigClient(fn) {
  const client = new AppServerClient({ cwd: CONFIG.workspace }).start();
  try {
    await initializeAppServerClient(client);
    return await fn(client);
  } finally {
    await client.stop();
  }
}

async function writeCodexConfigValue(keyPath, value) {
  return await withConfigClient(async (client) => client.request(
    "config/value/write",
    { keyPath, value, mergeStrategy: "upsert" },
    60_000,
  ));
}

async function listCodexModels() {
  return await withConfigClient(async (client) => {
    const result = await client.request("model/list", { includeHidden: false, limit: 50 }, 60_000);
    return Array.isArray(result?.data) ? result.data : [];
  });
}

async function startOrResumeAppServerThread(client, session) {
  const params = appServerStartParams(session);
  if (session.codexThreadId) {
    try {
      const resumed = await client.request("thread/resume", appServerResumeParams(session), 60_000);
      return resumed.thread.id;
    } catch (error) {
      log("WARN", "app-server thread resume failed; starting new thread", {
        sessionId: session.id,
        threadId: session.codexThreadId,
        error: String(error.message || error).slice(0, 1000),
      });
      session.codexThreadId = "";
      saveSessions();
    }
  }

  const started = await client.request("thread/start", params, 60_000);
  session.codexThreadId = started.thread.id;
  session.updatedAt = Date.now();
  saveSessions();
  return started.thread.id;
}

async function runCodexAppServer(event, session, state = null, onState = null, options = {}) {
  const chatId = event.chat_id;
  const messageId = event.message_id || event.id || crypto.randomUUID();
  const startedAt = Date.now();
  const recoveryAttempt = Number(options.recoveryAttempt || 0);
  const userContent = userTextFromContent(event.content);
  const liveState = state || createRunState(session, event, userContent);
  const client = new AppServerClient({ cwd: CONFIG.workspace }).start();
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

  try {
    const settings = effectiveSessionSettings(session);
    log("INFO", "starting codex app-server turn", {
      messageId,
      sessionId: session.id,
      existingThreadId: session.codexThreadId || "",
      model: settings.model || "",
      provider: settings.provider || "",
      reasoning: settings.reasoning || "",
      serviceTier: settings.serviceTier || "",
      timeoutMs: CONFIG.codexTimeoutMs,
      idleTimeoutMs: CONFIG.codexIdleTimeoutMs,
      disableMcp: CONFIG.disableMcp,
    });

    const initialized = await initializeAppServerClient(client);
    watchdog.touch();
    liveState.meta.model = initialized.userAgent || liveState.meta.model;

    const threadId = await startOrResumeAppServerThread(client, session);
    watchdog.touch();
    liveState.threadId = threadId;
    activeJob.threadId = threadId;
    if (state) {
      await flushState();
    }

    const turn = await client.request("turn/start", appServerTurnParams(threadId, event, userContent, session), 60_000);
    watchdog.touch();
    const turnId = turn?.turn?.id || "";
    activeJob.turnId = turnId;

    let completed = false;
    while (!completed && !watchdog.timedOut) {
      const message = await client.nextNotification(1000);
      if (!message) {
        if (client.closed) break;
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
    ensureRunDone(liveState, finalText);
    liveState.meta.durationMs = durationMs;
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
      if (shouldRecoverCodexRun(failure, recoveryAttempt)) {
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
      if (CONFIG.runMode !== "auto") throw error;
      const failure = classifyCodexFailure(error);
      if (["auth", "quota", "rate_limit", "user_stop"].includes(failure.kind)) throw error;
      log("WARN", "app-server mode failed; falling back to codex exec", {
        messageId: event.message_id || event.id,
        sessionId: session.id,
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
  const settings = effectiveSessionSettings(session);

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
  if (settings.serviceTier) args.push("-c", `service_tier="${settings.serviceTier}"`);
  for (const attachment of Array.isArray(event.attachments) ? event.attachments : []) {
    if (attachment?.type === "image" && attachment.path && fs.existsSync(attachment.path)) {
      args.push("--image", attachment.path);
    }
  }
  if (CONFIG.disableMcp) args.push("-c", "mcp_servers={}");
  args.push("--");
  args.push(`读取这个 UTF-8 任务文件，并按任务文件中的执行准则完成用户任务。要像 Codex 原生 Agent 一样主动使用可用工具、MCP、Skills、浏览器控制和本地文件完成需要核验或改动的工作。最终只输出要发给飞书用户的回复文本；不要描述读取任务文件、桥接器、飞书 IM skill 或发送流程。任务文件：${promptFile}`);

  const startedAt = Date.now();
  log("INFO", "starting codex", {
    messageId,
    sessionId: session.id,
    promptFile,
    outFile,
    model: settings.model || "",
    provider: settings.provider || "",
    reasoning: settings.reasoning || "",
    serviceTier: settings.serviceTier || "",
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

function cleanupRecalledMessages() {
  if (!hasDuration(CONFIG.recalledMessageTtlMs)) return;
  const cutoff = Date.now() - CONFIG.recalledMessageTtlMs;
  for (const [messageId, record] of recalledMessages) {
    if (Number(record?.at || 0) < cutoff) recalledMessages.delete(messageId);
  }
}

function rememberRecalledMessage(messageId, record = {}) {
  const id = String(messageId || "").trim();
  if (!id) return false;
  cleanupRecalledMessages();
  recalledMessages.set(id, {
    messageId: id,
    chatId: String(record.chatId || ""),
    eventId: String(record.eventId || ""),
    at: Number(record.at || 0) || Date.now(),
    reason: String(record.reason || "recall"),
  });
  return true;
}

function isMessageRecalled(messageId) {
  cleanupRecalledMessages();
  return recalledMessages.has(String(messageId || "").trim());
}

function dropPendingAttachmentsForMessage(messageId, chatId = "") {
  const target = String(messageId || "").trim();
  if (!target) return 0;
  let removed = 0;
  for (const [key, items] of pendingAttachmentsByChat) {
    if (chatId && key !== chatId) continue;
    const next = (items || []).filter((item) => {
      const keep = String(item?.messageId || "") !== target;
      if (!keep) removed += 1;
      return keep;
    });
    if (next.length) pendingAttachmentsByChat.set(key, next);
    else pendingAttachmentsByChat.delete(key);
  }
  return removed;
}

function removePendingEventsByMessageId(messageId) {
  const target = String(messageId || "").trim();
  if (!target) return 0;
  let removed = 0;
  for (let index = pendingEvents.length - 1; index >= 0; index -= 1) {
    if (messageIdOf(pendingEvents[index]) === target) {
      pendingEvents.splice(index, 1);
      removed += 1;
    }
  }
  return removed;
}

function pendingEventMatchesChat(event, chatId) {
  const target = String(chatId || "").trim();
  if (!target) return false;
  const current = chatIdOf(event);
  return current && current === target;
}

function clearPendingEventsForChat(chatId, { all = false } = {}) {
  let removed = 0;
  for (let index = pendingEvents.length - 1; index >= 0; index -= 1) {
    if (all || pendingEventMatchesChat(pendingEvents[index], chatId)) {
      pendingEvents.splice(index, 1);
      removed += 1;
    }
  }
  return removed;
}

function pendingEventsForChat(chatId) {
  if (!chatId) return 0;
  return pendingEvents.filter((event) => pendingEventMatchesChat(event, chatId)).length;
}

function queueSummary(chatId) {
  const knownForChat = pendingEventsForChat(chatId);
  const unknown = pendingEvents.filter((event) => !chatIdOf(event)).length;
  const parts = [`总队列 ${pendingEvents.length}`];
  if (chatId) parts.push(`当前聊天 ${knownForChat}`);
  if (unknown) parts.push(`未知聊天 ${unknown}`);
  return parts.join("，");
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

function enqueue(event) {
  if (isRecallEvent(event)) {
    handleRecallEvent(event);
    return;
  }

  const messageId = messageIdOf(event);
  if (messageId && isMessageRecalled(messageId)) {
    log("INFO", "recalled message ignored before enqueue", { messageId, eventId: eventIdOf(event) });
    return;
  }

  const command = parseCommand(event?.content);
  if (isOutOfBandCommand(command)) {
    void handleOutOfBandCommand(event, command)
      .catch((error) => log("ERROR", "out-of-band command handling failed", { error: String(error.stack || error) }));
    return;
  }
  pendingEvents.push({ ...event, queuedAt: Date.now() });
  drainQueue();
}

function isOutOfBandCommand(command) {
  return ["/stop", "/clearqueue", "/queue", "/goal", "/provider", "/model", "/fast"].includes(command?.name);
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
    command: command.name,
  });
  await handleCommand(event, command);
}

function drainQueue() {
  if (shuttingDown) return;
  while (activeJobs < CONFIG.maxConcurrent && pendingEvents.length) {
    const event = pendingEvents.shift();
    activeJobs += 1;
    handleEvent(event)
      .catch((error) => log("ERROR", "event handling failed", { error: String(error.stack || error) }))
      .finally(() => {
        activeJobs -= 1;
        drainQueue();
      });
  }
}

async function handleEvent(rawEvent) {
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
  const chatId = event.chat_id;
  if (!chatId) {
    log("WARN", "event missing chat_id", event);
    return;
  }

  stats.events += 1;
  const userContent = userTextFromContent(event.content);
  log("INFO", "message received", {
    eventId: event.event_id,
    messageId,
    chatId,
    chatType: event.chat_type,
    senderId: event.sender_id,
    contentPreview: userContent.slice(0, 120),
  });

  const command = parseCommand(event.content);
  if (command) {
    stats.commands += 1;
    await handleCommand(event, command);
    return;
  }

  const downloadedAttachments = [
    ...(await downloadImageAttachments(event)),
    ...(await downloadFileAttachments(event)),
  ];

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

  if (!card) {
    await sendMarkdown(
      chatId,
      [
        "**Codex 正在处理**",
        "",
        `会话：\`${session.title}\` (${session.id})`,
        `工作区：\`${CONFIG.workspace}\``,
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
      const markdown = await sessionsMarkdown(chatId);
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
  const session = await switchSession(chatId, target);
  if (!session) {
    await sendText(chatId, "没有找到这个会话。发送 /sessions 查看可切换的会话。", "switch-miss", messageId);
    return;
  }
  await sendText(chatId, `已切换到：${session.title || "未命名会话"} (${session.id})`, "switch", messageId);
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
  return [
    "**Codex 会话删除确认**",
    "",
    "这会执行 Codex++ 等价的本地删除：删除 Codex 本地索引记录、清理关联表、删除 rollout 会话文件，并移除飞书绑定。",
    "",
    `序号：${index}`,
    `标题：${entry.title || record.title || "未命名会话"}`,
    `Thread：${codexThreadLink(threadId)}`,
    `本地会话：${entry.id || ""}`,
    `Rollout：\`${record.rollout_path || "未记录"}\``,
    `确认有效期：${formatTime(expiresAt)}`,
    "",
    `确认删除请输入：\`/confirm delete ${index}\``,
  ].join("\n");
}

async function handleDeleteCommand(chatId, target, messageId) {
  if (!target) {
    await sendText(chatId, "用法：/delete <序号或ID>。先发送 /list 查看会话；删除需要二次确认。", "delete-usage", messageId);
    return;
  }

  await syncChatSessionsWithCodex(chatId);
  const match = await findSessionEntry(chatId, target);
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
  if (activeJobUsesThread(threadId)) {
    await sendText(chatId, "这个会话正在运行中，先 /stop 或等待任务结束后再删除。", "delete-busy", messageId);
    return;
  }

  const record = await loadCodexThreadRecord(threadId);
  if (!record) {
    removeThreadFromBridgeSessions(threadId);
    await sendText(chatId, "Codex 本地库里已经找不到这个 thread，已清理飞书侧绑定。", "delete-missing-thread", messageId);
    return;
  }

  cleanupPendingDeleteConfirmations();
  const expiresAt = Date.now() + CONFIG.deleteConfirmTtlMs;
  pendingDeleteConfirmations.set(deleteConfirmationKey(chatId, match.index), {
    chatId,
    threadId,
    sessionId: entry.id || "",
    index: match.index,
    title: entry.title || record.title || "",
    rolloutPath: record.rollout_path || "",
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
  const [actionRaw, indexRaw] = String(rest || "").trim().split(/\s+/);
  const action = String(actionRaw || "").toLowerCase();
  const indexText = String(indexRaw || "").trim();
  const index = Number(indexText);
  if (action !== "delete" || !Number.isInteger(index) || index < 1) {
    await sendText(chatId, "用法：/confirm delete <序号>。先用 /delete <序号或ID> 发起删除确认。", "confirm-usage", messageId);
    return;
  }

  cleanupPendingDeleteConfirmations();
  const key = deleteConfirmationKey(chatId, index);
  const pending = pendingDeleteConfirmations.get(key);
  if (!pending || pending.chatId !== chatId) {
    await sendText(chatId, "删除确认不存在或已过期。请重新发送 /delete <序号或ID>。", "confirm-miss", messageId);
    return;
  }

  const currentMatch = await findSessionEntry(chatId, String(pending.index));
  if (!currentMatch || String(currentMatch.entry.codexThreadId || "").trim() !== pending.threadId) {
    pendingDeleteConfirmations.delete(key);
    await sendText(chatId, "会话列表顺序已经变化，为避免删错，请重新发送 /list 和 /delete。", "confirm-list-changed", messageId);
    return;
  }

  if (activeJobUsesThread(pending.threadId)) {
    await sendText(chatId, "这个会话正在运行中，先 /stop 或等待任务结束后再删除。", "confirm-busy", messageId);
    return;
  }

  let result;
  try {
    result = await deleteCodexLocalThread(pending.threadId);
  } catch (error) {
    pendingDeleteConfirmations.delete(key);
    await sendMarkdown(
      chatId,
      [
        "**Codex 会话删除失败**",
        "",
        `Thread：${codexThreadLink(pending.threadId)}`,
        "",
        "```",
        String(error.message || error).slice(0, 1500),
        "```",
      ].join("\n"),
      "delete-error",
      messageId,
    );
    return;
  }

  const bridgeRemoved = removeThreadFromBridgeSessions(pending.threadId);
  forgetDeleteConfirmationsForThread(pending.threadId);
  log("INFO", "codex local thread deleted", {
    chatId,
    threadId: pending.threadId,
    rolloutDeleted: result.rolloutDeleted,
    rolloutMissing: result.rolloutMissing,
    rolloutError: result.rolloutError,
    bridgeRemoved,
  });

  const status = result.rolloutError ? "Codex 会话已从本地库删除，但 rollout 文件删除失败" : "Codex 会话已删除";
  await sendMarkdown(
    chatId,
    [
      `**${status}**`,
      "",
      `标题：${pending.title || result.title || "未命名会话"}`,
      `Thread：${codexThreadLink(pending.threadId)}`,
      `飞书绑定清理：${bridgeRemoved} 条`,
      `Rollout：${result.rolloutDeleted ? "已删除" : result.rolloutMissing ? "原本不存在" : result.rolloutError ? "删除失败" : "未记录"}`,
      result.rolloutPath ? `路径：\`${result.rolloutPath}\`` : "",
      result.rolloutError ? ["", "```", result.rolloutError.slice(0, 1200), "```"].join("\n") : "",
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

  try {
    if (!text || action === "status" || action === "view") {
      const goal = await getAppServerGoal(session);
      await sendMarkdown(chatId, goalMarkdown(session, goal), "goal-status", messageId);
      return;
    }

    if (action === "clear" || action === "delete" || action === "remove") {
      const cleared = await clearAppServerGoal(session);
      await sendText(chatId, cleared ? "已清除当前 Codex goal。" : "当前会话没有可清除的 Codex goal。", "goal-clear", messageId);
      return;
    }

    if (action === "pause") {
      const current = await getAppServerGoal(session);
      if (!current) {
        await sendText(chatId, "当前会话还没有 Codex goal，先用 /goal <目标> 设置。", "goal-pause-none", messageId);
        return;
      }
      const goal = await setAppServerGoal(session, { status: "paused" });
      await sendMarkdown(chatId, goalMarkdown(session, goal, "已暂停 Codex goal"), "goal-pause", messageId);
      return;
    }

    if (action === "resume") {
      const current = await getAppServerGoal(session);
      if (!current) {
        await sendText(chatId, "当前会话还没有 Codex goal，先用 /goal <目标> 设置。", "goal-resume-none", messageId);
        return;
      }
      const goal = await setAppServerGoal(session, { status: "active" });
      await sendMarkdown(chatId, goalMarkdown(session, goal, "已恢复 Codex goal"), "goal-resume", messageId);
      return;
    }

    if (text.length > 4000) {
      await sendText(chatId, "Goal 目标最长 4000 字。更长说明请放到文件里，再在 goal 里引用文件路径。", "goal-too-long", messageId);
      return;
    }

    const goal = await setAppServerGoal(session, { objective: text, status: "active" });
    await sendMarkdown(chatId, goalMarkdown(session, goal, "已设置 Codex goal"), "goal-set", messageId);
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
    await sendMarkdown(chatId, providerListMarkdown(session), "provider-list", messageId);
    return;
  }

  if (["clear", "default", "reset"].includes(action)) {
    setSessionOverride(session, "providerOverride", "");
    await sendMarkdown(chatId, providerStatusMarkdown(session, "已清除当前会话的 provider 覆盖，后续使用 Codex 配置默认 provider。"), "provider-clear", messageId);
    return;
  }

  const persist = action === "save";
  const providerId = persist ? args[1] : args[0];
  const provider = findCodexProvider(providerId);
  if (!provider) {
    await sendMarkdown(chatId, providerListMarkdown(session, `没有找到 provider：\`${providerId || ""}\``), "provider-miss", messageId);
    return;
  }

  try {
    if (persist) await writeCodexConfigValue("model_provider", provider.id);
    setSessionOverride(session, "providerOverride", provider.id);
    await sendMarkdown(
      chatId,
      providerStatusMarkdown(
        session,
        persist
          ? `已切换并写入用户级 config.toml：\`${provider.id}\`。`
          : `已切换当前飞书会话 provider：\`${provider.id}\`。`,
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
  const lines = [
    `**${title}**`,
    "",
    `当前会话：\`${session.title || "未命名会话"}\` (${session.id})`,
    `当前 provider：\`${settings.provider || "默认"}\`${session.providerOverride ? "（会话覆盖）" : "（配置默认）"}`,
    provider ? providerDetailLine(provider) : "provider 未在当前 config.toml 中找到；如果它来自 profile 或外部配置，请确认 Bridge 启动参数也选择了对应配置。",
    "",
    `当前运行设置：${settingsSummary(session)}`,
    "",
    "用法：`/provider list`、`/provider <providerId>`、`/provider save <providerId>`、`/provider clear`",
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

  if (action === "list") {
    try {
      await sendMarkdown(chatId, await modelListMarkdown(session), "model-list", messageId);
    } catch (error) {
      await sendMarkdown(chatId, runtimeCommandErrorMarkdown("model/list 查询失败", error), "model-list-error", messageId);
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
        await sendText(chatId, "用法：`/model effort <none|minimal|low|medium|high|xhigh>`", "model-effort-usage", messageId);
        return;
      }
      if (persist) await writeCodexConfigValue("model_reasoning_effort", effort);
      setSessionOverride(session, "reasoningOverride", effort);
      await sendMarkdown(chatId, modelStatusMarkdown(session, persist ? "已切换并保存 reasoning。" : "已切换当前会话 reasoning。"), "model-effort", messageId);
      return;
    }

    const model = cleanOverride(args[0]);
    const effort = normalizeReasoningEffort(args[1]);
    if (!model) {
      await sendText(chatId, "用法：`/model <模型ID> [推理强度]`，例如 `/model gpt-5.5 xhigh`。", "model-usage", messageId);
      return;
    }
    if (args[1] && !effort) {
      await sendText(chatId, "推理强度只能是：`none`、`minimal`、`low`、`medium`、`high`、`xhigh`。", "model-effort-invalid", messageId);
      return;
    }

    if (model.toLowerCase() === "default") {
      session.modelOverride = "";
    } else {
      session.modelOverride = model;
      if (persist) await writeCodexConfigValue("model", model);
    }
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

function modelStatusMarkdown(session, title = "Codex model") {
  const settings = effectiveSessionSettings(session);
  return [
    `**${title}**`,
    "",
    `当前会话：\`${session.title || "未命名会话"}\` (${session.id})`,
    `模型：\`${settings.model || "默认"}\`${session.modelOverride ? "（会话覆盖）" : "（配置默认）"}`,
    `推理强度：\`${settings.reasoning || "默认"}\`${session.reasoningOverride ? "（会话覆盖）" : "（配置默认）"}`,
    `provider：\`${settings.provider || "默认"}\``,
    `速度：\`${displayServiceTier(settings.serviceTier) || "默认"}\``,
    "",
    "用法：`/model list`、`/model <模型ID> [推理强度]`、`/model effort <强度>`、`/model save <模型ID> [强度]`、`/model clear`",
  ].join("\n");
}

async function modelListMarkdown(session) {
  const settings = effectiveSessionSettings(session);
  const models = await listCodexModels();
  const lines = ["**Codex model 列表**", ""];
  for (const model of models.slice(0, 30)) {
    const id = model.id || model.model || "";
    if (!id) continue;
    const marker = id === settings.model ? " ← 当前" : model.isDefault ? " ← 默认" : "";
    const efforts = Array.isArray(model.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts.map((item) => item.reasoningEffort).filter(Boolean).join("/")
      : "";
    const fast = Array.isArray(model.serviceTiers) && model.serviceTiers.length
      ? `；速度档：${model.serviceTiers.map((tier) => `${tier.name || tier.id}(${tier.id})`).join(", ")}`
      : "";
    lines.push(`- \`${id}\`${marker}：${model.displayName || id}${efforts ? `；推理 ${efforts}` : ""}${fast}`);
  }
  lines.push("");
  lines.push("切当前会话：`/model <模型ID> [推理强度]`，例如 `/model gpt-5.5 xhigh`");
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
    await sendText(chatId, `当前没有运行中的 Codex 任务。${clearMode ? `已清理等待队列 ${cleared} 条。` : ""}`, "stop-none", messageId);
    return;
  }
  stoppedJobs.add(job.messageId);
  if (job.rootMessageId) stoppedJobs.add(job.rootMessageId);

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
    "`/goal [目标]` — 查看或设置 Codex goal；支持 `/goal pause`、`/goal resume`、`/goal clear`",
    "`/provider [id]` — 查看或切换当前会话 provider；`/provider list` 列出可用 provider",
    "`/model [模型ID] [推理强度]` — 查看或切换当前会话模型；`/model list` 列出模型",
    "`/fast on|off|status` — 切换或查看 Codex Fast 速度模式",
    "`/compact` — 触发当前原生 thread 的上下文压缩",
    "`/sessions` — 列出飞书会话和 Codex 侧边栏可见会话",
    "`/switch <序号或ID>` — 切换到已有 Codex 会话",
    "`/delete <序号或ID>` — 删除 Codex 本地会话，需 `/confirm delete <序号>` 确认",
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
  const eventStatus = await readEventStatus();
  const authStatus = await readAuthSummary();
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

async function sessionsMarkdown(chatId) {
  const list = await listChatSessionsSynced(chatId);
  const currentId = sessions.chats[chatId]?.currentSessionId || "";
  if (!list.length) {
    return [
      "**Codex 会话列表**",
      "",
      "当前没有与 Codex 侧边栏同步的可见会话。",
      "直接发送普通消息，或使用 `/new [标题]` 创建新的飞书 Codex 会话。",
    ].join("\n");
    return "还没有记录过 Codex 会话。直接发送普通消息会自动创建。";
  }
  const lines = ["**Codex 会话列表**", ""];
  list.forEach((session, index) => {
    const marker = session._isCurrent || session.id === currentId ? " ← 当前" : "";
    const thread = codexThreadLink(session.codexThreadId);
    lines.push(
      `${index + 1}. ${session.title || "未命名会话"} (${session.id}) · ${thread} · ${sessionContextSummary(session)} · ${formatTime(session.updatedAt)} · ${session.messages.length} 条${marker}`,
    );
  });
  lines.push("");
  lines.push("使用 `/switch <序号或ID>` 切换会话，使用 `/delete <序号或ID>` 删除会话，删除需 `/confirm delete <序号>` 确认，使用 `/new [标题]` 创建新会话。");
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
    eventKeys: CONFIG.eventKeys,
    larkProfile: CONFIG.larkProfile || "default",
    larkCli: toolLabel(CONFIG.larkCli),
    codexCli: toolLabel(CONFIG.codexCli),
    runMode: CONFIG.runMode,
    sandbox: CONFIG.codexSandbox,
    reasoning: codexReasoningLabel,
    codexTimeoutMs: CONFIG.codexTimeoutMs,
    codexIdleTimeoutMs: CONFIG.codexIdleTimeoutMs,
    disableMcp: CONFIG.disableMcp,
    maxConcurrent: CONFIG.maxConcurrent,
    cardMode: CONFIG.useCards,
    cardThrottleMs: CONFIG.cardThrottleMs,
    debugCards: CONFIG.debugCards,
    showFinalSteps: CONFIG.showFinalSteps,
    replyToMessage: CONFIG.replyToMessage,
    replyInThread: CONFIG.useThreadReply,
  });

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
      enqueue(JSON.parse(trimmed));
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
