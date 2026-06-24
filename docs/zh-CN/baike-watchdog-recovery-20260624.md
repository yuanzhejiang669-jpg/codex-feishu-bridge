# 2026-06-24 百科 Watchdog 恢复记录

本文记录旧设备重启后百科 Bot 不回复的恢复过程。本文不包含密钥、token、完整日志、SQLite 数据库、飞书附件或会话正文。

## 现象

旧设备重启后，普通 Bot 可以回复 `/help`，但百科 Bot 能收到飞书消息却不回复。

当时普通 Bot 正常：

```text
codex-assistant-old
codex-assistant-old1 ... codex-assistant-old9
codex-assistant-mobile
```

受影响的百科 Bot：

```text
codex-assistant-old-baike
codex-assistant-old-baike-1
codex-assistant-old-baike-2
codex-assistant-old-baike-3
codex-assistant-old-baike-4
codex-assistant-old-baike-5
```

## 定位

- `codex-assistant-old` 是本机实例名，对应飞书 profile `codex-assistant-1`，飞书里显示为 `codex助手-old`。
- 百科的 `lark-cli` profiles、workspaces、runtime state、logs 和共享 Codex Home 都还存在。
- 缺失的是 Windows 计划任务 watchdog：`CodexFeishuBridgeWatchdog-codex-assistant-old-baike*`。
- 因为这 6 个任务缺失，重启后没有自动恢复百科 `im.message.receive_v1` 事件消费者。
- stale `bridge.pid` 可能指向已复用的无关进程 ID。停止 PID 前必须先确认进程命令行包含 `codex-feishu-bridge.mjs`。

## 正确映射

每个百科 Bot 使用自己的 `LarkProfile` 和 workspace，但共享同一个百科 Codex Home：

```text
C:\Users\12644\Documents\Codex\codex-homes\codex-assistant-old-baike
```

每个百科 watchdog 都必须显式传入这个 `-CodexHome`。不要让它回退到：

```text
C:\Users\12644
```

## 已执行恢复

- 安装 6 个计划任务：`CodexFeishuBridgeWatchdog-codex-assistant-old-baike` 到 `CodexFeishuBridgeWatchdog-codex-assistant-old-baike-5`。
- 初次安装时因 PowerShell `$HOME` 变量名冲突，短暂写入了错误 Codex Home；随后已重装为正确的百科 `-CodexHome`。
- 只停止了百科相关的错误参数 watchdog/Bridge 进程和 `lark-cli` consumer。
- 清理了 `codex-assistant-old-baike-5` 的 stale state 文件：

```text
C:\Users\12644\AppData\Local\CodexFeishuBridge\instances\codex-assistant-old-baike-5\state\bridge.pid
C:\Users\12644\AppData\Local\CodexFeishuBridge\instances\codex-assistant-old-baike-5\state\bridge.lock.json
C:\Users\12644\AppData\Local\CodexFeishuBridge\instances\codex-assistant-old-baike-5\state\bridge.stop
```

当时旧 PID 已被无关 `postgres.exe` 复用。

## 最终验证

恢复后：

- 6 个百科 Bridge 进程都在运行。
- `lark-cli --profile <codex-assistant-old-baike*> event status --current --json` 均返回 `running: true`。
- 每个百科 profile 都有 1 个活跃的 `im.message.receive_v1` consumer。
- 每个百科 `launch-config.json` 都指向共享百科 Codex Home。

