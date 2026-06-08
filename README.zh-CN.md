# Codex Feishu Bridge

语言：[English](README.md) | [中文](README.zh-CN.md)

Codex Feishu Bridge 用于将飞书机器人连接到本机 Codex 运行环境。它接收飞书消息，将支持的图片和文件附件下载到专用 workspace，把用户请求交给 Codex 执行，并将运行过程和最终回复回传到飞书。

`main` 分支是 Windows 部署分支，包含 PowerShell 启动脚本、Windows 计划任务 watchdog、二维码注册飞书机器人、多实例隔离、队列控制和运行诊断能力。

## 目录

- [架构](#架构)
- [功能能力](#功能能力)
- [仓库结构](#仓库结构)
- [前置要求](#前置要求)
- [飞书应用要求](#飞书应用要求)
- [安装仓库](#安装仓库)
- [推荐方式：二维码注册](#推荐方式二维码注册)
- [手动方式：使用已有飞书应用](#手动方式使用已有飞书应用)
- [Watchdog 与开机自启](#watchdog-与开机自启)
- [多实例部署](#多实例部署)
- [飞书命令](#飞书命令)
- [配置参考](#配置参考)
- [运行文件](#运行文件)
- [日志和故障排查](#日志和故障排查)
- [更新已有部署](#更新已有部署)
- [安全说明](#安全说明)
- [发布前检查](#发布前检查)

## 架构

Bridge 面向本机可信环境设计：

1. `lark-cli` 订阅飞书机器人事件。
2. `codex-feishu-bridge.mjs` 从 `lark-cli` 接收消息事件。
3. Bridge 将图片和文件附件下载到 workspace。
4. Bridge 将用户请求发送给 Codex，默认使用 `codex app-server --listen stdio://`。
5. Codex 运行时，Bridge 更新飞书交互式卡片。
6. Codex 完成后，Bridge 将最终回答发回飞书，并在本机记录 session 状态。
7. Windows 计划任务 watchdog 检查 Bridge 进程和飞书事件 consumer，并在不健康时自动重启实例。

建议每个机器人实例使用独立的飞书应用/profile、workspace、状态目录、日志目录和 watchdog 任务。

## 功能能力

- 通过 `im.message.receive_v1` 消费飞书消息事件。
- 通过 `CODEX_FEISHU_EVENT_KEYS` 可选订阅多个事件。
- 对撤回消息提供 best-effort 检查，尽量避免执行已撤回的排队消息。
- 默认使用 Codex `app-server` 模式，也支持 `exec` fallback。
- 使用飞书交互式卡片展示运行状态、工具调用、耗时、context 使用和最终回答。
- 支持将图片和文件附件下载到当前 workspace。
- 支持本地 bridge session 的新建、切换、列出、重置、压缩和删除。
- 支持查看和清理等待队列，便于处理长任务期间误发的后续消息。
- 支持同一 Windows 主机运行多个机器人实例。
- 支持 Windows 计划任务 watchdog 健康检查和自动重启。

## 仓库结构

| 路径 | 作用 |
|---|---|
| `codex-feishu-bridge.mjs` | Bridge 主进程，处理飞书事件、附件、Codex 执行、卡片、session、队列和命令。 |
| `register-codex-feishu-bot.mjs` | 基于二维码的飞书机器人注册和 `lark-cli` profile 写入逻辑。 |
| `register-codex-feishu-bot.ps1` | 注册器的 PowerShell 包装脚本，必要时会安装 Node 依赖。 |
| `start-codex-feishu-bridge.ps1` | 启动一个 Bridge 实例，并设置 workspace、profile、运行模式、超时、卡片和 MCP 参数。 |
| `stop-codex-feishu-bridge.ps1` | 停止一个 Bridge 实例，优先优雅退出，必要时强制结束进程。 |
| `watch-codex-feishu-bridge.ps1` | Watchdog 健康检查和修复脚本。 |
| `install-codex-feishu-watchdog.ps1` | 安装或卸载 Windows 计划任务 watchdog。 |
| `start-codex-feishu-bridge-hidden.vbs` | 后台隐藏窗口启动器。 |
| `watch-codex-feishu-bridge-hidden.vbs` | 计划任务使用的后台隐藏窗口 watchdog 启动器。 |
| `.env.example` | 可选环境变量示例。不要提交真实 `.env`。 |
| `docs/` | 补充部署和故障排查文档。 |
| `workspace/` | 示例 workspace 占位目录。真实工作文件不应提交到仓库。 |

## 前置要求

在 Windows 主机上安装并确认以下工具可用：

1. Windows 10 或 Windows 11。
2. PowerShell 5 或更高版本。
3. Node.js 20 或更高版本以及 npm。
4. Git。
5. 可用的 Codex CLI，或 Microsoft Store 版 Codex。
6. `lark-cli`。
7. Python 3 或 `sqlite3` CLI。二者至少需要一个，用于读取本地 Codex SQLite 状态，让 `/list` 能显示本地 Codex thread。
8. 一个可创建或授权飞书自建应用的飞书账号。

检查本机工具链：

```powershell
node -v
npm -v
git --version
powershell -NoProfile -Command "$PSVersionTable.PSVersion"
codex --version
python --version
```

如果尚未安装 `lark-cli`：

```powershell
npm install -g @larksuite/cli
lark-cli --version
```

如果 `codex` 不在 `PATH` 中，可以加入 `PATH`，也可以在启动 Bridge 前显式设置 `CODEX_CLI_BIN`：

```powershell
$env:CODEX_CLI_BIN = "C:\Path\To\codex.exe"
```

Windows 启动脚本会自动尝试查找 Microsoft Store 包 `OpenAI.Codex`。由于 WindowsApps 包目录下的内部 CLI 不一定能被 Node 直接启动，脚本会把内部 `app\resources\codex.exe` 复制到 `%LOCALAPPDATA%\CodexFeishuBridge\official-codex-cli\...`，再启动这个本地副本。如果设置了 `CODEX_CLI_BIN`，则以显式路径为最高优先级。

## 飞书应用要求

机器人使用的飞书应用需要满足：

- 已启用机器人能力。
- 已订阅事件 `im.message.receive_v1`。
- 已授予 `lark-cli` 和飞书开放平台 SDK 所需的收消息、发消息权限。
- 如需使用附件，已授予下载消息资源的相关权限。
- 已发布或安装到目标飞书租户。

关于撤回消息处理：

- Bridge 已包含对 `im.message.recalled_v1` 的可选支持。
- 飞书应用必须订阅 `im.message.recalled_v1`。
- 本机 `lark-cli` 版本必须能识别该 EventKey。
- 如果该事件不可用，Bridge 仍会在真正执行排队消息前 best-effort 检查消息状态。

默认保持只监听收消息事件：

```powershell
-EventKeys "im.message.receive_v1"
```

只有在飞书应用和本机 `lark-cli` 都支持撤回事件时，再启用：

```powershell
-EventKeys "im.message.receive_v1,im.message.recalled_v1"
```

## 安装仓库

建议将仓库放在稳定的工具目录：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\Documents\Codex\tools" | Out-Null
git clone <REPO_URL> "$env:USERPROFILE\Documents\Codex\tools\codex-feishu-bridge"
Set-Location "$env:USERPROFILE\Documents\Codex\tools\codex-feishu-bridge"
npm install
npm run check
```

Windows 部署使用 `main` 分支：

```powershell
git switch main
git pull --ff-only
```

## 推荐方式：二维码注册

二维码注册脚本会通过飞书开放平台二维码流程创建或授权飞书应用，写入 `lark-cli` profile，启动 Bridge，并可选安装 watchdog。

选择实例名和飞书展示名：

```powershell
Set-Location "$env:USERPROFILE\Documents\Codex\tools\codex-feishu-bridge"

$BotName = "codex-assistant-1"
$BotDisplayName = "Codex Assistant 1"
$Workspace = "$env:USERPROFILE\Documents\Codex\workspaces\feishu-bridge-$BotName"

.\register-codex-feishu-bot.ps1 `
  -Name $BotName `
  -DisplayName $BotDisplayName `
  -Workspace $Workspace `
  -RunMode app-server `
  -Reasoning xhigh `
  -CodexTimeoutSeconds 0 `
  -CodexIdleTimeoutSeconds 3600 `
  -InstallStartup
```

二维码流程完成后，在飞书中验证：

```text
/status
```

再发送一条普通任务消息：

```text
请用一句话说明你当前连接的是哪台本机 Codex。
```

以 `/` 开头的消息会被 Bridge 当成命令。普通 Codex 任务不要以 `/` 开头。

## 手动方式：使用已有飞书应用

如果飞书应用已经存在，可以将凭据写入 `lark-cli` profile：

```powershell
$profile = "codex-assistant-1"
$appId = "cli_xxxxxxxxxxxxx"
$appSecret = Read-Host "Feishu App Secret"

$appSecret | lark-cli profile add `
  --name $profile `
  --app-id $appId `
  --brand feishu `
  --app-secret-stdin

lark-cli profile list
```

启动 Bridge：

```powershell
.\start-codex-feishu-bridge.ps1 `
  -Name codex-assistant-1 `
  -LarkProfile codex-assistant-1 `
  -Workspace "$env:USERPROFILE\Documents\Codex\workspaces\feishu-bridge-codex-assistant-1" `
  -RunMode app-server `
  -Reasoning xhigh `
  -CodexTimeoutSeconds 0 `
  -CodexIdleTimeoutSeconds 3600
```

## Watchdog 与开机自启

为一个实例安装 watchdog：

```powershell
.\install-codex-feishu-watchdog.ps1 `
  -Name codex-assistant-1 `
  -LarkProfile codex-assistant-1 `
  -Workspace "$env:USERPROFILE\Documents\Codex\workspaces\feishu-bridge-codex-assistant-1" `
  -CodexTimeoutSeconds 0 `
  -CodexIdleTimeoutSeconds 3600 `
  -WatchdogTimeoutSeconds 180
```

Watchdog 会注册为 Windows 计划任务，在登录、解锁以及周期触发时运行。它会检查：

- Bridge PID 是否存在。
- PID 对应命令行是否匹配预期实例。
- `lark-cli event status --json` 中是否存在预期事件 consumer。
- 是否有另一个 watchdog 进程卡住超过设定时长。

卸载 watchdog：

```powershell
.\install-codex-feishu-watchdog.ps1 -Name codex-assistant-1 -Uninstall
```

手动执行一次 watchdog 检查：

```powershell
.\watch-codex-feishu-bridge.ps1 `
  -Name codex-assistant-1 `
  -LarkProfile codex-assistant-1 `
  -Workspace "$env:USERPROFILE\Documents\Codex\workspaces\feishu-bridge-codex-assistant-1"
```

## 多实例部署

每个机器人建议使用独立的实例名、飞书应用/profile、workspace 和 watchdog。

示例命名：

| 实例 | 飞书展示名 | Workspace |
|---|---|---|
| `codex-assistant-1` | `Codex Assistant 1` | `%USERPROFILE%\Documents\Codex\workspaces\feishu-bridge-codex-assistant-1` |
| `codex-assistant-2` | `Codex Assistant 2` | `%USERPROFILE%\Documents\Codex\workspaces\feishu-bridge-codex-assistant-2` |
| `codex-assistant-lab1` | `Codex Assistant Lab 1` | `%USERPROFILE%\Documents\Codex\workspaces\feishu-bridge-codex-assistant-lab1` |

注册另一个实例：

```powershell
$BotName = "codex-assistant-2"
$BotDisplayName = "Codex Assistant 2"
$Workspace = "$env:USERPROFILE\Documents\Codex\workspaces\feishu-bridge-$BotName"

.\register-codex-feishu-bot.ps1 `
  -Name $BotName `
  -DisplayName $BotDisplayName `
  -Workspace $Workspace `
  -RunMode app-server `
  -Reasoning xhigh `
  -CodexTimeoutSeconds 0 `
  -CodexIdleTimeoutSeconds 3600 `
  -InstallStartup
```

## 飞书命令

| 命令 | 说明 |
|---|---|
| `/help` | 显示可用命令。 |
| `/status` | 查看 Bridge、飞书、Codex、workspace、session、goal、队列和最近失败状态。 |
| `/now` 或 `/how` | 查看当前是否有任务正在运行。 |
| `/new [title]` | 创建本地 bridge session。 |
| `/list` 或 `/sessions` | 列出本地 bridge session 和可见 Codex threads。 |
| `/switch <序号或id>` | 将当前飞书聊天切换到另一个 session。 |
| `/context` | 查看当前 Codex thread、context 和 token 状态。 |
| `/goal [目标]` | 查看或设置 Codex goal。支持 `/goal pause`、`/goal resume`、`/goal clear`。 |
| `/provider [id]` | 查看或切换当前飞书聊天使用的 Codex provider。使用 `/provider save <id>` 持久写入用户 Codex 配置。 |
| `/model [模型ID] [推理强度]` | 查看或切换模型和 reasoning。使用 `/model list` 列出已配置模型。 |
| `/fast on/off/status` | 查看或切换 Codex Fast 模式。使用 `/fast save on` 持久写入配置。 |
| `/compact` | 压缩当前 Codex 原生 thread。 |
| `/reset` | 清空当前 bridge session 绑定。 |
| `/delete <序号或id>` | 请求删除本地 Codex thread，需要二次确认。 |
| `/confirm delete <序号>` | 确认待删除请求。 |
| `/stop` | 停止当前正在运行的 Codex 任务。`app-server` 模式会优先使用原生 `turn/interrupt`。 |
| `/queue` | 查看尚未开始执行的排队消息，不显示当前正在运行的任务。 |
| `/clearqueue` | 清空当前飞书聊天的排队消息，不停止当前任务。 |
| `/clearqueue all` | 清空该 Bot 实例处理的所有聊天排队消息。 |
| `/stop queue` | 停止当前任务，并清空当前聊天队列。 |
| `/stop all` | 停止当前任务，并清空该 Bot 实例的全部队列。 |

队列行为：

- Codex 已在运行时发送的新消息会进入等待队列。
- `/queue` 只显示等待消息，不显示当前正在执行的任务。
- 如果 Bridge 能检测到排队消息已被撤回，会跳过该消息。
- 后续排队消息不再需要执行时，使用 `/clearqueue`。
- 当前任务和后续队列都要取消时，使用 `/stop all`。

## 配置参考

### 脚本参数

| 参数 | 默认值 | 适用脚本 | 说明 |
|---|---|---|---|
| `-Name` | 空，即 default 实例 | start、stop、watchdog、registration | 实例名。命名实例使用独立运行目录。 |
| `-LarkProfile` | 当前或默认 profile | start、watchdog | `lark-cli` profile 名称，通常与 `-Name` 相同。 |
| `-Workspace` | 按实例生成的默认目录 | start、watchdog、registration | Codex 运行和附件保存目录。 |
| `-Sandbox` | `danger-full-access` | start、watchdog、registration | Codex sandbox 模式。 |
| `-RunMode` | `app-server` | start、watchdog、registration | Codex 运行模式。 |
| `-Reasoning` | `xhigh` | start、watchdog、registration | 传给 Codex 的 reasoning 设置。 |
| `-EventKeys` | `im.message.receive_v1` | start、watchdog、registration | 逗号分隔的飞书事件列表。 |
| `-CodexTimeoutSeconds` | `0` | start、watchdog、registration | 总时长硬超时。`0` 表示禁用总时长超时。 |
| `-CodexIdleTimeoutSeconds` | `3600` | start、watchdog、registration | 无进展/空闲超时。 |
| `-WatchdogTimeoutSeconds` | `180` | watchdog install/check | 用于清理卡住的 watchdog 进程。 |
| `-DisableMcp` | 关闭 | start、watchdog、registration | 禁止派生的 Codex 进程加载 MCP。 |
| `-InstallStartup` | 关闭 | registration | 二维码注册后安装 watchdog。 |

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CODEX_FEISHU_WORKSPACE` | 当前目录或脚本传入 workspace | Codex workspace。 |
| `CODEX_FEISHU_INSTANCE_NAME` | `default` | 运行实例名。 |
| `CODEX_FEISHU_LARK_PROFILE` | 空 | `lark-cli` profile。 |
| `CODEX_FEISHU_SANDBOX` | `danger-full-access` | Codex sandbox 模式。 |
| `CODEX_FEISHU_RUN_MODE` | `app-server` | 运行模式。 |
| `CODEX_FEISHU_EVENT_KEYS` | `im.message.receive_v1` | 逗号分隔的飞书事件列表。 |
| `CODEX_FEISHU_MODEL` | 空 | 可选模型覆盖。 |
| `CODEX_FEISHU_REASONING` | `xhigh` | reasoning 设置。 |
| `CODEX_FEISHU_CODEX_TIMEOUT_MS` | `0` | 总时长硬超时，单位毫秒。 |
| `CODEX_FEISHU_CODEX_IDLE_TIMEOUT_MS` | `3600000` | 无进展/空闲超时，单位毫秒。 |
| `CODEX_FEISHU_MAX_CONCURRENT` | `1` | 单实例并发任务数。建议保持串行。 |
| `CODEX_FEISHU_MAX_REPLY_CHARS` | `6000` | 直接回复最大字符数。 |
| `CODEX_FEISHU_CARD_MODE` | `1` | 启用飞书交互式卡片。 |
| `CODEX_FEISHU_CARD_THROTTLE_MS` | `400` | 卡片更新最小间隔。 |
| `CODEX_FEISHU_SHOW_FINAL_STEPS` | `1` | 最终结果中包含步骤摘要。 |
| `CODEX_FEISHU_REPLY_TO_MESSAGE` | `0` | 直接回复触发消息。 |
| `CODEX_FEISHU_REPLY_IN_THREAD` | `0` | 在支持时回复到飞书 thread。 |
| `CODEX_FEISHU_DISABLE_MCP` | `0` | 非零值表示禁用 MCP。 |
| `CODEX_FEISHU_SYNC_SESSIONS_FROM_CODEX` | `1` | 从本地 Codex 状态同步 session。 |
| `CODEX_FEISHU_SYNC_SIDEBAR` | `0` | 可选侧边栏同步。 |
| `CODEX_FEISHU_MAX_FILE_ATTACHMENT_BYTES` | `52428800` | 文件附件最大下载大小。 |
| `CODEX_FEISHU_RECALLED_MESSAGE_TTL_MS` | `86400000` | 已撤回消息标记在内存中的保留时长。 |
| `CODEX_CLI_BIN` | 自动检测 | 显式 Codex CLI 路径。 |
| `LARK_CLI_BIN` | `PATH` 中的 `lark-cli` | 显式 `lark-cli` 路径。 |

## 运行文件

默认实例：

```text
%LOCALAPPDATA%\CodexFeishuBridge\state
%LOCALAPPDATA%\CodexFeishuBridge\logs
```

命名实例：

```text
%LOCALAPPDATA%\CodexFeishuBridge\instances\<Name>\state
%LOCALAPPDATA%\CodexFeishuBridge\instances\<Name>\logs
```

Workspace 附件目录：

```text
<Workspace>\.codex-feishu-attachments\<date>\<message-id>\
```

`exec` fallback 的 prompt/output 目录：

```text
<Workspace>\.codex-feishu-runtime\codex-prompts\
<Workspace>\.codex-feishu-runtime\codex-output\
```

不要提交运行文件、日志、附件、本地 session 或任何凭据。

## 日志和故障排查

设置目标实例：

```powershell
$name = "codex-assistant-1"
$root = "$env:LOCALAPPDATA\CodexFeishuBridge\instances\$name"
```

查看日志：

```powershell
Get-Content "$root\logs\bridge.stdout.log" -Tail 80
Get-Content "$root\logs\bridge.stderr.log" -Tail 80
Get-Content "$root\logs\watchdog.log" -Tail 80
```

检查 Bridge PID 和进程：

```powershell
Get-Content "$root\state\bridge.pid"
Get-Process node
```

检查飞书事件 consumer：

```powershell
lark-cli --profile codex-assistant-1 event status --json
```

常见问题：

| 现象 | 建议处理 |
|---|---|
| 飞书没有回复 | 先发 `/status`；查看 `bridge.stderr.log`；检查 `lark-cli event status --json`。 |
| 找不到 `lark-cli` | 执行 `npm install -g @larksuite/cli`；重新打开 PowerShell；确认 `lark-cli --version`。 |
| 找不到 Codex | 确认 Codex 已安装；如果自动检测失败，设置 `CODEX_CLI_BIN`。 |
| `/list` 只显示默认或没有 Codex threads | 确认 `%USERPROFILE%\.codex\state_5.sqlite` 存在，并确认 Python 3 或 `sqlite3` 可用。 |
| 机器人收到消息但 Codex 不启动 | 检查 Codex 登录/auth 状态、workspace trust 和 Bridge stderr 日志。 |
| 卡片显示 Codex stream 中断 | Bridge 会等待原生重连，并可对 stream 中断重试一次。额度、鉴权、限流错误不会作为 stream recovery 自动重试。 |
| 撤回的排队消息仍然让人担心 | 使用 `/queue`、`/clearqueue` 或 `/stop all`。仅在飞书和 `lark-cli` 都支持时启用 `im.message.recalled_v1`。 |
| 旧卡片重启后看起来卡住 | 新版本 Bridge 启动时会把残留 running 卡片标记为已中断。 |
| 以 `/` 开头的普通消息没有按任务执行 | `/` 会触发命令解析。普通任务不要以 `/` 开头。 |
| Watchdog 反复重启 | 查看 `watchdog.log`，确认是 Bridge 进程失败还是飞书 consumer 失败。 |

如果本机没有 `rg`，可用 PowerShell `Select-String` 搜索：

```powershell
Get-ChildItem -Recurse -File | Select-String -Pattern "search text"
```

## 更新已有部署

更新源码和依赖：

```powershell
Set-Location "$env:USERPROFILE\Documents\Codex\tools\codex-feishu-bridge"
git switch main
git pull --ff-only
npm install
npm run check
```

重启一个实例，使其加载新代码：

```powershell
.\stop-codex-feishu-bridge.ps1 -Name codex-assistant-1
.\start-codex-feishu-bridge.ps1 `
  -Name codex-assistant-1 `
  -LarkProfile codex-assistant-1 `
  -Workspace "$env:USERPROFILE\Documents\Codex\workspaces\feishu-bridge-codex-assistant-1" `
  -CodexTimeoutSeconds 0 `
  -CodexIdleTimeoutSeconds 3600
```

如果 watchdog 脚本或参数有变化，重新安装 watchdog：

```powershell
.\install-codex-feishu-watchdog.ps1 `
  -Name codex-assistant-1 `
  -LarkProfile codex-assistant-1 `
  -Workspace "$env:USERPROFILE\Documents\Codex\workspaces\feishu-bridge-codex-assistant-1" `
  -CodexTimeoutSeconds 0 `
  -CodexIdleTimeoutSeconds 3600 `
  -WatchdogTimeoutSeconds 180
```

如果某个实例正在执行重要任务，不要重启该实例，除非可以接受任务中断。

## 安全说明

Bridge 会让能够给机器人发消息的人触发本机 Codex 执行。默认 `danger-full-access` 模式只适合私有、可信部署。

建议：

- 每个机器人只加入可信聊天。
- 每个机器人使用专用 workspace。
- 不要将机器人暴露在公开群或陌生人可访问的聊天中。
- 不要提交飞书 app secret、access token、`lark-cli` 配置、Codex auth、日志、session 或附件。
- 不要发布包含凭据的二维码注册结果页或截图。
- 在允许他人控制实例前，先检查 workspace 内容和权限边界。

## 发布前检查

发布或推送仓库变更前运行：

```powershell
git status --short
npm run check
```

搜索常见 secret 关键词。优先使用 `rg`：

```powershell
rg -n "app_secret|tenant_access_token|user_access_token|authorization|bearer|\\.lark-cli|\\.codex|AppData|<your-windows-user>" .
```

PowerShell 备用命令：

```powershell
Get-ChildItem -Recurse -File | Select-String -Pattern "app_secret|tenant_access_token|user_access_token|authorization|bearer|\\.lark-cli|\\.codex|AppData|<your-windows-user>"
```

提交前确认没有凭据、日志、附件、运行数据或个人状态文件。
