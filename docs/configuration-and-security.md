# 配置与安全边界

公开源码、桌面客户端数据和真实运行凭据必须分开。普通用户应在客户端内完成配置，不要把真实配置复制回仓库。

## 三类数据

### 可以提交

- Bridge 与桌面客户端源码
- PowerShell 启停、watchdog 和 doctor 脚本
- `.env.example` 与 `bridge.instances.json` 示例
- 不含真实身份、路径和凭据的公开截图与文档

### 仅保留在本机

- 客户端版本化状态、Bot 定义、工作空间队列和运行日志
- `bridge.instances.local.json` 等旧脚本实例配置
- `.lark-cli/`、`.codex/`、真实 `config.toml`
- Codex 数据库、rollout、附件和真实 workspace 内容

### 必须作为秘密处理

- API key、token、App Secret、cookie
- 飞书授权二维码和授权页面
- Provider 凭据、MCP token 和浏览器控制 token

## 桌面客户端凭据

客户端管理的第三方 Provider key 不以明文写入仓库。Windows 使用 DPAPI，macOS 使用 Keychain 支持的凭据存储。配置页和日志只显示 Provider ID、环境变量名或可用状态，不应回显完整密钥。

新增 Provider 时先执行客户端提供的最小真实 API 测试，成功后再保存和分配。删除 Provider 前会检查是否仍被 Bot、空间或其他配置引用。

## 旧脚本实例配置

公开仓库的 `bridge.instances.json` 只保留示例。真实配置放在：

```text
bridge.instances.local.json
```

它已加入 `.gitignore`。旧网页控制面板和脚本优先读取该文件。不要让同一个 Bot 同时由旧 watchdog 和桌面客户端管理。

旧 Provider 配置推荐只保存引用：

```toml
[model_providers.example]
name = "example"
base_url = "https://api.example.com/v1"
wire_api = "responses"
env_key = "EXAMPLE_API_KEY"
```

真实 key 放入用户环境变量或客户端凭据存储，不写进 Git。旧 Bridge 进程需要重启才能读取新环境变量。

## 截图发布

文档截图必须使用不可逆实色覆盖，不能只模糊。至少遮挡：用户名、完整本地路径、真实 Bot/空间名称、PID、私有域名、环境变量、Provider ID 和二维码。

本仓库用于当前公开截图的脚本：

```powershell
node .\scripts\redact-documentation-screenshots.mjs <截图目录> .\docs\assets\desktop
```

脚本不会把原始截图复制进仓库；它校验来源尺寸，并对输出遮挡区域做像素抽样检查。

## 发布前检查

```powershell
npm run check
git status --short
git diff --cached --stat
```

再搜索敏感内容：

```powershell
Get-ChildItem -Recurse -File |
  Where-Object { $_.FullName -notmatch '\\.git\\|node_modules\\|\\.codex-feishu-runtime\\|\\.codex-feishu-attachments\\' } |
  Select-String -Pattern 'sk-[A-Za-z0-9_-]{8,}|fc-[A-Za-z0-9_-]{8,}|app_secret|C:\\Users\\<your-real-user>'
```

示例关键字可能合法命中，必须人工复核；真实 key、二维码、profile secret 或本机路径一律不得提交。
