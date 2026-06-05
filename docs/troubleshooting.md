# Troubleshooting

## 飞书没有回复

先发：

```text
/status
```

再看日志：

```powershell
$root = "$env:LOCALAPPDATA\CodexFeishuBridge\instances\codex-assistant-1"
Get-Content "$root\logs\bridge.stdout.log" -Tail 80
Get-Content "$root\logs\bridge.stderr.log" -Tail 80
Get-Content "$root\logs\watchdog.log" -Tail 80
lark-cli event status --json
```

## `lark-cli not found`

```powershell
npm install -g @larksuite/cli
Get-Command lark-cli.cmd
lark-cli --version
```

重新打开 PowerShell 后再试。

## `codex` 找不到

```powershell
codex --version
Get-Command codex.exe
Get-Command codex.cmd
```

如果仍找不到，设置：

```powershell
$env:CODEX_CLI_BIN = "C:\Path\To\codex.exe"
```

## `/list` 只显示默认会话

这通常不是飞书问题，而是桥接器没有读到 Codex 本地状态库。

检查：

```powershell
Test-Path "$env:USERPROFILE\.codex\state_5.sqlite"
python --version
sqlite3 --version
```

`python` 或 `sqlite3` 至少一个可用即可。桥接器会优先使用 `sqlite3`，没有时自动 fallback 到 Python 3 标准库。

## 机器人收不到事件

检查：

- 机器人是否加入当前聊天。
- 飞书应用是否订阅 `im.message.receive_v1`。
- 权限是否已发布/审批。
- lark-cli profile 是否正确。
- 是否有另一台机器在消费同一个 app/bot。

测试：

```powershell
lark-cli event consume im.message.receive_v1 --as bot --timeout 60s
```

## `/你好` 显示未知命令

以 `/` 开头会被当成桥接器命令。普通任务直接发：

```text
你好
```

## watchdog 反复重启

看：

```powershell
Get-Content "$env:LOCALAPPDATA\CodexFeishuBridge\instances\codex-assistant-1\logs\watchdog.log" -Tail 120
```

常见原因是 lark consumer 不健康、profile 不正确、bridge PID 过期，或 Codex/lark-cli 命令不在 PATH。

## 停止全部

```powershell
.\stop-codex-feishu-bridge.ps1 -Name codex-assistant-1
lark-cli event stop
```
