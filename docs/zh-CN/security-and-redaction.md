# 安全与脱敏边界

本仓库可以记录 Bridge 源码、架构、部署形态、路径模式和脱敏后的设备清单，但不能记录密钥、运行日志、会话正文、数据库或可恢复私有内容。

## 可以进入仓库

| 类型 | 示例 |
|---|---|
| Bridge 源码 | `codex-feishu-bridge.mjs`、启动脚本、注册脚本、watchdog 脚本 |
| 控制面板源码 | `control-panel.mjs`、`control-panel\index.html`、`control-panel\app.js`、`control-panel\styles.css`、`doctor-codex-feishu-bridge.ps1`、`bridge.instances.json` |
| 部署说明 | 如何安装 Node、lark-cli、Codex、watchdog |
| 架构说明 | Workspace、Codex Home、Desktop Codex Home 的关系 |
| 脱敏清单 | 实例名、路径模式、工具链版本、MCP 名称 |
| 安全规则 | 哪些文件不应提交、排查时如何避免泄露 |

## 不要进入仓库

| 类型 | 示例 |
|---|---|
| 飞书凭据 | app secret、access token、tenant token、二维码授权结果 |
| `lark-cli` 私有配置 | `%USERPROFILE%\.lark-cli\config.json` |
| Codex 凭据 | `.codex\auth.json` |
| Codex 数据库 | `.codex\*.sqlite`、`.sqlite-wal`、`.sqlite-shm` |
| Codex 会话状态 | `sessions\`、`session_index.jsonl`、`.codex-global-state.json` |
| Bridge runtime state | `%LOCALAPPDATA%\CodexFeishuBridge\state`、`instances\*\state` |
| Bridge 日志 | `%LOCALAPPDATA%\CodexFeishuBridge\logs`、`instances\*\logs` |
| 控制面板运行状态 | `%LOCALAPPDATA%\CodexFeishuBridge\control-panel\state`、`%LOCALAPPDATA%\CodexFeishuBridge\control-panel\logs` |
| 附件和输出 | `.codex-feishu-attachments`、`.codex-feishu-runtime` |
| 私有内容 | 聊天原文、prompt、截图、二维码、附件、客户文件 |

## 路径写法

可以写路径模式：

```text
%LOCALAPPDATA%\CodexFeishuBridge\instances\<Name>\state
%USERPROFILE%\Documents\Codex\workspaces\feishu-bridge-<Name>
```

也可以在设备清单中记录已经公开脱敏的绝对路径，用于排查拓扑。但不要把路径旁边的私有文件内容复制出来。

## 发布前检查

运行：

```powershell
git status --short
npm run check
```

搜索常见敏感词：

```powershell
rg -n "app_secret|tenant_access_token|user_access_token|authorization|bearer|\\.lark-cli|\\.codex|auth.json|session_index|state_5|logs_2|bridge.stdout|bridge.stderr" .
```

如果没有 `rg`：

```powershell
Get-ChildItem -Recurse -File | Select-String -Pattern "app_secret|tenant_access_token|user_access_token|authorization|bearer|\\.lark-cli|\\.codex|auth.json|session_index|state_5|logs_2|bridge.stdout|bridge.stderr"
```

## 控制面板的特殊边界

控制面板源码可以进入公开仓库，因为它只包含展示逻辑、路径模式、实例名、端口和计划任务名。`bridge.instances.json` 也可以进入仓库，但必须保持非密钥化：只能包含设备标识、路径、Bot 名称、workspace、Codex Home、端口、URL、计划任务名。

控制面板运行时产生的 PID、日志、自检输出、最近错误片段和任何从真实日志中截取的内容，不应提交到 GitHub。控制面板添加 provider 时只能写入 `env_key` 字段名，不能把真实 API key 写入 `config.toml`、文档或截图。

## inventory 仓库的后续处理

`new-device-codex-feishu-bridge-inventory` 和 `old-device-codex-feishu-bridge-inventory` 可以保留为历史快照，但后续不建议继续作为主要事实源。新增或修正文档时，优先改本仓库的 `docs/zh-CN/`。

如果需要归档 inventory 仓库，建议在它们的 README 顶部加一句：

```text
本仓库已停止作为主要文档源。最新中文说明请查看 codex-feishu-bridge 主仓库的 docs/zh-CN/。
```

## 权限修复记录要求

如果为了推送或读取仓库而新增、删除或更换 GitHub SSH key、GitHub token、remote URL、credential helper 或 SSH config，必须更新：

- `README.md` 的“检查后的更新规则”是否仍准确。
- 本文件的安全边界和禁止提交范围。
- 对应设备 inventory 中的 GitHub/SSH 权限说明，旧设备写入 `old-device-inventory.md`，新设备写入 `new-device-inventory.md`。

只记录公钥标题、用途、fingerprint 和配置位置；不要记录私钥内容、token、验证码、cookie 或浏览器会话信息。
