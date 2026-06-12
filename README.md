# Codex Feishu Bridge

Languages: [English](README.md) | [中文](README.zh-CN.md)

Codex Feishu Bridge connects a Feishu bot to a local Codex runtime. It receives Feishu messages, downloads supported attachments into a dedicated workspace, starts or continues a Codex task, and posts progress plus final responses back to Feishu.

The `main` branch is the Windows deployment branch. It includes PowerShell startup scripts, Windows Scheduled Task watchdog support, QR-code based Feishu bot registration, multi-instance runtime isolation, queue controls, and operational diagnostics.

## Contents

- [Architecture](#architecture)
- [Capabilities](#capabilities)
- [Repository Layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Feishu App Requirements](#feishu-app-requirements)
- [Installation](#installation)
- [Recommended Setup: QR Registration](#recommended-setup-qr-registration)
- [Manual Setup With an Existing Feishu App](#manual-setup-with-an-existing-feishu-app)
- [Watchdog and Startup](#watchdog-and-startup)
- [Multi-Instance Deployment](#multi-instance-deployment)
- [Feishu Commands](#feishu-commands)
- [Configuration Reference](#configuration-reference)
- [Runtime Files](#runtime-files)
- [Logs and Troubleshooting](#logs-and-troubleshooting)
- [Updating an Existing Deployment](#updating-an-existing-deployment)
- [Security Notes](#security-notes)
- [Pre-Publish Checklist](#pre-publish-checklist)

## Architecture

The bridge is designed for a local trusted machine:

1. `lark-cli` subscribes to Feishu bot events.
2. `codex-feishu-bridge.mjs` receives message events from `lark-cli`.
3. The bridge downloads image/file attachments into a workspace.
4. The bridge sends the user request to Codex, normally through `codex app-server --listen stdio://`.
5. The bridge updates Feishu interactive cards while Codex is running.
6. The bridge posts the final answer to Feishu and records session state locally.
7. A Windows Scheduled Task watchdog checks the bridge and Feishu event consumer and restarts unhealthy instances.

Each bot instance should use its own Feishu app/profile, workspace, state directory, log directory, and watchdog task.

## Capabilities

- Feishu message event consumption through `im.message.receive_v1`.
- Optional multi-event subscription through `CODEX_FEISHU_EVENT_KEYS`.
- Optional best-effort handling for recalled messages before queued messages execute.
- Codex `app-server` mode by default, with `exec` fallback available.
- Feishu interactive cards for running status, tool calls, elapsed time, context usage, and final answers.
- Image and file attachment download into the active workspace.
- Local bridge sessions with commands to create, switch, list, reset, compact, and delete sessions.
- Queue visibility and cancellation commands for long-running or accidentally queued requests.
- Multi-instance operation on the same Windows host.
- Scheduled watchdog health checks and automatic restart.

## Repository Layout

| Path | Purpose |
|---|---|
| `codex-feishu-bridge.mjs` | Main bridge process. Handles Feishu events, attachments, Codex execution, cards, sessions, queueing, and commands. |
| `register-codex-feishu-bot.mjs` | QR-code based Feishu bot registration and `lark-cli` profile setup. |
| `register-codex-feishu-bot.ps1` | PowerShell wrapper for bot registration; installs Node dependencies when needed. |
| `start-codex-feishu-bridge.ps1` | Starts one bridge instance with workspace, profile, runtime, timeout, card, and MCP settings. |
| `stop-codex-feishu-bridge.ps1` | Stops one bridge instance. It requests graceful shutdown first and force-stops only when needed. |
| `watch-codex-feishu-bridge.ps1` | Watchdog health check and repair script. |
| `install-codex-feishu-watchdog.ps1` | Installs or removes the Windows Scheduled Task watchdog. |
| `start-codex-feishu-bridge-hidden.vbs` | Hidden-window bridge launcher used by background workflows. |
| `watch-codex-feishu-bridge-hidden.vbs` | Hidden-window watchdog launcher used by Scheduled Tasks. |
| `.env.example` | Optional environment variable reference. Do not commit a real `.env`. |
| `docs/` | Supplementary deployment and troubleshooting documents. |
| `workspace/` | Placeholder workspace directory. Real workspace data is not intended for source control. |

## Prerequisites

Install and verify the following on the Windows host:

1. Windows 10 or Windows 11.
2. PowerShell 5 or newer.
3. Node.js 20 or newer and npm.
4. Git.
5. A working Codex CLI or Microsoft Store Codex installation.
6. `lark-cli`.
7. Python 3 or `sqlite3` CLI. One of them is required for reading the local Codex SQLite state used by `/list`.
8. A Feishu account that can create or authorize a custom Feishu app.

Verify the local toolchain:

```powershell
node -v
npm -v
git --version
powershell -NoProfile -Command "$PSVersionTable.PSVersion"
codex --version
python --version
```

Install `lark-cli` if it is not already available:

```powershell
npm install -g @larksuite/cli
lark-cli --version
```

If `codex` is not on `PATH`, either add it to `PATH` or set `CODEX_CLI_BIN` before starting the bridge:

```powershell
$env:CODEX_CLI_BIN = "C:\Path\To\codex.exe"
```

The Windows scripts automatically try to locate the official Microsoft Store package `OpenAI.Codex`. Because WindowsApps package directories cannot always be spawned directly by Node, the script copies the internal `app\resources\codex.exe` into `%LOCALAPPDATA%\CodexFeishuBridge\official-codex-cli\...` and starts that local copy. Explicit `CODEX_CLI_BIN` still has the highest priority.

## Feishu App Requirements

The Feishu app used by the bot must have:

- Bot capability enabled.
- Event subscription for `im.message.receive_v1`.
- Message receive/send permissions required by `lark-cli` and the Feishu Open Platform SDK.
- Message resource download permissions when attachments are used.
- Installation or release to the target Feishu tenant.

For recalled-message handling:

- The bridge contains optional support for `im.message.recalled_v1`.
- The Feishu app must subscribe to `im.message.recalled_v1`.
- The local `lark-cli` version must recognize that EventKey.
- If the event is not available, the bridge still performs a best-effort message status check before executing queued messages.

Keep the default event list unless both Feishu and local `lark-cli` support the additional event:

```powershell
-EventKeys "im.message.receive_v1"
```

Only enable recalled events when supported:

```powershell
-EventKeys "im.message.receive_v1,im.message.recalled_v1"
```

## Installation

Clone the repository to a stable tools directory:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\Documents\Codex\tools" | Out-Null
git clone <REPO_URL> "$env:USERPROFILE\Documents\Codex\tools\codex-feishu-bridge"
Set-Location "$env:USERPROFILE\Documents\Codex\tools\codex-feishu-bridge"
npm install
npm run check
```

Use `main` for Windows deployments:

```powershell
git switch main
git pull --ff-only
```

## Recommended Setup: QR Registration

The QR registration script creates or authorizes a Feishu app through the Feishu Open Platform QR-code flow, writes a `lark-cli` profile, starts the bridge, and can install the watchdog.

Choose an instance name and display name:

```powershell
Set-Location "$env:USERPROFILE\Documents\Codex\tools\codex-feishu-bridge"

$BotName = "codex-assistant-1"
$BotDisplayName = "Codex Assistant 1"
$Workspace = "$env:USERPROFILE\Documents\Codex\workspaces\feishu-bridge-$BotName"

.\register-codex-feishu-bot.ps1 `
  -Name $BotName `
  -DisplayName $BotDisplayName `
  -Workspace $Workspace `
  -RunMode app-server `
  -Reasoning xhigh `
  -CodexTimeoutSeconds 0 `
  -CodexIdleTimeoutSeconds 3600 `
  -InstallStartup
```

After the QR flow completes, verify from Feishu:

```text
/status
```

Then send a normal non-command message:

```text
请用一句话说明你当前连接的是哪台本机 Codex。
```

Messages beginning with `/` are interpreted as bridge commands. Ordinary Codex tasks should not start with `/`.

## Manual Setup With an Existing Feishu App

If the Feishu app already exists, add its credentials to a `lark-cli` profile:

```powershell
$profile = "codex-assistant-1"
$appId = "cli_xxxxxxxxxxxxx"
$appSecret = Read-Host "Feishu App Secret"

$appSecret | lark-cli profile add `
  --name $profile `
  --app-id $appId `
  --brand feishu `
  --app-secret-stdin

lark-cli profile list
```

Start the bridge:

```powershell
.\start-codex-feishu-bridge.ps1 `
  -Name codex-assistant-1 `
  -LarkProfile codex-assistant-1 `
  -Workspace "$env:USERPROFILE\Documents\Codex\workspaces\feishu-bridge-codex-assistant-1" `
  -RunMode app-server `
  -Reasoning xhigh `
  -CodexTimeoutSeconds 0 `
  -CodexIdleTimeoutSeconds 3600
```

## Watchdog and Startup

Install a watchdog for one instance:

```powershell
.\install-codex-feishu-watchdog.ps1 `
  -Name codex-assistant-1 `
  -LarkProfile codex-assistant-1 `
  -Workspace "$env:USERPROFILE\Documents\Codex\workspaces\feishu-bridge-codex-assistant-1" `
  -CodexTimeoutSeconds 0 `
  -CodexIdleTimeoutSeconds 3600 `
  -WatchdogTimeoutSeconds 180
```

The watchdog is registered as a Windows Scheduled Task. It runs at login, unlock, and periodically. It checks:

- Whether the bridge PID exists.
- Whether the PID command line matches the expected bridge instance.
- Whether `lark-cli event status --json` reports the expected event consumer.
- Whether another watchdog copy appears stuck beyond the configured watchdog timeout.

Remove the watchdog:

```powershell
.\install-codex-feishu-watchdog.ps1 -Name codex-assistant-1 -Uninstall
```

Run one watchdog check manually:

```powershell
.\watch-codex-feishu-bridge.ps1 `
  -Name codex-assistant-1 `
  -LarkProfile codex-assistant-1 `
  -Workspace "$env:USERPROFILE\Documents\Codex\workspaces\feishu-bridge-codex-assistant-1"
```

## Multi-Instance Deployment

Use a separate instance name, Feishu app/profile, workspace, and watchdog for each bot.

Example naming:

| Instance | Feishu display name | Workspace |
|---|---|---|
| `codex-assistant-1` | `Codex Assistant 1` | `%USERPROFILE%\Documents\Codex\workspaces\feishu-bridge-codex-assistant-1` |
| `codex-assistant-2` | `Codex Assistant 2` | `%USERPROFILE%\Documents\Codex\workspaces\feishu-bridge-codex-assistant-2` |
| `codex-assistant-lab1` | `Codex Assistant Lab 1` | `%USERPROFILE%\Documents\Codex\workspaces\feishu-bridge-codex-assistant-lab1` |

Register another instance:

```powershell
$BotName = "codex-assistant-2"
$BotDisplayName = "Codex Assistant 2"
$Workspace = "$env:USERPROFILE\Documents\Codex\workspaces\feishu-bridge-$BotName"

.\register-codex-feishu-bot.ps1 `
  -Name $BotName `
  -DisplayName $BotDisplayName `
  -Workspace $Workspace `
  -RunMode app-server `
  -Reasoning xhigh `
  -CodexTimeoutSeconds 0 `
  -CodexIdleTimeoutSeconds 3600 `
  -InstallStartup
```

## Feishu Commands

| Command | Description |
|---|---|
| `/help` | Show available commands. |
| `/status` | Show bridge, Feishu, Codex, workspace, session, goal, queue, and recent failure status. |
| `/now` or `/how` | Show whether a task is currently running. |
| `/new [title]` | Create a local bridge session. |
| `/list` or `/sessions` | List local bridge sessions and visible Codex threads. |
| `/switch <index-or-id>` | Switch the current Feishu chat to another session. |
| `/context` | Show current Codex thread/context/token state. |
| `/goal [goal]` | View or start native Codex Goal mode. Supports `/goal pause`, `/goal resume`, and `/goal clear`. |
| `/provider [id]` | View or switch the Codex provider for the current Feishu chat. Use `/provider save <id>` to persist to the user Codex config. |
| `/model [model-id] [reasoning]` | View or switch model and reasoning. Use `/model list` to list configured models. |
| `/fast on/off/status` | View or switch Codex Fast mode. Use `/fast save on` to persist. |
| `/compact` | Compact the current native Codex thread. |
| `/reset` | Clear the current bridge session binding. |
| `/delete <index-or-id>` | Request deletion of a local Codex thread. Requires confirmation. |
| `/confirm delete <index>` | Confirm a pending delete request. |
| `/stop` | Stop the currently running Codex task. In `app-server` mode the bridge first uses native `turn/interrupt`. |
| `/queue` | Show queued messages that have not started yet. It does not show the currently running task. |
| `/clearqueue` | Clear queued messages for the current Feishu chat. The current task is not stopped. |
| `/clearqueue all` | Clear queued messages for all chats handled by this bot instance. |
| `/stop queue` | Stop the current task and clear the current chat queue. |
| `/stop all` | Stop the current task and clear all queues for this bot instance. |

Queue behavior:

- A message sent while Codex is already running is queued.
- While a Codex goal runner is active, plain text messages are routed as goal steering input instead of starting an unrelated task.
- `/queue` shows pending messages only, not the active task.
- Recalled queued messages are skipped when the bridge can detect recall status.
- Use `/clearqueue` for queued messages that should not run.
- Use `/stop all` when both the active task and queued messages should be cancelled.

## Configuration Reference

### Script Parameters

| Parameter | Default | Applies to | Description |
|---|---|---|---|
| `-Name` | empty/default instance | start, stop, watchdog, registration | Instance name. Named instances use isolated runtime directories. |
| `-LarkProfile` | current/default profile | start, watchdog | `lark-cli` profile name. Usually the same as `-Name`. |
| `-Workspace` | instance-specific default | start, watchdog, registration | Directory where Codex runs and attachments are stored. |
| `-Sandbox` | `danger-full-access` | start, watchdog, registration | Codex sandbox mode. |
| `-RunMode` | `app-server` | start, watchdog, registration | Codex runtime mode. |
| `-Reasoning` | `xhigh` | start, watchdog, registration | Reasoning setting passed to Codex. |
| `-EventKeys` | `im.message.receive_v1` | start, watchdog, registration | Comma-separated Feishu event keys. |
| `-CodexTimeoutSeconds` | `0` | start, watchdog, registration | Hard total timeout. `0` disables the total timeout. |
| `-CodexIdleTimeoutSeconds` | `3600` | start, watchdog, registration | Idle/no-progress timeout. |
| `-WatchdogTimeoutSeconds` | `180` | watchdog install/check | Timeout used to clean stuck watchdog processes. |
| `-DisableMcp` | off | start, watchdog, registration | Disables Codex MCP loading for spawned Codex processes. |
| `-InstallStartup` | off | registration | Installs watchdog after QR registration. |

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `CODEX_FEISHU_WORKSPACE` | current directory or script workspace | Codex workspace. |
| `CODEX_FEISHU_INSTANCE_NAME` | `default` | Runtime instance name. |
| `CODEX_FEISHU_LARK_PROFILE` | empty | `lark-cli` profile. |
| `CODEX_FEISHU_SANDBOX` | `danger-full-access` | Codex sandbox mode. |
| `CODEX_FEISHU_RUN_MODE` | `app-server` | Runtime mode. |
| `CODEX_FEISHU_EVENT_KEYS` | `im.message.receive_v1` | Comma-separated Feishu event keys. |
| `CODEX_FEISHU_MODEL` | empty | Optional model override. |
| `CODEX_FEISHU_REASONING` | `xhigh` | Reasoning setting. |
| `CODEX_FEISHU_CODEX_TIMEOUT_MS` | `0` | Hard total timeout in milliseconds. |
| `CODEX_FEISHU_CODEX_IDLE_TIMEOUT_MS` | `3600000` | Idle/no-progress timeout in milliseconds. |
| `CODEX_FEISHU_MAX_CONCURRENT` | `1` | Concurrent tasks per instance. Serial processing is recommended. |
| `CODEX_FEISHU_MAX_REPLY_CHARS` | `6000` | Maximum direct reply length before truncation/card folding. |
| `CODEX_FEISHU_CARD_MODE` | `1` | Enable Feishu interactive cards. |
| `CODEX_FEISHU_CARD_THROTTLE_MS` | `400` | Minimum interval between card updates. |
| `CODEX_FEISHU_SHOW_FINAL_STEPS` | `1` | Include final step summary when available. |
| `CODEX_FEISHU_REPLY_TO_MESSAGE` | `0` | Reply directly to the triggering message. |
| `CODEX_FEISHU_REPLY_IN_THREAD` | `0` | Reply in Feishu thread when supported. |
| `CODEX_FEISHU_DISABLE_MCP` | `0` | Disable MCP when set to a non-zero value. |
| `CODEX_FEISHU_SYNC_SESSIONS_FROM_CODEX` | `1` | Sync sessions from local Codex state. |
| `CODEX_FEISHU_SYNC_SIDEBAR` | `0` | Optional sidebar sync. |
| `CODEX_FEISHU_MAX_FILE_ATTACHMENT_BYTES` | `52428800` | Maximum downloaded file size. |
| `CODEX_FEISHU_RECALLED_MESSAGE_TTL_MS` | `86400000` | In-memory recalled-message marker lifetime. |
| `CODEX_CLI_BIN` | auto-detected | Explicit Codex CLI path. |
| `LARK_CLI_BIN` | `lark-cli` on `PATH` | Explicit `lark-cli` path. |

## Runtime Files

Default instance:

```text
%LOCALAPPDATA%\CodexFeishuBridge\state
%LOCALAPPDATA%\CodexFeishuBridge\logs
```

Named instance:

```text
%LOCALAPPDATA%\CodexFeishuBridge\instances\<Name>\state
%LOCALAPPDATA%\CodexFeishuBridge\instances\<Name>\logs
```

Workspace attachment directory:

```text
<Workspace>\.codex-feishu-attachments\<date>\<message-id>\
```

`exec` fallback prompt/output directory:

```text
<Workspace>\.codex-feishu-runtime\codex-prompts\
<Workspace>\.codex-feishu-runtime\codex-output\
```

Do not commit runtime files, logs, attachments, local sessions, or credentials.

## Logs and Troubleshooting

Set the target instance:

```powershell
$name = "codex-assistant-1"
$root = "$env:LOCALAPPDATA\CodexFeishuBridge\instances\$name"
```

Read logs:

```powershell
Get-Content "$root\logs\bridge.stdout.log" -Tail 80
Get-Content "$root\logs\bridge.stderr.log" -Tail 80
Get-Content "$root\logs\watchdog.log" -Tail 80
```

Check bridge PID and process:

```powershell
Get-Content "$root\state\bridge.pid"
Get-Process node
```

Check Feishu event consumers:

```powershell
lark-cli --profile codex-assistant-1 event status --json
```

Common issues:

| Symptom | Suggested action |
|---|---|
| Feishu receives no reply | Send `/status`; inspect `bridge.stderr.log`; check `lark-cli event status --json`. |
| `lark-cli` not found | Run `npm install -g @larksuite/cli`; reopen PowerShell; verify `lark-cli --version`. |
| Codex not found | Verify Codex installation; set `CODEX_CLI_BIN` if auto-detection cannot find it. |
| `/list` only shows default or no Codex threads | Confirm `%USERPROFILE%\.codex\state_5.sqlite` exists and Python 3 or `sqlite3` is available. |
| Bot receives messages but Codex does not start | Check Codex login/auth state, workspace trust, and bridge stderr logs. |
| Card reports Codex stream interruption | The bridge waits for native reconnect and can retry a stream interruption once. Quota, authentication, and rate-limit errors are not retried as stream recovery. |
| Recalled queued messages may still be present | Use `/queue`, `/clearqueue`, or `/stop all`. Enable `im.message.recalled_v1` only when Feishu and `lark-cli` support it. |
| Old card appears stuck after restart | Newer bridge versions mark stale running cards as interrupted during startup recovery. |
| Message starting with `/` is not handled as a normal task | Leading `/` triggers command parsing. Send ordinary tasks without a leading slash. |
| Watchdog repeatedly restarts | Inspect `watchdog.log` to determine whether the bridge process or Feishu consumer is failing. |

If `rg` is not installed, use PowerShell `Select-String` for repository searches:

```powershell
Get-ChildItem -Recurse -File | Select-String -Pattern "search text"
```

## Updating an Existing Deployment

Update source and dependencies:

```powershell
Set-Location "$env:USERPROFILE\Documents\Codex\tools\codex-feishu-bridge"
git switch main
git pull --ff-only
npm install
npm run check
```

Restart one instance so it loads the new code:

```powershell
.\stop-codex-feishu-bridge.ps1 -Name codex-assistant-1
.\start-codex-feishu-bridge.ps1 `
  -Name codex-assistant-1 `
  -LarkProfile codex-assistant-1 `
  -Workspace "$env:USERPROFILE\Documents\Codex\workspaces\feishu-bridge-codex-assistant-1" `
  -CodexTimeoutSeconds 0 `
  -CodexIdleTimeoutSeconds 3600
```

If the watchdog script or parameters changed, reinstall the watchdog:

```powershell
.\install-codex-feishu-watchdog.ps1 `
  -Name codex-assistant-1 `
  -LarkProfile codex-assistant-1 `
  -Workspace "$env:USERPROFILE\Documents\Codex\workspaces\feishu-bridge-codex-assistant-1" `
  -CodexTimeoutSeconds 0 `
  -CodexIdleTimeoutSeconds 3600 `
  -WatchdogTimeoutSeconds 180
```

Do not restart an instance that is currently running an important Codex task unless interruption is acceptable.

## Security Notes

This bridge allows Feishu users who can message the bot to trigger local Codex execution. The default `danger-full-access` mode is intended for private, trusted deployments only.

Recommended controls:

- Add each bot only to trusted chats.
- Use a dedicated workspace per bot instance.
- Do not expose the bot in public groups.
- Do not commit Feishu app secrets, access tokens, `lark-cli` configuration, Codex authentication, logs, sessions, or attachments.
- Do not publish QR registration result pages or screenshots containing credentials.
- Review workspace contents before allowing another user to control an instance.

## Pre-Publish Checklist

Run checks before publishing or pushing repository changes:

```powershell
git status --short
npm run check
```

Search for common secret patterns. Use `rg` when available:

```powershell
rg -n "app_secret|tenant_access_token|user_access_token|authorization|bearer|\\.lark-cli|\\.codex|AppData|<your-windows-user>" .
```

PowerShell fallback:

```powershell
Get-ChildItem -Recurse -File | Select-String -Pattern "app_secret|tenant_access_token|user_access_token|authorization|bearer|\\.lark-cli|\\.codex|AppData|<your-windows-user>"
```

Confirm that no credentials, logs, attachments, generated runtime data, or personal state files are included before committing.
