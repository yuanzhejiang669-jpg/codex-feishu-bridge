const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const TOML = require("smol-toml");

function readJsonSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").trim();
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function readCodexMcpServers(codexHome) {
  const filePath = path.join(codexHome, "config.toml");
  try {
    if (!fs.existsSync(filePath)) return {};
    const parsed = TOML.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    return parsed?.mcp_servers && typeof parsed.mcp_servers === "object" ? parsed.mcp_servers : {};
  } catch {
    return {};
  }
}

function resolveExecutableExists(command, env = process.env, platform = process.platform) {
  const raw = String(command || "").trim();
  if (!raw) return false;
  if (path.isAbsolute(raw) || raw.includes(path.sep) || raw.includes("/")) {
    return fs.existsSync(raw);
  }
  const pathEnv = String(env.PATH || env.Path || "");
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const exts = platform === "win32"
    ? String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, raw.toLowerCase().endsWith(ext.toLowerCase()) ? raw : `${raw}${ext}`);
      if (fs.existsSync(candidate)) return true;
    }
  }
  return false;
}

function findPythonScriptArg(entry) {
  const args = Array.isArray(entry?.args) ? entry.args : [];
  for (const arg of args) {
    const text = String(arg || "").trim();
    if (/\.py$/i.test(text)) return text;
  }
  return "";
}

function checkPythonSyntax(scriptPath, pythonCommand = "") {
  if (!scriptPath || !fs.existsSync(scriptPath)) {
    return { ok: false, detail: `脚本不存在：${scriptPath || "未配置"}` };
  }
  const candidates = [
    pythonCommand,
    ...(process.platform === "win32" ? ["python", "py"] : ["python3", "python"]),
  ].filter(Boolean);
  for (const cmd of candidates) {
    const args = cmd === "py" ? ["-3", "-m", "py_compile", scriptPath] : ["-m", "py_compile", scriptPath];
    const res = spawnSync(cmd, args, { windowsHide: true, encoding: "utf8", timeout: 5_000 });
    if (res.error && res.error.code === "ENOENT") continue;
    if (res.status === 0) return { ok: true, detail: `脚本存在且 Python 语法通过（${path.basename(scriptPath)}）` };
    return { ok: false, detail: `Python 语法检查失败：${String(res.stderr || res.stdout || "").trim().slice(0, 200)}` };
  }
  return { ok: true, detail: `脚本存在（${path.basename(scriptPath)}；当前环境未找到 python 命令执行编译检查）` };
}

async function probeLocalLoopbackBridge(fetchImpl = fetch) {
  const urls = ["http://127.0.0.1:18795/health", "http://127.0.0.1:18795/status"];
  let lastReason = "";
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) {
        return { status: "ok", detail: `Edge 扩展桥接服务在线（${url} -> HTTP ${response.status}）` };
      }
      lastReason = `HTTP ${response.status}`;
    } catch (error) {
      lastReason = String(error?.message || error).slice(0, 120);
    }
  }
  return { status: "warn", detail: `本地 Edge 扩展桥（127.0.0.1:18795）当前未响应（${lastReason || "未连接"}）` };
}

function inspectMineruToolchain({ userHome, codexHome, dataRoot, env = process.env, platform = process.platform }) {
  const skillCandidates = [
    path.join(codexHome, "skills", "mineru-document-parser", "SKILL.md"),
    path.join(dataRoot, "claude-tools", ".claude", "skills", "mineru-document-parser", "SKILL.md"),
    path.join(dataRoot, "antigravity-tools", "skills", "mineru-document-parser", "SKILL.md"),
  ];
  const skillFound = skillCandidates.some((file) => fs.existsSync(file));
  const defaultMineruRoot = platform === "win32"
    ? path.join(userHome, "Documents", "Codex", "tools", "mineru")
    : path.join(userHome, "Codex", "tools", "mineru");
  const mineruRoot = String(env.MINERU_ROOT || "").trim() || defaultMineruRoot;

  const cliPath = path.join(mineruRoot, "cli.py");
  const pythonCandidates = platform === "win32"
    ? [path.join(mineruRoot, ".venv", "Scripts", "python.exe"), path.join(mineruRoot, ".venv", "Scripts", "mineru.exe")]
    : [path.join(mineruRoot, ".venv", "bin", "mineru"), path.join(mineruRoot, ".venv", "bin", "python")];

  const cliFound = fs.existsSync(cliPath);
  const pythonFound = pythonCandidates.some((file) => fs.existsSync(file));

  if (!skillFound && !fs.existsSync(mineruRoot)) {
    return {
      status: "not_configured",
      skillFound: false,
      mineruRoot,
      pythonFound: false,
      cliFound: false,
      detail: "未检测到 MinerU 技能或本地 MinerU 运行目录（如需解析 PDF/文档请配置 MINERU_ROOT）",
    };
  }
  if (pythonFound && (cliFound || platform !== "win32")) {
    return {
      status: "ok",
      skillFound,
      mineruRoot,
      pythonFound,
      cliFound,
      detail: `MinerU 本地运行时就绪（${mineruRoot}）`,
    };
  }
  const missing = [];
  if (!pythonFound) missing.push(platform === "win32" ? ".venv\\Scripts\\python.exe" : ".venv/bin/mineru");
  if (!cliFound) missing.push("cli.py");
  return {
    status: "missing_runtime",
    skillFound,
    mineruRoot,
    pythonFound,
    cliFound,
    detail: `MinerU 运行时缺失 ${missing.join(" / ")}（目录：${mineruRoot}；可通过环境变量 MINERU_ROOT 指定位置）`,
  };
}

function isCloakBrowserDefaultOrTemplate(value) {
  const raw = String(value || "").trim();
  if (!raw) return true;
  if (/\$\{(?:CLAUDE_CONFIG_DIR|PLAYWRIGHT_MCP_USER_DATA_DIR|PLAYWRIGHT_MCP_OUTPUT_DIR)\}/i.test(raw)) return true;
  const normalized = raw.replace(/\\/g, "/").replace(/\/+$/, "");
  return /(?:^|\/)(?:browser-(?:profiles|artifacts|output)\/)?cloakbrowser\/default$/i.test(normalized);
}

async function probeMcpHealth(options = {}) {
  const userHome = options.userHome || os.homedir();
  const codexHome = options.codexHome || path.join(userHome, ".codex");
  const dataRoot = options.dataRoot || "";
  const engineRoot = options.engineRoot || "";
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const fetchImpl = options.fetchImpl || fetch;

  const sources = [
    { engine: "codex", map: readCodexMcpServers(codexHome) },
    { engine: "claude", map: readJsonSafe(path.join(dataRoot, "claude-tools", ".mcp.json"))?.mcpServers || {} },
    { engine: "antigravity", map: readJsonSafe(path.join(dataRoot, "antigravity-tools", ".mcp.json"))?.mcpServers || {} },
  ];

  const byName = new Map();
  for (const { engine, map } of sources) {
    if (!map || typeof map !== "object") continue;
    for (const [name, config] of Object.entries(map)) {
      if (!config || typeof config !== "object") continue;
      if (!byName.has(name)) {
        byName.set(name, { name, entries: [] });
      }
      byName.get(name).entries.push({ engine, config, disabled: config.disabled === true });
    }
  }

  const servers = [];
  for (const { name, entries } of byName.values()) {
    const engines = entries.map((item) => item.engine);
    const activeEntries = entries.filter((item) => !item.disabled);
    const allDisabled = activeEntries.length === 0;

    if (allDisabled) {
      servers.push({
        name,
        engines,
        active: false,
        disabled: true,
        status: "disabled",
        detail: "已禁用（disabled: true，不计入活跃 MCP）",
        commandAvailable: null,
      });
      continue;
    }

    const primary = activeEntries[0].config;
    const command = String(primary.command || "").trim();
    const url = String(primary.url || primary.serverUrl || "").trim();
    const commandAvailable = command ? resolveExecutableExists(command, env, platform) : null;
    const lowerName = name.toLowerCase();

    if (lowerName === "codex_browser_control") {
      const scriptArg = (Array.isArray(primary.args) ? primary.args : [])
        .map((arg) => String(arg || "").trim())
        .find((arg) => /\.(?:m?js|cjs)$/i.test(arg)) || "";
      const scriptMissing = Boolean(scriptArg && !fs.existsSync(scriptArg));
      const bridgeProbe = await probeLocalLoopbackBridge(fetchImpl);
      const isOnline = bridgeProbe.status === "ok";
      servers.push({
        name,
        engines,
        active: true,
        disabled: false,
        status: commandAvailable === false || scriptMissing ? "error" : "ok",
        detail: commandAvailable === false
          ? `命令不可用：${command}`
          : scriptMissing
            ? `脚本不存在：${scriptArg}`
            : isOnline
              ? bridgeProbe.detail
              : "命令与脚本就绪（Edge 扩展桥 127.0.0.1:18795 按需启动，当前空闲）",
        commandAvailable,
      });
      continue;
    }

    if (lowerName.includes("tavily") || lowerName.includes("firecrawl")) {
      const fallbackScript = engineRoot
        ? path.join(engineRoot, "tools", lowerName.includes("tavily") ? "tavily-router" : "firecrawl-router", "server.py")
        : "";
      const scriptArg = findPythonScriptArg(primary) || fallbackScript;
      const pyCheck = options.skipPythonCompile
        ? { ok: Boolean(scriptArg && fs.existsSync(scriptArg)), detail: scriptArg && fs.existsSync(scriptArg) ? `脚本存在（${path.basename(scriptArg)}）` : `脚本不存在：${scriptArg || "未配置"}` }
        : checkPythonSyntax(scriptArg, command);
      servers.push({
        name,
        engines,
        active: true,
        disabled: false,
        status: commandAvailable === false || !pyCheck.ok ? "error" : "ok",
        detail: commandAvailable === false ? `命令不可用：${command}` : `${pyCheck.detail}（只读检查，零外网调用）`,
        commandAvailable,
      });
      continue;
    }

    if (lowerName === "cloakbrowser") {
      const customConflict = activeEntries.some((item) => {
        const dir = item.config?.env?.PLAYWRIGHT_MCP_USER_DATA_DIR;
        return Boolean(dir) && !isCloakBrowserDefaultOrTemplate(dir);
      });
      servers.push({
        name,
        engines,
        active: true,
        disabled: false,
        status: commandAvailable === false ? "error" : customConflict ? "warn" : "ok",
        detail: commandAvailable === false
          ? `命令不可用：${command}`
          : customConflict
            ? "检测到显式自定义的 PLAYWRIGHT_MCP_USER_DATA_DIR，请确认不会在多 Bot 间冲突"
            : "已接入 Bridge 三引擎实例隔离（各 Bot 使用独立 PLAYWRIGHT_MCP_USER_DATA_DIR）",
        commandAvailable,
      });
      continue;
    }

    if (command) {
      servers.push({
        name,
        engines,
        active: true,
        disabled: false,
        status: commandAvailable ? "ok" : "error",
        detail: commandAvailable ? `命令可执行（${command}）` : `命令未找到：${command}`,
        commandAvailable,
      });
    } else if (url) {
      let validUrl = false;
      try {
        const parsed = new URL(url);
        validUrl = ["http:", "https:"].includes(parsed.protocol);
      } catch {}
      servers.push({
        name,
        engines,
        active: true,
        disabled: false,
        status: validUrl ? "ok" : "error",
        detail: validUrl ? `远端 MCP 端点已配置（${url}；只读检查不发外部请求）` : `无效 URL：${url}`,
        commandAvailable: null,
      });
    } else {
      servers.push({
        name,
        engines,
        active: true,
        disabled: false,
        status: "warn",
        detail: "缺少 command 或 url 配置",
        commandAvailable: null,
      });
    }
  }

  // Sort active servers first, disabled servers at the bottom
  servers.sort((a, b) => {
    if (a.disabled !== b.disabled) return a.disabled ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  const mineru = inspectMineruToolchain({ userHome, codexHome, dataRoot, env, platform });

  return {
    checkedAt: new Date().toISOString(),
    servers,
    documentToolchain: { mineru },
  };
}

module.exports = {
  inspectMineruToolchain,
  probeMcpHealth,
};
