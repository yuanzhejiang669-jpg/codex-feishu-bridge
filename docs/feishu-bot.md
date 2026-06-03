# Feishu Bot Setup

Use one Feishu custom app/bot per Windows device.

Example naming:

- First device: `Codex 助手`
- Second device: `Codex 助手一`

Both can be created under the same Feishu user account. The important part is that each device should use its own app profile in `lark-cli`.

## Feishu Developer Console Checklist

In Feishu Open Platform:

1. Create a self-built app.
2. Set app/bot name, for example `Codex 助手一`.
3. Enable the bot capability.
4. Install or publish the app to your tenant/workplace as required by Feishu.
5. Add the bot to the target chat.
6. Subscribe to event:
   - `im.message.receive_v1`
7. Grant/approve message permissions needed by the bridge:
   - Receive messages.
   - Read message details.
   - Send messages as bot.
   - Reply to messages as bot.
   - Download message resources/images if you want image support.
   - Create/update interactive cards if you want dynamic progress cards.

Exact permission names may vary in the Feishu console and CLI versions. Use `lark-cli doctor`, `lark-cli auth scopes`, and the error message from the bridge to identify missing scopes.

## Configure The App Locally

After the app exists, configure `lark-cli` on the Windows device:

```powershell
lark-cli config init --brand feishu --name codex-helper-1
lark-cli profile use codex-helper-1
lark-cli doctor
```

To configure non-interactively:

```powershell
$secret = Read-Host "Feishu App Secret" -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
)
$plain | lark-cli config init --brand feishu --name codex-helper-1 --app-id "YOUR_FEISHU_APP_ID" --app-secret-stdin
```

Do not commit the local `lark-cli` config. It usually lives under:

```text
C:\Users\<you>\.lark-cli\config.json
```

## Test The Bot

```powershell
lark-cli event consume im.message.receive_v1 --as bot --timeout 60s
```

Send a message to the bot in Feishu. If the event appears, the bot event path works.

Then start the bridge:

```powershell
.\start-codex-feishu-bridge.ps1 -Workspace "$PWD\workspace"
```
