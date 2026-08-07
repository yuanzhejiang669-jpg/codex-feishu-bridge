# 桌面客户端与高级控制

桌面客户端是推荐的本机管理入口。它把 Bot、工作空间、Provider、MCP / Skills、更新和兼容性检查放在同一个应用里，不要求用户保持终端窗口或单独启动网页服务。

![桌面客户端总览](assets/desktop/overview.png)

## 六个页面

- **总览**：查看 Codex 环境、在线 Bot、活动任务和检测结果。
- **Bot**：新建或接管 Bot，检查状态，启停或安全重启。安全重启会避开活动任务；强制重启需要用户明确选择。
- **工作空间**：创建垂类空间和 Bot 队列，逐个扫码注册，查看已有空间并执行受保护的删除。
- **Provider**：查看全局 Provider、添加并实测第三方 API、管理空间默认模型来源和推理档位。
- **MCP / Skills**：比较全局 Codex Home 与目标空间，选择性迁移能力。
- **系统**：检查客户端更新，设置登录启动和关闭到托盘，查看内置运行时兼容性。

![Bot 管理](assets/desktop/bots.png)

## 运行方式

安装后从开始菜单或桌面图标打开客户端即可。关闭窗口时，如果“关闭到托盘”已启用，客户端和已启用 Bot 会继续运行；不需要让命令行永久常驻。

客户端管理的 Bot 数据与旧脚本 runtime 隔离。接管旧 Bot 时，客户端会先检查活动任务；可以安全接管的实例才会停用旧 watchdog 并转入客户端管理。

## 更新

“系统”页从 GitHub Releases 检查稳定版。客户端可以后台下载更新，但只有在没有活动任务时才进入安装；重启后会恢复升级前启用的 Bot。macOS 未签名测试包暂不支持客户端内自动安装。

![系统与更新](assets/desktop/system.png)

## 高级网页控制面板

仓库仍保留旧网页控制面板，供源码开发、底层诊断和旧脚本部署使用：

```powershell
npm install
npm run panel
```

默认地址：

```text
http://127.0.0.1:8320/
```

也可以运行 `start-control-panel.ps1`。网页面板读取 `bridge.instances.local.json` 和旧 runtime，不等同于桌面客户端的数据层；普通安装用户不需要同时运行两套管理界面。

旧配置加载顺序：

1. `CODEX_FEISHU_INSTANCES_CONFIG` 指向的文件
2. 仓库根目录 `bridge.instances.local.json`
3. 仓库根目录 `bridge.instances.json`
4. 内置 fallback

## 单 Bot 脚本模式

仅在维护旧部署或调试源码时直接启动：

```powershell
powershell.exe -NoProfile -File .\start-codex-feishu-bridge.ps1 `
  -Name codex-assistant-1 `
  -LarkProfile codex-assistant-1 `
  -Workspace "$env:USERPROFILE\Documents\Codex\workspaces\feishu-bridge-codex-assistant-1" `
  -CodexHome "$env:USERPROFILE\.codex"
```

停止：

```powershell
powershell.exe -NoProfile -File .\stop-codex-feishu-bridge.ps1 -Name codex-assistant-1
```

脚本模式可安装 Windows 计划任务 watchdog，但它不应与同一个 Bot 的客户端管理同时启用。

## 安全边界

客户端和网页控制面板只管理本机文件与进程。它们不会删除飞书聊天记录，也不会自动删除飞书开放平台中的应用。删除 Bot、Provider 或空间前会生成预览，并对活动任务、路径边界和确认文本进行检查。
