# Personal Environment Migration

The `bootstrap/` bundle recreates reusable Codex preferences, provider and MCP configuration, vendored skills, and the 15-profile Bridge topology without publishing credentials or machine history.

## Included

- `bootstrap/AGENTS.md`: reusable global behavior and safety defaults.
- `bootstrap/config.example.toml`: model/provider defaults and repo-hosted MCP definitions with portable placeholders.
- `bootstrap/bridge.instances.personal.example.json`: the profile names, groups, workspace layout, and watchdog task names for 15 Bots.
- `bootstrap/install-personal-environment.ps1`: a PowerShell 5.1-compatible, idempotent installer.
- `skills/`: four reusable public-safe skills.

The bundle does not include API key values, Feishu/Lark app credentials, browser bridge tokens, authentication profiles, project trust/history blocks, session state, caches, runtime data, logs, private Tencent case notes, or `.system` skills.

## Install

Review the templates first. Test the operation without writing:

```powershell
powershell.exe -NoProfile -File .\bootstrap\install-personal-environment.ps1 `
  -CodexHome "$env:USERPROFILE\.codex-new" `
  -WhatIf
```

Install into the selected Codex Home:

```powershell
powershell.exe -NoProfile -File .\bootstrap\install-personal-environment.ps1 `
  -CodexHome "$env:USERPROFILE\.codex-new"
```

Existing files are skipped. Pass `-Force` only after reviewing differences when intentional replacement is required. The installer does not create backups.

Override `-RepoRoot`, `-UserHome`, `-WorkspaceRoot`, `-RuntimeRoot`, `-CodexHomesRoot`, `-NodeExe`, or `-PythonExe` when the derived defaults do not fit the destination machine.

## Render The Bot Topology

Use `-InstancesDestination` to render placeholders into a chosen file. This writes no app credentials:

```powershell
powershell.exe -NoProfile -File .\bootstrap\install-personal-environment.ps1 `
  -CodexHome "$env:USERPROFILE\.codex-new" `
  -InstancesDestination "$PWD\bridge.instances.personal.local.json"
```

The generated topology preserves `default`, `codex-assistant-1` through `codex-assistant-9`, four `writing` profiles, and `180bot`. Create or authorize matching `lark-cli` profiles separately.

## Manual Setup

1. Set provider environment variables named by each `env_key`; never put key values in the repository.
2. Replace `SET_IN_LOCAL_CONFIG` in the installed browser MCP configuration with a locally generated bridge token, or remove that MCP until configured.
3. Create local Tavily and Firecrawl key-pool files under
   `~/Documents/Codex/mcp-data/key-pools`; router state is created under
   `~/Documents/Codex/mcp-data/state` when first used.
4. Install Python/Node dependencies for the selected repo-hosted MCP servers.
5. Authenticate Codex and `lark-cli`, then create Feishu apps/profiles and grant required scopes outside this repository.
6. Review the Windows sandbox setting before using the configuration on another machine.

After pulling an updated repository on an existing device, MCP definitions that
point directly at `tools/firecrawl-router/server.py` use the new router after the
MCP process is restarted (normally by opening a new Codex session). If a local
configuration points at a copied runtime file instead, copy the repository file
to that configured path and verify the two files have the same hash. Key-pool and
router-state files remain device-local and must never be committed.

## Validation

```powershell
# Parse JSON
Get-Content -Raw .\bootstrap\bridge.instances.personal.example.json | ConvertFrom-Json | Out-Null

# Parse the installer with Windows PowerShell 5.1
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path .\bootstrap\install-personal-environment.ps1),
  [ref]$null,
  [ref]$errors
)
$errors

# Repository checks
npm run check
```

Use a TOML parser to validate both the template and rendered `config.toml`. Finally run the installer twice against a disposable directory: the second run without `-Force` must preserve existing files, while a reviewed `-Force` run must replace them.
