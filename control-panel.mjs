import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8320;
const APP_TITLE = "Codex 飞书 Bridge 新设备控制面板";

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const runtimeRoot = path.join(localAppData, "CodexFeishuBridge");
const panelRoot = path.join(runtimeRoot, "control-panel");
const panelStateDir = path.join(panelRoot, "state");
const panelLogDir = path.join(panelRoot, "logs");
const panelPidFile = path.join(panelStateDir, "control-panel.pid");
const codexConfigPath = path.join(os.homedir(), ".codex", "config.toml");
const staticRoot = path.join(__dirname, "control-panel");
const instancesConfigPath = path.join(__dirname, "bridge.instances.json");
const doctorScript = path.join(__dirname, "doctor-codex-feishu-bridge.ps1");
const startBridgeScript = path.join(__dirname, "start-codex-feishu-bridge.ps1");
const stopBridgeScript = path.join(__dirname, "stop-codex-feishu-bridge.ps1");

function getArg(name, fallback) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

const host = getArg("host", process.env.CODEX_FEISHU_PANEL_HOST || DEFAULT_HOST);
const port = Number(getArg("port", process.env.CODEX_FEISHU_PANEL_PORT || DEFAULT_PORT));

function fallbackInstancesConfig() {
  const instances = [
    {
      id: "default",
      name: "default",
      label: "默认 Bot",
      runtimeRoot,
      workspace: path.join(os.homedir(), "Documents", "Codex", "workspaces", "feishu-bridge"),
      codexHome: path.join(os.homedir(), ".codex"),
      desktopCodexHome: "",
      larkProfile: "default",
      taskName: "CodexFeishuBridgeWatchdog",
    },
  ];

  for (let index = 1; index <= 9; index += 1) {
    const name = `codex-assistant-${index}`;
    instances.push({
      id: name,
      name,
      label: `Codex 助手 ${index}`,
      runtimeRoot: path.join(runtimeRoot, "instances", name),
      workspace: path.join(os.homedir(), "Documents", "Codex", "workspaces", `feishu-bridge-${name}`),
      codexHome: path.join(os.homedir(), ".codex"),
      desktopCodexHome: "",
      larkProfile: name,
      taskName: `CodexFeishuBridgeWatchdog-${name}`,
    });
  }

  return {
    schemaVersion: 1,
    device: {
      id: "fallback",
      name: "当前设备",
      description: "控制面板内置兼容配置。",
    },
    paths: {
      sourceRoot: __dirname,
      runtimeRoot,
      workspaceRoot: path.join(os.homedir(), "Documents", "Codex", "workspaces"),
      codexHome: path.join(os.homedir(), ".codex"),
      codexConfig: codexConfigPath,
    },
    controlPanel: {
      title: APP_TITLE,
      host,
      port,
      url: `http://${host}:${port}/`,
      taskName: "CodexFeishuBridgeControlPanel",
      startScript: path.join(__dirname, "start-control-panel.ps1"),
      stopScript: path.join(__dirname, "stop-control-panel.ps1"),
      pidFile: panelPidFile,
      logDir: panelLogDir,
    },
    proxies: [
      {
        id: "mimo2codex",
        label: "mimo2codex 官方 DeepSeek 路由",
        port: 8788,
        url: "http://127.0.0.1:8788/v1",
        note: "用于官方 DeepSeek，以及可选 Kimi / GLM generic provider。",
      },
      {
        id: "mimo2codex-apideepseek",
        label: "mimo2codex API DeepSeek 独立路由",
        port: 8789,
        url: "http://127.0.0.1:8789/v1",
        note: "用于 apideepseek.com 非官方渠道，和官方 DeepSeek 路由隔离。",
      },
    ],
    instances,
  };
}

function normalizeInstancesConfig(config) {
  const fallback = fallbackInstancesConfig();
  if (!config || typeof config !== "object") return fallback;
  const instances = Array.isArray(config.instances) && config.instances.length ? config.instances : fallback.instances;
  const proxies = Array.isArray(config.proxies) && config.proxies.length ? config.proxies : fallback.proxies;
  return {
    ...fallback,
    ...config,
    paths: {
      ...fallback.paths,
      ...(config.paths || {}),
    },
    controlPanel: {
      ...fallback.controlPanel,
      ...(config.controlPanel || {}),
    },
    proxies,
    instances: instances.map((item) => ({
      id: item.id || item.name,
      name: item.name || item.id,
      label: item.label || item.name || item.id,
      runtimeRoot: item.runtimeRoot,
      workspace: item.workspace || "",
      codexHome: item.codexHome || path.join(os.homedir(), ".codex"),
      desktopCodexHome: item.desktopCodexHome || "",
      larkProfile: item.larkProfile || item.name || item.id,
      taskName: item.taskName || `CodexFeishuBridgeWatchdog-${item.name || item.id}`,
    })).filter((item) => item.id && item.name && item.runtimeRoot && item.taskName),
  };
}

function loadInstancesConfig() {
  const fallback = normalizeInstancesConfig(fallbackInstancesConfig());
  if (!existsSync(instancesConfigPath)) {
    return {
      ...fallback,
      _source: {
        path: instancesConfigPath,
        exists: false,
        loaded: false,
        fallback: true,
        error: "bridge.instances.json not found",
      },
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(instancesConfigPath, "utf8"));
    return {
      ...normalizeInstancesConfig(parsed),
      _source: {
        path: instancesConfigPath,
        exists: true,
        loaded: true,
        fallback: false,
        error: "",
      },
    };
  } catch (error) {
    return {
      ...fallback,
      _source: {
        path: instancesConfigPath,
        exists: true,
        loaded: false,
        fallback: true,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function instanceDescriptors(config = loadInstancesConfig()) {
  return config.instances || [];
}

function jsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function textResponse(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readTextFile(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function readJsonFile(filePath) {
  const text = await readTextFile(filePath);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readRequestJson(req, maxBytes = 64_000) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error("请求体过大");
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function requireString(value, field, maxLength = 240) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${field} 不能为空`);
  if (text.length > maxLength) throw new Error(`${field} 太长`);
  return text;
}

function validateProviderPayload(payload) {
  const id = requireString(payload.id, "provider id", 80);
  if (!/^[A-Za-z0-9_.-]+$/.test(id)) {
    throw new Error("provider id 只能包含英文字母、数字、下划线、点和短横线");
  }

  const name = requireString(payload.name || payload.id, "name", 160);
  const baseUrl = requireString(payload.baseUrl, "base_url", 500).replace(/\/+$/, "");
  let parsedUrl;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new Error("base_url 不是合法 URL");
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("base_url 只支持 http 或 https");
  }

  const envKey = requireString(payload.envKey, "env_key", 120);
  if (!/^[A-Z][A-Z0-9_]*$/.test(envKey)) {
    throw new Error("env_key 必须是大写环境变量名，例如 SUB2API_API_KEY");
  }

  const wireApi = String(payload.wireApi || "responses").trim();
  if (wireApi !== "responses") {
    throw new Error("第一版添加向导只支持 GPT / Responses 兼容 provider");
  }

  return {
    id,
    name,
    baseUrl,
    wireApi,
    envKey,
  };
}

function redactTomlString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function providerTomlBlock(provider) {
  return [
    "",
    `[model_providers.${provider.id}]`,
    `name = "${redactTomlString(provider.name)}"`,
    `base_url = "${redactTomlString(provider.baseUrl)}"`,
    `wire_api = "${redactTomlString(provider.wireApi)}"`,
    `env_key = "${redactTomlString(provider.envKey)}"`,
    "",
  ].join("\n");
}

async function ensureProviderCanBeAdded(provider) {
  const config = await readCodexConfig();
  if (config.providers.some((item) => item.id === provider.id)) {
    throw new Error(`provider 已存在：${provider.id}`);
  }
  if (!process.env[provider.envKey]) {
    throw new Error(`当前控制面板进程看不到环境变量 ${provider.envKey}。请先设置用户环境变量，再重启控制面板。`);
  }
  return config;
}

async function appendProviderToConfig(provider) {
  await ensureProviderCanBeAdded(provider);
  const currentText = (await readTextFile(codexConfigPath)) || "";
  const nextText = `${currentText.replace(/\s*$/, "\n")}${providerTomlBlock(provider)}`;
  await writeFile(codexConfigPath, nextText, "utf8");
  return readCodexConfig();
}

async function providerModels(provider) {
  const key = process.env[provider.envKey];
  if (!key) throw new Error(`当前控制面板进程看不到环境变量 ${provider.envKey}`);
  const response = await fetch(`${provider.baseUrl}/models`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${key}`,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GET /models 失败：HTTP ${response.status} ${text.slice(0, 240)}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("GET /models 返回的不是 JSON");
  }
  const data = Array.isArray(payload.data) ? payload.data : [];
  return data.map((item) => ({
    id: item.id || "",
    ownedBy: item.owned_by || item.ownedBy || "",
    object: item.object || "",
  })).filter((item) => item.id);
}

async function providerResponsesTest(provider, model) {
  const key = process.env[provider.envKey];
  if (!key) throw new Error(`当前控制面板进程看不到环境变量 ${provider.envKey}`);
  const started = Date.now();
  const response = await fetch(`${provider.baseUrl}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: "ping",
      max_output_tokens: 8,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`POST /responses 失败：HTTP ${response.status} ${text.slice(0, 300)}`);
  }
  let payload = {};
  try {
    payload = JSON.parse(text);
  } catch {
    // Some compatible providers may not return strict JSON on success.
  }
  return {
    ok: true,
    elapsedMs: Date.now() - started,
    responseId: payload.id || "",
  };
}

async function readTail(filePath, maxBytes = 160_000) {
  try {
    const info = await stat(filePath);
    const start = Math.max(0, info.size - maxBytes);
    const handle = await import("node:fs/promises").then((fs) => fs.open(filePath, "r"));
    try {
      const buffer = Buffer.alloc(info.size - start);
      await handle.read(buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

function parsePid(text) {
  const trimmed = String(text || "").trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

function fromEpochMs(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) return null;
  try {
    return new Date(numberValue).toISOString();
  } catch {
    return null;
  }
}

function getActiveRuns(activeState) {
  const runs = activeState?.runs;
  if (!runs || typeof runs !== "object") return [];
  return Object.values(runs)
    .filter(Boolean)
    .map((run) => ({
      messageId: run.messageId || "",
      chatId: run.chatId || "",
      sessionId: run.sessionId || "",
      startedAt: fromEpochMs(run.startedAt),
      updatedAt: fromEpochMs(run.updatedAt),
      bridgePid: run.bridgePid || null,
      workspace: run.workspace || "",
    }));
}

function parseWatchdog(tailText) {
  const lines = tailText.split(/\r?\n/).filter(Boolean);
  const lastLine = lines.at(-1) || "";
  const healthy = /\bhealthy\b/i.test(lastLine);
  const consumerMatch = lastLine.match(/consumer\s+([^#\s]+)#(\d+)/i);
  const bridgePidMatch = lastLine.match(/bridgePid=(\d+)/i);

  return {
    healthy,
    lastLine,
    lastAt: (lastLine.match(/^(\S+)/) || [])[1] || "",
    consumer: consumerMatch
      ? {
          eventKey: consumerMatch[1],
          pid: Number(consumerMatch[2]),
        }
      : null,
    bridgePid: bridgePidMatch ? Number(bridgePidMatch[1]) : null,
  };
}

function parseLastRunSettings(tailText) {
  const lines = tailText.split(/\r?\n/).filter(Boolean).reverse();
  for (const line of lines) {
    if (!line.includes("starting codex app-server turn")) continue;
    const jsonStart = line.indexOf("{");
    if (jsonStart < 0) continue;
    try {
      const payload = JSON.parse(line.slice(jsonStart));
      return {
        provider: payload.provider || "",
        model: payload.model || "",
        reasoning: payload.reasoning || "",
        serviceTier: payload.serviceTier || "",
        sessionId: payload.sessionId || "",
        threadId: payload.existingThreadId || "",
        at: line.slice(0, 24).trim(),
      };
    } catch {
      return null;
    }
  }
  return null;
}

function parseLogJsonLine(line) {
  const jsonStart = line.indexOf("{");
  if (jsonStart < 0) return null;
  try {
    return JSON.parse(line.slice(jsonStart));
  } catch {
    return null;
  }
}

function parseLastLogEvent(tailText, eventText) {
  const lines = tailText.split(/\r?\n/).filter(Boolean).reverse();
  for (const line of lines) {
    if (!line.includes(eventText)) continue;
    return {
      at: line.slice(0, 24).trim(),
      line: line.slice(0, 900),
      payload: parseLogJsonLine(line),
    };
  }
  return null;
}

function parseRecentProblems(tailText) {
  const lines = tailText.split(/\r?\n/).filter(Boolean);
  const problemLines = lines.filter((line) =>
    /\b(ERROR|WARN)\b|failed|失败|502|unknown error|未知错误|exception/i.test(line),
  );
  return problemLines.slice(-5).map((line) => line.slice(0, 600));
}

function parseTomlValue(line) {
  const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*$/);
  if (!match) return null;
  let value = match[2].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return [match[1], value];
}

async function readCodexConfig() {
  const text = await readTextFile(codexConfigPath);
  const result = {
    path: codexConfigPath,
    exists: Boolean(text),
    model: "",
    provider: "",
    reasoning: "",
    serviceTier: "",
    providers: [],
  };
  if (!text) return result;

  let currentProvider = null;
  for (const line of text.split(/\r?\n/)) {
    const providerHeader = line.match(/^\s*\[model_providers\.([^\]]+)\]\s*$/);
    if (providerHeader) {
      currentProvider = {
        id: providerHeader[1],
        name: providerHeader[1],
        baseUrl: "",
        wireApi: "",
        envKey: "",
        envVisible: false,
      };
      result.providers.push(currentProvider);
      continue;
    }

    const tableHeader = line.match(/^\s*\[/);
    if (tableHeader && !providerHeader) {
      currentProvider = null;
    }

    const parsed = parseTomlValue(line);
    if (!parsed) continue;
    const [key, value] = parsed;

    if (currentProvider) {
      if (key === "name") currentProvider.name = value;
      if (key === "base_url") currentProvider.baseUrl = value;
      if (key === "wire_api") currentProvider.wireApi = value;
      if (key === "env_key") {
        currentProvider.envKey = value;
        currentProvider.envVisible = Boolean(process.env[value]);
      }
      continue;
    }

    if (key === "model") result.model = value;
    if (key === "model_provider") result.provider = value;
    if (key === "model_reasoning_effort") result.reasoning = value;
    if (key === "service_tier") result.serviceTier = value;
  }

  return result;
}

function runPowerShell(script, timeoutMs = 12_000) {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            error: error.message,
            stderr,
            stdout,
            processes: [],
            tasks: [],
            ports: [],
          });
          return;
        }
        try {
          const parsed = JSON.parse(stdout || "{}");
          resolve({ ok: true, ...parsed });
        } catch (parseError) {
          resolve({
            ok: false,
            error: parseError.message,
            stderr,
            stdout,
            processes: [],
            tasks: [],
            ports: [],
          });
        }
      },
    );
  });
}

async function getSystemSnapshot() {
  const script = `
$ErrorActionPreference = "SilentlyContinue"
$procRows = @()
$processInfos = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe' OR Name='pwsh.exe' OR Name='wscript.exe'" -ErrorAction SilentlyContinue
foreach ($item in @($processInfos)) {
  $commandLine = [string]$item.CommandLine
  if ($commandLine -notlike "*codex-feishu-bridge*" -and $commandLine -notlike "*mimo2codex*" -and $commandLine -notlike "*control-panel.mjs*") {
    continue
  }
  $processIdValue = [int]$item.ProcessId
  $processObject = Get-Process -Id $processIdValue -ErrorAction SilentlyContinue
  $startTimeValue = $null
  if ($processObject) {
    try { $startTimeValue = $processObject.StartTime.ToString("o") } catch {}
  }
  $procRows += [pscustomobject]@{
    processId = $processIdValue
    name = [string]$item.Name
    startTime = $startTimeValue
    commandLine = $commandLine
  }
}

$taskRows = @()
$taskInfos = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
  $_.TaskName -like "CodexFeishuBridgeWatchdog*" -or $_.TaskName -eq "Mimo2CodexProxyWatchdog"
}
foreach ($task in @($taskInfos)) {
  $taskRows += [pscustomobject]@{
    taskName = [string]$task.TaskName
    state = [string]$task.State
  }
}

$portRows = @()
$connections = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort 8788,8789,8320 -ErrorAction SilentlyContinue
foreach ($connection in @($connections)) {
  $portRows += [pscustomobject]@{
    localAddress = [string]$connection.LocalAddress
    localPort = [int]$connection.LocalPort
    state = [string]$connection.State
    owningProcess = [int]$connection.OwningProcess
  }
}

[pscustomobject]@{
  processes = $procRows
  tasks = $taskRows
  ports = $portRows
} | ConvertTo-Json -Depth 6
`;
  return runPowerShell(script);
}

function processMap(systemSnapshot) {
  const map = new Map();
  for (const item of systemSnapshot.processes || []) {
    map.set(Number(item.processId), item);
  }
  return map;
}

function taskMap(systemSnapshot) {
  const map = new Map();
  for (const item of systemSnapshot.tasks || []) {
    map.set(item.taskName, item);
  }
  return map;
}

async function fileInfo(filePath) {
  try {
    const info = await stat(filePath);
    return {
      path: filePath,
      exists: true,
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
    };
  } catch {
    return {
      path: filePath,
      exists: false,
      size: null,
      modifiedAt: "",
    };
  }
}

function buildPaths(descriptor, stateDir, logDir, launchConfig, lockInfo) {
  const workspace = launchConfig.workspace || lockInfo.workspace || "";
  const codexHome = launchConfig.codexHome || lockInfo.codexHome || path.join(os.homedir(), ".codex");
  const desktopCodexHome = launchConfig.desktopCodexHome || "";
  const visibleCodexHome = desktopCodexHome || codexHome;

  return {
    runtimeRoot: descriptor.runtimeRoot,
    stateDir,
    logDir,
    workspace,
    codexHome,
    desktopCodexHome,
    visibleCodexHome,
    bridgePidFile: path.join(stateDir, "bridge.pid"),
    bridgeLockFile: path.join(stateDir, "bridge.lock.json"),
    launchConfigFile: path.join(stateDir, "launch-config.json"),
    activeRunsFile: path.join(stateDir, "active-runs.json"),
    sessionsFile: path.join(stateDir, "sessions.json"),
    seenEventsFile: path.join(stateDir, "seen-events.json"),
    watchdogLogFile: path.join(logDir, "watchdog.log"),
    bridgeLogFile: path.join(logDir, "codex-feishu-bridge.log"),
    stdoutLogFile: path.join(logDir, "bridge.stdout.log"),
    stderrLogFile: path.join(logDir, "bridge.stderr.log"),
    codexConfigFile: path.join(codexHome, "config.toml"),
    codexStateDbFile: path.join(visibleCodexHome, "state_5.sqlite"),
    codexSessionIndexFile: path.join(visibleCodexHome, "session_index.jsonl"),
    codexGlobalStateFile: path.join(visibleCodexHome, ".codex-global-state.json"),
    codexSessionsDir: path.join(visibleCodexHome, "sessions"),
    startScript: path.join(__dirname, "start-codex-feishu-bridge.ps1"),
    stopScript: path.join(__dirname, "stop-codex-feishu-bridge.ps1"),
    watchdogScript: path.join(__dirname, "watch-codex-feishu-bridge.ps1"),
    watchdogInstallScript: path.join(__dirname, "install-codex-feishu-watchdog.ps1"),
    watchdogTaskName: descriptor.taskName,
  };
}

async function buildSidebarStatus(bridgeLogTail, paths) {
  const registered = parseLastLogEvent(bridgeLogTail, "codex thread registered in target Codex home");
  const synced = parseLastLogEvent(bridgeLogTail, "codex desktop sidebar index synced");
  const reconciled = parseLastLogEvent(bridgeLogTail, "codex desktop sidebar indexes reconciled");
  const files = {
    stateDb: await fileInfo(paths.codexStateDbFile),
    sessionIndex: await fileInfo(paths.codexSessionIndexFile),
    globalState: await fileInfo(paths.codexGlobalStateFile),
    sessionsDir: await fileInfo(paths.codexSessionsDir),
  };

  const hasRecentActivity = Boolean(registered || synced || reconciled);
  const hasFiles = files.stateDb.exists && files.sessionIndex.exists && files.sessionsDir.exists;
  const hasSyncError = /sidebar.*(failed|error)|EPERM|lock/i.test(bridgeLogTail);
  let status = "无近期任务";
  let level = "info";
  let note = "当前 Bot 最近没有创建或继续 Codex thread。";

  if (hasRecentActivity && hasFiles) {
    status = "正常";
    level = "good";
    note = "最近有 thread 注册、索引同步或索引校验记录，且关键索引文件存在。";
  } else if (!hasFiles) {
    status = "索引文件不完整";
    level = "warn";
    note = "Codex Desktop 侧边栏所需的关键索引文件或 sessions 目录缺失。";
  } else if (hasSyncError) {
    status = "历史有同步告警";
    level = "warn";
    note = "最近日志片段包含 sidebar/lock/EPERM 关键词，但没有新的成功同步记录覆盖它。";
  }

  return {
    status,
    level,
    source: "Bridge 日志 + Codex Home 索引文件",
    visibleCodexHome: paths.visibleCodexHome,
    registered,
    synced,
    reconciled,
    note,
    files,
  };
}

async function readInstanceStatus(descriptor, system, codexConfig) {
  const stateDir = path.join(descriptor.runtimeRoot, "state");
  const logDir = path.join(descriptor.runtimeRoot, "logs");
  const pid = parsePid(await readTextFile(path.join(stateDir, "bridge.pid")));
  const lock = await readJsonFile(path.join(stateDir, "bridge.lock.json"));
  const launch = await readJsonFile(path.join(stateDir, "launch-config.json"));
  const activeRuns = getActiveRuns(await readJsonFile(path.join(stateDir, "active-runs.json")));
  const watchdogTail = await readTail(path.join(logDir, "watchdog.log"), 40_000);
  const bridgeLogTail = await readTail(path.join(logDir, "codex-feishu-bridge.log"), 240_000);
  const processInfo = pid ? system.processesByPid.get(pid) : null;
  const task = system.tasksByName.get(descriptor.taskName) || null;
  const watchdog = parseWatchdog(watchdogTail);
  const lastRun = parseLastRunSettings(bridgeLogTail);
  const problems = parseRecentProblems(bridgeLogTail);
  const launchConfig = launch || {};
  const lockInfo = lock || {};
  const paths = buildPaths(descriptor, stateDir, logDir, launchConfig, lockInfo);
  const sidebar = await buildSidebarStatus(bridgeLogTail, paths);

  return {
    id: descriptor.id,
    name: descriptor.name,
    label: descriptor.label,
    runtimeRoot: descriptor.runtimeRoot,
    stateDir,
    logDir,
    pid,
    online: Boolean(processInfo),
    processName: processInfo?.name || "",
    processStartTime: processInfo?.startTime || fromEpochMs(lockInfo.startedAt),
    launchUpdatedAt: launchConfig.updatedAt || "",
    workspace: launchConfig.workspace || lockInfo.workspace || "",
    codexHome: launchConfig.codexHome || lockInfo.codexHome || "",
    desktopCodexHome: launchConfig.desktopCodexHome || "",
    larkProfile: launchConfig.larkProfile || lockInfo.larkProfile || "",
    activeRunCount: activeRuns.length,
    activeRuns,
    task: task
      ? {
          name: task.taskName,
          state: task.state,
        }
      : {
          name: descriptor.taskName,
          state: "未找到",
    },
    watchdog,
    paths,
    sidebar,
    lastRun: lastRun || {
      provider: codexConfig.provider,
      model: codexConfig.model,
      reasoning: codexConfig.reasoning,
      serviceTier: codexConfig.serviceTier,
      sessionId: "",
      threadId: "",
      at: "",
    },
    recentProblems: problems,
  };
}

async function listRuntimeDirectories() {
  const rootItems = [];
  try {
    const entries = await readdir(runtimeRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) rootItems.push(entry.name);
    }
  } catch {
    // Runtime directory can be missing before the first bridge launch.
  }
  return rootItems.sort();
}

function proxyStatus(systemSnapshot, configuredProxies = null) {
  const byPort = new Map();
  for (const item of systemSnapshot.ports || []) {
    if (item.state === "Listen") {
      byPort.set(Number(item.localPort), item);
    }
  }

  const source = Array.isArray(configuredProxies) && configuredProxies.length
    ? configuredProxies
    : fallbackInstancesConfig().proxies;

  return source.map((proxy) => {
    const portValue = Number(proxy.port);
    return {
      id: proxy.id,
      label: proxy.label,
      port: portValue,
      url: proxy.url,
      online: byPort.has(portValue),
      owningProcess: byPort.get(portValue)?.owningProcess || null,
      note: proxy.note || "",
    };
  });
}

function scriptArgsForInstance(instanceName) {
  if (!instanceName || instanceName === "default") return [];
  return ["-Name", instanceName];
}

function runScript(filePath, args = [], timeoutMs = 60_000) {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-File", filePath, ...args],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          exitCode: error?.code ?? 0,
          error: error ? error.message : "",
          stdout,
          stderr,
        });
      },
    );
  });
}

async function runDoctorReport() {
  const result = await runScript(doctorScript, ["-Json"], 45_000);
  if (!result.ok) {
    return {
      ok: false,
      error: result.error || result.stderr || "doctor script failed",
      stdout: result.stdout,
      stderr: result.stderr,
      script: doctorScript,
    };
  }

  try {
    return {
      ...JSON.parse(result.stdout || "{}"),
      script: doctorScript,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stdout: result.stdout,
      stderr: result.stderr,
      script: doctorScript,
    };
  }
}

async function getInstanceDescriptorByName(name) {
  const descriptor = instanceDescriptors().find((item) => item.name === name || item.id === name);
  if (!descriptor) throw new Error(`未知 Bot：${name}`);
  return descriptor;
}

async function readPidForDescriptor(descriptor) {
  const pidPath = path.join(descriptor.runtimeRoot, "state", "bridge.pid");
  return parsePid(await readTextFile(pidPath));
}

async function hasActiveRun(descriptor) {
  const activeFile = path.join(descriptor.runtimeRoot, "state", "active-runs.json");
  const runs = getActiveRuns(await readJsonFile(activeFile));
  return {
    count: runs.length,
    file: activeFile,
  };
}

async function restartIdleInstance(name) {
  const descriptor = await getInstanceDescriptorByName(name);
  const active = await hasActiveRun(descriptor);
  const beforePid = await readPidForDescriptor(descriptor);
  if (active.count > 0) {
    return {
      name: descriptor.name,
      action: "skipped",
      reason: `当前有 ${active.count} 个 active run，已跳过`,
      beforePid,
      afterPid: beforePid,
      activeRuns: active.count,
    };
  }

  const args = scriptArgsForInstance(descriptor.name);
  const stopResult = await runScript(stopBridgeScript, args, 60_000);
  if (!stopResult.ok) {
    return {
      name: descriptor.name,
      action: "failed",
      reason: "停止 Bridge 失败",
      beforePid,
      afterPid: await readPidForDescriptor(descriptor),
      activeRuns: 0,
      stopResult,
    };
  }

  const startResult = await runScript(startBridgeScript, args, 60_000);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const afterPid = await readPidForDescriptor(descriptor);
  return {
    name: descriptor.name,
    action: startResult.ok && afterPid ? "restarted" : "failed",
    reason: startResult.ok && afterPid ? "已重启并写入 PID" : "启动后未确认到 PID",
    beforePid,
    afterPid,
    pidChanged: Boolean(beforePid && afterPid && beforePid !== afterPid),
    activeRuns: 0,
    stopResult,
    startResult,
  };
}

async function restartIdleInstances(names) {
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error("请至少选择一个 Bot");
  }
  const targetNames = names;
  const results = [];
  for (const name of targetNames) {
    results.push(await restartIdleInstance(name));
  }
  return {
    results,
    summary: {
      restarted: results.filter((item) => item.action === "restarted").length,
      skipped: results.filter((item) => item.action === "skipped").length,
      failed: results.filter((item) => item.action === "failed").length,
      total: results.length,
    },
  };
}

async function readProxyLog() {
  const logRoot = path.join(runtimeRoot, "mimo2codex-proxies", "logs");
  const candidates = [
    path.join(logRoot, "mimo2codex-proxies.log"),
    path.join(logRoot, "proxy-watchdog.log"),
    path.join(logRoot, "watchdog.log"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return {
        path: candidate,
        tail: (await readTail(candidate, 60_000)).split(/\r?\n/).filter(Boolean).slice(-20),
      };
    }
  }

  return {
    path: logRoot,
    tail: [],
  };
}

function summarize(instances, proxies, tasks) {
  const online = instances.filter((item) => item.online).length;
  const activeRuns = instances.reduce((sum, item) => sum + item.activeRunCount, 0);
  const unhealthyWatchdogs = instances.filter((item) => !item.watchdog.healthy).length;
  const missingTasks = tasks.filter((item) => item.state === "未找到").length;
  const proxiesOnline = proxies.filter((item) => item.online).length;

  return {
    totalBots: instances.length,
    onlineBots: online,
    offlineBots: instances.length - online,
    activeRuns,
    unhealthyWatchdogs,
    missingTasks,
    proxiesOnline,
    totalProxies: proxies.length,
  };
}

async function gatherStatus() {
  const instancesConfig = loadInstancesConfig();
  const [systemSnapshot, codexConfig, runtimeDirectories, proxyLog] = await Promise.all([
    getSystemSnapshot(),
    readCodexConfig(),
    listRuntimeDirectories(),
    readProxyLog(),
  ]);

  const system = {
    ...systemSnapshot,
    processesByPid: processMap(systemSnapshot),
    tasksByName: taskMap(systemSnapshot),
  };

  const descriptors = instanceDescriptors(instancesConfig);
  const instances = [];
  for (const descriptor of descriptors) {
    instances.push(await readInstanceStatus(descriptor, system, codexConfig));
  }

  const proxies = proxyStatus(systemSnapshot, instancesConfig.proxies);
  const bridgeTasks = instances.map((instance) => instance.task);
  const proxyTask =
    system.tasksByName.get("Mimo2CodexProxyWatchdog") || {
      taskName: "Mimo2CodexProxyWatchdog",
      state: "未找到",
    };

  return {
    title: APP_TITLE,
    generatedAt: new Date().toISOString(),
    host,
    port,
    runtimeRoot,
    configSource: instancesConfig._source,
    instancesConfig: {
      schemaVersion: instancesConfig.schemaVersion,
      device: instancesConfig.device,
      paths: instancesConfig.paths,
      controlPanel: instancesConfig.controlPanel,
      instanceCount: descriptors.length,
      proxyCount: instancesConfig.proxies?.length || 0,
    },
    codexConfig,
    runtimeDirectories,
    instances,
    proxies,
    proxyLog,
    tasks: {
      bridge: bridgeTasks,
      proxy: {
        name: proxyTask.taskName,
        state: proxyTask.state,
      },
    },
    summary: summarize(instances, proxies, [...bridgeTasks, proxyTask]),
    diagnostics: {
      systemSnapshotOk: Boolean(systemSnapshot.ok),
      systemSnapshotError: systemSnapshot.ok ? "" : systemSnapshot.error || "PowerShell snapshot failed",
    },
  };
}

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
]);

async function serveStatic(req, res, url) {
  const relativePath = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const targetPath = path.resolve(staticRoot, relativePath);
  const rootWithSeparator = path.resolve(staticRoot) + path.sep;
  if (!targetPath.startsWith(rootWithSeparator) && targetPath !== path.resolve(staticRoot, "index.html")) {
    textResponse(res, 403, "Forbidden");
    return;
  }

  try {
    const body = await readFile(targetPath);
    const type = contentTypes.get(path.extname(targetPath).toLowerCase()) || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    textResponse(res, 404, "Not found");
  }
}

async function requestHandler(req, res) {
  const url = new URL(req.url || "/", `http://${host}:${port}`);
  if (url.pathname === "/api/health") {
    jsonResponse(res, 200, {
      ok: true,
      title: APP_TITLE,
      generatedAt: new Date().toISOString(),
    });
    return;
  }

  if (url.pathname === "/api/status") {
    try {
      jsonResponse(res, 200, await gatherStatus());
    } catch (error) {
      jsonResponse(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (url.pathname === "/api/doctor") {
    try {
      jsonResponse(res, 200, await runDoctorReport());
    } catch (error) {
      jsonResponse(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        script: doctorScript,
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/provider/preview") {
    try {
      const provider = validateProviderPayload(await readRequestJson(req));
      const models = await providerModels(provider);
      jsonResponse(res, 200, {
        ok: true,
        provider,
        models,
        toml: providerTomlBlock(provider).trim(),
        envVisible: Boolean(process.env[provider.envKey]),
      });
    } catch (error) {
      jsonResponse(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/provider/test") {
    try {
      const body = await readRequestJson(req);
      const provider = validateProviderPayload(body);
      const model = requireString(body.model, "测试模型 ID", 160);
      const result = await providerResponsesTest(provider, model);
      jsonResponse(res, 200, {
        ok: true,
        provider,
        model,
        result,
      });
    } catch (error) {
      jsonResponse(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/provider/add") {
    try {
      const body = await readRequestJson(req);
      const provider = validateProviderPayload(body);
      const model = requireString(body.model, "测试模型 ID", 160);
      if (body.confirm !== provider.id) {
        throw new Error("确认文本不匹配。请在确认框输入 provider id。");
      }
      await ensureProviderCanBeAdded(provider);
      const models = await providerModels(provider);
      const test = await providerResponsesTest(provider, model);
      const config = await appendProviderToConfig(provider);
      jsonResponse(res, 200, {
        ok: true,
        provider,
        model,
        models,
        test,
        configPath: codexConfigPath,
        config,
      });
    } catch (error) {
      jsonResponse(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/restart/idle") {
    try {
      const body = await readRequestJson(req);
      if (body.confirm !== "重启空闲Bot") {
        throw new Error("确认文本不匹配。请输入：重启空闲Bot");
      }
      const names = Array.isArray(body.names) ? body.names.map((item) => String(item)) : [];
      jsonResponse(res, 200, {
        ok: true,
        ...(await restartIdleInstances(names)),
      });
    } catch (error) {
      jsonResponse(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    textResponse(res, 405, "Method not allowed");
    return;
  }

  await serveStatic(req, res, url);
}

async function writePidFile() {
  await mkdir(panelStateDir, { recursive: true });
  await mkdir(panelLogDir, { recursive: true });
  await writeFile(panelPidFile, `${process.pid}\n`, "utf8");
}

async function removePidFile() {
  try {
    const text = await readTextFile(panelPidFile);
    if (parsePid(text) === process.pid) {
      await unlink(panelPidFile);
    }
  } catch {
    // Best-effort cleanup.
  }
}

await writePidFile();

const server = createServer((req, res) => {
  requestHandler(req, res).catch((error) => {
    jsonResponse(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
});

server.listen(port, host, () => {
  console.log(`${APP_TITLE} 已启动：http://${host}:${port}`);
});

function shutdown() {
  server.close(() => {
    removePidFile().finally(() => process.exit(0));
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
