# Codex Feishu Bridge

把飞书机器人接到本机 Codex 的 Windows 桥接器。

这个项目的目标很直接：在一台 Windows 电脑上运行本地 Codex，把飞书里的普通消息、图片和文件转成 Codex 任务，再把 Codex 的过程和最终回答回传到飞书。旧设备只要拿到这个仓库链接，按 README 配置一次，就可以复现同样的“飞书远程控制 Codex”效果。

## 适用场景

- 在手机、平板或另一台电脑的飞书里远程调用家里/办公室 Windows 机器上的 Codex。
- 给多个飞书机器人分别绑定不同 Codex workspace，例如 `codex-assistant-1`、`codex-assistant-2`。
- 让 Codex 在一个稳定目录里处理飞书发来的文档、图片、代码和长任务。
- 用飞书动态卡片查看 Codex 正在做什么，任务结束后折叠过程并保留最终答案。

## 当前能力

- 飞书事件消费：监听 `im.message.receive_v1`。
- Codex 运行模式：默认使用 `codex app-server --listen stdio://`，必要时可切到 `exec`。
- 动态卡片：任务运行中实时更新，完成后展示最终答案、耗时、token/context 信息。
- 附件处理：支持飞书图片和文件下载到 workspace，再交给 Codex 读取。
- 会话管理：支持新建、切换、列出、同步 Codex 可见线程。
- 安全删除：删除本地 Codex thread 前需要按 `/confirm delete <序号>` 二次确认。
- 多实例：同一台 Windows 机器可以跑多个机器人/profile/workspace。
- 看门狗：Windows 计划任务定期检查桥进程和飞书 consumer，不健康时自动重启。

## 目录说明

| 文件或目录 | 作用 |
|---|---|
| `codex-feishu-bridge.mjs` | 核心桥接器，负责飞书事件、附件、Codex app-server、动态卡片、会话、命令处理 |
| `start-codex-feishu-bridge.ps1` | 启动桥接器，设置 workspace、profile、sandbox、reasoning、超时、卡片等参数 |
| `stop-codex-feishu-bridge.ps1` | 停止桥接器，优先优雅退出，必要时结束进程 |
| `watch-codex-feishu-bridge.ps1` | 看门狗健康检查和自动重启 |
| `install-codex-feishu-watchdog.ps1` | 注册/卸载 Windows 计划任务 |
| `register-codex-feishu-bot.mjs` | 通过飞书二维码注册新机器人，并写入 lark-cli profile |
| `register-codex-feishu-bot.ps1` | 注册器的 PowerShell 包装，会自动安装 Node 依赖 |
| `*-hidden.vbs` | 后台隐藏窗口启动器 |
| `.env.example` | 可选环境变量示例，不要提交真实 `.env` |
| `docs/` | 补充部署和故障文档 |
| `workspace/` | 示例 workspace 占位目录，真实内容不会提交 |

## 不会提交的内容

这些内容必须只留在本机：

- 飞书 App Secret、access token。
- `%USERPROFILE%\.lark-cli\config.json`。
- `%USERPROFILE%\.codex\auth.json`、`config.toml`、sessions、SQLite state。
- `%LOCALAPPDATA%\CodexFeishuBridge` 下的日志、PID、sessions、二维码注册文件。
- `.codex-feishu-runtime`、`.codex-feishu-attachments`、Codex 输出、飞书下载附件。

## 旧设备给 Codex 的提示词

把下面这段发给旧设备上的 Codex，并把 `<REPO_URL>` 换成真实 GitHub 地址：

```text
请在这台 Windows 设备上安装并配置 Codex Feishu Bridge。

仓库地址：<REPO_URL>

目标效果：
1. 克隆仓库到 %USERPROFILE%\Documents\Codex\tools\codex-feishu-bridge。
2. 按 README 检查 Node.js 20+、npm、PowerShell、Codex CLI、lark-cli。
3. 使用 register-codex-feishu-bot.ps1 注册一个飞书机器人，实例名用 codex-assistant-1。
4. workspace 使用 %USERPROFILE%\Documents\Codex\workspaces\feishu-bridge-codex-assistant-1。
5. 默认使用 app-server、danger-full-access、reasoning=xhigh、Codex 超时 7200 秒、动态卡片开启、MCP 开启。
6. 安装 watchdog 开机/解锁/每 5 分钟自动检查。
7. 最后在飞书里发送 /status 和一条普通消息验证。

不要提交或展示任何 app secret、token、.codex auth、.lark-cli config、日志、sessions 或附件内容。
如果本机 codex 不在 PATH，请先定位 codex.exe 或 codex.cmd，然后设置 CODEX_CLI_BIN 再启动。
```

## 前置要求

在目标 Windows 设备上准备：

1. Windows 10/11。
2. PowerShell 5+。
3. Node.js 20+ 和 npm。
4. Git。
5. 已安装并登录可用的官方 Microsoft Store 版 Codex，或其他可用的 Codex CLI。
6. `lark-cli`。
7. Python 3 或 `sqlite3` CLI。用于读取 Codex 本地 `state_5.sqlite`，从而让 `/list` 显示本机 Codex 侧边栏已有会话。
8. 可以扫码管理飞书自建应用的飞书账号。

检查命令：

```powershell
node -v
npm -v
git --version
powershell -NoProfile -Command "$PSVersionTable.PSVersion"
codex --version
python --version
```

安装 lark-cli：

```powershell
npm install -g @larksuite/cli
lark-cli --version
```

启动脚本默认会优先自动查找官方 Microsoft Store 版 `OpenAI.Codex`。由于 WindowsApps 保护目录下的内部 CLI 不能被 Node 直接 `spawn`，脚本会把 `app\resources\codex.exe` 同步到 `%LOCALAPPDATA%\CodexFeishuBridge\official-codex-cli\...`，再从这个本地缓存副本启动。这样 Codex 自动更新、版本目录变化后，桥接器仍会使用当前官方版本。

如果要显式指定其他 Codex CLI，例如测试版、Codex++ 或 Rebuild，再设置 `CODEX_CLI_BIN`：

```powershell
$env:CODEX_CLI_BIN = "C:\Path\To\codex.exe"
```

也可以把这行写进用户环境变量，之后重新打开 PowerShell。`CODEX_CLI_BIN` 的优先级最高。

如果 `python --version` 不可用，也可以安装 `sqlite3` CLI。二者有一个可用即可；桥接器会优先调用 `sqlite3`，没有时自动 fallback 到 Python 标准库 `sqlite3`。

## 安装仓库

推荐固定放到：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\Documents\Codex\tools" | Out-Null
git clone <REPO_URL> "$env:USERPROFILE\Documents\Codex\tools\codex-feishu-bridge"
Set-Location "$env:USERPROFILE\Documents\Codex\tools\codex-feishu-bridge"
npm install
npm run check
```

## 推荐方式：二维码自动注册机器人

这个方式最接近当前好用的效果。它会：

- 调用飞书开放平台 SDK 申请注册二维码。
- 打开本机二维码 HTML。
- 扫码后获得 app id 和 app secret。
- 写入 lark-cli profile。
- 启动桥接器。
- 可选安装 watchdog。

### PowerShell 直接注册并启动 Bot

在目标 Windows 设备的 PowerShell 里复制下面这段。只需要改 `$BotName` 和 `$BotDisplayName`；脚本会生成飞书注册二维码，扫码后自动创建 profile、启动 bridge，并安装 watchdog。

```powershell
Set-Location "$env:USERPROFILE\Documents\Codex\tools\codex-feishu-bridge"

$BotName = "codex-assistant-1"
$BotDisplayName = "Codex Assistant 1"

.\register-codex-feishu-bot.ps1 `
  -Name $BotName `
  -DisplayName $BotDisplayName `
  -Workspace "$env:USERPROFILE\Documents\Codex\workspaces\feishu-bridge-$BotName" `
  -RunMode app-server `
  -Reasoning xhigh `
  -CodexTimeoutSeconds 7200 `
  -InstallStartup
```

例如第二个 Bot，把变量改成：

```powershell
$BotName = "codex-assistant-2"
$BotDisplayName = "Codex Assistant 2"
```

旧设备上也一样，只是在旧设备本机 PowerShell 里运行；例如：

```powershell
$BotName = "codex-assistant-old3"
$BotDisplayName = "Codex Assistant Old 3"
```

也可以直接写死参数：

```powershell
Set-Location "$env:USERPROFILE\Documents\Codex\tools\codex-feishu-bridge"

.\register-codex-feishu-bot.ps1 `
  -Name codex-assistant-1 `
  -DisplayName "Codex Assistant 1" `
  -Workspace "$env:USERPROFILE\Documents\Codex\workspaces\feishu-bridge-codex-assistant-1" `
  -RunMode app-server `
  -Reasoning xhigh `
  -CodexTimeoutSeconds 7200 `
  -InstallStartup
```

完成后在飞书里给机器人发送：

```text
/status
```

再发送一条普通消息，例如：

```text
你是谁？请用一句话说明你现在连接的是本机 Codex。
```

注意：普通任务不要以 `/` 开头。以 `/` 开头的文本会被桥接器当成命令。

## 手动方式：使用已有飞书应用

如果你已经在飞书开放平台有应用，可以手动配置。

飞书应用侧至少需要：

- 启用机器人能力。
- 订阅事件：`im.message.receive_v1`。
- 给机器人授予收消息、发消息、下载消息资源所需权限。
- 发布或安装到对应企业/租户。

然后写入 lark-cli profile：

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

启动桥接器：

```powershell
.\start-codex-feishu-bridge.ps1 `
  -Name codex-assistant-1 `
  -LarkProfile codex-assistant-1 `
  -Workspace "$env:USERPROFILE\Documents\Codex\workspaces\feishu-bridge-codex-assistant-1" `
  -RunMode app-server `
  -Reasoning xhigh `
  -CodexTimeoutSeconds 7200
```

## 开机自启和看门狗

安装：

```powershell
.\install-codex-feishu-watchdog.ps1 `
  -Name codex-assistant-1 `
  -LarkProfile codex-assistant-1 `
  -Workspace "$env:USERPROFILE\Documents\Codex\workspaces\feishu-bridge-codex-assistant-1"
```

卸载：

```powershell
.\install-codex-feishu-watchdog.ps1 -Name codex-assistant-1 -Uninstall
```

看门狗会在登录、解锁、以及每 5 分钟触发一次。它会检查：

- `bridge.pid` 对应进程是否存在。
- 进程命令行是否像桥接器。
- `lark-cli event status --json` 里是否存在运行中的 `im.message.receive_v1` consumer。

## 多机器人

每个机器人建议使用独立的：

- `Name`
- lark-cli profile
- workspace
- watchdog task
- `%LOCALAPPDATA%\CodexFeishuBridge\instances\<Name>` 状态目录

示例：

```powershell
.\register-codex-feishu-bot.ps1 `
  -Name codex-assistant-2 `
  -DisplayName "Codex Assistant 2" `
  -Workspace "$env:USERPROFILE\Documents\Codex\workspaces\feishu-bridge-codex-assistant-2" `
  -InstallStartup
```

## 常用命令

| 飞书命令 | 作用 |
|---|---|
| `/help` | 显示帮助 |
| `/status` | 查看桥、飞书、Codex、workspace、当前 session 状态 |
| `/now` 或 `/how` | 查看当前是否有任务运行 |
| `/new [title]` | 新建本地桥接 session |
| `/list` 或 `/sessions` | 列出 session 和可见 Codex threads |
| `/switch <序号或id>` | 切换 session |
| `/context` | 查看当前 Codex thread/context/token 状态 |
| `/compact` | 压缩当前 Codex 原生 thread |
| `/reset` | 清空当前桥接 session 绑定 |
| `/delete <序号或id>` | 请求删除本地 Codex thread，需要二次确认 |
| `/confirm delete <序号>` | 确认删除 |
| `/stop` | 停止当前运行中的 Codex 任务 |

## 默认参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `RunMode` | `app-server` | 使用 Codex app-server 原生线程 |
| `Sandbox` | `danger-full-access` | 本机私有桥默认全权限，依靠私有机器人和专用 workspace 做边界 |
| `Reasoning` | `xhigh` | 传给 Codex 的推理强度 |
| `CodexTimeoutSeconds` | `7200` | 启动脚本默认 2 小时 |
| `MaxConcurrent` | `1` | 同实例串行处理 |
| 动态卡片 | 开启 | 用飞书卡片显示过程和结果 |
| MCP | 开启 | 需要关闭时传 `-DisableMcp` |
| 附件大小 | 50 MB | 超过会跳过 |
| 附件暂存 | 30 分钟 | 只发附件不发文字时，等待下一条文字触发处理 |

## Runtime 位置

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

workspace 示例：

```text
%USERPROFILE%\Documents\Codex\workspaces\feishu-bridge-codex-assistant-1
```

附件会下载到 workspace 下的：

```text
.codex-feishu-attachments\<date>\<message-id>\
```

Codex exec fallback 的 prompt/output 会写入：

```text
.codex-feishu-runtime\codex-prompts\
.codex-feishu-runtime\codex-output\
```

## 日志和排错

查看桥接器输出：

```powershell
$root = "$env:LOCALAPPDATA\CodexFeishuBridge\instances\codex-assistant-1"
Get-Content "$root\logs\bridge.stdout.log" -Tail 80
Get-Content "$root\logs\bridge.stderr.log" -Tail 80
Get-Content "$root\logs\watchdog.log" -Tail 80
```

确认进程：

```powershell
Get-Content "$env:LOCALAPPDATA\CodexFeishuBridge\instances\codex-assistant-1\state\bridge.pid"
Get-Process node
lark-cli event status --json
```

常见问题：

| 现象 | 处理 |
|---|---|
| 飞书没回复 | 先发 `/status`；再看 `bridge.stderr.log` 和 `lark-cli event status --json` |
| `lark-cli not found` | 重新执行 `npm install -g @larksuite/cli`，并确认新 PowerShell 能找到 `lark-cli` |
| `codex` 找不到 | 优先确认官方 Microsoft Store 版 `OpenAI.Codex` 已安装；如需使用其他 CLI，再设置 `CODEX_CLI_BIN`，或把 `codex.exe`/`codex.cmd` 加入 PATH |
| `/list` 只显示默认会话 | 确认 `%USERPROFILE%\.codex\state_5.sqlite` 存在，并确认 `python --version` 或 `sqlite3 --version` 至少一个可用 |
| 机器人收到消息但 Codex 不动 | 检查 Codex 登录状态、`%USERPROFILE%\.codex\auth.json`、workspace 是否可信 |
| 以 `/你好` 开头没有正常回答 | 这是命令解析；普通任务不要用 `/` 开头 |
| watchdog 反复重启 | 看 `watchdog.log` 里 consumer 或 bridge 失败原因 |

## 安全边界

这个桥接器会让能给机器人发消息的人触发本机 Codex 执行。它默认使用 `danger-full-access`，适合个人私有、可信群聊和专用机器，不适合公开群或陌生人可访问的机器人。

建议：

- 每个机器人只加入可信会话。
- 给桥接器使用专用 workspace。
- 不要把飞书 app secret、Codex auth、日志、sessions、附件提交到 GitHub。
- 不要在公共仓库 issue 或截图中暴露二维码注册结果、app id/app secret、token。
- 多人使用前，先明确谁有权让本机执行命令和读写文件。

## 更新项目

在目标设备上更新：

```powershell
Set-Location "$env:USERPROFILE\Documents\Codex\tools\codex-feishu-bridge"
git pull
npm install
npm run check
.\stop-codex-feishu-bridge.ps1 -Name codex-assistant-1
.\start-codex-feishu-bridge.ps1 -Name codex-assistant-1 -LarkProfile codex-assistant-1 -Workspace "$env:USERPROFILE\Documents\Codex\workspaces\feishu-bridge-codex-assistant-1"
```

## 发布到 GitHub 前检查

```powershell
git status --short
rg -n "app_secret|tenant_access_token|user_access_token|authorization|bearer|\\.lark-cli|\\.codex|AppData|<your-windows-user>" .
npm run check
```

确认没有 secrets、日志、附件和个人状态文件后再提交和推送。
