param(
  [Parameter(Mandatory = $true)]
  [string]$Name,
  [string]$Profile = "",
  [string]$DisplayName = "",
  [string]$Description = "Remote control local Codex sessions from Feishu.",
  [string[]]$AvatarUrl = @(),
  [string]$Workspace = "",
  [string]$CodexHome = "",
  [string]$DesktopCodexHome = "",
  [string]$Source = "codex",
  [ValidateSet("feishu", "lark")]
  [string]$Brand = "feishu",
  [int]$TimeoutSeconds = 600,
  [switch]$NoOpenQr,
  [switch]$NoStart,
  [switch]$InstallStartup,
  [switch]$ForceProfile,
  [switch]$NoInstallDependencies,
  [string]$Sandbox = "",
  [ValidateSet("", "app-server", "auto", "exec")]
  [string]$RunMode = "",
  [string]$Reasoning = "",
  [string]$EventKeys = "",
  [int]$CodexTimeoutSeconds = 0,
  [int]$CodexIdleTimeoutSeconds = 3600,
  [int]$MaxConcurrent = 0,
  [switch]$DisableMcp,
  [switch]$EnableMcp
)

$ErrorActionPreference = "Stop"

$nodeScript = Join-Path $PSScriptRoot "register-codex-feishu-bot.mjs"
$packageJson = Join-Path $PSScriptRoot "package.json"
$sdkDir = Join-Path $PSScriptRoot "node_modules\@larksuiteoapi\node-sdk"
$qrDir = Join-Path $PSScriptRoot "node_modules\qrcode"

if (-not (Test-Path -LiteralPath $nodeScript)) {
  throw "Registration script not found: $nodeScript"
}

if (-not $NoInstallDependencies) {
  if (-not (Test-Path -LiteralPath $sdkDir) -or -not (Test-Path -LiteralPath $qrDir)) {
    if (-not (Test-Path -LiteralPath $packageJson)) {
      throw "package.json not found: $packageJson"
    }
    Push-Location $PSScriptRoot
    try {
      npm install --omit=dev
    } finally {
      Pop-Location
    }
  }
}

$argsList = @(
  $nodeScript,
  "--name", $Name,
  "--source", $Source,
  "--brand", $Brand,
  "--timeout-seconds", $TimeoutSeconds
)

if ($Profile.Trim()) { $argsList += @("--profile", $Profile.Trim()) }
if ($DisplayName.Trim()) { $argsList += @("--display-name", $DisplayName.Trim()) }
if ($Description.Trim()) { $argsList += @("--description", $Description.Trim()) }
foreach ($url in $AvatarUrl) {
  if ($url.Trim()) { $argsList += @("--avatar-url", $url.Trim()) }
}
if ($Workspace.Trim()) { $argsList += @("--workspace", $Workspace.Trim()) }
if ($CodexHome.Trim()) { $argsList += @("--codex-home", $CodexHome.Trim()) }
if ($DesktopCodexHome.Trim()) { $argsList += @("--desktop-codex-home", $DesktopCodexHome.Trim()) }
if ($NoOpenQr) { $argsList += "--no-open-qr" }
if ($NoStart) { $argsList += "--no-start" }
if ($InstallStartup) { $argsList += "--install-startup" }
if ($ForceProfile) { $argsList += "--force-profile" }
if ($Sandbox.Trim()) { $argsList += @("--sandbox", $Sandbox.Trim()) }
if ($RunMode.Trim()) { $argsList += @("--run-mode", $RunMode.Trim()) }
if ($Reasoning.Trim()) { $argsList += @("--reasoning", $Reasoning.Trim()) }
if ($EventKeys.Trim()) { $argsList += @("--event-keys", $EventKeys.Trim()) }
if ($PSBoundParameters.ContainsKey("CodexTimeoutSeconds")) { $argsList += @("--codex-timeout-seconds", $CodexTimeoutSeconds) }
if ($PSBoundParameters.ContainsKey("CodexIdleTimeoutSeconds")) { $argsList += @("--codex-idle-timeout-seconds", $CodexIdleTimeoutSeconds) }
if ($MaxConcurrent -gt 0) { $argsList += @("--max-concurrent", $MaxConcurrent) }
if ($DisableMcp) { $argsList += "--disable-mcp" }
if ($EnableMcp) { $argsList += "--enable-mcp" }

node @argsList
exit $LASTEXITCODE
