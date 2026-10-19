param([string]$ShortcutPath = "")

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (-not $ShortcutPath) {
  $profileRoot = [Environment]::GetFolderPath('UserProfile')
  $ShortcutPath = Join-Path $profileRoot 'AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Codex Feishu Bridge.lnk'
}
$shortcut = (Resolve-Path -LiteralPath $ShortcutPath).Path
$links = New-Object -ComObject WScript.Shell
$link = $links.CreateShortcut($shortcut)
$target = $link.TargetPath
if ([IO.Path]::GetFileName($target) -ne 'Codex Feishu Bridge.exe' -or -not (Test-Path -LiteralPath $target)) {
  throw 'Expected the installed Codex Feishu Bridge shortcut.'
}
if ($link.Arguments) { throw 'The installed desktop shortcut must not add development or background flags.' }
$session = (Get-Process -Id $PID).SessionId
$desktop = @(Get-Process -Name explorer -ErrorAction SilentlyContinue | Where-Object SessionId -eq $session)
if ($session -eq 0 -or -not $desktop.Count) {
  throw 'Launch this helper in the logged-in interactive desktop, not directly in an SSH session.'
}
# The existing desktop shell launches the shortcut. Invoking it directly from
# PowerShell can leave Electron attached to the maintenance terminal.
$shell = New-Object -ComObject Shell.Application
$windowHandle = 0
$desktopWindow = $shell.Windows().FindWindowSW(0, 0, 8, [ref]$windowHandle, 1)
if (-not $desktopWindow) { throw 'The existing Explorer desktop automation object is unavailable.' }
# Shell.Application itself may execute in the caller. Obtain the dispatch
# object belonging to the real Explorer desktop so it creates the process.
$desktopApplication = $desktopWindow.Document.Application
$desktopApplication.ShellExecute($shortcut, '', $link.WorkingDirectory, 'open', 1)
$deadline = (Get-Date).AddSeconds(20)
do {
  Start-Sleep -Milliseconds 300
  $clients = @(Get-CimInstance Win32_Process -Filter "Name='Codex Feishu Bridge.exe'" | Where-Object {
    $_.ExecutablePath -eq $target -and $_.SessionId -eq $session -and $_.CommandLine -notmatch '--type='
  })
  if ($clients.Count -eq 1) {
    [pscustomobject]@{ pid=$clients[0].ProcessId; sessionId=$session; parentPid=$clients[0].ParentProcessId; executable=$target } | ConvertTo-Json
    exit 0
  }
} while ((Get-Date) -lt $deadline)
throw 'The installed desktop client did not appear in the interactive session.'
