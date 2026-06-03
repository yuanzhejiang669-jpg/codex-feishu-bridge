$ErrorActionPreference = "Stop"

$stateDir = Join-Path (Join-Path $env:LOCALAPPDATA "CodexFeishuBridge") "state"
$pidFile = Join-Path $stateDir "bridge.pid"
$stopFile = Join-Path $stateDir "bridge.stop"

if (-not (Test-Path $pidFile)) {
  Write-Host "Codex Feishu Bridge is not running: no PID file found."
  exit 0
}

$pidText = (Get-Content -LiteralPath $pidFile -Raw).Trim()
if ($pidText -notmatch '^\d+$') {
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  Write-Host "Removed invalid PID file."
  exit 0
}

$process = Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue
if (-not $process) {
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  Write-Host "Bridge process was not running. Removed stale PID file."
  exit 0
}

Set-Content -LiteralPath $stopFile -Value (Get-Date).ToString("o") -Encoding UTF8

for ($i = 0; $i -lt 10; $i++) {
  Start-Sleep -Seconds 1
  $process = Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue
  if (-not $process) {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
    Write-Host "Codex Feishu Bridge stopped. PID: $pidText"
    exit 0
  }
}

Write-Warning "Bridge did not stop gracefully in 10 seconds; terminating process $pidText."
Stop-Process -Id ([int]$pidText) -ErrorAction Stop
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
Write-Host "Codex Feishu Bridge force-stopped. PID: $pidText"
