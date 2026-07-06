$ErrorActionPreference = "Stop"

$baseDataRoot = Join-Path $env:LOCALAPPDATA "CodexFeishuBridge"
$panelRoot = Join-Path $baseDataRoot "control-panel"
$stateDir = Join-Path $panelRoot "state"
$logDir = Join-Path $panelRoot "logs"
$pidFile = Join-Path $stateDir "control-panel.pid"
$stopLog = Join-Path $logDir "control-panel-stop.log"
$panelScript = Join-Path $PSScriptRoot "control-panel.mjs"
$panelScriptName = Split-Path -Leaf $panelScript
$pidFileProcessId = $null

New-Item -ItemType Directory -Force -Path $stateDir, $logDir | Out-Null

function Write-StopLog {
  param([string]$Message)
  Add-Content -LiteralPath $stopLog -Value ("{0} {1}" -f (Get-Date).ToString("o"), $Message) -Encoding UTF8
}

function Test-IsControlPanelProcess {
  param([int]$ProcessIdValue)
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessIdValue" -ErrorAction SilentlyContinue
  if (-not $processInfo) { return $false }
  $commandLine = [string]$processInfo.CommandLine
  if ($commandLine -notlike "*$panelScriptName*") { return $false }
  if ($commandLine -like "*$panelScript*") { return $true }
  if ($pidFileProcessId -and $ProcessIdValue -eq $pidFileProcessId) { return $true }

  $portOwners = @(Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort 8320 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)
  return $portOwners -contains $ProcessIdValue
}

$targets = @()
if (Test-Path -LiteralPath $pidFile) {
  $processIdText = (Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue).Trim()
  if ($processIdText -match '^\d+$') {
    $pidFileProcessId = [int]$processIdText
    $targets += $pidFileProcessId
  }
}

$portProcessIds = @(Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort 8320 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique)
foreach ($processIdValue in $portProcessIds) {
  $targets += [int]$processIdValue
}

$processInfos = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
foreach ($processInfo in @($processInfos)) {
  $processIdValue = [int]$processInfo.ProcessId
  if (Test-IsControlPanelProcess -ProcessIdValue $processIdValue) {
    $targets += $processIdValue
  }
}

$targets = @($targets | Sort-Object -Unique)
if (-not $targets.Count) {
  Write-StopLog "no control panel process found"
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  exit 0
}

foreach ($processIdValue in $targets) {
  if (-not (Test-IsControlPanelProcess -ProcessIdValue $processIdValue)) {
    Write-StopLog "skip pid=$processIdValue because it is not control-panel.mjs"
    continue
  }

  try {
    Stop-Process -Id $processIdValue -Force -ErrorAction Stop
    Write-StopLog "stopped control panel pid=$processIdValue"
  } catch {
    Write-StopLog "failed to stop pid=${processIdValue}: $($_.Exception.Message)"
  }
}

Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
