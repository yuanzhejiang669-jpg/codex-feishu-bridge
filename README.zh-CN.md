# Codex Feishu Bridge

语言: [English](README.md) | [中文](README.zh-CN.md)

Codex Feishu Bridge 用来把飞书机器人连接到本机 Codex。它接收飞书消息，下载图片和文件附件，在本机启动或继续 Codex 任务，并把运行进度和最终回复发回飞书。

这个仓库现在作为 **唯一的中文事实源** 来维护 Bridge 本体、架构说明、新旧设备部署清单和安全边界。飞书文档只建议保留短入口，旧的 `new-device-...inventory` 和 `old-device-...inventory` 仓库只作为历史快照，不再作为主要阅读入口。

## 阅读顺序

1. [中文文档地图](docs/zh-CN/README.md)
2. [架构说明](docs/zh-CN/architecture.md)
3. [旧设备部署清单](docs/zh-CN/old-device-inventory.md)
4. [新设备部署清单](docs/zh-CN/new-device-inventory.md)
5. [安全与脱敏边界](docs/zh-CN/security-and-redaction.md)

## 项目定位

本仓库承担四类内容：

| 内容 | 放在这里的形式 | 说明 |
|---|---|---|
| Bridge 源码 | 根目录脚本和 `codex-feishu-bridge.mjs` | 长期维护的工程主体。 |
| 架构说明 | `docs/zh-CN/architecture.md` | 解释 Bridge、Workspace、Codex Home、桌面侧边栏镜像之间的关系。 |
| 新设备状态 | `docs/zh-CN/new-device-inventory.md` | 记录新设备的实例、路径、工具链和排查结论。 |
| 旧设备状态 | `docs/zh-CN/old-device-inventory.md` | 记录旧设备、百科 Bot、专用 Codex Home 和桌面镜像行为。 |

不要再把同一套事实分别维护在飞书文档、主项目 README、两个 inventory 仓库里。以后先更新本仓库，再让飞书入口链接到本仓库。

## 核心架构

Bridge 面向本机可信环境：

1. `lark-cli` 消费飞书机器人事件。
2. `codex-feishu-bridge.mjs` 接收事件并解析消息、附件和本地 session。
3. Bridge 把任务发送给 Codex，默认使用 `codex app-server --listen stdio://`。
4. Codex 在本机 Codex Home 中创建或继续线程。
5. Bridge 更新飞书交互卡片，并发送最终回复。
6. Windows watchdog 定期检查 Bridge 进程和飞书事件 consumer，必要时重启。

每个 Bot 实例建议有独立的飞书 app/profile、workspace、状态目录、日志目录和 watchdog。多个相关 Bot 可以共用一个专用 Codex Home，从而共享同一套 `AGENTS.md`、`config.toml`、skills、MCP 和 Codex thread 状态。

## 目录结构

| 路径 | 用途 |
|---|---|
| `codex-feishu-bridge.mjs` | Bridge 主进程。处理飞书事件、附件、Codex 执行、卡片、session、队列和命令。 |
| `register-codex-feishu-bot.mjs` | 基于二维码的飞书 Bot 注册和 `lark-cli` profile 写入逻辑。 |
| `register-codex-feishu-bot.ps1` | 注册器的 PowerShell 包装脚本。 |
| `start-codex-feishu-bridge.ps1` | 启动一个 Bridge 实例，并设置 workspace、profile、Codex Home、运行模式等。 |
| `stop-codex-feishu-bridge.ps1` | 停止一个 Bridge 实例。 |
| `watch-codex-feishu-bridge.ps1` | Watchdog 健康检查和修复脚本。 |
| `install-codex-feishu-watchdog.ps1` | 安装或卸载 Windows 计划任务 watchdog。 |
| `docs/zh-CN/` | 统一中文文档中心。 |
| `workspace/` | 示例 workspace 占位目录。真实运行文件不应提交。 |

## 快速启动

安装依赖：

```powershell
Set-Location "$env:USERPROFILE\Documents\Codex\tools\codex-feishu-bridge"
npm install
npm run check
```

注册并启动一个 Bot：

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

如果这个 Bot 需要使用专用规则、skills 或 MCP，额外传入：

```powershell
-CodexHome "$env:USERPROFILE\Documents\Codex\codex-homes\<name>"
```

如果还需要把专用 Codex Home 里的线程同步到默认 Codex Desktop 侧边栏，使用启动脚本支持的 `-DesktopCodexHome` 参数，并指向默认用户 Codex Home。

## 常用飞书命令

| 命令 | 说明 |
|---|---|
| `/help` | 查看可用命令。 |
| `/status` | 查看 Bridge、飞书、Codex、workspace、session、goal、队列和最近失败状态。 |
| `/list` 或 `/sessions` | 列出本地 Bridge session 和可见 Codex threads。 |
| `/switch <序号或 id>` | 切换当前飞书聊天绑定的 session。 |
| `/context` | 查看当前 Codex thread、context 和 token 状态。 |
| `/stop` | 停止当前正在运行的 Codex 任务。 |
| `/queue` | 查看尚未执行的队列消息。 |
| `/clearqueue` | 清空当前聊天的队列消息。 |
| `/stop all` | 停止当前任务并清空本实例全部队列。 |

以 `/` 开头的消息会被当成 Bridge 命令。普通 Codex 任务不要以 `/` 开头。

## 安全边界

不要提交：

- 飞书 app secret、access token、`lark-cli` 配置
- Codex auth、SQLite 状态库、session index、rollout、日志
- 飞书附件、截图、二维码、运行时 prompt/output
- `%LOCALAPPDATA%\CodexFeishuBridge\state` 或 `instances/*/state`

完整规则见 [安全与脱敏边界](docs/zh-CN/security-and-redaction.md)。

## 发布前检查

```powershell
git status --short
npm run check
```

再搜索常见敏感词：

```powershell
rg -n "app_secret|tenant_access_token|user_access_token|authorization|bearer|\\.lark-cli|\\.codex|AppData" .
```
