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

进行中：正式发布与分设备部署。运行源码已提交推送，尚未完成全部安装/重启；不得据此报告任务完成。

### 代码交付与 CLI 部署

- 正式分支已推送 f0e8669、0ecb8b1，标签 v0.8.21；GitHub Actions 34226762444 正在 Windows/macOS 构建。
- Linux 独立工作区 `C:\Users\yzjiang\Documents\Codex\tools\codex-feishu-bridge-cli-linux`，从原 Linux 分支合入两项提交（54e0ec8、d3e5bfc）；保留全部 Linux 支持并解决版本/探测合并冲突。桌面测试 213 通过、3 平台跳过；标签 v0.8.21-linux.1 已推送。
- 本机 Windows CLI 已是稳定 0.153.4，无需重复覆盖安装；所有现有 Bot 的 Provider 配置仅计算 SHA256，未改动内容。26 个客户端 Bot 中当前对话 Bot 有活动任务，不能现在安装重启。
- Ubuntu 完整官方 CLI 已经校验 SHA256 后安装到 `/home/yzj666/.local/share/codex-cli/0.153.4`，`/home/yzj666/.local/bin/codex` 指向其中 bin/codex；不依赖 SSH PATH 中的 Node，实测两处均返回 0.153.4。旧 npm 安装未删。
- Ubuntu 5 个 Bot 均在线且当前空闲，Provider config SHA256=22b5686e51443907d927c97e804157fea2dacc899bda3d4e924e6a3193caa36f。
- Mac SCP 速度极慢且 SSH 间歇超时，已取消该 SCP；官方 npm Registry 直连可下载，正在续传完整 darwin-arm64 包。安装前必须用 npm 官方 dist.integrity 验证，未安装半包，未改代理。

### 对抗性审查

### 部署进展（20:52）

- GitHub v0.8.21 正式发布成功，Linux v0.8.21-linux.1 亦发布成功。Windows 安装包 SHA256=49176b96f31fcb9ab068674e360522dbb40ba9440ee885490a7f58b0346b91d4，Mac arm64 ZIP=c32d067b2f9964b0e0f58dd0bb707b4851201c16242eb4063f142eb259356ff4，Ubuntu DEB=17ada0c5c98dabaacc59c4d2dde4c96f5e54cf3d62258db92eabdd4a157b3f3d。
- Mac 官方 npm 平台包经 SHA512 dist.integrity 校验，完整安装在 `/Users/cathyhuang/.local/share/codex-cli/0.153.4/package/vendor/aarch64-apple-darwin`；`/Users/cathyhuang/.local/bin/codex` 入口验证为 0.153.4。未修改系统代理。Bridge ZIP 直连及 SCP 很慢，改用公开发行物下载镜像，仍必须匹配官方 SHA256 才安装。
- Ubuntu 已通过官方 DEB 升级为 0.8.21~linux.1，5 个 Bot 全部更换 PID 并恢复在线，全部配置哈希不变。新进程环境明确是 installed-cli，路径 `/home/yzj666/.local/share/codex-cli/0.153.4/bin/codex`；事件监听 ready，公式预热成功。正常 GUI 由用户 systemd 临时服务 cfb-upgrade-launch-0821 启动，不带 --background，脱离 SSH 仍存活。
- Ubuntu 首次退出保护检查因进程标题重写而拒绝执行，未停止 Bot；改用 /proc/PID/exe 校验后安全退出并成功安装。恢复标记与自动启动同时尝试时出现一次重复实例拒绝日志，状态目录锁成功保护，实际每个 Bot 仅一个主进程。
- 当前 Windows 已登记并启动 InteractiveToken 计划任务 CodexFeishuBridge-Upgrade-0821，等待所有 Bot 连续空闲后安装。现在不能标记本机已经升级；结果写入 `C:\Users\yzjiang\AppData\Local\CodexFeishuBridgeDesktop\pending-upgrades\cli-0.8.21\upgrade-result.json`。
- 新增部署工具 `.codex-work/deploy-guard.cjs`、`.codex-work/upgrade-windows.ps1`；当前 Windows pending-upgrades/cli-0.8.21 内有 helper、已验证 installer.exe，运行时生成 upgrade.log、before.json、upgrade-result.json。Ubuntu临时目录增加 bridge.deb、deploy-guard.cjs、before.json、before-retry.json；安装器生成/替换 /opt/Codex Feishu Bridge 全套应用文件及 dpkg 标准状态。Mac临时目录新增 install-mac-cli.sh、bridge.zip/bridge-direct.zip 未完成下载、bridge-mirror.zip 与 download.log。

### 对抗性审查验证条目

- 0.8.22 发布前复测：核心检查126/126；桌面195通过、3平台跳过。初始化锁保护只针对普通文件，保留目录型损坏锁原有明确报错行为；现有架构边界测试与新增竞争测试均通过。

- Mac 最终恢复 6/6，两个空间模型调用返回 OK，配置哈希不变，正常 GUI 持续运行。文稿权限弹窗已解除；不再需要用户重复点击。
- 恢复后进程级复核发现 codex-assistant-1 额外进程70721，原所有者70720仍正常。确认 active-runs 为空、进程命令和所有者匹配后，只向70721发送 SIGTERM，保留70720及浏览器 MCP 9840。
- 定位到真实并发启动漏洞：现有单实例锁要求 bridge.pid 同时存在，但 bridge.pid 是拿到锁后才写，留下竞争窗口；空的刚创建锁也会被误删。补充每个 Bot 启动 Promise 互斥、活锁不依赖后写 PID 文件、刚初始化锁不允许删除。对应四种情形回归通过（supervisor+锁共30通过、2平台跳过）。为让正式安装包也包含修复，将补发0.8.22/0.8.22-linux.1，不覆盖0.8.21资产，不采用本机热补丁冒充正式升级。当前本机待安装任务先暂停，待更新为最新包后恢复。

- Mac 完整安装包已正常替换到 `/Applications/Codex Feishu Bridge.app`，0.8.21 进程 PID67486 持续运行，旧应用为 `/tmp/cfb-cli-upgrade.XYakJW/previous.app`（安装回滚用途）。六个旧 Bot 在替换前确认空闲并通过停止文件退出，没有强杀任务。
- Mac 的发布流程明确为 unsigned/unnotarized，因此不能拿 Developer ID 严格签名作为该发行渠道存在的属性。安装前官方 ZIP SHA256、版本、arm64 主程序、完整 engine 和 Node/lark 工具检查通过；没有重签应用、移除 quarantine、关闭 Gatekeeper 或修改 TCC 数据库。
- Mac 新应用启动被系统“访问文稿文件夹”确认拦住，六个 Bot 尚未恢复，不能报告 Mac 已完成。已通过屏幕确认并请求用户在 Mac 点允许；精确匹配提示的 AppleScript 未找到可点击 AX 节点，未点击任何其他权限弹窗。SSH 本机到 Mac 路径超时，改用同 Tailnet 的 Ubuntu 作为 SSH ProxyJump，未启用网络代理或修改两台设备的代理配置。
- Mac 两个空间的独立 CLI initialize/model-list/最小请求均返回 OK。SSH 会话的 launchctl getenv 与 GUI bootstrap 域不同，初测误判凭据缺失；验证 helper 改为仅在 Mac 本地读取既有 secrets.env 对应 env_key 的 base64 值传给测试子进程，未写回/更换凭据、未将凭据复制到其他设备。
- 新增 `.codex-work/upgrade-mac.sh`、`inspect-runtime.cjs`、`allow-bridge-documents.applescript`、`inspect-mac-prompt.applescript`、`inventory-artifacts.cjs`，Mac tmp 同名副本。诊断截图 desktop-check.png、desktop-small.jpg、prompt-current.jpg 及本机 mac-* 副本仅供此次启动诊断。完整本地产物清单为 `.codex-work/cli-upgrade/local-artifact-files.txt`，已枚举新 worktree、构建/依赖和本机升级目录文件。

- 21:08 旧 Windows 最终验证完成：0.8.21.0，17/17 Bot 在线且日志为独立 npm native CLI，17 项配置哈希全部保持。两个配置空间 initialize/model-list/最小回复均成功，源码 npm run check 123/123。最终记录是 `C:\Users\12644\AppData\Local\CodexFeishuBridgeDesktop\pending-upgrades\cli-0.8.21\final-verification.json`；早期 upgrade-result.json 的 failed 作为历史保留，不代表最终状态。计划任务已注销。
- 旧 Windows 陈旧 PID=6480 实际属于 WLANExt.exe。核对 lock.startedAt=1787582824419 后，仅删除 codex-assistant-old-baike-5/state/bridge.pid 和 bridge.lock.json 两个失效运行标记；未停止 WLANExt，原会话未删。Bot 后续自动恢复为 PID11892。自动恢复分批进行，因此把部署验证等待窗口加长到按 Bot 数量计算，避免 17/26 Bot 被过短超时误报失败。
- 已取回旧 Windows final-verification、cli-verification 到本机 `.codex-work/cli-upgrade/oldpc-*.json`。新增 helper inspect-oldpc-locks.ps1、inspect-stale-oldpc.ps1、repair-stale-oldpc.ps1、final-verify-oldpc.ps1 及其旧机 Temp 副本。
- Mac 完整 ZIP 最终大小 238675484，SHA256 与官方一致；开始使用已验证安装包替换应用。此时恢复了原 hotmail Tailscale 账号。

- Ubuntu App Server initialize、model/list 和 ephemeral 最小回复均通过，输出 OK；结果文件 `/tmp/cfb-cli-upgrade.86CowP/cli-verification.json`。已克隆可持续更新的 Linux 源码仓库到 `/home/yzj666/Codex/tools/codex-feishu-bridge-cli-backend`，分支 linux/ubuntu-client，保留原无 Git 的构建目录。
- Mac 原 origin 使用 SSH 时 GitHub 主机密钥检查失败，未绕过校验；改为明确 HTTPS fetch 后新增 worktree `/Users/cathyhuang/Documents/Codex/tools/codex-feishu-bridge-cli-backend`（deploy/cli-backend-0821，0ecb8b1），原 main 本地提交和 .gitignore 改动不变。

- 本机独立 npm native CLI 已对五个配置空间逐一执行 initialize、model/list 和不持久化会话的最小回复，全部返回 OK；使用只读沙箱，测试调用临时禁用 MCP 启动但不修改 config.toml。初版测试 helper 的 MCP 表名正则误匹配 .env 子表，已修正后重测；该错误只影响测试命令覆盖项，未写入任何用户配置。
- 旧 Windows CLI 从 0.136.0 升级为 0.153.4；源码 main 从 7493623 快进至 0ecb8b1，原有三处 Browser Control/Tavily 修改完整保留。正式 EXE 直连下载并核验成功。
- 旧 Windows 部署曾因旧 PID 文件恰好对应存活的其他进程而退出等待超时；未强杀该进程。部署 helper 增加 node 进程名和 PID 文件时间/进程启动时间一致性检查，并增加异常后正常重新打开客户端的恢复逻辑。首次结果记录 failed，不将其当成升级成功；正在重试。初始“17 在线”属于仅按 PID 存活的粗略盘点，不能据此认定旧记录对应的 Bot 真实在线。
- 新增 `.codex-work/prepare-oldpc.ps1`、`schedule-oldpc.ps1`、`verify-oldpc.ps1`、`inspect-oldpc-upgrade.ps1`、`verify-cli.mjs`；相应旧 Windows Temp helper、副本 pending-upgrades/cli-0.8.21、安装包与执行日志已生成。本机验证结果为 `.codex-work/cli-upgrade/local-cli-verification.json`（继承旧显式路径的初测）、`local-native-cli-verification.json`（最终独立 CLI 五空间成功结果）。

1. 三个月后 PATH/包布局漂移：npm shim 解析成保留目录结构的 native entry，校验 manifest 声明目录及路径不能逃逸；破损显式路径禁止静默换后端。对应回归已通过。
2. 三个月后磁盘升级但后端仍旧：每次启动重新探测；运行版本来自真实 initialize userAgent，以 Bridge PID/后端存活过滤；不以磁盘 --version 替代运行版本。重复启动重新探测及损坏/旧 PID 状态测试通过。
3. 三个月后新 CLI 无法启动导致 Bot 全停：批量重启先探测新后端，失败不停止任何 Bot；保留空闲检查、逐项启动与失败恢复。补充回归通过。Electron 开发模式 resourcesPath 误指安装资源的问题也已修复并复测。

### 本阶段产物登记

- 两个独立 Git worktree、其源码/文档/依赖目录、桌面 generated/engine、proxy-runtime/node_modules、resources/icon.ico、out 下安装包、blockmap、latest.yml、checksums、win-unpacked、latest 兼容副本。
- `.codex-work/device-inventory.cjs` 和 `.codex-work/install-posix-cli.sh`；Ubuntu `/tmp/cfb-cli-upgrade.86CowP` 内对应 helper 与 codex.tar.gz。
- Ubuntu `/home/yzj666/.local/share/codex-cli/0.153.4` 完整目录及 `/home/yzj666/.local/bin/codex` 链接。
- Mac `/tmp/cfb-cli-upgrade.XYakJW/codex.tar.gz` 未完成旧传输；`codex-npm.tgz` 续传中；完成验证后清理临时文件。

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
