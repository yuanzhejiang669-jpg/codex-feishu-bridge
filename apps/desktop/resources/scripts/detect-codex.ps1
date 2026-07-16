$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$packages = @(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Sort-Object Version -Descending)
$package = $packages | Select-Object -First 1

$packageFound = $null -ne $package
$packageFullName = ''
$packageVersion = ''
$installLocation = ''
$sourceRuntimePath = ''
$cachedRuntimePath = ''

if ($packageFound) {
  $packageFullName = [string]$package.PackageFullName
  $packageVersion = [string]$package.Version
  $installLocation = [string]$package.InstallLocation
  $candidate = Join-Path $installLocation 'app\resources\codex.exe'
  if (Test-Path -LiteralPath $candidate) {
    $sourceRuntimePath = (Resolve-Path -LiteralPath $candidate).Path
  }

  $cacheCandidate = Join-Path (Join-Path (Join-Path $env:LOCALAPPDATA 'CodexFeishuBridge\official-codex-cli') $packageFullName) 'codex.exe'
  if (Test-Path -LiteralPath $cacheCandidate) {
    $cachedRuntimePath = (Resolve-Path -LiteralPath $cacheCandidate).Path
  }
}

$payload = [ordered]@{
  packageFound = $packageFound
  packageFullName = $packageFullName
  packageVersion = $packageVersion
  installLocation = $installLocation
  sourceRuntimePath = $sourceRuntimePath
  cachedRuntimePath = $cachedRuntimePath
  runtimeFound = [bool]($cachedRuntimePath -or $sourceRuntimePath)
}

$payload | ConvertTo-Json -Compress

