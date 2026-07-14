import fs from "node:fs";

const OFFICIAL_CACHE_PATTERN = /(?:^|[\\/])official-codex-cli[\\/](OpenAI\.Codex_([^_\\/]+)_[^\\/]+)[\\/]codex\.exe$/i;
const WINDOWS_APP_PATTERN = /(?:^|[\\/])WindowsApps[\\/](OpenAI\.Codex_([^_\\/]+)_[^\\/]+)[\\/]app[\\/]resources[\\/]codex\.exe$/i;

const DESKTOP_PACKAGE_QUERY = [
  "$ErrorActionPreference = 'Stop'",
  "$package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop | Sort-Object Version -Descending | Select-Object -First 1",
  "if (-not $package) { [pscustomobject]@{ found = $false } | ConvertTo-Json -Compress; exit 0 }",
  "$codexPath = Join-Path $package.InstallLocation 'app\\resources\\codex.exe'",
  "$codexItem = Get-Item -LiteralPath $codexPath -ErrorAction SilentlyContinue",
  "[pscustomobject]@{ found = $true; version = $package.Version.ToString(); packageFullName = $package.PackageFullName; installLocation = $package.InstallLocation; codexPath = $codexPath; codexLength = if ($codexItem) { $codexItem.Length } else { $null } } | ConvertTo-Json -Compress",
].join("; ");

export function parseCodexCliVersion(stdout) {
  const text = String(stdout || "").trim();
  const match = text.match(/\bcodex(?:-cli)?\s+v?([^\s]+)/i);
  return match?.[1] || "";
}

export function parseCodexRuntimeSource(command) {
  const executable = String(command || "").trim().replace(/^"|"$/g, "");
  for (const [kind, pattern] of [
    ["official-cache", OFFICIAL_CACHE_PATTERN],
    ["windows-app", WINDOWS_APP_PATTERN],
  ]) {
    const match = executable.match(pattern);
    if (match) {
      return {
        kind,
        executable,
        packageFullName: match[1],
        packageVersion: match[2],
      };
    }
  }
  return {
    kind: "custom",
    executable,
    packageFullName: "",
    packageVersion: "",
  };
}

export function parseDesktopPackage(stdout) {
  const parsed = parseLastJsonObject(stdout);
  if (!parsed?.found) return null;
  const version = String(parsed.version || "").trim();
  const packageFullName = String(parsed.packageFullName || "").trim();
  if (!version || !packageFullName) throw new Error("desktop package response is incomplete");
  return {
    version,
    packageFullName,
    installLocation: String(parsed.installLocation || "").trim(),
    codexPath: String(parsed.codexPath || "").trim(),
    codexLength: Number.isFinite(Number(parsed.codexLength)) ? Number(parsed.codexLength) : null,
  };
}

export function runtimeAlignment(runtime, desktop, runtimeFile = null) {
  if (!runtime?.packageFullName) return "incomparable";
  if (!desktop?.packageFullName) return "unknown";
  if (runtime.packageFullName.toLowerCase() !== desktop.packageFullName.toLowerCase()) return "not-aligned";
  if (runtimeFile?.unavailable) return "runtime-file-unavailable";
  if (desktop.codexLength !== null && runtimeFile?.size !== undefined && runtimeFile.size !== desktop.codexLength) {
    return "runtime-file-mismatch";
  }
  return "aligned";
}

export async function readCodexRuntimeVersionStatus({
  codexCli,
  runTool,
  powershellTool = { command: "powershell.exe", argsPrefix: ["-NoProfile", "-NonInteractive", "-Command"] },
  cliTimeoutMs = 5_000,
  packageTimeoutMs = 10_000,
  statFile = (file) => fs.promises.stat(file),
} = {}) {
  const runtime = parseCodexRuntimeSource(codexCli?.command);
  const [cliResult, packageResult] = await Promise.all([
    settleTool(runTool, codexCli, ["--version"], cliTimeoutMs),
    settleTool(runTool, powershellTool, [DESKTOP_PACKAGE_QUERY], packageTimeoutMs),
  ]);

  let cliVersion = "";
  let cliError = "";
  if (cliResult.ok && cliResult.result.code === 0) {
    cliVersion = parseCodexCliVersion(`${cliResult.result.stdout || ""}\n${cliResult.result.stderr || ""}`);
    if (!cliVersion) cliError = "无法解析版本输出";
  } else {
    cliError = toolFailureText(cliResult);
  }

  let desktop = null;
  let desktopError = "";
  if (packageResult.ok && packageResult.result.code === 0) {
    try {
      desktop = parseDesktopPackage(packageResult.result.stdout);
      if (!desktop) desktopError = "未安装 OpenAI.Codex 桌面端";
    } catch (error) {
      desktopError = `无法解析桌面包信息：${error.message || error}`;
    }
  } else {
    desktopError = toolFailureText(packageResult);
  }

  let runtimeFile = null;
  if (runtime.packageFullName && desktop?.packageFullName
    && runtime.packageFullName.toLowerCase() === desktop.packageFullName.toLowerCase()) {
    try {
      runtimeFile = await statFile(runtime.executable);
    } catch {
      runtimeFile = { unavailable: true };
    }
  }

  return {
    cliVersion,
    cliError,
    runtime,
    desktop,
    desktopError,
    alignment: runtimeAlignment(runtime, desktop, runtimeFile),
  };
}

export function codexRuntimeVersionLines(status) {
  const cli = status?.cliVersion
    ? status.cliVersion
    : `查询失败${status?.cliError ? `（${status.cliError}）` : ""}`;
  const runtime = status?.runtime?.packageVersion
    ? `OpenAI.Codex ${status.runtime.packageVersion}`
    : "自定义路径（无法识别桌面包版本）";
  const desktop = status?.desktop?.version
    ? `OpenAI.Codex ${status.desktop.version}`
    : `查询失败${status?.desktopError ? `（${status.desktopError}）` : ""}`;

  let alignment = "未知（无法比较运行时来源包与桌面端最新包）";
  if (status?.alignment === "aligned") {
    alignment = "已对齐（Bridge 使用桌面端最新包的 Codex 运行时）";
  } else if (status?.alignment === "not-aligned") {
    alignment = "未对齐（Bridge 当前运行时不是桌面端最新包）";
  } else if (status?.alignment === "runtime-file-mismatch") {
    alignment = "异常（来源包版本一致，但运行时 codex.exe 大小与桌面包不一致）";
  } else if (status?.alignment === "runtime-file-unavailable") {
    alignment = "异常（来源包版本一致，但运行时 codex.exe 不存在或不可访问）";
  } else if (status?.alignment === "incomparable") {
    alignment = "不可比较（Bridge 使用自定义 Codex 路径）";
  }

  return [
    `Codex CLI：\`${cli}\``,
    `运行时来源包：${runtime}`,
    `桌面端最新包：${desktop}`,
    `版本状态：${alignment}`,
  ];
}

async function settleTool(runTool, tool, args, timeoutMs) {
  if (typeof runTool !== "function" || !tool?.command) {
    return { ok: false, error: new Error("运行工具未配置") };
  }
  try {
    return { ok: true, result: await runTool(tool, args, { timeoutMs }) };
  } catch (error) {
    return { ok: false, error };
  }
}

function toolFailureText(outcome) {
  if (!outcome?.ok) return compactError(outcome?.error?.message || outcome?.error || "启动失败");
  const result = outcome.result || {};
  if (result.timedOut) return "查询超时";
  return compactError(result.stderr || result.stdout || `退出码 ${result.code}`);
}

function parseLastJsonObject(stdout) {
  const text = String(stdout || "").replace(/^\uFEFF/, "").trim();
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index].replace(/^\uFEFF/, ""));
    } catch {}
  }
  throw new Error("desktop package response does not contain JSON");
}

function compactError(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 160);
}
