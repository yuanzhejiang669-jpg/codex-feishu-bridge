---
name: powershell-safe-invocation
description: Use when writing or running PowerShell on Windows, especially native programs, quoted paths, escaping, pwsh, Start-Process, file operations, remote Windows SSH, scheduled tasks, Bridge restarts, or shell troubleshooting.
---

# PowerShell Safe Invocation

## Shell

Prefer PowerShell 7 through `pwsh.exe` only after verifying it exists. If `pwsh.exe` is not available, use Windows PowerShell 5.1 through `powershell.exe` and keep examples 5.1-compatible.

On the current Windows device, Codex tool calls commonly run under Windows PowerShell 5.1, and `pwsh.exe` may not be in `PATH`. Do not assume PowerShell 7 features, parser behavior, or .NET API conveniences are available.

When the active shell is uncertain, verify:

```powershell
$PSVersionTable.PSVersion
Get-Command pwsh.exe -ErrorAction SilentlyContinue
Get-Command powershell.exe -ErrorAction SilentlyContinue
```

Do not assume installing PowerShell 7 makes `powershell.exe` use PowerShell 7:

- `pwsh.exe` = PowerShell 7
- `powershell.exe` = Windows PowerShell 5.1
- `$PSNativeCommandArgumentPassing` is PowerShell 7-specific; in Windows PowerShell 5.1 it may be unset or unavailable.

## Native Programs

Never construct one large command string when arguments can be passed separately.

Use:

```powershell
$exe = 'C:\Path With Spaces\tool.exe'
$args = @(
    '--input'
    'C:\Data Folder\input.json'
    '--flag'
)

& $exe @args

$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    throw "$exe failed with exit code $exitCode"
}
```

Rules:

- Treat every native argument as one array item.
- Invoke executable paths stored in variables with `&`.
- Capture `$LASTEXITCODE` immediately.
- Do not use `Invoke-Expression`.
- Do not add a `cmd.exe /c` layer merely to launch an executable.
- Do not use Bash-style `\"` escaping in PowerShell.

## Cmdlets

Use hashtable splatting for PowerShell cmdlets:

```powershell
$params = @{
    LiteralPath = 'C:\Data[1]\input.txt'
    Destination = 'C:\Output'
    Force       = $true
    ErrorAction = 'Stop'
}

Copy-Item @params
```

Use `-LiteralPath` for real paths unless wildcard expansion is intentional.

Do not use `$LASTEXITCODE` to test a PowerShell cmdlet. Use terminating errors:

```powershell
$ErrorActionPreference = 'Stop'
```

## Complex Commands

Avoid deeply quoted commands such as:

```text
cmd.exe /c pwsh.exe -Command "..."
```

For multiline code, nested quotes, JSON, XML, regular expressions, pipelines, redirection, or non-ASCII paths:

1. Write a temporary `.ps1` file.
2. Execute it with:

```text
pwsh.exe -NoLogo -NoProfile -NonInteractive -File script.ps1
```

If `pwsh.exe` is not available, use Windows PowerShell 5.1:

```text
powershell.exe -NoProfile -File script.ps1
```

For portable launchers, choose the runner explicitly:

```powershell
$scriptPath = 'C:\Temp\work.ps1'
$pwsh = Get-Command pwsh.exe -ErrorAction SilentlyContinue
if ($pwsh) {
    & $pwsh.Source -NoLogo -NoProfile -NonInteractive -File $scriptPath
} else {
    & powershell.exe -NoProfile -File $scriptPath
}
```

Prefer `-File` over `-Command` for anything beyond a short, simple expression.

Do not add `-ExecutionPolicy Bypass` unless execution policy is actually blocking a trusted script.

## Strings And Multiline Code

- Use single quotes for literal strings and paths.
- Use double quotes only when PowerShell expansion is needed.
- Avoid backtick line continuation; use arrays, hashtables, splatting, parentheses, or script blocks.
- For JSON, create objects and use `ConvertTo-Json`; do not hand-escape JSON.
- Use single-quoted here-strings for literal multiline text.
- Specify text encoding explicitly when another tool consumes the file.
- In Windows PowerShell 5.1, avoid dense one-liners that combine `foreach`/script blocks with a trailing pipeline. Prefer collecting objects into `$rows` and then piping `$rows` to `Format-Table`, `ConvertTo-Json`, or `Export-Csv`.

## Windows PowerShell 5.1 Pitfalls

Assume variable names are case-insensitive. Do not use `$pid` as a local variable because `$PID` is a built-in read-only variable. Use names such as `$processIdText`, `$bridgePid`, or `$nodePid`.

Keep casts separate from common parameters. This is wrong:

```powershell
Get-Process -Id ([int]$processIdText -ErrorAction SilentlyContinue)
```

Use:

```powershell
Get-Process -Id ([int]$processIdText) -ErrorAction SilentlyContinue
```

When a pipeline follows a script block and parsing gets fragile, split it into statements:

```powershell
$rows = foreach ($item in $items) {
    [pscustomobject]@{ Name = $item.Name; Value = $item.Value }
}
$rows | ConvertTo-Json -Depth 4
```

## Text Encoding

For Chinese Markdown or Obsidian vault files such as `D:\ObsidianVault`, read and write UTF-8 explicitly in Windows PowerShell 5.1. Do not trust the console display when it shows mojibake.

Read UTF-8 explicitly:

```powershell
$text = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($path))
```

Write UTF-8 explicitly when another tool expects UTF-8:

```powershell
[System.IO.File]::WriteAllText($path, $text, [System.Text.Encoding]::UTF8)
```

`Set-Content -Encoding UTF8` in Windows PowerShell 5.1 writes UTF-8 with BOM. That is acceptable for many Markdown workflows, but be aware of the BOM when a downstream tool is strict.

## Start-Process

For normal foreground execution, use:

```powershell
& $exe @args
```

Use `Start-Process` only for elevation, new/hidden windows, detached launch, or shell behavior.

`Start-Process -ArgumentList` joins values into a command-line string and is not a reliable structured-argument API.

When a separate process is required and arguments are complex, prefer `ProcessStartInfo.ArgumentList` only after confirming it is available in the active runtime:

```powershell
$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $exe
$psi.UseShellExecute = $false

if (-not $psi.ArgumentList) {
    throw 'ProcessStartInfo.ArgumentList is unavailable in this PowerShell/.NET runtime; use a temporary .ps1 file or a tightly controlled Arguments string.'
}

foreach ($arg in $args) {
    $psi.ArgumentList.Add($arg)
}

$process = [System.Diagnostics.Process]::Start($psi)
$process.WaitForExit()

if ($process.ExitCode -ne 0) {
    throw "Process failed with exit code $($process.ExitCode)"
}
```

On Windows PowerShell 5.1, if `ArgumentList` is unavailable and the only arguments are a trusted script path you generated, a controlled `Arguments` string is acceptable:

```powershell
$scriptPath = 'C:\Temp\work.ps1'
$escapedScriptPath = $scriptPath -replace '"', '\"'

$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = 'powershell.exe'
$psi.UseShellExecute = $true
$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$psi.Arguments = "-NoProfile -File `"$escapedScriptPath`""
[System.Diagnostics.Process]::Start($psi) | Out-Null
```

Do not use this fallback for arbitrary user-provided arguments. For arbitrary arguments, write a temporary `.ps1` wrapper and pass data through files or environment variables.

Do not rely on a process launched through a transient SSH session to stay alive after the SSH session exits. For persistent Windows services such as Codex Feishu Bridge instances, prefer a scheduled task or existing watchdog entry, then verify the actual child process after launch.

## Remote Windows SSH

For SSH into another Windows host, keep remote commands short and read-only when possible. For complex logic, prefer one of these patterns:

1. Copy a temporary `.ps1` file with `scp`, run it with `powershell.exe -NoProfile -File`, then delete it.
2. Use `-EncodedCommand` only for small, self-contained snippets.
3. Split large diagnostics into several smaller commands.

Long encoded commands can fail depending on quoting, length, policy, or remote session context. Do not print secrets in remote command output. If a temporary script or payload contains credentials, delete it after use.

## Codex Feishu Bridge Operations

Before restarting Bridge or bot processes, inspect the local conventions first: startup scripts, watchdog scripts, PID files, logs, state files, and scheduled tasks may differ between devices.

Before restart, parse `active-runs.json` by object shape instead of treating any JSON object as active work. Count non-null run entries, for example by checking `$active.runs.PSObject.Properties`.

After restart, do not assume a successful command means the Bridge is healthy. Verify:

- The expected `bridge.pid` exists and contains a process ID.
- `Get-Process -Id <pid>` finds a live process.
- The process `StartTime` changed when a restart was intended.
- The log or user-facing command, such as `/provider list`, confirms the Bridge sees the expected environment.

## File Operations

Before recursive delete, move, or overwrite:

- Resolve the absolute root and target paths.
- Verify the target is inside the intended root.
- Reject empty, root-level, or unexpected paths.
- Keep filesystem mutations in PowerShell instead of passing paths to another shell.

## Decision Order

Choose the simplest safe option:

1. PowerShell cmdlet.
2. `& $exe @args`.
3. Temporary `.ps1` file with `pwsh.exe -File` if `pwsh.exe` exists, otherwise `powershell.exe -File`.
4. `ProcessStartInfo.ArgumentList` only when the runtime exposes it.
5. `Start-Process` when its special behavior is required.
6. `cmd.exe /c` only when cmd semantics are required.
7. `Invoke-Expression` only as a tightly controlled last resort.

For uncommon cases and complete examples, read `reference.md`.
