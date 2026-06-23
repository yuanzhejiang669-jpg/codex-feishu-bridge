# Codex Feishu Bridge

Languages: [中文](README.md) | [English](README.en.md)

Codex Feishu Bridge connects a Feishu bot to a local Codex runtime. It receives Feishu messages, downloads supported attachments into a dedicated workspace, starts or continues a Codex task, and posts progress plus final responses back to Feishu.

This repository uses Chinese as the primary documentation language. See [README.md](README.md) and [docs/zh-CN](docs/zh-CN/) for the current documentation center.

## Quick Links

- [Chinese documentation map](docs/zh-CN/README.md)
- [Architecture](docs/zh-CN/architecture.md)
- [Old-device inventory](docs/zh-CN/old-device-inventory.md)
- [New-device inventory](docs/zh-CN/new-device-inventory.md)
- [Security and redaction](docs/zh-CN/security-and-redaction.md)

## Architecture

The bridge is designed for a local trusted Windows machine:

1. `lark-cli` consumes Feishu bot events.
2. `codex-feishu-bridge.mjs` receives message events from `lark-cli`.
3. The bridge downloads image/file attachments into a workspace.
4. The bridge sends the user request to Codex, normally through `codex app-server --listen stdio://`.
5. Codex writes local thread state in the configured Codex home.
6. The bridge updates Feishu interactive cards and posts the final response.
7. A Windows Scheduled Task watchdog checks the bridge and Feishu event consumer and restarts unhealthy instances.

Each bot instance should use its own Feishu app/profile, workspace, state directory, log directory, and watchdog task. Related bots may share a dedicated Codex home with `-CodexHome` so they use the same Codex config, `AGENTS.md`, skills, MCP settings, and Codex session store.

## Repository Layout

| Path | Purpose |
|---|---|
| `codex-feishu-bridge.mjs` | Main bridge process. Handles Feishu events, attachments, Codex execution, cards, sessions, queueing, and commands. |
| `register-codex-feishu-bot.mjs` | QR-code based Feishu bot registration and `lark-cli` profile setup. |
| `register-codex-feishu-bot.ps1` | PowerShell wrapper for bot registration. |
| `start-codex-feishu-bridge.ps1` | Starts one bridge instance with workspace, profile, Codex home, runtime, timeout, card, and MCP settings. |
| `stop-codex-feishu-bridge.ps1` | Stops one bridge instance. |
| `watch-codex-feishu-bridge.ps1` | Watchdog health check and repair script. |
| `install-codex-feishu-watchdog.ps1` | Installs or removes the Windows Scheduled Task watchdog. |
| `docs/zh-CN/` | Primary Chinese documentation center. |

## Check

```powershell
npm install
npm run check
```

Do not commit secrets, local Codex state, Feishu attachments, runtime logs, SSH private keys, or generated session data.
