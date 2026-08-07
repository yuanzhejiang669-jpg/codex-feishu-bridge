# 架构说明

Codex 飞书 Bridge 分为桌面管理层和消息执行层。桌面客户端负责安装、配置、凭据、进程生命周期和更新；Bridge 引擎负责把飞书事件变成本机 Codex 任务，再把进度与结果回写飞书。

## 进程关系

```text
Codex Feishu Bridge Desktop
  -> Bot / 工作空间 / Provider / MCP / Skills 配置
  -> 客户端 supervisor 启停和恢复 Bot

飞书客户端
  -> 飞书开放平台 Bot
  -> lark-cli profile / 事件通道
  -> codex-feishu-bridge.mjs
  -> codex app-server --listen stdio://
  -> 本机 Codex Home / workspace / sessions
```

桌面客户端安装包内置 Node.js、lark-cli 和版本匹配的 Bridge 引擎。安装用户不需要从仓库启动脚本。仓库中的 PowerShell、watchdog 和网页控制面板仍可独立运行旧部署，但同一个 Bot 只能有一个生命周期管理者。

## 数据边界

每个客户端 Bot 有独立的：

- 飞书应用与 lark-cli profile
- Bridge runtime、PID、日志和恢复状态
- workspace
- 自动启动选择

多个垂类 Bot 可以共享一个隔离 Codex Home，从而共享 Provider、模型、Skills、MCP 和会话库。不同 Codex Home 的会话与配置保持隔离。

客户端自身使用版本化数据 Schema 和原子迁移。Windows Provider key 由 DPAPI 保护，macOS 由 Keychain 支持的存储保护。Bridge 引擎只能通过配置的环境或凭据注入读取所需秘密。

## 桌面管理层

- `apps/desktop/src/main/index.cjs`：Electron 主进程和 IPC 组合入口。
- `apps/desktop/src/main/services/supervisor.cjs`：客户端 Bot 的启停、活动任务保护和状态恢复。
- `apps/desktop/src/main/services/workspace-factory.cjs`：空间与 Bot 创建队列。
- `apps/desktop/src/main/services/provider-manager.cjs`：Provider 目录、凭据和引用管理。
- `apps/desktop/src/main/services/capability-migration.cjs`：MCP / Skills 源目标预览和迁移。
- `apps/desktop/src/main/services/updater.cjs`：GitHub Release 检查、下载和安装保护。
- `apps/desktop/src/main/services/data-migrations.cjs`：客户端数据 Schema 迁移与回滚。
- `apps/desktop/src/renderer/`：总览、Bot、工作空间、Provider、MCP / Skills 和系统页面。

## Bridge 执行层

- `codex-feishu-bridge.mjs`：Bridge 组合入口和高层业务编排。
- `src/codex/app-server-client.mjs`：Codex app-server stdio 传输、请求响应和通知队列。
- `src/codex/app-server-protocol.mjs`：thread、turn 和 steer 参数构造。
- `src/runtime/event-dispatcher.mjs`：飞书事件排队、并发限制、旧消息过滤和续调度。
- `src/runtime/run-watchdog.mjs`：任务总时长和空闲超时。
- `src/runtime/single-instance-lock.mjs`：Bridge 单实例锁和陈旧锁接管。
- `register-codex-feishu-bot.mjs`：飞书 Bot 注册、profile 写入和二维码流程。

旧部署还使用 `control-panel.mjs`、`control-panel/`、`start-codex-feishu-bridge.ps1` 和 Windows 计划任务 watchdog。它们是高级兼容层，不是新安装的前置条件。

## 会话数据

`/list` 合并以下来源：

- 当前 Bot 的飞书 thread 绑定
- 当前 Codex Home 的 `state_5.sqlite`
- `sessions/**/rollout-*.jsonl`
- `session_index.jsonl`
- `.codex-global-state.json`
- 同一 Codex Home 下其他 Bridge 实例的绑定

展示时会标注来源，让用户区分正常会话、仅残留文件、侧边栏索引和 Bridge 绑定。

## 删除模型

删除分为快照和确认两步：

1. `/delete <序号>` 保存当时列表对应的 threadId 快照。
2. `/confirm delete <序号>` 按快照清理当前 Codex Home 中实际存在的记录。

不会跨 Codex Home，也不会删除 Provider、密钥、日志、Bot 配置或飞书聊天消息。
