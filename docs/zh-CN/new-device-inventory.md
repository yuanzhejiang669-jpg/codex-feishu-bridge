# 新设备部署清单

本文件合并自新设备 inventory 仓库。它是一个脱敏后的现场快照，用来说明新设备上的 Codex Feishu Bridge 如何部署，不包含密钥、完整日志、SQLite 数据库、飞书附件或会话正文。

## 快照信息

| 项 | 值 |
|---|---|
| 快照时间 | 2026-06-22，Asia/Shanghai |
| 设备角色 | 新设备 |
| Hostname | `LAPTOP-S8RAA9LG` |
| Windows 用户 | `laptop-s8raa9lg\yzjiang` |
| 用户目录 | `C:\Users\yzjiang` |
| Codex Home | `C:\Users\yzjiang\.codex` |
| Documents Codex 根目录 | `C:\Users\yzjiang\Documents\Codex` |
| Bridge 源码路径 | `C:\Users\yzjiang\Documents\Codex\tools\codex-feishu-bridge` |

## 工具链

| 工具 | 观察到的版本 |
|---|---|
| Git | `2.53.0.windows.2` |
| GitHub CLI | `2.88.1` |
| Node.js | `v24.15.0` |
| npm | `11.13.0` |
| PowerShell | `5.1.26100.7920` |
| Codex CLI | `codex-cli 0.133.0` |
| lark-cli | `1.0.55` |

## 新设备 Bridge 状态

新设备并不只有一个默认/root Bridge。它同时存在：

1. 默认/root Bridge：

```text
C:\Users\yzjiang\Documents\Codex\workspaces\feishu-bridge
```

2. 命名实例：

```text
codex-assistant-1
codex-assistant-2
codex-assistant-3
codex-assistant-4
codex-assistant-5
codex-assistant-6
codex-assistant-7
codex-assistant-8
codex-assistant-9
```

命名实例遵循这个模式：

```text
C:\Users\yzjiang\Documents\Codex\workspaces\feishu-bridge-codex-assistant-N
C:\Users\yzjiang\AppData\Local\CodexFeishuBridge\instances\codex-assistant-N
```

这说明比较新旧设备行为时，不能只比较默认 workspace。必须确认对比的是 root/default Bridge 还是命名实例 Bridge。

## Bridge 源码仓库

| 项 | 值 |
|---|---|
| 本地路径 | `C:\Users\yzjiang\Documents\Codex\tools\codex-feishu-bridge` |
| 分支 | `main` |
| 远端 | `git@github.com:yuanzhejiang669-jpg/codex-feishu-bridge.git` |
| package name | `codex-feishu-bridge` |
| package version | `0.1.0` |
| 默认运行模式 | `app-server` |

源代码仍然以本仓库为准。新设备 inventory 仓库只记录当时观察到的状态。

## Codex Desktop 包

新设备安装了 Microsoft Store 版 Codex：

```text
OpenAI.Codex_26.616.6631.0_x64__2p2nqsd0c76g0
```

Bridge 启动脚本会把包内的：

```text
app\resources\codex.exe
```

复制到：

```text
C:\Users\yzjiang\AppData\Local\CodexFeishuBridge\official-codex-cli\...
```

这样可以避免直接从受保护的 WindowsApps 目录启动 Codex CLI 失败。

## Codex 配置摘要

新设备用户 Codex 配置包含：

```text
model = "gpt-5.5"
model_provider = "sub2api"
model_reasoning_effort = "xhigh"
service_tier = "fast"
```

当前第三方模型路由还需要下列 Codex provider block 形态：

```text
[model_providers.mimo2codex]
base_url = "http://127.0.0.1:8788/v1"
wire_api = "responses"
env_key = "MIMO2CODEX_KEY"

[model_providers.mimo2codex-apideepseek]
base_url = "http://127.0.0.1:8789/v1"
wire_api = "responses"
env_key = "MIMO2CODEX_KEY"
```

Bridge 暴露的组合 provider 包括 `m2c-deepseek`、`m2c-deepseek-flash`、`m2c-apideepseek`、`m2c-apideepseek-flash`、`m2c-kimi` 和 `m2c-glm`。它们通过 `/provider` 切换当前 session，通过 `/provider save` 写入用户级 Codex 配置。

非 GPT 模型接入参考项目是 `7as0nch/mimo2codex`：https://github.com/7as0nch/mimo2codex 。它作为独立本地代理运行，不合并进 Bridge 源码。

当前新设备已经把 mimo2codex 代理纳入独立 Windows 计划任务守护，避免关机后 8788/8789 本地端点丢失：

| 项 | 值 |
|---|---|
| 计划任务名 | `Mimo2CodexProxyWatchdog` |
| 安装脚本 | `C:\Users\yzjiang\Documents\Codex\tools\codex-feishu-bridge\install-mimo2codex-proxy-watchdog.ps1` |
| 启动脚本 | `C:\Users\yzjiang\Documents\Codex\tools\codex-feishu-bridge\start-mimo2codex-proxies.ps1` |
| 隐藏启动包装 | `C:\Users\yzjiang\Documents\Codex\tools\codex-feishu-bridge\start-mimo2codex-proxies-hidden.vbs` |
| 触发条件 | 当前用户登录、会话解锁、每 5 分钟健康检查 |
| 日志目录 | `C:\Users\yzjiang\AppData\Local\CodexFeishuBridge\mimo2codex-proxies\logs` |

新设备恢复时，在安装 `mimo2codex`、写好 `%USERPROFILE%\.mimo2codex\providers.json`、`%USERPROFILE%\.mimo2codex-apideepseek\providers.json` 和 Windows 用户环境变量后执行：

```powershell
Set-Location "$env:USERPROFILE\Documents\Codex\tools\codex-feishu-bridge"
.\install-mimo2codex-proxy-watchdog.ps1
```

验证命令：

```powershell
Get-ScheduledTask -TaskName Mimo2CodexProxyWatchdog
Get-ScheduledTaskInfo -TaskName Mimo2CodexProxyWatchdog
Get-NetTCPConnection -LocalPort 8788,8789
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" |
  Where-Object { $_.CommandLine -match 'mimo2codex|8788|8789' } |
  Select-Object ProcessId,CommandLine
```

已观察到的 MCP：

```text
tavily
codex_browser_control
codex_desktop_control
codex_android_control
node_repl
```

已观察到的插件类别：

```text
documents
spreadsheets
presentations
browser
chrome
pdf
```

配置中的密钥、token 和完整路径不应进入公开仓库。

## 端口

快照中观察到：

| 端口 | 含义 |
|---:|---|
| `8317` | 本地 CLIProxy 兼容 API endpoint |
| `8318` | 本地图像或 API endpoint |
| `8320` | Codex Feishu Bridge 新设备控制面板 |
| `8788` | mimo2codex 默认本地 Responses 兼容 endpoint |
| `8789` | API DeepSeek 专用 mimo2codex endpoint |
| `18795` | Codex browser-control extension bridge |

当时未观察到 `9222` 监听。

## 2026-07-03 控制面板、doctor 和集中配置

新设备已经增加本机中文控制面板和自检层：

```text
http://127.0.0.1:8320/
```

关键文件：

| 用途 | 路径 |
|---|---|
| 集中实例配置 | `C:\Users\yzjiang\Documents\Codex\tools\codex-feishu-bridge\bridge.instances.json` |
| 控制面板服务 | `C:\Users\yzjiang\Documents\Codex\tools\codex-feishu-bridge\control-panel.mjs` |
| 控制面板页面 | `C:\Users\yzjiang\Documents\Codex\tools\codex-feishu-bridge\control-panel\index.html` |
| 控制面板前端逻辑 | `C:\Users\yzjiang\Documents\Codex\tools\codex-feishu-bridge\control-panel\app.js` |
| 控制面板样式 | `C:\Users\yzjiang\Documents\Codex\tools\codex-feishu-bridge\control-panel\styles.css` |
| 系统自检脚本 | `C:\Users\yzjiang\Documents\Codex\tools\codex-feishu-bridge\doctor-codex-feishu-bridge.ps1` |
| 控制面板启动脚本 | `C:\Users\yzjiang\Documents\Codex\tools\codex-feishu-bridge\start-control-panel.ps1` |
| 控制面板停止脚本 | `C:\Users\yzjiang\Documents\Codex\tools\codex-feishu-bridge\stop-control-panel.ps1` |
| 控制面板计划任务安装脚本 | `C:\Users\yzjiang\Documents\Codex\tools\codex-feishu-bridge\install-control-panel-watchdog.ps1` |
| 控制面板运行状态 | `C:\Users\yzjiang\AppData\Local\CodexFeishuBridge\control-panel\state` |
| 控制面板日志 | `C:\Users\yzjiang\AppData\Local\CodexFeishuBridge\control-panel\logs` |
| D 盘常用脚本 | `D:\常用\自启动脚本汇总\Codex飞书Bridge新设备控制面板` |

`bridge.instances.json` 当前描述 10 个 Bot：

```text
default
codex-assistant-1
codex-assistant-2
codex-assistant-3
codex-assistant-4
codex-assistant-5
codex-assistant-6
codex-assistant-7
codex-assistant-8
codex-assistant-9
```

控制面板页面采用左侧导航和右侧单栏目内容区。主要栏目包括：仪表盘、Bot 状态、本地代理、全局设置、Provider 配置、管理操作、系统自检、最近问题。

普通监控页面只读；管理操作有两类写入能力：

- 添加 GPT / Responses provider：先拉取 `/models`，再做轻量 `/responses` 测活，确认后追加 provider block 到 `C:\Users\yzjiang\.codex\config.toml`，只写 `env_key` 名称，不写密钥。
- 安全重启空闲 Bot：读取 `active-runs.json`，有 active run 的实例自动跳过；只重启 Bridge 进程，不重启 watchdog，不重启 8788/8789 代理。

doctor 自检覆盖：集中配置、Node.js、关键源码文件、用户级 `config.toml`、provider env_key 可见性、控制面板进程/端口/计划任务、每个 Bot 的 PID/active run/watchdog/侧边栏索引、本地代理端口和 `Mimo2CodexProxyWatchdog`。

## 和旧设备对比时的重点

新设备样本说明：Bridge 线程可以直接写入默认 `C:\Users\yzjiang\.codex`，并具备桌面侧边栏可见所需的元数据，例如：

```text
source = vscode
thread_source = user
has_user_event = 1
preview 非空
```

旧设备普通 Bot 现在也应直接符合这类形态。旧设备百科 Bot 不同，它们的源线程在百科专用 Codex Home 中，然后再镜像到默认 Codex Home。

## 排除项

以下内容只允许本地存在，不进入 GitHub：

```text
C:\Users\yzjiang\.codex\auth.json
C:\Users\yzjiang\.codex\*.sqlite
C:\Users\yzjiang\.codex\session_index.jsonl
C:\Users\yzjiang\.codex\.codex-global-state.json
C:\Users\yzjiang\AppData\Local\CodexFeishuBridge\state
C:\Users\yzjiang\AppData\Local\CodexFeishuBridge\instances\*\state
C:\Users\yzjiang\AppData\Local\CodexFeishuBridge\logs
C:\Users\yzjiang\AppData\Local\CodexFeishuBridge\instances\*\logs
```

原因是这些文件可能包含认证信息、本地状态、私有 prompt、thread 元数据、飞书事件标识或聊天历史。
