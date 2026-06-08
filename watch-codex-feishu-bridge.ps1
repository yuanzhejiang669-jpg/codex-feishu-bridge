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
  [string]$EventKeys = "im.message.receive_v1",
  [int]$CodexTimeoutSeconds = 0,
  [int]$CodexIdleTimeoutSeconds = 3600,
  [int]$RestartCooldownSeconds = 60,
  [int]$WatchdogTimeoutSeconds = 180,
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

function Test-WatchdogCommandMatchesInstance {
  param([string]$CommandLine)
  if (-not $CommandLine) { return $false }
  if ($CommandLine -notlike "*watch-codex-feishu-bridge.ps1*") { return $false }
  if (-not $safeName) {
    return $CommandLine -notmatch "(?i)\s-Name\s+"
  }
  $escaped = [regex]::Escape($safeName)
  return $CommandLine -match "(?i)\s-Name\s+[`"']?$escaped[`"']?(?:\s|$)"
}

function Stop-StaleWatchdogProcesses {
  if ($WatchdogTimeoutSeconds -le 0) { return }
  $now = Get-Date
  $currentPid = [int]$PID
  $processes = Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction SilentlyContinue
  foreach ($processInfo in @($processes)) {
    $processId = [int]$processInfo.ProcessId
    if ($processId -eq $currentPid) { continue }
    if (-not (Test-WatchdogCommandMatchesInstance ([string]$processInfo.CommandLine))) { continue }

    $startedAt = $null
    try {
      $startedAt = [System.Management.ManagementDateTimeConverter]::ToDateTime($processInfo.CreationDate)
    } catch {
      $startedAt = $null
    }
    if (-not $startedAt) { continue }

    $ageSeconds = ($now - $startedAt).TotalSeconds
    if ($ageSeconds -lt $WatchdogTimeoutSeconds) { continue }

    try {
      Stop-Process -Id $processId -Force -ErrorAction Stop
      Write-WatchdogLog "stopped stale watchdog pid=$processId age=$([int]$ageSeconds)s"
    } catch {
      Write-WatchdogLog "failed to stop stale watchdog pid=${processId}: $($_.Exception.Message)"
    }
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
  $npmLarkExe = Join-Path $env:APPDATA "npm\node_modules\@larksuite\cli\bin\lark-cli.exe"
  if (Test-Path -LiteralPath $npmLarkExe) { return $npmLarkExe }
  $cmd = Get-Command "lark-cli.cmd" -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $npmLark = Join-Path $env:APPDATA "npm\lark-cli.cmd"
  if (Test-Path -LiteralPath $npmLark) { return $npmLark }
  return $null
}

function ConvertTo-CmdArgument {
  param([string]$Value)
  return '"' + ($Value -replace '"', '""') + '"'
}

function ConvertTo-ProcessArgument {
  param([string]$Value)
  if ($Value -notmatch '[\s"]') { return $Value }
  return '"' + ($Value -replace '\\', '\\' -replace '"', '\"') + '"'
}

function Invoke-ProcessWithTimeout {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [int]$TimeoutMs = 15000
  )

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FilePath
  $psi.Arguments = (($Arguments | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join " ")
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  [void]$process.Start()
  if (-not $process.WaitForExit($TimeoutMs)) {
    try { $process.Kill() } catch {}
    try { [void]$process.WaitForExit(5000) } catch {}
    return @{
      ExitCode = -1
      Stdout = ""
      Stderr = ""
      TimedOut = $true
    }
  }
  return @{
    ExitCode = $process.ExitCode
    Stdout = $process.StandardOutput.ReadToEnd()
    Stderr = $process.StandardError.ReadToEnd()
    TimedOut = $false
  }
}

function Get-ExpectedEventKeys {
  $keys = @()
  foreach ($item in ($EventKeys -split '[,\s;]+')) {
    $trimmed = $item.Trim()
    if ($trimmed -and -not $keys.Contains($trimmed)) {
      $keys += $trimmed
    }
  }
  if (-not $keys.Count) {
    $keys += "im.message.receive_v1"
  }
  return $keys
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

  $processFile = $larkCli
  $processArgs = $statusArgs
  if ($larkCli -match '\.(cmd|bat)$') {
    $cmdLine = (ConvertTo-CmdArgument $larkCli) + " " + (($statusArgs | ForEach-Object { ConvertTo-CmdArgument $_ }) -join " ")
    $processFile = "cmd.exe"
    $processArgs = @("/d", "/s", "/c", $cmdLine)
  }
  $result = Invoke-ProcessWithTimeout -FilePath $processFile -Arguments ([string[]]$processArgs) -TimeoutMs 15000
  if ($result.TimedOut) {
    return @{ Ok = $false; Reason = "lark-cli status timed out" }
  }
  $stdout = [string]$result.Stdout
  $stderr = [string]$result.Stderr
  $outputText = $stdout

  try {
    $status = $outputText | ConvertFrom-Json
  } catch {
    if ($result.ExitCode -ne 0) {
      return @{ Ok = $false; Reason = "lark-cli status failed: $($stdout.Trim()) $($stderr.Trim())".Trim() }
    }
    return @{ Ok = $false; Reason = "lark-cli status returned invalid json" }
  }

  $runningKeys = @{}
  foreach ($app in @($status.apps)) {
    if (-not $app.running) { continue }
    foreach ($consumer in @($app.consumers)) {
      if ($consumer.event_key) {
        $runningKeys[[string]$consumer.event_key] = $consumer.pid
      }
    }
  }

  $expected = Get-ExpectedEventKeys
  $missing = @()
  $found = @()
  foreach ($key in $expected) {
    if ($runningKeys.ContainsKey($key)) {
      $found += "$key#$($runningKeys[$key])"
    } else {
      $missing += $key
    }
  }
  if (-not $missing.Count) {
    return @{ Ok = $true; Reason = "consumer $($found -join ', ')" }
  }

  return @{ Ok = $false; Reason = "missing consumer: $($missing -join ', ')" }
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

function Wait-BridgeHealthy {
  param([int]$TimeoutSeconds = 60)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $bridge = $null
  $consumer = @{ Ok = $false; Reason = "not checked yet" }

  while ((Get-Date) -lt $deadline) {
    $bridge = Get-BridgeProcess
    $consumer = Test-LarkConsumer
    if ($bridge -and $consumer.Ok) {
      return @{ Ok = $true; Bridge = $bridge; Consumer = $consumer }
    }
    Start-Sleep -Seconds 2
  }

  return @{ Ok = $false; Bridge = $bridge; Consumer = $consumer }
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
      "-EventKeys",
      $EventKeys,
      "-CodexTimeoutSeconds",
      $CodexTimeoutSeconds,
      "-CodexIdleTimeoutSeconds",
      $CodexIdleTimeoutSeconds
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

  $health = Wait-BridgeHealthy -TimeoutSeconds 60
  if ($health.Ok) {
    Write-WatchdogLog "restart ok; bridgePid=$($health.Bridge.Id); $($health.Consumer.Reason)"
  } else {
    Write-WatchdogLog "restart incomplete; bridge=$([bool]$health.Bridge); consumer=$($health.Consumer.Ok); reason=$($health.Consumer.Reason)"
  }
}

Rotate-WatchdogLog
Stop-StaleWatchdogProcesses

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
