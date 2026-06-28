param(
  [string]$HostName = "127.0.0.1",
  [int]$DefaultPort = 8788,
  [int]$ApiDeepSeekPort = 8789,
  [int]$StartupWaitSeconds = 20
)

$ErrorActionPreference = "Stop"

$dataRoot = Join-Path $env:LOCALAPPDATA "CodexFeishuBridge\mimo2codex-proxies"
$logDir = Join-Path $dataRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-ProxyLog {
  param([string]$Message)
  $line = "{0} {1}" -f (Get-Date).ToString("o"), $Message
  Add-Content -LiteralPath (Join-Path $logDir "watchdog.log") -Value $line -Encoding UTF8
}

function Import-UserEnvIfMissing {
  param([string[]]$Names)
  foreach ($name in $Names) {
    $current = [Environment]::GetEnvironmentVariable($name, "Process")
    if (-not [string]::IsNullOrWhiteSpace($current)) {
      continue
    }
    $userValue = [Environment]::GetEnvironmentVariable($name, "User")
    if ([string]::IsNullOrWhiteSpace($userValue)) {
      continue
    }
    [Environment]::SetEnvironmentVariable($name, $userValue, "Process")
  }
}

function ConvertTo-ProcessArgument {
  param([string]$Value)
  if ($Value -notmatch '[\s"]') { return $Value }
  return '"' + ($Value -replace '\\', '\\' -replace '"', '\"') + '"'
}

function Get-Mimo2CodexLaunch {
  $node = Get-Command "node.exe" -ErrorAction SilentlyContinue
  $moduleCli = Join-Path $env:APPDATA "npm\node_modules\mimo2codex\dist\cli.js"
  if ($node -and (Test-Path -LiteralPath $moduleCli)) {
    return @{
      FilePath = $node.Source
      PrefixArgs = @($moduleCli)
      Kind = "node"
    }
  }

  $cmd = Get-Command "mimo2codex.cmd" -ErrorAction SilentlyContinue
  if (-not $cmd) {
    $cmdPath = Join-Path $env:APPDATA "npm\mimo2codex.cmd"
    if (Test-Path -LiteralPath $cmdPath) {
      $cmd = @{ Source = $cmdPath }
    }
  }
  if ($cmd) {
    return @{
      FilePath = "cmd.exe"
      PrefixArgs = @("/d", "/s", "/c", "`"$($cmd.Source)`"")
      Kind = "cmd"
    }
  }

  throw "mimo2codex was not found. Install it with: npm install -g mimo2codex"
}

function Test-TcpPort {
  param(
    [string]$HostValue,
    [int]$Port
  )
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect($HostValue, $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(1000, $false)) {
      return $false
    }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Get-Mimo2CodexProcessesByPort {
  param([int]$Port)
  $pattern = "(?i)mimo2codex"
  $portPattern = "(?i)(?:--port\s+|--port=)$Port(?:\s|$)"
  $processes = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" -ErrorAction SilentlyContinue
  @($processes | Where-Object {
    $cmd = [string]$_.CommandLine
    $cmd -match $pattern -and $cmd -match $portPattern
  })
}

function Stop-DuplicateProxyProcesses {
  param(
    [int]$Port,
    [object[]]$Processes
  )
  if (@($Processes).Count -le 1) { return @($Processes) }

  $ordered = @($Processes | Sort-Object CreationDate)
  $keep = $ordered[0]
  foreach ($duplicate in @($ordered | Select-Object -Skip 1)) {
    try {
      Stop-Process -Id ([int]$duplicate.ProcessId) -Force -ErrorAction Stop
      Write-ProxyLog "stopped duplicate mimo2codex process port=$Port pid=$($duplicate.ProcessId)"
    } catch {
      Write-ProxyLog "failed to stop duplicate process port=$Port pid=$($duplicate.ProcessId): $($_.Exception.Message)"
    }
  }
  return @($keep)
}

function Stop-StaleProxyProcesses {
  param(
    [int]$Port,
    [object[]]$Processes
  )
  foreach ($processInfo in @($Processes)) {
    try {
      Stop-Process -Id ([int]$processInfo.ProcessId) -Force -ErrorAction Stop
      Write-ProxyLog "stopped stale mimo2codex process port=$Port pid=$($processInfo.ProcessId)"
    } catch {
      Write-ProxyLog "failed to stop stale process port=$Port pid=$($processInfo.ProcessId): $($_.Exception.Message)"
    }
  }
}

function Start-Mimo2CodexProxy {
  param(
    [string]$Name,
    [int]$Port,
    [string[]]$Arguments
  )

  $matching = @(Get-Mimo2CodexProcessesByPort -Port $Port)
  if (Test-TcpPort -HostValue $HostName -Port $Port) {
    $pidText = if (@($matching).Count -gt 0) { (@($matching | Select-Object -ExpandProperty ProcessId) -join ",") } else { "unknown" }
    Write-ProxyLog "healthy $Name port=$Port pid=$pidText"
    return
  }

  if (@($matching).Count -gt 0) {
    Stop-StaleProxyProcesses -Port $Port -Processes $matching
  }

  $launch = Get-Mimo2CodexLaunch
  $allArgs = @($launch.PrefixArgs) + @($Arguments)
  $stdout = Join-Path $logDir "$Name.out.log"
  $stderr = Join-Path $logDir "$Name.err.log"

  $process = Start-Process `
    -FilePath $launch.FilePath `
    -ArgumentList (($allArgs | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join " ") `
    -WorkingDirectory $PSScriptRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -PassThru

  Write-ProxyLog "started $Name port=$Port pid=$($process.Id)"

  $deadline = (Get-Date).AddSeconds($StartupWaitSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-TcpPort -HostValue $HostName -Port $Port) {
      Write-ProxyLog "ready $Name port=$Port pid=$($process.Id)"
      return
    }
    Start-Sleep -Milliseconds 500
  }

  Write-ProxyLog "start timeout $Name port=$Port pid=$($process.Id)"
}

Import-UserEnvIfMissing @(
  "MIMO2CODEX_KEY",
  "DEEPSEEK_API_KEY",
  "DS_API_KEY",
  "APIDEEPSEEK_API_KEY",
  "KIMI_API_KEY",
  "GLM_API_KEY",
  "XAI_API_KEY"
)

Start-Mimo2CodexProxy `
  -Name "mimo2codex-8788" `
  -Port $DefaultPort `
  -Arguments @("--model", "ds", "--host", $HostName, "--port", [string]$DefaultPort)

Start-Mimo2CodexProxy `
  -Name "mimo2codex-apideepseek-8789" `
  -Port $ApiDeepSeekPort `
  -Arguments @(
    "--no-load-env",
    "--data-dir",
    (Join-Path $env:USERPROFILE ".mimo2codex-apideepseek"),
    "--model",
    "apideepseek",
    "--host",
    $HostName,
    "--port",
    [string]$ApiDeepSeekPort
  )
