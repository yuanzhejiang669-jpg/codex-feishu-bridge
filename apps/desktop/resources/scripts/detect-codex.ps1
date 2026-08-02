$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

. (Join-Path $PSScriptRoot 'resolve-codex-runtime.ps1')

$packages = @(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Sort-Object Version -Descending)
$package = $packages | Select-Object -First 1

$packageFound = $null -ne $package
$packageFullName = ''
$packageVersion = ''
$installLocation = ''
$sourceRuntimePath = ''
$cachedRuntimePath = ''
$cachedPackageFullName = ''
$cacheMatch = 'none'

if ($packageFound) {
  $packageFullName = [string]$package.PackageFullName
  $packageVersion = [string]$package.Version
  $installLocation = [string]$package.InstallLocation
  $candidate = Join-Path $installLocation 'app\resources\codex.exe'
  if (Test-Path -LiteralPath $candidate) {
    $sourceRuntimePath = (Resolve-Path -LiteralPath $candidate).Path
  }

}

$cacheRoots = @(
  (Join-Path $env:LOCALAPPDATA 'CodexFeishuBridge\official-codex-cli'),
  (Join-Path $env:LOCALAPPDATA 'CodexFeishuBridgeDesktop\runtime-localappdata\CodexFeishuBridge\official-codex-cli')
)
$cachedRuntime = Resolve-CodexCachedRuntime -PackageFullName $packageFullName -CacheRoots $cacheRoots
$cachedRuntimePath = $cachedRuntime.cachedRuntimePath
$cachedPackageFullName = $cachedRuntime.cachedPackageFullName
$cacheMatch = $cachedRuntime.cacheMatch

$payload = [ordered]@{
  packageFound = $packageFound
  packageFullName = $packageFullName
  packageVersion = $packageVersion
  installLocation = $installLocation
  sourceRuntimePath = $sourceRuntimePath
  cachedRuntimePath = $cachedRuntimePath
  cachedPackageFullName = $cachedPackageFullName
  cacheMatch = $cacheMatch
  runtimeFound = [bool]$cachedRuntimePath
}

$payload | ConvertTo-Json -Compress
