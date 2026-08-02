function Get-CodexCachePackageVersion {
  param([string]$PackageFullName)

  if ($PackageFullName -notmatch '^OpenAI\.Codex_([^_]+)_') {
    return [version]'0.0.0.0'
  }

  try {
    return [version]$Matches[1]
  } catch {
    return [version]'0.0.0.0'
  }
}

function Resolve-CodexCachedRuntime {
  param(
    [string]$PackageFullName,
    [string[]]$CacheRoots
  )

  $candidates = foreach ($cacheRoot in @($CacheRoots)) {
    if (-not $cacheRoot -or -not (Test-Path -LiteralPath $cacheRoot)) {
      continue
    }

    foreach ($directory in Get-ChildItem -LiteralPath $cacheRoot -Directory -ErrorAction SilentlyContinue) {
      if ($directory.Name -notmatch '^OpenAI\.Codex_[^_]+_[^\\/]+$') {
        continue
      }
      $candidate = Join-Path $directory.FullName 'codex.exe'
      $item = Get-Item -LiteralPath $candidate -ErrorAction SilentlyContinue
      if ($null -eq $item -or $item.Length -le 0) {
        continue
      }

      [pscustomobject]@{
        path = $item.FullName
        packageFullName = $directory.Name
        packageVersion = Get-CodexCachePackageVersion $directory.Name
        exact = $PackageFullName -and [string]::Equals(
          $directory.Name,
          $PackageFullName,
          [System.StringComparison]::OrdinalIgnoreCase
        )
        lastWriteTimeUtc = $item.LastWriteTimeUtc
      }
    }
  }

  $sortProperties = @(
    @{ Expression = { $_.exact }; Descending = $true }
    @{ Expression = { $_.packageVersion }; Descending = $true }
    @{ Expression = { $_.lastWriteTimeUtc }; Descending = $true }
  )
  $selected = $candidates | Sort-Object -Property $sortProperties | Select-Object -First 1

  if ($null -eq $selected) {
    return [pscustomobject]@{
      cachedRuntimePath = ''
      cachedPackageFullName = ''
      cacheMatch = 'none'
    }
  }

  return [pscustomobject]@{
    cachedRuntimePath = $selected.path
    cachedPackageFullName = $selected.packageFullName
    cacheMatch = if ($selected.exact) { 'exact' } else { 'fallback' }
  }
}
