[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }),
    [string]$RepoRoot,
    [string]$UserHome = $env:USERPROFILE,
    [string]$WorkspaceRoot,
    [string]$RuntimeRoot,
    [string]$CodexHomesRoot,
    [string]$NodeExe = 'node',
    [string]$PythonExe = 'python',
    [string]$InstancesDestination,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

if (-not $RepoRoot) {
    $RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
}
if (-not $WorkspaceRoot) {
    $WorkspaceRoot = Join-Path $UserHome 'Documents\Codex\workspaces'
}
if (-not $RuntimeRoot) {
    $RuntimeRoot = Join-Path $env:LOCALAPPDATA 'CodexFeishuBridge'
}
if (-not $CodexHomesRoot) {
    $CodexHomesRoot = Join-Path $UserHome 'Documents\Codex\codex-homes'
}

$CodexHome = [System.IO.Path]::GetFullPath($CodexHome)
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
$UserHome = [System.IO.Path]::GetFullPath($UserHome)
$WorkspaceRoot = [System.IO.Path]::GetFullPath($WorkspaceRoot)
$RuntimeRoot = [System.IO.Path]::GetFullPath($RuntimeRoot)
$CodexHomesRoot = [System.IO.Path]::GetFullPath($CodexHomesRoot)

function ConvertTo-PortablePath([string]$Path) {
    return $Path.Replace('\', '/')
}

$tokens = @{
    '{{CODEX_HOME}}' = ConvertTo-PortablePath $CodexHome
    '{{REPO_ROOT}}' = ConvertTo-PortablePath $RepoRoot
    '{{USER_HOME}}' = ConvertTo-PortablePath $UserHome
    '{{WORKSPACE_ROOT}}' = ConvertTo-PortablePath $WorkspaceRoot
    '{{RUNTIME_ROOT}}' = ConvertTo-PortablePath $RuntimeRoot
    '{{CODEX_HOMES_ROOT}}' = ConvertTo-PortablePath $CodexHomesRoot
    '{{NODE_EXE}}' = (ConvertTo-PortablePath $NodeExe).Replace('"', '\"')
    '{{PYTHON_EXE}}' = (ConvertTo-PortablePath $PythonExe).Replace('"', '\"')
}

function Expand-Template([string]$Text) {
    foreach ($entry in $tokens.GetEnumerator()) {
        $Text = $Text.Replace($entry.Key, $entry.Value)
    }
    return $Text
}

function Ensure-Directory([string]$Path) {
    if (Test-Path -LiteralPath $Path) { return }
    if ($PSCmdlet.ShouldProcess($Path, 'Create directory')) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Install-Text([string]$Source, [string]$Destination, [switch]$Render) {
    if ((Test-Path -LiteralPath $Destination) -and -not $Force) {
        Write-Verbose "Skipping existing file: $Destination"
        return
    }
    $parent = Split-Path -Parent $Destination
    Ensure-Directory $parent
    if ($PSCmdlet.ShouldProcess($Destination, 'Install file')) {
        $text = [System.IO.File]::ReadAllText($Source, [System.Text.Encoding]::UTF8)
        if ($Render) { $text = Expand-Template $text }
        [System.IO.File]::WriteAllText($Destination, $text, (New-Object System.Text.UTF8Encoding($false)))
    }
}

$bootstrapRoot = $PSScriptRoot
Install-Text (Join-Path $bootstrapRoot 'AGENTS.md') (Join-Path $CodexHome 'AGENTS.md')
Install-Text (Join-Path $bootstrapRoot 'config.example.toml') (Join-Path $CodexHome 'config.toml') -Render

$skillsSource = Join-Path $RepoRoot 'skills'
$skillsDestination = Join-Path $CodexHome 'skills'
Get-ChildItem -LiteralPath $skillsSource -Recurse -File | ForEach-Object {
    if ($_.Name -eq 'README.md') { return }
    $relative = $_.FullName.Substring($skillsSource.Length).TrimStart('\', '/')
    Install-Text $_.FullName (Join-Path $skillsDestination $relative)
}

if ($InstancesDestination) {
    $InstancesDestination = [System.IO.Path]::GetFullPath($InstancesDestination)
    Install-Text (Join-Path $bootstrapRoot 'bridge.instances.personal.example.json') $InstancesDestination -Render
}

Write-Host "Personal environment installation evaluated for: $CodexHome"
if (-not $InstancesDestination) {
    Write-Host 'Instance topology was not rendered. Pass -InstancesDestination to create it.'
}
