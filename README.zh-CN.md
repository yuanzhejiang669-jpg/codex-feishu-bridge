# Codex Feishu Bridge

语言：[English](README.md) | [中文](README.zh-CN.md)

Codex Feishu Bridge 用于将飞书机器人连接到本机 Codex 运行环境。它接收飞书消息，将支持的图片和文件附件下载到专用 workspace，把用户请求交给 Codex 执行，并将运行过程和最终回复回传到飞书。

`macos-support` 分支提供跨平台 Bridge 主体代码，以及面向 macOS 的 shell 脚本和 `launchd` 服务管理。该分支主要用于 macOS 部署，同时保留来自 `main` 分支的 Windows 脚本。

## 目录

- [架构](#架构)
- [支持平台](#支持平台)
- [功能能力](#功能能力)
- [仓库结构](#仓库结构)
- [前置要求](#前置要求)
- [飞书应用要求](#飞书应用要求)
- [macOS 安装](#macos-安装)
- [推荐 macOS 方式：二维码注册](#推荐-macos-方式二维码注册)
- [手动方式：使用已有飞书应用](#手动方式使用已有飞书应用)
- [macOS launchd Watchdog](#macos-launchd-watchdog)
- [手动启动和停止](#手动启动和停止)
- [多实例部署](#多实例部署)
- [飞书命令](#飞书命令)
- [配置参考](#配置参考)
- [运行文件](#运行文件)
- [日志和故障排查](#日志和故障排查)
- [更新已有 macOS 部署](#更新已有-macos-部署)
- [Windows 说明](#windows-说明)
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
7. Watchdog 检查 Bridge 进程和飞书事件 consumer，并在不健康时自动重启实例。

建议每个机器人实例使用独立的飞书应用/profile、workspace、状态目录、日志目录和 watchdog 注册项。

## 支持平台

| 平台 | 状态 | 服务管理方式 |
|---|---|---|
| macOS | 本分支支持 | `launchd` LaunchAgent |
| Windows | 通过继承的 PowerShell 脚本支持 | Windows 计划任务 |
| Linux | 提供基础 shell 启停脚本，但本分支未提供生产级服务安装器 | 手动或自定义服务 |

Windows 优先部署建议使用 `main` 分支。macOS 部署建议使用 `macos-support` 分支。

## 功能能力

- 通过 `im.message.receive_v1` 消费飞书消息事件。
- 通过 `CODEX_FEISHU_EVENT_KEYS` 可选订阅多个事件。
- 对撤回消息提供 best-effort 检查，尽量避免执行已撤回的排队消息。
- 默认使用 Codex `app-server` 模式，也支持 `exec` fallback。
- 使用飞书交互式卡片展示运行状态、工具调用、耗时、context 使用和最终回答。
- 支持将图片和文件附件下载到当前 workspace。
- 支持本地 bridge session 的新建、切换、列出、重置、压缩和删除。
- 支持查看和清理等待队列，便于处理长任务期间误发的后续消息。
- 支持同一主机运行多个机器人实例。
- 支持 watchdog 健康检查和自动重启。

## 仓库结构

| 路径 | 作用 |
|---|---|
| `codex-feishu-bridge.mjs` | Bridge 主进程，处理飞书事件、附件、Codex 执行、卡片、session、队列和命令。 |
| `register-codex-feishu-bot.mjs` | 基于二维码的飞书机器人注册和 `lark-cli` profile 写入逻辑。 |
| `register-codex-feishu-bot.sh` | macOS/Linux 注册器包装脚本，必要时会安装 Node 依赖。 |
| `start-codex-feishu-bridge.sh` | 启动一个 macOS/Linux Bridge 实例。 |
| `stop-codex-feishu-bridge.sh` | 停止一个 macOS/Linux Bridge 实例。 |
| `watch-codex-feishu-bridge.sh` | macOS/Linux watchdog 健康检查和修复脚本。 |
| `install-codex-feishu-launchd.sh` | 安装或卸载 macOS `launchd` LaunchAgent。 |
| `register-codex-feishu-bot.ps1` | Windows 注册器 PowerShell 包装脚本。 |
| `start-codex-feishu-bridge.ps1` | Windows Bridge 启动脚本。 |
| `stop-codex-feishu-bridge.ps1` | Windows Bridge 停止脚本。 |
| `watch-codex-feishu-bridge.ps1` | Windows watchdog 脚本。 |
| `install-codex-feishu-watchdog.ps1` | Windows 计划任务安装脚本。 |
| `.env.example` | 可选环境变量示例。不要提交真实 `.env`。 |
| `docs/` | 补充部署和故障排查文档。 |
| `workspace/` | 示例 workspace 占位目录。真实工作文件不应提交到仓库。 |

## 前置要求

在 macOS 主机上安装并确认以下工具可用：

1. macOS，并使用能够为当前用户执行 `launchctl bootstrap` 的账号。
2. Node.js 20 或更高版本以及 npm。
3. Git。
4. 可用的 Codex CLI。
5. `lark-cli`。
6. Python 3 或 `sqlite3` CLI。二者至少需要一个，用于读取本地 Codex SQLite 状态，让 `/list` 能显示本地 Codex thread。
7. 一个可创建或授权飞书自建应用的飞书账号。

检查本机工具链：

```bash
node -v
npm -v
git --version
codex --version
python3 --version
```

如果尚未安装 `lark-cli`：

```bash
npm install -g @larksuite/cli
lark-cli --version
```

如果 shell 中找不到 `codex` 或 `lark-cli`，先定位可执行文件：

```bash
which codex
which lark-cli
```

必要时，在启动 Bridge 或安装 `launchd` 前显式导出路径：

```bash
export CODEX_CLI_BIN="$(which codex)"
export LARK_CLI_BIN="$(which lark-cli)"
```

`launchd` 安装脚本会把当前 `PATH` 以及显式的 `CODEX_CLI_BIN`、`LARK_CLI_BIN` 写入生成的 LaunchAgent。如果后续移动或重装了这些工具，需要重新安装 LaunchAgent。

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

```bash
--event-keys "im.message.receive_v1"
```

只有在飞书应用和本机 `lark-cli` 都支持撤回事件时，再启用：

```bash
--event-keys "im.message.receive_v1,im.message.recalled_v1"
```

## macOS 安装

克隆仓库并切换到本分支：

```bash
mkdir -p "$HOME/Documents/Codex/tools"
git clone <REPO_URL> "$HOME/Documents/Codex/tools/codex-feishu-bridge"
cd "$HOME/Documents/Codex/tools/codex-feishu-bridge"
git switch macos-support
npm install
npm run check
```

如果仓库已经存在：

```bash
cd "$HOME/Documents/Codex/tools/codex-feishu-bridge"
git fetch origin
git switch macos-support
git pull --ff-only
npm install
npm run check
```

## 推荐 macOS 方式：二维码注册

二维码注册脚本会通过飞书开放平台二维码流程创建或授权飞书应用，写入 `lark-cli` profile，启动 Bridge，并可选安装 `launchd` watchdog。

选择实例名和飞书展示名：

```bash
cd "$HOME/Documents/Codex/tools/codex-feishu-bridge"

BOT_NAME="codex-assistant-mac1"
BOT_DISPLAY_NAME="Codex Assistant Mac 1"
WORKSPACE="$HOME/Documents/Codex/workspaces/feishu-bridge-$BOT_NAME"

bash ./register-codex-feishu-bot.sh \
  --name "$BOT_NAME" \
  --display-name "$BOT_DISPLAY_NAME" \
  --workspace "$WORKSPACE" \
  --run-mode app-server \
  --reasoning xhigh \
  --codex-timeout-seconds 0 \
  --codex-idle-timeout-seconds 3600 \
  --install-startup
```

脚本会打开一个本地二维码页面。请使用有权限管理目标应用或租户的飞书账号扫码授权。

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

```bash
PROFILE="codex-assistant-mac1"
APP_ID="cli_xxxxxxxxxxxxx"
read -r -s -p "Feishu App Secret: " APP_SECRET
printf '\n'

printf '%s\n' "$APP_SECRET" | lark-cli profile add \
  --name "$PROFILE" \
  --app-id "$APP_ID" \
  --brand feishu \
  --app-secret-stdin

lark-cli profile list
```

启动 Bridge：

```bash
bash ./start-codex-feishu-bridge.sh \
  --name codex-assistant-mac1 \
  --lark-profile codex-assistant-mac1 \
  --workspace "$HOME/Documents/Codex/workspaces/feishu-bridge-codex-assistant-mac1" \
  --run-mode app-server \
  --reasoning xhigh \
  --codex-timeout-seconds 0 \
  --codex-idle-timeout-seconds 3600
```

## macOS launchd Watchdog

为一个实例安装 LaunchAgent：

```bash
bash ./install-codex-feishu-launchd.sh \
  --name codex-assistant-mac1 \
  --lark-profile codex-assistant-mac1 \
  --workspace "$HOME/Documents/Codex/workspaces/feishu-bridge-codex-assistant-mac1" \
  --codex-timeout-seconds 0 \
  --codex-idle-timeout-seconds 3600 \
  --watchdog-timeout-seconds 180
```

LaunchAgent 会：

- 在用户登录时运行。
- 每 300 秒运行一次。
- 执行 `watch-codex-feishu-bridge.sh`。
- 在 Bridge 进程或飞书事件 consumer 不健康时重启 Bridge。
- 将日志写入实例日志目录。

命名实例的默认 label：

```text
com.codex.feishu-bridge.<instance-name>
```

检查 LaunchAgent：

```bash
launchctl print "gui/$(id -u)/com.codex.feishu-bridge.codex-assistant-mac1"
```

手动执行一次 watchdog 检查：

```bash
bash ./watch-codex-feishu-bridge.sh \
  --name codex-assistant-mac1 \
  --lark-profile codex-assistant-mac1 \
  --workspace "$HOME/Documents/Codex/workspaces/feishu-bridge-codex-assistant-mac1"
```

移除 LaunchAgent：

```bash
bash ./install-codex-feishu-launchd.sh \
  --name codex-assistant-mac1 \
  --uninstall
```

如果脚本路径、运行参数、`CODEX_CLI_BIN`、`LARK_CLI_BIN` 或仓库位置发生变化，需要重新安装 LaunchAgent。

## 手动启动和停止

后台启动一个实例：

```bash
bash ./start-codex-feishu-bridge.sh \
  --name codex-assistant-mac1 \
  --lark-profile codex-assistant-mac1 \
  --workspace "$HOME/Documents/Codex/workspaces/feishu-bridge-codex-assistant-mac1"
```

以前台模式启动，便于调试：

```bash
bash ./start-codex-feishu-bridge.sh \
  --name codex-assistant-mac1 \
  --lark-profile codex-assistant-mac1 \
  --workspace "$HOME/Documents/Codex/workspaces/feishu-bridge-codex-assistant-mac1" \
  --foreground
```

停止一个实例：

```bash
bash ./stop-codex-feishu-bridge.sh --name codex-assistant-mac1
```

## 多实例部署

每个机器人建议使用独立的实例名、飞书应用/profile、workspace 和 LaunchAgent。

示例命名：

| 实例 | 飞书展示名 | Workspace |
|---|---|---|
| `codex-assistant-mac1` | `Codex Assistant Mac 1` | `~/Documents/Codex/workspaces/feishu-bridge-codex-assistant-mac1` |
| `codex-assistant-mac2` | `Codex Assistant Mac 2` | `~/Documents/Codex/workspaces/feishu-bridge-codex-assistant-mac2` |
| `codex-assistant-lab1` | `Codex Assistant Lab 1` | `~/Documents/Codex/workspaces/feishu-bridge-codex-assistant-lab1` |

注册另一个实例：

```bash
BOT_NAME="codex-assistant-mac2"
BOT_DISPLAY_NAME="Codex Assistant Mac 2"
WORKSPACE="$HOME/Documents/Codex/workspaces/feishu-bridge-$BOT_NAME"

bash ./register-codex-feishu-bot.sh \
  --name "$BOT_NAME" \
  --display-name "$BOT_DISPLAY_NAME" \
  --workspace "$WORKSPACE" \
  --run-mode app-server \
  --reasoning xhigh \
  --codex-timeout-seconds 0 \
  --codex-idle-timeout-seconds 3600 \
  --install-startup
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

### Shell 脚本参数

| 参数 | 默认值 | 适用脚本 | 说明 |
|---|---|---|---|
| `--name` | 空，即 default 实例 | start、stop、watchdog、launchd、registration | 实例名。命名实例使用独立运行目录。 |
| `--lark-profile` | 当前或默认 profile | start、watchdog、launchd | `lark-cli` profile 名称，通常与 `--name` 相同。 |
| `--workspace` | 按实例生成的默认目录 | start、watchdog、launchd、registration | Codex 运行和附件保存目录。 |
| `--sandbox` | `danger-full-access` | start、watchdog、registration | Codex sandbox 模式。 |
| `--run-mode` | `app-server` | start、watchdog、registration | Codex 运行模式。 |
| `--reasoning` | `xhigh` | start、watchdog、registration | 传给 Codex 的 reasoning 设置。 |
| `--event-keys` | `im.message.receive_v1` | start、watchdog、launchd、registration | 逗号分隔的飞书事件列表。 |
| `--codex-timeout-seconds` | `0` | start、watchdog、launchd、registration | 总时长硬超时。`0` 表示禁用总时长超时。 |
| `--codex-idle-timeout-seconds` | `3600` | start、watchdog、launchd、registration | 无进展/空闲超时。 |
| `--watchdog-timeout-seconds` | `180` | watchdog、launchd | 用于清理卡住的 watchdog lock。 |
| `--disable-mcp` | 关闭 | start、watchdog、registration | 禁止派生的 Codex 进程加载 MCP。 |
| `--foreground` | 关闭 | start | 前台运行 Bridge。 |
| `--install-startup` | 关闭 | registration | 二维码注册后安装平台 watchdog。 |
| `--uninstall` | 关闭 | launchd | 移除 LaunchAgent。 |

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CODEX_FEISHU_WORKSPACE` | 脚本传入 workspace | Codex workspace。 |
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

macOS 默认实例：

```text
~/Library/Application Support/CodexFeishuBridge/state
~/Library/Application Support/CodexFeishuBridge/logs
```

macOS 命名实例：

```text
~/Library/Application Support/CodexFeishuBridge/instances/<Name>/state
~/Library/Application Support/CodexFeishuBridge/instances/<Name>/logs
```

LaunchAgent plist：

```text
~/Library/LaunchAgents/com.codex.feishu-bridge.<Name>.plist
```

Workspace 附件目录：

```text
<Workspace>/.codex-feishu-attachments/<date>/<message-id>/
```

`exec` fallback 的 prompt/output 目录：

```text
<Workspace>/.codex-feishu-runtime/codex-prompts/
<Workspace>/.codex-feishu-runtime/codex-output/
```

不要提交运行文件、日志、附件、本地 session、LaunchAgent plist 或任何凭据。

## 日志和故障排查

设置目标实例：

```bash
NAME="codex-assistant-mac1"
ROOT="$HOME/Library/Application Support/CodexFeishuBridge/instances/$NAME"
```

查看日志：

```bash
tail -n 80 "$ROOT/logs/codex-feishu-bridge.log"
tail -n 80 "$ROOT/logs/bridge.stdout.log"
tail -n 80 "$ROOT/logs/bridge.stderr.log"
tail -n 80 "$ROOT/logs/watchdog.log"
tail -n 80 "$ROOT/logs/launchd.stdout.log"
tail -n 80 "$ROOT/logs/launchd.stderr.log"
```

检查 Bridge PID 和进程：

```bash
cat "$ROOT/state/bridge.pid"
ps -p "$(cat "$ROOT/state/bridge.pid")" -o pid,command
```

检查飞书事件 consumer：

```bash
lark-cli --profile codex-assistant-mac1 event status --json
```

检查 LaunchAgent：

```bash
launchctl print "gui/$(id -u)/com.codex.feishu-bridge.codex-assistant-mac1"
```

常见问题：

| 现象 | 建议处理 |
|---|---|
| 飞书没有回复 | 先发 `/status`；查看 `bridge.stderr.log`、`watchdog.log` 和 `lark-cli event status --json`。 |
| `launchd` 下找不到 `lark-cli` | 导出 `LARK_CLI_BIN="$(which lark-cli)"` 后重新安装 LaunchAgent。 |
| `launchd` 下找不到 Codex | 导出 `CODEX_CLI_BIN="$(which codex)"` 后重新安装 LaunchAgent。 |
| `launchctl bootstrap` 失败 | 对 plist 路径执行 `plutil -lint`，并查看 `launchd.stderr.log`。 |
| `/list` 只显示默认或没有 Codex threads | 确认本地 Codex 状态存在，并确认 Python 3 或 `sqlite3` 可用。 |
| 机器人收到消息但 Codex 不启动 | 检查 Codex 登录/auth 状态、workspace trust 和 Bridge stderr 日志。 |
| 卡片显示 Codex stream 中断 | Bridge 会等待原生重连，并可对 stream 中断重试一次。额度、鉴权、限流错误不会作为 stream recovery 自动重试。 |
| 撤回的排队消息仍然让人担心 | 使用 `/queue`、`/clearqueue` 或 `/stop all`。仅在飞书和 `lark-cli` 都支持时启用 `im.message.recalled_v1`。 |
| 旧卡片重启后看起来卡住 | 新版本 Bridge 启动时会把残留 running 卡片标记为已中断。 |
| 以 `/` 开头的普通消息没有按任务执行 | `/` 会触发命令解析。普通任务不要以 `/` 开头。 |
| Watchdog 反复重启 | 查看 `watchdog.log`，确认是 Bridge 进程失败还是飞书 consumer 失败。 |

## 更新已有 macOS 部署

更新源码和依赖：

```bash
cd "$HOME/Documents/Codex/tools/codex-feishu-bridge"
git fetch origin
git switch macos-support
git pull --ff-only
npm install
npm run check
```

重启一个实例，使其加载新代码：

```bash
bash ./stop-codex-feishu-bridge.sh --name codex-assistant-mac1
bash ./start-codex-feishu-bridge.sh \
  --name codex-assistant-mac1 \
  --lark-profile codex-assistant-mac1 \
  --workspace "$HOME/Documents/Codex/workspaces/feishu-bridge-codex-assistant-mac1" \
  --codex-timeout-seconds 0 \
  --codex-idle-timeout-seconds 3600
```

如果 watchdog 脚本、仓库路径、二进制路径或运行参数发生变化，重新安装 LaunchAgent：

```bash
export CODEX_CLI_BIN="$(which codex)"
export LARK_CLI_BIN="$(which lark-cli)"

bash ./install-codex-feishu-launchd.sh \
  --name codex-assistant-mac1 \
  --lark-profile codex-assistant-mac1 \
  --workspace "$HOME/Documents/Codex/workspaces/feishu-bridge-codex-assistant-mac1" \
  --codex-timeout-seconds 0 \
  --codex-idle-timeout-seconds 3600 \
  --watchdog-timeout-seconds 180
```

如果某个实例正在执行重要任务，不要重启该实例，除非可以接受任务中断。

## Windows 说明

本分支包含来自 `main` 的 Windows PowerShell 脚本。Windows 优先部署建议使用 `main` 分支。如果必须在 Windows 上使用本分支，可按同样的高层流程运行：

```powershell
.\register-codex-feishu-bot.ps1 `
  -Name codex-assistant-1 `
  -DisplayName "Codex Assistant 1" `
  -Workspace "$env:USERPROFILE\Documents\Codex\workspaces\feishu-bridge-codex-assistant-1" `
  -RunMode app-server `
  -Reasoning xhigh `
  -CodexTimeoutSeconds 0 `
  -CodexIdleTimeoutSeconds 3600 `
  -InstallStartup
```

Windows watchdog 使用 `install-codex-feishu-watchdog.ps1` 和 Windows 计划任务，不使用 `launchd`。

## 安全说明

Bridge 会让能够给机器人发消息的人触发本机 Codex 执行。默认 `danger-full-access` 模式只适合私有、可信部署。

建议：

- 每个机器人只加入可信聊天。
- 每个机器人使用专用 workspace。
- 不要将机器人暴露在公开群或陌生人可访问的聊天中。
- 不要提交飞书 app secret、access token、`lark-cli` 配置、Codex auth、日志、session、附件或 LaunchAgent plist。
- 不要发布包含凭据的二维码注册结果页或截图。
- 在允许他人控制实例前，先检查 workspace 内容和权限边界。

## 发布前检查

发布或推送仓库变更前运行：

```bash
git status --short
npm run check
bash -n start-codex-feishu-bridge.sh
bash -n stop-codex-feishu-bridge.sh
bash -n watch-codex-feishu-bridge.sh
bash -n install-codex-feishu-launchd.sh
bash -n register-codex-feishu-bot.sh
```

搜索常见 secret 关键词。优先使用 `rg`：

```bash
rg -n "app_secret|tenant_access_token|user_access_token|authorization|bearer|\\.lark-cli|\\.codex|Library/Application Support|<your-user>" .
```

通用备用命令：

```bash
grep -RInE "app_secret|tenant_access_token|user_access_token|authorization|bearer|\\.lark-cli|\\.codex|Library/Application Support|<your-user>" . --exclude-dir=node_modules --exclude-dir=.git
```

提交前确认没有凭据、日志、附件、运行数据、个人状态文件或 LaunchAgent plist。
