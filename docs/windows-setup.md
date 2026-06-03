# Windows Setup

This guide is for setting up the bridge on another Windows device, using the same Feishu account but a different bot name such as `Codex 助手一`.

## 1. Install Prerequisites

Install these on the second Windows device:

- Git for Windows.
- Node.js 20 or newer.
- Codex CLI or Codex Desktop.
- Feishu desktop app.
- Feishu/Lark CLI.

Install Feishu/Lark CLI:

```powershell
npm install -g @larksuite/cli
lark-cli --version
```

Check Codex:

```powershell
codex --version
codex exec --help
```

If Codex cannot read `C:\Users\<you>\.codex\config.toml`, fix that first. For current Codex CLI versions, `service_tier` should be `fast` or `flex`, not `priority`.

## 2. Clone The Private Repository

```powershell
git clone https://github.com/<your-account>/codex-feishu-bridge.git
cd codex-feishu-bridge
```

Create a workspace for Feishu-triggered Codex runs:

```powershell
New-Item -ItemType Directory -Force -Path .\workspace | Out-Null
```

## 3. Create Or Configure The Feishu Bot

Recommended setup for a second device:

- Use the same Feishu user account.
- Create a separate Feishu custom app/bot for this device.
- Name it `Codex 助手一`.
- Keep the first machine's bot as `Codex 助手`.

Why use a separate bot: if two machines consume events from the same app/bot, replies can duplicate, compete, or route unpredictably. One bot/app per device is simpler and safer.

See [feishu-bot.md](feishu-bot.md) for the app-console checklist.

## 4. Configure lark-cli

Interactive setup:

```powershell
lark-cli config init --brand feishu --name codex-helper-1
lark-cli profile use codex-helper-1
lark-cli doctor
```

If you already have the App ID and App Secret:

```powershell
$secret = Read-Host "Feishu App Secret" -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
)
$plain | lark-cli config init --brand feishu --name codex-helper-1 --app-id "YOUR_FEISHU_APP_ID" --app-secret-stdin
lark-cli profile use codex-helper-1
lark-cli doctor
```

Optional user authorization, useful if you later let Codex call Feishu APIs as the user:

```powershell
lark-cli auth login --domain im,event,drive,docs
lark-cli auth list
```

The bridge itself sends replies as `bot`.

## 5. Test Event Consumption

Run this in a terminal:

```powershell
lark-cli event consume im.message.receive_v1 --as bot --timeout 60s
```

Send a message to the bot in Feishu. You should see a JSON event in the terminal. Stop the command after the test.

If no event arrives, check:

- The bot is enabled and installed.
- The bot is added to the chat.
- The app has subscribed to `im.message.receive_v1`.
- App permissions are approved/published in the Feishu developer console.

## 6. Start The Bridge

```powershell
.\start-codex-feishu-bridge.ps1 -Workspace "$PWD\workspace"
```

Foreground debugging:

```powershell
.\start-codex-feishu-bridge.ps1 -Workspace "$PWD\workspace" -Foreground
```

Stop:

```powershell
.\stop-codex-feishu-bridge.ps1
```

Status:

```powershell
lark-cli event status --json
Get-Content "$env:LOCALAPPDATA\CodexFeishuBridge\state\bridge.pid"
Get-Content "$env:LOCALAPPDATA\CodexFeishuBridge\logs\codex-feishu-bridge.log" -Tail 80
```

## 7. Optional Autostart

Install a watchdog scheduled task:

```powershell
.\install-codex-feishu-watchdog.ps1 -Workspace "$PWD\workspace"
```

If Task Scheduler refuses due to permissions, use the hidden VBS launcher manually or place a shortcut to `watch-codex-feishu-bridge-hidden.vbs` in:

```text
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
```

## 8. Verify End To End

In Feishu, send:

```text
你好
```

Do not send `/你好`; that is interpreted as a slash command. Use `/help` only when you want bridge commands.
