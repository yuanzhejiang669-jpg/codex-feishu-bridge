$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Server = Join-Path $Root "src\server.mjs"
$Node = (Get-Command node).Source
$PortText = $env:BROWSER_CONTROL_EXTENSION_PORT
if (-not $PortText) { $PortText = "18795" }
$Port = [int]$PortText
$CodexConfig = Join-Path $env:USERPROFILE ".codex\config.toml"
if (-not $env:BROWSER_CONTROL_EXTENSION_TOKEN -and (Test-Path $CodexConfig)) {
    $tokenLine = Select-String -Path $CodexConfig -Pattern 'BROWSER_CONTROL_EXTENSION_TOKEN\s*=' | Select-Object -First 1
    if ($tokenLine -and $tokenLine.Line -match 'BROWSER_CONTROL_EXTENSION_TOKEN\s*=\s*"([^"]+)"') {
        $env:BROWSER_CONTROL_EXTENSION_TOKEN = $Matches[1]
    }
}

$connections = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($connection in $connections) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)" -ErrorAction SilentlyContinue
    if ($process -and $process.CommandLine -match "browser-control-mcp[\\/]+src[\\/]+server\.mjs") {
        Stop-Process -Id $process.ProcessId -Force
        Write-Output "Stopped browser-control-mcp bridge process $($process.ProcessId) on port $Port"
    } elseif ($process) {
        throw "Port $Port is owned by non-browser-control process $($process.ProcessId): $($process.CommandLine)"
    }
}

function Test-BridgeReady {
    try {
        $response = Invoke-RestMethod -Method Get "http://127.0.0.1:$Port/" -TimeoutSec 2
        if (-not $response) { return $false }
        if ($env:BROWSER_CONTROL_EXTENSION_TOKEN) {
            $body = @{ id = "restart-health"; cmd = "get_health" } | ConvertTo-Json -Compress
            $headers = @{ "x-codex-browser-token" = $env:BROWSER_CONTROL_EXTENSION_TOKEN }
            $health = Invoke-RestMethod -Method Post "http://127.0.0.1:$Port/link" -ContentType "application/json" -Headers $headers -Body $body -TimeoutSec 2
            return [bool]$health
        }
        return $true
    } catch {
        return $false
    }
}

function Start-BridgeProcess {
    $commandLine = "`"$Node`" `"$Server`""
    try {
        $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
            CommandLine = $commandLine
            CurrentDirectory = [string]$Root
        }
        if ($result.ReturnValue -eq 0 -and $result.ProcessId) {
            return [int]$result.ProcessId
        }
        Write-Output "Win32_Process.Create returned $($result.ReturnValue); falling back to Start-Process"
    } catch {
        Write-Output "Win32_Process.Create failed: $($_.Exception.Message); falling back to Start-Process"
    }
    $child = Start-Process -FilePath $Node -ArgumentList @($Server) -WorkingDirectory $Root -WindowStyle Hidden -PassThru
    return [int]$child.Id
}

function Test-ProcessRunning($ProcessId) {
    return [bool](Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

$attempts = 3
for ($attempt = 1; $attempt -le $attempts; $attempt++) {
    $childId = Start-BridgeProcess
    Write-Output "Started browser-control-mcp bridge process $childId on port $Port (attempt $attempt/$attempts)"

    $deadline = (Get-Date).AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 250
        if (-not (Test-ProcessRunning $childId)) { break }
        if (Test-BridgeReady) {
            if ($env:BROWSER_CONTROL_EXTENSION_TOKEN) {
                Write-Output "Bridge HTTP endpoint and token-authenticated link are reachable."
            } else {
                Write-Output "Bridge HTTP endpoint is reachable."
            }
            exit 0
        }
    } while ((Get-Date) -lt $deadline)

    if (-not (Test-ProcessRunning $childId)) {
        Write-Output "Bridge process $childId exited early"
    } else {
        Stop-Process -Id $childId -Force -ErrorAction SilentlyContinue
        Write-Output "Stopped unreachable browser-control-mcp bridge process $childId"
    }
    Start-Sleep -Seconds $attempt
}

throw "Bridge did not become reachable on port $Port after $attempts attempts"
