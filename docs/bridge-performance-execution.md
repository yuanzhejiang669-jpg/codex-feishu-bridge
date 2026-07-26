# Codex Feishu Bridge 极致响应改造执行记录

状态：阶段一已发布；本机空闲后升级任务已安排
目标版本：Desktop `0.8.2`
开始时间：2026-07-27

## v0：基线审计

完成事项：

- 确认源码仓库、`origin/main` 与工作树干净。
- 阅读项目发布与设备同步规则。
- 确认普通消息当前串行等待 CardKit 后才启动 Codex。
- 确认 app-server 在普通任务、Goal、压缩和配置请求后都会关闭。
- 确认当前事件去重使用持久化 `seen-events.json` 和跨实例事件锁，但没有启动时间水位线。
- 确认默认消息并发为 1；设计改为独占 app-server 租约池，避免直接共享 stdio 通知。
- 确认 Desktop 当前版本为 `0.8.1`，本次计划升级为 `0.8.2`。

验证：

- 仓库：`C:\Users\yzjiang\Documents\Codex\tools\codex-feishu-bridge`
- 分支：`main`
- 初始状态：与 `origin/main` 一致且无未提交文件

下一步：

- 实现热租约池、事件水位线和卡片/Codex 并行启动。
- 补充自动化测试与配置说明。

## v1：阶段一核心实现

完成事项：

- 新增 app-server 独占热租约池：
  - 普通任务完成后默认保留 15 分钟。
  - 池大小默认跟随 Bridge 消息并发数。
  - 同一 stdio 客户端不会同时租给两个任务。
  - 初始化结果随进程缓存，热会话不重复 `initialize`。
  - 失败、恢复重试、关闭和空闲超时会安全丢弃对应进程。
- 普通消息的 CardKit 打开与 Codex 启动改为并行：
  - 卡片未就绪期间持续保留最新运行状态。
  - 卡片打开后立即追平最新状态。
  - 卡片失败继续走原有 Markdown 兜底。
- 新增启动事件水位线：
  - 默认允许启动前两分钟内的消息继续处理。
  - 更早的积压消息被持久化标记并跳过。
  - 无时间戳消息不做猜测，沿用原处理路径。
- 新增 app-server 跨租约通知清理和 thread/turn 归属过滤。
- 在并行打开卡片之前先登记 active run，防止卡片尚未返回时被更新器或 watchdog 误判为空闲。
- 新增热池、事件时间解析、租约互斥和关键路径顺序自动化测试。
- 更新环境变量示例与 README 性能说明。

新增配置：

- `CODEX_FEISHU_APP_SERVER_IDLE_TTL_MS`，默认 `900000`。
- `CODEX_FEISHU_APP_SERVER_POOL_SIZE`，默认跟随 `CODEX_FEISHU_MAX_CONCURRENT`。
- `CODEX_FEISHU_EVENT_REPLAY_GRACE_MS`，默认 `120000`。

验证：

- Bridge 主文件与新增模块语法检查通过。
- 定向架构测试：29 项通过。
- 根项目完整检查：74 项通过，0 失败。
- 真实 Codex `0.145.0` 热池 smoke：
  - 冷初始化 `170ms`。
  - 第二次租约复用同一 PID。
  - 热初始化 `0ms`。
- Desktop `0.8.2` 测试：184 项中 181 通过、3 项平台跳过、0 失败。

下一步：

- 运行真实 app-server smoke test。
- 升级 Desktop 版本并完成 Desktop 全套测试与 Windows 打包。

## v2：Windows 构建与 GitHub 发布

完成事项：

- Desktop 版本从 `0.8.1` 升级到 `0.8.2`。
- Windows x64 NSIS 安装包、blockmap、`latest.yml` 和 SHA-256 清单构建完成。
- 打包 Engine 的源码提交：`1d7a157ddd39c43790bf3d9103f0837991cc41d5`。
- 源码已推送到 `origin/main`。
- 稳定标签与 Release：`v0.8.2`。
- GitHub Actions `Release Windows Desktop Client` 构建成功。
- 最终 GitHub Release 资产重新下载并逐项校验：
  - 安装包大小：`169750343` bytes。
  - 安装包 SHA-256：`0c26fd3e4a618db07466f01747f04ad13e1966907143c50a7f7fed0c5721a7c2`。
  - blockmap SHA-256：`f3d61eb875ac434da571f3c5123359aaaa49ba60427b0a7cf6cca767145dbfb8`。
  - `latest.yml` SHA-256：`8a072854ffc9632ca8bce699d61f615d399e5df7f62d18062c83ffbcf3c57dee`。

说明：

- 标签触发的 GitHub Actions 会重新构建并替换最初手工上传的本机资产，因此设备安装基准已切换为 Actions 生成的最终 Release，而不是本机首次构建文件。

## v3：设备同步

旧 Windows 设备：

- 仓库从 `fd38b4989f9166aa7772eec61f82388809b348cf` 快进到 `1d7a157ddd39c43790bf3d9103f0837991cc41d5`。
- 保留既有未提交文件 `tools/codex-browser-control-mcp/scripts/restart-extension-bridge.ps1`，未覆盖、未提交。
- 根项目 74 项检查通过。
- 真实热池 smoke 通过：冷初始化约 `770ms`，热初始化 `0ms`。
- 最终 GitHub Release 安装包哈希校验通过并安装为 `0.8.2.0`。
- 已安装 Engine `sourceCommit` 为 `1d7a157ddd39c43790bf3d9103f0837991cc41d5`。
- Bot 恢复通过计划任务启动，避免临时 SSH 会话结束时回收子进程。
- 最终稳定复查：
  - Desktop `0.8.2.0`。
  - Engine 与仓库均为 `1d7a157ddd39c43790bf3d9103f0837991cc41d5`。
  - 17/17 Bot 在线，active run 为 0。
  - 临时计划任务和远端安装包已删除。
  - 删除临时任务后继续稳定观察 60 秒，Desktop 与全部 Bot 仍在线。
- 旧设备既有未提交浏览器桥接脚本修改在升级后仍保持不变。

当前 Windows 设备：

- 当前会话 Bot 仍有 1 个 active run，因此没有被中断。
- 已创建一次性延迟升级任务；它会等待全部 Bot 空闲，校验最终 GitHub Release 哈希，再执行安装、版本检查和全部托管 Bot 恢复验证。
- 延迟任务结果将写入 `%LOCALAPPDATA%\CodexFeishuBridgeDesktop\pending-upgrades\complete-v0.8.2-result.json`。
- 延迟任务由计划任务 `CodexFeishuBridgeDesktopPostUpgrade082` 承载，当前已启动并确认正在等待本次会话 active run 清零。
