# 配置与安全边界

本项目适合开源代码和脚本，但不适合公开本机运行数据。开源前必须把“示例配置”和“真实配置”分开。

## 可以提交

- Bridge 源码
- 控制面板源码
- PowerShell 启动、停止、watchdog、doctor 脚本
- `.env.example`
- `bridge.instances.json` 示例配置
- README、docs、LICENSE

## 不应提交

- `.env`、`.env.*`
- API key、token、app secret、cookie
- `.lark-cli/`
- `.codex/`
- 真实 `config.toml`
- `bridge.instances.local.json`
- `state/`、`logs/`、PID、lock、active-runs
- 二维码、授权页面、注册日志
- Codex `state_5.sqlite`
- `sessions/**/rollout-*.jsonl`
- 附件和真实 workspace 内容

## 本机实例配置

公开仓库提交的 `bridge.instances.json` 只保留示例路径。真实配置放在：

```text
bridge.instances.local.json
```

这个文件已加入 `.gitignore`。控制面板会优先读取它，新增或卸载 Bot 时也会写回这个本地配置文件。

## 密钥策略

Provider 配置推荐只写：

```toml
[model_providers.example]
name = "example"
base_url = "https://api.example.com/v1"
wire_api = "responses"
env_key = "EXAMPLE_API_KEY"
```

真实 key 写入 Windows 用户环境变量，不写进 Git 仓库：

```powershell
[Environment]::SetEnvironmentVariable('EXAMPLE_API_KEY', '<your-key>', 'User')
```

写入后需要重启 Bridge 实例，让新环境变量进入进程。

## 发布前检查

建议至少执行：

```powershell
npm run check
git status --short
git diff --cached --stat
```

再搜索敏感内容：

```powershell
Get-ChildItem -Recurse -File |
  Where-Object { $_.FullName -notmatch '\\.git\\|node_modules\\|\\.codex-feishu-runtime\\|\\.codex-feishu-attachments\\' } |
  Select-String -Pattern 'sk-[A-Za-z0-9_-]{8,}|fc-[A-Za-z0-9_-]{8,}|app_secret|token|api[_-]?key|C:\\Users\\<your-real-user>'
```

如果命中示例文字，要人工确认是否只是文档说明；如果命中真实 key、真实 profile secret、二维码或运行态路径，不要提交。
