# Codex Feishu Bridge

Windows-only bridge for running local Codex from a Feishu bot.

This project lets a Feishu bot receive chat messages, start a local Codex run on the Windows machine, and send the final answer back to Feishu. It is designed for personal/private use across trusted chats.

## What Is Included

- `codex-feishu-bridge.mjs` - Node.js bridge process.
- `start-codex-feishu-bridge.ps1` - start the bridge.
- `stop-codex-feishu-bridge.ps1` - stop the bridge.
- `watch-codex-feishu-bridge.ps1` - watchdog health check and restart script.
- `install-codex-feishu-watchdog.ps1` - optional Windows Task Scheduler installer.
- `*-hidden.vbs` - hidden-window launchers for Windows login/background use.
- `docs/windows-setup.md` - full setup on another Windows device.
- `docs/feishu-bot.md` - Feishu bot/app setup notes.
- `docs/troubleshooting.md` - common failures.

## What Is Not Included

This repository intentionally does not include local credentials or runtime data:

- Feishu App Secret or access tokens.
- `C:\Users\<you>\.lark-cli\config.json`.
- `C:\Users\<you>\.codex\auth.json`, `config.toml`, sessions, logs, SQLite state.
- Bridge runtime state under `%LOCALAPPDATA%\CodexFeishuBridge`.
- Logs, PID files, downloaded message attachments, or Codex transcripts.

## Quick Start On A Second Windows Device

```powershell
git clone https://github.com/<your-account>/codex-feishu-bridge.git
cd codex-feishu-bridge
npm install -g @larksuite/cli

# Configure the Feishu/Lark app on this device.
# Use a new bot/app such as "Codex 助手一".
lark-cli config init --brand feishu --name codex-helper-1
lark-cli profile use codex-helper-1
lark-cli doctor

# Start bridge. The default workspace is ./workspace.
.\start-codex-feishu-bridge.ps1 -Workspace "$PWD\workspace"
```

Then open Feishu, send a normal message to the bot. Do not prefix ordinary messages with `/`; slash-prefixed text is treated as a bridge command.

Detailed steps: [docs/windows-setup.md](docs/windows-setup.md).

## Built-In Commands

- `/help` - show command help.
- `/status` - bridge, auth, event, workspace, and current session status.
- `/new [title]` - create a new local bridge session.
- `/list` or `/sessions` - list sessions synchronized with visible Codex threads.
- `/switch <index-or-id>` - switch session.
- `/now` or `/how` - quick runtime status.
- `/context` - current Codex thread/token context status.
- `/compact` - compact current Codex native thread when supported.
- `/reset` - clear current bridge session context.
- `/stop` - stop current Codex job.

## Runtime Layout

By default the bridge writes runtime state outside the repository:

- State: `%LOCALAPPDATA%\CodexFeishuBridge\state`
- Logs: `%LOCALAPPDATA%\CodexFeishuBridge\logs`
- Workspace: `.\workspace` unless `-Workspace` is provided.

## Security Boundary

Anyone who can message the bot in allowed chats can trigger local Codex execution on the Windows machine. Keep the bot private, add it only to trusted chats, and avoid using this bridge in public or broad group chats.

The bridge defaults to `danger-full-access` because Windows sandbox behavior can vary across Codex CLI/Desktop versions. Use a dedicated workspace and trusted bot membership as the primary boundary.
