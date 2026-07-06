param(
  [switch]$Json
)

$ErrorActionPreference = "Stop"

$scriptRoot = $PSScriptRoot
$bundledInstancesConfigPath = Join-Path $scriptRoot "bridge.instances.json"
$localInstancesConfigPath = Join-Path $scriptRoot "bridge.instances.local.json"
$instancesConfigPath = if ($env:CODEX_FEISHU_INSTANCES_CONFIG) {
  [System.IO.Path]::GetFullPath($env:CODEX_FEISHU_INSTANCES_CONFIG)
} elseif (Test-Path -LiteralPath $localInstancesConfigPath -PathType Leaf) {
  $localInstancesConfigPath
} else {
  $bundledInstancesConfigPath
}
$codexConfigPath = Join-Path $env:USERPROFILE ".codex\config.toml"

function Resolve-ConfiguredPath {
  param([string]$Path)
  if (-not $Path) { return "" }
  $value = [string]$Path
  $value = $value.Replace("C:\Users\<you>", $env:USERPROFILE)
  $value = $value.Replace("C:/Users/<you>", ($env:USERPROFILE -replace "\\", "/"))
  $value = $value.Replace("%USERPROFILE%", $env:USERPROFILE)
  if ($value -eq "C:\path\to\codex-feishu-bridge") { return $scriptRoot }
  if ($value -eq "C:/path/to/codex-feishu-bridge") { return ($scriptRoot -replace "\\", "/") }
  if ($value -like "C:\path\to\codex-feishu-bridge\*") {
    return (Join-Path $scriptRoot $value.Substring("C:\path\to\codex-feishu-bridge\".Length))
  }
  if ($value -like "C:/path/to/codex-feishu-bridge/*") {
    return (($scriptRoot -replace "\\", "/") + "/" + $value.Substring("C:/path/to/codex-feishu-bridge/".Length))
  }
  return $value
}

function Test-SafePath {
  param(
    [string]$Path,
    [string]$PathType = ""
  )
  if (-not $Path) { return $false }
  try {
    if ($PathType) {
      return (Test-Path -LiteralPath $Path -PathType $PathType)
    }
    return (Test-Path -LiteralPath $Path)
  } catch {
    return $false
  }
}

function Read-Utf8Text {
  param([string]$Path)
  if (-not (Test-SafePath -Path $Path -PathType Leaf)) { return $null }
  return [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($Path))
}

function Read-Utf8Json {
  param([string]$Path)
  $text = Read-Utf8Text -Path $Path
  if (-not $text) { return $null }
  $text = $text.TrimStart([char]0xFEFF)
  return $text | ConvertFrom-Json
}

function Test-DirectoryPath {
  param([string]$Path)
  if (-not $Path) { return $false }
  return (Test-SafePath -Path $Path -PathType Container)
}

function Test-FilePath {
  param([string]$Path)
  if (-not $Path) { return $false }
  return (Test-SafePath -Path $Path -PathType Leaf)
}

function Get-FileSummary {
  param([string]$Path)
  if (-not (Test-SafePath -Path $Path)) {
    return [pscustomobject]@{
      path = $Path
      exists = $false
      size = $null
      modifiedAt = ""
    }
  }

  $item = Get-Item -LiteralPath $Path -ErrorAction Stop
  return [pscustomobject]@{
    path = $Path
    exists = $true
    size = $item.Length
    modifiedAt = $item.LastWriteTime.ToString("o")
  }
}

function Get-DirectorySummary {
  param([string]$Path)
  if (-not (Test-SafePath -Path $Path -PathType Container)) {
    return [pscustomobject]@{
      path = $Path
      exists = $false
      modifiedAt = ""
    }
  }

  $item = Get-Item -LiteralPath $Path -ErrorAction Stop
  return [pscustomobject]@{
    path = $Path
    exists = $true
    modifiedAt = $item.LastWriteTime.ToString("o")
  }
}

function Get-PidFileProcess {
  param([string]$PidFile)
  $result = [ordered]@{
    pidFile = $PidFile
    pid = $null
    alive = $false
    processName = ""
    commandLine = ""
    startTime = ""
  }

  if (-not (Test-FilePath -Path $PidFile)) {
    return [pscustomobject]$result
  }

  $pidText = (Get-Content -LiteralPath $PidFile -Raw -ErrorAction SilentlyContinue).Trim()
  if ($pidText -notmatch '^\d+$') {
    return [pscustomobject]$result
  }

  $processIdValue = [int]$pidText
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$processIdValue" -ErrorAction SilentlyContinue
  $processObject = Get-Process -Id $processIdValue -ErrorAction SilentlyContinue

  $result.pid = $processIdValue
  if ($processInfo) {
    $result.alive = $true
    $result.processName = [string]$processInfo.Name
    $result.commandLine = [string]$processInfo.CommandLine
  }
  if ($processObject) {
    try { $result.startTime = $processObject.StartTime.ToString("o") } catch {}
  }

  return [pscustomobject]$result
}

function Get-ActiveRunCount {
  param([string]$Path)
  if (-not (Test-FilePath -Path $Path)) { return 0 }
  try {
    $active = Read-Utf8Json -Path $Path
    if (-not $active -or -not $active.runs) { return 0 }
    return @($active.runs.PSObject.Properties | Where-Object { $null -ne $_.Value }).Count
  } catch {
    return 0
  }
}

function Get-TaskState {
  param([string]$TaskName)
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) {
    return [pscustomobject]@{
      name = $TaskName
      exists = $false
      state = "Missing"
    }
  }

  return [pscustomobject]@{
    name = $TaskName
    exists = $true
    state = [string]$task.State
  }
}

function Test-PortListen {
  param([int]$Port)
  $connection = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $connection) {
    return [pscustomobject]@{
      port = $Port
      listening = $false
      owningProcess = $null
    }
  }

  return [pscustomobject]@{
    port = $Port
    listening = $true
    owningProcess = [int]$connection.OwningProcess
  }
}

function Read-TailText {
  param(
    [string]$Path,
    [int]$MaxBytes = 60000
  )
  if (-not (Test-FilePath -Path $Path)) { return "" }
  $info = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
  if (-not $info) { return "" }
  $length = [int64]$info.Length
  $start = [Math]::Max([int64]0, $length - [int64]$MaxBytes)
  $count = [int]($length - $start)
  if ($count -le 0) { return "" }

  $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
  try {
    $stream.Seek($start, [System.IO.SeekOrigin]::Begin) | Out-Null
    $buffer = New-Object byte[] $count
    $read = $stream.Read($buffer, 0, $count)
    return [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)
  } finally {
    $stream.Dispose()
  }
}

function Get-WatchdogHealth {
  param([string]$LogPath)
  $tail = Read-TailText -Path $LogPath -MaxBytes 50000
  $lines = @($tail -split "`r?`n" | Where-Object { $_ })
  $lastLine = ""
  if ($lines.Count -gt 0) { $lastLine = [string]$lines[$lines.Count - 1] }
  return [pscustomobject]@{
    logPath = $LogPath
    exists = (Test-FilePath -Path $LogPath)
    healthy = ($lastLine -match '\bhealthy\b')
    lastLine = $lastLine
  }
}

function Get-EnvKeysFromToml {
  param([string]$Path)
  $keys = @()
  $text = Read-Utf8Text -Path $Path
  if (-not $text) { return $keys }
  foreach ($line in ($text -split "`r?`n")) {
    $match = [regex]::Match($line, '^\s*env_key\s*=\s*["'']([^"'']+)["'']')
    if ($match.Success) {
      $keys += $match.Groups[1].Value
    }
  }
  return @($keys | Sort-Object -Unique)
}

function Get-EnvKeyStatus {
  param([string[]]$Keys)
  $rows = @()
  foreach ($key in @($Keys)) {
    if (-not $key) { continue }
    $processVisible = [bool][Environment]::GetEnvironmentVariable($key, "Process")
    $userVisible = [bool][Environment]::GetEnvironmentVariable($key, "User")
    $machineVisible = [bool][Environment]::GetEnvironmentVariable($key, "Machine")
    $rows += [pscustomobject]@{
      key = $key
      processVisible = $processVisible
      userVisible = $userVisible
      machineVisible = $machineVisible
      visibleSomewhere = ($processVisible -or $userVisible -or $machineVisible)
      valueShown = $false
    }
  }
  return $rows
}

function New-Check {
  param(
    [string]$Group,
    [string]$Name,
    [string]$Status,
    [string]$Message,
    [string]$Path = "",
    [string]$Impact = "",
    [string]$NextStep = ""
  )
  return [pscustomobject]@{
    group = $Group
    name = $Name
    status = $Status
    message = $Message
    path = $Path
    impact = $Impact
    nextStep = $NextStep
  }
}

$checks = @()
$config = Read-Utf8Json -Path $instancesConfigPath
if (-not $config) {
  $checks += New-Check -Group "配置" -Name "统一实例配置" -Status "bad" -Message "bridge.instances.json 不存在或无法解析。" -Path $instancesConfigPath -Impact "面板和自检无法使用集中配置。" -NextStep "恢复或重新生成 bridge.instances.json。"
  $config = [pscustomobject]@{
    paths = [pscustomobject]@{
      sourceRoot = $scriptRoot
      runtimeRoot = (Join-Path $env:LOCALAPPDATA "CodexFeishuBridge")
      codexHome = (Join-Path $env:USERPROFILE ".codex")
      codexConfig = $codexConfigPath
    }
    controlPanel = [pscustomobject]@{
      taskName = "CodexFeishuBridgeControlPanel"
      pidFile = (Join-Path $env:LOCALAPPDATA "CodexFeishuBridge\control-panel\state\control-panel.pid")
      port = 8320
    }
    proxies = @()
    instances = @()
  }
} else {
  $checks += New-Check -Group "配置" -Name "统一实例配置" -Status "ok" -Message "实例配置可读取。" -Path $instancesConfigPath
}

$sourceRoot = Resolve-ConfiguredPath -Path $(if ($config.paths.sourceRoot) { [string]$config.paths.sourceRoot } else { $scriptRoot })
$runtimeRoot = Resolve-ConfiguredPath -Path $(if ($config.paths.runtimeRoot) { [string]$config.paths.runtimeRoot } else { Join-Path $env:LOCALAPPDATA "CodexFeishuBridge" })
$codexConfigPath = Resolve-ConfiguredPath -Path $(if ($config.paths.codexConfig) { [string]$config.paths.codexConfig } else { $codexConfigPath })

$node = Get-Command "node.exe" -ErrorAction SilentlyContinue
if ($node) {
  $checks += New-Check -Group "基础环境" -Name "Node.js" -Status "ok" -Message "node.exe 可用。" -Path $node.Source
} else {
  $checks += New-Check -Group "基础环境" -Name "Node.js" -Status "bad" -Message "node.exe 不可用。" -Impact "Bridge 和控制面板都需要 Node.js。" -NextStep "安装 Node.js 或修复 PATH。"
}

$requiredFiles = @(
  "codex-feishu-bridge.mjs",
  "control-panel.mjs",
  "start-codex-feishu-bridge.ps1",
  "stop-codex-feishu-bridge.ps1",
  "watch-codex-feishu-bridge.ps1",
  "start-control-panel.ps1",
  "stop-control-panel.ps1",
  "control-panel\index.html",
  "control-panel\app.js",
  "control-panel\styles.css"
)
foreach ($relative in $requiredFiles) {
  $pathValue = Join-Path $sourceRoot $relative
  if (Test-FilePath -Path $pathValue) {
    $checks += New-Check -Group "基础环境" -Name $relative -Status "ok" -Message "关键文件存在。" -Path $pathValue
  } else {
    $checks += New-Check -Group "基础环境" -Name $relative -Status "bad" -Message "关键文件缺失。" -Path $pathValue -Impact "相关功能可能无法启动或展示。" -NextStep "从仓库恢复该文件。"
  }
}

if (Test-FilePath -Path $codexConfigPath) {
  $checks += New-Check -Group "Provider" -Name "Codex config.toml" -Status "ok" -Message "用户级 Codex 配置存在。" -Path $codexConfigPath
} else {
  $checks += New-Check -Group "Provider" -Name "Codex config.toml" -Status "bad" -Message "用户级 Codex 配置缺失。" -Path $codexConfigPath -Impact "Provider 和全局模型默认值无法确认。" -NextStep "恢复 C:\Users\yzjiang\.codex\config.toml。"
}

$envKeys = @(Get-EnvKeysFromToml -Path $codexConfigPath)
$envStatus = @(Get-EnvKeyStatus -Keys $envKeys)
foreach ($row in $envStatus) {
  if ($row.processVisible) {
    $checks += New-Check -Group "Provider" -Name $row.key -Status "ok" -Message "当前自检进程可见该 env_key。" -NextStep "无需处理。"
  } elseif ($row.visibleSomewhere) {
    $checks += New-Check -Group "Provider" -Name $row.key -Status "warn" -Message "系统或用户环境中能看到该 env_key，但当前自检进程不可见。" -Impact "已运行的 Bridge 可能需要重启后才能看到新 key。" -NextStep "只重启需要使用该 Provider 的空闲 Bot Bridge。"
  } else {
    $checks += New-Check -Group "Provider" -Name $row.key -Status "warn" -Message "未在 Process/User/Machine 环境中看到该 env_key。" -Impact "使用对应 Provider 时会鉴权失败。" -NextStep "设置用户环境变量后重启对应 Bridge。"
  }
}

$controlPanelPidFile = [string]$config.controlPanel.pidFile
if (-not $controlPanelPidFile) {
  $controlPanelPidFile = Join-Path $runtimeRoot "control-panel\state\control-panel.pid"
}
$controlPanelPidFile = Resolve-ConfiguredPath -Path $controlPanelPidFile
$controlPanelProcess = Get-PidFileProcess -PidFile $controlPanelPidFile
$controlPanelPort = if ($config.controlPanel.port) { [int]$config.controlPanel.port } else { 8320 }
$controlPanelPortStatus = Test-PortListen -Port $controlPanelPort
$controlPanelTask = Get-TaskState -TaskName ([string]$config.controlPanel.taskName)

if ($controlPanelProcess.alive) {
  $checks += New-Check -Group "控制面板" -Name "控制面板进程" -Status "ok" -Message "控制面板 PID 文件指向的进程在线。" -Path $controlPanelPidFile
} else {
  $checks += New-Check -Group "控制面板" -Name "控制面板进程" -Status "warn" -Message "控制面板 PID 文件没有指向在线进程。" -Path $controlPanelPidFile -Impact "浏览器面板可能打不开。" -NextStep "运行 start-control-panel.ps1 或启动控制面板 VBS。"
}

if ($controlPanelPortStatus.listening) {
  $checks += New-Check -Group "控制面板" -Name "控制面板端口" -Status "ok" -Message "127.0.0.1:$controlPanelPort 正在监听。" -Path ("http://127.0.0.1:{0}/" -f $controlPanelPort)
} else {
  $checks += New-Check -Group "控制面板" -Name "控制面板端口" -Status "warn" -Message "127.0.0.1:$controlPanelPort 未监听。" -Impact "浏览器无法访问控制面板。" -NextStep "启动控制面板服务。"
}

if ($controlPanelTask.exists) {
  $checks += New-Check -Group "控制面板" -Name "控制面板计划任务" -Status "ok" -Message ("计划任务存在，状态：{0}" -f $controlPanelTask.state) -Path $controlPanelTask.name
} else {
  $checks += New-Check -Group "控制面板" -Name "控制面板计划任务" -Status "warn" -Message "控制面板开机自启动计划任务不存在。" -Impact "开机后控制面板可能不会自动启动。" -NextStep "运行 install-control-panel-watchdog.ps1。"
}

$instances = @()
foreach ($instance in @($config.instances)) {
  $runtime = Resolve-ConfiguredPath -Path ([string]$instance.runtimeRoot)
  $workspace = Resolve-ConfiguredPath -Path ([string]$instance.workspace)
  $codexHome = Resolve-ConfiguredPath -Path ([string]$instance.codexHome)
  $desktopCodexHome = Resolve-ConfiguredPath -Path ([string]$instance.desktopCodexHome)
  $stateDir = Join-Path $runtime "state"
  $logDir = Join-Path $runtime "logs"
  $paths = [ordered]@{
    runtimeRoot = $runtime
    workspace = $workspace
    codexHome = $codexHome
    desktopCodexHome = $desktopCodexHome
    stateDir = $stateDir
    logDir = $logDir
    bridgePidFile = (Join-Path $stateDir "bridge.pid")
    activeRunsFile = (Join-Path $stateDir "active-runs.json")
    launchConfigFile = (Join-Path $stateDir "launch-config.json")
    watchdogLogFile = (Join-Path $logDir "watchdog.log")
    bridgeLogFile = (Join-Path $logDir "codex-feishu-bridge.log")
    stateDbFile = (Join-Path $codexHome "state_5.sqlite")
    sessionIndexFile = (Join-Path $codexHome "session_index.jsonl")
    sessionsDir = (Join-Path $codexHome "sessions")
  }

  $process = Get-PidFileProcess -PidFile $paths.bridgePidFile
  $activeRunCount = Get-ActiveRunCount -Path $paths.activeRunsFile
  $task = Get-TaskState -TaskName ([string]$instance.taskName)
  $watchdog = Get-WatchdogHealth -LogPath $paths.watchdogLogFile

  $sidebarOk = ((Test-FilePath -Path $paths.stateDbFile) -and (Test-FilePath -Path $paths.sessionIndexFile) -and (Test-DirectoryPath -Path $paths.sessionsDir))

  $instances += [pscustomobject]@{
    id = [string]$instance.id
    name = [string]$instance.name
    label = [string]$instance.label
    larkProfile = [string]$instance.larkProfile
    online = [bool]$process.alive
    pid = $process.pid
    activeRunCount = $activeRunCount
    task = $task
    watchdog = $watchdog
    sidebarIndexFilesOk = $sidebarOk
    paths = [pscustomobject]$paths
  }

  if ($process.alive) {
    $checks += New-Check -Group "Bot" -Name $instance.name -Status "ok" -Message ("Bridge 在线，PID {0}。" -f $process.pid) -Path $paths.bridgePidFile
  } else {
    $checks += New-Check -Group "Bot" -Name $instance.name -Status "bad" -Message "Bridge 不在线。" -Path $paths.bridgePidFile -Impact "这个 Bot 无法响应飞书消息。" -NextStep "如果没有 active run，用 watchdog 或启动脚本拉起该 Bot。"
  }

  if ($activeRunCount -gt 0) {
    $checks += New-Check -Group "Bot" -Name ("{0} active run" -f $instance.name) -Status "warn" -Message ("当前有 {0} 个运行中任务。" -f $activeRunCount) -Path $paths.activeRunsFile -Impact "此 Bot 不应被重启。" -NextStep "等待任务结束，或确认 active-runs.json 是否残留。"
  } else {
    $checks += New-Check -Group "Bot" -Name ("{0} active run" -f $instance.name) -Status "ok" -Message "当前空闲。" -Path $paths.activeRunsFile
  }

  if ($task.exists) {
    $checks += New-Check -Group "Watchdog" -Name $instance.taskName -Status "ok" -Message ("计划任务存在，状态：{0}" -f $task.state) -Path ([string]$instance.taskName)
  } else {
    $checks += New-Check -Group "Watchdog" -Name $instance.taskName -Status "bad" -Message "watchdog 计划任务缺失。" -Impact "Bridge 掉线后不会自动拉起。" -NextStep "运行 install-codex-feishu-watchdog.ps1。"
  }

  if ($watchdog.healthy) {
    $checks += New-Check -Group "Watchdog" -Name ("{0} watchdog.log" -f $instance.name) -Status "ok" -Message "最近 watchdog 日志包含 healthy。" -Path $paths.watchdogLogFile
  } else {
    $checks += New-Check -Group "Watchdog" -Name ("{0} watchdog.log" -f $instance.name) -Status "warn" -Message "最近 watchdog 日志未看到 healthy。" -Path $paths.watchdogLogFile -Impact "自动保活状态需要人工确认。" -NextStep "查看 watchdog.log 最后一行。"
  }

  if ($sidebarOk) {
    $checks += New-Check -Group "侧边栏索引" -Name $instance.name -Status "ok" -Message "Codex Desktop 侧边栏关键索引文件存在。" -Path $paths.codexHome
  } else {
    $checks += New-Check -Group "侧边栏索引" -Name $instance.name -Status "warn" -Message "侧边栏索引关键文件不完整。" -Path $paths.codexHome -Impact "Codex Desktop 侧边栏可能看不到该 Bot 创建的 thread。" -NextStep "让该 Bot 完成一次正常对话后再次自检。"
  }
}

$proxyRows = @()
$configuredProxies = @()
if ($config.proxies) {
  $configuredProxies = @($config.proxies)
} elseif ($config.localProxies) {
  $configuredProxies = @($config.localProxies)
}
foreach ($proxy in $configuredProxies) {
  $portStatus = Test-PortListen -Port ([int]$proxy.port)
  $proxyId = if ($proxy.id) { [string]$proxy.id } else { [string]$proxy.name }
  $proxyUrl = if ($proxy.url) { [string]$proxy.url } else { "http://127.0.0.1:{0}/v1" -f ([int]$proxy.port) }
  $proxyRows += [pscustomobject]@{
    id = $proxyId
    label = [string]$proxy.label
    port = [int]$proxy.port
    url = $proxyUrl
    online = [bool]$portStatus.listening
    owningProcess = $portStatus.owningProcess
    note = [string]$proxy.note
  }
  if ($portStatus.listening) {
    $checks += New-Check -Group "本地代理" -Name $proxyId -Status "ok" -Message ("端口 {0} 正在监听。" -f $proxy.port) -Path $proxyUrl
  } else {
    $checks += New-Check -Group "本地代理" -Name $proxyId -Status "bad" -Message ("端口 {0} 未监听。" -f $proxy.port) -Path $proxyUrl -Impact "对应非 GPT 模型 Provider 无法使用。" -NextStep "检查 Mimo2CodexProxyWatchdog 或 start-mimo2codex-proxies.ps1。"
  }
}

$proxyTask = Get-TaskState -TaskName "Mimo2CodexProxyWatchdog"
if ($proxyTask.exists) {
  $checks += New-Check -Group "本地代理" -Name "Mimo2CodexProxyWatchdog" -Status "ok" -Message ("计划任务存在，状态：{0}" -f $proxyTask.state) -Path "Mimo2CodexProxyWatchdog"
} else {
  $checks += New-Check -Group "本地代理" -Name "Mimo2CodexProxyWatchdog" -Status "warn" -Message "本地代理 watchdog 计划任务缺失。" -Impact "8788/8789 掉线后可能不会自动恢复。" -NextStep "运行 install-mimo2codex-proxy-watchdog.ps1。"
}

$summary = [pscustomobject]@{
  totalChecks = @($checks).Count
  ok = @($checks | Where-Object { $_.status -eq "ok" }).Count
  warn = @($checks | Where-Object { $_.status -eq "warn" }).Count
  bad = @($checks | Where-Object { $_.status -eq "bad" }).Count
  totalBots = @($instances).Count
  onlineBots = @($instances | Where-Object { $_.online }).Count
  activeRuns = @($instances | Measure-Object -Property activeRunCount -Sum).Sum
  proxiesOnline = @($proxyRows | Where-Object { $_.online }).Count
  totalProxies = @($proxyRows).Count
}

$report = [pscustomobject]@{
  ok = ($summary.bad -eq 0)
  generatedAt = (Get-Date).ToString("o")
  device = $config.device
  configPath = $instancesConfigPath
  sourceRoot = $sourceRoot
  runtimeRoot = $runtimeRoot
  codexConfigPath = $codexConfigPath
  controlPanel = [pscustomobject]@{
    process = $controlPanelProcess
    port = $controlPanelPortStatus
    task = $controlPanelTask
    config = $config.controlPanel
  }
  summary = $summary
  checks = $checks
  instances = $instances
  proxies = $proxyRows
  envKeys = $envStatus
}

if ($Json) {
  $report | ConvertTo-Json -Depth 9
  exit 0
}

Write-Host "Codex 飞书 Bridge 自检报告"
Write-Host ("生成时间：{0}" -f $report.generatedAt)
Write-Host ("配置文件：{0}" -f $instancesConfigPath)
Write-Host ("Bot：{0}/{1} 在线；active run：{2}；代理：{3}/{4} 在线" -f $summary.onlineBots, $summary.totalBots, $summary.activeRuns, $summary.proxiesOnline, $summary.totalProxies)
Write-Host ("检查项：OK {0} / WARN {1} / BAD {2}" -f $summary.ok, $summary.warn, $summary.bad)
Write-Host ""

$checks |
  Sort-Object group, status, name |
  Select-Object group, status, name, message, path |
  Format-Table -AutoSize

if ($summary.bad -gt 0 -or $summary.warn -gt 0) {
  Write-Host ""
  Write-Host "需要关注："
  foreach ($item in @($checks | Where-Object { $_.status -ne "ok" })) {
    Write-Host ("- [{0}] {1} / {2}: {3}" -f $item.status, $item.group, $item.name, $item.message)
    if ($item.impact) { Write-Host ("  影响：{0}" -f $item.impact) }
    if ($item.nextStep) { Write-Host ("  建议：{0}" -f $item.nextStep) }
    if ($item.path) { Write-Host ("  路径：{0}" -f $item.path) }
  }
}
