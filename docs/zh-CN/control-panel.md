# 控制面板与系统自检

更新时间：2026-07-03

本文说明 `codex-feishu-bridge` 仓库内置的本地控制面板、集中实例配置和 doctor 自检脚本。所有路径和字段名可以公开；真实 API key、飞书密钥、Codex 登录态、SQLite 状态库、session 正文和日志正文不得进入仓库。

## 一句话结论

控制面板是一个运行在本机 `127.0.0.1:8320` 的中文 Web 工具。它把多 Bot、多 watchdog、本地 provider 代理、Codex Home、Desktop 侧边栏索引和系统自检集中展示出来，并提供两个需要确认文本的管理能力：添加 GPT / Responses provider，以及只重启空闲 Bridge 实例。

## 架构图

```text
浏览器 http://127.0.0.1:8320
  |
  v
control-panel/index.html + app.js + styles.css
  |
  v
control-panel.mjs  本地 HTTP/API 服务
  |
  +-- 读取 bridge.instances.json
  |     +-- device / paths / controlPanel
  |     +-- proxies: 8788 / 8789
  |     +-- instances: 每个 Bot 的 runtimeRoot / workspace / codexHome / taskName
  |
  +-- 读取本机状态
  |     +-- bridge.pid / bridge.lock.json / launch-config.json
  |     +-- active-runs.json / sessions.json / seen-events.json
  |     +-- watchdog.log / codex-feishu-bridge.log / stdout / stderr
  |     +-- Codex Home: config.toml / state_5.sqlite / session_index.jsonl / sessions
  |     +-- Windows 计划任务 / 端口 / 进程
  |
  +-- 调用 doctor-codex-feishu-bridge.ps1 -Json
  |
  +-- 可选管理动作
        +-- 添加 GPT provider -> 写 %USERPROFILE%\.codex\config.toml
        +-- 重启空闲 Bot -> stop-codex-feishu-bridge.ps1 + start-codex-feishu-bridge.ps1
```

控制面板不是 Codex runtime，也不是飞书 Bot 本体。它只是读取和管理 Bridge 周边状态。真正接收飞书消息和调用 Codex 的仍然是每个 Bot 自己的 `codex-feishu-bridge.mjs` 进程。

## 文件职责

| 文件 | 职责 |
|---|---|
| `bridge.instances.json` | 当前设备的集中实例配置。控制面板和 doctor 都从这里知道应该检查哪些 Bot、端口和路径。 |
| `control-panel.mjs` | Node 本地 HTTP 服务，托管静态页面并提供状态、自检、provider 添加和安全重启 API。 |
| `control-panel/index.html` | 页面结构，采用左侧导航 + 右侧单栏目内容区。 |
| `control-panel/app.js` | 前端状态管理、自动刷新、页面切换、详情折叠、provider 表单、重启表单和 doctor 渲染。 |
| `control-panel/styles.css` | 浅灰背景、白色 8px 卡片、左侧导航、绿黄红状态标签等 UI 样式。 |
| `doctor-codex-feishu-bridge.ps1` | 只读自检脚本，输出人类可读表格或 JSON。 |
| `start-control-panel.ps1` | 启动 `node control-panel.mjs --host 127.0.0.1 --port 8320`，写 PID 和日志。 |
| `stop-control-panel.ps1` | 只停止命令行包含 `control-panel.mjs` 的 Node 进程，避免误杀 Bridge 或其他 Node。 |
| `start-control-panel-hidden.vbs` | 隐藏窗口运行启动脚本。 |
| `install-control-panel-watchdog.ps1` | 注册 `CodexFeishuBridgeControlPanel` 计划任务，让控制面板登录后和定时健康检查时自动恢复。 |

## 页面栏目

| 栏目 | 展示内容 |
|---|---|
| 仪表盘 | Bot 在线数、active run 数、watchdog 异常数、8788/8789 代理在线数，以及状态含义说明。 |
| Bot 状态 | 每个 Bot 的在线状态、PID、active run、watchdog、计划任务、最近 provider/model、侧边栏索引状态和所有关键绝对路径。 |
| 本地代理 | `mimo2codex` 8788 / 8789 端口、PID、URL、用途说明和代理日志位置。 |
| 全局设置 | 用户级 `config.toml` 的默认 `model`、`model_provider`、`model_reasoning_effort`、`service_tier`。 |
| Provider 配置 | `[model_providers.*]` 列表、base_url、wire_api、env_key 是否对当前控制面板进程可见。 |
| 管理操作 | 添加 GPT provider；选择并重启空闲 Bridge 实例。 |
| 系统自检 | doctor 的 OK/WARN/BAD 汇总、每项检查的影响、建议和绝对路径。 |
| 最近问题 | 从每个 Bot 最近日志中提取 WARN、ERROR、failed、502、未知错误等关键词。 |

## API 边界

| API | 方法 | 是否写入 | 说明 |
|---|---:|---:|---|
| `/api/health` | GET | 否 | 控制面板健康检查。 |
| `/api/status` | GET | 否 | 汇总 Bot、provider、proxy、日志、任务和路径状态。 |
| `/api/doctor` | GET | 否 | 执行只读 doctor，自检范围由 `bridge.instances.json` 决定。 |
| `/api/provider/preview` | POST | 否 | 校验 provider 表单，调用目标 provider `GET /models` 并返回待写 TOML。 |
| `/api/provider/test` | POST | 否 | 用指定模型调用目标 provider `POST /responses` 做轻量测活。 |
| `/api/provider/add` | POST | 是 | 先 preview + test，再确认文本匹配 provider id 后追加 provider block 到 `config.toml`。 |
| `/api/restart/idle` | POST | 是 | 确认文本为 `重启空闲Bot` 后，只重启选中的空闲 Bridge。 |

管理 API 只绑定在 `127.0.0.1`。不要把控制面板暴露到公网或局域网。如果需要远程查看，应使用远程桌面或 SSH 隧道，并保留本机访问边界。

## 添加 GPT Provider 的流程

控制面板目前只支持 GPT / Responses 兼容 provider。流程是：

1. 用户填写 `provider id`、`name`、`base_url`、`env_key`、测试模型 ID。
2. 控制面板检查 `provider id` 只能包含字母、数字、下划线、点和短横线。
3. 控制面板检查 `base_url` 必须是 `http` 或 `https`。
4. 控制面板检查 `env_key` 必须是大写环境变量名。
5. 控制面板检查当前进程能看到该 env_key，但不显示密钥值。
6. 预览阶段调用 `{base_url}/models`。
7. 测活阶段调用 `{base_url}/responses`，请求体是轻量 `input: "ping"`。
8. 写入阶段要求确认框输入 provider id。
9. 最终只追加下面这种非密钥配置：

```toml
[model_providers.exampleapi]
name = "Example API"
base_url = "https://example.com/v1"
wire_api = "responses"
env_key = "EXAMPLE_API_KEY"
```

添加 provider 后，已经运行的 Bridge 是否能看到新 env key 取决于 Bridge 进程环境。如果 env key 是新设置的，通常只需要重启要使用该 provider 的空闲 Bridge 实例，不需要重启 mimo2codex，也不需要重启所有 Bot。

## 安全重启逻辑

控制面板的重启对象是 Bridge 实例进程，不是 watchdog，也不是本地 8788/8789 代理。

每个候选 Bot 都会先读取：

```text
%LOCALAPPDATA%\CodexFeishuBridge\...\state\active-runs.json
```

如果 active run 数量大于 0，控制面板跳过该 Bot 并说明原因。只有 active run 为 0 的实例才会执行：

```text
stop-codex-feishu-bridge.ps1 [-Name <instance>]
start-codex-feishu-bridge.ps1 [-Name <instance>]
```

`default` 实例不带 `-Name`；命名实例会带 `-Name codex-assistant-N`。重启后通过新的 `bridge.pid` 验证进程是否重新写入。

## doctor 自检范围

`doctor-codex-feishu-bridge.ps1` 是只读脚本。检查项包括：

- `bridge.instances.json` 是否存在并可解析。
- Node.js 是否可用。
- Bridge 主程序、控制面板、启动/停止脚本、前端文件是否存在。
- 用户级 `config.toml` 是否存在。
- provider env_key 在 Process/User/Machine 环境中是否可见，但不输出值。
- 控制面板 PID、端口和计划任务。
- 每个 Bot 的 `bridge.pid`、active run、watchdog 计划任务、watchdog.log、侧边栏索引关键文件。
- 8788/8789 等本地代理端口。
- `Mimo2CodexProxyWatchdog` 是否存在。

输出状态含义：

| 状态 | 含义 |
|---|---|
| OK | 当前项可以正常观察或运行。 |
| WARN | 需要关注，但不一定已经影响主流程，例如 active run、env key 只在用户环境可见、控制面板计划任务缺失。 |
| BAD | 关键项缺失或不可用，例如 Bot 离线、代理端口未监听、关键文件不存在。 |

## 新设备部署

新设备当前的集中配置文件是：

```text
C:\Users\yzjiang\Documents\Codex\tools\codex-feishu-bridge\bridge.instances.json
```

它描述：

```text
设备：new-pc / 新设备
源码目录：C:\Users\yzjiang\Documents\Codex\tools\codex-feishu-bridge
运行目录：C:\Users\yzjiang\AppData\Local\CodexFeishuBridge
Codex Home：C:\Users\yzjiang\.codex
控制面板：http://127.0.0.1:8320/
代理：8788 / 8789
实例：default + codex-assistant-1..9
```

新设备的常用 VBS 脚本位于：

```text
D:\常用\自启动脚本汇总\Codex飞书Bridge新设备控制面板
```

## 旧设备部署

旧设备应在 oldpc 本机使用相同源码，但使用旧设备专用 `bridge.instances.json`。目标拓扑是：

```text
普通全局 Bot：codex-assistant-old, codex-assistant-old1..old9
百科 Bot：codex-assistant-old-baike, codex-assistant-old-baike-1..-5
只读展示：codex-assistant-mobile
```

旧设备关键路径：

```text
源码目录：C:\Users\12644\Documents\Codex\tools\codex-feishu-bridge
运行目录：C:\Users\12644\AppData\Local\CodexFeishuBridge
普通 Codex Home：C:\Users\12644\.codex
百科 Codex Home：C:\Users\12644\Documents\Codex\codex-homes\codex-assistant-old-baike
控制面板：http://127.0.0.1:8320/
```

旧设备的 D 盘 VBS 建议放在：

```text
D:\常用\自启动脚本\Codex飞书Bridge旧设备控制面板
```

至少包含：

```text
01-启动旧设备控制面板服务.vbs
02-打开旧设备控制面板页面.vbs
03-关闭旧设备控制面板服务.vbs
说明.txt
```

旧设备的 mobile 只读展示，不应纳入默认批量重启或批量修改。百科 Bot 使用百科 Codex Home 作为源 Home，并镜像到普通 Codex Home 供 Codex Desktop 侧边栏显示。

## 不进入仓库的内容

不要提交：

```text
%LOCALAPPDATA%\CodexFeishuBridge\control-panel\logs
%LOCALAPPDATA%\CodexFeishuBridge\control-panel\state
%LOCALAPPDATA%\CodexFeishuBridge\instances\*\state
%LOCALAPPDATA%\CodexFeishuBridge\instances\*\logs
%USERPROFILE%\.codex\auth.json
%USERPROFILE%\.codex\sessions
%USERPROFILE%\.codex\*.sqlite
真实 API key、飞书 app secret、lark-cli profile、cookie、token、聊天正文、附件
```

`bridge.instances.json` 可以提交，因为它只记录路径、实例名、端口和计划任务名，不应包含密钥。
