#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const SERVER_NAME = "codex-browser-control";
const SERVER_VERSION = "0.6.0";
const DEFAULT_PORT = Number(process.env.BROWSER_CONTROL_PORT || 9222);
const DEFAULT_HOST = process.env.BROWSER_CONTROL_HOST || "127.0.0.1";
const EXTENSION_BRIDGE_HOST = process.env.BROWSER_CONTROL_EXTENSION_HOST || "127.0.0.1";
const EXTENSION_BRIDGE_PORT = Number(process.env.BROWSER_CONTROL_EXTENSION_PORT || 18795);
const DEFAULT_EXTENSION_BRIDGE_TOKEN = "<local-extension-token>";
const CONFIG_EXTENSION_BRIDGE_TOKEN = readCodexConfigExtensionToken();
const EXTENSION_BRIDGE_TOKEN = String(process.env.BROWSER_CONTROL_EXTENSION_TOKEN || CONFIG_EXTENSION_BRIDGE_TOKEN || DEFAULT_EXTENSION_BRIDGE_TOKEN);
const EXTENSION_BRIDGE_REQUIRE_TOKEN = process.env.BROWSER_CONTROL_EXTENSION_REQUIRE_TOKEN !== "0";
const EXTENSION_BRIDGE_ALLOW_UNSAFE_CSP = process.env.BROWSER_CONTROL_ALLOW_UNSAFE_CSP === "1";
const EXTENSION_ALLOW_MANAGEMENT = boolEnv(process.env.BROWSER_CONTROL_ALLOW_EXTENSION_MANAGEMENT);
const EXTENSION_ALLOW_CONTENT_SETTINGS = boolEnv(process.env.BROWSER_CONTROL_ALLOW_EXTENSION_CONTENT_SETTINGS);
const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SRC_DIR, "..");
const EXTENSION_BRIDGE_RESTART_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "restart-extension-bridge.ps1");
const OUTPUT_ROOT = path.resolve(process.env.BROWSER_CONTROL_OUTPUT_DIR || path.join(os.homedir(), ".codex", "tmp", "browser-control"));
const ALLOWED_OUTPUT_ROOTS = [...new Set([
  OUTPUT_ROOT,
  path.resolve(os.tmpdir()),
  ...String(process.env.BROWSER_CONTROL_ALLOWED_OUTPUT_DIRS || "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item)),
])];
const DEFAULT_SCREENSHOT_DIR = path.join(OUTPUT_ROOT, "screenshots");
const DEFAULT_DOWNLOAD_DIR = path.join(OUTPUT_ROOT, "downloads");
const DEFAULT_TRACE_DIR = path.join(OUTPUT_ROOT, "traces");
const GENERIC_SIMHTML_BRIDGE = path.join(PACKAGE_ROOT, "vendor", "generic_simphtml_bridge.py");
const launched = new Map();
const extensionSessions = new Map();
const extensionPending = new Map();
const extensionSockets = new Set();
const playwrightSessions = new Map();
let activeTrace = null;
let lastTrace = null;
let playwrightModule = null;
let extensionBridgeServer = null;
let genericSimphtmlAssets = null;
let extensionBridgeStatus = {
  enabled: process.env.BROWSER_CONTROL_EXTENSION_BRIDGE !== "0",
  listening: false,
  proxy: false,
  host: EXTENSION_BRIDGE_HOST,
  port: EXTENSION_BRIDGE_PORT,
  security: extensionBridgeSecurityStatus(),
  error: null,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function asPort(value) {
  const port = Number(value || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function readCodexConfigExtensionToken() {
  try {
    const configPath = path.join(os.homedir(), ".codex", "config.toml");
    if (!existsSync(configPath)) return "";
    const text = readFileSync(configPath, "utf8");
    const match = text.match(/BROWSER_CONTROL_EXTENSION_TOKEN\s*=\s*"([^"]+)"/);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

function asHost(value) {
  return String(value || DEFAULT_HOST);
}

function jsonText(data) {
  return typeof data === "string" ? data : JSON.stringify(data, null, 2);
}

function isPathWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function canonicalBoundaryPath(candidate) {
  let existing = path.resolve(candidate);
  const missingParts = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missingParts.unshift(path.basename(existing));
    existing = parent;
  }
  const canonicalExisting = existsSync(existing) ? realpathSync.native(existing) : existing;
  return path.resolve(canonicalExisting, ...missingParts);
}

function resolveOutputPath(value, fallback, label = "output path") {
  const candidate = value
    ? path.resolve(path.isAbsolute(String(value)) ? String(value) : path.join(OUTPUT_ROOT, String(value)))
    : path.resolve(fallback);
  const canonicalCandidate = canonicalBoundaryPath(candidate);
  if (!ALLOWED_OUTPUT_ROOTS.some((root) => isPathWithin(canonicalCandidate, canonicalBoundaryPath(root)))) {
    throw new Error(`${label} must be inside an allowed output root: ${ALLOWED_OUTPUT_ROOTS.join(", ")}`);
  }
  return candidate;
}

function toolResult(data, extraContent = []) {
  return {
    content: [{ type: "text", text: jsonText(data) }, ...extraContent],
  };
}

function toolError(message, data) {
  return {
    isError: true,
    content: [{ type: "text", text: jsonText(data ? { error: message, data } : { error: message }) }],
  };
}

function traceIdFromName(name = "trace") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = String(name || "trace")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "trace";
  return `${stamp}-${slug}-${randomUUID().slice(0, 8)}`;
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function traceOptions(args = {}) {
  return {
    includeArgs: args.includeArgs !== false,
    includeResults: args.includeResults !== false,
    includeSnapshots: Boolean(args.includeSnapshots),
    includeScreenshots: Boolean(args.includeScreenshots),
    includeConsole: Boolean(args.includeConsole),
    includeNetwork: Boolean(args.includeNetwork),
    screenshotFullPage: Boolean(args.screenshotFullPage),
    redactSensitive: args.redactSensitive !== false,
    maxTextChars: clampNumber(args.maxTextChars, 12000, 500, 200000),
    maxResultChars: clampNumber(args.maxResultChars, 8000, 500, 100000),
    maxEvents: clampNumber(args.maxEvents, 500, 0, 10000),
  };
}

function truncateTraceString(value, maxChars = 8000) {
  const text = String(value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

function traceSensitiveKey(key = "") {
  return /password|passwd|pwd|token|secret|cookie|authorization|api[-_]?key|credential|session/i.test(String(key));
}

function sanitizeTraceValue(value, options = {}, key = "", seen = new WeakSet()) {
  if (options.redactSensitive !== false && traceSensitiveKey(key)) return "[redacted]";
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (key === "script") {
      return { length: value.length };
    }
    return truncateTraceString(value, options.maxResultChars || 8000);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 80).map((item) => sanitizeTraceValue(item, options, key, seen));
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const result = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 120)) {
      result[childKey] = sanitizeTraceValue(childValue, options, childKey, seen);
    }
    return result;
  }
  return String(value);
}

function sanitizeTraceArgs(toolName, args = {}, options = {}) {
  const sanitized = sanitizeTraceValue(args, options);
  if (["browser_type", "browser_locator_type", "browser_playwright_type"].includes(toolName) && sanitized && typeof sanitized === "object" && Object.prototype.hasOwnProperty.call(sanitized, "value")) {
    sanitized.value = `[redacted typed text: ${String(args.value || "").length} chars]`;
  }
  return sanitized;
}

function sanitizeTraceResult(result, options = {}) {
  const textItems = [];
  for (const item of result?.content || []) {
    if (item?.type === "text") {
      let parsed;
      try {
        parsed = JSON.parse(item.text);
      } catch {
        parsed = item.text;
      }
      textItems.push(sanitizeTraceValue(parsed, options));
    } else {
      textItems.push({ type: item?.type || "unknown", omitted: true });
    }
  }
  return {
    isError: Boolean(result?.isError),
    content: textItems,
  };
}

function traceStepForWrite(step) {
  const { trace, originalArgs, ...serializable } = step;
  return serializable;
}

function writeTraceLine(trace, entry) {
  if (!trace) return;
  const line = {
    traceId: trace.id,
    sequence: ++trace.lineSequence,
    at: new Date().toISOString(),
    ...entry,
  };
  try {
    appendFileSync(trace.jsonlPath, `${JSON.stringify(line)}\n`, "utf8");
  } catch (error) {
    trace.writeErrors.push({ at: new Date().toISOString(), error: error.message });
  }
}

function traceSummary(trace) {
  if (!trace) return null;
  const end = trace.endedAt ? new Date(trace.endedAt).getTime() : Date.now();
  const start = new Date(trace.startedAt).getTime();
  return {
    id: trace.id,
    name: trace.name,
    status: trace.status,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    durationMs: Math.max(0, end - start),
    steps: trace.steps.length,
    events: trace.events.length,
    droppedEvents: trace.droppedEvents,
    paths: {
      dir: trace.dir,
      jsonl: trace.jsonlPath,
      export: trace.exportPath,
      artifacts: trace.artifactDir,
    },
    options: trace.options,
    writeErrors: trace.writeErrors,
  };
}

function traceExportPayload(trace) {
  return {
    ...traceSummary(trace),
    steps: trace.steps.map(traceStepForWrite),
    events: trace.events,
  };
}

function exportTrace(trace, outPath) {
  const target = resolveOutputPath(outPath, trace.exportPath, "trace export path");
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(traceExportPayload(trace), null, 2), "utf8");
  return target;
}

function beginTraceStep(toolName, args = {}) {
  const trace = activeTrace;
  if (!trace || String(toolName || "").startsWith("browser_trace_")) return null;
  const step = {
    trace,
    index: ++trace.stepSequence,
    id: `step-${String(trace.stepSequence).padStart(4, "0")}`,
    tool: toolName,
    startedAt: new Date().toISOString(),
    endedAt: null,
    durationMs: null,
    ok: null,
    originalArgs: args,
  };
  if (trace.options.includeArgs) {
    step.args = sanitizeTraceArgs(toolName, args, trace.options);
  }
  trace.steps.push(step);
  writeTraceLine(trace, { type: "tool_start", step: traceStepForWrite(step) });
  return step;
}

function traceUrl(url) {
  if (!url) return "";
  try {
    const parsed = new URL(String(url));
    for (const key of [...parsed.searchParams.keys()]) {
      if (traceSensitiveKey(key)) parsed.searchParams.set(key, "[redacted]");
    }
    return truncateTraceString(parsed.toString(), 1500);
  } catch {
    return truncateTraceString(url, 1500);
  }
}

function collectTraceCdpEvent(tab, message) {
  const trace = activeTrace;
  if (!trace || !message?.method) return;
  const method = message.method;
  const params = message.params || {};
  let event = null;
  if (trace.options.includeConsole && method === "Runtime.consoleAPICalled") {
    event = {
      type: "console",
      level: params.type || "log",
      text: (params.args || []).map((arg) => truncateTraceString(arg.value ?? arg.description ?? arg.type ?? "", 1000)).filter(Boolean),
      stack: params.stackTrace?.callFrames?.slice(0, 3).map((frame) => ({ url: traceUrl(frame.url), lineNumber: frame.lineNumber, columnNumber: frame.columnNumber })),
    };
  } else if (trace.options.includeConsole && method === "Runtime.exceptionThrown") {
    event = {
      type: "exception",
      text: truncateTraceString(params.exceptionDetails?.text || params.exceptionDetails?.exception?.description || "", 2000),
      url: traceUrl(params.exceptionDetails?.url || ""),
      lineNumber: params.exceptionDetails?.lineNumber,
      columnNumber: params.exceptionDetails?.columnNumber,
    };
  } else if (trace.options.includeConsole && method === "Log.entryAdded") {
    event = {
      type: "log",
      level: params.entry?.level,
      text: truncateTraceString(params.entry?.text || "", 2000),
      url: traceUrl(params.entry?.url || ""),
    };
  } else if (trace.options.includeNetwork && method === "Network.requestWillBeSent") {
    event = {
      type: "network_request",
      requestId: params.requestId,
      method: params.request?.method,
      url: traceUrl(params.request?.url || params.documentURL || ""),
      resourceType: params.type,
    };
  } else if (trace.options.includeNetwork && method === "Network.responseReceived") {
    event = {
      type: "network_response",
      requestId: params.requestId,
      status: params.response?.status,
      mimeType: params.response?.mimeType,
      url: traceUrl(params.response?.url || ""),
      resourceType: params.type,
    };
  } else if (trace.options.includeNetwork && method === "Network.loadingFailed") {
    event = {
      type: "network_failed",
      requestId: params.requestId,
      errorText: params.errorText,
      blockedReason: params.blockedReason,
    };
  }
  if (!event) return;
  event.tabId = tab?.id || null;
  event.tabUrl = traceUrl(tab?.url || "");
  event.at = new Date().toISOString();
  if (trace.events.length >= trace.options.maxEvents) {
    trace.droppedEvents += 1;
    return;
  }
  trace.events.push(event);
  writeTraceLine(trace, { type: "browser_event", event });
}

function traceArtifactBase(trace, step, suffix) {
  mkdirSync(trace.artifactDir, { recursive: true });
  return path.join(trace.artifactDir, `${step.id}-${suffix}`);
}

async function captureCdpTraceArtifacts(trace, step, args = {}) {
  return withTab(args, async (cdp, tab) => {
    const artifacts = { tabId: tab.id, url: traceUrl(tab.url || ""), title: tab.title || "" };
    if (trace.options.includeSnapshots) {
      const snapshot = await evaluateValue(cdp, snapshotExpression(Math.min(trace.options.maxTextChars, 50000)), 10000);
      const snapshotPath = traceArtifactBase(trace, step, "snapshot.json");
      writeFileSync(snapshotPath, JSON.stringify(sanitizeTraceValue(snapshot, trace.options), null, 2), "utf8");
      artifacts.snapshot = snapshotPath;
    }
    if (trace.options.includeScreenshots) {
      const format = "png";
      const params = { format, fromSurface: true };
      if (trace.options.screenshotFullPage) {
        const metrics = await cdp.send("Page.getLayoutMetrics").catch(() => null);
        const size = metrics?.contentSize || { width: 1280, height: 720 };
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width: Math.max(1, Math.ceil(size.width)),
          height: Math.max(1, Math.ceil(size.height)),
          deviceScaleFactor: 1,
          mobile: false,
        }).catch(() => {});
        params.captureBeyondViewport = true;
      }
      try {
        const captured = await cdp.send("Page.captureScreenshot", params, 30000);
        const screenshotPath = traceArtifactBase(trace, step, "screenshot.png");
        writeFileSync(screenshotPath, Buffer.from(captured.data, "base64"));
        artifacts.screenshot = screenshotPath;
      } finally {
        if (trace.options.screenshotFullPage) await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
      }
    }
    return artifacts;
  });
}

async function captureExtensionTraceArtifacts(trace, step, toolName, args = {}) {
  if (!trace.options.includeSnapshots || !["browser_extension_scan", "browser_extension_execute_js", "browser_extension_command"].includes(toolName)) return null;
  const sessions = canProxyExtensionBridge() ? await remoteBrowserBridgeSessions(args) : liveBrowserBridgeSessions();
  const session = matchExtensionSession(sessions, args);
  const response = await extensionExecuteForTool(session, snapshotExpression(Math.min(trace.options.maxTextChars, 50000)), args);
  const snapshotPath = traceArtifactBase(trace, step, "extension-snapshot.json");
  writeFileSync(snapshotPath, JSON.stringify(sanitizeTraceValue(response.data, trace.options), null, 2), "utf8");
  return { tabId: session.id, url: traceUrl(session.url || ""), title: session.title || "", snapshot: snapshotPath };
}

function shouldCaptureTraceArtifacts(toolName) {
  return ![
    "browser_status",
    "browser_stop",
    "browser_list_tabs",
    "browser_extension_status",
    "browser_extension_list_tabs",
    "browser_extension_repair",
  ].includes(toolName);
}

async function finishTraceStep(step, result, error) {
  if (!step) return;
  const trace = step.trace;
  step.endedAt = new Date().toISOString();
  step.durationMs = Math.max(0, new Date(step.endedAt).getTime() - new Date(step.startedAt).getTime());
  step.ok = !error && !result?.isError;
  if (error) step.error = { message: error.message };
  if (result && trace.options.includeResults) step.result = sanitizeTraceResult(result, trace.options);
  if ((trace.options.includeSnapshots || trace.options.includeScreenshots) && shouldCaptureTraceArtifacts(step.tool)) {
    try {
      step.artifacts = step.tool.startsWith("browser_extension_")
        ? await captureExtensionTraceArtifacts(trace, step, step.tool, step.originalArgs || {})
        : await captureCdpTraceArtifacts(trace, step, step.originalArgs || {});
    } catch (artifactError) {
      step.artifactError = artifactError.message;
    }
  }
  writeTraceLine(trace, { type: "tool_end", step: traceStepForWrite(step) });
}

function createTrace(args = {}) {
  if (activeTrace) throw new Error(`Trace already active: ${activeTrace.id}. Stop it before starting another trace.`);
  const id = traceIdFromName(args.name || "trace");
  const options = traceOptions(args);
  let dir;
  let jsonlPath;
  let exportPath;
  let artifactDir;
  if (args.path) {
    jsonlPath = resolveOutputPath(args.path, null, "trace path");
    dir = path.dirname(jsonlPath);
    const base = path.basename(jsonlPath, path.extname(jsonlPath));
    exportPath = path.join(dir, `${base}.json`);
    artifactDir = path.join(dir, `${base}-artifacts`);
  } else {
    dir = path.join(resolveOutputPath(args.dir, DEFAULT_TRACE_DIR, "trace directory"), id);
    jsonlPath = path.join(dir, "trace.jsonl");
    exportPath = path.join(dir, "trace.json");
    artifactDir = path.join(dir, "artifacts");
  }
  mkdirSync(dir, { recursive: true });
  if (options.includeSnapshots || options.includeScreenshots) mkdirSync(artifactDir, { recursive: true });
  const trace = {
    id,
    name: String(args.name || "trace"),
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    dir,
    jsonlPath,
    exportPath,
    artifactDir,
    options,
    steps: [],
    events: [],
    droppedEvents: 0,
    writeErrors: [],
    lineSequence: 0,
    stepSequence: 0,
  };
  writeTraceLine(trace, { type: "trace_start", summary: traceSummary(trace) });
  activeTrace = trace;
  return trace;
}

async function toolBrowserTraceStart(args = {}) {
  const trace = createTrace(args);
  return toolResult({ ok: true, active: traceSummary(trace) });
}

async function toolBrowserTraceStatus(args = {}) {
  return toolResult({ ok: true, active: traceSummary(activeTrace), last: traceSummary(lastTrace) });
}

async function toolBrowserTraceStop(args = {}) {
  if (!activeTrace) throw new Error("No active browser trace.");
  const trace = activeTrace;
  trace.status = "stopped";
  trace.endedAt = new Date().toISOString();
  writeTraceLine(trace, { type: "trace_stop", summary: traceSummary(trace) });
  let exported = null;
  if (args.export !== false) exported = exportTrace(trace, args.path);
  activeTrace = null;
  lastTrace = trace;
  return toolResult({ ok: true, stopped: traceSummary(trace), exported });
}

async function toolBrowserTraceExport(args = {}) {
  const trace = activeTrace || lastTrace;
  if (!trace) throw new Error("No active or completed browser trace to export.");
  const exported = exportTrace(trace, args.path);
  return toolResult({ ok: true, active: Boolean(activeTrace && trace === activeTrace), exported, summary: traceSummary(trace) });
}

function pythonBridge(request, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn("python", [GENERIC_SIMHTML_BRIDGE], {
      cwd: path.dirname(GENERIC_SIMHTML_BRIDGE),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`generic_simphtml_bridge timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`generic_simphtml_bridge exited ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`generic_simphtml_bridge returned invalid JSON: ${error.message}; stdout=${stdout}; stderr=${stderr}`));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

async function getGenericSimphtmlAssets() {
  if (!genericSimphtmlAssets) {
    genericSimphtmlAssets = await pythonBridge({ cmd: "assets" });
  }
  return genericSimphtmlAssets;
}

async function genericPostprocessHtml(args = {}) {
  return await pythonBridge({
    cmd: "postprocess",
    content: args.content || "",
    lists: args.lists || [],
    cutlist: args.cutlist !== false,
    text_only: Boolean(args.textOnly),
    maxchars: Number(args.maxChars || 35000),
    instruction: args.instruction || "",
  }, Number(args.timeoutMs || 30000));
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function rpcError(id, code, message, data) {
  send({ jsonrpc: "2.0", id, error: { code, message, data } });
}

function boolEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function safeTokenEqual(actual, expected) {
  const left = Buffer.from(String(actual || ""));
  const right = Buffer.from(String(expected || ""));
  if (!left.length || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function tokenFromRequest(req, body = {}) {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    return req.headers["x-codex-browser-token"] || url.searchParams.get("token") || body.token || "";
  } catch {
    return req.headers["x-codex-browser-token"] || body.token || "";
  }
}

function isBridgeRequestAuthorized(req, body = {}) {
  if (!EXTENSION_BRIDGE_REQUIRE_TOKEN) return true;
  return safeTokenEqual(tokenFromRequest(req, body), EXTENSION_BRIDGE_TOKEN);
}

function writeUnauthorized(res) {
  res.writeHead(401, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: false, error: "Unauthorized browser extension bridge request" }));
}

function extensionBridgeSecurityStatus() {
  return {
    authRequired: EXTENSION_BRIDGE_REQUIRE_TOKEN,
    tokenConfigured: Boolean(EXTENSION_BRIDGE_TOKEN),
    usingDefaultToken: EXTENSION_BRIDGE_TOKEN === DEFAULT_EXTENSION_BRIDGE_TOKEN,
    allowUnsafeCspBypass: EXTENSION_BRIDGE_ALLOW_UNSAFE_CSP,
    allowExtensionManagement: EXTENSION_ALLOW_MANAGEMENT,
    allowExtensionContentSettings: EXTENSION_ALLOW_CONTENT_SETTINGS,
  };
}

function assertExtensionCommandAllowed(command) {
  if (!command || typeof command !== "object") return;
  if (command.cmd === "management" && !EXTENSION_ALLOW_MANAGEMENT) {
    throw new Error("browser extension management commands are disabled. Set BROWSER_CONTROL_ALLOW_EXTENSION_MANAGEMENT=1, enable the extension-side constant, and add the manifest permission only when needed.");
  }
  if (command.cmd === "contentSettings" && !EXTENSION_ALLOW_CONTENT_SETTINGS) {
    throw new Error("browser extension contentSettings commands are disabled. Set BROWSER_CONTROL_ALLOW_EXTENSION_CONTENT_SETTINGS=1, enable the extension-side constant, and add the manifest permission only when needed.");
  }
  if (Array.isArray(command.commands)) {
    for (const item of command.commands) assertExtensionCommandAllowed(item);
  }
}

async function fetchJson(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} ${response.statusText} from ${url}${body ? `: ${body}` : ""}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} ${response.statusText} from ${url}${body ? `: ${body}` : ""}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function debuggerBase(args = {}) {
  return `http://${asHost(args.host)}:${asPort(args.port)}`;
}

async function getVersion(args = {}) {
  return fetchJson(`${debuggerBase(args)}/json/version`, {}, 4000);
}

async function getTargets(args = {}) {
  return fetchJson(`${debuggerBase(args)}/json/list`, {}, 4000);
}

function pageTargets(targets) {
  return targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
}

async function resolveTab(args = {}) {
  const targets = pageTargets(await getTargets(args));
  if (args.tabId || args.targetId) {
    const id = String(args.tabId || args.targetId);
    const found = targets.find((target) => target.id === id);
    if (!found) throw new Error(`No page target found for tabId ${id}`);
    return found;
  }
  if (args.urlPattern) {
    const pattern = String(args.urlPattern);
    const found = targets.find((target) => target.url?.includes(pattern));
    if (!found) throw new Error(`No page target URL contains ${pattern}`);
    return found;
  }
  if (!targets.length) throw new Error("No page targets are available. Use browser_start or browser_open first.");
  return targets[0];
}

async function createTarget(args) {
  const url = String(args.url || "about:blank");
  const targetUrl = `${debuggerBase(args)}/json/new?${encodeURIComponent(url)}`;
  try {
    return await fetchJson(targetUrl, { method: "PUT" }, 5000);
  } catch (error) {
    return await fetchJson(targetUrl, { method: "GET" }, 5000);
  }
}

async function decodeWsData(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (data && typeof data.text === "function") return data.text();
  return String(data);
}

class CdpClient {
  constructor(wsUrl, tab = null) {
    this.wsUrl = wsUrl;
    this.tab = tab;
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = new Map();
    this.ws = new WebSocket(wsUrl);
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out connecting to ${wsUrl}`)), 8000);
      this.ws.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      this.ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error(`Failed to connect to ${wsUrl}`));
      }, { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      decodeWsData(event.data)
        .then((text) => this.handleMessage(JSON.parse(text)))
        .catch((error) => this.rejectAll(error));
    });
    this.ws.addEventListener("close", () => this.rejectAll(new Error("CDP websocket closed")));
  }

  handleMessage(message) {
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, reject, timer } = this.pending.get(message.id);
      clearTimeout(timer);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message || "CDP error"} ${JSON.stringify(message.error.data || {})}`));
      else resolve(message.result || {});
      return;
    }
    if (message.method && this.eventWaiters.has(message.method)) {
      const waiters = this.eventWaiters.get(message.method);
      const remaining = [];
      for (const waiter of waiters) {
        let matched = true;
        try {
          matched = waiter.predicate ? waiter.predicate(message.params || {}) : true;
        } catch (error) {
          clearTimeout(waiter.timer);
          waiter.reject(error);
          continue;
        }
        if (!matched) {
          remaining.push(waiter);
          continue;
        }
        clearTimeout(waiter.timer);
        waiter.resolve(message.params || {});
      }
      if (remaining.length) this.eventWaiters.set(message.method, remaining);
      else this.eventWaiters.delete(message.method);
    }
    collectTraceCdpEvent(this.tab, message);
  }

  async send(method, params = {}, timeoutMs = 15000) {
    await this.ready;
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(payload);
    });
  }

  waitForEvent(method, timeoutMs = 10000, predicate = null) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = this.eventWaiters.get(method) || [];
        this.eventWaiters.set(method, waiters.filter((waiter) => waiter.timer !== timer));
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      const waiters = this.eventWaiters.get(method) || [];
      waiters.push({ resolve, reject, timer, predicate });
      this.eventWaiters.set(method, waiters);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // Best effort close.
    }
    this.rejectAll(new Error("CDP connection closed"));
  }

  rejectAll(error) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const [, waiters] of this.eventWaiters) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.eventWaiters.clear();
  }
}

async function withTab(args, callback) {
  const tab = await resolveTab(args);
  const cdp = new CdpClient(tab.webSocketDebuggerUrl, tab);
  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    if (activeTrace?.options.includeConsole) {
      await cdp.send("Log.enable").catch(() => {});
    }
    if (activeTrace?.options.includeNetwork) {
      await cdp.send("Network.enable").catch(() => {});
    }
    return await callback(cdp, tab);
  } finally {
    cdp.close();
  }
}

async function withRawTab(args, callback) {
  const tab = await resolveTab(args);
  const cdp = new CdpClient(tab.webSocketDebuggerUrl, tab);
  try {
    return await callback(cdp, tab);
  } finally {
    cdp.close();
  }
}

async function withBrowser(args, callback) {
  const version = await getVersion(args);
  if (!version.webSocketDebuggerUrl) {
    throw new Error("Debugger version endpoint did not expose a browser websocket URL");
  }
  const cdp = new CdpClient(version.webSocketDebuggerUrl);
  try {
    return await callback(cdp, version);
  } finally {
    cdp.close();
  }
}

function wsAcceptKey(key) {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function wsFrameText(text) {
  const payload = Buffer.from(text);
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function wsSend(socket, data) {
  if (!socket || socket.destroyed) return;
  socket.write(wsFrameText(typeof data === "string" ? data : JSON.stringify(data)));
}

function wsClose(socket) {
  try {
    socket.end(Buffer.from([0x88, 0x00]));
  } catch {
    socket.destroy();
  }
}

function decodeWsFrames(socket, chunk) {
  socket._wsBuffer = socket._wsBuffer ? Buffer.concat([socket._wsBuffer, chunk]) : chunk;
  const messages = [];
  let offset = 0;
  while (socket._wsBuffer.length - offset >= 2) {
    const start = offset;
    const first = socket._wsBuffer[offset++];
    const second = socket._wsBuffer[offset++];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    if (length === 126) {
      if (socket._wsBuffer.length - offset < 2) { offset = start; break; }
      length = socket._wsBuffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (socket._wsBuffer.length - offset < 8) { offset = start; break; }
      const bigLength = socket._wsBuffer.readBigUInt64BE(offset);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket frame too large");
      length = Number(bigLength);
      offset += 8;
    }
    let mask;
    if (masked) {
      if (socket._wsBuffer.length - offset < 4) { offset = start; break; }
      mask = socket._wsBuffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (socket._wsBuffer.length - offset < length) { offset = start; break; }
    const payload = Buffer.from(socket._wsBuffer.subarray(offset, offset + length));
    offset += length;
    if (masked) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    if (opcode === 0x8) {
      wsClose(socket);
      continue;
    }
    if (opcode === 0x9) {
      socket.write(Buffer.from([0x8a, 0x00]));
      continue;
    }
    if (opcode === 0x1) messages.push(payload.toString("utf8"));
  }
  socket._wsBuffer = socket._wsBuffer.subarray(offset);
  return messages;
}

function updateExtensionTabs(socket, tabs = []) {
  const nextIds = new Set(tabs.map((tab) => String(tab.id)));
  socket._extensionSessionIds ||= new Set();
  for (const oldId of [...socket._extensionSessionIds]) {
    if (!nextIds.has(oldId)) {
      const session = extensionSessions.get(oldId);
      if (session && session.socket === socket) session.active = false;
      socket._extensionSessionIds.delete(oldId);
    }
  }
  for (const tab of tabs) {
    const id = String(tab.id);
    extensionSessions.set(id, {
      id,
      numericId: Number(tab.id),
      title: tab.title || "",
      url: tab.url || "",
      active: true,
      type: "ext_ws",
      connectedAt: extensionSessions.get(id)?.connectedAt || Date.now(),
      updatedAt: Date.now(),
      socket,
    });
    socket._extensionSessionIds.add(id);
  }
}

function handleExtensionMessage(socket, text) {
  if (!text || text === "{\"type\":\"ping\"}") return;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return;
  }
  if (data.type === "ready") {
    const id = String(data.sessionId || randomUUID());
    socket._extensionSessionIds ||= new Set();
    extensionSessions.set(id, {
      id,
      numericId: Number.NaN,
      title: data.title || "",
      url: data.url || "",
      active: true,
      type: "ws",
      connectedAt: extensionSessions.get(id)?.connectedAt || Date.now(),
      updatedAt: Date.now(),
      socket,
    });
    socket._extensionSessionIds.add(id);
    return;
  }
  if (data.type === "ext_ready" || data.type === "tabs_update") {
    updateExtensionTabs(socket, data.tabs || []);
    return;
  }
  if (data.type === "ack") {
    const pending = extensionPending.get(data.id);
    if (pending) pending.acked = true;
    return;
  }
  if (data.type === "result" || data.type === "error") {
    const pending = extensionPending.get(data.id);
    if (!pending) return;
    extensionPending.delete(data.id);
    clearTimeout(pending.timer);
    if (data.type === "error") pending.reject(Object.assign(new Error(typeof data.error === "string" ? data.error : JSON.stringify(data.error)), { newTabs: data.newTabs || [] }));
    else pending.resolve({ data: data.result, newTabs: data.newTabs || [] });
  }
}

function startExtensionBridge() {
  if (!extensionBridgeStatus.enabled) return;
  const server = createServer(async (req, res) => {
    try {
      if (req.url === "/api/longpoll" && req.method === "POST") {
        const data = await readRequestJson(req);
        if (!isBridgeRequestAuthorized(req, data)) return writeUnauthorized(res);
        const id = String(data.sessionId || randomUUID());
        let session = extensionSessions.get(id);
        if (!session) {
          session = {
            id,
            numericId: Number.NaN,
            title: data.title || "",
            url: data.url || "",
            active: true,
            type: "http",
            connectedAt: Date.now(),
            updatedAt: Date.now(),
            httpQueue: [],
          };
          extensionSessions.set(id, session);
        }
        session.title = data.title || session.title || "";
        session.url = data.url || session.url || "";
        session.active = true;
        session.updatedAt = Date.now();
        const started = Date.now();
        while (Date.now() - started < 5000) {
          if (session.httpQueue?.length) {
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(session.httpQueue.shift());
            return;
          }
          await sleep(200);
        }
        httpJson(res, { id: "", ret: "next long-poll" });
        return;
      }
      if (req.url === "/api/result" && req.method === "POST") {
        const data = await readRequestJson(req);
        if (!isBridgeRequestAuthorized(req, data)) return writeUnauthorized(res);
        const pending = extensionPending.get(data.id);
        if (pending) {
          extensionPending.delete(data.id);
          clearTimeout(pending.timer);
          if (data.type === "error") pending.reject(Object.assign(new Error(typeof data.error === "string" ? data.error : JSON.stringify(data.error)), { newTabs: data.newTabs || [] }));
          else pending.resolve({ data: data.result, newTabs: data.newTabs || [] });
        }
        httpJson(res, { ok: true });
        return;
      }
      if (req.url === "/link" && req.method === "POST") {
        const data = await readRequestJson(req);
        if (!isBridgeRequestAuthorized(req, data)) return writeUnauthorized(res);
        if (data.cmd === "get_health") {
          httpJson(res, { r: extensionBridgeHealth() });
          return;
        }
        if (data.cmd === "get_all_sessions") {
          httpJson(res, { r: liveBrowserBridgeSessions().map((session) => ({
            id: session.id,
            url: session.url,
            title: session.title,
            type: session.type,
            connected_at: session.connectedAt / 1000,
          })) });
          return;
        }
        if (data.cmd === "find_session") {
          const urlPattern = String(data.url_pattern || "");
          const matches = liveBrowserBridgeSessions()
            .filter((session) => !urlPattern || session.url.includes(urlPattern))
            .map((session) => [session.id, { url: session.url, title: session.title, type: session.type }]);
          httpJson(res, { r: matches });
          return;
        }
        if (data.cmd === "execute_js") {
          try {
            const session = resolveExtensionSession({ sessionId: data.sessionId });
            assertExtensionCommandAllowed(data.code);
            const result = await extensionExecute(session, data.code || "", { timeoutMs: Number(data.timeout || 15) * 1000 });
            httpJson(res, { r: result });
          } catch (error) {
            httpJson(res, { r: { error: error.message } });
          }
          return;
        }
        httpJson(res, { ok: true });
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("codex-browser-control extension bridge\n");
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: error.message }));
    }
  });
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key || !isBridgeRequestAuthorized(req)) {
      if (key) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      }
      socket.destroy();
      return;
    }
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${wsAcceptKey(key)}`,
      "\r\n",
    ].join("\r\n"));
    socket._extensionSessionIds = new Set();
    extensionSockets.add(socket);
    socket.on("data", (chunk) => {
      try {
        for (const message of decodeWsFrames(socket, chunk)) handleExtensionMessage(socket, message);
      } catch {
        socket.destroy();
      }
    });
    socket.on("close", () => {
      extensionSockets.delete(socket);
      for (const sessionId of socket._extensionSessionIds || []) {
        const session = extensionSessions.get(sessionId);
        if (session && session.socket === socket) session.active = false;
      }
    });
    socket.on("error", () => {});
  });
  extensionBridgeServer = server;
  server.on("error", (error) => {
    extensionBridgeStatus = {
      ...extensionBridgeStatus,
      listening: false,
      proxy: error.code === "EADDRINUSE",
      error: error.message,
    };
  });
  server.listen(EXTENSION_BRIDGE_PORT, EXTENSION_BRIDGE_HOST, () => {
    extensionBridgeStatus = { ...extensionBridgeStatus, listening: true, proxy: false, error: null };
  });
}

function liveExtensionSessions() {
  return [...extensionSessions.values()]
    .filter((session) => session.active && session.socket && !session.socket.destroyed)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function liveBrowserBridgeSessions() {
  return [...extensionSessions.values()]
    .filter((session) => session.active && ((session.socket && !session.socket.destroyed) || session.type === "http"))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function resolveExtensionSession(args = {}) {
  const sessions = liveBrowserBridgeSessions();
  return matchExtensionSession(sessions, args);
}

function extensionExecute(session, code, args = {}) {
  if (!session) throw new Error("No browser bridge session selected");
  const id = randomUUID();
  const timeoutMs = Number(args.timeoutMs || 15000);
  const payload = Number.isFinite(session.numericId) ? { id, code, tabId: session.numericId } : { id, code };
  if (session.type === "http") {
    session.httpQueue ||= [];
    session.httpQueue.push(JSON.stringify(payload));
  } else {
    if (!session.socket || session.socket.destroyed) throw new Error(`Extension session ${session.id || ""} is not connected`);
    wsSend(session.socket, payload);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      extensionPending.delete(id);
      reject(new Error(`Extension command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    extensionPending.set(id, { resolve, reject, timer, acked: false });
  });
}

function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 10 * 1024 * 1024) {
        reject(new Error("Request body is too large"));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function httpJson(res, data) {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function extensionBridgeUrl(pathname = "/link") {
  const host = EXTENSION_BRIDGE_HOST.includes(":") ? `[${EXTENSION_BRIDGE_HOST}]` : EXTENSION_BRIDGE_HOST;
  return `http://${host}:${EXTENSION_BRIDGE_PORT}${pathname}`;
}

function canProxyExtensionBridge() {
  return Boolean(extensionBridgeStatus.proxy || String(extensionBridgeStatus.error || "").includes("EADDRINUSE"));
}

async function postExtensionBridge(command, args = {}) {
  const timeoutMs = Number(args.timeoutMs || 15000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(extensionBridgeUrl("/link"), {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-codex-browser-token": EXTENSION_BRIDGE_TOKEN,
      },
      body: JSON.stringify({ ...command, token: EXTENSION_BRIDGE_TOKEN }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Extension bridge HTTP ${response.status}: ${text.slice(0, 500)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Extension bridge returned invalid JSON: ${text.slice(0, 500)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function remoteBrowserBridgeSessions(args = {}) {
  const response = await postExtensionBridge({ cmd: "get_all_sessions" }, args);
  const sessions = Array.isArray(response.r) ? response.r : [];
  const now = Date.now();
  return sessions.map((session) => ({
    id: String(session.id),
    title: session.title || "",
    url: session.url || "",
    type: session.type || "proxy",
    connectedAt: Number(session.connected_at ? session.connected_at * 1000 : now),
    updatedAt: now,
    proxy: true,
  })).sort((a, b) => b.updatedAt - a.updatedAt);
}

function extensionBridgeHealth() {
  return {
    server: SERVER_NAME,
    version: SERVER_VERSION,
    bridge: extensionBridgeStatus,
    sockets: extensionSockets.size,
    pending: extensionPending.size,
    sessions: liveBrowserBridgeSessions().map((session) => ({
      id: session.id,
      title: session.title,
      url: session.url,
      type: session.type,
      connectedAt: new Date(session.connectedAt).toISOString(),
      updatedAt: new Date(session.updatedAt).toISOString(),
    })),
    time: new Date().toISOString(),
  };
}

async function remoteBrowserBridgeHealth(args = {}) {
  try {
    const response = await postExtensionBridge({ cmd: "get_health" }, args);
    return response.r || null;
  } catch (error) {
    return { error: error.message };
  }
}

function extensionBridgeMode() {
  if (!extensionBridgeStatus.enabled) return "disabled";
  if (extensionBridgeStatus.listening) return "listening";
  if (canProxyExtensionBridge()) return "proxy";
  if (extensionBridgeStatus.error) return "error";
  return "starting";
}

function bridgeRecommendation(status) {
  if (status === "proxy_no_sessions" || status === "listening_no_sessions") {
    return "Bridge is reachable but no Edge/Chrome extension sessions are connected. Reload Codex Browser Control Bridge (18795), or run browser_extension_repair from a proxy MCP process.";
  }
  if (status === "bridge_unreachable") {
    return "Bridge endpoint is not reachable. Start or repair the 18795 bridge process.";
  }
  if (status === "disabled") {
    return "Extension bridge is disabled by BROWSER_CONTROL_EXTENSION_BRIDGE=0.";
  }
  return null;
}

async function extensionBridgeDiagnostics(args = {}) {
  const mode = extensionBridgeMode();
  const proxy = canProxyExtensionBridge();
  let sessions = [];
  let health = null;
  let error = null;
  if (proxy) {
    try {
      sessions = await remoteBrowserBridgeSessions(args);
    } catch (remoteError) {
      error = remoteError.message;
    }
    health = await remoteBrowserBridgeHealth(args);
    if (health?.error && !error) error = health.error;
  } else {
    sessions = liveBrowserBridgeSessions();
    health = extensionBridgeHealth();
  }
  const status = !extensionBridgeStatus.enabled
    ? "disabled"
    : error
      ? "bridge_unreachable"
      : sessions.length
        ? (proxy ? "proxy_healthy" : "listening_healthy")
        : (proxy ? "proxy_no_sessions" : "listening_no_sessions");
  return {
    status,
    mode,
    bridge: { ...extensionBridgeStatus },
    sockets: extensionSockets.size,
    sessionCount: sessions.length,
    sessions,
    health,
    error,
    recommendation: bridgeRecommendation(status),
  };
}

async function extensionBridgeView(args = {}) {
  const diagnostics = await extensionBridgeDiagnostics(args);
  const bridge = {
    ...diagnostics.bridge,
    available: !diagnostics.error,
    mode: diagnostics.mode,
    status: diagnostics.status,
    sessionCount: diagnostics.sessionCount,
    recommendation: diagnostics.recommendation,
    proxyTargetReachable: diagnostics.mode === "proxy" ? !diagnostics.error : undefined,
    proxyError: diagnostics.mode === "proxy" ? diagnostics.error : undefined,
  };
  if (diagnostics.mode === "proxy" && !diagnostics.error) {
    bridge.error = null;
    bridge.reusedExternalBridge = true;
  }
  return {
    bridge,
    sessions: diagnostics.sessions,
    diagnostics,
  };
}

function assertExtensionBridgeConfiguration() {
  if (extensionBridgeStatus.enabled && EXTENSION_BRIDGE_REQUIRE_TOKEN && EXTENSION_BRIDGE_TOKEN === DEFAULT_EXTENSION_BRIDGE_TOKEN) {
    throw new Error("Browser extension bridge authentication is enabled but no private token is configured. Set BROWSER_CONTROL_EXTENSION_TOKEN or disable the extension bridge explicitly.");
  }
}

function runChildCommand(command, args = [], options = {}) {
  const timeoutMs = Number(options.timeoutMs || 15000);
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd || PACKAGE_ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ ok: false, code: null, stdout, stderr, error: `Timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr, error: error.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function restartExternalExtensionBridge(args = {}) {
  if (process.platform !== "win32") {
    return { ok: false, skipped: true, reason: "Automatic bridge restart is currently implemented for Windows only." };
  }
  if (!existsSync(EXTENSION_BRIDGE_RESTART_SCRIPT)) {
    return { ok: false, skipped: true, reason: `Missing restart script: ${EXTENSION_BRIDGE_RESTART_SCRIPT}` };
  }
  return runChildCommand("powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    EXTENSION_BRIDGE_RESTART_SCRIPT,
  ], { timeoutMs: Number(args.timeoutMs || 20000), cwd: PACKAGE_ROOT });
}

async function waitForExtensionSessions(args = {}, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = await extensionBridgeDiagnostics({ ...args, timeoutMs: Math.min(timeoutMs, 5000) });
  while (!last.sessionCount && Date.now() < deadline) {
    await sleep(500);
    last = await extensionBridgeDiagnostics({ ...args, timeoutMs: Math.min(Math.max(deadline - Date.now(), 1000), 5000) });
  }
  return last;
}

function matchExtensionSession(sessions, args = {}) {
  const requested = args.extensionTabId ?? args.sessionId ?? args.switchTabId ?? args.switch_tab_id ?? args.tabId;
  if (requested != null) {
    const id = String(requested);
    const found = sessions.find((session) => session.id === id);
    if (!found) throw new Error(`No extension tab session found for ${id}`);
    return found;
  }
  if (args.urlPattern) {
    const found = sessions.find((session) => session.url.includes(String(args.urlPattern)));
    if (!found) throw new Error(`No extension tab URL contains ${args.urlPattern}`);
    return found;
  }
  if (!sessions.length) throw new Error("No extension-controlled tabs are connected. Install/enable Codex Browser Control Bridge (18795) or open a normal http(s) page.");
  return sessions[0];
}

async function resolveExtensionSessionForTool(args = {}) {
  if (canProxyExtensionBridge()) {
    return matchExtensionSession(await remoteBrowserBridgeSessions(args), args);
  }
  return resolveExtensionSession(args);
}

async function extensionExecuteForTool(session, code, args = {}) {
  assertExtensionCommandAllowed(code);
  if (!session?.proxy) return extensionExecute(session, code, args);
  const timeoutMs = Number(args.timeoutMs || 15000);
  const response = await postExtensionBridge({
    cmd: "execute_js",
    sessionId: session.id,
    timeout: Math.ceil(timeoutMs / 1000),
    code,
  }, { ...args, timeoutMs: timeoutMs + 5000 });
  const result = response.r;
  if (result && typeof result === "object" && result.error) throw new Error(result.error);
  return { data: result, newTabs: [] };
}

function exceptionText(exceptionDetails) {
  if (!exceptionDetails) return "";
  return exceptionDetails.exception?.description
    || exceptionDetails.text
    || JSON.stringify(exceptionDetails);
}

async function evaluateValue(cdp, expression, timeoutMs = 15000) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, timeoutMs);
  if (result.exceptionDetails) throw new Error(exceptionText(result.exceptionDetails));
  if (Object.prototype.hasOwnProperty.call(result.result || {}, "value")) return result.result.value;
  if (Object.prototype.hasOwnProperty.call(result.result || {}, "unserializableValue")) return result.result.unserializableValue;
  return result.result?.description ?? null;
}

function standardBrowserExecutablePaths() {
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean);
  return roots.flatMap((root) => [
    path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
  ]);
}

function allowedPortableBrowserPaths() {
  return String(process.env.BROWSER_CONTROL_ALLOWED_BROWSER_PATHS || "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
}

function validateBrowserExecutable(executablePath, source = "executablePath") {
  const resolved = path.resolve(String(executablePath));
  const basename = path.basename(resolved).toLowerCase();
  if (!["chrome.exe", "msedge.exe"].includes(basename)) {
    throw new Error(`${source} must point to Google Chrome (chrome.exe) or Microsoft Edge (msedge.exe).`);
  }
  if (!existsSync(resolved)) throw new Error(`${source} does not exist: ${resolved}`);
  const canonical = realpathSync.native(resolved);
  if (canonical.toLowerCase() !== resolved.toLowerCase()) {
    throw new Error(`${source} must be a real executable path, not a symlink or junction path: ${resolved}`);
  }
  const approved = [...standardBrowserExecutablePaths(), ...allowedPortableBrowserPaths()]
    .filter((candidate) => existsSync(candidate))
    .map((candidate) => path.resolve(candidate).toLowerCase());
  if (!approved.includes(canonical.toLowerCase())) {
    throw new Error(`${source} is not an approved Chrome/Edge installation path. Use a standard Google/Microsoft installation or list the exact portable executable in BROWSER_CONTROL_ALLOWED_BROWSER_PATHS.`);
  }
  return canonical;
}

function findBrowserExecutable(browser, explicitPath) {
  if (explicitPath) return validateBrowserExecutable(explicitPath);
  if (process.env.BROWSER_CONTROL_BROWSER_PATH) return validateBrowserExecutable(process.env.BROWSER_CONTROL_BROWSER_PATH, "BROWSER_CONTROL_BROWSER_PATH");

  const standard = standardBrowserExecutablePaths();
  const chrome = standard.filter((candidate) => path.basename(candidate).toLowerCase() === "chrome.exe");
  const edge = standard.filter((candidate) => path.basename(candidate).toLowerCase() === "msedge.exe");
  const candidates = String(browser || "edge").toLowerCase().includes("chrome") ? chrome : edge;
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`No standard ${String(browser || "edge")} executable was found. Configure BROWSER_CONTROL_BROWSER_PATH and allow its exact path with BROWSER_CONTROL_ALLOWED_BROWSER_PATHS for a portable installation.`);
  return validateBrowserExecutable(found, "auto-detected browser executable");
}

async function waitForDebugger(args, timeoutMs = 15000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      return await getVersion(args);
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw new Error(`Browser debugger did not become ready on ${debuggerBase(args)}: ${lastError?.message || "unknown error"}`);
}

async function toolBrowserStart(args = {}) {
  const port = asPort(args.port);
  const host = asHost(args.host);
  try {
    const version = await getVersion({ port, host });
    return toolResult({ ok: true, alreadyRunning: true, host, port, version });
  } catch {
    // Continue and launch a browser.
  }

  const executable = findBrowserExecutable(args.browser, args.executablePath);
  const profileRoot = path.join(os.tmpdir(), "codex-browser-control");
  const userDataDir = path.resolve(args.userDataDir || path.join(profileRoot, `profile-${port}`));
  mkdirSync(userDataDir, { recursive: true });

  const flags = [
    `--remote-debugging-port=${port}`,
    `--remote-debugging-address=${host}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (args.headless) flags.push("--headless=new", "--disable-gpu");
  if (Array.isArray(args.extraArgs)) flags.push(...args.extraArgs.map(String));
  flags.push(String(args.url || "about:blank"));

  const child = spawn(executable, flags, { detached: true, stdio: "ignore", windowsHide: Boolean(args.headless) });
  child.unref();
  launched.set(port, { pid: child.pid, executable, userDataDir, host });

  const version = await waitForDebugger({ port, host }, Number(args.timeoutMs || 15000));
  return toolResult({
    ok: true,
    started: true,
    pid: child.pid,
    executable,
    host,
    port,
    userDataDir,
    browser: version.Browser,
    webSocketDebuggerUrl: version.webSocketDebuggerUrl,
  });
}

async function toolBrowserStatus(args = {}) {
  try {
    const version = await getVersion(args);
    return toolResult({
      connected: true,
      host: asHost(args.host),
      port: asPort(args.port),
      version,
      launchedByThisServer: launched.get(asPort(args.port)) || null,
    });
  } catch (error) {
    return toolResult({
      connected: false,
      host: asHost(args.host),
      port: asPort(args.port),
      error: error.message,
      hint: "Use browser_start, or launch Chrome/Edge with --remote-debugging-port and --remote-debugging-address=127.0.0.1.",
    });
  }
}

async function toolBrowserStop(args = {}) {
  const port = asPort(args.port);
  const host = asHost(args.host);
  const version = await getVersion({ port, host });
  if (!version.webSocketDebuggerUrl) {
    throw new Error("Debugger version endpoint did not expose a browser websocket URL");
  }

  const cdp = new CdpClient(version.webSocketDebuggerUrl);
  try {
    await cdp.send("Browser.close", {}, Number(args.timeoutMs || 5000));
  } catch (error) {
    const info = launched.get(port);
    if (!info?.pid) throw error;
    try {
      process.kill(info.pid);
    } catch {
      throw error;
    }
  } finally {
    launched.delete(port);
    cdp.close();
  }
  return toolResult({ ok: true, host, port, closed: true });
}

async function toolBrowserListTabs(args = {}) {
  const targets = await getTargets(args);
  return toolResult({
    host: asHost(args.host),
    port: asPort(args.port),
    tabs: pageTargets(targets).map((target) => ({
      id: target.id,
      title: target.title,
      url: target.url,
      type: target.type,
      devtoolsFrontendUrl: target.devtoolsFrontendUrl,
    })),
  });
}

async function waitForPageSettled(cdp, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await evaluateValue(cdp, "document.readyState", 5000).catch(() => "loading");
    if (state === "complete" || state === "interactive") return state;
    await sleep(200);
  }
  return "timeout";
}

async function toolBrowserOpen(args = {}) {
  if (!args.url) throw new Error("browser_open requires url");
  const url = String(args.url);
  if (args.tabId && args.newTab === false) {
    return withTab(args, async (cdp, tab) => {
      await cdp.send("Page.navigate", { url });
      const readyState = await waitForPageSettled(cdp, Number(args.timeoutMs || 10000));
      return toolResult({ ok: true, reusedTab: true, tabId: tab.id, url, readyState });
    });
  }

  const target = await createTarget(args);
  const settled = await withTab({ ...args, tabId: target.id }, async (cdp) => waitForPageSettled(cdp, Number(args.timeoutMs || 10000)));
  return toolResult({
    ok: true,
    newTab: true,
    tabId: target.id,
    title: target.title,
    url: target.url || url,
    readyState: settled,
  });
}

async function toolBrowserActivate(args = {}) {
  if (!args.tabId && !args.targetId) throw new Error("browser_activate requires tabId");
  const id = encodeURIComponent(String(args.tabId || args.targetId));
  const result = await fetchText(`${debuggerBase(args)}/json/activate/${id}`, {}, 5000);
  return toolResult({ ok: true, tabId: String(args.tabId || args.targetId), result });
}

async function toolBrowserClose(args = {}) {
  if (!args.tabId && !args.targetId) throw new Error("browser_close requires tabId");
  const id = encodeURIComponent(String(args.tabId || args.targetId));
  const result = await fetchText(`${debuggerBase(args)}/json/close/${id}`, {}, 5000);
  return toolResult({ ok: true, tabId: String(args.tabId || args.targetId), result });
}

function targetSummary(target) {
  if (!target) return null;
  return {
    id: target.id,
    title: target.title || "",
    url: target.url || "",
    type: target.type || "",
    attached: target.attached,
  };
}

async function waitForNewPageTarget(args = {}, beforeIds = new Set(), timeoutMs = 10000) {
  const started = Date.now();
  let lastTargets = [];
  while (Date.now() - started < timeoutMs) {
    const targets = pageTargets(await getTargets(args));
    lastTargets = targets;
    const found = targets.find((target) => !beforeIds.has(target.id));
    if (found) return { target: found, waitedMs: Date.now() - started };
    await sleep(Number(args.intervalMs || 250));
  }
  return { target: null, waitedMs: Date.now() - started, targets: lastTargets };
}

async function toolBrowserWaitForNewTab(args = {}) {
  const timeoutMs = Number(args.timeoutMs || 10000);
  const beforeIds = new Set(Array.isArray(args.existingTabIds) ? args.existingTabIds.map(String) : []);
  if (!beforeIds.size) {
    const current = pageTargets(await getTargets(args));
    for (const target of current) beforeIds.add(target.id);
    if (args.actionScript) {
      await withTab(args, async (cdp) => {
        const result = await cdp.send("Runtime.evaluate", {
          expression: `(async () => { ${args.actionScript}\n})()`,
          awaitPromise: true,
          returnByValue: args.returnByValue !== false,
          userGesture: true,
        }, Number(args.actionTimeoutMs || args.timeoutMs || 15000));
        if (result.exceptionDetails) throw new Error(exceptionText(result.exceptionDetails));
      });
    }
  }
  const waited = await waitForNewPageTarget(args, beforeIds, timeoutMs);
  if (!waited.target) {
    return toolError("Timed out waiting for a new tab", { waitedMs: waited.waitedMs, currentTabs: (waited.targets || []).map(targetSummary) });
  }
  return toolResult({ ok: true, waitedMs: waited.waitedMs, tab: targetSummary(waited.target) });
}

async function maybeWaitForNewTabAfterAction(args, action) {
  if (!args.waitForNewTab) {
    return { actionResult: await action(), newTab: null };
  }
  const before = pageTargets(await getTargets(args));
  const beforeIds = new Set(before.map((target) => target.id));
  const actionResult = await action();
  const waited = await waitForNewPageTarget(args, beforeIds, Number(args.newTabTimeoutMs || args.timeoutMs || 10000));
  if (!waited.target && args.requireNewTab) {
    throw new Error(`Timed out waiting for new tab after action (${waited.waitedMs}ms)`);
  }
  return { actionResult, newTab: waited.target ? { waitedMs: waited.waitedMs, tab: targetSummary(waited.target) } : null };
}

async function toolBrowserDialog(args = {}) {
  const action = String(args.action || "wait");
  const timeoutMs = Number(args.timeoutMs || 10000);
  return withRawTab(args, async (cdp, tab) => {
    const enableDialogEvents = async () => {
      await cdp.send("Page.enable", {}, Math.min(3000, Math.max(1000, timeoutMs))).catch(() => {});
    };
    const handleDialog = async (dialog = null, mode = "event") => {
      const params = { accept: action === "accept" };
      if (args.promptText != null) params.promptText = String(args.promptText);
      await cdp.send("Page.handleJavaScriptDialog", params, Number(args.handleTimeoutMs || 5000));
      return toolResult({ ok: true, tabId: tab.id, action, dialog, mode });
    };
    const runActionScript = async () => {
      if (typeof args.actionScript !== "string") return null;
      const result = await cdp.send("Runtime.evaluate", {
        expression: `(async () => { ${args.actionScript}\n})()`,
        awaitPromise: true,
        returnByValue: args.returnByValue !== false,
        userGesture: true,
      }, Number(args.actionTimeoutMs || args.timeoutMs || 15000));
      if (result.exceptionDetails) throw new Error(exceptionText(result.exceptionDetails));
      return result.result || null;
    };
    if (action === "wait") {
      await enableDialogEvents();
      const waiting = cdp.waitForEvent("Page.javascriptDialogOpening", timeoutMs);
      const actionRun = runActionScript();
      if (actionRun) actionRun.catch(() => {});
      const dialog = await waiting;
      return toolResult({ ok: true, tabId: tab.id, dialog });
    }
    if (action === "accept" || action === "dismiss") {
      if (args.waitForDialog !== false) {
        await enableDialogEvents();
        const waiting = cdp.waitForEvent("Page.javascriptDialogOpening", timeoutMs).catch(() => null);
        const actionRun = runActionScript();
        const maybeDialog = await waiting;
        if (maybeDialog) {
          const handled = await handleDialog(maybeDialog, "event");
          if (actionRun) await actionRun.catch(() => null);
          return handled;
        }
        if (actionRun) await actionRun.catch(() => null);
      }
      return handleDialog(null, "direct");
    }
    throw new Error("browser_dialog action must be wait, accept, or dismiss");
  });
}

function downloadBehaviorParams(args = {}) {
  const downloadPath = resolveOutputPath(args.downloadPath || args.path, DEFAULT_DOWNLOAD_DIR, "download directory");
  mkdirSync(downloadPath, { recursive: true });
  const behavior = args.behavior || "allow";
  return {
    downloadPath,
    params: {
      behavior,
      downloadPath,
      eventsEnabled: args.eventsEnabled !== false,
    },
  };
}

async function setDownloadBehavior(cdp, args = {}) {
  const { downloadPath, params } = downloadBehaviorParams(args);
  await cdp.send("Browser.setDownloadBehavior", params, Number(args.timeoutMs || 15000));
  return downloadPath;
}

async function toolBrowserSetDownloadBehavior(args = {}) {
  return withBrowser(args, async (cdp) => {
    const downloadPath = await setDownloadBehavior(cdp, args);
    return toolResult({ ok: true, behavior: args.behavior || "allow", downloadPath, eventsEnabled: args.eventsEnabled !== false });
  });
}

async function toolBrowserWaitForDownload(args = {}) {
  const timeoutMs = Number(args.timeoutMs || 30000);
  return withBrowser(args, async (cdp) => {
    const started = Date.now();
    const downloadPath = await setDownloadBehavior(cdp, args);
    const suggestedFilename = args.suggestedFilename ? String(args.suggestedFilename) : null;
    const willBegin = cdp.waitForEvent("Browser.downloadWillBegin", timeoutMs, (event) => {
      if (suggestedFilename && !String(event.suggestedFilename || "").includes(suggestedFilename)) return false;
      return true;
    });
    const begin = await willBegin;
    let progress = begin;
    while (true) {
      const remainingMs = Math.max(1000, timeoutMs - (Date.now() - started));
      progress = await cdp.waitForEvent("Browser.downloadProgress", remainingMs, (event) => event.guid === begin.guid);
      if (progress.state === "completed" || progress.state === "canceled") break;
    }
    const filePath = begin.suggestedFilename ? path.join(downloadPath, begin.suggestedFilename) : null;
    return toolResult({
      ok: progress.state === "completed",
      downloadPath,
      guid: begin.guid,
      url: begin.url,
      suggestedFilename: begin.suggestedFilename,
      filePath,
      state: progress.state,
      totalBytes: progress.totalBytes,
      receivedBytes: progress.receivedBytes,
    });
  });
}

async function toolBrowserGrantPermissions(args = {}) {
  const permissions = Array.isArray(args.permissions) ? args.permissions.map(String) : [];
  if (!permissions.length) throw new Error("browser_grant_permissions requires permissions array");
  const tab = await resolveTab(args);
  return withBrowser(args, async (cdp) => {
    const origin = args.origin ? String(args.origin) : new URL(tab.url || "http://127.0.0.1").origin;
    await cdp.send("Browser.grantPermissions", { origin, permissions }, Number(args.timeoutMs || 15000));
    return toolResult({ ok: true, tabId: tab.id, origin, permissions });
  });
}

async function toolBrowserResetPermissions(args = {}) {
  const tab = await resolveTab(args);
  return withBrowser(args, async (cdp) => {
    const origin = args.origin ? String(args.origin) : new URL(tab.url || "http://127.0.0.1").origin;
    await cdp.send("Browser.resetPermissions", { origin }, Number(args.timeoutMs || 15000)).catch(async () => {
      await cdp.send("Browser.resetPermissions", {}, Number(args.timeoutMs || 15000));
    });
    return toolResult({ ok: true, tabId: tab.id, origin });
  });
}

async function loadPlaywright() {
  if (playwrightModule) return playwrightModule;
  try {
    playwrightModule = await import("playwright");
    return playwrightModule;
  } catch (playwrightError) {
    try {
      playwrightModule = await import("playwright-core");
      return playwrightModule;
    } catch (coreError) {
      const error = new Error("Playwright is not installed. Install optional dependency 'playwright' or 'playwright-core' in browser-control-mcp to use browser_playwright_* tools.");
      error.cause = { playwright: playwrightError.message, playwrightCore: coreError.message };
      throw error;
    }
  }
}

function playwrightSessionSummary(session) {
  if (!session) return null;
  return {
    id: session.id,
    browserName: session.browserName,
    headless: session.headless,
    startedAt: session.startedAt,
    pageCount: session.pages.size,
    defaultPageId: session.defaultPageId,
    userDataDir: session.userDataDir || null,
  };
}

function resolvePlaywrightSession(args = {}) {
  const id = String(args.sessionId || args.playwrightSessionId || playwrightSessions.keys().next().value || "");
  if (!id || !playwrightSessions.has(id)) throw new Error("No Playwright session found. Use browser_playwright_start first.");
  return playwrightSessions.get(id);
}

function resolvePlaywrightPage(session, args = {}) {
  if (args.pageId && session.pages.has(String(args.pageId))) return session.pages.get(String(args.pageId));
  if (session.defaultPageId && session.pages.has(session.defaultPageId)) return session.pages.get(session.defaultPageId);
  const first = session.context.pages()[0];
  if (!first) throw new Error("Playwright session has no pages.");
  const pageId = [...session.pages.entries()].find(([, page]) => page === first)?.[0] || randomUUID();
  session.pages.set(pageId, first);
  session.defaultPageId = pageId;
  return first;
}

function playwrightPageId(session, page) {
  const existing = [...session.pages.entries()].find(([, value]) => value === page);
  if (existing) return existing[0];
  const id = randomUUID();
  session.pages.set(id, page);
  return id;
}

function playwrightLocator(page, args = {}) {
  if (args.selector) return page.locator(String(args.selector)).nth(Number(args.nth || 0));
  if (args.role) {
    const options = {};
    if (args.name) options.name = args.name;
    if (args.exact != null) options.exact = Boolean(args.exact);
    return page.getByRole(String(args.role), options).nth(Number(args.nth || 0));
  }
  if (args.label) return page.getByLabel(String(args.label), { exact: Boolean(args.exact) }).nth(Number(args.nth || 0));
  if (args.placeholder) return page.getByPlaceholder(String(args.placeholder), { exact: Boolean(args.exact) }).nth(Number(args.nth || 0));
  if (args.alt) return page.getByAltText(String(args.alt), { exact: Boolean(args.exact) }).nth(Number(args.nth || 0));
  if (args.title) return page.getByTitle(String(args.title), { exact: Boolean(args.exact) }).nth(Number(args.nth || 0));
  if (args.testId) return page.getByTestId(String(args.testId)).nth(Number(args.nth || 0));
  if (args.text) return page.getByText(String(args.text), { exact: Boolean(args.exact) }).nth(Number(args.nth || 0));
  throw new Error("Playwright locator requires selector, role, text, label, placeholder, alt, title, or testId.");
}

function playwrightPageSummary(session, page) {
  return {
    pageId: playwrightPageId(session, page),
    url: page.url(),
    closed: page.isClosed(),
  };
}

async function toolBrowserPlaywrightStatus(args = {}) {
  let available = false;
  let version = null;
  let error = null;
  try {
    const mod = await loadPlaywright();
    available = true;
    version = mod?.version || null;
  } catch (caught) {
    error = caught.message;
  }
  return toolResult({
    ok: true,
    available,
    version,
    error,
    sessions: [...playwrightSessions.values()].map(playwrightSessionSummary),
  });
}

async function toolBrowserPlaywrightStart(args = {}) {
  const mod = await loadPlaywright();
  const browserName = String(args.browser || "chromium");
  const engine = mod[browserName];
  if (!engine?.launch && !engine?.launchPersistentContext) throw new Error(`Unsupported Playwright browser: ${browserName}`);
  const headless = args.headless !== false;
  const launchOptions = { headless };
  if (args.executablePath) launchOptions.executablePath = validateBrowserExecutable(args.executablePath);
  if (Array.isArray(args.args)) launchOptions.args = args.args.map(String);
  const id = randomUUID();
  let browser = null;
  let context;
  if (args.userDataDir) {
    const userDataDir = path.resolve(String(args.userDataDir));
    mkdirSync(userDataDir, { recursive: true });
    context = await engine.launchPersistentContext(userDataDir, launchOptions);
  } else {
    browser = await engine.launch(launchOptions);
    context = await browser.newContext(args.contextOptions || {});
  }
  const page = context.pages()[0] || await context.newPage();
  if (args.url) await page.goto(String(args.url), { waitUntil: args.waitUntil || "load", timeout: Number(args.timeoutMs || 30000) });
  const pageId = randomUUID();
  const session = {
    id,
    browserName,
    browser,
    context,
    pages: new Map([[pageId, page]]),
    defaultPageId: pageId,
    headless,
    userDataDir: args.userDataDir ? path.resolve(String(args.userDataDir)) : null,
    startedAt: new Date().toISOString(),
  };
  context.on("page", (newPage) => {
    const newPageId = playwrightPageId(session, newPage);
    session.defaultPageId ||= newPageId;
  });
  playwrightSessions.set(id, session);
  return toolResult({ ok: true, session: playwrightSessionSummary(session), page: await playwrightPageDetails(session, page) });
}

async function playwrightPageDetails(session, page) {
  return {
    ...playwrightPageSummary(session, page),
    title: await page.title().catch(() => ""),
  };
}

async function toolBrowserPlaywrightOpen(args = {}) {
  const session = resolvePlaywrightSession(args);
  let page = args.newPage ? await session.context.newPage() : resolvePlaywrightPage(session, args);
  if (!args.url) throw new Error("browser_playwright_open requires url");
  await page.goto(String(args.url), { waitUntil: args.waitUntil || "load", timeout: Number(args.timeoutMs || 30000) });
  const pageId = playwrightPageId(session, page);
  session.defaultPageId = pageId;
  return toolResult({ ok: true, sessionId: session.id, page: await playwrightPageDetails(session, page) });
}

async function toolBrowserPlaywrightClick(args = {}) {
  const session = resolvePlaywrightSession(args);
  const page = resolvePlaywrightPage(session, args);
  const locator = playwrightLocator(page, args);
  await locator.click({
    button: args.button || "left",
    clickCount: Number(args.clickCount || 1),
    timeout: Number(args.timeoutMs || 30000),
  });
  if (args.settleMs) await sleep(Number(args.settleMs));
  return toolResult({ ok: true, sessionId: session.id, page: await playwrightPageDetails(session, page) });
}

async function toolBrowserPlaywrightType(args = {}) {
  if (typeof args.value !== "string") throw new Error("browser_playwright_type requires string value");
  const session = resolvePlaywrightSession(args);
  const page = resolvePlaywrightPage(session, args);
  const locator = playwrightLocator(page, args);
  if (args.clear) await locator.fill("", { timeout: Number(args.timeoutMs || 30000) });
  await locator.fill(String(args.value), { timeout: Number(args.timeoutMs || 30000) });
  if (args.pressEnter) await locator.press("Enter", { timeout: Number(args.timeoutMs || 30000) });
  if (args.settleMs) await sleep(Number(args.settleMs));
  return toolResult({ ok: true, sessionId: session.id, page: await playwrightPageDetails(session, page), insertedLength: args.value.length, pressedEnter: Boolean(args.pressEnter) });
}

async function toolBrowserPlaywrightScreenshot(args = {}) {
  const session = resolvePlaywrightSession(args);
  const page = resolvePlaywrightPage(session, args);
  const outPath = resolveOutputPath(args.path, path.join(DEFAULT_SCREENSHOT_DIR, `playwright-screenshot-${Date.now()}.png`), "screenshot path");
  mkdirSync(path.dirname(outPath), { recursive: true });
  const buffer = await page.screenshot({
    path: outPath,
    fullPage: Boolean(args.fullPage),
    type: args.format === "jpeg" ? "jpeg" : "png",
    quality: args.format === "jpeg" && args.quality ? Math.max(1, Math.min(100, Number(args.quality))) : undefined,
    timeout: Number(args.timeoutMs || 30000),
  });
  const extra = args.includeData ? [{ type: "image", data: buffer.toString("base64"), mimeType: `image/${args.format === "jpeg" ? "jpeg" : "png"}` }] : [];
  return toolResult({ ok: true, sessionId: session.id, page: await playwrightPageDetails(session, page), path: outPath }, extra);
}

async function toolBrowserPlaywrightStop(args = {}) {
  const session = resolvePlaywrightSession(args);
  await session.context.close().catch(() => {});
  if (session.browser) await session.browser.close().catch(() => {});
  playwrightSessions.delete(session.id);
  return toolResult({ ok: true, stopped: playwrightSessionSummary(session) });
}

function hasLocatorArgs(args = {}) {
  return Boolean(args.selector || args.text || args.role || args.name || args.label || args.placeholder || args.alt || args.title || args.testId || args.testID);
}

function elementLookupExpression(args = {}) {
  const payload = {
    selector: args.selector || null,
    text: args.text || null,
    exact: Boolean(args.exact),
    allElements: Boolean(args.allElements),
  };
  return `(() => {
    const params = ${JSON.stringify(payload)};
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const isVisible = (element) => {
      if (!element || !(element instanceof Element)) return false;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const label = (element) => clean([
      element.innerText,
      element.value,
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("placeholder"),
      element.alt,
      element.name,
    ].filter(Boolean).join(" "));
    let element = null;
    if (params.selector) {
      element = document.querySelector(params.selector);
    }
    if (!element && params.text) {
      const needle = clean(params.text).toLowerCase();
      const preferred = "button,a,input,textarea,select,[role=button],[contenteditable=true],label,summary,[onclick]";
      const pool = [
        ...document.querySelectorAll(preferred),
        ...(params.allElements ? document.querySelectorAll("body *") : []),
      ];
      element = Array.from(new Set(pool)).find((candidate) => {
        if (!isVisible(candidate)) return false;
        const hay = label(candidate).toLowerCase();
        return params.exact ? hay === needle : hay.includes(needle);
      });
    }
    if (!element) return { ok: false, error: "Element not found" };
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    element.focus?.({ preventScroll: true });
    const rect = element.getBoundingClientRect();
    return {
      ok: true,
      tag: element.tagName,
      text: label(element).slice(0, 300),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
    };
  })()`;
}

function locatorExpression(args = {}) {
  const payload = {
    selector: args.selector || null,
    text: args.text || null,
    role: args.role || null,
    name: args.name || null,
    label: args.label || null,
    placeholder: args.placeholder || null,
    alt: args.alt || null,
    title: args.title || null,
    testId: args.testId || args.testID || null,
    exact: Boolean(args.exact),
    nth: args.nth == null ? 0 : Number(args.nth),
    includeHidden: Boolean(args.includeHidden),
    allElements: args.allElements !== false,
    action: args.action || "inspect",
    requireEditable: Boolean(args.requireEditable),
  };
  return `(async () => {
    const params = ${JSON.stringify(payload)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const lower = (value) => clean(value).toLowerCase();
    const matches = (value, needle) => {
      if (!needle) return true;
      const hay = lower(value);
      const target = lower(needle);
      return params.exact ? hay === target : hay.includes(target);
    };
    const cssPath = (element) => {
      if (!element || !(element instanceof Element)) return "";
      if (element.id) return "#" + CSS.escape(element.id);
      const parts = [];
      let node = element;
      while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body) {
        let part = node.tagName.toLowerCase();
        if (node.classList?.length) part += "." + [...node.classList].slice(0, 3).map((c) => CSS.escape(c)).join(".");
        const parent = node.parentElement;
        if (parent) {
          const siblings = [...parent.children].filter((sibling) => sibling.tagName === node.tagName);
          if (siblings.length > 1) part += \`:nth-of-type(\${siblings.indexOf(node) + 1})\`;
        }
        parts.unshift(part);
        node = parent;
      }
      return parts.join(" > ");
    };
    const isVisible = (element) => {
      if (!element || !(element instanceof Element)) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) === 0) return false;
      if (rect.width <= 0 || rect.height <= 0) return false;
      if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) return false;
      return true;
    };
    const accessibleRole = (element) => {
      const explicit = element.getAttribute("role");
      if (explicit) return explicit.toLowerCase();
      const tag = element.tagName;
      const type = lower(element.getAttribute("type"));
      if (tag === "A" && element.hasAttribute("href")) return "link";
      if (tag === "BUTTON") return "button";
      if (tag === "TEXTAREA") return "textbox";
      if (tag === "SELECT") return "combobox";
      if (tag === "INPUT") {
        if (["button", "submit", "reset", "image"].includes(type)) return "button";
        if (["checkbox"].includes(type)) return "checkbox";
        if (["radio"].includes(type)) return "radio";
        if (["range"].includes(type)) return "slider";
        return "textbox";
      }
      if (tag === "SUMMARY") return "button";
      return "";
    };
    const labelFor = (element) => {
      const labels = [];
      if (element.id) {
        for (const label of document.querySelectorAll(\`label[for="\${CSS.escape(element.id)}"]\`)) labels.push(label.innerText);
      }
      if (element.labels) for (const label of element.labels) labels.push(label.innerText);
      const wrapped = element.closest("label");
      if (wrapped) labels.push(wrapped.innerText);
      return clean(labels.filter(Boolean).join(" "));
    };
    const accessibleName = (element) => {
      const labelledBy = clean((element.getAttribute("aria-labelledby") || "").split(/\\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" "));
      return clean([
        element.getAttribute("aria-label"),
        labelledBy,
        labelFor(element),
        element.alt,
        element.getAttribute("title"),
        element.getAttribute("placeholder"),
        element.value && ["BUTTON", "INPUT"].includes(element.tagName) ? element.value : "",
        element.innerText,
        element.name,
      ].filter(Boolean).join(" "));
    };
    const isDisabled = (element) => {
      if (!element || !(element instanceof Element)) return true;
      if (element.disabled) return true;
      if (element.getAttribute("aria-disabled") === "true") return true;
      const style = getComputedStyle(element);
      return style.pointerEvents === "none";
    };
    const isEditable = (element) => {
      if (!element || !(element instanceof Element)) return false;
      if (element.isContentEditable) return true;
      if (element.tagName === "TEXTAREA") return !element.readOnly && !isDisabled(element);
      if (element.tagName === "INPUT") {
        const type = lower(element.type || "text");
        return !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(type)
          && !element.readOnly && !isDisabled(element);
      }
      return false;
    };
    const allCandidates = () => {
      const preferred = "button,a,input,textarea,select,label,summary,[role],[contenteditable=true],[onclick],[aria-label],[title],[placeholder],img";
      const pool = [
        ...(params.selector ? document.querySelectorAll(params.selector) : []),
        ...document.querySelectorAll(preferred),
        ...(params.allElements ? document.querySelectorAll("body *") : []),
      ];
      return [...new Set(pool)].filter((element) => element instanceof Element);
    };
    const scoreCandidate = (element) => {
      const role = accessibleRole(element);
      const name = accessibleName(element);
      const label = labelFor(element);
      let score = 0;
      if (params.selector && element.matches(params.selector)) score += 100;
      if (params.role && role === lower(params.role)) score += 80;
      else if (params.role) return -1;
      if (params.name && matches(name, params.name)) score += 70;
      else if (params.name) return -1;
      if (params.text && matches([name, element.innerText, element.value].join(" "), params.text)) score += 60;
      else if (params.text) return -1;
      if (params.label && matches(label, params.label)) score += 65;
      else if (params.label) return -1;
      if (params.placeholder && matches(element.getAttribute("placeholder"), params.placeholder)) score += 65;
      else if (params.placeholder) return -1;
      if (params.alt && matches(element.alt, params.alt)) score += 65;
      else if (params.alt) return -1;
      if (params.title && matches(element.getAttribute("title"), params.title)) score += 65;
      else if (params.title) return -1;
      if (params.testId) {
        const testValue = element.getAttribute("data-testid") || element.getAttribute("data-test-id") || element.getAttribute("data-test") || element.getAttribute("testid");
        if (matches(testValue, params.testId)) score += 90;
        else return -1;
      }
      if (!params.includeHidden && !isVisible(element)) return -1;
      if (isDisabled(element)) score -= 15;
      if (isEditable(element)) score += 8;
      if (["BUTTON", "A", "INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) || element.getAttribute("role")) score += 6;
      return score;
    };
    const describe = (element, score) => {
      const rect = element.getBoundingClientRect();
      return {
        score,
        tag: element.tagName,
        role: accessibleRole(element),
        name: accessibleName(element).slice(0, 300),
        text: clean(element.innerText || element.value || "").slice(0, 300),
        selector: cssPath(element),
        visible: isVisible(element),
        disabled: isDisabled(element),
        editable: isEditable(element),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      };
    };
    const scored = allCandidates()
      .map((element) => ({ element, score: scoreCandidate(element) }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score);
    const selected = scored[Math.max(0, params.nth || 0)];
    if (!selected) {
      return { ok: false, error: "No locator match", candidates: [] };
    }
    const element = selected.element;
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    await sleep(50);
    const before = element.getBoundingClientRect();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const after = element.getBoundingClientRect();
    const rect = after;
    const stable = Math.abs(before.x - after.x) < 0.5 && Math.abs(before.y - after.y) < 0.5
      && Math.abs(before.width - after.width) < 0.5 && Math.abs(before.height - after.height) < 0.5;
    const points = [
      { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, name: "center" },
      { x: rect.left + Math.max(1, rect.width * 0.25), y: rect.top + rect.height / 2, name: "left-center" },
      { x: rect.left + Math.max(1, rect.width * 0.75), y: rect.top + rect.height / 2, name: "right-center" },
      { x: rect.left + rect.width / 2, y: rect.top + Math.max(1, rect.height * 0.25), name: "top-center" },
      { x: rect.left + rect.width / 2, y: rect.top + Math.max(1, rect.height * 0.75), name: "bottom-center" },
    ].filter((point) => point.x >= 0 && point.y >= 0 && point.x <= innerWidth && point.y <= innerHeight);
    const hit = points.map((point) => {
      const top = document.elementFromPoint(point.x, point.y);
      return { ...point, ok: Boolean(top && (top === element || element.contains(top) || top.contains(element))), topTag: top?.tagName || "", topText: clean(top?.innerText || top?.getAttribute?.("aria-label") || "").slice(0, 120) };
    });
    const clickPoint = hit.find((point) => point.ok) || hit[0] || { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, name: "center", ok: false };
    const reasons = [];
    if (!isVisible(element)) reasons.push("not_visible");
    if (isDisabled(element)) reasons.push("disabled_or_pointer_events_none");
    if (!stable) reasons.push("not_stable");
    if (params.requireEditable && !isEditable(element)) reasons.push("not_editable");
    if (params.action !== "inspect" && !clickPoint.ok) reasons.push("obscured_or_outside_viewport");
    return {
      ok: reasons.length === 0,
      error: reasons.length ? reasons.join(",") : null,
      selected: describe(element, selected.score),
      actionability: {
        visible: isVisible(element),
        enabled: !isDisabled(element),
        stable,
        editable: isEditable(element),
        receivesEvents: Boolean(clickPoint.ok),
        reasons,
        clickPoint: { x: clickPoint.x, y: clickPoint.y, name: clickPoint.name },
        hit,
      },
      candidates: scored.slice(0, 10).map((item) => describe(item.element, item.score)),
    };
  })()`;
}

async function waitForLocator(cdp, args = {}) {
  const timeoutMs = Number(args.timeoutMs || 10000);
  const intervalMs = Number(args.intervalMs || 250);
  const started = Date.now();
  let last = null;
  while (Date.now() - started <= timeoutMs) {
    last = await evaluateValue(cdp, locatorExpression(args), Math.min(Math.max(intervalMs + 1000, 2000), timeoutMs + 1000)).catch((error) => ({ ok: false, error: error.message }));
    if (last.ok || args.waitForActionable === false) {
      return { result: last, waitedMs: Date.now() - started };
    }
    await sleep(intervalMs);
  }
  const error = last?.error || "Timed out waiting for locator";
  const details = last?.actionability?.reasons?.length ? ` (${last.actionability.reasons.join(", ")})` : "";
  throw new Error(`${error}${details}`);
}

async function dispatchMouseClick(cdp, center, args = {}) {
  const button = String(args.button || "left");
  const clickCount = Number(args.clickCount || 1);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: center.x, y: center.y, button: "none" });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: center.x, y: center.y, button, clickCount });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: center.x, y: center.y, button, clickCount });
}

async function toolBrowserLocatorFind(args = {}) {
  if (!args.selector && !args.text && !args.role && !args.name && !args.label && !args.placeholder && !args.alt && !args.title && !args.testId && !args.testID) {
    throw new Error("browser_locator_find requires selector, text, role/name, label, placeholder, alt, title, or testId");
  }
  return withTab(args, async (cdp, tab) => {
    const result = await evaluateValue(cdp, locatorExpression({ ...args, action: "inspect", waitForActionable: false }), Number(args.timeoutMs || 15000));
    return toolResult({ ok: result.ok, tabId: tab.id, locator: result });
  });
}

async function toolBrowserActionabilityCheck(args = {}) {
  if (!args.selector && !args.text && !args.role && !args.name && !args.label && !args.placeholder && !args.alt && !args.title && !args.testId && !args.testID) {
    throw new Error("browser_actionability_check requires selector, text, role/name, label, placeholder, alt, title, or testId");
  }
  return withTab(args, async (cdp, tab) => {
    const result = await evaluateValue(cdp, locatorExpression({ ...args, action: args.action || "click" }), Number(args.timeoutMs || 15000));
    return toolResult({ ok: result.ok, tabId: tab.id, locator: result });
  });
}

async function toolBrowserLocatorClick(args = {}) {
  if (!args.selector && !args.text && !args.role && !args.name && !args.label && !args.placeholder && !args.alt && !args.title && !args.testId && !args.testID) {
    throw new Error("browser_locator_click requires selector, text, role/name, label, placeholder, alt, title, or testId");
  }
  const { actionResult, newTab } = await maybeWaitForNewTabAfterAction(args, () => withTab(args, async (cdp, tab) => {
    const { result, waitedMs } = await waitForLocator(cdp, { ...args, action: "click" });
    if (!result.ok) throw new Error(result.error || "Locator is not actionable");
    await dispatchMouseClick(cdp, result.actionability.clickPoint, args);
    if (args.settleMs) await sleep(Number(args.settleMs));
    return { tabId: tab.id, clicked: result.selected, actionability: result.actionability, waitedMs };
  }));
  return toolResult({ ok: true, ...actionResult, ...(newTab ? { newTab } : {}) });
}

async function toolBrowserLocatorType(args = {}) {
  if (!args.selector && !args.text && !args.role && !args.name && !args.label && !args.placeholder && !args.alt && !args.title && !args.testId && !args.testID) {
    throw new Error("browser_locator_type requires selector, text, role/name, label, placeholder, alt, title, or testId");
  }
  if (typeof args.value !== "string") throw new Error("browser_locator_type requires string value");
  return withTab(args, async (cdp, tab) => {
    const { result, waitedMs } = await waitForLocator(cdp, { ...args, action: "type", requireEditable: true });
    if (!result.ok) throw new Error(result.error || "Locator is not editable");
    await dispatchMouseClick(cdp, result.actionability.clickPoint, args);
    if (args.clear) {
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 0 });
      await dispatchKey(cdp, "Backspace", "Backspace", 8);
    }
    if (args.value) await cdp.send("Input.insertText", { text: args.value });
    if (args.pressEnter) await dispatchKey(cdp, "Enter", "Enter", 13);
    if (args.settleMs) await sleep(Number(args.settleMs));
    return toolResult({ ok: true, tabId: tab.id, typedInto: result.selected, insertedLength: args.value.length, pressedEnter: Boolean(args.pressEnter), actionability: result.actionability, waitedMs });
  });
}

async function dispatchKey(cdp, key, code, windowsVirtualKeyCode, modifiers = 0) {
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers });
}

async function toolBrowserClick(args = {}) {
  if (!args.selector && !args.text) throw new Error("browser_click requires selector or text");
  const { actionResult, newTab } = await maybeWaitForNewTabAfterAction(args, () => withTab(args, async (cdp, tab) => {
    const found = await evaluateValue(cdp, elementLookupExpression(args));
    if (!found.ok) throw new Error(found.error);
    await dispatchMouseClick(cdp, found.center, args);
    return { tabId: tab.id, clicked: found };
  }));
  return toolResult({ ok: true, ...actionResult, ...(newTab ? { newTab } : {}) });
}

async function toolBrowserType(args = {}) {
  if (!args.selector && !args.text) throw new Error("browser_type requires selector or text");
  if (typeof args.value !== "string") throw new Error("browser_type requires string value");
  return withTab(args, async (cdp, tab) => {
    const found = await evaluateValue(cdp, elementLookupExpression(args));
    if (!found.ok) throw new Error(found.error);
    await dispatchMouseClick(cdp, found.center, args);
    if (args.clear) {
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 0 });
      await dispatchKey(cdp, "Backspace", "Backspace", 8);
    }
    if (args.value) await cdp.send("Input.insertText", { text: args.value });
    if (args.pressEnter) await dispatchKey(cdp, "Enter", "Enter", 13);
    return toolResult({ ok: true, tabId: tab.id, typedInto: found, insertedLength: args.value.length, pressedEnter: Boolean(args.pressEnter) });
  });
}

async function toolBrowserEval(args = {}) {
  if (typeof args.script !== "string") throw new Error("browser_eval requires script");
  return withTab(args, async (cdp, tab) => {
    const result = await cdp.send("Runtime.evaluate", {
      expression: args.script,
      awaitPromise: args.awaitPromise !== false,
      returnByValue: args.returnByValue !== false,
      userGesture: true,
    }, Number(args.timeoutMs || 15000));
    if (result.exceptionDetails) throw new Error(exceptionText(result.exceptionDetails));
    return toolResult({
      ok: true,
      tabId: tab.id,
      result: result.result,
    });
  });
}

async function toolBrowserCdp(args = {}) {
  if (typeof args.method !== "string") throw new Error("browser_cdp requires method");
  return withTab(args, async (cdp, tab) => {
    const result = await cdp.send(args.method, args.params || {}, Number(args.timeoutMs || 15000));
    return toolResult({ ok: true, tabId: tab.id, method: args.method, result });
  });
}

function pathGet(value, dottedPath = "") {
  if (!dottedPath) return value;
  let cursor = value;
  for (const part of String(dottedPath).split(".")) {
    if (cursor == null) return undefined;
    const key = /^\d+$/.test(part) ? Number(part) : part;
    cursor = cursor[key];
  }
  return cursor;
}

function resolveBatchRefs(value, results) {
  if (typeof value === "string") {
    const exact = value.match(/^\$(\d+)(?:\.(.+))?$/);
    if (exact) return pathGet(results[Number(exact[1])], exact[2] || "");
    return value.replace(/\$(\d+)\.([A-Za-z0-9_$.[\]-]+)/g, (_, index, refPath) => {
      const resolved = pathGet(results[Number(index)], refPath.replace(/\[(\d+)\]/g, ".$1"));
      return resolved == null ? "" : String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((item) => resolveBatchRefs(item, results));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveBatchRefs(item, results)]));
  }
  return value;
}

async function runCdpBatch(cdp, commands, args = {}) {
  if (!Array.isArray(commands)) throw new Error("CDP batch requires commands array");
  const results = [];
  for (const [index, command] of commands.entries()) {
    try {
      if (!command || typeof command.method !== "string") throw new Error(`Command ${index} is missing method`);
      const params = resolveBatchRefs(command.params || {}, results);
      const result = await cdp.send(command.method, params, Number(command.timeoutMs || args.timeoutMs || 15000));
      results.push({ ok: true, method: command.method, result });
    } catch (error) {
      results.push({ ok: false, method: command?.method || "", error: error.message });
      if (args.stopOnError !== false) break;
    }
  }
  return results;
}

async function toolBrowserCdpBatch(args = {}) {
  return withTab(args, async (cdp, tab) => {
    const results = await runCdpBatch(cdp, args.commands, args);
    return toolResult({ ok: results.every((item) => item.ok), tabId: tab.id, results });
  });
}

async function getCookiesForTab(cdp, tab, args = {}) {
  await cdp.send("Network.enable").catch(() => {});
  const urls = Array.isArray(args.urls) && args.urls.length
    ? args.urls.map(String)
    : [String(args.url || tab.url || "")].filter(Boolean);
  const result = await cdp.send("Network.getCookies", urls.length ? { urls } : {});
  return { urls, cookies: result.cookies || [] };
}

async function toolBrowserCookies(args = {}) {
  return withTab(args, async (cdp, tab) => {
    const result = await getCookiesForTab(cdp, tab, args);
    return toolResult({ ok: true, tabId: tab.id, ...result });
  });
}

async function findDomNode(cdp, selector, args = {}) {
  await cdp.send("DOM.enable");
  if (args.nodeId) return Number(args.nodeId);
  if (!selector) throw new Error("selector or nodeId is required");
  const doc = await cdp.send("DOM.getDocument", { depth: -1, pierce: args.pierce !== false });
  const direct = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector }).catch(() => ({}));
  if (direct.nodeId) return direct.nodeId;
  const search = await cdp.send("DOM.performSearch", {
    query: selector,
    includeUserAgentShadowDOM: args.includeUserAgentShadowDOM !== false,
  });
  try {
    if (!search.resultCount) throw new Error(`No DOM node found for selector: ${selector}`);
    const found = await cdp.send("DOM.getSearchResults", { searchId: search.searchId, fromIndex: 0, toIndex: 1 });
    if (!found.nodeIds?.[0]) throw new Error(`No DOM node found for selector: ${selector}`);
    return found.nodeIds[0];
  } finally {
    if (search.searchId) await cdp.send("DOM.discardSearchResults", { searchId: search.searchId }).catch(() => {});
  }
}

async function toolBrowserSetFileInputFiles(args = {}) {
  if (!Array.isArray(args.files) || !args.files.length) throw new Error("browser_set_file_input_files requires files");
  const files = args.files.map((file) => path.resolve(String(file)));
  for (const file of files) {
    if (!existsSync(file)) throw new Error(`File does not exist: ${file}`);
  }
  return withTab(args, async (cdp, tab) => {
    const nodeId = await findDomNode(cdp, args.selector, args);
    await cdp.send("DOM.setFileInputFiles", { nodeId, files }, Number(args.timeoutMs || 15000));
    if (args.dispatchEvents !== false && args.selector) {
      await evaluateValue(cdp, `(() => {
        const el = document.querySelector(${JSON.stringify(args.selector)});
        if (!el) return false;
        for (const type of ["input", "change"]) el.dispatchEvent(new Event(type, { bubbles: true }));
        return true;
      })()`).catch(() => false);
    }
    return toolResult({ ok: true, tabId: tab.id, selector: args.selector || null, nodeId, files });
  });
}

function flattenFrameTree(frameTree, result = []) {
  if (!frameTree) return result;
  if (frameTree.frame) result.push(frameTree.frame);
  for (const child of frameTree.childFrames || []) flattenFrameTree(child, result);
  return result;
}

async function toolBrowserIframeEval(args = {}) {
  if (typeof args.script !== "string") throw new Error("browser_iframe_eval requires script");
  return withTab(args, async (cdp, tab) => {
    const tree = await cdp.send("Page.getFrameTree");
    const frames = flattenFrameTree(tree.frameTree);
    const frame = frames.find((item, index) => {
      if (args.frameId && item.id !== args.frameId) return false;
      if (args.frameUrlContains && !String(item.url || "").includes(String(args.frameUrlContains))) return false;
      if (args.frameName && item.name !== args.frameName) return false;
      if (args.frameIndex != null && index !== Number(args.frameIndex)) return false;
      return args.frameId || args.frameUrlContains || args.frameName || args.frameIndex != null ? true : index > 0;
    });
    if (!frame) throw new Error("No matching iframe found");
    const world = await cdp.send("Page.createIsolatedWorld", {
      frameId: frame.id,
      worldName: "codex-browser-control",
      grantUniveralAccess: true,
    });
    const result = await cdp.send("Runtime.evaluate", {
      expression: `(async () => { ${args.script}\n})()`,
      awaitPromise: true,
      returnByValue: args.returnByValue !== false,
      contextId: world.executionContextId,
      userGesture: true,
    }, Number(args.timeoutMs || 15000));
    if (result.exceptionDetails) throw new Error(exceptionText(result.exceptionDetails));
    return toolResult({ ok: true, tabId: tab.id, frame, result: result.result });
  });
}

async function toolBrowserDomPierce(args = {}) {
  if (!args.selector) throw new Error("browser_dom_pierce requires selector");
  return withTab(args, async (cdp, tab) => {
    await cdp.send("DOM.enable");
    await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const search = await cdp.send("DOM.performSearch", {
      query: String(args.selector),
      includeUserAgentShadowDOM: args.includeUserAgentShadowDOM !== false,
    });
    const limit = Math.max(1, Math.min(Number(args.limit || 20), 200));
    try {
      const found = search.resultCount
        ? await cdp.send("DOM.getSearchResults", { searchId: search.searchId, fromIndex: 0, toIndex: Math.min(search.resultCount, limit) })
        : { nodeIds: [] };
      const nodes = [];
      for (const nodeId of found.nodeIds || []) {
        const described = await cdp.send("DOM.describeNode", { nodeId }).catch(() => ({}));
        const box = await cdp.send("DOM.getBoxModel", { nodeId }).catch(() => null);
        nodes.push({ nodeId, node: described.node || null, boxModel: box?.model || null });
      }
      return toolResult({ ok: true, tabId: tab.id, selector: args.selector, resultCount: search.resultCount || 0, nodes });
    } finally {
      if (search.searchId) await cdp.send("DOM.discardSearchResults", { searchId: search.searchId }).catch(() => {});
    }
  });
}

function genericScanExpression(args = {}) {
  const textOnly = Boolean(args.textOnly);
  return `(() => {
    const textOnly = ${JSON.stringify(textOnly)};
    const ignoreTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "META", "LINK", "COLGROUP", "COL", "TEMPLATE", "PARAM", "SOURCE"]);
    const ignoreIds = new Set(["ljq-ind"]);
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (node, keep = false) => {
      if (!(node instanceof Element)) return true;
      if (keep) return true;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0
        && rect.width > 0 && rect.height > 0 && Math.abs(rect.left) < 5000 && Math.abs(rect.top) < 5000;
    };
    const safeAttr = (clone, source) => {
      for (const attr of [...source.attributes || []]) {
        const name = attr.name.toLowerCase();
        if (name === "style" || name.startsWith("on") || name === "srcset") clone.removeAttribute(attr.name);
        if ((name === "src" || name === "href" || name === "action") && attr.value.length > 80) {
          clone.setAttribute(attr.name, name === "href" ? "__link__" : "__url__");
        }
        if ((name === "class" || name === "id") && attr.value.length > 120) clone.setAttribute(attr.name, attr.value.slice(0, 120));
      }
    };
    const cloneNode = (source, keep = false) => {
      if (source.nodeType === Node.COMMENT_NODE) return null;
      if (source.nodeType === Node.TEXT_NODE) return document.createTextNode(source.textContent);
      if (!(source instanceof Element)) return null;
      if (ignoreTags.has(source.tagName) || ignoreIds.has(source.id)) return null;
      const isDropdown = source.matches?.('[role="menu"],.dropdown-menu,[class*="dropdown"],[class*="menu"]')
        && source.textContent.length < 500 && source.querySelectorAll('a,button,[role="menuitem"],li').length <= 7;
      const childKeep = keep || isDropdown;
      const clone = source.cloneNode(false);
      safeAttr(clone, source);
      if ((source.tagName === "INPUT" || source.tagName === "TEXTAREA") && source.value) clone.setAttribute("value", source.value);
      if (source.tagName === "INPUT" && ["radio", "checkbox"].includes(source.type) && source.checked) clone.setAttribute("checked", "");
      if (source.tagName === "SELECT" && source.value) clone.setAttribute("data-selected", source.value);
      try {
        if (source.matches(":-webkit-autofill")) {
          clone.setAttribute("data-autofilled", "true");
          if (!source.value) clone.setAttribute("value", "protected-autofill-value");
        }
      } catch {}
      const children = [];
      for (const child of source.childNodes) {
        const copied = cloneNode(child, childKeep);
        if (copied) children.push(copied);
      }
      if (source.tagName === "IFRAME") {
        try {
          const body = source.contentDocument?.body || source.contentWindow?.document?.body;
          if (body) {
            const wrapper = document.createElement("div");
            wrapper.setAttribute("data-iframe-content", source.src || "");
            for (const child of body.childNodes) {
              const copied = cloneNode(child, childKeep);
              if (copied) wrapper.appendChild(copied);
            }
            if (wrapper.childNodes.length) children.push(wrapper);
          }
        } catch {}
      }
      if (source.shadowRoot) {
        for (const child of source.shadowRoot.childNodes) {
          const copied = cloneNode(child, childKeep);
          if (copied) children.push(copied);
        }
      }
      const hasChildren = children.some((child) => child.nodeType !== Node.TEXT_NODE || clean(child.textContent));
      if (!visible(source, childKeep) && !hasChildren) return null;
      for (const child of children) clone.appendChild(child);
      if (clone.tagName === "DIV" && !clone.children.length && !clean(clone.textContent)) return null;
      return clone;
    };
    const root = cloneNode(document.body);
    if (!root) return "";
    if (textOnly) {
      root.querySelectorAll("input:not([type=hidden]),textarea,select").forEach((el) => {
        const label = [el.tagName, el.id && "#" + el.id, el.getAttribute("name") && "name=" + el.getAttribute("name"),
          el.tagName === "INPUT" && "type=" + (el.getAttribute("type") || "text"),
          el.getAttribute("placeholder") && '"' + el.getAttribute("placeholder") + '"',
          el.getAttribute("data-autofilled") && "autofilled",
          el.disabled && "disabled", el.getAttribute("data-selected") && '="' + el.getAttribute("data-selected") + '"'
        ].filter(Boolean).join(" ");
        el.insertAdjacentText("beforebegin", "\\n[" + label + "]\\n");
      });
      return clean(root.textContent).replace(/\\n\\s*\\n\\s*\\n/g, "\\n\\n");
    }
    root.querySelectorAll("svg").forEach((svg) => { svg.textContent = ""; [...svg.attributes].forEach((attr) => svg.removeAttribute(attr.name)); });
    return root.outerHTML;
  })()`;
}

function truncateText(value, maxChars = 35000) {
  const text = String(value || "");
  const limit = Number(maxChars || 35000);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 40))}\n[TRUNCATED ${text.length - limit} chars]`;
}

async function genericSimphtmlScan(cdp, args = {}) {
  const assets = await getGenericSimphtmlAssets();
  const timeoutMs = Number(args.timeoutMs || 30000);
  const textOnly = Boolean(args.textOnly);
  let lists = [];
  if (args.cutlist !== false && !textOnly) {
    lists = await evaluateValue(cdp, `(async () => {
      ${assets.js_findMainList}
      return findMainList(document.body);
    })()`, timeoutMs).catch(() => []);
  }
  const rawContent = await evaluateValue(cdp, `(async () => {
    ${args.extraJs || ""}
    ${assets.js_optHTML}
    return optHTML(${textOnly ? "true" : "false"});
  })()`, timeoutMs);
  const processed = await genericPostprocessHtml({
    content: rawContent,
    lists,
    cutlist: args.cutlist !== false,
    textOnly,
    maxChars: args.maxChars || 35000,
    instruction: args.instruction || "",
    timeoutMs,
  });
  return { content: processed.content, lists };
}

async function extensionCdpEvaluateValue(session, expression, args = {}) {
  const response = await extensionExecuteForTool(session, {
    cmd: "cdp",
    tabId: Number(session.id),
    method: "Runtime.evaluate",
    params: {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    },
  }, args);
  const result = response.data;
  if (result?.exceptionDetails) throw new Error(exceptionText(result.exceptionDetails));
  if (Object.prototype.hasOwnProperty.call(result?.result || {}, "value")) return result.result.value;
  if (Object.prototype.hasOwnProperty.call(result?.result || {}, "unserializableValue")) return result.result.unserializableValue;
  return result?.result?.description ?? null;
}

async function genericSimphtmlExtensionScan(session, args = {}) {
  const assets = await getGenericSimphtmlAssets();
  const timeoutMs = Number(args.timeoutMs || 30000);
  const textOnly = Boolean(args.textOnly);
  let lists = [];
  if (args.cutlist !== false && !textOnly) {
    lists = await extensionCdpEvaluateValue(session, `(async () => {
      ${assets.js_findMainList}
      return findMainList(document.body);
    })()`, { ...args, timeoutMs }).catch(() => []);
  }
  const rawContent = await extensionCdpEvaluateValue(session, `(async () => {
    ${args.extraJs || ""}
    ${assets.js_optHTML}
    return optHTML(${textOnly ? "true" : "false"});
  })()`, { ...args, timeoutMs });
  const processed = await genericPostprocessHtml({
    content: rawContent,
    lists,
    cutlist: args.cutlist !== false,
    textOnly,
    maxChars: args.maxChars || 35000,
    instruction: args.instruction || "",
    timeoutMs,
  });
  return { content: processed.content, lists };
}

async function toolBrowserScan(args = {}) {
  const targets = pageTargets(await getTargets(args));
  const tabs = targets.map((target) => ({
    id: target.id,
    title: target.title,
    url: target.url && target.url.length > 80 ? `${target.url.slice(0, 80)}...` : target.url,
  }));
  if (args.tabsOnly) {
    return toolResult({ status: "success", metadata: { tabs_count: tabs.length, tabs, active_tab: args.tabId || targets[0]?.id || null } });
  }
  return withTab(args, async (cdp, tab) => {
    let content;
    let engine = "generic_simphtml";
    let warning = null;
    if (args.engine === "simple") {
      content = await evaluateValue(cdp, genericScanExpression(args), Number(args.timeoutMs || 15000));
      content = truncateText(content, args.maxChars || 35000);
      engine = "simple";
    } else {
      try {
        ({ content } = await genericSimphtmlScan(cdp, args));
      } catch (error) {
        warning = `generic_simphtml failed, used simple scan fallback: ${error.message}`;
        content = await evaluateValue(cdp, genericScanExpression(args), Number(args.timeoutMs || 15000));
        content = truncateText(content, args.maxChars || 35000);
        engine = "simple-fallback";
      }
    }
    return toolResult({
      status: "success",
      metadata: { tabs_count: tabs.length, tabs, active_tab: tab.id, engine, warning },
      content,
    });
  });
}

const startMonitorExpression = `(() => {
  if (window._codexTm && window._codexTm.id) clearInterval(window._codexTm.id);
  const extract = () => {
    const texts = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = String(node.textContent || "").trim();
      const sample = text.slice(0, 40);
      if (text.length > 10 && sample && !sample.includes("_")) texts.add(sample);
    }
    return texts;
  };
  window._codexTm = { extract, init: extract(), all: new Set() };
  window._codexTm.id = setInterval(() => extract().forEach((text) => window._codexTm.all.add(text)), 450);
  return true;
})()`;

const stopMonitorExpression = `(() => {
  if (!window._codexTm) return [];
  clearInterval(window._codexTm.id);
  const final = window._codexTm.extract();
  const newlySeen = [...window._codexTm.all].filter((text) => !window._codexTm.init.has(text));
  const result = newlySeen.length < 8 ? newlySeen : newlySeen.filter((text) => !final.has(text));
  delete window._codexTm;
  return [...new Set(result)].slice(0, 50);
})()`;

async function executeGenericCommand(cdp, tab, command, args = {}) {
  const cmd = command?.cmd;
  if (cmd === "tabs") {
    const targets = pageTargets(await getTargets(args));
    return targets.map((target) => ({ id: target.id, url: target.url, title: target.title }));
  }
  if (cmd === "cookies") {
    return await getCookiesForTab(cdp, tab, command);
  }
  if (cmd === "cdp") {
    if (!command.method) throw new Error("Generic cdp command requires method");
    return await cdp.send(command.method, command.params || {}, Number(command.timeoutMs || args.timeoutMs || 15000));
  }
  if (cmd === "batch") {
    return await runCdpBatch(cdp, command.commands, { ...args, ...command });
  }
  throw new Error(`Unknown GenericAgent command: ${cmd}`);
}

function parseGenericCommand(script) {
  if (typeof script !== "string") return null;
  const trimmed = script.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && parsed.cmd ? parsed : null;
  } catch {
    return null;
  }
}

async function toolBrowserGenericCommand(args = {}) {
  const command = args.command || parseGenericCommand(args.script || "");
  if (!command?.cmd) throw new Error("browser_generic_command requires command with cmd");
  return withTab(args, async (cdp, tab) => {
    const result = await executeGenericCommand(cdp, tab, command, args);
    return toolResult({ ok: true, tabId: tab.id, command: command.cmd, result });
  });
}

async function toolBrowserExecuteJsRich(args = {}) {
  if (typeof args.script !== "string") throw new Error("browser_execute_js_rich requires script");
  return withTab(args, async (cdp, tab) => {
    const beforeTargets = pageTargets(await getTargets(args));
    const beforeIds = new Set(beforeTargets.map((target) => target.id));
    let beforeHtml = null;
    let assets = null;
    if (!args.noMonitor) {
      assets = await getGenericSimphtmlAssets().catch(() => null);
      beforeHtml = await genericSimphtmlScan(cdp, { ...args, textOnly: false, maxChars: 9999999 }).then((r) => r.content).catch(() => null);
      await evaluateValue(cdp, assets?.temp_monitor_js || startMonitorExpression, 5000).catch(() => false);
    }

    let jsReturn = null;
    let error = null;
    try {
      const genericCommand = parseGenericCommand(args.script);
      if (genericCommand) {
        jsReturn = await executeGenericCommand(cdp, tab, genericCommand, args);
      } else {
        const result = await cdp.send("Runtime.evaluate", {
          expression: `(async () => { ${args.script}\n})()`,
          awaitPromise: true,
          returnByValue: args.returnByValue !== false,
          userGesture: true,
        }, Number(args.timeoutMs || 15000));
        if (result.exceptionDetails) throw new Error(exceptionText(result.exceptionDetails));
        jsReturn = Object.prototype.hasOwnProperty.call(result.result || {}, "value")
          ? result.result.value
          : result.result?.description ?? null;
      }
    } catch (caught) {
      error = caught.message;
    }

    await sleep(Number(args.settleMs || 1000));
    const afterTargets = pageTargets(await getTargets(args));
    const newTabs = afterTargets
      .filter((target) => !beforeIds.has(target.id))
      .map((target) => ({ id: target.id, url: target.url, title: target.title }));

    const response = {
      status: error ? "failed" : "success",
      js_return: jsReturn,
      tab_id: tab.id,
    };
    if (newTabs.length) response.newTabs = newTabs;
    if (error) response.error = error;
    if (!args.noMonitor) {
      response.transients = await evaluateValue(cdp, assets?.stop_monitor_js || stopMonitorExpression, 5000).catch(() => []);
      const afterHtml = await genericSimphtmlScan(cdp, { ...args, textOnly: false, maxChars: 9999999 }).then((r) => r.content).catch(() => null);
      if (beforeHtml && afterHtml) {
        if (beforeHtml === afterHtml && !response.transients.length && !newTabs.length) {
          response.diff = "DOM变化量: 0 (页面无变化)";
          response.suggestion = "页面无明显变化";
        } else {
          const delta = Math.abs(afterHtml.length - beforeHtml.length);
          response.diff = `DOM变化量: ${beforeHtml === afterHtml ? 0 : "changed"}, HTML长度变化: ${delta}`;
          if (beforeHtml !== afterHtml) response.top_change = truncateText(afterHtml, 2000);
        }
      } else {
        response.diff = "页面变化监控不可用";
      }
    }
    return toolResult(response);
  });
}

async function toolBrowserExtensionStatus(args = {}) {
  const { bridge, sessions, diagnostics } = await extensionBridgeView(args);
  return toolResult({
    ...bridge,
    sockets: extensionSockets.size,
    diagnostics: {
      mode: diagnostics.mode,
      status: diagnostics.status,
      sessionCount: diagnostics.sessionCount,
      recommendation: diagnostics.recommendation,
      error: diagnostics.error,
    },
    tabs: sessions.map((session) => ({
      id: session.id,
      title: session.title,
      url: session.url,
      type: session.type,
      updatedAt: new Date(session.updatedAt).toISOString(),
    })),
  });
}

async function toolBrowserExtensionListTabs(args = {}) {
  const { bridge, sessions, diagnostics } = await extensionBridgeView(args);
  return toolResult({
    bridge,
    diagnostics: {
      mode: diagnostics.mode,
      status: diagnostics.status,
      sessionCount: diagnostics.sessionCount,
      recommendation: diagnostics.recommendation,
      error: diagnostics.error,
    },
    tabs: sessions.map((session) => ({
      id: session.id,
      title: session.title,
      url: session.url,
      type: session.type,
      connectedAt: new Date(session.connectedAt).toISOString(),
      updatedAt: new Date(session.updatedAt).toISOString(),
    })),
  });
}

async function toolBrowserExtensionRepair(args = {}) {
  const timeoutMs = Number(args.timeoutMs || 20000);
  const before = await extensionBridgeDiagnostics({ ...args, timeoutMs: Math.min(timeoutMs, 5000) });
  const actions = [];
  let after = before;

  if (before.sessionCount) {
    return toolResult({ status: "ok", before, after, actions });
  }

  if (args.restartBridge !== false && before.mode === "proxy") {
    const restart = await restartExternalExtensionBridge({ ...args, timeoutMs });
    actions.push({ name: "restart_external_bridge", ...restart });
    after = await waitForExtensionSessions(args, Math.max(1000, timeoutMs - 1000));
  } else if (before.mode === "listening") {
    actions.push({
      name: "restart_external_bridge",
      skipped: true,
      reason: "Current MCP process owns the 18795 bridge; refusing to kill the process that is handling this tool call.",
    });
  } else {
    actions.push({
      name: "restart_external_bridge",
      skipped: true,
      reason: `Bridge mode ${before.mode} is not a safe automatic restart target.`,
    });
  }

  return toolResult({
    status: after.sessionCount ? "repaired" : "attention_required",
    before,
    after,
    actions,
    recommendation: after.recommendation || "Reload Codex Browser Control Bridge (18795) in Edge/Chrome, then run browser_extension_status again.",
  });
}

async function toolBrowserExtensionExecuteJs(args = {}) {
  if (typeof args.script !== "string") throw new Error("browser_extension_execute_js requires script");
  const session = await resolveExtensionSessionForTool(args);
  const command = parseGenericCommand(args.script);
  assertExtensionCommandAllowed(command || args.script);
  const response = await extensionExecuteForTool(session, command || args.script, args);
  return toolResult({
    status: "success",
    js_return: response.data,
    tab_id: session.id,
    newTabs: response.newTabs || [],
  });
}

async function toolBrowserExtensionCommand(args = {}) {
  const command = args.command || parseGenericCommand(args.script || "");
  if (!command?.cmd) throw new Error("browser_extension_command requires command with cmd");
  assertExtensionCommandAllowed(command);
  const session = await resolveExtensionSessionForTool(args);
  const response = await extensionExecuteForTool(session, command, args);
  return toolResult({ ok: true, tab_id: session.id, command: command.cmd, result: response.data, newTabs: response.newTabs || [] });
}

async function toolBrowserExtensionScan(args = {}) {
  const sessions = canProxyExtensionBridge() ? await remoteBrowserBridgeSessions(args) : liveBrowserBridgeSessions();
  const tabs = sessions.map((session) => ({
    id: session.id,
    title: session.title,
    url: session.url && session.url.length > 80 ? `${session.url.slice(0, 80)}...` : session.url,
  }));
  if (args.tabsOnly) {
    return toolResult({ status: "success", metadata: { tabs_count: tabs.length, tabs, active_tab: args.sessionId || sessions[0]?.id || null } });
  }
  const session = matchExtensionSession(sessions, args);
  let content;
  let engine = "generic_simphtml";
  let warning = null;
  if (args.engine === "simple") {
    const response = await extensionExecuteForTool(session, genericScanExpression(args), args);
    content = truncateText(response.data, args.maxChars || 35000);
    engine = "simple";
  } else {
    try {
      ({ content } = await genericSimphtmlExtensionScan(session, args));
    } catch (error) {
      warning = `generic_simphtml failed, used simple extension scan fallback: ${error.message}`;
      const response = await extensionExecuteForTool(session, genericScanExpression(args), args);
      content = truncateText(response.data, args.maxChars || 35000);
      engine = "simple-fallback";
    }
  }
  return toolResult({
    status: "success",
    metadata: { tabs_count: tabs.length, tabs, active_tab: session.id, engine, warning },
    content,
  });
}

function snapshotExpression(maxTextLength) {
  const limit = Number(maxTextLength || 20000);
  return `(() => {
    const clean = (value, max = 500) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, max);
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const cssPath = (element) => {
      if (element.id) return "#" + CSS.escape(element.id);
      const parts = [];
      let node = element;
      while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body) {
        let part = node.tagName.toLowerCase();
        if (node.classList.length) part += "." + [...node.classList].slice(0, 3).map((c) => CSS.escape(c)).join(".");
        const parent = node.parentElement;
        if (parent) {
          const siblings = [...parent.children].filter((sibling) => sibling.tagName === node.tagName);
          if (siblings.length > 1) part += \`:nth-of-type(\${siblings.indexOf(node) + 1})\`;
        }
        parts.unshift(part);
        node = parent;
      }
      return parts.join(" > ");
    };
    const describe = (element, index) => {
      const rect = element.getBoundingClientRect();
      const label = clean([
        element.innerText,
        element.value,
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("placeholder"),
        element.alt,
        element.name,
      ].filter(Boolean).join(" "), 300);
      return {
        index,
        tag: element.tagName,
        text: label,
        href: element.href || "",
        type: element.type || "",
        role: element.getAttribute("role") || "",
        selector: cssPath(element),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      };
    };
    const interactiveSelector = "a,button,input,textarea,select,[role=button],[contenteditable=true],summary,[onclick]";
    const interactive = [...document.querySelectorAll(interactiveSelector)].filter(isVisible).slice(0, 250).map(describe);
    return {
      title: document.title,
      url: location.href,
      readyState: document.readyState,
      text: clean(document.body?.innerText || "", ${limit}),
      links: interactive.filter((item) => item.tag === "A").slice(0, 100),
      buttons: interactive.filter((item) => item.tag === "BUTTON" || item.role === "button").slice(0, 100),
      inputs: interactive.filter((item) => ["INPUT", "TEXTAREA", "SELECT"].includes(item.tag) || item.type).slice(0, 100),
      elements: interactive,
    };
  })()`;
}

async function toolBrowserSnapshot(args = {}) {
  return withTab(args, async (cdp, tab) => {
    const snapshot = await evaluateValue(cdp, snapshotExpression(args.maxTextLength), Number(args.timeoutMs || 15000));
    return toolResult({ tabId: tab.id, ...snapshot });
  });
}

async function toolBrowserAccessibilitySnapshot(args = {}) {
  return withTab(args, async (cdp, tab) => {
    await cdp.send("Accessibility.enable").catch(() => {});
    const tree = await cdp.send("Accessibility.getFullAXTree", {}, Number(args.timeoutMs || 15000));
    const maxNodes = Math.max(1, Math.min(Number(args.maxNodes || 400), 2000));
    const interestingOnly = args.interestingOnly !== false;
    const nodes = (tree.nodes || []).map((node) => {
      const props = {};
      for (const prop of node.properties || []) {
        const value = prop.value;
        props[prop.name] = value?.value ?? value?.description ?? null;
      }
      return {
        nodeId: node.nodeId,
        backendDOMNodeId: node.backendDOMNodeId,
        role: node.role?.value || node.role?.description || "",
        name: node.name?.value || node.name?.description || "",
        value: node.value?.value || node.value?.description || "",
        description: node.description?.value || node.description?.description || "",
        ignored: Boolean(node.ignored),
        properties: props,
        childIds: node.childIds || [],
      };
    }).filter((node) => {
      if (!interestingOnly) return true;
      if (node.ignored) return false;
      if (node.name || node.value || node.description) return true;
      return ["button", "link", "textbox", "combobox", "checkbox", "radio", "menuitem", "tab", "heading", "img"].includes(String(node.role).toLowerCase());
    }).slice(0, maxNodes);
    return toolResult({
      ok: true,
      tabId: tab.id,
      title: tab.title,
      url: tab.url,
      nodeCount: tree.nodes?.length || 0,
      returnedNodeCount: nodes.length,
      interestingOnly,
      nodes,
    });
  });
}

async function toolBrowserPageDiagnostics(args = {}) {
  return withTab(args, async (cdp, tab) => {
    const timeoutMs = Number(args.timeoutMs || 20000);
    const includeAccessibility = args.includeAccessibility !== false;
    const includeVisual = args.includeVisual !== false;
    const includeLocator = args.includeLocator !== false && hasLocatorArgs(args);
    const issues = [];
    const recommendations = [];

    const snapshot = await evaluateValue(cdp, snapshotExpression(args.maxTextLength || 12000), timeoutMs);
    const interactiveCount = (snapshot.elements || []).length;
    const textLength = String(snapshot.text || "").length;

    if (snapshot.readyState !== "complete") {
      issues.push({ severity: "warning", code: "document_not_complete", message: `Document readyState is ${snapshot.readyState}` });
      recommendations.push("Wait for page load or a target element before sending user-like actions.");
    }
    if (!textLength) {
      issues.push({ severity: "warning", code: "no_visible_text", message: "No visible body text was detected." });
      recommendations.push("Use visual analysis or wait for application content when DOM text is empty.");
    }
    if (!interactiveCount) {
      issues.push({ severity: "warning", code: "no_interactive_elements", message: "No visible interactive elements were detected." });
      recommendations.push("Check whether the page is still loading, blocked, or rendered inside canvas/iframe/shadow DOM.");
    }

    let accessibility = null;
    if (includeAccessibility) {
      await cdp.send("Accessibility.enable").catch(() => {});
      const tree = await cdp.send("Accessibility.getFullAXTree", {}, Math.min(timeoutMs, 15000)).catch((error) => ({ error: error.message, nodes: [] }));
      const nodes = tree.nodes || [];
      const interesting = nodes.filter((node) => {
        if (node.ignored) return false;
        const role = String(node.role?.value || node.role?.description || "").toLowerCase();
        const name = node.name?.value || node.name?.description || "";
        const value = node.value?.value || node.value?.description || "";
        if (name || value) return true;
        return ["button", "link", "textbox", "combobox", "checkbox", "radio", "menuitem", "tab", "heading", "img"].includes(role);
      });
      accessibility = {
        ok: !tree.error,
        error: tree.error || null,
        nodeCount: nodes.length,
        interestingNodeCount: interesting.length,
        sample: interesting.slice(0, Math.max(0, Math.min(Number(args.maxAccessibilitySample || 20), 100))).map((node) => ({
          role: node.role?.value || node.role?.description || "",
          name: String(node.name?.value || node.name?.description || "").slice(0, 160),
          value: String(node.value?.value || node.value?.description || "").slice(0, 160),
          ignored: Boolean(node.ignored),
        })),
      };
      if (tree.error) {
        issues.push({ severity: "warning", code: "accessibility_unavailable", message: tree.error });
      } else if (!interesting.length && interactiveCount) {
        issues.push({ severity: "warning", code: "sparse_accessibility_tree", message: "Interactive DOM elements exist, but the accessibility tree has no interesting nodes." });
        recommendations.push("Prefer CSS/text locator or DOM scan for this page; accessibility labels may be missing.");
      }
    }

    let locator = null;
    if (includeLocator) {
      locator = await evaluateValue(cdp, locatorExpression({ ...args, action: args.action || "click" }), Math.min(timeoutMs, 15000)).catch((error) => ({ ok: false, error: error.message }));
      if (!locator.ok) {
        issues.push({ severity: "error", code: "target_not_actionable", message: locator.error || "Locator did not resolve to an actionable element." });
        recommendations.push("Run browser_locator_find for candidate selectors, then retry the action with the selected locator.");
      }
    }

    let visual = null;
    if (includeVisual) {
      const viewport = await viewportSize(cdp);
      const clip = args.visualClip || args.clip || (args.width || args.height ? { x: args.x, y: args.y, width: args.width, height: args.height } : null);
      const normalizedClip = clip ? normalizeClip(clip, viewport, args.padding) : null;
      const captured = await captureScreenshotData(cdp, args, normalizedClip);
      const analysis = (await analyzeImageData(cdp, [{ data: captured.data, format: captured.format }], args)).stats?.[0] || null;
      visual = {
        ok: Boolean(analysis),
        format: captured.format,
        clip: normalizedClip,
        viewport,
        nonBlankScore: analysis?.nonBlankScore ?? null,
        luminance: analysis?.mean?.luminance ?? null,
        luminanceStdDev: analysis?.luminanceStdDev ?? null,
        colorBins: analysis?.colorBins ?? null,
        darkRatio: analysis?.darkRatio ?? null,
        lightRatio: analysis?.lightRatio ?? null,
        transparentRatio: analysis?.transparentRatio ?? null,
      };
      if (analysis && analysis.nonBlankScore < 0.08) {
        issues.push({ severity: "error", code: "visually_blank", message: `Visual nonBlankScore is ${analysis.nonBlankScore.toFixed(3)}.` });
        recommendations.push("Wait for render completion, check navigation errors, or capture a screenshot for manual inspection.");
      } else if (analysis && analysis.nonBlankScore < 0.18) {
        issues.push({ severity: "warning", code: "low_visual_signal", message: `Visual nonBlankScore is ${analysis.nonBlankScore.toFixed(3)}.` });
      }
    }

    const trace = activeTrace ? {
      id: activeTrace.id,
      name: activeTrace.name,
      steps: activeTrace.steps.length,
      eventCount: activeTrace.events.length,
      droppedEvents: activeTrace.droppedEvents,
      includeConsole: activeTrace.options.includeConsole,
      includeNetwork: activeTrace.options.includeNetwork,
    } : null;

    let score = 100;
    if (snapshot.readyState !== "complete") score -= 15;
    if (!textLength) score -= 12;
    if (!interactiveCount) score -= 12;
    if (accessibility && accessibility.ok === false) score -= 8;
    if (visual?.nonBlankScore != null) {
      if (visual.nonBlankScore < 0.08) score -= 30;
      else if (visual.nonBlankScore < 0.18) score -= 12;
    }
    if (includeLocator) {
      if (!locator?.ok) score -= 25;
      else if (locator.actionability?.reasons?.length) score -= 15;
    }
    score = Math.max(0, Math.min(100, Math.round(score)));

    return toolResult({
      ok: issues.every((issue) => issue.severity !== "error"),
      tabId: tab.id,
      title: snapshot.title,
      url: snapshot.url,
      readyState: snapshot.readyState,
      textLength,
      interactiveCount,
      links: (snapshot.links || []).length,
      buttons: (snapshot.buttons || []).length,
      inputs: (snapshot.inputs || []).length,
      accessibility,
      visual,
      locator,
      trace,
      issues,
      recommendations: [...new Set(recommendations)],
      score,
    });
  });
}

async function toolBrowserWaitFor(args = {}) {
  if (!args.selector && !args.text && !args.urlContains) {
    throw new Error("browser_wait_for requires selector, text, or urlContains");
  }
  const timeoutMs = Number(args.timeoutMs || 10000);
  const intervalMs = Number(args.intervalMs || 250);
  const state = String(args.state || "visible");
  return withTab(args, async (cdp, tab) => {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
      const found = await evaluateValue(cdp, `(() => {
        const hasUrl = ${JSON.stringify(args.urlContains || null)} ? location.href.includes(${JSON.stringify(args.urlContains || "")}) : true;
        if (!hasUrl) return { ok: false, reason: "url" };
        if (!${JSON.stringify(Boolean(args.selector || args.text))}) return { ok: true, url: location.href };
        const probe = ${elementLookupExpression({ selector: args.selector, text: args.text, exact: args.exact, allElements: true })};
        return probe;
      })()`).catch((error) => ({ ok: false, error: error.message }));
      last = found;
      if (state === "hidden" && !found.ok) return toolResult({ ok: true, state, tabId: tab.id, waitedMs: Date.now() - started });
      if (state !== "hidden" && found.ok) return toolResult({ ok: true, state, tabId: tab.id, waitedMs: Date.now() - started, found });
      await sleep(intervalMs);
    }
    return toolError(`Timed out waiting for ${state}`, { tabId: tab.id, waitedMs: Date.now() - started, last });
  });
}

async function toolBrowserScroll(args = {}) {
  const deltaX = Number(args.deltaX || 0);
  const deltaY = Number(args.deltaY || 0);
  return withTab(args, async (cdp, tab) => {
    const result = await evaluateValue(cdp, `(() => {
      if (${JSON.stringify(args.to || null)} === "top") window.scrollTo({ top: 0, left: 0, behavior: "instant" });
      else if (${JSON.stringify(args.to || null)} === "bottom") window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
      else window.scrollBy({ left: ${deltaX}, top: ${deltaY}, behavior: "instant" });
      return { x: window.scrollX, y: window.scrollY, height: document.documentElement.scrollHeight };
    })()`);
    return toolResult({ ok: true, tabId: tab.id, scroll: result });
  });
}

function screenshotFormat(args = {}) {
  return args.format === "jpeg" ? "jpeg" : "png";
}

function normalizeClip(clip, viewport = null, padding = 0) {
  if (!clip) return null;
  const pad = Math.max(0, Number(padding || 0));
  let x = Number(clip.x ?? clip.left ?? 0) - pad;
  let y = Number(clip.y ?? clip.top ?? 0) - pad;
  let width = Number(clip.width ?? 0) + pad * 2;
  let height = Number(clip.height ?? 0) + pad * 2;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid screenshot clip: ${JSON.stringify(clip)}`);
  }
  if (viewport) {
    const maxWidth = Number(viewport.width || 0);
    const maxHeight = Number(viewport.height || 0);
    const right = Math.min(maxWidth || x + width, x + width);
    const bottom = Math.min(maxHeight || y + height, y + height);
    x = Math.max(0, x);
    y = Math.max(0, y);
    width = Math.max(1, right - x);
    height = Math.max(1, bottom - y);
  }
  return {
    x: Math.max(0, x),
    y: Math.max(0, y),
    width: Math.max(1, width),
    height: Math.max(1, height),
    scale: Number(clip.scale || 1),
  };
}

async function viewportSize(cdp) {
  return evaluateValue(cdp, `(() => ({ width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1 }))()`, 5000)
    .catch(() => ({ width: 0, height: 0, devicePixelRatio: 1 }));
}

async function captureScreenshotData(cdp, args = {}, clip = null) {
  const format = screenshotFormat(args);
  const params = { format, fromSurface: true };
  if (format === "jpeg" && args.quality) params.quality = Math.max(1, Math.min(100, Number(args.quality)));
  if (clip) params.clip = clip;
  const result = await cdp.send("Page.captureScreenshot", params, Number(args.timeoutMs || 30000));
  return { data: result.data, format };
}

function writeScreenshot(data, format, args = {}, suffix = "screenshot") {
  const outPath = resolveOutputPath(args.path, path.join(DEFAULT_SCREENSHOT_DIR, `${suffix}-${Date.now()}.${format}`), "screenshot path");
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, Buffer.from(data, "base64"));
  return outPath;
}

function imageStatsExpression(images, options = {}) {
  const payload = {
    images,
    sampleMax: Math.max(100, Math.min(Number(options.sampleMax || 120000), 1000000)),
    diffThreshold: Math.max(0, Math.min(Number(options.diffThreshold || 12), 255)),
  };
  return `(async () => {
    const params = ${JSON.stringify(payload)};
    const loadImage = async (item) => {
      const mime = item.format === "jpeg" ? "image/jpeg" : "image/png";
      const blob = await (await fetch("data:" + mime + ";base64," + item.data)).blob();
      const bitmap = await createImageBitmap(blob);
      const maxPixels = Math.max(1, params.sampleMax);
      const scale = Math.min(1, Math.sqrt(maxPixels / Math.max(1, bitmap.width * bitmap.height)));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0, width, height);
      const pixels = ctx.getImageData(0, 0, width, height).data;
      return { width: bitmap.width, height: bitmap.height, sampleWidth: width, sampleHeight: height, pixels };
    };
    const statsFor = (image) => {
      const pixels = image.pixels;
      const count = pixels.length / 4;
      let sumR = 0, sumG = 0, sumB = 0, sumA = 0, sumLum = 0, sumLum2 = 0;
      let transparent = 0, dark = 0, light = 0;
      const colors = new Map();
      for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], a = pixels[i + 3];
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        sumR += r; sumG += g; sumB += b; sumA += a; sumLum += lum; sumLum2 += lum * lum;
        if (a < 10) transparent++;
        if (lum < 30) dark++;
        if (lum > 225) light++;
        const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
        colors.set(key, (colors.get(key) || 0) + 1);
      }
      const meanLum = sumLum / Math.max(1, count);
      const variance = Math.max(0, sumLum2 / Math.max(1, count) - meanLum * meanLum);
      const sortedColors = [...colors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([key, value]) => ({
        rgb: [((key >> 8) & 15) * 17, ((key >> 4) & 15) * 17, (key & 15) * 17],
        ratio: value / Math.max(1, count),
      }));
      const colorBins = colors.size;
      return {
        width: image.width,
        height: image.height,
        sampleWidth: image.sampleWidth,
        sampleHeight: image.sampleHeight,
        sampledPixels: count,
        mean: { r: sumR / count, g: sumG / count, b: sumB / count, a: sumA / count, luminance: meanLum },
        luminanceStdDev: Math.sqrt(variance),
        transparentRatio: transparent / Math.max(1, count),
        darkRatio: dark / Math.max(1, count),
        lightRatio: light / Math.max(1, count),
        colorBins,
        dominantColors: sortedColors,
        nonBlankScore: Math.min(1, (Math.sqrt(variance) / 64) * 0.55 + Math.min(colorBins / 96, 1) * 0.35 + (1 - Math.max(dark, light, transparent) / Math.max(1, count)) * 0.1),
      };
    };
    const loaded = [];
    for (const image of params.images) loaded.push(await loadImage(image));
    const stats = loaded.map(statsFor);
    let comparison = null;
    if (loaded.length >= 2) {
      const a = loaded[0], b = loaded[1];
      const width = Math.min(a.sampleWidth, b.sampleWidth);
      const height = Math.min(a.sampleHeight, b.sampleHeight);
      let changed = 0, totalDelta = 0, maxDelta = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const ai = (y * a.sampleWidth + x) * 4;
          const bi = (y * b.sampleWidth + x) * 4;
          const delta = (Math.abs(a.pixels[ai] - b.pixels[bi]) + Math.abs(a.pixels[ai + 1] - b.pixels[bi + 1]) + Math.abs(a.pixels[ai + 2] - b.pixels[bi + 2])) / 3;
          totalDelta += delta;
          if (delta > maxDelta) maxDelta = delta;
          if (delta >= params.diffThreshold) changed++;
        }
      }
      const count = Math.max(1, width * height);
      comparison = {
        sampleWidth: width,
        sampleHeight: height,
        changedPixels: changed,
        changedRatio: changed / count,
        meanDelta: totalDelta / count,
        maxDelta,
        similar: changed / count < 0.01 && totalDelta / count < params.diffThreshold,
      };
    }
    return { ok: true, stats, comparison };
  })()`;
}

async function analyzeImageData(cdp, imageItems, args = {}) {
  return evaluateValue(cdp, imageStatsExpression(imageItems, args), Number(args.timeoutMs || 30000));
}

async function elementClip(cdp, args = {}) {
  const result = await evaluateValue(cdp, locatorExpression({ ...args, action: "inspect", waitForActionable: false }), Number(args.timeoutMs || 15000));
  if (!result.ok) throw new Error(result.error || "No locator match");
  const viewport = await viewportSize(cdp);
  return { locator: result, clip: normalizeClip(result.selected.rect, viewport, args.padding) };
}

async function toolBrowserElementScreenshot(args = {}) {
  if (!args.selector && !args.text && !args.role && !args.name && !args.label && !args.placeholder && !args.alt && !args.title && !args.testId && !args.testID) {
    throw new Error("browser_element_screenshot requires selector, text, role/name, label, placeholder, alt, title, or testId");
  }
  return withTab(args, async (cdp, tab) => {
    const { locator, clip } = await elementClip(cdp, args);
    const captured = await captureScreenshotData(cdp, args, clip);
    const outPath = writeScreenshot(captured.data, captured.format, args, "element");
    const response = { ok: true, tabId: tab.id, path: outPath, format: captured.format, clip, locator: locator.selected };
    if (args.analyze) response.analysis = (await analyzeImageData(cdp, [{ data: captured.data, format: captured.format }], args)).stats?.[0] || null;
    const extra = args.includeData ? [{ type: "image", data: captured.data, mimeType: `image/${captured.format}` }] : [];
    return toolResult(response, extra);
  });
}

async function toolBrowserRegionScreenshot(args = {}) {
  return withTab(args, async (cdp, tab) => {
    const viewport = await viewportSize(cdp);
    const clip = normalizeClip(args.clip || { x: args.x, y: args.y, width: args.width, height: args.height }, viewport, args.padding);
    const captured = await captureScreenshotData(cdp, args, clip);
    const outPath = writeScreenshot(captured.data, captured.format, args, "region");
    const response = { ok: true, tabId: tab.id, path: outPath, format: captured.format, clip };
    if (args.analyze) response.analysis = (await analyzeImageData(cdp, [{ data: captured.data, format: captured.format }], args)).stats?.[0] || null;
    const extra = args.includeData ? [{ type: "image", data: captured.data, mimeType: `image/${captured.format}` }] : [];
    return toolResult(response, extra);
  });
}

async function toolBrowserVisualAnalyze(args = {}) {
  return withTab(args, async (cdp, tab) => {
    let clip = null;
    let locator = null;
    if (args.selector || args.text || args.role || args.name || args.label || args.placeholder || args.alt || args.title || args.testId || args.testID) {
      ({ locator, clip } = await elementClip(cdp, args));
    } else if (args.clip || args.width || args.height) {
      const viewport = await viewportSize(cdp);
      clip = normalizeClip(args.clip || { x: args.x, y: args.y, width: args.width, height: args.height }, viewport, args.padding);
    }
    const captured = await captureScreenshotData(cdp, args, clip);
    const analysis = (await analyzeImageData(cdp, [{ data: captured.data, format: captured.format }], args)).stats?.[0] || null;
    const outPath = args.path ? writeScreenshot(captured.data, captured.format, args, "visual") : null;
    return toolResult({ ok: true, tabId: tab.id, path: outPath, format: captured.format, clip, locator: locator?.selected || null, analysis });
  });
}

async function toolBrowserVisualCompare(args = {}) {
  return withTab(args, async (cdp, tab) => {
    const before = await captureScreenshotData(cdp, args, null);
    if (args.actionScript) {
      const result = await cdp.send("Runtime.evaluate", {
        expression: `(async () => { ${args.actionScript}\n})()`,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      }, Number(args.actionTimeoutMs || args.timeoutMs || 15000));
      if (result.exceptionDetails) throw new Error(exceptionText(result.exceptionDetails));
    }
    if (args.settleMs !== 0) await sleep(Number(args.settleMs || 500));
    const after = await captureScreenshotData(cdp, args, null);
    const analysis = await analyzeImageData(cdp, [
      { data: before.data, format: before.format },
      { data: after.data, format: after.format },
    ], args);
    const beforePath = args.beforePath ? writeScreenshot(before.data, before.format, { ...args, path: args.beforePath }, "before") : null;
    const afterPath = args.afterPath ? writeScreenshot(after.data, after.format, { ...args, path: args.afterPath }, "after") : null;
    return toolResult({ ok: true, tabId: tab.id, beforePath, afterPath, format: before.format, stats: analysis.stats, comparison: analysis.comparison });
  });
}

async function toolBrowserScreenshot(args = {}) {
  return withTab(args, async (cdp, tab) => {
    const format = screenshotFormat(args);
    const params = { format, fromSurface: true };
    if (format === "jpeg" && args.quality) params.quality = Math.max(1, Math.min(100, Number(args.quality)));

    if (args.fullPage) {
      const metrics = await cdp.send("Page.getLayoutMetrics");
      const size = metrics.contentSize || { width: 1280, height: 720 };
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: Math.max(1, Math.ceil(size.width)),
        height: Math.max(1, Math.ceil(size.height)),
        deviceScaleFactor: 1,
        mobile: false,
      });
      params.captureBeyondViewport = true;
    }

    try {
      const result = await cdp.send("Page.captureScreenshot", params, Number(args.timeoutMs || 30000));
      const outPath = resolveOutputPath(args.path, path.join(DEFAULT_SCREENSHOT_DIR, `screenshot-${Date.now()}.${format}`), "screenshot path");
      mkdirSync(path.dirname(outPath), { recursive: true });
      writeFileSync(outPath, Buffer.from(result.data, "base64"));
      const extra = args.includeData ? [{ type: "image", data: result.data, mimeType: `image/${format}` }] : [];
      return toolResult({ ok: true, tabId: tab.id, path: outPath, format, fullPage: Boolean(args.fullPage) }, extra);
    } finally {
      if (args.fullPage) await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    }
  });
}

const commonTabProperties = {
  host: { type: "string", description: "Debugger host. Defaults to 127.0.0.1." },
  port: { type: "number", description: "Chrome DevTools remote debugging port. Defaults to 9222." },
  tabId: { type: "string", description: "Target/tab id from browser_list_tabs. Defaults to the first page target." },
  urlPattern: { type: "string", description: "Use the first tab whose URL contains this string." },
};

const commonExtensionProperties = {
  sessionId: { type: "string", description: "Extension tab/session id from browser_extension_list_tabs." },
  extensionTabId: { type: "string", description: "Alias for sessionId." },
  switchTabId: { type: "string", description: "GenericAgent-compatible alias for sessionId." },
  tabId: { type: "string", description: "GenericAgent-compatible extension tab id." },
  urlPattern: { type: "string", description: "Use the first extension-controlled tab whose URL contains this string." },
  timeoutMs: { type: "number" },
};

const tools = [
  {
    name: "browser_trace_start",
    description: "Start a local browser-control trace that records MCP tool calls, timings, sanitized results, and optional page artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Human-readable trace name." },
        dir: { type: "string", description: "Trace output directory under an allowed output root. Defaults to <output-root>/traces/<trace-id>." },
        path: { type: "string", description: "Explicit JSONL trace path under an allowed output root. Also creates a sibling JSON export path." },
        includeArgs: { type: "boolean", description: "Record sanitized tool arguments. Defaults to true." },
        includeResults: { type: "boolean", description: "Record sanitized tool results. Defaults to true." },
        includeSnapshots: { type: "boolean", description: "Capture compact page snapshots after actionable tools." },
        includeScreenshots: { type: "boolean", description: "Capture screenshots after CDP-backed actionable tools." },
        includeConsole: { type: "boolean", description: "Record console/log/exception events while CDP tools are connected." },
        includeNetwork: { type: "boolean", description: "Record a lightweight network request/response/failure summary while CDP tools are connected." },
        screenshotFullPage: { type: "boolean", description: "Use full-page screenshots for trace artifacts." },
        redactSensitive: { type: "boolean", description: "Redact tokens, cookies, passwords, and typed text. Defaults to true." },
        maxTextChars: { type: "number", description: "Maximum snapshot text length." },
        maxResultChars: { type: "number", description: "Maximum stored string/result length." },
        maxEvents: { type: "number", description: "Maximum browser events kept in memory/export. Defaults to 500." },
      },
    },
  },
  {
    name: "browser_trace_status",
    description: "Return the active trace summary and the last stopped trace summary.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_trace_stop",
    description: "Stop the active trace and optionally export a consolidated JSON replay file.",
    inputSchema: {
      type: "object",
      properties: {
        export: { type: "boolean", description: "Write consolidated JSON export. Defaults to true." },
        path: { type: "string", description: "Optional export JSON path." },
      },
    },
  },
  {
    name: "browser_trace_export",
    description: "Export the active or most recently stopped trace to consolidated JSON.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional export JSON path." },
      },
    },
  },
  {
    name: "browser_start",
    description: "Start a visible Chrome/Edge instance with local CDP enabled, or report the existing debugger if already running.",
    inputSchema: {
      type: "object",
      properties: {
        host: commonTabProperties.host,
        port: commonTabProperties.port,
        browser: { type: "string", enum: ["edge", "chrome"], description: "Browser to launch. Defaults to edge on Windows." },
        executablePath: { type: "string", description: "Optional real chrome.exe/msedge.exe path under a standard install root, or an exact path allowed by BROWSER_CONTROL_ALLOWED_BROWSER_PATHS." },
        userDataDir: { type: "string", description: "Optional browser profile directory. Defaults to a temp profile per port." },
        url: { type: "string", description: "Initial URL. Defaults to about:blank." },
        headless: { type: "boolean", description: "Launch headless instead of visible." },
        extraArgs: { type: "array", items: { type: "string" }, description: "Additional browser launch flags." },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_status",
    description: "Check whether a local Chrome DevTools endpoint is reachable.",
    inputSchema: { type: "object", properties: { host: commonTabProperties.host, port: commonTabProperties.port } },
  },
  {
    name: "browser_stop",
    description: "Close the browser attached to a Chrome DevTools endpoint.",
    inputSchema: {
      type: "object",
      properties: {
        host: commonTabProperties.host,
        port: commonTabProperties.port,
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_list_tabs",
    description: "List controllable page tabs from the Chrome DevTools endpoint.",
    inputSchema: { type: "object", properties: { host: commonTabProperties.host, port: commonTabProperties.port } },
  },
  {
    name: "browser_extension_status",
    description: "Check the built-in Codex browser extension bridge on 127.0.0.1:18795.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_extension_list_tabs",
    description: "List tabs connected through the Codex Browser Control Bridge (18795) Chrome/Edge extension.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_extension_repair",
    description: "Diagnose and repair the Codex Browser Control Bridge (18795) when the port is reachable but no extension tabs are connected.",
    inputSchema: {
      type: "object",
      properties: {
        timeoutMs: { type: "number" },
        restartBridge: { type: "boolean", description: "Restart the external bridge process when this MCP process is proxying to it. Defaults to true." },
      },
    },
  },
  {
    name: "browser_extension_scan",
    description: "Extension-backed web_scan using the Codex Browser Control Bridge (18795), preserving the user's logged-in browser profile.",
    inputSchema: {
      type: "object",
      properties: {
        ...commonExtensionProperties,
        tabsOnly: { type: "boolean" },
        textOnly: { type: "boolean" },
        maxChars: { type: "number", description: "Maximum content characters. Defaults to 35000." },
        cutlist: { type: "boolean", description: "Use GenericAgent list elision. Defaults to true." },
        instruction: { type: "string", description: "Important text to preserve while eliding repeated lists." },
        engine: { type: "string", enum: ["generic_simphtml", "simple"], description: "Defaults to GenericAgent's migrated simphtml engine." },
      },
    },
  },
  {
    name: "browser_extension_execute_js",
    description: "GenericAgent extension-backed web_execute_js on a user browser tab. Accepts plain JS or JSON command strings.",
    inputSchema: {
      type: "object",
      required: ["script"],
      properties: {
        ...commonExtensionProperties,
        script: { type: "string" },
      },
    },
  },
  {
    name: "browser_extension_command",
    description: "Send bridge commands through the installed Codex extension: cookies, tabs, cdp, batch, management, or contentSettings.",
    inputSchema: {
      type: "object",
      properties: {
        ...commonExtensionProperties,
        command: { type: "object" },
        script: { type: "string", description: "JSON command string." },
      },
    },
  },
  {
    name: "browser_open",
    description: "Open a URL in a new tab, or navigate an existing tab when newTab is false and tabId is provided.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        ...commonTabProperties,
        url: { type: "string" },
        newTab: { type: "boolean", description: "Defaults to true." },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_activate",
    description: "Bring a target tab to the front.",
    inputSchema: { type: "object", required: ["tabId"], properties: commonTabProperties },
  },
  {
    name: "browser_close",
    description: "Close a target tab.",
    inputSchema: { type: "object", required: ["tabId"], properties: commonTabProperties },
  },
  {
    name: "browser_wait_for_new_tab",
    description: "Wait for a new page tab, optionally after running a page-side action script in the current tab.",
    inputSchema: {
      type: "object",
      properties: {
        ...commonTabProperties,
        existingTabIds: { type: "array", items: { type: "string" }, description: "Known existing tab ids. Defaults to current page targets before actionScript." },
        actionScript: { type: "string", description: "Optional page-side script to trigger the new tab." },
        actionTimeoutMs: { type: "number" },
        returnByValue: { type: "boolean" },
        timeoutMs: { type: "number" },
        intervalMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_dialog",
    description: "Wait for, accept, or dismiss a JavaScript alert/confirm/prompt dialog.",
    inputSchema: {
      type: "object",
      properties: {
        ...commonTabProperties,
        action: { type: "string", enum: ["wait", "accept", "dismiss"], description: "Defaults to wait." },
        actionScript: { type: "string", description: "Optional page-side script to run after dialog event listening is armed." },
        actionTimeoutMs: { type: "number" },
        returnByValue: { type: "boolean" },
        promptText: { type: "string", description: "Text for prompt dialogs when accepting." },
        waitForDialog: { type: "boolean", description: "Wait for a dialog before handling it. Defaults to true for accept/dismiss." },
        handleTimeoutMs: { type: "number" },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_set_download_behavior",
    description: "Configure the selected browser context to allow, deny, or default downloads and set a download directory.",
    inputSchema: {
      type: "object",
      properties: {
        ...commonTabProperties,
        downloadPath: { type: "string", description: "Directory under an allowed output root. Defaults to <output-root>/downloads." },
        path: { type: "string", description: "Alias for downloadPath." },
        behavior: { type: "string", enum: ["allow", "allowAndName", "deny", "default"], description: "Defaults to allow." },
        eventsEnabled: { type: "boolean", description: "Enable Browser.download* events. Defaults to true." },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_wait_for_download",
    description: "Enable download events and wait for the next browser download to complete or cancel.",
    inputSchema: {
      type: "object",
      properties: {
        ...commonTabProperties,
        downloadPath: { type: "string", description: "Directory under an allowed output root. Defaults to <output-root>/downloads." },
        path: { type: "string", description: "Alias for downloadPath." },
        suggestedFilename: { type: "string", description: "Optional substring filter for suggested filename." },
        behavior: { type: "string", enum: ["allow", "allowAndName"], description: "Defaults to allow." },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_grant_permissions",
    description: "Grant browser permissions such as clipboardReadWrite, geolocation, notifications, camera, or microphone for an origin.",
    inputSchema: {
      type: "object",
      required: ["permissions"],
      properties: {
        ...commonTabProperties,
        origin: { type: "string", description: "Origin to grant permissions for. Defaults to the selected tab origin." },
        permissions: { type: "array", items: { type: "string" } },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_reset_permissions",
    description: "Reset browser permissions for an origin, or all permissions when origin reset is unsupported.",
    inputSchema: {
      type: "object",
      properties: {
        ...commonTabProperties,
        origin: { type: "string", description: "Origin to reset permissions for. Defaults to the selected tab origin." },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_playwright_status",
    description: "Check optional Playwright backend availability and active Playwright sessions.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_playwright_start",
    description: "Start an optional Playwright-controlled browser session. This does not replace CDP or extension tools.",
    inputSchema: {
      type: "object",
      properties: {
        browser: { type: "string", enum: ["chromium", "firefox", "webkit"], description: "Defaults to chromium." },
        headless: { type: "boolean", description: "Defaults to true." },
        executablePath: { type: "string", description: "Optional real chrome.exe/msedge.exe path under a standard install root, or an exact path allowed by BROWSER_CONTROL_ALLOWED_BROWSER_PATHS." },
        userDataDir: { type: "string", description: "Use Playwright persistent context with this profile directory." },
        url: { type: "string" },
        waitUntil: { type: "string", enum: ["load", "domcontentloaded", "networkidle", "commit"] },
        args: { type: "array", items: { type: "string" }, description: "Additional browser launch args." },
        contextOptions: { type: "object" },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_playwright_open",
    description: "Navigate a Playwright page, or open a new Playwright page when newPage is true.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        sessionId: { type: "string" },
        pageId: { type: "string" },
        url: { type: "string" },
        newPage: { type: "boolean" },
        waitUntil: { type: "string", enum: ["load", "domcontentloaded", "networkidle", "commit"] },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_playwright_click",
    description: "Click using Playwright locator auto-waiting in an optional Playwright session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        pageId: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
        role: { type: "string" },
        name: { type: "string" },
        label: { type: "string" },
        placeholder: { type: "string" },
        alt: { type: "string" },
        title: { type: "string" },
        testId: { type: "string" },
        exact: { type: "boolean" },
        nth: { type: "number" },
        button: { type: "string", enum: ["left", "middle", "right"] },
        clickCount: { type: "number" },
        settleMs: { type: "number" },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_playwright_type",
    description: "Fill text using Playwright locator auto-waiting in an optional Playwright session.",
    inputSchema: {
      type: "object",
      required: ["value"],
      properties: {
        sessionId: { type: "string" },
        pageId: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
        role: { type: "string" },
        name: { type: "string" },
        label: { type: "string" },
        placeholder: { type: "string" },
        alt: { type: "string" },
        title: { type: "string" },
        testId: { type: "string" },
        exact: { type: "boolean" },
        nth: { type: "number" },
        value: { type: "string" },
        clear: { type: "boolean" },
        pressEnter: { type: "boolean" },
        settleMs: { type: "number" },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_playwright_screenshot",
    description: "Capture a screenshot from an optional Playwright session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        pageId: { type: "string" },
        path: { type: "string", description: "Output path under an allowed output root." },
        fullPage: { type: "boolean" },
        format: { type: "string", enum: ["png", "jpeg"] },
        quality: { type: "number" },
        includeData: { type: "boolean" },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_playwright_stop",
    description: "Stop an optional Playwright-controlled browser session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
      },
    },
  },
  {
    name: "browser_snapshot",
    description: "Read page title, URL, visible text, and common interactive elements.",
    inputSchema: {
      type: "object",
      properties: {
        ...commonTabProperties,
        maxTextLength: { type: "number", description: "Maximum visible text length. Defaults to 20000." },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_accessibility_snapshot",
    description: "Read a compact Chrome accessibility tree for deterministic LLM-friendly page understanding.",
    inputSchema: {
      type: "object",
      properties: {
        ...commonTabProperties,
        maxNodes: { type: "number", description: "Maximum accessibility nodes to return. Defaults to 400." },
        interestingOnly: { type: "boolean", description: "Filter ignored/empty nodes. Defaults to true." },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_page_diagnostics",
    description: "Run a compact page health check combining DOM snapshot, accessibility, visual signal, trace status, and optional locator actionability.",
    inputSchema: {
      type: "object",
      properties: {
        ...commonTabProperties,
        selector: { type: "string" },
        text: { type: "string" },
        role: { type: "string" },
        name: { type: "string" },
        label: { type: "string" },
        placeholder: { type: "string" },
        alt: { type: "string" },
        title: { type: "string" },
        testId: { type: "string" },
        exact: { type: "boolean" },
        nth: { type: "number" },
        requireEditable: { type: "boolean" },
        includeAccessibility: { type: "boolean", description: "Include accessibility tree summary. Defaults to true." },
        includeVisual: { type: "boolean", description: "Include visual nonblank/luminance analysis. Defaults to true." },
        includeLocator: { type: "boolean", description: "Check locator actionability when locator fields are provided. Defaults to true." },
        maxTextLength: { type: "number", description: "Maximum visible text length for the DOM snapshot. Defaults to 12000." },
        maxAccessibilitySample: { type: "number", description: "Maximum accessibility sample nodes to return. Defaults to 20." },
        visualClip: { type: "object", description: "Optional viewport clip for visual diagnostics." },
        clip: { type: "object", description: "Alias for visualClip." },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        padding: { type: "number" },
        format: { type: "string", enum: ["png", "jpeg"] },
        quality: { type: "number" },
        sampleMax: { type: "number" },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_scan",
    description: "GenericAgent-style web_scan: list tabs and return optimized visible HTML or text, including input values, open shadow roots, and same-origin iframe content.",
    inputSchema: {
      type: "object",
      properties: {
        ...commonTabProperties,
        tabsOnly: { type: "boolean", description: "Only return tab metadata." },
        textOnly: { type: "boolean", description: "Return compact visible text instead of optimized HTML." },
        maxChars: { type: "number", description: "Maximum content characters. Defaults to 35000." },
        cutlist: { type: "boolean", description: "Use GenericAgent list elision. Defaults to true." },
        instruction: { type: "string", description: "Important text to preserve while eliding repeated lists." },
        extraJs: { type: "string", description: "Extra JavaScript to run before GenericAgent optHTML." },
        engine: { type: "string", enum: ["generic_simphtml", "simple"], description: "Defaults to GenericAgent's migrated simphtml engine." },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_locator_find",
    description: "Find elements using Playwright-style signals such as role/name/text/label/placeholder/alt/title/testId/CSS and return ranked candidates.",
    inputSchema: {
      type: "object",
      properties: {
        ...commonTabProperties,
        selector: { type: "string" },
        text: { type: "string" },
        role: { type: "string" },
        name: { type: "string" },
        label: { type: "string" },
        placeholder: { type: "string" },
        alt: { type: "string" },
        title: { type: "string" },
        testId: { type: "string" },
        exact: { type: "boolean" },
        nth: { type: "number" },
        includeHidden: { type: "boolean" },
        allElements: { type: "boolean", description: "Search all body elements in addition to interactive candidates. Defaults to true." },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_actionability_check",
    description: "Check whether a located element is visible, stable, enabled, editable when requested, and can receive click events.",
    inputSchema: {
      type: "object",
      properties: {
        ...commonTabProperties,
        selector: { type: "string" },
        text: { type: "string" },
        role: { type: "string" },
        name: { type: "string" },
        label: { type: "string" },
        placeholder: { type: "string" },
        alt: { type: "string" },
        title: { type: "string" },
        testId: { type: "string" },
        exact: { type: "boolean" },
        nth: { type: "number" },
        requireEditable: { type: "boolean" },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_locator_click",
    description: "Click a Playwright-style locator after auto-waiting for visibility, stability, enabled state, and event hit testing.",
    inputSchema: {
      type: "object",
      properties: {
        ...commonTabProperties,
        selector: { type: "string" },
        text: { type: "string" },
        role: { type: "string" },
        name: { type: "string" },
        label: { type: "string" },
        placeholder: { type: "string" },
        alt: { type: "string" },
        title: { type: "string" },
        testId: { type: "string" },
        exact: { type: "boolean" },
        nth: { type: "number" },
        button: { type: "string", enum: ["left", "middle", "right"] },
        clickCount: { type: "number" },
        timeoutMs: { type: "number" },
        intervalMs: { type: "number" },
        settleMs: { type: "number" },
        waitForNewTab: { type: "boolean", description: "Wait for a newly opened page tab after the click." },
        newTabTimeoutMs: { type: "number" },
        requireNewTab: { type: "boolean", description: "Return an error if waitForNewTab is true but no new tab appears." },
      },
    },
  },
  {
    name: "browser_locator_type",
    description: "Type into a Playwright-style locator after auto-waiting for visibility, stability, enabled state, editability, and event hit testing.",
    inputSchema: {
      type: "object",
      required: ["value"],
      properties: {
        ...commonTabProperties,
        selector: { type: "string" },
        text: { type: "string" },
        role: { type: "string" },
        name: { type: "string" },
        label: { type: "string" },
        placeholder: { type: "string" },
        alt: { type: "string" },
        title: { type: "string" },
        testId: { type: "string" },
        exact: { type: "boolean" },
        nth: { type: "number" },
        value: { type: "string" },
        clear: { type: "boolean" },
        pressEnter: { type: "boolean" },
        timeoutMs: { type: "number" },
        intervalMs: { type: "number" },
        settleMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_click",
    description: "Click an element by CSS selector or visible text using CDP mouse events.",
    inputSchema: {
      type: "object",
      properties: {
        ...commonTabProperties,
        selector: { type: "string" },
        text: { type: "string" },
        exact: { type: "boolean" },
        allElements: { type: "boolean", description: "Allow text search across all visible body elements." },
        button: { type: "string", enum: ["left", "middle", "right"] },
        clickCount: { type: "number" },
        waitForNewTab: { type: "boolean", description: "Wait for a newly opened page tab after the click." },
        newTabTimeoutMs: { type: "number" },
        requireNewTab: { type: "boolean", description: "Return an error if waitForNewTab is true but no new tab appears." },
      },
    },
  },
  {
    name: "browser_type",
    description: "Focus an element and type text with CDP keyboard/input events.",
    inputSchema: {
      type: "object",
      required: ["value"],
      properties: {
        ...commonTabProperties,
        selector: { type: "string" },
        text: { type: "string" },
        exact: { type: "boolean" },
        value: { type: "string" },
        clear: { type: "boolean" },
        pressEnter: { type: "boolean" },
      },
    },
  },
  {
    name: "browser_eval",
    description: "Evaluate JavaScript in the selected page context.",
    inputSchema: {
      type: "object",
      required: ["script"],
      properties: {
        ...commonTabProperties,
        script: { type: "string" },
        awaitPromise: { type: "boolean" },
        returnByValue: { type: "boolean" },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_cdp",
    description: "Send a raw Chrome DevTools Protocol command to a page target.",
    inputSchema: {
      type: "object",
      required: ["method"],
      properties: {
        ...commonTabProperties,
        method: { type: "string", description: "CDP method, such as Runtime.evaluate or Page.captureScreenshot." },
        params: { type: "object" },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_cdp_batch",
    description: "Run a GenericAgent-style batch of CDP commands on one target. Later params can reference earlier results with $0.result.foo.",
    inputSchema: {
      type: "object",
      required: ["commands"],
      properties: {
        ...commonTabProperties,
        commands: {
          type: "array",
          items: {
            type: "object",
            required: ["method"],
            properties: {
              method: { type: "string" },
              params: { type: "object" },
              timeoutMs: { type: "number" },
            },
          },
        },
        stopOnError: { type: "boolean", description: "Defaults to true." },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_cookies",
    description: "Read cookies for the selected tab or explicit URLs through CDP, including HttpOnly cookies exposed by DevTools.",
    inputSchema: {
      type: "object",
      properties: {
        ...commonTabProperties,
        url: { type: "string" },
        urls: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "browser_set_file_input_files",
    description: "Set files on an input[type=file] using CDP DOM.setFileInputFiles, matching GenericAgent's preferred upload path.",
    inputSchema: {
      type: "object",
      required: ["files"],
      properties: {
        ...commonTabProperties,
        selector: { type: "string", description: "CSS selector for the file input. Optional when nodeId is supplied." },
        nodeId: { type: "number", description: "Existing DOM nodeId for the file input." },
        files: { type: "array", items: { type: "string" } },
        pierce: { type: "boolean", description: "Pierce open shadow DOM when locating the node. Defaults to true." },
        includeUserAgentShadowDOM: { type: "boolean" },
        dispatchEvents: { type: "boolean", description: "Dispatch input/change events after setting files. Defaults to true." },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_iframe_eval",
    description: "Evaluate JavaScript inside a matching iframe via Page.createIsolatedWorld, for cross-origin iframe workflows.",
    inputSchema: {
      type: "object",
      required: ["script"],
      properties: {
        ...commonTabProperties,
        script: { type: "string" },
        frameId: { type: "string" },
        frameUrlContains: { type: "string" },
        frameName: { type: "string" },
        frameIndex: { type: "number" },
        returnByValue: { type: "boolean" },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_dom_pierce",
    description: "Search DOM with pierce:true and return node ids/box models, useful for open/closed shadow DOM and transformed elements.",
    inputSchema: {
      type: "object",
      required: ["selector"],
      properties: {
        ...commonTabProperties,
        selector: { type: "string" },
        limit: { type: "number" },
        includeUserAgentShadowDOM: { type: "boolean" },
      },
    },
  },
  {
    name: "browser_generic_command",
    description: "Run GenericAgent-style JSON commands: {cmd:'cookies'}, {cmd:'tabs'}, {cmd:'cdp'}, or {cmd:'batch'}.",
    inputSchema: {
      type: "object",
      properties: {
        ...commonTabProperties,
        command: { type: "object" },
        script: { type: "string", description: "JSON command string for compatibility with GenericAgent web_execute_js." },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_execute_js_rich",
    description: "GenericAgent-style web_execute_js: execute JS or JSON command, detect new tabs, transient text, and DOM change summary.",
    inputSchema: {
      type: "object",
      required: ["script"],
      properties: {
        ...commonTabProperties,
        script: { type: "string" },
        noMonitor: { type: "boolean" },
        settleMs: { type: "number" },
        returnByValue: { type: "boolean" },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_wait_for",
    description: "Wait until an element/text/URL condition appears or disappears.",
    inputSchema: {
      type: "object",
      properties: {
        ...commonTabProperties,
        selector: { type: "string" },
        text: { type: "string" },
        exact: { type: "boolean" },
        urlContains: { type: "string" },
        state: { type: "string", enum: ["visible", "hidden"] },
        timeoutMs: { type: "number" },
        intervalMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_scroll",
    description: "Scroll the selected page.",
    inputSchema: {
      type: "object",
      properties: {
        ...commonTabProperties,
        deltaX: { type: "number" },
        deltaY: { type: "number" },
        to: { type: "string", enum: ["top", "bottom"] },
      },
    },
  },
  {
    name: "browser_element_screenshot",
    description: "Capture a screenshot clipped to a Playwright-style located element.",
    inputSchema: {
      type: "object",
      properties: {
        ...commonTabProperties,
        selector: { type: "string" },
        text: { type: "string" },
        role: { type: "string" },
        name: { type: "string" },
        label: { type: "string" },
        placeholder: { type: "string" },
        alt: { type: "string" },
        title: { type: "string" },
        testId: { type: "string" },
        exact: { type: "boolean" },
        nth: { type: "number" },
        padding: { type: "number", description: "Extra pixels around the element clip." },
        path: { type: "string", description: "Output path under an allowed output root. Defaults to <output-root>/screenshots." },
        format: { type: "string", enum: ["png", "jpeg"] },
        quality: { type: "number" },
        includeData: { type: "boolean" },
        analyze: { type: "boolean", description: "Return brightness/color/nonblank statistics for the captured image." },
        sampleMax: { type: "number" },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_region_screenshot",
    description: "Capture a screenshot clipped to a viewport region.",
    inputSchema: {
      type: "object",
      properties: {
        ...commonTabProperties,
        clip: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            width: { type: "number" },
            height: { type: "number" },
            scale: { type: "number" },
          },
        },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        padding: { type: "number" },
        path: { type: "string" },
        format: { type: "string", enum: ["png", "jpeg"] },
        quality: { type: "number" },
        includeData: { type: "boolean" },
        analyze: { type: "boolean" },
        sampleMax: { type: "number" },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_visual_analyze",
    description: "Capture a page, element, or region screenshot and return visual statistics such as luminance, color bins, dominant colors, and nonblank score.",
    inputSchema: {
      type: "object",
      properties: {
        ...commonTabProperties,
        selector: { type: "string" },
        text: { type: "string" },
        role: { type: "string" },
        name: { type: "string" },
        label: { type: "string" },
        placeholder: { type: "string" },
        alt: { type: "string" },
        title: { type: "string" },
        testId: { type: "string" },
        exact: { type: "boolean" },
        nth: { type: "number" },
        clip: { type: "object" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        padding: { type: "number" },
        path: { type: "string", description: "Optional screenshot path to save the analyzed capture." },
        format: { type: "string", enum: ["png", "jpeg"] },
        quality: { type: "number" },
        sampleMax: { type: "number" },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_visual_compare",
    description: "Capture before/after screenshots around an optional actionScript and return pixel-difference statistics.",
    inputSchema: {
      type: "object",
      properties: {
        ...commonTabProperties,
        actionScript: { type: "string" },
        actionTimeoutMs: { type: "number" },
        settleMs: { type: "number" },
        beforePath: { type: "string" },
        afterPath: { type: "string" },
        format: { type: "string", enum: ["png", "jpeg"] },
        quality: { type: "number" },
        sampleMax: { type: "number" },
        diffThreshold: { type: "number" },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_screenshot",
    description: "Capture a screenshot and save it to disk.",
    inputSchema: {
      type: "object",
      properties: {
        ...commonTabProperties,
        path: { type: "string", description: "Output path. Defaults to browser-control-mcp/screenshots." },
        fullPage: { type: "boolean" },
        format: { type: "string", enum: ["png", "jpeg"] },
        quality: { type: "number", description: "JPEG quality 1-100." },
        includeData: { type: "boolean", description: "Also return image data in the MCP response." },
        timeoutMs: { type: "number" },
      },
    },
  },
];

async function callToolInner(name, args) {
  switch (name) {
    case "browser_trace_start": return toolBrowserTraceStart(args);
    case "browser_trace_status": return toolBrowserTraceStatus(args);
    case "browser_trace_stop": return toolBrowserTraceStop(args);
    case "browser_trace_export": return toolBrowserTraceExport(args);
    case "browser_start": return toolBrowserStart(args);
    case "browser_status": return toolBrowserStatus(args);
    case "browser_stop": return toolBrowserStop(args);
    case "browser_list_tabs": return toolBrowserListTabs(args);
    case "browser_extension_status": return toolBrowserExtensionStatus(args);
    case "browser_extension_list_tabs": return toolBrowserExtensionListTabs(args);
    case "browser_extension_repair": return toolBrowserExtensionRepair(args);
    case "browser_extension_scan": return toolBrowserExtensionScan(args);
    case "browser_extension_execute_js": return toolBrowserExtensionExecuteJs(args);
    case "browser_extension_command": return toolBrowserExtensionCommand(args);
    case "browser_open": return toolBrowserOpen(args);
    case "browser_activate": return toolBrowserActivate(args);
    case "browser_close": return toolBrowserClose(args);
    case "browser_wait_for_new_tab": return toolBrowserWaitForNewTab(args);
    case "browser_dialog": return toolBrowserDialog(args);
    case "browser_set_download_behavior": return toolBrowserSetDownloadBehavior(args);
    case "browser_wait_for_download": return toolBrowserWaitForDownload(args);
    case "browser_grant_permissions": return toolBrowserGrantPermissions(args);
    case "browser_reset_permissions": return toolBrowserResetPermissions(args);
    case "browser_playwright_status": return toolBrowserPlaywrightStatus(args);
    case "browser_playwright_start": return toolBrowserPlaywrightStart(args);
    case "browser_playwright_open": return toolBrowserPlaywrightOpen(args);
    case "browser_playwright_click": return toolBrowserPlaywrightClick(args);
    case "browser_playwright_type": return toolBrowserPlaywrightType(args);
    case "browser_playwright_screenshot": return toolBrowserPlaywrightScreenshot(args);
    case "browser_playwright_stop": return toolBrowserPlaywrightStop(args);
    case "browser_snapshot": return toolBrowserSnapshot(args);
    case "browser_accessibility_snapshot": return toolBrowserAccessibilitySnapshot(args);
    case "browser_page_diagnostics": return toolBrowserPageDiagnostics(args);
    case "browser_scan": return toolBrowserScan(args);
    case "browser_locator_find": return toolBrowserLocatorFind(args);
    case "browser_actionability_check": return toolBrowserActionabilityCheck(args);
    case "browser_locator_click": return toolBrowserLocatorClick(args);
    case "browser_locator_type": return toolBrowserLocatorType(args);
    case "browser_click": return toolBrowserClick(args);
    case "browser_type": return toolBrowserType(args);
    case "browser_eval": return toolBrowserEval(args);
    case "browser_cdp": return toolBrowserCdp(args);
    case "browser_cdp_batch": return toolBrowserCdpBatch(args);
    case "browser_cookies": return toolBrowserCookies(args);
    case "browser_set_file_input_files": return toolBrowserSetFileInputFiles(args);
    case "browser_iframe_eval": return toolBrowserIframeEval(args);
    case "browser_dom_pierce": return toolBrowserDomPierce(args);
    case "browser_generic_command": return toolBrowserGenericCommand(args);
    case "browser_execute_js_rich": return toolBrowserExecuteJsRich(args);
    case "browser_wait_for": return toolBrowserWaitFor(args);
    case "browser_scroll": return toolBrowserScroll(args);
    case "browser_element_screenshot": return toolBrowserElementScreenshot(args);
    case "browser_region_screenshot": return toolBrowserRegionScreenshot(args);
    case "browser_visual_analyze": return toolBrowserVisualAnalyze(args);
    case "browser_visual_compare": return toolBrowserVisualCompare(args);
    case "browser_screenshot": return toolBrowserScreenshot(args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

async function callTool(name, args = {}) {
  const step = beginTraceStep(name, args);
  let result;
  let caughtError;
  try {
    result = await callToolInner(name, args);
    return result;
  } catch (error) {
    caughtError = error;
    throw error;
  } finally {
    await finishTraceStep(step, result, caughtError);
  }
}

async function handleRequest(message) {
  const { id, method, params } = message;
  if (!method) return rpcError(id, -32600, "Invalid request: missing method");
  if (method.startsWith("notifications/")) return;

  try {
    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      });
      return;
    }
    if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools } });
      return;
    }
    if (method === "tools/call") {
      const result = await callTool(params?.name, params?.arguments || {});
      send({ jsonrpc: "2.0", id, result });
      return;
    }
    if (method === "resources/list") {
      send({ jsonrpc: "2.0", id, result: { resources: [] } });
      return;
    }
    if (method === "prompts/list") {
      send({ jsonrpc: "2.0", id, result: { prompts: [] } });
      return;
    }
    rpcError(id, -32601, `Method not found: ${method}`);
  } catch (error) {
    const result = toolError(error.message);
    send({ jsonrpc: "2.0", id, result });
  }
}

assertExtensionBridgeConfiguration();
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
startExtensionBridge();
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch (error) {
    rpcError(null, -32700, `Parse error: ${error.message}`);
    return;
  }
  handleRequest(message).catch((error) => rpcError(message.id, -32603, error.message));
});

process.on("uncaughtException", (error) => {
  console.error(`[${SERVER_NAME}] uncaughtException`, error);
});

process.on("unhandledRejection", (error) => {
  console.error(`[${SERVER_NAME}] unhandledRejection`, error);
});
