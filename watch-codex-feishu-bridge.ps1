param(
  [string]$Name = "",
  [string]$LarkProfile = "",
  [string]$Workspace = "",
  [string]$StartScript = (Join-Path $PSScriptRoot "start-codex-feishu-bridge.ps1"),
  [string]$StopScript = (Join-Path $PSScriptRoot "stop-codex-feishu-bridge.ps1"),
  [string]$Sandbox = "danger-full-access",
  [ValidateSet("app-server", "auto", "exec")]
  [string]$RunMode = "app-server",
  [string]$Reasoning = "xhigh",
  [int]$CodexTimeoutSeconds = 7200,
  [int]$RestartCooldownSeconds = 60,
  [switch]$DisableMcp
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
  if (-not $Workspace.Trim()) {
    $Workspace = Join-Path (Join-Path $env:USERPROFILE "Documents\Codex\workspaces") ("feishu-bridge-" + $safeName)
  }
} else {
  $safeName = ""
  $dataRoot = $baseDataRoot
  if (-not $Workspace.Trim()) {
    $Workspace = Join-Path (Join-Path $env:USERPROFILE "Documents\Codex\workspaces") "feishu-bridge"
  }
}
$stateDir = Join-Path $dataRoot "state"
$logDir = Join-Path $dataRoot "logs"
$pidFile = Join-Path $stateDir "bridge.pid"
$lockFile = Join-Path $stateDir "watchdog.lock"
$logFile = Join-Path $logDir "watchdog.log"
$lastRestartFile = Join-Path $stateDir "watchdog-last-restart.txt"

New-Item -ItemType Directory -Force -Path $stateDir, $logDir | Out-Null

function Write-WatchdogLog {
  param([string]$Message)
  $line = "{0} {1}" -f (Get-Date).ToString("o"), $Message
  Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}

function Rotate-WatchdogLog {
  if (-not (Test-Path -LiteralPath $logFile)) { return }
  $item = Get-Item -LiteralPath $logFile -ErrorAction SilentlyContinue
  if ($item -and $item.Length -gt 1048576) {
    $backup = Join-Path $logDir "watchdog.log.1"
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
    Move-Item -LiteralPath $logFile -Destination $backup -Force
  }
}

function Get-BridgeProcess {
  if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
  $pidText = (Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue).Trim()
  if ($pidText -notmatch '^\d+$') { return $null }
  $process = Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue
  if (-not $process) { return $null }
  $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$pidText" -ErrorAction SilentlyContinue).CommandLine
  if ($cmd -notlike "*codex-feishu-bridge*") { return $null }
  return $process
}

function Get-LarkCliCommand {
  $cmd = Get-Command "lark-cli.cmd" -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $npmLark = Join-Path $env:APPDATA "npm\lark-cli.cmd"
  if (Test-Path -LiteralPath $npmLark) { return $npmLark }
  return $null
}

function Test-LarkConsumer {
  $larkCli = Get-LarkCliCommand
  if (-not $larkCli) {
    return @{ Ok = $false; Reason = "lark-cli not found" }
  }

  $statusArgs = @()
  if ($LarkProfile.Trim()) {
    $statusArgs += @("--profile", $LarkProfile.Trim())
  }
  $statusArgs += @("event", "status")
  if ($LarkProfile.Trim()) {
    $statusArgs += "--current"
  }
  $statusArgs += "--json"

  $tempBase = Join-Path $env:TEMP ("codex-feishu-lark-status-{0}-{1}" -f $PID, ([guid]::NewGuid().ToString("N")))
  $stdoutPath = "$tempBase.out"
  $stderrPath = "$tempBase.err"
  try {
    $process = Start-Process `
      -FilePath $larkCli `
      -ArgumentList $statusArgs `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -WindowStyle Hidden `
      -PassThru
    if (-not $process.WaitForExit(15000)) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      return @{ Ok = $false; Reason = "lark-cli status timed out" }
    }
    if (Test-Path -LiteralPath $stdoutPath) {
      $stdout = [string](Get-Content -LiteralPath $stdoutPath -Raw -ErrorAction SilentlyContinue)
    } else {
      $stdout = ""
    }
    if (Test-Path -LiteralPath $stderrPath) {
      $stderr = [string](Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue)
    } else {
      $stderr = ""
    }
    if ($null -eq $stdout) { $stdout = "" }
    if ($null -eq $stderr) { $stderr = "" }
    if ($process.ExitCode -ne 0) {
      return @{ Ok = $false; Reason = "lark-cli status failed: $($stdout.Trim()) $($stderr.Trim())".Trim() }
    }
    $outputText = $stdout
  } finally {
    Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
  }

  try {
    $status = $outputText | ConvertFrom-Json
  } catch {
    return @{ Ok = $false; Reason = "lark-cli status returned invalid json" }
  }

  foreach ($app in @($status.apps)) {
    if (-not $app.running) { continue }
    foreach ($consumer in @($app.consumers)) {
      if ($consumer.event_key -eq "im.message.receive_v1") {
        return @{ Ok = $true; Reason = "consumer pid $($consumer.pid)" }
      }
    }
  }

  return @{ Ok = $false; Reason = "no active im.message.receive_v1 consumer" }
}

function Test-RecentRestartCooldown {
  if (-not (Test-Path -LiteralPath $lastRestartFile)) { return $false }
  try {
    $last = [datetime](Get-Content -LiteralPath $lastRestartFile -Raw)
    return ((Get-Date) - $last).TotalSeconds -lt $RestartCooldownSeconds
  } catch {
    return $false
  }
}

function Restart-Bridge {
  param([string]$Reason)

  if (Test-RecentRestartCooldown) {
    Write-WatchdogLog "restart skipped during cooldown; reason=$Reason"
    return
  }

  Write-WatchdogLog "restart begin; reason=$Reason"
  Set-Content -LiteralPath $lastRestartFile -Value (Get-Date).ToString("o") -Encoding UTF8

  try {
    $stopArgs = @(
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      $StopScript
    )
    if ($safeName) { $stopArgs += @("-Name", $safeName) }
    & powershell.exe @stopArgs | ForEach-Object {
      Write-WatchdogLog "stop: $_"
    }
  } catch {
    Write-WatchdogLog "stop failed: $($_.Exception.Message)"
  }

  Start-Sleep -Seconds 2

  try {
    $startArgs = @(
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      $StartScript,
      "-Sandbox",
      $Sandbox,
      "-RunMode",
      $RunMode,
      "-Reasoning",
      $Reasoning,
      "-CodexTimeoutSeconds",
      $CodexTimeoutSeconds
    )
    if ($safeName) { $startArgs += @("-Name", $safeName) }
    if ($LarkProfile.Trim()) { $startArgs += @("-LarkProfile", $LarkProfile.Trim()) }
    if ($Workspace.Trim()) { $startArgs += @("-Workspace", $Workspace) }
    if ($DisableMcp) { $startArgs += "-DisableMcp" }
    & powershell.exe @startArgs | ForEach-Object {
      Write-WatchdogLog "start: $_"
    }
  } catch {
    Write-WatchdogLog "start failed: $($_.Exception.Message)"
    throw
  }

  Start-Sleep -Seconds 3
  $bridge = Get-BridgeProcess
  $consumer = Test-LarkConsumer
  if ($bridge -and $consumer.Ok) {
    Write-WatchdogLog "restart ok; bridgePid=$($bridge.Id); $($consumer.Reason)"
  } else {
    Write-WatchdogLog "restart incomplete; bridge=$([bool]$bridge); consumer=$($consumer.Ok); reason=$($consumer.Reason)"
  }
}

Rotate-WatchdogLog

$lockStream = $null
try {
  $lockStream = [System.IO.File]::Open($lockFile, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
} catch {
  Write-WatchdogLog "another watchdog instance is already running"
  exit 0
}

try {
  $bridge = Get-BridgeProcess
  $consumer = Test-LarkConsumer

  if (-not $bridge) {
    Restart-Bridge "bridge process missing or stale"
    exit 0
  }

  if (-not $consumer.Ok) {
    Restart-Bridge "lark consumer unhealthy: $($consumer.Reason)"
    exit 0
  }

  Write-WatchdogLog "healthy; bridgePid=$($bridge.Id); $($consumer.Reason)"
} catch {
  Write-WatchdogLog "watchdog failed: $($_.Exception.Message)"
  exit 1
} finally {
  if ($lockStream) { $lockStream.Dispose() }
}
