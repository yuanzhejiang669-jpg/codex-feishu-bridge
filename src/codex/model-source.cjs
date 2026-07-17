const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function canonicalPath(value) {
  const resolved = path.resolve(String(value || "").trim());
  try { return fs.realpathSync.native(resolved); } catch { return resolved; }
}

function pathKey(value) {
  return canonicalPath(value).toLowerCase();
}

function readUtf8(file) {
  try { return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""); } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function topLevelString(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(text || "").match(new RegExp(`^\\s*${escaped}\\s*=\\s*(["'])(.*?)\\1\\s*(?:#.*)?$`, "m"));
  return match?.[2]?.trim() || "";
}

function providerDefinitions(text, envValue = (name) => process.env[name] || "") {
  const source = String(text || "");
  const tables = [...source.matchAll(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/gm)];
  return tables.map((table, tableIndex) => {
    const providerMatch = table[1].trim().match(/^model_providers\.([A-Za-z0-9_.-]+)$/);
    if (!providerMatch) return null;
    const body = source.slice(table.index + table[0].length, tables[tableIndex + 1]?.index ?? source.length);
    const stringValue = (name) => topLevelString(body, name);
    const envKey = stringValue("env_key");
    return {
      id: providerMatch[1],
      name: stringValue("name") || providerMatch[1],
      baseUrl: stringValue("base_url"),
      wireApi: stringValue("wire_api"),
      envKey,
      credentialAvailable: envKey ? Boolean(envValue(envKey)) : null,
    };
  }).filter(Boolean).sort((left, right) => left.id.localeCompare(right.id));
}

function inspectCodexHome(codexHome, options = {}) {
  const resolved = canonicalPath(codexHome);
  const configPath = path.join(resolved, "config.toml");
  const text = readUtf8(configPath);
  const currentProvider = topLevelString(text, "model_provider") || "openai";
  return {
    codexHome: resolved,
    configPath,
    exists: fs.existsSync(resolved),
    currentProvider,
    currentModel: topLevelString(text, "model"),
    sourceKind: currentProvider === "openai" ? "openai" : "third-party",
    providers: providerDefinitions(text, options.envValue),
  };
}

function discoverCodexHomes({ globalHome, roots = [], bindings = [] } = {}) {
  const homes = new Map();
  const add = (value, source, bot = null) => {
    if (!String(value || "").trim()) return;
    const resolved = canonicalPath(value);
    const key = pathKey(resolved);
    if (!homes.has(key)) homes.set(key, { codexHome: resolved, sources: new Set(), bots: [] });
    const item = homes.get(key);
    item.sources.add(source);
    if (bot && !item.bots.some((entry) => entry.name === bot.name && entry.owner === bot.owner)) item.bots.push(bot);
  };
  add(globalHome || path.join(os.homedir(), ".codex"), "global");
  for (const binding of bindings) add(binding.codexHome, binding.source || "binding", binding.bot || null);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) add(path.join(root, entry.name), "discovered");
    }
  }
  return [...homes.values()].map((item) => ({
    codexHome: item.codexHome,
    sources: [...item.sources],
    bots: item.bots.sort((left, right) => left.name.localeCompare(right.name)),
  })).sort((left, right) => left.codexHome.localeCompare(right.codexHome));
}

function setTopLevelString(text, name, value) {
  const lines = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  const replacement = `${name} = ${JSON.stringify(String(value))}`;
  let inTopLevel = true;
  let replaced = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) inTopLevel = false;
    if (inTopLevel && new RegExp(`^\\s*${name}\\s*=`).test(lines[index])) {
      lines[index] = replacement;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    let insertAt = lines.findIndex((line) => /^\s*\[/.test(line));
    if (insertAt < 0) insertAt = lines.length;
    while (insertAt > 0 && lines[insertAt - 1] === "") insertAt -= 1;
    lines.splice(insertAt, 0, replacement);
  }
  return `${lines.join("\n").replace(/\n+$/g, "")}\n`;
}

function writeAtomic(destination, text) {
  const id = crypto.randomUUID();
  const temporary = `${destination}.${id}.tmp`;
  const backup = `${destination}.${id}.bak`;
  const existed = fs.existsSync(destination);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.writeFileSync(temporary, text, "utf8");
    if (existed) fs.renameSync(destination, backup);
    fs.renameSync(temporary, destination);
    fs.rmSync(backup, { force: true });
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    if (fs.existsSync(backup)) {
      fs.rmSync(destination, { force: true });
      fs.renameSync(backup, destination);
    }
    throw error;
  }
}

function previewModelSourceSwitch(codexHome, targetProvider, options = {}) {
  const target = String(targetProvider || "").trim();
  if (!PROVIDER_ID.test(target)) throw new Error("Provider 标识无效");
  const state = inspectCodexHome(codexHome, options);
  if (target !== "openai" && !state.providers.some((item) => item.id === target)) {
    throw new Error(`Codex Home 中不存在第三方 Provider：${target}`);
  }
  const provider = state.providers.find((item) => item.id === target) || null;
  if (provider?.envKey && !provider.credentialAvailable) {
    throw new Error(`第三方 Provider ${target} 的环境变量 ${provider.envKey} 不可用`);
  }
  return {
    ...state,
    targetProvider: target,
    targetKind: target === "openai" ? "openai" : "third-party",
    changed: state.currentProvider !== target,
  };
}

function applyModelSourceSwitch(codexHome, targetProvider, options = {}) {
  const preview = previewModelSourceSwitch(codexHome, targetProvider, options);
  if (!preview.changed) return { ...preview, applied: false };
  const original = readUtf8(preview.configPath);
  const next = setTopLevelString(original, "model_provider", preview.targetProvider);
  (options.writeAtomic || writeAtomic)(preview.configPath, next);
  return { ...preview, applied: true, original, next };
}

function restoreModelSourceSwitch(result, options = {}) {
  if (!result?.applied || typeof result.original !== "string") return false;
  (options.writeAtomic || writeAtomic)(result.configPath, result.original);
  return true;
}

function inspectSessionOverrides(sessionPaths = []) {
  const files = [];
  let overrideCount = 0;
  for (const sessionPath of [...new Set(sessionPaths.map((item) => path.resolve(item)))]) {
    const text = readUtf8(sessionPath);
    if (!text) continue;
    let data;
    try { data = JSON.parse(text); } catch { continue; }
    let count = 0;
    for (const chat of Object.values(data.chats || {})) {
      for (const session of Array.isArray(chat?.sessions) ? chat.sessions : []) {
        if (String(session?.providerOverride || "").trim() || String(session?.providerBundleOverride || "").trim()) count += 1;
      }
    }
    overrideCount += count;
    files.push({ path: sessionPath, count });
  }
  return { overrideCount, files };
}

function clearSessionOverrides(sessionPaths = [], options = {}) {
  const writes = [];
  for (const sessionPath of [...new Set(sessionPaths.map((item) => path.resolve(item)))]) {
    const original = readUtf8(sessionPath);
    if (!original) continue;
    let data;
    try { data = JSON.parse(original); } catch { throw new Error(`会话文件不是有效 JSON：${sessionPath}`); }
    let changed = 0;
    for (const chat of Object.values(data.chats || {})) {
      for (const session of Array.isArray(chat?.sessions) ? chat.sessions : []) {
        if (String(session?.providerOverride || "").trim() || String(session?.providerBundleOverride || "").trim()) changed += 1;
        session.providerOverride = "";
        session.providerBundleOverride = "";
      }
    }
    if (changed) writes.push({ path: sessionPath, original, next: `${JSON.stringify(data, null, 2)}\n`, changed });
  }
  const completed = [];
  try {
    for (const write of writes) {
      (options.writeAtomic || writeAtomic)(write.path, write.next);
      completed.push(write);
    }
  } catch (error) {
    for (const write of completed.reverse()) {
      try { (options.writeAtomic || writeAtomic)(write.path, write.original); } catch {}
    }
    throw error;
  }
  return { changed: writes.reduce((sum, item) => sum + item.changed, 0), writes };
}

function restoreSessionOverrides(result, options = {}) {
  for (const write of [...(result?.writes || [])].reverse()) {
    (options.writeAtomic || writeAtomic)(write.path, write.original);
  }
}

function parseLoginState(output, ok) {
  const text = String(output || "").trim();
  const lower = text.toLowerCase();
  if (/not logged in|signed out|unauthenticated|no credentials/.test(lower)) return "signed-out";
  if (ok && /logged in|chatgpt|api key|access token/.test(lower)) return "signed-in";
  return "unknown";
}

function execCodex(codexPath, args, codexHome, options = {}) {
  const runner = options.execFile || execFile;
  return new Promise((resolve) => {
    runner(codexPath, args, {
      windowsHide: true,
      timeout: options.timeoutMs || 15_000,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      env: { ...process.env, ...(options.env || {}), CODEX_HOME: canonicalPath(codexHome) },
    }, (error, stdout, stderr) => resolve({
      ok: !error,
      code: typeof error?.code === "number" ? error.code : (error ? 1 : 0),
      output: `${stdout || ""}\n${stderr || ""}`.trim(),
      error: error?.code === "ETIMEDOUT" ? "timeout" : (error ? "unavailable" : ""),
    }));
  });
}

async function inspectLogin(codexPath, codexHome, options = {}) {
  if (!codexPath || !fs.existsSync(codexPath)) {
    return { state: "unavailable", summary: "官方 Codex 运行时不可用" };
  }
  const result = await execCodex(codexPath, ["login", "status"], codexHome, options);
  return {
    state: parseLoginState(result.output, result.ok),
    summary: result.output.split(/\r?\n/).find(Boolean) || (result.error === "timeout" ? "登录状态查询超时" : "未返回登录状态"),
  };
}

function createLoginManager(options = {}) {
  const jobs = new Map();
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || 10 * 60_000);
  const warningMs = Math.min(timeoutMs, Math.max(0, Number(options.warningMs) || 2 * 60_000));
  const publicJob = (job) => job ? {
    codexHome: job.codexHome,
    processId: job.processId,
    status: job.status,
    startedAt: job.startedAt,
    warningAt: job.warningAt,
    expiresAt: job.expiresAt,
    finishedAt: job.finishedAt || "",
    exitCode: job.exitCode,
    error: job.error || "",
  } : null;
  const finish = (job, status, details = {}) => {
    if (job.status !== "running") return false;
    clearTimeout(job.timeout);
    job.status = status;
    job.finishedAt = new Date().toISOString();
    Object.assign(job, details);
    return true;
  };
  const terminate = (job, status = "restarted") => {
    if (!job || !finish(job, status)) return false;
    try { job.child.kill(); } catch {}
    return true;
  };
  return {
    start(codexPath, codexHome) {
      if (!codexPath || !fs.existsSync(codexPath)) throw new Error("官方 Codex 运行时不可用");
      const resolved = canonicalPath(codexHome);
      const key = pathKey(resolved);
      const existing = jobs.get(key);
      terminate(existing);
      const startedAtMs = Date.now();
      const child = (options.spawn || spawn)(codexPath, ["login"], {
        windowsHide: true,
        stdio: "ignore",
        env: { ...process.env, ...(options.env || {}), CODEX_HOME: resolved },
      });
      const job = {
        codexHome: resolved,
        processId: child.pid || null,
        status: "running",
        startedAt: new Date(startedAtMs).toISOString(),
        warningAt: new Date(startedAtMs + timeoutMs - warningMs).toISOString(),
        expiresAt: new Date(startedAtMs + timeoutMs).toISOString(),
        finishedAt: "",
        exitCode: null,
        error: "",
        child,
        timeout: null,
      };
      jobs.set(key, job);
      job.timeout = setTimeout(() => {
        if (!finish(job, "timed-out", { error: "OpenAI login timed out after 10 minutes" })) return;
        try { child.kill(); } catch {}
      }, timeoutMs);
      job.timeout.unref?.();
      child.once("error", (error) => {
        finish(job, "failed", { error: error.message });
      });
      child.once("exit", (code) => {
        finish(job, code === 0 ? "completed" : "failed", { exitCode: code });
      });
      child.unref?.();
      return publicJob(job);
    },
    get(codexHome) { return publicJob(jobs.get(pathKey(codexHome))); },
    stop(codexHome) { return terminate(jobs.get(pathKey(codexHome)), "cancelled"); },
  };
}

function versionParts(value) {
  return String(value || "").split(".").map((item) => Number(item) || 0);
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
}

function discoverOfficialCodex(localAppData = process.env.LOCALAPPDATA || "") {
  const root = path.join(localAppData, "CodexFeishuBridge", "official-codex-cli");
  if (!fs.existsSync(root)) return "";
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      path: path.join(root, entry.name, "codex.exe"),
      version: entry.name.match(/^OpenAI\.Codex_([^_]+)/i)?.[1] || "0",
    }))
    .filter((item) => fs.existsSync(item.path))
    .sort((left, right) => compareVersions(right.version, left.version))[0]?.path || "";
}

module.exports = {
  applyModelSourceSwitch,
  canonicalPath,
  clearSessionOverrides,
  createLoginManager,
  discoverCodexHomes,
  discoverOfficialCodex,
  inspectCodexHome,
  inspectLogin,
  inspectSessionOverrides,
  parseLoginState,
  previewModelSourceSwitch,
  providerDefinitions,
  restoreModelSourceSwitch,
  restoreSessionOverrides,
  setTopLevelString,
  topLevelString,
  writeAtomic,
};
