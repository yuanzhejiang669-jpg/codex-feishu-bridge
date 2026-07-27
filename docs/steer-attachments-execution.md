# `/steer` 附件支持执行记录

状态：功能与发布完成；当前设备等待承载会话结束后自动升级  
目标版本：Desktop `0.8.3`  
日期：2026-07-27

## v0：根因与原生能力验证

- 确认 Bridge 在命令分支中先调用 `handleCommand` 并返回，附件下载位于返回之后，因此旧版 `/steer` 只能收到文字。
- 确认普通消息附件链路正常，问题只发生在命令分支。
- 使用本机 Codex app-server 对真实运行中的 turn 调用 `turn/steer`，以 `localImage` 传入“刘惠春”截图；服务端接受同一 turn，并正确识别图片文字。
- 首次在 `turn/started` 前调用得到 `no active turn to steer`，确认必须保留 turn 就绪与生命周期检查。

## v1：实现

- 新增仅针对 `/steer` 的命令附件预处理；其他旁路命令不增加下载开销。
- 普通命令入口和旁路命令入口统一调用同一预处理函数。
- 下载数量与请求数量不一致时整次 steer 不执行，避免文字成功、附件丢失的假成功。
- turn 未就绪或原生 steer 失败时，将已下载附件放回待处理存储。
- 待处理附件按消息、文件键和路径去重，防止重试产生重复输入。
- 成功回执显示实际附带的图片和文件数量。
- Desktop 版本提升为 `0.8.3`。

## v2：本地验证

- 定向架构与附件重试测试：30/30 通过。
- 根项目完整检查：75/75 通过。
- Desktop 完整检查：184 项中 181 通过、3 项平台跳过、0 失败。
- 原生 app-server smoke 通过，Codex CLI 版本 `0.145.0`。
- 热池 smoke 通过：冷初始化约 `168ms`，同进程热初始化 `0ms`。
- 暂存 Engine smoke 通过。
- Windows x64 NSIS、blockmap、`latest.yml` 和校验清单构建并验证通过。
- 本机初次构建安装包大小：`169750656` bytes。
- 本机初次构建安装包 SHA-256：`203d54013aa50f4199afaa27966ba40b20d4630b5882df8a6b6608b7e427e059`。
- 正式设备安装以 GitHub Actions 从最终标签重新生成并校验的 Release 资产为准。

## v3：对抗性审查

假设三个月后该能力再次出现问题，最可能的三个原因及验证如下：

1. **两个命令入口行为漂移。**
   - 风险：`/steer` 既可能通过旁路命令入口，也可能从普通事件入口进入；只修其中一个会在特定调度条件下复发。
   - 验证：静态边界测试要求两个入口都在 `handleCommand` 前调用同一个 `prepareCommandAttachments`。
   - 修复：两条路径已统一，不复制下载实现。
2. **下载假成功或 turn 生命周期竞争导致附件丢失。**
   - 风险：Lark CLI 返回成功但文件未落盘、附件部分失败、或下载后 turn 已结束。
   - 验证：请求数与实际下载数逐类比较；下载成功后再检查本地文件存在；原生请求失败路径测试附件回存调用。
   - 修复：部分失败时整次不追加；未落盘视为失败；turn 未就绪或 steer 失败时附件回存并明确提示。
3. **连续快速 steer 产生乱序或重复附件。**
   - 风险：多个旁路命令并行到达，或者一次失败后重试。
   - 验证：保留 `job.steerInFlight` 串行链；测试同一附件两次回存后只取出一份。
   - 修复：所有 steer 继续串行；待处理附件增加稳定身份去重。

审查没有扩展到其他命令或普通任务逻辑。

## v4：发布与设备同步

GitHub：

- 功能提交：`045dfdbecd628b118c00460bc68af36115d49d7b`。
- `origin/main` 已推送，稳定标签为 `v0.8.3`。
- GitHub Actions `Release Windows Desktop Client` 成功。
- Release 为公开稳定版本，包含 5 个且仅包含 Windows 资产。
- Actions 安装包大小：`169750981` bytes。
- Actions 安装包 SHA-256：`29cdf445f00756d9ac9cf8fc1e17f63d93d6606ef46e78cd2e9b0e7892618d42`。
- Release 资产重新下载后，安装包、blockmap 和 `latest.yml` 均与校验清单一致。

旧 Windows：

- 仓库快进到功能提交，原有未提交文件
  `tools/codex-browser-control-mcp/scripts/restart-extension-bridge.ps1`
  保持不变。
- 根项目完整检查 75/75 通过。
- 客户端安装为 `0.8.3.0`，Engine `sourceCommit` 为功能提交。
- 首次从 SSH 内直接调用安装校验时，安装已经成功，但客户端进程随 SSH 作业结束，导致 Bot 恢复校验返回非零；未将其误报为完成。
- 随后通过一次性计划任务在已登录桌面会话中启动客户端，17/17 Bot 依次恢复。
- 删除一次性任务和临时远端安装包后继续观察 60 秒：客户端仍在线，17/17 Bot 在线，活动 run 为 0。

当前 Windows：

- 当前发布会话 Bot 仍有 1 个 active run，未被中断。
- 已重新下载并校验正式 GitHub Release。
- 已创建并启动一次性计划任务
  `CodexFeishuBridgeDesktopPostUpgrade083`。
- 任务会等待所有托管 Bot 的 active run 清零，然后执行哈希复核、安装 `0.8.3`、版本与 Engine 提交检查、全部在线 Bot 恢复及 60 秒稳定性验证。
- 结果写入
  `%LOCALAPPDATA%\CodexFeishuBridgeDesktop\pending-upgrades\complete-v0.8.3-result.json`；
  日志写入同目录的 `complete-v0.8.3.log`。
