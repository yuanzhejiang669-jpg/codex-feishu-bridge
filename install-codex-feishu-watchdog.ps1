param(
  [string]$Workspace = (Join-Path $PSScriptRoot "workspace"),
  [string]$TaskName = "CodexFeishuBridgeWatchdog",
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$watchdogScript = Join-Path $PSScriptRoot "watch-codex-feishu-bridge.ps1"
$hiddenLauncher = Join-Path $PSScriptRoot "watch-codex-feishu-bridge-hidden.vbs"

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled task if it existed: $TaskName"
  exit 0
}

if (-not (Test-Path -LiteralPath $watchdogScript)) {
  throw "Watchdog script not found: $watchdogScript"
}
if (-not (Test-Path -LiteralPath $hiddenLauncher)) {
  throw "Hidden launcher not found: $hiddenLauncher"
}
if (-not (Test-Path -LiteralPath $Workspace)) {
  throw "Workspace not found: $Workspace"
}

$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$author = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$startBoundary = (Get-Date).Date.ToString("yyyy-MM-ddTHH:mm:ss")
$workingDirectory = $PSScriptRoot
$arguments = "`"$hiddenLauncher`" `"$Workspace`""

function Escape-XmlText {
  param([string]$Text)
  return [System.Security.SecurityElement]::Escape($Text)
}

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>$(Escape-XmlText $author)</Author>
    <Description>Keep the Codex Feishu bridge running after login, unlock, and routine health checks.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$(Escape-XmlText $sid)</UserId>
    </LogonTrigger>
    <SessionStateChangeTrigger>
      <Enabled>true</Enabled>
      <UserId>$(Escape-XmlText $sid)</UserId>
      <StateChange>SessionUnlock</StateChange>
    </SessionStateChangeTrigger>
    <CalendarTrigger>
      <StartBoundary>$startBoundary</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
      <Repetition>
        <Interval>PT5M</Interval>
        <Duration>P1D</Duration>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$(Escape-XmlText $sid)</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT3M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>$(Escape-XmlText $arguments)</Arguments>
      <WorkingDirectory>$(Escape-XmlText $workingDirectory)</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

Register-ScheduledTask -TaskName $TaskName -Xml $xml -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3

$task = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName

Write-Host "Installed scheduled task: $TaskName"
Write-Host "State: $($task.State)"
Write-Host "LastRunTime: $($info.LastRunTime)"
Write-Host "LastTaskResult: $($info.LastTaskResult)"
