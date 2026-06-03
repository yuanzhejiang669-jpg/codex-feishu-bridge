# Troubleshooting

## `unknown variant priority, expected fast or flex`

Your Codex CLI cannot parse `service_tier = "priority"` in:

```text
C:\Users\<you>\.codex\config.toml
```

Use:

```toml
service_tier = "fast"
```

or:

```toml
service_tier = "flex"
```

If there is a desktop setting such as `default-service-tier = "priority"`, change it to `fast` as well.

## `/你好` Shows Unknown Command

Slash-prefixed messages are bridge commands. Send:

```text
你好
```

Use `/help` only for bridge command help.

## `lark-cli not found`

Install it:

```powershell
npm install -g @larksuite/cli
lark-cli --version
```

If PowerShell cannot find it, reopen the terminal or check:

```powershell
Get-Command lark-cli.cmd
```

## Bot Receives No Events

Check:

```powershell
lark-cli doctor
lark-cli event status --json
lark-cli event consume im.message.receive_v1 --as bot --timeout 60s
```

Common causes:

- The bot is not added to the chat.
- The app has not subscribed to `im.message.receive_v1`.
- The app permissions were changed but not approved/published.
- The wrong `lark-cli` profile is active.
- Another machine is consuming events for the same bot/app.

## Bridge Starts But Feishu Gets No Reply

Check logs:

```powershell
Get-Content "$env:LOCALAPPDATA\CodexFeishuBridge\logs\codex-feishu-bridge.log" -Tail 120
Get-Content "$env:LOCALAPPDATA\CodexFeishuBridge\logs\bridge.stderr.log" -Tail 80
```

Then check that Codex can run:

```powershell
codex exec --help
```

## Two Windows Devices

Recommended:

- Device A uses bot/app `Codex 助手`.
- Device B uses bot/app `Codex 助手一`.
- Each device has its own `lark-cli` profile.
- Each device runs its own bridge and workspace.

Avoid using one bot/app on two devices at the same time.

## Stop Everything

```powershell
.\stop-codex-feishu-bridge.ps1
lark-cli event stop
```
