param(
  [string]$Name = "",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

function Get-SafeInstanceName([string]$RawName) {
  $safe = ($RawName.Trim() -replace '[^A-Za-z0-9_.-]', '-').Trim('-')
  if (-not $safe) {
    throw "Instance name contains no usable characters: $RawName"
  }
  return $safe
}

$baseDataRoot = Join-Path $env:LOCALAPPDATA "CodexFeishuBridge"
if ($Name.Trim()) {
  $safeName = Get-SafeInstanceName $Name
  $dataRoot = Join-Path (Join-Path $baseDataRoot "instances") $safeName
} else {
  $safeName = ""
  $dataRoot = $baseDataRoot
}

$stateDir = Join-Path $dataRoot "state"
$pidFile = Join-Path $stateDir "bridge.pid"
$stopFile = Join-Path $stateDir "bridge.stop"

function Get-BridgeIdentity {
  $result = & node.exe (Join-Path $PSScriptRoot 'src/runtime/bridge-process-identity.cjs') --state $stateDir
  $resultExit = $LASTEXITCODE
  $identity = $result | ConvertFrom-Json
  if ($resultExit -ne 0 -and $resultExit -ne 3) { throw $identity.error }
  return $identity
}

if (-not (Test-Path $pidFile)) {
  Write-Host "Codex Feishu Bridge is not running: no PID file found. Instance: $(if ($safeName) { $safeName } else { 'default' })"
  exit 0
}

$pidText = (Get-Content -LiteralPath $pidFile -Raw).Trim()
if ($pidText -notmatch '^\d+$') {
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  Write-Host "Removed invalid PID file."
  exit 0
}

$identity = Get-BridgeIdentity
if ($identity.status -eq 'stale') {
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  Write-Host "Bridge process was not running. Removed stale PID file; unrelated processes were left running."
  exit 0
}
$pidText = [string]$identity.pid
$expectedStartTime = $identity.createdAt

function Test-OriginalBridgeAlive {
  $current = Get-BridgeIdentity
  if ($current.status -eq 'stale') { return $false }
  if ([string]$current.pid -ne $pidText -or $current.createdAt -ne $expectedStartTime) {
    throw 'Bridge ownership changed while stopping; the replacement process was left running.'
  }
  return $true
}

Set-Content -LiteralPath $stopFile -Value (Get-Date).ToString("o") -Encoding UTF8

if ($Force) {
  if (-not (Test-OriginalBridgeAlive)) { exit 0 }
  $taskkillArgs = @('/PID', $pidText, '/T', '/F')
  & taskkill.exe @taskkillArgs | Out-Null
  $taskkillExitCode = $LASTEXITCODE
  Start-Sleep -Milliseconds 500
  if (Test-OriginalBridgeAlive) {
    throw "Bridge process tree did not stop after taskkill. PID: $pidText; exit code: $taskkillExitCode"
  }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
  Write-Host "Codex Feishu Bridge force-stopped with its process tree. Instance: $(if ($safeName) { $safeName } else { 'default' }); PID: $pidText"
  exit 0
}

for ($i = 0; $i -lt 10; $i++) {
  Start-Sleep -Seconds 1
  if (-not (Test-OriginalBridgeAlive)) {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
    Write-Host "Codex Feishu Bridge stopped. Instance: $(if ($safeName) { $safeName } else { 'default' }); PID: $pidText"
    exit 0
  }
}

Write-Warning "Bridge did not stop gracefully in 10 seconds; terminating process $pidText."
if (-not (Test-OriginalBridgeAlive)) { exit 0 }
Stop-Process -Id ([int]$pidText) -ErrorAction Stop
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
Write-Host "Codex Feishu Bridge force-stopped. Instance: $(if ($safeName) { $safeName } else { 'default' }); PID: $pidText"
