# Windows Setup

本页是 README 的拆分版部署清单。完整安装说明和“发给旧设备 Codex 的提示词”以仓库根目录 `README.md` 为准。

## 1. 安装依赖

```powershell
node -v
npm -v
git --version
codex --version
python --version
npm install -g @larksuite/cli
lark-cli --version
```

如果 `codex --version` 不可用，先定位 `codex.exe` 或 `codex.cmd`，再设置：

```powershell
$env:CODEX_CLI_BIN = "C:\Path\To\codex.exe"
```

`/list` 要显示本机 Codex 侧边栏已有会话，需要能读取 `%USERPROFILE%\.codex\state_5.sqlite`。桥接器优先使用 `sqlite3` CLI；没有 `sqlite3` 时会自动使用 Python 3 标准库。

## 2. 克隆仓库

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\Documents\Codex\tools" | Out-Null
git clone <REPO_URL> "$env:USERPROFILE\Documents\Codex\tools\codex-feishu-bridge"
Set-Location "$env:USERPROFILE\Documents\Codex\tools\codex-feishu-bridge"
npm install
npm run check
```

## 3. 推荐注册方式

```powershell
.\register-codex-feishu-bot.ps1 `
  -Name codex-assistant-1 `
  -DisplayName "Codex Assistant 1" `
  -Workspace "$env:USERPROFILE\Documents\Codex\workspaces\feishu-bridge-codex-assistant-1" `
  -RunMode app-server `
  -Reasoning xhigh `
  -CodexTimeoutSeconds 7200 `
  -InstallStartup
```

扫码完成后，在飞书发送：

```text
/status
```

再发送普通消息验证。普通任务不要以 `/` 开头。

## 4. 手动启动

```powershell
.\start-codex-feishu-bridge.ps1 `
  -Name codex-assistant-1 `
  -LarkProfile codex-assistant-1 `
  -Workspace "$env:USERPROFILE\Documents\Codex\workspaces\feishu-bridge-codex-assistant-1" `
  -RunMode app-server `
  -Reasoning xhigh `
  -CodexTimeoutSeconds 7200
```

停止：

```powershell
.\stop-codex-feishu-bridge.ps1 -Name codex-assistant-1
```

## 5. 看门狗

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
