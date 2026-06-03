param(
  [string]$Workspace = (Get-Location).Path,
  [string]$Sandbox = "danger-full-access",
  [ValidateSet("app-server", "auto", "exec")]
  [string]$RunMode = "app-server",
  [string]$Reasoning = "xhigh",
  [int]$CodexTimeoutSeconds = 7200,
  [int]$MaxConcurrent = 1,
  [int]$CardThrottleMs = 400,
  [switch]$NoCard,
  [switch]$DebugCards,
  [switch]$ShowFinalSteps,
  [switch]$HideFinalSteps,
  [switch]$ReplyToMessage,
  [switch]$NoThreadReply,
  [switch]$ThreadReply,
  [switch]$EnableMcp,
  [switch]$DisableMcp,
  [switch]$Foreground
)

$ErrorActionPreference = "Stop"

$script = Join-Path $PSScriptRoot "codex-feishu-bridge.mjs"
$dataRoot = Join-Path $env:LOCALAPPDATA "CodexFeishuBridge"
$stateDir = Join-Path $dataRoot "state"
$logDir = Join-Path $dataRoot "logs"
$pidFile = Join-Path $stateDir "bridge.pid"
$stdoutLog = Join-Path $logDir "bridge.stdout.log"
$stderrLog = Join-Path $logDir "bridge.stderr.log"

New-Item -ItemType Directory -Force -Path $stateDir, $logDir | Out-Null

function Resolve-CodexCliBin {
  if ($env:CODEX_CLI_BIN) {
    if (Test-Path -LiteralPath $env:CODEX_CLI_BIN) {
      return (Resolve-Path -LiteralPath $env:CODEX_CLI_BIN).Path
    }
    Write-Warning "CODEX_CLI_BIN is set but not found: $env:CODEX_CLI_BIN"
  }

  $pathCandidate = Get-Command "codex.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pathCandidate) {
    return $pathCandidate.Source
  }

  $windowsAppsRoot = Join-Path $env:ProgramFiles "WindowsApps"
  if (Test-Path -LiteralPath $windowsAppsRoot) {
    $desktopCandidate = Get-ChildItem -LiteralPath $windowsAppsRoot -Directory -Filter "OpenAI.Codex_*" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      ForEach-Object { Join-Path $_.FullName "app\resources\codex.exe" } |
      Where-Object { Test-Path -LiteralPath $_ } |
      Select-Object -First 1
    if ($desktopCandidate) {
      return (Resolve-Path -LiteralPath $desktopCandidate).Path
    }
  }

  return $null
}

if (Test-Path $pidFile) {
  $existingPid = (Get-Content -LiteralPath $pidFile -Raw).Trim()
  if ($existingPid -match '^\d+$') {
    $existing = Get-Process -Id ([int]$existingPid) -ErrorAction SilentlyContinue
    if ($existing) {
      Write-Host "Codex Feishu Bridge is already running. PID: $existingPid"
      Write-Host "Log: $stdoutLog"
      exit 0
    }
  }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

$env:CODEX_FEISHU_WORKSPACE = (Resolve-Path -LiteralPath $Workspace).Path
$env:CODEX_FEISHU_SANDBOX = $Sandbox
$env:CODEX_FEISHU_RUN_MODE = $RunMode
if ($Reasoning.Trim()) {
  $env:CODEX_FEISHU_REASONING = $Reasoning.Trim()
} else {
  Remove-Item Env:CODEX_FEISHU_REASONING -ErrorAction SilentlyContinue
}
$env:CODEX_FEISHU_CODEX_TIMEOUT_MS = [string]($CodexTimeoutSeconds * 1000)
$env:CODEX_FEISHU_DISABLE_MCP = if ($DisableMcp) { "1" } else { "0" }
$env:CODEX_FEISHU_MAX_CONCURRENT = [string]$MaxConcurrent
$env:CODEX_FEISHU_CARD_MODE = if ($NoCard) { "0" } else { "1" }
$env:CODEX_FEISHU_CARD_THROTTLE_MS = [string]$CardThrottleMs
$env:CODEX_FEISHU_CARD_DEBUG = if ($DebugCards) { "1" } else { "0" }
$env:CODEX_FEISHU_SHOW_FINAL_STEPS = if ($HideFinalSteps) { "0" } else { "1" }
$env:CODEX_FEISHU_REPLY_TO_MESSAGE = if ($ReplyToMessage) { "1" } else { "0" }
$env:CODEX_FEISHU_REPLY_IN_THREAD = if ($ThreadReply -and -not $NoThreadReply) { "1" } else { "0" }
$env:CODEX_FEISHU_STATE_DIR = $stateDir
$env:CODEX_FEISHU_LOG_DIR = $logDir

$resolvedCodexCli = Resolve-CodexCliBin
if ($resolvedCodexCli) {
  $env:CODEX_CLI_BIN = $resolvedCodexCli
}

if ($Foreground) {
  node $script
  exit $LASTEXITCODE
}

$process = Start-Process `
  -FilePath "node" `
  -ArgumentList @($script) `
  -WorkingDirectory $PSScriptRoot `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -WindowStyle Hidden `
  -PassThru

Start-Sleep -Seconds 2
if (Test-Path $pidFile) {
  $bridgePid = (Get-Content -LiteralPath $pidFile -Raw).Trim()
} else {
  $bridgePid = [string]$process.Id
}

Write-Host "Codex Feishu Bridge started. PID: $bridgePid"
Write-Host "Workspace: $($env:CODEX_FEISHU_WORKSPACE)"
Write-Host "Codex CLI: $($env:CODEX_CLI_BIN)"
Write-Host "Run mode: $($env:CODEX_FEISHU_RUN_MODE)"
Write-Host "Sandbox: $($env:CODEX_FEISHU_SANDBOX)"
Write-Host "Reasoning: $($env:CODEX_FEISHU_REASONING)"
Write-Host "MCP: $(if ($env:CODEX_FEISHU_DISABLE_MCP -eq '0') { 'enabled' } else { 'disabled' })"
Write-Host "Card throttle: $($env:CODEX_FEISHU_CARD_THROTTLE_MS)ms"
Write-Host "Final steps: $($env:CODEX_FEISHU_SHOW_FINAL_STEPS)"
Write-Host "Main log: $(Join-Path $logDir 'codex-feishu-bridge.log')"
Write-Host "Stdout log: $stdoutLog"
Write-Host "Stderr log: $stderrLog"
