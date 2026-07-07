import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import {
  cp,
  rm,
  mkdir,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  binaryResponse,
  jsonResponse,
  readJsonFile,
  readRequestJson,
  readTextFile,
  textResponse,
} from "./src/control-panel/http.mjs";
import {
  optionalString,
  requireString,
  safeInteger,
} from "./src/control-panel/validation.mjs";
import {
  environmentVariableSource,
  environmentVariableValue,
} from "./src/control-panel/environment.mjs";

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
const factoryJobsFile = path.join(panelStateDir, "workspace-factory-jobs.json");
const registrationsRoot = path.join(runtimeRoot, "registrations");
const codexConfigPath = path.join(os.homedir(), ".codex", "config.toml");
const staticRoot = path.join(__dirname, "control-panel");
const bundledInstancesConfigPath = path.join(__dirname, "bridge.instances.json");
const localInstancesConfigPath = path.join(__dirname, "bridge.instances.local.json");
const envInstancesConfigPath = process.env.CODEX_FEISHU_INSTANCES_CONFIG
  ? path.resolve(process.env.CODEX_FEISHU_INSTANCES_CONFIG)
  : "";
const instancesConfigPath = envInstancesConfigPath || localInstancesConfigPath;
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
      group: item.group || "",
      runtimeRoot: item.runtimeRoot,
      workspace: item.workspace || "",
      codexHome: item.codexHome || path.join(os.homedir(), ".codex"),
      desktopCodexHome: item.desktopCodexHome || "",
      larkProfile: item.larkProfile || item.name || item.id,
      taskName: item.taskName || `CodexFeishuBridgeWatchdog-${item.name || item.id}`,
    })).filter((item) => item.id && item.name && item.runtimeRoot && item.taskName),
  };
}

function instancesConfigCandidates() {
  const candidates = envInstancesConfigPath
    ? [envInstancesConfigPath]
    : [localInstancesConfigPath, bundledInstancesConfigPath];
  return [...new Set(candidates.filter(Boolean))];
}

function loadInstancesConfig() {
  const fallback = normalizeInstancesConfig(fallbackInstancesConfig());
  const candidates = instancesConfigCandidates();
  const sourcePath = candidates.find((candidate) => existsSync(candidate));
  if (!sourcePath) {
    return {
      ...fallback,
      _source: {
        path: instancesConfigPath,
        candidates,
        exists: false,
        loaded: false,
        fallback: true,
        error: "instances config not found",
      },
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(sourcePath, "utf8").replace(/^\uFEFF/, ""));
    return {
      ...normalizeInstancesConfig(parsed),
      _source: {
        path: sourcePath,
        writePath: instancesConfigPath,
        candidates,
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
        path: sourcePath,
        writePath: instancesConfigPath,
        candidates,
        exists: true,
        loaded: false,
        fallback: true,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function readWritableInstancesConfig() {
  const writableText = await readTextFile(instancesConfigPath);
  if (writableText) return JSON.parse(writableText.replace(/^\uFEFF/, ""));

  const sourcePath = instancesConfigCandidates().find((candidate) => candidate !== instancesConfigPath && existsSync(candidate));
  if (sourcePath) {
    const sourceText = await readTextFile(sourcePath);
    if (sourceText) return JSON.parse(sourceText.replace(/^\uFEFF/, ""));
  }

  return fallbackInstancesConfig();
}

async function writeWritableInstancesConfig(config) {
  await mkdir(path.dirname(instancesConfigPath), { recursive: true });
  await writeFile(instancesConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return instancesConfigPath;
}

function instanceDescriptors(config = loadInstancesConfig()) {
  return config.instances || [];
}

function validateFactoryPayload(payload) {
  const instancesConfig = loadInstancesConfig();
  const paths = instancesConfig.paths || {};
  const displayNameSeed = optionalString(payload.spaceName || "写作", 80) || "写作";
  const slug = requireString(payload.slug || "writing", "空间 slug", 60).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error("空间 slug 只能包含小写英文字母、数字和短横线，并且必须以字母或数字开头");
  }

  const count = safeInteger(payload.count, "Bot 数量", 6, 1, 16);
  const baseIndex = safeInteger(payload.baseIndex, "起始序号", 1, 1, 99);
  const displayNamePattern = optionalString(payload.displayNamePattern, 120) || `Codex助手{index}-${displayNameSeed}`;
  const instanceNamePattern = optionalString(payload.instanceNamePattern, 120) || `codex-assistant-{index}-${slug}`;
  if (!displayNamePattern.includes("{index}")) throw new Error("飞书显示名模板必须包含 {index}");
  if (!instanceNamePattern.includes("{index}")) throw new Error("实例名模板必须包含 {index}");

  const workspaceRoot = path.resolve(optionalString(payload.workspaceRoot, 500) || paths.workspaceRoot || path.join(os.homedir(), "Documents", "Codex", "workspaces"));
  const codexHomeRoot = path.resolve(optionalString(payload.codexHomeRoot, 500) || path.join(os.homedir(), "Documents", "Codex", "codex-homes"));
  const codexHomeName = optionalString(payload.codexHomeName, 160) || `codex-assistant-${slug}`;
  if (!/^[A-Za-z0-9_.-]+$/.test(codexHomeName)) {
    throw new Error("Codex Home 目录名只能包含英文字母、数字、下划线、点和短横线");
  }

  const baselineProfile = optionalString(payload.baselineProfile, 120) || "codex-assistant-1";
  const brand = optionalString(payload.brand, 20) || "feishu";
  if (!["feishu", "lark"].includes(brand)) throw new Error("brand 只能是 feishu 或 lark");

  const description = optionalString(payload.description, 240) || `Codex 飞书 Bridge 垂类空间：${displayNameSeed}`;
  const avatarUrls = String(payload.avatarUrls || "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
  for (const avatarUrl of avatarUrls) {
    if (!/^https?:\/\//i.test(avatarUrl)) throw new Error(`头像 URL 必须是 http(s)：${avatarUrl}`);
  }
  if (avatarUrls.length > 6) throw new Error("头像 URL 最多 6 个");

  return {
    spaceName: displayNameSeed,
    slug,
    count,
    baseIndex,
    displayNamePattern,
    instanceNamePattern,
    workspaceRoot,
    codexHomeRoot,
    codexHomeName,
    codexHome: path.join(codexHomeRoot, codexHomeName),
    baselineProfile,
    brand,
    description,
    avatarUrls,
  };
}

function renderPattern(pattern, index, values) {
  return String(pattern)
    .replaceAll("{index}", String(index))
    .replaceAll("{slug}", values.slug)
    .replaceAll("{space}", values.spaceName);
}

function quoteCommandArg(value) {
  const text = String(value ?? "");
  if (!text) return '""';
  if (/^[A-Za-z0-9_./:=\\-]+$/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

function isPathInside(childPath, parentPath) {
  const child = path.resolve(childPath);
  const parent = path.resolve(parentPath);
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function uniqueStrings(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function redactSensitiveText(value, secrets = []) {
  let text = String(value || "");
  for (const secret of secrets) {
    const item = String(secret || "");
    if (item.length < 4) continue;
    text = text.split(item).join("<redacted>");
  }
  text = text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer <redacted>")
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"'\s]+/gi, "$1=<redacted>");
  return text;
}

function errorMessage(error, secrets = []) {
  return redactSensitiveText(error instanceof Error ? error.message : String(error), secrets);
}

async function pathExists(filePath) {
  if (!filePath) return false;
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function directoryExists(dirPath) {
  if (!dirPath) return false;
  try {
    const info = await stat(dirPath);
    return info.isDirectory();
  } catch {
    return false;
  }
}

function isCoreInstanceName(name) {
  return name === "default" || /^codex-assistant-(?:[1-9])$/.test(String(name || ""));
}

function isUninstallAllowedInstance(descriptor) {
  return Boolean(descriptor?.group) && !isCoreInstanceName(descriptor.name);
}

function cleanupRoots(config = loadInstancesConfig()) {
  const paths = config.paths || {};
  return {
    runtimeRoot,
    instancesRoot: path.join(runtimeRoot, "instances"),
    registrationsRoot,
    workspaceRoot: paths.workspaceRoot || path.join(os.homedir(), "Documents", "Codex", "workspaces"),
    codexHomesRoot: path.join(os.homedir(), "Documents", "Codex", "codex-homes"),
  };
}

function assertPathInsideRoot(targetPath, rootPath, label) {
  if (!targetPath || !rootPath) throw new Error(`${label} path is empty`);
  const target = path.resolve(targetPath);
  const root = path.resolve(rootPath);
  if (target === root || !isPathInside(target, root)) {
    throw new Error(`${label} path is outside the allowed root: ${target}`);
  }
  return target;
}

function splitTomlTables(text) {
  const tables = [];
  let current = {
    header: "",
    lines: [],
  };
  for (const line of String(text || "").replace(/\r\n/g, "\n").split("\n")) {
    const match = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (match) {
      tables.push(current);
      current = {
        header: match[1],
        lines: [line],
      };
      continue;
    }
    current.lines.push(line);
  }
  tables.push(current);
  return tables;
}

function parseMcpTableHeader(header) {
  const parts = String(header || "").split(".");
  if (parts[0] !== "mcp_servers" || parts.length < 2 || !parts[1]) return null;
  return {
    serverId: parts[1],
    isMainTable: parts.length === 2,
  };
}

function hasInlineSecretToml(block) {
  return /(TOKEN|SECRET|PASSWORD|KEY)\s*=/.test(block) && !/KEY_POOL_PATH|ROUTER_STATE_PATH/.test(block);
}

function buildSafeFactoryConfigToml(sourceText, selectedMcpIds = []) {
  const selectedMcp = new Set(selectedMcpIds.map((id) => String(id || "").split(".")[0]).filter(Boolean));
  const tables = splitTomlTables(sourceText);
  const lines = [
    "# Generated by Codex Feishu Bridge workspace factory.",
    "# Secrets are not copied. Provider blocks use env_key only.",
    "",
  ];
  const rootLines = tables[0]?.lines || [];
  for (const line of rootLines) {
    if (/^\s*(model|model_provider|model_reasoning_effort|service_tier|personality)\s*=/.test(line)) {
      lines.push(line);
    }
  }

  for (const table of tables) {
    if (/^model_providers\./.test(table.header)) {
      lines.push("", ...table.lines);
    }
  }

  if (selectedMcp.size) {
    lines.push("", "[mcp_servers]");
    const skippedMcp = new Set();
    const skippedMcpCommented = new Set();
    for (const table of tables) {
      const info = parseMcpTableHeader(table.header);
      if (!info || !info.isMainTable || !selectedMcp.has(info.serverId)) continue;
      const block = table.lines.join("\n");
      if (hasInlineSecretToml(block)) {
        skippedMcp.add(info.serverId);
      }
    }
    for (const table of tables) {
      const info = parseMcpTableHeader(table.header);
      if (!info || !selectedMcp.has(info.serverId)) continue;
      if (skippedMcp.has(info.serverId)) {
        if (info.isMainTable && !skippedMcpCommented.has(info.serverId)) {
          lines.push("", `# skipped mcp_servers.${info.serverId}: block appears to contain sensitive inline env values`);
          skippedMcpCommented.add(info.serverId);
        }
        continue;
      }
      lines.push("", ...table.lines);
    }
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function isModelProviderTable(header) {
  const match = String(header || "").match(/^model_providers\.([^\]]+)$/);
  return match ? match[1] : "";
}

function normalizedTomlBlock(lines) {
  return String(Array.isArray(lines) ? lines.join("\n") : lines || "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function providerBlockHasInlineSecret(block) {
  for (const line of String(block || "").split(/\r?\n/)) {
    const parsed = parseTomlValue(line);
    if (!parsed) continue;
    const key = parsed[0].toLowerCase();
    if (key === "env_key") continue;
    if (/api[_-]?key|token|secret|password|authorization|bearer/.test(key)) return true;
  }
  return false;
}

function extractModelProviderBlocks(sourceText) {
  const providers = [];
  const skipped = [];
  for (const table of splitTomlTables(sourceText)) {
    const id = isModelProviderTable(table.header);
    if (!id) continue;
    const block = table.lines.join("\n");
    const provider = {
      id,
      header: table.header,
      lines: [...table.lines],
      name: id,
      baseUrl: "",
      wireApi: "",
      envKey: "",
      envVisible: false,
      envSource: "",
    };
    for (const line of table.lines) {
      const parsed = parseTomlValue(line);
      if (!parsed) continue;
      const [key, value] = parsed;
      if (key === "name") provider.name = value;
      if (key === "base_url") provider.baseUrl = value;
      if (key === "wire_api") provider.wireApi = value;
      if (key === "env_key") {
        provider.envKey = value;
        provider.envVisible = Boolean(environmentVariableValue(value));
        provider.envSource = environmentVariableSource(value);
      }
    }
    if (providerBlockHasInlineSecret(block)) {
      skipped.push({
        id,
        reason: "provider block appears to contain an inline secret; skipped",
      });
      continue;
    }
    providers.push(provider);
  }
  return { providers, skipped };
}

function joinTomlTables(tables) {
  const lines = [];
  for (const table of tables) {
    const tableLines = Array.isArray(table.lines) ? table.lines : [];
    if (lines.length && table.header && lines.at(-1).trim() !== "") lines.push("");
    lines.push(...tableLines);
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function providerSyncTargets(config = loadInstancesConfig()) {
  const globalCodexHome = path.resolve(path.dirname(codexConfigPath));
  const seen = new Map();
  for (const instance of instanceDescriptors(config)) {
    const codexHome = instance.codexHome ? path.resolve(instance.codexHome) : "";
    if (!codexHome || codexHome.toLowerCase() === globalCodexHome.toLowerCase()) continue;
    const key = codexHome.toLowerCase();
    const current = seen.get(key) || {
      codexHome,
      configPath: path.join(codexHome, "config.toml"),
      instances: [],
      groups: new Set(),
    };
    current.instances.push({
      name: instance.name,
      label: instance.label,
      group: instance.group || "",
    });
    if (instance.group) current.groups.add(instance.group);
    seen.set(key, current);
  }
  return [...seen.values()].map((target) => ({
    codexHome: target.codexHome,
    configPath: target.configPath,
    groups: [...target.groups],
    instances: target.instances,
  }));
}

function targetProviderTableIndex(tables) {
  const index = new Map();
  tables.forEach((table, tableIndex) => {
    const id = isModelProviderTable(table.header);
    if (id) index.set(id, tableIndex);
  });
  return index;
}

async function buildProviderSyncPlan({ apply = false } = {}) {
  const sourceText = await readTextFile(codexConfigPath);
  if (!sourceText) throw new Error(`Global Codex config not found: ${codexConfigPath}`);
  const source = extractModelProviderBlocks(sourceText);
  const targets = providerSyncTargets();
  const summary = {
    targetCount: targets.length,
    sourceProviderCount: source.providers.length,
    sourceSkippedCount: source.skipped.length,
    addCount: 0,
    updateCount: 0,
    unchangedCount: 0,
    skippedCount: source.skipped.length,
    writtenCount: 0,
  };

  const results = [];
  for (const target of targets) {
    const codexHomeExists = await directoryExists(target.codexHome);
    const configExists = await pathExists(target.configPath);
    if (!codexHomeExists) {
      results.push({
        ...target,
        ok: false,
        action: "skipped",
        reason: "Codex Home directory does not exist",
        exists: false,
        configExists,
        added: [],
        updated: [],
        unchanged: [],
        skipped: [],
      });
      summary.skippedCount += source.providers.length;
      continue;
    }
    if (!configExists) {
      results.push({
        ...target,
        ok: false,
        action: "skipped",
        reason: "config.toml does not exist",
        exists: true,
        configExists,
        added: [],
        updated: [],
        unchanged: [],
        skipped: [],
      });
      summary.skippedCount += source.providers.length;
      continue;
    }

    const targetText = (await readTextFile(target.configPath)) || "";
    const tables = splitTomlTables(targetText);
    const index = targetProviderTableIndex(tables);
    const added = [];
    const updated = [];
    const unchanged = [];
    const skipped = [];

    for (const provider of source.providers) {
      const tableIndex = index.get(provider.id);
      if (tableIndex == null) {
        added.push(provider.id);
        continue;
      }
      const existing = tables[tableIndex];
      if (providerBlockHasInlineSecret(existing.lines.join("\n"))) {
        skipped.push({
          id: provider.id,
          reason: "target provider block appears to contain an inline secret; skipped",
        });
        continue;
      }
      if (normalizedTomlBlock(existing.lines) === normalizedTomlBlock(provider.lines)) {
        unchanged.push(provider.id);
        continue;
      }
      updated.push(provider.id);
    }

    let written = false;
    if (apply && (added.length || updated.length)) {
      await mkdir(target.codexHome, { recursive: true });
      for (const provider of source.providers) {
        if (!added.includes(provider.id) && !updated.includes(provider.id)) continue;
        const tableIndex = index.get(provider.id);
        if (tableIndex == null) {
          tables.push({
            header: provider.header,
            lines: [...provider.lines],
          });
        } else {
          tables[tableIndex] = {
            header: provider.header,
            lines: [...provider.lines],
          };
        }
      }
      await writeFile(target.configPath, joinTomlTables(tables), "utf8");
      written = true;
    }

    summary.addCount += added.length;
    summary.updateCount += updated.length;
    summary.unchangedCount += unchanged.length;
    summary.skippedCount += skipped.length;
    if (written) summary.writtenCount += 1;
    results.push({
      ...target,
      ok: true,
      action: written ? "written" : (added.length || updated.length ? "pending" : "unchanged"),
      exists: true,
      configExists,
      added,
      updated,
      unchanged,
      skipped,
      written,
    });
  }

  return {
    ok: true,
    applied: apply,
    source: {
      codexHome: path.dirname(codexConfigPath),
      configPath: codexConfigPath,
      providers: source.providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        wireApi: provider.wireApi,
        envKey: provider.envKey,
        envVisible: provider.envVisible,
        envSource: provider.envSource,
      })),
      skipped: source.skipped,
    },
    summary,
    targets: results,
    note: "Only [model_providers.*] blocks are synced. API keys, default model settings, MCP, skills, sessions, logs, watchdog and Bot config are not changed.",
  };
}

function listMcpServerIdsFromToml(sourceText) {
  const ids = [];
  for (const table of splitTomlTables(sourceText)) {
    const info = parseMcpTableHeader(table.header);
    if (info?.isMainTable && !ids.includes(info.serverId)) ids.push(info.serverId);
  }
  return ids;
}

function skillRootDescriptors() {
  return [
    {
      kind: "personal",
      label: "个人 skills",
      root: path.join(os.homedir(), ".codex", "skills"),
      targetSubdir: "skills",
      includeHidden: false,
      requireSkillMd: false,
    },
  ];
}

async function listSkillDirectories(root, options = {}) {
  if (!(await directoryExists(root))) return [];
  const recursive = Boolean(options.recursive);
  if (!recursive) {
    const rows = await readdir(root, { withFileTypes: true });
    const result = [];
    for (const item of rows) {
      if (!item.isDirectory()) continue;
      if (!options.includeHidden && item.name.startsWith(".")) continue;
      const sourcePath = path.join(root, item.name);
      if (options.requireSkillMd !== false && !(await pathExists(path.join(sourcePath, "SKILL.md")))) continue;
      result.push({
        name: item.name,
        relativePath: item.name,
        sourcePath,
      });
    }
    return result;
  }

  const result = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let rows = [];
    try {
      rows = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (rows.some((item) => item.isFile() && item.name === "SKILL.md")) {
      const relativePath = path.relative(root, dir);
      result.push({
        name: path.basename(dir),
        relativePath,
        sourcePath: dir,
      });
      continue;
    }
    for (const item of rows) {
      if (!item.isDirectory()) continue;
      if (!options.includeHidden && item.name.startsWith(".")) continue;
      stack.push(path.join(dir, item.name));
    }
  }
  return result;
}

async function listFactorySources() {
  const configText = (await readTextFile(codexConfigPath)) || "";
  const roots = skillRootDescriptors();
  const skills = [];
  const seenIds = new Set();
  for (const rootInfo of roots) {
    let items = [];
    try {
      items = await listSkillDirectories(rootInfo.root, rootInfo);
    } catch {
      items = [];
    }
    for (const item of items) {
      const id = `${rootInfo.kind}:${item.relativePath.replace(/\\/g, "/")}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      skills.push({
        id,
        name: item.name,
        kind: rootInfo.kind,
        label: rootInfo.label,
        sourcePath: item.sourcePath,
        relativePath: item.relativePath,
        targetSubdir: rootInfo.targetSubdir,
      });
    }
  }
  skills.sort((a, b) => `${a.label}:${a.name}`.localeCompare(`${b.label}:${b.name}`));

  return {
    ok: true,
    codexHome: path.join(os.homedir(), ".codex"),
    configPath: codexConfigPath,
    agentsPath: path.join(os.homedir(), ".codex", "AGENTS.md"),
    skillsRoot: path.join(os.homedir(), ".codex", "skills"),
    skillRoots: roots.map((item) => ({
      kind: item.kind,
      label: item.label,
      root: item.root,
      targetSubdir: item.targetSubdir,
    })),
    skills,
    mcpServers: listMcpServerIdsFromToml(configText),
  };
}

function normalizeIdList(value, allowedPattern = /^[A-Za-z0-9_.-]+$/) {
  const list = Array.isArray(value)
    ? value
    : String(value || "")
      .split(/\r?\n|,/);
  return Array.from(new Set(list.map((item) => String(item || "").trim()).filter(Boolean))).filter((item) => allowedPattern.test(item));
}

function safeFactoryAuthQrPath(job, kind = "auth") {
  const name = String(job?.name || "").trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return "";
  const fileName = kind === "auth" ? "auth-domain-all-qr.png" : "register-qr.png";
  return path.join(registrationsRoot, name, fileName);
}

function safeFactoryQrPath(job) {
  if (!job?.qrImage) return "";
  const resolved = path.resolve(job.qrImage);
  const root = path.resolve(registrationsRoot);
  if (!isPathInside(resolved, root)) return "";
  if (path.basename(resolved).toLowerCase() !== "register-qr.png") return "";
  return resolved;
}

async function readFactoryJobQr(jobName) {
  const name = String(jobName || "").trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error("Bot 名称不合法。");
  }
  const state = await readFactoryJobs();
  const job = (state.jobs || []).find((item) => item.name === name || item.id === name);
  if (!job) {
    throw new Error(`队列中找不到 Bot：${name}`);
  }
  const qrPath = safeFactoryQrPath(job) || safeFactoryAuthQrPath(job, "register");
  if (!qrPath || !(await pathExists(qrPath))) {
    throw new Error(`二维码图片不存在：${job.qrImage || "-"}`);
  }
  return {
    path: qrPath,
    body: await readFile(qrPath),
  };
}

async function hydrateFactoryRuntimeArtifacts(state) {
  const clone = {
    ...(state || {}),
    jobs: (state?.jobs || []).map((job) => ({ ...job })),
  };
  for (const job of clone.jobs || []) {
    const name = String(job?.name || "").trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) continue;

    const registerDir = path.join(registrationsRoot, name);
    const registerQrImage = path.join(registerDir, "register-qr.png");
    const registerQrPage = path.join(registerDir, "register-qr.html");
    if (!job.qrImage && await pathExists(registerQrImage)) {
      job.qrImage = registerQrImage;
    }
    if (!job.qrPage && await pathExists(registerQrPage)) {
      job.qrPage = registerQrPage;
    }

    const authQrImage = path.join(registerDir, "auth-domain-all-qr.png");
    if (job.auth?.status && !job.auth.qrImage && await pathExists(authQrImage)) {
      job.auth = {
        ...job.auth,
        qrImage: authQrImage,
      };
    }
  }
  return clone;
}

async function readFactoryJobAuthQr(jobName) {
  const name = String(jobName || "").trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error("Bot 名称不合法。");
  }
  const state = await readFactoryJobs();
  const job = (state.jobs || []).find((item) => item.name === name || item.id === name);
  if (!job) {
    throw new Error(`队列中找不到 Bot：${name}`);
  }
  const qrPath = path.resolve(job.auth?.qrImage || safeFactoryAuthQrPath(job, "auth"));
  const root = path.resolve(registrationsRoot);
  if (!isPathInside(qrPath, root) || path.basename(qrPath).toLowerCase() !== "auth-domain-all-qr.png") {
    throw new Error("补授权二维码路径不合法。");
  }
  if (!(await pathExists(qrPath))) {
    throw new Error(`补授权二维码不存在：${qrPath}`);
  }
  return {
    path: qrPath,
    body: await readFile(qrPath),
  };
}

async function prepareFactoryLocalSpace(payload) {
  const confirm = String(payload.confirm || "").trim();
  if (confirm !== "初始化本地空间") {
    throw new Error("确认文本不匹配。请输入：初始化本地空间");
  }

  const preview = buildFactoryPreview(payload);
  const factory = preview.inputs;
  const selectedSkills = normalizeIdList(payload.selectedSkills);
  const selectedMcpServers = normalizeIdList(payload.selectedMcpServers);
  const overwrite = Boolean(payload.overwrite);
  const sources = await listFactorySources();
  const sourceSkillsById = new Map(sources.skills.map((item) => [item.id, item]));
  const sourceMcpIds = new Set(sources.mcpServers);
  const operations = [];

  const codexHomeRoot = path.resolve(factory.codexHomeRoot);
  const codexHome = path.resolve(factory.codexHome);
  const workspaceRoot = path.resolve(factory.workspaceRoot);
  if (!isPathInside(codexHome, codexHomeRoot)) {
    throw new Error(`Codex Home 目标不在根目录内：${codexHome}`);
  }

  for (const instance of preview.instances) {
    if (!isPathInside(instance.workspace, workspaceRoot)) {
      throw new Error(`workspace 目标不在根目录内：${instance.workspace}`);
    }
    if (!isPathInside(instance.runtimeRoot, runtimeRoot)) {
      throw new Error(`runtimeRoot 目标不在运行根目录内：${instance.runtimeRoot}`);
    }
  }

  const configTarget = path.join(codexHome, "config.toml");
  const manifestPath = path.join(codexHome, "codex-feishu-workspace-factory.manifest.json");
  if (!overwrite) {
    const existingTargets = [];
    for (const target of [configTarget, manifestPath]) {
      if (await pathExists(target)) existingTargets.push(target);
    }
    if (existingTargets.length) {
      throw new Error(`目标已存在，默认不覆盖：${existingTargets.join("；")}`);
    }
  }

  await mkdir(codexHome, { recursive: true });
  operations.push({ action: "mkdir", path: codexHome });
  for (const dirName of ["sessions", "skills", "tmp"]) {
    const target = path.join(codexHome, dirName);
    await mkdir(target, { recursive: true });
    operations.push({ action: "mkdir", path: target });
  }

  const sourceConfig = (await readTextFile(codexConfigPath)) || "";
  const safeConfig = buildSafeFactoryConfigToml(
    sourceConfig,
    selectedMcpServers.filter((id) => sourceMcpIds.has(id)),
  );
  await writeFile(configTarget, safeConfig, "utf8");
  operations.push({ action: "write", path: configTarget, note: "safe config.toml" });

  const agentsSource = path.join(os.homedir(), ".codex", "AGENTS.md");
  const agentsTarget = path.join(codexHome, "AGENTS.md");
  if (await pathExists(agentsSource)) {
    await cp(agentsSource, agentsTarget, { force: true });
    operations.push({ action: "copy", source: agentsSource, path: agentsTarget });
  }

  const copiedSkills = [];
  for (const skillId of selectedSkills) {
    const skill = sourceSkillsById.get(skillId);
    if (!skill) {
      operations.push({ action: "skip", path: skillId, reason: "skill not found in source" });
      continue;
    }
    const source = skill.sourcePath;
    const target = path.join(codexHome, skill.targetSubdir || "skills", skill.relativePath || skill.name || skillId);
    await cp(source, target, { recursive: true, force: true });
    copiedSkills.push(skillId);
    operations.push({ action: "copy-dir", source, path: target });
  }

  for (const instance of preview.instances) {
    await mkdir(instance.workspace, { recursive: true });
    operations.push({ action: "mkdir", path: instance.workspace });
    const workspaceAgents = path.join(instance.workspace, "AGENTS.md");
    if (!(await pathExists(workspaceAgents))) {
      const text = [
        "# Codex Feishu Bridge Workspace",
        "",
        `Instance: ${instance.name}`,
        `Space: ${factory.spaceName}`,
        `Codex Home: ${factory.codexHome}`,
        "",
        "This workspace was prepared by the Codex Feishu Bridge workspace factory.",
        "",
      ].join("\n");
      await writeFile(workspaceAgents, text, "utf8");
      operations.push({ action: "write", path: workspaceAgents });
    }
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: "local-prepare",
    warning: "This manifest records local preparation only. It does not mean Feishu apps were registered or bots were started.",
    sourceRoot: preview.paths.sourceRoot,
    runtimeRoot,
    factory: {
      spaceName: factory.spaceName,
      slug: factory.slug,
      count: factory.count,
      baseIndex: factory.baseIndex,
      displayNamePattern: factory.displayNamePattern,
      instanceNamePattern: factory.instanceNamePattern,
      workspaceRoot: factory.workspaceRoot,
      codexHomeRoot: factory.codexHomeRoot,
      codexHome: factory.codexHome,
      desktopCodexHome: preview.paths.desktopCodexHome,
      baselineProfile: factory.baselineProfile,
      brand: factory.brand,
    },
    selectedSkills,
    copiedSkills,
    selectedMcpServers: selectedMcpServers.filter((id) => sourceMcpIds.has(id)),
    bridgeInstancesAppendPreview: preview.bridgeInstancesAppendPreview,
    instances: preview.instances.map((item) => ({
      name: item.name,
      label: item.label,
      workspace: item.workspace,
      codexHome: item.codexHome,
      desktopCodexHome: item.desktopCodexHome,
      runtimeRoot: item.runtimeRoot,
      larkProfile: item.larkProfile,
      taskName: item.taskName,
    })),
    operations,
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  operations.push({ action: "write", path: manifestPath });

  return {
    ok: true,
    mode: "local-prepare",
    generatedAt: new Date().toISOString(),
    message: "本地空间初始化完成。未创建飞书 APP，未授权，未写 bridge.instances.json，未安装 watchdog，未启动 Bot。",
    codexHome,
    manifestPath,
    configPath: configTarget,
    operations,
    manifest,
  };
}

async function readFactoryJobs() {
  const parsed = await readJsonFile(factoryJobsFile);
  if (!parsed || typeof parsed !== "object") {
    return {
      schemaVersion: 1,
      updatedAt: "",
      jobs: [],
    };
  }
  return {
    schemaVersion: 1,
    updatedAt: parsed.updatedAt || "",
    jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
  };
}

async function writeFactoryJobs(state) {
  await mkdir(panelStateDir, { recursive: true });
  const next = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    jobs: Array.isArray(state.jobs) ? state.jobs : [],
  };
  await writeFile(factoryJobsFile, JSON.stringify(next, null, 2), "utf8");
  return next;
}

async function createFactoryJobQueue(payload) {
  const confirm = String(payload.confirm || "").trim();
  if (confirm !== "生成真实创建队列") {
    throw new Error("确认文本不匹配。请输入：生成真实创建队列");
  }
  const preview = buildFactoryPreview(payload);
  const factory = preview.inputs;
  const manifestPath = path.join(factory.codexHome, "codex-feishu-workspace-factory.manifest.json");
  if (!(await pathExists(manifestPath))) {
    throw new Error(`请先完成本地空间初始化，未找到 manifest：${manifestPath}`);
  }

  const existing = await readFactoryJobs();
  const existingNames = new Set(existing.jobs.map((job) => job.name).filter(Boolean));
  const jobs = [...existing.jobs];
  for (const instance of preview.instances) {
    if (existingNames.has(instance.name)) continue;
    jobs.push({
      id: instance.name,
      name: instance.name,
      label: instance.label,
      group: instance.group,
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      appId: "",
      larkProfile: instance.larkProfile,
      workspace: instance.workspace,
      codexHome: instance.codexHome,
      desktopCodexHome: instance.desktopCodexHome,
      runtimeRoot: instance.runtimeRoot,
      taskName: instance.taskName,
      displayName: instance.label,
      description: factory.description,
      brand: factory.brand,
      avatarUrls: factory.avatarUrls,
      lastError: "",
      scopes: {
        checkedAt: "",
        count: null,
        missing: [],
        extra: [],
      },
      commands: instance.commands,
    });
  }

  return {
    ok: true,
    jobsFile: factoryJobsFile,
    manifestPath,
    ...publicFactoryState(await writeFactoryJobs({ jobs })),
  };
}

async function factoryJobsStatus() {
  const state = await hydrateFactoryRuntimeArtifacts(await readFactoryJobs());
  return {
    ok: true,
    jobsFile: factoryJobsFile,
    ...publicFactoryState(state),
  };
}

function sanitizeRegisterLog(text) {
  return String(text || "")
    .replace(/(appSecret|client_secret|secret)\s*[:=]\s*["']?[^"'\s]+/gi, "$1=<redacted>")
    .replace(/(token)\s*[:=]\s*["']?[^"'\s]+/gi, "$1=<redacted>");
}

function parseRegisterResult(stdout) {
  const text = String(stdout || "");
  return {
    appId: text.match(/Registered Feishu app:\s*(\S+)/)?.[1] || "",
    profile: text.match(/Created lark-cli profile:\s*(\S+)/)?.[1] || "",
    qrPage: text.match(/QR page:\s*(.+)/)?.[1]?.trim() || "",
    qrImage: text.match(/QR image:\s*(.+)/)?.[1]?.trim() || "",
  };
}

async function findLarkProfile(profileName) {
  const name = optionalString(profileName, 120);
  if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) return null;
  const result = await runLarkCli(["profile", "list"], { timeoutMs: 30_000 });
  if (!result.ok) return null;
  const text = result.stdout.trim();
  if (!text) return null;
  try {
    const profiles = JSON.parse(text);
    return Array.isArray(profiles) ? profiles.find((item) => item?.name === name) || null : null;
  } catch {
    return null;
  }
}

function registerFailureInfo(result, parsed, profileExists) {
  const text = sanitizeRegisterLog([result.error, result.stderr, result.stdout].filter(Boolean).join("\n")).trim();
  const lower = text.toLowerCase();
  const timedOut = /etimedout|timed out|timeout/.test(lower);
  const network = timedOut || /econnreset|enotfound|socket hang up|network/.test(lower);
  const qrShown = Boolean(parsed?.qrPage || parsed?.qrImage || /QR page:|Scan this QR code/i.test(text));
  const appIdSeen = Boolean(parsed?.appId);

  if (profileExists) {
    return {
      kind: "local_profile_exists_after_failure",
      message: "注册脚本返回失败，但本地 lark-cli profile 已存在，已按本地 profile 恢复。",
      hint: "下一步请复查权限。",
    };
  }
  if (appIdSeen) {
    return {
      kind: "remote_app_created_local_profile_missing",
      message: "飞书侧可能已创建应用，但本地 profile 没写入。",
      hint: "不要直接启动。若飞书侧已删除残留应用，可重新创建；若未删除，需要手动补录 appId/appSecret。",
    };
  }
  if (network && qrShown) {
    return {
      kind: "network_timeout_after_qr",
      message: "二维码阶段后网络超时，本地没有拿到 appId/profile。",
      hint: "如果飞书侧出现了残留 Bot，请先在飞书侧删除，再在控制面板重试创建。",
    };
  }
  if (network) {
    return {
      kind: "network_timeout",
      message: "注册过程网络超时，本地没有完成 profile 写入。",
      hint: "检查代理/TUN 或稍后重试。",
    };
  }
  return {
    kind: "register_failed",
    message: "注册脚本失败，本地没有完成 profile 写入。",
    hint: "查看 register log；确认飞书侧没有残留应用后可重试。",
  };
}

function runRegisterScriptForJob(job) {
  return new Promise((resolve) => {
    const args = [
      path.join(__dirname, "register-codex-feishu-bot.mjs"),
      "--name",
      job.name,
      "--profile",
      job.larkProfile || job.name,
      "--display-name",
      job.displayName || job.label || job.name,
      "--description",
      job.description || `Codex Feishu Bridge bot ${job.name}`,
      "--workspace",
      job.workspace,
      "--codex-home",
      job.codexHome,
      "--desktop-codex-home",
      job.desktopCodexHome,
      "--brand",
      job.brand || "feishu",
      "--no-start",
      "--timeout-seconds",
      "600",
    ];
    for (const avatarUrl of job.avatarUrls || []) {
      args.push("--avatar-url", avatarUrl);
    }

    const child = spawn(process.execPath, args, {
      cwd: __dirname,
      windowsHide: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      resolve({
        ok: false,
        exitCode: -1,
        error: error.message,
        stdout,
        stderr,
      });
    });
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        exitCode: code ?? 0,
        stdout,
        stderr,
        parsed: parseRegisterResult(stdout),
      });
    });
  });
}

async function startNextFactoryRegistration(payload) {
  const confirm = String(payload.confirm || "").trim();
  if (confirm !== "创建下一个飞书APP") {
    throw new Error("确认文本不匹配。请输入：创建下一个飞书APP");
  }
  const state = await readFactoryJobs();
  const job = chooseFactoryJob(
    state,
    payload.name,
    (item) => ["pending", "failed"].includes(item.status),
    "没有 pending/failed 状态的 Bot 可创建",
  );

  job.status = "registering";
  job.updatedAt = new Date().toISOString();
  job.lastError = "";
  await writeFactoryJobs(state);

  const logDir = path.join(panelLogDir, "factory");
  await mkdir(logDir, { recursive: true });
  const logPath = path.join(logDir, `${job.name}-register.log`);
  await writeFile(logPath, `Started registration at ${new Date().toISOString()}\n`, "utf8");

  const result = await runRegisterScriptForJob(job);
  const parsed = result.parsed || parseRegisterResult(result.stdout);
  const logText = [
    `Finished at ${new Date().toISOString()}`,
    `ExitCode: ${result.exitCode}`,
    "",
    "STDOUT:",
    sanitizeRegisterLog(result.stdout),
    "",
    "STDERR:",
    sanitizeRegisterLog(result.stderr),
    "",
  ].join("\n");
  await writeFile(logPath, logText, "utf8");

  const nextState = await readFactoryJobs();
  const nextJob = nextState.jobs.find((item) => item.name === job.name);
  if (nextJob) {
    nextJob.updatedAt = new Date().toISOString();
    nextJob.registerLogPath = logPath;
    nextJob.qrPage = parsed.qrPage || nextJob.qrPage || "";
    nextJob.qrImage = parsed.qrImage || nextJob.qrImage || "";
    const localProfile = await findLarkProfile(nextJob.larkProfile || nextJob.name);
    if (result.ok || localProfile) {
      nextJob.status = "profile_created";
      nextJob.appId = parsed.appId || localProfile?.appId || nextJob.appId || "";
      nextJob.lastError = result.ok ? "" : registerFailureInfo(result, parsed, true).message;
      delete nextJob.failureKind;
      delete nextJob.recoveryHint;
    } else {
      const failure = registerFailureInfo(result, parsed, false);
      nextJob.status = "failed";
      nextJob.appId = parsed.appId || nextJob.appId || "";
      nextJob.failureKind = failure.kind;
      nextJob.recoveryHint = failure.hint;
      const rawError = sanitizeRegisterLog(result.error || result.stderr || `register script failed with exit code ${result.exitCode}`).trim();
      nextJob.lastError = [failure.message, rawError, failure.hint].filter(Boolean).join("\n\n").slice(0, 2000);
    }
  }
  const written = await writeFactoryJobs(nextState);
  return {
    ok: result.ok,
    action: "register-next",
    jobName: job.name,
    logPath,
    parsed,
    exitCode: result.exitCode,
    ...written,
  };
}

async function removePendingFactoryJob(payload) {
  const confirm = String(payload.confirm || "").trim();
  if (confirm !== "移除未创建队列项") {
    throw new Error("确认文本不匹配。请输入：移除未创建队列项");
  }
  const state = await readFactoryJobs();
  const job = findFactoryJob(state, payload.name);
  if (!job) throw new Error("请指定要移除的 Bot");
  if (!["pending", "failed"].includes(job.status) || job.appId) {
    throw new Error(`${job.name} 已经创建或进入后续状态，不能作为未创建队列项移除`);
  }
  state.jobs = state.jobs.filter((item) => item.name !== job.name);
  return {
    ok: true,
    action: "remove-pending",
    removed: job.name,
    ...(await writeFactoryJobs(state)),
  };
}

async function resetFactoryJobsView(payload) {
  const confirm = String(payload.confirm || "").trim();
  if (confirm !== "重置创建队列显示") {
    throw new Error("确认文本不匹配。请输入：重置创建队列显示");
  }
  return {
    ok: true,
    action: "reset-view",
    removedCount: (await readFactoryJobs()).jobs.length,
    ...(await writeFactoryJobs({ jobs: [] })),
  };
}

function compareScopes(base, current) {
  const baseScopes = new Set(base.scopes || []);
  const currentScopes = new Set(current.scopes || []);
  return {
    missing: Array.from(baseScopes).filter((scope) => !currentScopes.has(scope)).sort(),
    extra: Array.from(currentScopes).filter((scope) => !baseScopes.has(scope)).sort(),
  };
}

function needsFactoryAuth(job) {
  return ["profile_created", "scopes_checked", "instance_config_written", "watchdog_installed", "started"].includes(job.status)
    && (!job.scopes?.checkedAt || (job.scopes?.missing || []).length > 0);
}

function findFactoryJob(state, name) {
  const value = optionalString(name, 120);
  if (!value) return null;
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error(`Bot 名称不合法：${value}`);
  const job = state.jobs.find((item) => item.name === value || item.id === value || item.larkProfile === value);
  if (!job) throw new Error(`队列中找不到 Bot：${value}`);
  return job;
}

function chooseFactoryJob(state, name, predicate, fallbackError) {
  const selected = findFactoryJob(state, name);
  if (selected) {
    if (!predicate(selected)) throw new Error(`${selected.name} 当前状态不满足此操作条件`);
    return selected;
  }
  const job = state.jobs.find(predicate);
  if (!job) throw new Error(fallbackError);
  return job;
}

function factoryJobsForAction(state, name, predicate, fallbackError) {
  const selected = findFactoryJob(state, name);
  if (selected) {
    if (!predicate(selected)) throw new Error(`${selected.name} 当前状态不满足此操作条件`);
    return [selected];
  }
  const jobs = state.jobs.filter(predicate);
  if (!jobs.length) throw new Error(fallbackError);
  return jobs;
}

function factoryAuthExpired(job) {
  const expiresAt = Date.parse(job.auth?.expiresAt || "");
  return Number.isFinite(expiresAt) && Date.now() > expiresAt;
}

async function startFactoryJobAuth(payload) {
  const confirm = String(payload.confirm || "").trim();
  if (confirm !== "发起补授权") throw new Error("确认文本不匹配。请输入：发起补授权");
  const state = await readFactoryJobs();
  const job = chooseFactoryJob(state, payload.name, needsFactoryAuth, "没有需要补授权的 job。请先创建飞书 APP/profile 并复查权限。");
  const profile = job.larkProfile || job.name;
  if (!/^[A-Za-z0-9_.-]+$/.test(profile)) throw new Error(`profile 名称不合法：${profile}`);

  const authDir = path.join(registrationsRoot, job.name);
  await mkdir(authDir, { recursive: true });
  const qrPath = safeFactoryAuthQrPath(job, "auth");
  const result = await runLarkCli(["auth", "login", "--domain", "all", "--no-wait", "--json", "--profile", profile], { timeoutMs: 60_000 });
  if (!result.ok) {
    job.updatedAt = new Date().toISOString();
    job.auth = {
      status: "failed",
      requestedAt: new Date().toISOString(),
      profile,
      lastError: sanitizeRegisterLog(result.stderr || result.error || "auth login --no-wait failed").slice(0, 2000),
    };
    job.lastError = job.auth.lastError;
    return {
      ok: false,
      action: "start-auth",
      jobName: job.name,
      ...(publicFactoryState(await writeFactoryJobs(state))),
    };
  }

  let parsed;
  try {
    parsed = parseFirstJson(result.stdout);
  } catch (error) {
    job.updatedAt = new Date().toISOString();
    job.auth = {
      status: "failed",
      requestedAt: new Date().toISOString(),
      profile,
      lastError: error instanceof Error ? error.message : String(error),
    };
    job.lastError = job.auth.lastError;
    return {
      ok: false,
      action: "start-auth",
      jobName: job.name,
      ...(publicFactoryState(await writeFactoryJobs(state))),
    };
  }
  if (!parsed.verification_url || !parsed.device_code) {
    throw new Error("lark-cli 没有返回 verification_url 或 device_code。");
  }

  const QRCode = await import("qrcode");
  await QRCode.toFile(qrPath, parsed.verification_url, {
    width: 320,
    margin: 2,
    errorCorrectionLevel: "M",
  });
  if (!(await pathExists(qrPath))) {
    throw new Error(`生成补授权二维码失败：${qrPath}`);
  }

  job.updatedAt = new Date().toISOString();
  job.auth = {
    status: "pending",
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + Number(parsed.expires_in || 600) * 1000).toISOString(),
    profile,
    verificationUrl: parsed.verification_url,
    deviceCode: parsed.device_code,
    qrImage: qrPath,
    lastError: "",
  };
  job.lastError = "等待用户扫码完成补授权";
  return {
    ok: true,
    action: "start-auth",
    jobName: job.name,
    verificationUrl: parsed.verification_url,
    qrImage: qrPath,
    ...(publicFactoryState(await writeFactoryJobs(state))),
  };
}

async function completeFactoryJobAuth(payload) {
  const confirm = String(payload.confirm || "").trim();
  if (confirm !== "完成补授权") throw new Error("确认文本不匹配。请输入：完成补授权");
  const state = await readFactoryJobs();
  const job = chooseFactoryJob(
    state,
    payload.name,
    (item) => item.auth?.status === "pending" && item.auth?.deviceCode,
    "没有等待完成的补授权。请先点击“发起补授权”并扫码。",
  );
  if (factoryAuthExpired(job)) {
    job.updatedAt = new Date().toISOString();
    job.auth.status = "expired";
    job.auth.lastError = "补授权二维码已过期，请重新发起补授权。";
    job.lastError = job.auth.lastError;
    return {
      ok: false,
      action: "complete-auth",
      jobName: job.name,
      ...(publicFactoryState(await writeFactoryJobs(state))),
    };
  }
  const profile = job.auth.profile || job.larkProfile || job.name;
  const result = await runLarkCli(["auth", "login", "--device-code", job.auth.deviceCode, "--profile", profile, "--json"], {
    timeoutMs: 60_000,
  });
  job.updatedAt = new Date().toISOString();
  if (!result.ok) {
    job.auth.status = "pending";
    job.auth.lastError = sanitizeRegisterLog(result.stderr || result.error || "auth login --device-code failed").slice(0, 2000);
    job.lastError = job.auth.lastError;
    return {
      ok: false,
      action: "complete-auth",
      jobName: job.name,
      ...(publicFactoryState(await writeFactoryJobs(state))),
    };
  }

  job.auth.status = "completed";
  job.auth.completedAt = new Date().toISOString();
  delete job.auth.deviceCode;
  job.auth.lastError = "";
  job.lastError = "";
  const current = await readFactoryScopesBaseline(profile);
  if (current.ok) {
    job.scopes = {
      ...(job.scopes || {}),
      checkedAt: new Date().toISOString(),
      count: current.count,
    };
  }
  return {
    ok: true,
    action: "complete-auth",
    jobName: job.name,
    ...(publicFactoryState(await writeFactoryJobs(state))),
  };
}

async function checkFactoryJobScopes(payload) {
  const confirm = String(payload.confirm || "").trim();
  if (confirm !== "复查权限") throw new Error("确认文本不匹配。请输入：复查权限");
  const baselineProfile = optionalString(payload.baselineProfile, 120) || "codex-assistant-1";
  const state = await readFactoryJobs();
  const candidates = factoryJobsForAction(
    state,
    payload.name,
    (job) => ["profile_created", "scopes_checked", "instance_config_written", "watchdog_installed", "started"].includes(job.status),
    "没有可复查 scopes 的 job。请先创建飞书 APP/profile。",
  );
  const base = await readFactoryScopesBaseline(baselineProfile);
  if (!base.ok) throw new Error(`读取基准 profile scopes 失败：${base.error || baselineProfile}`);

  for (const job of candidates) {
    const current = await readFactoryScopesBaseline(job.larkProfile || job.name);
    job.updatedAt = new Date().toISOString();
    if (!current.ok) {
      job.lastError = `读取 profile scopes 失败：${current.error || current.stderr || job.larkProfile}`;
      continue;
    }
    const diff = compareScopes(base, current);
    job.scopes = {
      checkedAt: new Date().toISOString(),
      baselineProfile,
      baselineCount: base.count,
      count: current.count,
      missing: diff.missing,
      extra: diff.extra,
    };
    if (job.status === "profile_created") job.status = "scopes_checked";
    job.lastError = diff.missing.length ? `缺少 ${diff.missing.length} 个 scopes` : "";
  }

  return {
    ok: true,
    action: "check-scopes",
    baselineProfile,
    ...(await writeFactoryJobs(state)),
  };
}

async function appendFactoryInstancesToConfig(payload) {
  const confirm = String(payload.confirm || "").trim();
  if (confirm !== "写入实例配置") throw new Error("确认文本不匹配。请输入：写入实例配置");
  const state = await readFactoryJobs();
  const readyJobs = factoryJobsForAction(
    state,
    payload.name,
    (job) => ["scopes_checked", "instance_config_written", "watchdog_installed", "started"].includes(job.status)
      && job.scopes?.checkedAt
      && !(job.scopes?.missing || []).length,
    "没有权限完整且可写入实例配置的 job。请先创建飞书 APP/profile，并确认 missing 为 0。",
  );

  const raw = JSON.stringify(await readWritableInstancesConfig());
  if (!raw) throw new Error(`bridge.instances.json 不存在：${instancesConfigPath}`);
  const config = JSON.parse(raw);
  const instances = Array.isArray(config.instances) ? config.instances : [];
  const existing = new Set(instances.map((item) => item.name || item.id).filter(Boolean));
  const appended = [];
  for (const job of readyJobs) {
    if (existing.has(job.name)) {
      job.status = job.status === "profile_created" || job.status === "scopes_checked" ? "instance_config_written" : job.status;
      job.updatedAt = new Date().toISOString();
      continue;
    }
    const block = {
      id: job.name,
      name: job.name,
      label: job.label,
      group: job.group,
      larkProfile: job.larkProfile,
      runtimeRoot: job.runtimeRoot,
      workspace: job.workspace,
      codexHome: job.codexHome,
      desktopCodexHome: job.desktopCodexHome,
      taskName: job.taskName,
    };
    instances.push(block);
    existing.add(job.name);
    appended.push(block);
    if (job.status === "scopes_checked") job.status = "instance_config_written";
    job.updatedAt = new Date().toISOString();
    job.lastError = "";
  }
  config.instances = instances;
  const configPath = await writeWritableInstancesConfig(config);

  return {
    ok: true,
    action: "append-instances",
    configPath,
    appended,
    ...(await writeFactoryJobs(state)),
  };
}

function jobScriptArgs(job) {
  const args = [
    "-Name",
    job.name,
    "-LarkProfile",
    job.larkProfile || job.name,
    "-Workspace",
    job.workspace,
    "-CodexHome",
    job.codexHome,
  ];
  if (job.desktopCodexHome) args.push("-DesktopCodexHome", job.desktopCodexHome);
  return args;
}

async function installFactoryWatchdogs(payload) {
  const confirm = String(payload.confirm || "").trim();
  if (confirm !== "安装新watchdog") throw new Error("确认文本不匹配。请输入：安装新watchdog");
  const state = await readFactoryJobs();
  const jobs = factoryJobsForAction(
    state,
    payload.name,
    (job) => job.status === "instance_config_written",
    "没有可安装 watchdog 的 job。请先写入实例配置。",
  );
  const results = [];
  for (const job of jobs) {
    const result = await runScript(path.join(__dirname, "install-codex-feishu-watchdog.ps1"), jobScriptArgs(job), 60_000);
    job.updatedAt = new Date().toISOString();
    if (result.ok) {
      if (job.status === "instance_config_written") job.status = "watchdog_installed";
      job.lastError = "";
    } else {
      job.status = "failed";
      job.lastError = result.stderr || result.error || "install watchdog failed";
    }
    results.push({ name: job.name, ok: result.ok, stdout: result.stdout, stderr: result.stderr, error: result.error });
  }
  return {
    ok: results.every((item) => item.ok),
    action: "install-watchdogs",
    results,
    ...(await writeFactoryJobs(state)),
  };
}

async function startFactoryBots(payload) {
  const confirm = String(payload.confirm || "").trim();
  if (confirm !== "启动新Bot") throw new Error("确认文本不匹配。请输入：启动新Bot");
  const state = await readFactoryJobs();
  const jobs = factoryJobsForAction(
    state,
    payload.name,
    (job) => job.status === "watchdog_installed",
    "没有可启动的 job。请先安装 watchdog。",
  );
  const results = [];
  for (const job of jobs) {
    const args = [...jobScriptArgs(job), "-EnableMcp"];
    const result = await runScript(startBridgeScript, args, 60_000);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const pid = parsePid(await readTextFile(path.join(job.runtimeRoot, "state", "bridge.pid")));
    job.updatedAt = new Date().toISOString();
    if (result.ok && pid) {
      job.status = "started";
      job.pid = pid;
      job.lastError = "";
    } else {
      job.status = "failed";
      job.lastError = result.stderr || result.error || "start bridge failed";
    }
    results.push({ name: job.name, ok: result.ok && Boolean(pid), pid, stdout: result.stdout, stderr: result.stderr, error: result.error });
  }
  return {
    ok: results.every((item) => item.ok),
    action: "start-bots",
    results,
    ...(await writeFactoryJobs(state)),
  };
}

function buildFactoryPreview(payload) {
  const factory = validateFactoryPayload(payload);
  const config = loadInstancesConfig();
  const paths = config.paths || {};
  const knownNames = new Set((config.instances || []).map((item) => item.name || item.id).filter(Boolean));
  const knownTaskNames = new Set((config.instances || []).map((item) => item.taskName).filter(Boolean));
  const globalCodexHome = paths.codexHome || path.join(os.homedir(), ".codex");
  const sourceRoot = paths.sourceRoot || __dirname;
  const instances = [];

  for (let offset = 0; offset < factory.count; offset += 1) {
    const index = factory.baseIndex + offset;
    const name = renderPattern(factory.instanceNamePattern, index, factory).replace(/[^A-Za-z0-9_.-]/g, "-");
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`实例名生成后不合法：${name}`);
    const label = renderPattern(factory.displayNamePattern, index, factory);
    const workspace = path.join(factory.workspaceRoot, `feishu-bridge-${name}`);
    const runtimeRootForInstance = name === "default" ? runtimeRoot : path.join(runtimeRoot, "instances", name);
    const taskName = name === "default" ? "CodexFeishuBridgeWatchdog" : `CodexFeishuBridgeWatchdog-${name}`;
    const registerArgs = [
      "node",
      path.join(sourceRoot, "register-codex-feishu-bot.mjs"),
      "--name",
      name,
      "--profile",
      name,
      "--display-name",
      label,
      "--description",
      factory.description,
      "--workspace",
      workspace,
      "--codex-home",
      factory.codexHome,
      "--desktop-codex-home",
      globalCodexHome,
      "--brand",
      factory.brand,
      "--install-startup",
      "--enable-mcp",
    ];
    for (const avatarUrl of factory.avatarUrls) {
      registerArgs.push("--avatar-url", avatarUrl);
    }

    instances.push({
      id: name,
      name,
      label,
      group: factory.slug,
      larkProfile: name,
      runtimeRoot: runtimeRootForInstance,
      workspace,
      codexHome: factory.codexHome,
      desktopCodexHome: globalCodexHome,
      taskName,
      conflicts: {
        instanceName: knownNames.has(name),
        taskName: knownTaskNames.has(taskName),
        workspacePath: existsSync(workspace),
        runtimeRoot: existsSync(runtimeRootForInstance),
      },
      commands: {
        registerAndInstall: registerArgs.map(quoteCommandArg).join(" "),
        startBridge: [
          "powershell.exe",
          "-NoProfile",
          "-File",
          path.join(sourceRoot, "start-codex-feishu-bridge.ps1"),
          "-Name",
          name,
          "-LarkProfile",
          name,
          "-Workspace",
          workspace,
          "-CodexHome",
          factory.codexHome,
          "-DesktopCodexHome",
          globalCodexHome,
          "-EnableMcp",
        ].map(quoteCommandArg).join(" "),
        installWatchdog: [
          "powershell.exe",
          "-NoProfile",
          "-File",
          path.join(sourceRoot, "install-codex-feishu-watchdog.ps1"),
          "-Name",
          name,
          "-LarkProfile",
          name,
          "-Workspace",
          workspace,
          "-CodexHome",
          factory.codexHome,
        ].map(quoteCommandArg).join(" "),
      },
    });
  }

  const instanceBlocks = instances.map((item) => ({
    id: item.id,
    name: item.name,
    label: item.label,
    group: item.group,
    larkProfile: item.larkProfile,
    runtimeRoot: item.runtimeRoot,
    workspace: item.workspace,
    codexHome: item.codexHome,
    desktopCodexHome: item.desktopCodexHome,
    taskName: item.taskName,
  }));

  return {
    ok: true,
    mode: "preview-only",
    generatedAt: new Date().toISOString(),
    warning: "当前接口只做预览，不创建飞书 APP，不授权，不写 bridge.instances.json，不启动或重启 Bot。",
    inputs: factory,
    paths: {
      sourceRoot,
      runtimeRoot,
      workspaceRoot: factory.workspaceRoot,
      codexHomeRoot: factory.codexHomeRoot,
      spaceCodexHome: factory.codexHome,
      desktopCodexHome: globalCodexHome,
      codexConfig: paths.codexConfig || codexConfigPath,
      bridgeInstancesJson: instancesConfigPath,
      registerScript: path.join(sourceRoot, "register-codex-feishu-bot.mjs"),
      startScript: startBridgeScript,
      installWatchdogScript: path.join(sourceRoot, "install-codex-feishu-watchdog.ps1"),
    },
    scopesBaseline: {
      profile: factory.baselineProfile,
      note: "权限基准通过 /api/factory/scopes-baseline 动态读取，不在预览里硬编码。",
    },
    localPrepare: {
      confirmText: "初始化本地空间",
      copiesByDefault: ["safe config.toml", "AGENTS.md"],
      note: "本地初始化只创建 workspace/Codex Home/manifest，并复制勾选的 skills/MCP 配置；不会创建飞书 APP 或启动 Bot。",
    },
    bridgeInstancesAppendPreview: instanceBlocks,
    instances,
  };
}

function resolveLarkCliTool() {
  if (process.platform !== "win32") return { command: "lark-cli", argsPrefix: [] };
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const candidates = [
    path.join(appData, "npm", "lark-cli.cmd"),
    path.join(appData, "npm", "node_modules", "@larksuite", "cli", "bin", "lark-cli.cmd"),
  ];
  const cmd = candidates.find((item) => existsSync(item)) || "lark-cli.cmd";
  return { command: "cmd.exe", argsPrefix: ["/d", "/s", "/c", cmd] };
}

function runLarkCli(args, options = {}) {
  const larkCli = resolveLarkCliTool();
  let command = larkCli.command;
  let commandArgs = [...larkCli.argsPrefix, ...args];
  if (process.platform === "win32" && path.basename(command).toLowerCase() === "cmd.exe" && larkCli.argsPrefix.length >= 4) {
    commandArgs = ["/d", "/s", "/c", [larkCli.argsPrefix[3], ...args].map(quoteCommandArg).join(" ")];
  }
  return new Promise((resolve) => {
    execFile(
      command,
      commandArgs,
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: options.timeoutMs || 60_000,
        maxBuffer: options.maxBuffer || 2 * 1024 * 1024,
        cwd: options.cwd || process.cwd(),
        env: {
          ...process.env,
          LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
          LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
        },
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          exitCode: error && typeof error.code === "number" ? error.code : 0,
          command: [command, ...commandArgs].map(quoteCommandArg).join(" "),
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          error: error ? error.message : "",
        });
      },
    );
  });
}

function parseFirstJson(text) {
  const raw = String(text || "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("输出中没有 JSON");
  return JSON.parse(raw.slice(start, end + 1));
}

function publicAuthInfo(auth) {
  if (!auth) return null;
  return {
    status: auth.status || "",
    requestedAt: auth.requestedAt || "",
    completedAt: auth.completedAt || "",
    expiresAt: auth.expiresAt || "",
    verificationUrl: auth.verificationUrl || "",
    qrImage: auth.qrImage || "",
    profile: auth.profile || "",
    lastError: auth.lastError || "",
  };
}

function publicFactoryJob(job) {
  if (!job) return job;
  const clone = { ...job };
  if (clone.auth) clone.auth = publicAuthInfo(clone.auth);
  return clone;
}

function publicFactoryState(state) {
  return {
    ...(state || {}),
    jobs: (state?.jobs || []).map(publicFactoryJob),
  };
}

function readFactoryScopesBaseline(profile) {
  const larkProfile = optionalString(profile, 120) || "codex-assistant-1";
  if (!/^[A-Za-z0-9_.-]+$/.test(larkProfile)) throw new Error("profile 名称不合法");
  return new Promise((resolve) => {
    runLarkCli(["auth", "scopes", "--json", "--profile", larkProfile], { timeoutMs: 30_000 }).then((result) => {
        if (!result.ok) {
          resolve({
            ok: false,
            profile: larkProfile,
            command: result.command,
            error: result.error,
            stderr: result.stderr.slice(0, 1000),
          });
          return;
        }
        const jsonStart = result.stdout.indexOf("{");
        const jsonEnd = result.stdout.lastIndexOf("}");
        if (jsonStart < 0 || jsonEnd < jsonStart) {
          resolve({
            ok: false,
            profile: larkProfile,
            command: result.command,
            error: "lark-cli 没有返回 JSON",
            stdout: result.stdout.slice(0, 1000),
            stderr: result.stderr.slice(0, 1000),
          });
          return;
        }
        try {
          const parsed = JSON.parse(result.stdout.slice(jsonStart, jsonEnd + 1));
          const scopes = Array.isArray(parsed.userScopes)
            ? parsed.userScopes
            : Array.isArray(parsed.scopes)
              ? parsed.scopes
              : [];
          resolve({
            ok: true,
            profile: larkProfile,
            appId: parsed.appId || "",
            brand: parsed.brand || "",
            tokenType: parsed.tokenType || "",
            count: Number(parsed.count || scopes.length),
            scopes,
            command: result.command,
          });
        } catch (parseError) {
          resolve({
            ok: false,
            profile: larkProfile,
            command: result.command,
            error: parseError instanceof Error ? parseError.message : String(parseError),
            stdout: result.stdout.slice(0, 1000),
            stderr: result.stderr.slice(0, 1000),
          });
        }
      });
  });
}

function validateProviderId(value) {
  const id = requireString(value, "provider id", 80);
  if (!/^[A-Za-z0-9_.-]+$/.test(id)) {
    throw new Error("provider id 只能包含英文字母、数字、下划线、点和短横线");
  }
  return id;
}

function validateProviderPayload(payload) {
  const id = validateProviderId(payload.id);

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
    serviceTierPassthrough:
      payload.serviceTierPassthrough === true
      || String(payload.serviceTierPassthrough || "").toLowerCase() === "true",
  };
}

function providerApiKeyFromPayload(payload) {
  const apiKey = optionalString(payload.apiKey, 4000);
  if (/[\r\n]/.test(apiKey)) throw new Error("API Key 不能包含换行");
  return apiKey;
}

function providerRuntimeKey(provider, apiKey = "") {
  return apiKey || environmentVariableValue(provider.envKey) || "";
}

async function setUserEnvironmentVariable(name, value, options = {}) {
  const clearExisting = Boolean(options.clearExisting);
  const tempName = `codex-feishu-env-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const scriptPath = path.join(os.tmpdir(), `${tempName}.ps1`);
  const valuePath = path.join(os.tmpdir(), `${tempName}.txt`);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$name = $env:CODEX_FEISHU_ENV_NAME",
    "$valuePath = $env:CODEX_FEISHU_ENV_VALUE_FILE",
    "$clearExisting = $env:CODEX_FEISHU_ENV_CLEAR_EXISTING -eq '1'",
    "if ([string]::IsNullOrWhiteSpace($name)) { throw 'Environment variable name is empty.' }",
    "if ([string]::IsNullOrWhiteSpace($valuePath)) { throw 'Environment variable value file is empty.' }",
    "if (-not (Test-Path -LiteralPath $valuePath)) { throw 'Environment variable value file is missing.' }",
    "$value = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($valuePath))",
    "if ($clearExisting) {",
    "  Remove-Item -Path ('Env:' + $name) -ErrorAction SilentlyContinue",
    "  [Environment]::SetEnvironmentVariable($name, $null, 'User')",
    "}",
    "[Environment]::SetEnvironmentVariable($name, $value, 'User')",
  ].join("\n");

  try {
    await writeFile(valuePath, value, "utf8");
    await writeFile(scriptPath, script, "utf8");
    await new Promise((resolve, reject) => {
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          scriptPath,
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 15_000,
          maxBuffer: 256 * 1024,
          env: {
            ...process.env,
            CODEX_FEISHU_ENV_NAME: name,
            CODEX_FEISHU_ENV_VALUE_FILE: valuePath,
            CODEX_FEISHU_ENV_CLEAR_EXISTING: clearExisting ? "1" : "0",
          },
        },
        (error, stdout, stderr) => {
          if (error) {
            const detail = [stderr, stdout, error.message].filter(Boolean).join("\n").trim();
            reject(new Error(redactSensitiveText(`PowerShell user environment update failed: ${detail}`, [value])));
            return;
          }
          resolve();
        },
      );
    });
    if (clearExisting) delete process.env[name];
    process.env[name] = value;
  } finally {
    await Promise.all([
      unlink(valuePath).catch(() => {}),
      unlink(scriptPath).catch(() => {}),
    ]);
  }
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
    ...(provider.serviceTierPassthrough ? ["service_tier_passthrough = true"] : []),
    "",
  ].join("\n");
}

async function ensureProviderCanBeAdded(provider, apiKey = "") {
  const config = await readCodexConfig();
  if (config.providers.some((item) => item.id === provider.id)) {
    throw new Error(`provider 已存在：${provider.id}`);
  }
  if (!providerRuntimeKey(provider, apiKey)) {
    throw new Error(`当前控制面板进程看不到环境变量 ${provider.envKey}，也没有收到 API Key。请填写 API Key 或先设置用户环境变量。`);
  }
  return config;
}

async function appendProviderToConfig(provider, apiKey = "") {
  await ensureProviderCanBeAdded(provider, apiKey);
  const currentText = (await readTextFile(codexConfigPath)) || "";
  const nextText = `${currentText.replace(/\s*$/, "\n")}${providerTomlBlock(provider)}`;
  await writeFile(codexConfigPath, nextText, "utf8");
  return readCodexConfig();
}

async function replaceProviderEnvironmentVariable(providerId, apiKey, model, submittedEnvKey = "") {
  if (!apiKey) throw new Error("替换环境变量必须填写新的 API Key");
  const config = await readCodexConfig();
  const provider = config.providers.find((item) => item.id === providerId);
  if (!provider) {
    throw new Error(`provider 不存在：${providerId}。请先新增 provider，或确认 provider id 是否正确。`);
  }
  if (!provider.envKey) {
    throw new Error(`provider ${providerId} 没有 env_key，无法替换环境变量。`);
  }
  if (submittedEnvKey && submittedEnvKey !== provider.envKey) {
    throw new Error(`env_key 与现有 provider 不一致。当前 ${providerId} 使用 ${provider.envKey}。`);
  }

  const models = await providerModels(provider, apiKey);
  const test = await providerResponsesTest(provider, model, apiKey);
  await setUserEnvironmentVariable(provider.envKey, apiKey, { clearExisting: true });
  return {
    provider,
    model,
    models,
    test,
    envKey: provider.envKey,
    envReplaced: true,
    configPath: codexConfigPath,
    config: await readCodexConfig(),
  };
}

async function providerModels(provider, apiKey = "") {
  const key = providerRuntimeKey(provider, apiKey);
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

async function providerResponsesTest(provider, model, apiKey = "") {
  const key = providerRuntimeKey(provider, apiKey);
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
  let payload = {};
  try {
    payload = JSON.parse(text);
  } catch {
    // Some compatible providers may not return strict JSON on success.
  }
  if (!response.ok) {
    const lower = text.toLowerCase();
    const requestShapeLikelyUnsupported =
      response.status === 400
      && /invalid.*request|invalid_responses_request|unsupported|unknown parameter|bad request/.test(lower);
    return {
      ok: false,
      level: requestShapeLikelyUnsupported ? "warn" : "bad",
      elapsedMs: Date.now() - started,
      httpStatus: response.status,
      responseId: payload.id || "",
      error: text.slice(0, 800),
      note: requestShapeLikelyUnsupported
        ? "模型列表已连通，但控制面板的轻量 /responses 探针请求形状被该 provider 拒绝；这不等于飞书 Bot 已保存的 provider 不能用。"
        : "provider 返回非成功状态；如果飞书 Bot 仍能运行，以 Bot 实际请求结果为准。",
    };
  }
  return {
    ok: true,
    level: "good",
    elapsedMs: Date.now() - started,
    httpStatus: response.status,
    responseId: payload.id || "",
    note: "轻量 /responses 探针成功。",
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
  const problemLines = lines.filter(isRecentProblemLine);
  return problemLines.slice(-5).map((line) => line.slice(0, 600));
}

function isRecentProblemLine(line) {
  if (isIgnorableRecentProblemLine(line)) return false;
  const level = line.match(/^\S+\s+([A-Z]+)\b/)?.[1] || "";
  if (["INFO", "DEBUG", "TRACE"].includes(level)) return false;
  if (["WARN", "ERROR"].includes(level)) return true;
  return /\bfailed\b|失败|\bunknown error\b|未知错误|\bexception\b|\b(?:HTTP\s*)?502\b/i.test(line);
}

function isIgnorableRecentProblemLine(line) {
  if (/WARN event consumer stderr/i.test(line)) {
    return /\[source\] feishu-websocket: connected|\[event\] listening for events|\[event\] to stop gracefully|\[event\] started bus daemon|\[event\] remote connection check: online_instance_cnt=0|\[event\] consuming as |\[event\] local bus not found; checking remote connections/i.test(line);
  }
  if (/WARN codex global state watcher unavailable/i.test(line)) {
    return /ENOENT: no such file or directory.+\.codex-global-state\.json/i.test(line);
  }
  return false;
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
        envSource: "",
        serviceTierPassthrough: false,
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
      if (key === "service_tier_passthrough" || key === "supports_service_tier") {
        currentProvider.serviceTierPassthrough = String(value).toLowerCase() === "true";
      }
      if (key === "env_key") {
        currentProvider.envKey = value;
        currentProvider.envVisible = Boolean(environmentVariableValue(value));
        currentProvider.envSource = environmentVariableSource(value);
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

function directoryRecord(filePath, rootPath, type, name = "") {
  return {
    name: name || path.basename(filePath),
    type,
    path: filePath,
    root: rootPath,
    removable: Boolean(rootPath && filePath && isPathInside(filePath, rootPath) && path.resolve(filePath) !== path.resolve(rootPath)),
  };
}

async function listChildDirectories(rootPath) {
  try {
    const entries = await readdir(rootPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(rootPath, entry.name));
  } catch {
    return [];
  }
}

function knownInstanceNames(config = loadInstancesConfig()) {
  return new Set(instanceDescriptors(config).map((item) => item.name).filter(Boolean));
}

function expectedWorkspaceNameForInstance(name) {
  return `feishu-bridge-${name}`;
}

function residualBotNameFromWorkspace(dirName) {
  return dirName.startsWith("feishu-bridge-") ? dirName.slice("feishu-bridge-".length) : "";
}

async function buildResidualCleanupItems(config = loadInstancesConfig()) {
  const roots = cleanupRoots(config);
  const knownNames = knownInstanceNames(config);
  const itemsByPath = new Map();

  const workspaceDirs = await listChildDirectories(roots.workspaceRoot);
  for (const dirPath of workspaceDirs) {
    const dirName = path.basename(dirPath);
    const botName = residualBotNameFromWorkspace(dirName);
    if (!botName || knownNames.has(botName) || !botName.includes("-writing")) continue;
    itemsByPath.set(path.resolve(dirPath).toLowerCase(), {
      botName,
      displayName: botName,
      reason: "workspace exists but bot is not listed in bridge.instances.json",
      records: [directoryRecord(dirPath, roots.workspaceRoot, "workspace", dirName)],
    });
  }

  const registrationDirs = await listChildDirectories(roots.registrationsRoot);
  for (const dirPath of registrationDirs) {
    const botName = path.basename(dirPath);
    if (!botName.includes("-writing") || knownNames.has(botName)) continue;
    const key = path.resolve(dirPath).toLowerCase();
    const existing = [...itemsByPath.values()].find((item) => item.botName === botName);
    const target = existing || {
      botName,
      displayName: botName,
      reason: "registration cache exists but bot is not listed in bridge.instances.json",
      records: [],
    };
    target.records.push(directoryRecord(dirPath, roots.registrationsRoot, "registration", botName));
    if (!existing) itemsByPath.set(key, target);
  }

  const runtimeDirs = await listChildDirectories(roots.instancesRoot);
  for (const dirPath of runtimeDirs) {
    const botName = path.basename(dirPath);
    if (!botName.includes("-writing") || knownNames.has(botName)) continue;
    const key = path.resolve(dirPath).toLowerCase();
    const existing = [...itemsByPath.values()].find((item) => item.botName === botName);
    const target = existing || {
      botName,
      displayName: botName,
      reason: "runtime directory exists but bot is not listed in bridge.instances.json",
      records: [],
    };
    target.records.push(directoryRecord(dirPath, roots.instancesRoot, "runtime", botName));
    if (!existing) itemsByPath.set(key, target);
  }

  return [...itemsByPath.values()]
    .map((item) => ({
      ...item,
      removable: item.records.length > 0 && item.records.every((record) => record.removable),
    }))
    .sort((a, b) => a.botName.localeCompare(b.botName));
}

async function buildFormalUninstallItems(config = loadInstancesConfig()) {
  const roots = cleanupRoots(config);
  const systemSnapshot = await getSystemSnapshot();
  const system = {
    ...systemSnapshot,
    processesByPid: processMap(systemSnapshot),
    tasksByName: taskMap(systemSnapshot),
  };
  const items = [];

  for (const descriptor of instanceDescriptors(config)) {
    const active = await hasActiveRun(descriptor);
    const pid = await readPidForDescriptor(descriptor);
    const processInfo = pid ? system.processesByPid.get(pid) : null;
    const task = descriptor.taskName ? system.tasksByName.get(descriptor.taskName) : null;
    const workspacePath = descriptor.workspace || path.join(roots.workspaceRoot, expectedWorkspaceNameForInstance(descriptor.name));
    const records = [
      directoryRecord(descriptor.runtimeRoot, descriptor.name === "default" ? runtimeRoot : roots.instancesRoot, "runtime", descriptor.name),
      directoryRecord(workspacePath, roots.workspaceRoot, "workspace", path.basename(workspacePath)),
      directoryRecord(path.join(roots.registrationsRoot, descriptor.name), roots.registrationsRoot, "registration", descriptor.name),
    ];

    items.push({
      name: descriptor.name,
      label: descriptor.label,
      group: descriptor.group || "",
      profile: descriptor.larkProfile || descriptor.name,
      taskName: descriptor.taskName,
      workspace: workspacePath,
      runtimeRoot: descriptor.runtimeRoot,
      codexHome: descriptor.codexHome,
      desktopCodexHome: descriptor.desktopCodexHome || "",
      allowed: isUninstallAllowedInstance(descriptor),
      protectedReason: isCoreInstanceName(descriptor.name)
        ? "default and codex-assistant-1..9 are protected in this first version"
        : descriptor.group
          ? ""
          : "only grouped vertical-space bots can be uninstalled here",
      activeRunCount: active.count,
      activeRunsFile: active.file,
      pid,
      online: Boolean(processInfo),
      taskState: task?.state || "not-found",
      records,
    });
  }

  return items.sort((a, b) => a.name.localeCompare(b.name));
}

async function cleanupPlan() {
  const config = loadInstancesConfig();
  const formal = await buildFormalUninstallItems(config);
  const residual = await buildResidualCleanupItems(config);
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    instancesConfigPath,
    roots: cleanupRoots(config),
    formal,
    residual,
    spaces: buildSpaceCleanupItems(config, formal, residual),
    notes: [
      "This panel only cleans local Bridge artifacts. Delete Feishu developer-console apps manually after local uninstall.",
      "Shared Codex Home directories are intentionally never deleted by per-bot uninstall.",
    ],
  };
}

function buildSpaceCleanupItems(config, formal, residual) {
  const roots = cleanupRoots(config);
  const byGroup = new Map();
  for (const item of formal || []) {
    if (!item.group || !item.allowed) continue;
    if (!byGroup.has(item.group)) {
      byGroup.set(item.group, {
        group: item.group,
        label: item.group,
        botNames: [],
        residualBotNames: [],
        codexHomes: new Set(),
        desktopCodexHomes: new Set(),
        activeRunCount: 0,
      });
    }
    const space = byGroup.get(item.group);
    space.botNames.push(item.name);
    if (item.codexHome) space.codexHomes.add(item.codexHome);
    if (item.desktopCodexHome) space.desktopCodexHomes.add(item.desktopCodexHome);
    space.activeRunCount += Number(item.activeRunCount || 0);
  }

  for (const item of residual || []) {
    const botName = String(item.botName || "");
    const group = [...byGroup.keys()].find((key) => botName.endsWith(`-${key}`));
    if (!group) continue;
    byGroup.get(group).residualBotNames.push(item.botName);
  }

  return [...byGroup.values()]
    .map((item) => {
      const codexHomes = [...item.codexHomes];
      const codexHomeRecords = codexHomes.map((codexHome) => directoryRecord(codexHome, roots.codexHomesRoot, "codexHome", path.basename(codexHome)));
      return {
        group: item.group,
        label: item.label,
        botNames: item.botNames.sort(),
        residualBotNames: item.residualBotNames.sort(),
        codexHomes,
        desktopCodexHomes: [...item.desktopCodexHomes],
        activeRunCount: item.activeRunCount,
        allowed: item.botNames.length > 0 && item.activeRunCount === 0 && codexHomeRecords.every((record) => record.removable),
        records: codexHomeRecords,
        roots,
      };
    })
    .sort((a, b) => a.group.localeCompare(b.group));
}

async function removeDirectoryRecord(record) {
  if (!record?.removable) {
    throw new Error(`Refusing to remove unsafe path: ${record?.path || ""}`);
  }
  assertPathInsideRoot(record.path, record.root, record.type || "cleanup");
  if (!(await directoryExists(record.path))) {
    return { path: record.path, action: "missing" };
  }
  await rm(record.path, { recursive: true, force: true });
  return { path: record.path, action: "removed" };
}

async function cleanupResidual(payload) {
  const name = requireString(payload.name, "Bot name", 160);
  const confirm = String(payload.confirm || "").trim();
  if (confirm !== name) throw new Error(`确认文本不匹配。请输入 Bot 名：${name}`);

  const plan = await cleanupPlan();
  const item = plan.residual.find((entry) => entry.botName === name);
  if (!item) throw new Error(`没有找到未创建残留：${name}`);
  if (!item.removable) throw new Error(`${name} 包含不安全路径，拒绝清理`);

  const removed = [];
  for (const record of item.records) {
    removed.push(await removeDirectoryRecord(record));
  }

  return {
    ok: true,
    action: "cleanup-residual",
    name,
    removed,
    plan: await cleanupPlan(),
  };
}

async function unregisterScheduledTask(taskName) {
  if (!taskName) return { ok: true, skipped: true, reason: "no task name" };
  const escaped = taskName.replace(/'/g, "''");
  const script = `
$ErrorActionPreference = "Stop"
$taskName = '${escaped}'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
  [pscustomobject]@{ ok = $true; action = "unregistered"; taskName = $taskName } | ConvertTo-Json -Depth 4
} else {
  [pscustomobject]@{ ok = $true; action = "missing"; taskName = $taskName } | ConvertTo-Json -Depth 4
}
`;
  return runPowerShell(script, 20_000);
}

async function removeInstanceFromConfig(name) {
  const raw = JSON.stringify(await readWritableInstancesConfig());
  if (!raw) throw new Error(`bridge.instances.json not found: ${instancesConfigPath}`);
  const config = JSON.parse(raw.replace(/^\uFEFF/, ""));
  const before = Array.isArray(config.instances) ? config.instances : [];
  const after = before.filter((item) => (item.name || item.id) !== name);
  if (after.length === before.length) return { removed: false, count: before.length };
  config.instances = after;
  const configPath = await writeWritableInstancesConfig(config);
  return { removed: true, before: before.length, after: after.length, path: configPath };
}

async function uninstallFormalBot(payload) {
  const name = requireString(payload.name, "Bot name", 160);
  const confirm = String(payload.confirm || "").trim();
  if (confirm !== name) throw new Error(`确认文本不匹配。请输入 Bot 名：${name}`);
  const removeWorkspace = Boolean(payload.removeWorkspace);
  const removeRegistration = payload.removeRegistration !== false;
  const removeRuntime = payload.removeRuntime !== false;

  const config = loadInstancesConfig();
  const descriptor = instanceDescriptors(config).find((item) => item.name === name || item.id === name);
  if (!descriptor) throw new Error(`未知 Bot：${name}`);
  if (!isUninstallAllowedInstance(descriptor)) {
    throw new Error(`${name} 受保护。第一版只允许卸载带 group 的垂类 Bot，不允许删除 default 或普通 1-9。`);
  }

  const active = await hasActiveRun(descriptor);
  if (active.count > 0) {
    throw new Error(`${name} 当前有 ${active.count} 个 active run，拒绝卸载。`);
  }

  const roots = cleanupRoots(config);
  const workspacePath = descriptor.workspace || path.join(roots.workspaceRoot, expectedWorkspaceNameForInstance(name));
  const runtimeRecord = directoryRecord(descriptor.runtimeRoot, roots.instancesRoot, "runtime", name);
  const registrationRecord = directoryRecord(path.join(roots.registrationsRoot, name), roots.registrationsRoot, "registration", name);
  const workspaceRecord = directoryRecord(workspacePath, roots.workspaceRoot, "workspace", path.basename(workspacePath));

  const beforePid = await readPidForDescriptor(descriptor);
  const stopResult = await runScript(stopBridgeScript, scriptArgsForInstance(name), 60_000);
  if (!stopResult.ok) {
    throw new Error(`停止 ${name} Bridge 失败：${stopResult.error || stopResult.stderr || "unknown error"}`);
  }
  const taskResult = await unregisterScheduledTask(descriptor.taskName);
  const configResult = await removeInstanceFromConfig(name);

  const removed = [];
  if (removeRuntime) removed.push(await removeDirectoryRecord(runtimeRecord));
  if (removeRegistration) removed.push(await removeDirectoryRecord(registrationRecord));
  if (removeWorkspace) removed.push(await removeDirectoryRecord(workspaceRecord));

  return {
    ok: true,
    action: "uninstall-formal-bot",
    name,
    beforePid,
    stopResult,
    taskResult,
    configResult,
    removed,
    kept: {
      workspace: removeWorkspace ? "" : workspacePath,
      codexHome: descriptor.codexHome,
      desktopCodexHome: descriptor.desktopCodexHome || "",
      larkProfile: descriptor.larkProfile || name,
      feishuApp: "Delete manually in Feishu developer console if no longer needed.",
    },
    plan: await cleanupPlan(),
  };
}

async function uninstallSpace(payload) {
  const group = requireString(payload.group, "Space group", 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(group)) throw new Error(`空间 group 不合法：${group}`);
  const confirm = String(payload.confirm || "").trim();
  if (confirm !== group) throw new Error(`确认文本不匹配。请输入空间 slug：${group}`);
  const removeWorkspaces = payload.removeWorkspaces !== false;
  const removeResidual = payload.removeResidual !== false;
  const removeCodexHome = payload.removeCodexHome !== false;

  const plan = await cleanupPlan();
  const space = (plan.spaces || []).find((item) => item.group === group);
  if (!space) throw new Error(`没有找到空间：${group}`);
  if (!space.allowed) {
    throw new Error(`${group} 当前不可卸载。请确认该空间有正式 Bot、没有 active run，且路径都在安全根目录内。`);
  }

  const formalResults = [];
  for (const name of space.botNames) {
    formalResults.push(await uninstallFormalBot({
      name,
      confirm: name,
      removeRuntime: true,
      removeRegistration: true,
      removeWorkspace: removeWorkspaces,
    }));
  }

  const residualResults = [];
  if (removeResidual) {
    for (const name of space.residualBotNames || []) {
      try {
        residualResults.push(await cleanupResidual({ name, confirm: name }));
      } catch (error) {
        residualResults.push({ ok: false, name, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  const codexHomeResults = [];
  if (removeCodexHome) {
    const refreshed = await cleanupPlan();
    const refreshedSpace = (refreshed.spaces || []).find((item) => item.group === group) || space;
    for (const record of refreshedSpace.records || space.records || []) {
      codexHomeResults.push(await removeDirectoryRecord(record));
    }
  }

  return {
    ok: true,
    action: "uninstall-space",
    group,
    formalResults: formalResults.map((item) => ({
      name: item.name,
      beforePid: item.beforePid,
      removed: item.removed,
      kept: item.kept,
    })),
    residualResults,
    codexHomeResults,
    note: "Feishu developer-console apps and lark-cli profiles are not deleted automatically.",
    plan: await cleanupPlan(),
  };
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

  if (url.pathname === "/api/cleanup/plan") {
    try {
      jsonResponse(res, 200, await cleanupPlan());
    } catch (error) {
      jsonResponse(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/cleanup/residual") {
    try {
      jsonResponse(res, 200, await cleanupResidual(await readRequestJson(req)));
    } catch (error) {
      jsonResponse(res, 400, {
        ok: false,
        error: errorMessage(error),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/cleanup/uninstall") {
    try {
      jsonResponse(res, 200, await uninstallFormalBot(await readRequestJson(req)));
    } catch (error) {
      jsonResponse(res, 400, {
        ok: false,
        error: errorMessage(error),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/cleanup/space-uninstall") {
    try {
      jsonResponse(res, 200, await uninstallSpace(await readRequestJson(req)));
    } catch (error) {
      jsonResponse(res, 400, {
        ok: false,
        error: errorMessage(error, [body?.apiKey]),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/factory/preview") {
    try {
      jsonResponse(res, 200, buildFactoryPreview(await readRequestJson(req)));
    } catch (error) {
      jsonResponse(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (url.pathname === "/api/factory/sources") {
    try {
      jsonResponse(res, 200, await listFactorySources());
    } catch (error) {
      jsonResponse(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/factory/prepare-local") {
    try {
      jsonResponse(res, 200, await prepareFactoryLocalSpace(await readRequestJson(req, 256_000)));
    } catch (error) {
      jsonResponse(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (url.pathname === "/api/factory/jobs") {
    try {
      jsonResponse(res, 200, await factoryJobsStatus());
    } catch (error) {
      jsonResponse(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (url.pathname === "/api/factory/jobs/qr") {
    try {
      const image = await readFactoryJobQr(url.searchParams.get("name"));
      binaryResponse(res, 200, image.body, "image/png");
    } catch (error) {
      jsonResponse(res, 404, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (url.pathname === "/api/factory/jobs/auth-qr") {
    try {
      const image = await readFactoryJobAuthQr(url.searchParams.get("name"));
      binaryResponse(res, 200, image.body, "image/png");
    } catch (error) {
      jsonResponse(res, 404, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/factory/jobs/create") {
    try {
      jsonResponse(res, 200, await createFactoryJobQueue(await readRequestJson(req, 256_000)));
    } catch (error) {
      jsonResponse(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/factory/jobs/register-next") {
    try {
      jsonResponse(res, 200, await startNextFactoryRegistration(await readRequestJson(req)));
    } catch (error) {
      jsonResponse(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/factory/jobs/remove-pending") {
    try {
      jsonResponse(res, 200, await removePendingFactoryJob(await readRequestJson(req)));
    } catch (error) {
      jsonResponse(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/factory/jobs/reset-view") {
    try {
      jsonResponse(res, 200, await resetFactoryJobsView(await readRequestJson(req)));
    } catch (error) {
      jsonResponse(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/factory/jobs/start-auth") {
    try {
      jsonResponse(res, 200, await startFactoryJobAuth(await readRequestJson(req)));
    } catch (error) {
      jsonResponse(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/factory/jobs/complete-auth") {
    try {
      jsonResponse(res, 200, await completeFactoryJobAuth(await readRequestJson(req)));
    } catch (error) {
      jsonResponse(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/factory/jobs/check-scopes") {
    try {
      jsonResponse(res, 200, await checkFactoryJobScopes(await readRequestJson(req)));
    } catch (error) {
      jsonResponse(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/factory/jobs/append-instances") {
    try {
      jsonResponse(res, 200, await appendFactoryInstancesToConfig(await readRequestJson(req)));
    } catch (error) {
      jsonResponse(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/factory/jobs/install-watchdogs") {
    try {
      jsonResponse(res, 200, await installFactoryWatchdogs(await readRequestJson(req)));
    } catch (error) {
      jsonResponse(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/factory/jobs/start-bots") {
    try {
      jsonResponse(res, 200, await startFactoryBots(await readRequestJson(req)));
    } catch (error) {
      jsonResponse(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (url.pathname === "/api/factory/scopes-baseline") {
    try {
      const body = req.method === "POST" ? await readRequestJson(req) : {};
      const profile = body.profile || url.searchParams.get("profile") || "codex-assistant-1";
      jsonResponse(res, 200, await readFactoryScopesBaseline(profile));
    } catch (error) {
      jsonResponse(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/provider/preview") {
    let apiKeyForError = "";
    try {
      const body = await readRequestJson(req);
      const provider = validateProviderPayload(body);
      const apiKey = providerApiKeyFromPayload(body);
      apiKeyForError = apiKey;
      const models = await providerModels(provider, apiKey);
      jsonResponse(res, 200, {
        ok: true,
        provider,
        models,
        toml: providerTomlBlock(provider).trim(),
        envVisible: Boolean(providerRuntimeKey(provider, apiKey)),
        apiKeyProvided: Boolean(apiKey),
      });
    } catch (error) {
      jsonResponse(res, 400, {
        ok: false,
        error: errorMessage(error, [apiKeyForError]),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/provider/test") {
    let apiKeyForError = "";
    try {
      const body = await readRequestJson(req);
      const provider = validateProviderPayload(body);
      const apiKey = providerApiKeyFromPayload(body);
      apiKeyForError = apiKey;
      const model = requireString(body.model, "测试模型 ID", 160);
      const result = await providerResponsesTest(provider, model, apiKey);
      jsonResponse(res, 200, {
        ok: true,
        provider,
        model,
        envVisible: Boolean(providerRuntimeKey(provider, apiKey)),
        apiKeyProvided: Boolean(apiKey),
        result,
      });
    } catch (error) {
      jsonResponse(res, 400, {
        ok: false,
        error: errorMessage(error, [apiKeyForError]),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/provider/add") {
    let apiKeyForError = "";
    try {
      const body = await readRequestJson(req);
      const provider = validateProviderPayload(body);
      const apiKey = providerApiKeyFromPayload(body);
      apiKeyForError = apiKey;
      const model = requireString(body.model, "测试模型 ID", 160);
      if (body.confirm !== provider.id) {
        throw new Error("确认文本不匹配。请在确认框输入 provider id。");
      }
      await ensureProviderCanBeAdded(provider, apiKey);
      const models = await providerModels(provider, apiKey);
      const test = await providerResponsesTest(provider, model, apiKey);
      let envWritten = false;
      if (apiKey) {
        await setUserEnvironmentVariable(provider.envKey, apiKey);
        envWritten = true;
      }
      const config = await appendProviderToConfig(provider, apiKey);
      jsonResponse(res, 200, {
        ok: true,
        provider,
        model,
        models,
        test,
        envWritten,
        envKey: provider.envKey,
        configPath: codexConfigPath,
        config,
      });
    } catch (error) {
      jsonResponse(res, 400, {
        ok: false,
        error: errorMessage(error, [apiKeyForError]),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/provider/replace-env") {
    let apiKeyForError = "";
    try {
      const body = await readRequestJson(req);
      const providerId = validateProviderId(body.id);
      const apiKey = providerApiKeyFromPayload(body);
      apiKeyForError = apiKey;
      const model = requireString(body.model, "测试模型 ID", 160);
      const submittedEnvKey = optionalString(body.envKey, 120);
      if (body.confirm !== providerId) {
        throw new Error("确认文本不匹配。请在确认框输入 provider id。");
      }
      const result = await replaceProviderEnvironmentVariable(providerId, apiKey, model, submittedEnvKey);
      jsonResponse(res, 200, {
        ok: true,
        ...result,
      });
    } catch (error) {
      jsonResponse(res, 400, {
        ok: false,
        error: errorMessage(error, [apiKeyForError]),
      });
    }
    return;
  }

  if (url.pathname === "/api/provider/sync-preview") {
    try {
      jsonResponse(res, 200, await buildProviderSyncPlan({ apply: false }));
    } catch (error) {
      jsonResponse(res, 500, {
        ok: false,
        error: errorMessage(error),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/provider/sync-spaces") {
    try {
      const body = await readRequestJson(req);
      if (body.confirm !== "同步Provider到空间") {
        throw new Error("确认文本不匹配。请输入：同步Provider到空间");
      }
      jsonResponse(res, 200, await buildProviderSyncPlan({ apply: true }));
    } catch (error) {
      jsonResponse(res, 400, {
        ok: false,
        error: errorMessage(error),
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
