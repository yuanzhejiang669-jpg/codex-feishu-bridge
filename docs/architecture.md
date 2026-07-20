# 架构说明

Codex 飞书 Bridge 的职责是把飞书 Bot 消息转成 Codex 本机任务，再把任务进度和结果回写飞书。它不托管模型，也不保存云端密钥；真正的模型、Provider、MCP、Skills 都由本机 Codex 环境决定。

## 进程关系

```text
飞书客户端
  -> 飞书开放平台 Bot
  -> lark-cli profile / 事件通道
  -> codex-feishu-bridge.mjs
  -> codex app-server --listen stdio://
  -> 本机 Codex Home / workspace
```

每个 Bot 实例建议有独立的：

- 飞书应用和 lark-cli profile
- Bridge runtime 目录
- workspace
- 日志目录
- watchdog 计划任务

多个垂类 Bot 可以共用同一个 Codex Home。例如 3 个写作 Bot 可以共用 `codex-assistant-writing` 这个 Codex Home，这样它们共享同一套空间配置、Skills、MCP 和会话库。

## 主要模块

- `codex-feishu-bridge.mjs`：Bridge 组合入口和高层业务编排。具体传输、协议、队列、watchdog 和锁由 `src/` 模块负责。
- `src/codex/app-server-client.mjs`：Codex app-server stdio 传输、请求响应和通知队列。
- `src/codex/app-server-protocol.mjs`：Codex thread、turn 和 steer 参数构造。
- `src/runtime/event-dispatcher.mjs`：飞书事件排队、并发限制、召回过滤和任务续调度。
- `src/runtime/run-watchdog.mjs`：Codex 任务总时长和空闲超时。
- `src/runtime/single-instance-lock.mjs`：Bridge 单实例锁、陈旧锁接管和所有者释放。
- `control-panel.mjs`：本地控制面板 API。读取进程、日志、配置、队列、Provider、注册结果和卸载计划。
- `control-panel/`：控制面板前端。
- `register-codex-feishu-bot.mjs`：辅助注册飞书 Bot、写入 lark-cli profile、生成二维码。
- `start-codex-feishu-bridge.ps1`：启动单个 Bridge 实例。
- `watch-codex-feishu-bridge.ps1`：watchdog 健康检查和恢复。
- `install-codex-feishu-watchdog.ps1`：安装 Windows 计划任务。
- `doctor-codex-feishu-bridge.ps1`：本机诊断。

## 会话数据来源

`/list` 不只看一个位置，而是合并多个来源：

- 当前 Bot 的 `state/sessions.json` 飞书绑定
- 当前 Codex Home 的 `state_5.sqlite`
- 当前 Codex Home 的 `sessions/**/rollout-*.jsonl`
- 当前 Codex Home 的 `session_index.jsonl`
- 当前 Codex Home 的 `.codex-global-state.json`
- 与当前 Bot 使用同一 Codex Home 的其他 Bridge 实例绑定

展示时会标注来源，让用户区分正常会话、仅残留文件、侧边栏残留和 Bridge 绑定。

## 删除模型

删除分两步：

1. `/delete <序号>`：只按当时 `/list` 结果保存 threadId 快照，并要求二次确认。
2. `/confirm delete <序号>`：按快照 threadId 清理实际存在的位置。

清理范围包括当前 Codex Home 的 DB 主记录、rollout 文件、`session_index.jsonl`、`.codex-global-state.json`，以及同一 Codex Home 的 Bridge 绑定。不会跨 Codex Home 删除会话，也不会删除配置、密钥、日志、watchdog、Bot 配置或飞书聊天消息。

## 控制面板配置加载

控制面板按以下顺序读取实例配置：

1. `CODEX_FEISHU_INSTANCES_CONFIG`
2. `bridge.instances.local.json`
3. `bridge.instances.json`
4. 内置 fallback

公开仓库只提交示例 `bridge.instances.json`。真实本机实例放在 `bridge.instances.local.json`，并由 `.gitignore` 忽略。
