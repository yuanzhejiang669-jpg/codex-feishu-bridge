# 故障排查

先判断 Bot 由桌面客户端还是旧脚本管理。不要同时对同一个 Bot 启动两套恢复机制。

## 客户端打不开或没有窗口

1. 从开始菜单或应用程序目录重新打开 **Codex Feishu Bridge**。
2. 检查系统托盘；启用“关闭到托盘”后，关闭窗口不会退出客户端。
3. 在任务管理器中确认是否已有客户端进程。
4. 仍无界面时再检查客户端日志和安装目录，不要用临时终端进程替代正常启动方式。

## Bot 没反应

在客户端“Bot”页先看：

- Bot 是否为“在线”。
- 是否有活动任务；同一 Bot 的后续消息可能正在排队。
- “检查”是否提示飞书身份、权限、Provider、Codex runtime 或 Bridge 引擎异常。
- Bot 是否仍标记为旧脚本只读，而没有被客户端接管。

没有活动任务时，可先执行“安全重启”。强制重启会中断任务，只在用户明确接受时使用。

## 更新一直等待

客户端在有活动任务时不会安装更新。先让任务正常结束，再回到“系统”页继续。更新后比较当前版本与最新版本，并确认原本启用的 Bot 已恢复。

macOS 未签名测试构建暂不支持客户端内自动安装，需要下载新包后替换应用并用正常应用启动方式打开。

## Provider 不可用

1. 在“Provider”页确认凭据显示可用。
2. 对目标模型执行最小真实测试，不要只检查 URL 可连接。
3. 确认 Provider 协议：Responses 直连；只有 Chat Completions 的接口需要 mimo2codex 适配。
4. 检查该 Bot 或空间实际选择的 Provider 和模型，避免只改了全局目录却保留会话级覆盖。
5. 变更后只重启空闲 Bot。

## 工作空间创建卡住

队列中每个 Bot 独立注册。检查当前项是等待扫码、等待授权、权限不足还是本地保存失败。二维码过期后在当前队列项重新生成，不要继续使用旧图片。队列不会保存 App Secret、Token 或 API key。

## MCP / Skills 迁移后不可用

“已定位”只代表配置或目录存在。还要检查运行时、入口文件、依赖包、外部可执行文件、环境变量和最小真实工具调用。目标 Codex Home 已经运行的 Bot 需要重启后才能读取新的环境。

## 旧脚本部署

仅对旧脚本管理的 Bot 使用以下诊断。

读取 PID 并确认进程：

```powershell
Get-Content "$env:LOCALAPPDATA\CodexFeishuBridge\instances\<bot>\state\bridge.pid"
Get-Process -Id <pid>
```

查看日志：

```powershell
Get-Content "$env:LOCALAPPDATA\CodexFeishuBridge\instances\<bot>\logs\codex-feishu-bridge.log" -Tail 120
```

运行综合诊断：

```powershell
npm run doctor
```

旧网页控制面板看不到新 Bot 时，确认它已写入 `bridge.instances.local.json`；公开的 `bridge.instances.json` 不承载真实实例。

## 会话残留与删除

`/list` 会标注 Codex DB、rollout、索引和 Bridge 绑定等来源。残留不等于可继续的正常会话。`/delete` 生成 threadId 快照，`/confirm delete` 才按快照清理；活动任务或越过当前 Codex Home 的路径会拒绝删除。
