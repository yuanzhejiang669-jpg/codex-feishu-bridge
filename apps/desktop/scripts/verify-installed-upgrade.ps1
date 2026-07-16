param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedVersion,

    [string]$InstalledExecutable = "$env:LOCALAPPDATA\Programs\Codex Feishu Bridge\Codex Feishu Bridge.exe",

    [string]$DataRoot = "$env:LOCALAPPDATA\CodexFeishuBridgeDesktop"
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

foreach ($required in @($InstallerPath, $InstalledExecutable, $DataRoot)) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Required upgrade path does not exist: $required"
    }
}

$managedRoot = Join-Path $DataRoot 'managed-bots'
$runtimeRoot = Join-Path $DataRoot 'runtime-localappdata\CodexFeishuBridge\instances'
$before = @{}

foreach ($directory in Get-ChildItem -LiteralPath $managedRoot -Directory) {
    $name = $directory.Name
    $stateRoot = Join-Path (Join-Path $runtimeRoot $name) 'state'
    $pidPath = Join-Path $stateRoot 'bridge.pid'
    $activePath = Join-Path $stateRoot 'active-runs.json'
    if (-not (Test-Path -LiteralPath $pidPath)) {
        throw "Managed Bot has no PID file: $name"
    }
    $bridgePidText = ([Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($pidPath))).Trim()
    if ($bridgePidText -notmatch '^\d+$') {
        throw "Managed Bot has an invalid PID: $name"
    }
    $bridgeProcess = Get-Process -Id ([int]$bridgePidText) -ErrorAction SilentlyContinue
    if ($null -eq $bridgeProcess) {
        throw "Managed Bot is offline before upgrade: $name"
    }
    $activeCount = 0
    if (Test-Path -LiteralPath $activePath) {
        $activeText = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($activePath))
        $active = $activeText | ConvertFrom-Json
        if ($null -ne $active.runs) {
            $activeCount = @($active.runs.PSObject.Properties | Where-Object { $null -ne $_.Value }).Count
        }
    }
    if ($activeCount -gt 0) {
        throw "Managed Bot has $activeCount active run(s): $name"
    }
    $before[$name] = [int]$bridgePidText
}

$installedFullPath = [IO.Path]::GetFullPath($InstalledExecutable)
$desktopProcesses = Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).Equals($installedFullPath, [StringComparison]::OrdinalIgnoreCase)
}
foreach ($desktopProcess in $desktopProcesses) {
    Stop-Process -Id $desktopProcess.ProcessId -Force -ErrorAction SilentlyContinue
}

$deadline = (Get-Date).AddSeconds(15)
do {
    $remaining = Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).Equals($installedFullPath, [StringComparison]::OrdinalIgnoreCase)
    }
    if (-not $remaining) { break }
    Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $deadline)
if ($remaining) { throw 'Installed desktop client did not exit before upgrade' }

$installer = Start-Process -FilePath $InstallerPath -ArgumentList @('/S') -WindowStyle Hidden -Wait -PassThru
if ($installer.ExitCode -ne 0) {
    throw "Installer failed with exit code $($installer.ExitCode)"
}

function Normalize-ReleaseVersion([string]$Value) {
    if ($Value -match '^(\d+)\.(\d+)(?:\.(\d+))?(?:\.0)?$') {
        $patch = if ($null -ne $Matches[3] -and $Matches[3] -ne '') { [int]$Matches[3] } else { 0 }
        return "$([int]$Matches[1]).$([int]$Matches[2]).$patch"
    }
    return $Value.Trim()
}

$installedVersion = (Get-Item -LiteralPath $InstalledExecutable).VersionInfo.ProductVersion
if ((Normalize-ReleaseVersion $installedVersion) -ne (Normalize-ReleaseVersion $ExpectedVersion)) {
    throw "Installed executable version mismatch: expected $ExpectedVersion, actual $installedVersion"
}

$uninstall = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like 'Codex Feishu Bridge*' } |
    Sort-Object DisplayVersion -Descending |
    Select-Object -First 1
if ($null -eq $uninstall -or $uninstall.DisplayVersion -ne $ExpectedVersion) {
    throw "Windows uninstall registry version mismatch: $($uninstall.DisplayVersion)"
}

Start-Process -FilePath $InstalledExecutable -ArgumentList @('--background') -WindowStyle Hidden | Out-Null
$deadline = (Get-Date).AddSeconds(20)
do {
    $desktopMain = Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).Equals($installedFullPath, [StringComparison]::OrdinalIgnoreCase) -and
        $_.CommandLine -notmatch '--type='
    } | Select-Object -First 1
    if ($desktopMain) { break }
    Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $deadline)
if (-not $desktopMain) { throw 'Upgraded desktop client did not start' }

$recoveryDeadline = (Get-Date).AddMinutes(5)
$stableSince = $null
$stableSignature = ''
do {
    $botRows = foreach ($name in $before.Keys | Sort-Object) {
        $pidPath = Join-Path (Join-Path (Join-Path $runtimeRoot $name) 'state') 'bridge.pid'
        $bridgePidText = ''
        $bridgeProcess = $null
        if (Test-Path -LiteralPath $pidPath) {
            $bridgePidText = ([Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($pidPath))).Trim()
            if ($bridgePidText -match '^\d+$') {
                $bridgeProcess = Get-Process -Id ([int]$bridgePidText) -ErrorAction SilentlyContinue
            }
        }
        [pscustomobject]@{
            name = $name
            previousProcessId = $before[$name]
            processId = if ($bridgePidText -match '^\d+$') { [int]$bridgePidText } else { 0 }
            online = $null -ne $bridgeProcess
            restarted = $null -ne $bridgeProcess -and [int]$bridgePidText -ne $before[$name]
        }
    }
    $offlineCount = @($botRows | Where-Object { -not $_.online }).Count
    $signature = (@($botRows | Sort-Object name | ForEach-Object { "$($_.name):$($_.processId)" })) -join '|'
    if ($offlineCount -eq 0) {
        if ($stableSignature -ne $signature) {
            $stableSignature = $signature
            $stableSince = Get-Date
        }
        if (((Get-Date) - $stableSince).TotalSeconds -ge 60) { break }
    } else {
        $stableSince = $null
        $stableSignature = ''
    }
    Start-Sleep -Seconds 2
} while ((Get-Date) -lt $recoveryDeadline)
if (@($botRows | Where-Object { -not $_.online }).Count -gt 0 -or $null -eq $stableSince -or ((Get-Date) - $stableSince).TotalSeconds -lt 60) {
    $offlineNames = ($botRows | Where-Object { -not $_.online } | Select-Object -ExpandProperty name) -join ', '
    throw "Managed Bots did not remain stable for 60 seconds after upgrade: $offlineNames"
}

[pscustomobject]@{
    ok = $true
    installedVersion = $installedVersion
    uninstallVersion = $uninstall.DisplayVersion
    desktopProcessId = $desktopMain.ProcessId
    recoveryMode = 'restart-after-client-upgrade'
    stableSeconds = [int]((Get-Date) - $stableSince).TotalSeconds
    managedBots = $botRows
} | ConvertTo-Json -Depth 4
