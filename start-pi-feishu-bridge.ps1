param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("pi-global-01", "pi-global-02", "pi-global-03")]
  [string]$Name,
  [string]$UserHome = "",
  [switch]$Foreground
)

$ErrorActionPreference = "Stop"

$resolvedUserHome = $UserHome.Trim()
if (-not $resolvedUserHome) {
  $resolvedUserHome = [Environment]::GetFolderPath("UserProfile")
}
if (-not $resolvedUserHome -or -not (Test-Path -LiteralPath $resolvedUserHome -PathType Container)) {
  throw "Real user home is unavailable: $resolvedUserHome"
}
$resolvedUserHome = (Resolve-Path -LiteralPath $resolvedUserHome).Path
$userProfileRoot = [System.IO.Path]::GetPathRoot($resolvedUserHome)
$env:USERPROFILE = $resolvedUserHome
$env:HOME = $resolvedUserHome
$env:HOMEDRIVE = $userProfileRoot.TrimEnd("\")
$env:HOMEPATH = $resolvedUserHome.Substring($userProfileRoot.Length - 1)
$env:LOCALAPPDATA = Join-Path $resolvedUserHome "AppData\Local"
$env:APPDATA = Join-Path $resolvedUserHome "AppData\Roaming"
$agentHome = Join-Path (Join-Path $resolvedUserHome "Documents\Codex\pi-homes") $Name
$manifestPath = Join-Path $agentHome "bridge.json"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "Pi Bridge manifest not found: $manifestPath"
}
$manifestText = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($manifestPath))
$manifest = $manifestText | ConvertFrom-Json
if ([string]$manifest.engine -ne "pi" -or [string]$manifest.name -ne $Name) {
  throw "Pi Bridge manifest identity mismatch: $manifestPath"
}

foreach ($target in @($manifest.workspace, $manifest.agentHome, $manifest.sessionDir, $manifest.modelsPath, $manifest.settingsPath, $manifest.capabilitiesPath)) {
  if (-not (Test-Path -LiteralPath ([string]$target))) {
    throw "Pi Bridge runtime path is unavailable: $target"
  }
}
foreach ($target in (@($manifest.extensionPaths) + @($manifest.skillPaths))) {
  if (-not (Test-Path -LiteralPath ([string]$target))) {
    throw "Pi Bridge capability path is unavailable: $target"
  }
}

foreach ($envKeyValue in @($manifest.providerEnvKeys)) {
  $envKey = ([string]$envKeyValue).Trim()
  if (-not $envKey) { continue }
  $currentValue = [Environment]::GetEnvironmentVariable($envKey, "Process")
  if ([string]::IsNullOrWhiteSpace($currentValue)) {
    $currentValue = [Environment]::GetEnvironmentVariable($envKey, "User")
  }
  if ([string]::IsNullOrWhiteSpace($currentValue)) {
    throw "Pi Provider environment variable is unavailable: $envKey"
  }
  [Environment]::SetEnvironmentVariable($envKey, $currentValue, "Process")
}

$env:CODEX_FEISHU_AGENT_ENGINE = "pi"
$env:PI_CODING_AGENT_DIR = [string]$manifest.agentHome
$env:CODEX_FEISHU_PI_SESSION_DIR = [string]$manifest.sessionDir
$env:CODEX_FEISHU_PI_PROVIDER = [string]$manifest.defaultProvider
$env:CODEX_FEISHU_PI_MODEL = [string]$manifest.defaultModel
$env:CODEX_FEISHU_PI_THINKING = [string]$manifest.thinking
$env:CODEX_FEISHU_PI_EXTENSIONS = (@($manifest.extensionPaths) -join [System.IO.Path]::PathSeparator)
$env:CODEX_FEISHU_PI_SKILLS = (@($manifest.skillPaths) -join [System.IO.Path]::PathSeparator)
$env:CODEX_FEISHU_PI_CAPABILITIES_CONFIG = [string]$manifest.capabilitiesPath

$bridgeScript = Join-Path $PSScriptRoot "start-codex-feishu-bridge.ps1"
$launch = @{
  Name = $Name
  LarkProfile = [string]$manifest.larkProfile
  Workspace = [string]$manifest.workspace
  Reasoning = [string]$manifest.thinking
}
if ($Foreground) { $launch.Foreground = $true }
& $bridgeScript @launch
exit $LASTEXITCODE
