param(
  [string]$HostName = "127.0.0.1",
  [int]$Port = 8320,
  [switch]$Foreground
)

$ErrorActionPreference = "Stop"

$script = Join-Path $PSScriptRoot "control-panel.mjs"
$baseDataRoot = Join-Path $env:LOCALAPPDATA "CodexFeishuBridge"
$panelRoot = Join-Path $baseDataRoot "control-panel"
$stateDir = Join-Path $panelRoot "state"
$logDir = Join-Path $panelRoot "logs"
$pidFile = Join-Path $stateDir "control-panel.pid"
$stdoutLog = Join-Path $logDir "control-panel.stdout.log"
$stderrLog = Join-Path $logDir "control-panel.stderr.log"
$panelScriptName = Split-Path -Leaf $script

New-Item -ItemType Directory -Force -Path $stateDir, $logDir | Out-Null

function Get-NodeCommand {
  $cmd = Get-Command "node.exe" -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  $programFilesNode = Join-Path $env:ProgramFiles "nodejs\node.exe"
  if (Test-Path -LiteralPath $programFilesNode) { return $programFilesNode }

  throw "node.exe not found"
}

function Get-ExistingPanelProcess {
  $portOwners = @(Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort 8320 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)

  if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
  $pidText = (Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue).Trim()
  if ($pidText -match '^\d+$') {
    $process = Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue
    if ($process) {
      $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$pidText" -ErrorAction SilentlyContinue).CommandLine
      if ($cmd -like "*$panelScriptName*" -and (($cmd -like "*$script*") -or ($portOwners -contains [int]$pidText))) {
        return $process
      }
    }
  }

  $processInfos = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
  foreach ($processInfo in @($processInfos)) {
    $processIdValue = [int]$processInfo.ProcessId
    $commandLine = [string]$processInfo.CommandLine
    if ($commandLine -like "*$panelScriptName*" -and (($commandLine -like "*$script*") -or ($portOwners -contains $processIdValue))) {
      return Get-Process -Id $processIdValue -ErrorAction SilentlyContinue
    }
  }

  return $null
}

$existing = Get-ExistingPanelProcess
if ($existing) {
  Set-Content -LiteralPath $pidFile -Value ([string]$existing.Id) -Encoding UTF8
  Write-Host "Codex Feishu Bridge control panel is already running. PID: $($existing.Id)"
  Write-Host "URL: http://${HostName}:$Port"
  exit 0
}

Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue

$node = Get-NodeCommand
$arguments = @(
  $script
  "--host"
  $HostName
  "--port"
  ([string]$Port)
)

if ($Foreground) {
  & $node @arguments
  exit $LASTEXITCODE
}

$argString = ($arguments | ForEach-Object {
  if ($_ -match '[\s"]') {
    '"' + ($_ -replace '"', '\"') + '"'
  } else {
    $_
  }
}) -join " "

$process = Start-Process `
  -FilePath $node `
  -ArgumentList $argString `
  -WorkingDirectory $PSScriptRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -PassThru

Set-Content -LiteralPath $pidFile -Value ([string]$process.Id) -Encoding UTF8

Start-Sleep -Seconds 1
if ($process.HasExited) {
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  $stderrTail = ""
  if (Test-Path -LiteralPath $stderrLog) {
    $stderrTail = (Get-Content -LiteralPath $stderrLog -Tail 40 -ErrorAction SilentlyContinue) -join "`n"
  }
  throw "Control panel process exited immediately. $stderrTail"
}

Write-Host "Started Codex Feishu Bridge control panel. PID: $($process.Id)"
Write-Host "URL: http://${HostName}:$Port"
