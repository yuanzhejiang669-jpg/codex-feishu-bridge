# Codex CLI 优先后端：执行记录

## 2026-09-08 开始

- 用户授权：规划、实现、记录、正式发布，以及当前 Windows、旧 Windows、Mac、Ubuntu 的 CLI/Bridge 更新与安全重启。
- 已阅读项目 AGENTS.md、发布流程、设备迁移及平台适配、安全 PowerShell 调用要求。
- 当前源码：`C:\Users\yzjiang\Documents\Codex\tools\codex-feishu-bridge`；origin 为 `yuanzhejiang669-jpg/codex-feishu-bridge`。
- 初始桌面 package.json 为 0.9.0。尚未改运行代码，尚未更新任何设备。
- 检测到既有用户改动，必须保留且不得默默包含入本次发布：`scripts/smoke-formula-renderer.mjs`、`src/feishu/cards/formula-renderer.mjs`、`start-mimo2codex-proxies.ps1`、`test/formula-renderer.test.mjs`；未跟踪 `.codex-work/`、`creative-preset-adapter/`、`test/formula-layout.test.mjs`。
- 初步定位：桌面环境探测、supervisor、PowerShell 启动器、`src/codex/runtime-version.mjs`。现有 App Server 对接保留。
- 设备登记脚本存在 Ubuntu 缺少 `tailscale_dns_name` 时抛错的问题，前次已用只读探测绕过；不在本次修复范围。

## 状态

### 基线与独立工作区

- 官方 npm latest = 0.153.4；0.154.0-alpha.6 不是稳定版。GitHub stable = v0.8.20。
- 原目录实际在 wip/pi-agent-integration（759df23），因此新建独立工作区 `C:\Users\yzjiang\Documents\Codex\tools\codex-feishu-bridge-cli-backend`，从 origin/main 2579be0 开始，分支 feat/cli-backend。保留原目录及原记录，不覆盖 Pi 开发工作。
- 当前 Windows 已安装 0.8.20；Mac 已安装 0.8.19，SSH/Doctor 均通过；Ubuntu SSH 通过，但 ~/.local/bin/codex 是依赖未进入 SSH PATH 的 Node 的 npm 启动器。
- Mac 源码 main ahead 1 且 .gitignore 已修改，不能强制覆盖；Ubuntu 为独立 Linux 发行分支，不能直接安装 Windows/macOS 发行物。
- 新增完整布局 CLI 解析器，桌面每次启动重新解析，保留 App Server 协议；新增握手运行版本记录与系统页展示。初测解析器/环境探测 12 项通过；supervisor 测试因新工作区尚缺 smol-toml 未能运行，正在安装依赖后重测。
- 新工作区执行 npm ci，产生根目录及 apps/desktop/node_modules 与 npm 安装缓存；两份文档在新工作区保留正式后续记录。

进行中：基线与调用链核查。尚未发布/安装/重启；不得据此报告任务完成。

## 文件登记

### 实现与验证（发布前）

- 预定稳定版 0.8.21，基于正式 0.8.20，不包含 Pi 分支。
- 根检查 123/123；桌面检查 193 通过、3 平台跳过；追加逐次重启重新解析测试后 supervisor 25 通过、2 平台跳过。
- 独立 npm CLI 本机解析到完整 vendor 布局中的 bin/codex.exe（0.153.4），App Server initialize 实测成功并正常关闭。
- Mac 直连官方完整包 45 秒仅收到 335366 字节并超时；改从本机下载并 SCP，不启用网络代理。
- 官方完整包 SHA256：Mac arm64 35438da1fbf7a6db7ddb3bcec84448fa6015ba188461472a97d9d1da7d9c4353；Linux x64 a822187e1a2420c61c5926721bfbd878701ed95547c9bb0d4de4498a16ba1821。
- 旧 Windows 切换正确 Tailnet 后 Doctor 首次握手失败，后续 hostname 成功确认 DESKTOP-NV7373U；已恢复 hotmail Tailnet。
- 产物新增：新工作区 .codex-work/cli-upgrade 中两份官方完整 tar.gz 与 codex-package_SHA256SUMS；Mac /tmp/cfb-cli-upgrade.XYakJW/codex.tar.gz；Ubuntu /tmp/cfb-cli-upgrade.86CowP/codex.tar.gz（传输中）。npm 检查生成 apps/desktop/generated/engine、proxy-runtime/node_modules 与兼容补丁；测试的临时 cfb-* 目录由测试 finally 清理。

- 新增本规划与执行记录两份 Markdown；后续每个阶段追加实际修改、验证和产物。
