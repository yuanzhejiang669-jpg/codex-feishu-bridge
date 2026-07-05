# 故障排查

## Bot 没反应

先确认 Bridge 进程是否存在：

```powershell
Get-Content "$env:LOCALAPPDATA\CodexFeishuBridge\instances\<bot>\state\bridge.pid"
Get-Process -Id <pid>
```

再看日志：

```powershell
Get-Content "$env:LOCALAPPDATA\CodexFeishuBridge\instances\<bot>\logs\codex-feishu-bridge.log" -Tail 120
```

常见原因：

- 飞书 app 未完成授权或 scopes 不足。
- lark-cli profile 不存在或指向旧 app。
- Bridge 没有重启，仍然看不到新环境变量或新代码。
- Codex app-server 启动失败。
- 当前会话有 active run，新的命令被排队或拒绝。

## Provider key 不可见

控制面板写入 Windows 用户环境变量后，当前已运行的 Bridge 进程不会自动获得新环境变量。需要重启对应 Bot，或者重启所有 Bot。

检查用户环境变量：

```powershell
reg query HKCU\Environment
```

## `/list` 看到残留

残留不等于正常会话。`/list` 会标注来源：

- Codex DB + rollout + Bridge 绑定：正常会话。
- rollout-only：只有历史文件，DB 记录缺失。
- session_index / 侧边栏残留：只剩 UI 索引或全局状态。
- Bridge 绑定：飞书会话还指向某个 threadId。

删除时仍然按 threadId 快照清理实际存在的位置，不会要求所有来源都同时存在。

## 删除被拒绝

常见原因：

- 目标 thread 有 active run。
- rollout 文件不在对应 Codex Home 的 `sessions` 目录内。
- rollout 文件名不包含目标 threadId。
- 二次确认序号不是当前待删快照序号。

## 控制面板看不到新 Bot

确认新 Bot 已写入 `bridge.instances.local.json`，然后刷新页面。公开示例 `bridge.instances.json` 不承载本机真实实例。

## 二维码过期

重新点击对应 Bot 的补授权或注册按钮，确认 UI 上显示的是该 Bot 的最新二维码。扫码时看 Bot 名、profile 和二维码生成时间，不要扫旧文件或旧页面。
