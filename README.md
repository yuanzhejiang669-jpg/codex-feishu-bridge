# Codex Feishu Bridge

Languages: [English](README.md) | [中文](README.zh-CN.md)

Codex Feishu Bridge connects a Feishu bot to a local Codex runtime. It receives Feishu messages, downloads supported attachments into a dedicated workspace, starts or continues a Codex task, and posts progress plus final responses back to Feishu.

The `macos-support` branch provides the cross-platform bridge code plus macOS-oriented shell scripts and `launchd` service management. It is intended for macOS deployments while retaining the Windows scripts from the main branch.

## Contents

- [Architecture](#architecture)
- [Supported Platforms](#supported-platforms)
- [Capabilities](#capabilities)
- [Repository Layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Feishu App Requirements](#feishu-app-requirements)
- [macOS Installation](#macos-installation)
- [Recommended macOS Setup: QR Registration](#recommended-macos-setup-qr-registration)
- [Manual Setup With an Existing Feishu App](#manual-setup-with-an-existing-feishu-app)
- [macOS launchd Watchdog](#macos-launchd-watchdog)
- [Manual Start and Stop](#manual-start-and-stop)
- [Multi-Instance Deployment](#multi-instance-deployment)
- [Feishu Commands](#feishu-commands)
- [Configuration Reference](#configuration-reference)
- [Runtime Files](#runtime-files)
- [Logs and Troubleshooting](#logs-and-troubleshooting)
- [Updating an Existing macOS Deployment](#updating-an-existing-macos-deployment)
- [Windows Notes](#windows-notes)
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
7. A watchdog checks the bridge and Feishu event consumer and restarts unhealthy instances.

Each bot instance should use its own Feishu app/profile, workspace, state directory, log directory, and watchdog registration.

## Supported Platforms

| Platform | Status | Service manager |
|---|---|---|
| macOS | Supported by this branch | `launchd` LaunchAgent |
| Windows | Supported through inherited PowerShell scripts | Windows Scheduled Task |
| Linux | Basic shell start/stop scripts are present, but no production service installer is provided in this branch | Manual or custom service |

Use `main` for Windows-first deployments. Use `macos-support` for macOS deployments.

## Capabilities

- Feishu message event consumption through `im.message.receive_v1`.
- Optional multi-event subscription through `CODEX_FEISHU_EVENT_KEYS`.
- Optional best-effort handling for recalled messages before queued messages execute.
- Codex `app-server` mode by default, with `exec` fallback available.
- Feishu interactive cards for running status, tool calls, elapsed time, context usage, and final answers.
- Image and file attachment download into the active workspace.
- Local bridge sessions with commands to create, switch, list, reset, compact, and delete sessions.
- Queue visibility and cancellation commands for long-running or accidentally queued requests.
- Multi-instance operation on the same host.
- Watchdog health checks and automatic restart.

## Repository Layout

| Path | Purpose |
|---|---|
| `codex-feishu-bridge.mjs` | Main bridge process. Handles Feishu events, attachments, Codex execution, cards, sessions, queueing, and commands. |
| `register-codex-feishu-bot.mjs` | QR-code based Feishu bot registration and `lark-cli` profile setup. |
| `register-codex-feishu-bot.sh` | macOS/Linux wrapper for bot registration; installs Node dependencies when needed. |
| `start-codex-feishu-bridge.sh` | Starts one macOS/Linux bridge instance. |
| `stop-codex-feishu-bridge.sh` | Stops one macOS/Linux bridge instance. |
| `watch-codex-feishu-bridge.sh` | macOS/Linux watchdog health check and repair script. |
| `install-codex-feishu-launchd.sh` | Installs or removes a macOS `launchd` LaunchAgent. |
| `register-codex-feishu-bot.ps1` | Windows PowerShell wrapper for bot registration. |
| `start-codex-feishu-bridge.ps1` | Windows bridge startup script. |
| `stop-codex-feishu-bridge.ps1` | Windows bridge stop script. |
| `watch-codex-feishu-bridge.ps1` | Windows watchdog script. |
| `install-codex-feishu-watchdog.ps1` | Windows Scheduled Task installer. |
| `.env.example` | Optional environment variable reference. Do not commit a real `.env`. |
| `docs/` | Supplementary deployment and troubleshooting documents. |
| `workspace/` | Placeholder workspace directory. Real workspace data is not intended for source control. |

## Prerequisites

Install and verify the following on the macOS host:

1. macOS with a user account that can run `launchctl bootstrap` for user LaunchAgents.
2. Node.js 20 or newer and npm.
3. Git.
4. A working Codex CLI.
5. `lark-cli`.
6. Python 3 or `sqlite3` CLI. One of them is required for reading local Codex SQLite state used by `/list`.
7. A Feishu account that can create or authorize a custom Feishu app.

Verify the local toolchain:

```bash
node -v
npm -v
git --version
codex --version
python3 --version
```

Install `lark-cli` if it is not already available:

```bash
npm install -g @larksuite/cli
lark-cli --version
```

If `codex` or `lark-cli` is not visible from the shell, locate the executable paths:

```bash
which codex
which lark-cli
```

When needed, export explicit paths before starting the bridge or installing `launchd`:

```bash
export CODEX_CLI_BIN="$(which codex)"
export LARK_CLI_BIN="$(which lark-cli)"
```

The `launchd` installer records the current `PATH` plus explicit `CODEX_CLI_BIN` and `LARK_CLI_BIN` values in the generated LaunchAgent. If either tool is moved or reinstalled, reinstall the LaunchAgent.

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

```bash
--event-keys "im.message.receive_v1"
```

Only enable recalled events when supported:

```bash
--event-keys "im.message.receive_v1,im.message.recalled_v1"
```

## macOS Installation

Clone the repository and switch to this branch:

```bash
mkdir -p "$HOME/Documents/Codex/tools"
git clone <REPO_URL> "$HOME/Documents/Codex/tools/codex-feishu-bridge"
cd "$HOME/Documents/Codex/tools/codex-feishu-bridge"
git switch macos-support
npm install
npm run check
```

If the repository already exists:

```bash
cd "$HOME/Documents/Codex/tools/codex-feishu-bridge"
git fetch origin
git switch macos-support
git pull --ff-only
npm install
npm run check
```

## Recommended macOS Setup: QR Registration

The QR registration script creates or authorizes a Feishu app through the Feishu Open Platform QR-code flow, writes a `lark-cli` profile, starts the bridge, and can install the `launchd` watchdog.

Choose an instance name and display name:

```bash
cd "$HOME/Documents/Codex/tools/codex-feishu-bridge"

BOT_NAME="codex-assistant-mac1"
BOT_DISPLAY_NAME="Codex Assistant Mac 1"
WORKSPACE="$HOME/Documents/Codex/workspaces/feishu-bridge-$BOT_NAME"

bash ./register-codex-feishu-bot.sh \
  --name "$BOT_NAME" \
  --display-name "$BOT_DISPLAY_NAME" \
  --workspace "$WORKSPACE" \
  --run-mode app-server \
  --reasoning xhigh \
  --codex-timeout-seconds 0 \
  --codex-idle-timeout-seconds 3600 \
  --install-startup
```

The script opens a local QR-code page. Scan and authorize it with a Feishu account that can manage the target app or tenant.

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

```bash
PROFILE="codex-assistant-mac1"
APP_ID="cli_xxxxxxxxxxxxx"
read -r -s -p "Feishu App Secret: " APP_SECRET
printf '\n'

printf '%s\n' "$APP_SECRET" | lark-cli profile add \
  --name "$PROFILE" \
  --app-id "$APP_ID" \
  --brand feishu \
  --app-secret-stdin

lark-cli profile list
```

Start the bridge:

```bash
bash ./start-codex-feishu-bridge.sh \
  --name codex-assistant-mac1 \
  --lark-profile codex-assistant-mac1 \
  --workspace "$HOME/Documents/Codex/workspaces/feishu-bridge-codex-assistant-mac1" \
  --run-mode app-server \
  --reasoning xhigh \
  --codex-timeout-seconds 0 \
  --codex-idle-timeout-seconds 3600
```

## macOS launchd Watchdog

Install a LaunchAgent for one instance:

```bash
bash ./install-codex-feishu-launchd.sh \
  --name codex-assistant-mac1 \
  --lark-profile codex-assistant-mac1 \
  --workspace "$HOME/Documents/Codex/workspaces/feishu-bridge-codex-assistant-mac1" \
  --codex-timeout-seconds 0 \
  --codex-idle-timeout-seconds 3600 \
  --watchdog-timeout-seconds 180
```

The LaunchAgent:

- Runs at user login.
- Runs every 300 seconds.
- Executes `watch-codex-feishu-bridge.sh`.
- Restarts the bridge when the process or Feishu event consumer is unhealthy.
- Writes logs under the instance log directory.

Default label for a named instance:

```text
com.codex.feishu-bridge.<instance-name>
```

Check the LaunchAgent:

```bash
launchctl print "gui/$(id -u)/com.codex.feishu-bridge.codex-assistant-mac1"
```

Run one watchdog check manually:

```bash
bash ./watch-codex-feishu-bridge.sh \
  --name codex-assistant-mac1 \
  --lark-profile codex-assistant-mac1 \
  --workspace "$HOME/Documents/Codex/workspaces/feishu-bridge-codex-assistant-mac1"
```

Remove the LaunchAgent:

```bash
bash ./install-codex-feishu-launchd.sh \
  --name codex-assistant-mac1 \
  --uninstall
```

Reinstall the LaunchAgent after changing script paths, runtime parameters, `CODEX_CLI_BIN`, `LARK_CLI_BIN`, or the repository location.

## Manual Start and Stop

Start one instance in the background:

```bash
bash ./start-codex-feishu-bridge.sh \
  --name codex-assistant-mac1 \
  --lark-profile codex-assistant-mac1 \
  --workspace "$HOME/Documents/Codex/workspaces/feishu-bridge-codex-assistant-mac1"
```

Start in the foreground for debugging:

```bash
bash ./start-codex-feishu-bridge.sh \
  --name codex-assistant-mac1 \
  --lark-profile codex-assistant-mac1 \
  --workspace "$HOME/Documents/Codex/workspaces/feishu-bridge-codex-assistant-mac1" \
  --foreground
```

Stop one instance:

```bash
bash ./stop-codex-feishu-bridge.sh --name codex-assistant-mac1
```

## Multi-Instance Deployment

Use a separate instance name, Feishu app/profile, workspace, and LaunchAgent for each bot.

Example naming:

| Instance | Feishu display name | Workspace |
|---|---|---|
| `codex-assistant-mac1` | `Codex Assistant Mac 1` | `~/Documents/Codex/workspaces/feishu-bridge-codex-assistant-mac1` |
| `codex-assistant-mac2` | `Codex Assistant Mac 2` | `~/Documents/Codex/workspaces/feishu-bridge-codex-assistant-mac2` |
| `codex-assistant-lab1` | `Codex Assistant Lab 1` | `~/Documents/Codex/workspaces/feishu-bridge-codex-assistant-lab1` |

Register another instance:

```bash
BOT_NAME="codex-assistant-mac2"
BOT_DISPLAY_NAME="Codex Assistant Mac 2"
WORKSPACE="$HOME/Documents/Codex/workspaces/feishu-bridge-$BOT_NAME"

bash ./register-codex-feishu-bot.sh \
  --name "$BOT_NAME" \
  --display-name "$BOT_DISPLAY_NAME" \
  --workspace "$WORKSPACE" \
  --run-mode app-server \
  --reasoning xhigh \
  --codex-timeout-seconds 0 \
  --codex-idle-timeout-seconds 3600 \
  --install-startup
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
| `/goal [goal]` | View or set a Codex goal. Supports `/goal pause`, `/goal resume`, and `/goal clear`. |
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
- `/queue` shows pending messages only, not the active task.
- Recalled queued messages are skipped when the bridge can detect recall status.
- Use `/clearqueue` for queued messages that should not run.
- Use `/stop all` when both the active task and queued messages should be cancelled.

## Configuration Reference

### Shell Script Options

| Option | Default | Applies to | Description |
|---|---|---|---|
| `--name` | empty/default instance | start, stop, watchdog, launchd, registration | Instance name. Named instances use isolated runtime directories. |
| `--lark-profile` | current/default profile | start, watchdog, launchd | `lark-cli` profile name. Usually the same as `--name`. |
| `--workspace` | instance-specific default | start, watchdog, launchd, registration | Directory where Codex runs and attachments are stored. |
| `--sandbox` | `danger-full-access` | start, watchdog, registration | Codex sandbox mode. |
| `--run-mode` | `app-server` | start, watchdog, registration | Codex runtime mode. |
| `--reasoning` | `xhigh` | start, watchdog, registration | Reasoning setting passed to Codex. |
| `--event-keys` | `im.message.receive_v1` | start, watchdog, launchd, registration | Comma-separated Feishu event keys. |
| `--codex-timeout-seconds` | `0` | start, watchdog, launchd, registration | Hard total timeout. `0` disables the total timeout. |
| `--codex-idle-timeout-seconds` | `3600` | start, watchdog, launchd, registration | Idle/no-progress timeout. |
| `--watchdog-timeout-seconds` | `180` | watchdog, launchd | Timeout used to clean stuck watchdog locks. |
| `--disable-mcp` | off | start, watchdog, registration | Disables Codex MCP loading for spawned Codex processes. |
| `--foreground` | off | start | Runs the bridge in the foreground. |
| `--install-startup` | off | registration | Installs the platform watchdog after QR registration. |
| `--uninstall` | off | launchd | Removes the LaunchAgent. |

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `CODEX_FEISHU_WORKSPACE` | script workspace | Codex workspace. |
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

macOS default instance:

```text
~/Library/Application Support/CodexFeishuBridge/state
~/Library/Application Support/CodexFeishuBridge/logs
```

macOS named instance:

```text
~/Library/Application Support/CodexFeishuBridge/instances/<Name>/state
~/Library/Application Support/CodexFeishuBridge/instances/<Name>/logs
```

LaunchAgent plist:

```text
~/Library/LaunchAgents/com.codex.feishu-bridge.<Name>.plist
```

Workspace attachment directory:

```text
<Workspace>/.codex-feishu-attachments/<date>/<message-id>/
```

`exec` fallback prompt/output directory:

```text
<Workspace>/.codex-feishu-runtime/codex-prompts/
<Workspace>/.codex-feishu-runtime/codex-output/
```

Do not commit runtime files, logs, attachments, local sessions, LaunchAgent plists, or credentials.

## Logs and Troubleshooting

Set the target instance:

```bash
NAME="codex-assistant-mac1"
ROOT="$HOME/Library/Application Support/CodexFeishuBridge/instances/$NAME"
```

Read logs:

```bash
tail -n 80 "$ROOT/logs/codex-feishu-bridge.log"
tail -n 80 "$ROOT/logs/bridge.stdout.log"
tail -n 80 "$ROOT/logs/bridge.stderr.log"
tail -n 80 "$ROOT/logs/watchdog.log"
tail -n 80 "$ROOT/logs/launchd.stdout.log"
tail -n 80 "$ROOT/logs/launchd.stderr.log"
```

Check bridge PID and process:

```bash
cat "$ROOT/state/bridge.pid"
ps -p "$(cat "$ROOT/state/bridge.pid")" -o pid,command
```

Check Feishu event consumers:

```bash
lark-cli --profile codex-assistant-mac1 event status --json
```

Check LaunchAgent:

```bash
launchctl print "gui/$(id -u)/com.codex.feishu-bridge.codex-assistant-mac1"
```

Common issues:

| Symptom | Suggested action |
|---|---|
| Feishu receives no reply | Send `/status`; inspect `bridge.stderr.log`, `watchdog.log`, and `lark-cli event status --json`. |
| `lark-cli` not found under `launchd` | Export `LARK_CLI_BIN="$(which lark-cli)"` and reinstall the LaunchAgent. |
| Codex not found under `launchd` | Export `CODEX_CLI_BIN="$(which codex)"` and reinstall the LaunchAgent. |
| `launchctl bootstrap` fails | Run `plutil -lint` on the plist path and inspect `launchd.stderr.log`. |
| `/list` only shows default or no Codex threads | Confirm local Codex state exists and Python 3 or `sqlite3` is available. |
| Bot receives messages but Codex does not start | Check Codex login/auth state, workspace trust, and bridge stderr logs. |
| Card reports Codex stream interruption | The bridge waits for native reconnect and can retry a stream interruption once. Quota, authentication, and rate-limit errors are not retried as stream recovery. |
| Recalled queued messages may still be present | Use `/queue`, `/clearqueue`, or `/stop all`. Enable `im.message.recalled_v1` only when Feishu and `lark-cli` support it. |
| Old card appears stuck after restart | Newer bridge versions mark stale running cards as interrupted during startup recovery. |
| Message starting with `/` is not handled as a normal task | Leading `/` triggers command parsing. Send ordinary tasks without a leading slash. |
| Watchdog repeatedly restarts | Inspect `watchdog.log` to determine whether the bridge process or Feishu consumer is failing. |

## Updating an Existing macOS Deployment

Update source and dependencies:

```bash
cd "$HOME/Documents/Codex/tools/codex-feishu-bridge"
git fetch origin
git switch macos-support
git pull --ff-only
npm install
npm run check
```

Restart one instance so it loads the new code:

```bash
bash ./stop-codex-feishu-bridge.sh --name codex-assistant-mac1
bash ./start-codex-feishu-bridge.sh \
  --name codex-assistant-mac1 \
  --lark-profile codex-assistant-mac1 \
  --workspace "$HOME/Documents/Codex/workspaces/feishu-bridge-codex-assistant-mac1" \
  --codex-timeout-seconds 0 \
  --codex-idle-timeout-seconds 3600
```

If the watchdog script, repository path, binary paths, or runtime parameters changed, reinstall the LaunchAgent:

```bash
export CODEX_CLI_BIN="$(which codex)"
export LARK_CLI_BIN="$(which lark-cli)"

bash ./install-codex-feishu-launchd.sh \
  --name codex-assistant-mac1 \
  --lark-profile codex-assistant-mac1 \
  --workspace "$HOME/Documents/Codex/workspaces/feishu-bridge-codex-assistant-mac1" \
  --codex-timeout-seconds 0 \
  --codex-idle-timeout-seconds 3600 \
  --watchdog-timeout-seconds 180
```

Do not restart an instance that is currently running an important Codex task unless interruption is acceptable.

## Windows Notes

This branch includes the Windows PowerShell scripts from `main`. For a Windows-first deployment, prefer the `main` branch. If this branch is used on Windows, follow the same high-level pattern:

```powershell
.\register-codex-feishu-bot.ps1 `
  -Name codex-assistant-1 `
  -DisplayName "Codex Assistant 1" `
  -Workspace "$env:USERPROFILE\Documents\Codex\workspaces\feishu-bridge-codex-assistant-1" `
  -RunMode app-server `
  -Reasoning xhigh `
  -CodexTimeoutSeconds 0 `
  -CodexIdleTimeoutSeconds 3600 `
  -InstallStartup
```

The Windows watchdog uses `install-codex-feishu-watchdog.ps1` and Windows Scheduled Tasks, not `launchd`.

## Security Notes

This bridge allows Feishu users who can message the bot to trigger local Codex execution. The default `danger-full-access` mode is intended for private, trusted deployments only.

Recommended controls:

- Add each bot only to trusted chats.
- Use a dedicated workspace per bot instance.
- Do not expose the bot in public groups.
- Do not commit Feishu app secrets, access tokens, `lark-cli` configuration, Codex authentication, logs, sessions, attachments, or LaunchAgent plists.
- Do not publish QR registration result pages or screenshots containing credentials.
- Review workspace contents before allowing another user to control an instance.

## Pre-Publish Checklist

Run checks before publishing or pushing repository changes:

```bash
git status --short
npm run check
bash -n start-codex-feishu-bridge.sh
bash -n stop-codex-feishu-bridge.sh
bash -n watch-codex-feishu-bridge.sh
bash -n install-codex-feishu-launchd.sh
bash -n register-codex-feishu-bot.sh
```

Search for common secret patterns. Use `rg` when available:

```bash
rg -n "app_secret|tenant_access_token|user_access_token|authorization|bearer|\\.lark-cli|\\.codex|Library/Application Support|<your-user>" .
```

Portable fallback:

```bash
grep -RInE "app_secret|tenant_access_token|user_access_token|authorization|bearer|\\.lark-cli|\\.codex|Library/Application Support|<your-user>" . --exclude-dir=node_modules --exclude-dir=.git
```

Confirm that no credentials, logs, attachments, generated runtime data, personal state files, or LaunchAgent plists are included before committing.
