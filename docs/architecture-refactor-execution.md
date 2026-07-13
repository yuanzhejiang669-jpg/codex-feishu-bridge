# Codex 飞书 Bridge 架构重构执行记录

本文记录本次架构重构的实际改动、验证结果和进程处理情况。后续继续迁移模块时，按同样格式追加。

## 基线

- 时间：2026-07-06
- 本机仓库：`C:\Users\yzjiang\Documents\Codex\tools\codex-feishu-bridge`
- 基准提交：`0e57d3206cc75997058c918ec37a7afe26f5716b`
- 基准远程：`origin/main`
- 基准状态：本机 `HEAD` 与 `origin/main` 一致
- 主文件：`codex-feishu-bridge.mjs`
- 主文件规模：约 9840 行
- 运行要求：只重启 active run 为 0 的空闲 Bot；有 active run 的 Bot 跳过

## 执行原则

- 每个模块拆分后立即运行 `npm run check`。
- 不改变 Bot 命令、飞书回复、Provider、附件、队列、Goal、控制面板的用户可见行为。
- 不直接重启正在运行任务的 Bot。
- GitHub 推送完成后再同步旧设备。
- 旧设备同步后同样只重启空闲 Bot。

## 2026-07-06 阶段 0：文档和检查基线

改动：

- 新增 `docs/architecture-refactor-plan.md`
- 新增 `docs/architecture-refactor-execution.md`

验证：

- 后续阶段统一用 `npm run check` 验证。

进程情况：

- 未重启任何 Bot。

## 2026-07-06 阶段 1：日志和错误分类

改动：

- 新增 `src/logging/errors.mjs`
- 新增 `src/logging/logger.mjs`
- `codex-feishu-bridge.mjs` 改为导入日志和错误分类函数
- 删除主文件中重复的 `safeJson`、`errorText`、`classifyCodexFailure`、`normalizeFailure`、`emptyCompletionError` 等实现

验证：

- `npm run check` 通过
- `node --check src\logging\errors.mjs` 通过
- `node --check src\logging\logger.mjs` 通过

进程情况：

- 未重启任何 Bot。

## 2026-07-06 阶段 2：service_tier 策略

改动：

- 新增 `src/config/service-tier.mjs`
- 迁移 fast/standard/service_tier 计划、自动降级判断、Provider service_tier 展示逻辑
- `codex-feishu-bridge.mjs` 通过 `createServiceTierPolicy({ findProvider })` 绑定 Provider 查询能力

验证：

- `npm run check` 通过

进程情况：

- 未重启任何 Bot。

## 2026-07-06 阶段 3：运行时状态文件

改动：

- 新增 `src/runtime/seen-events.mjs`
- 新增 `src/runtime/active-runs.mjs`
- 新增 `src/runtime/recalled-messages.mjs`
- 迁移飞书事件去重、event-lock、`active-runs.json`、撤回消息 TTL 缓存
- 主文件保留业务调用点，不再直接实现这些状态文件的读写细节

验证：

- `npm run check` 通过

进程情况：

- 未重启任何 Bot。

## 2026-07-06 阶段 4：配置和 Provider

改动：

- 新增 `src/config/env.mjs`
- 新增 `src/config/paths.mjs`
- 新增 `src/providers/codex-config.mjs`
- 迁移默认工具解析、数据根目录、环境变量解析、路径等价判断、Codex `config.toml` 读取和写入、Provider 列表、Provider bundle 查询

验证：

- `npm run check` 通过

进程情况：

- 未重启任何 Bot。

## 2026-07-06 阶段 5：附件、命令解析、会话归一化

改动：

- 新增 `src/attachments/pending.mjs`
- 新增 `src/commands/parser.mjs`
- 新增 `src/sessions/normalize.mjs`
- 迁移附件 pending、按消息删除附件、斜杠命令解析、用户文本归一化、Goal/token/context usage 归一化

验证：

- `npm run check` 通过

进程情况：

- 未重启任何 Bot。

## 2026-07-06 阶段 6：检查脚本

改动：

- 新增 `scripts/check-syntax.mjs`
- 更新 `package.json` 的 `check` 脚本为 `node scripts/check-syntax.mjs`
- `npm run check` 现在覆盖入口文件、控制面板文件和 `src/**/*.mjs`

验证：

- `npm run check` 通过，输出覆盖以下新增模块：
  - `src\attachments\pending.mjs`
  - `src\commands\parser.mjs`
  - `src\config\env.mjs`
  - `src\config\paths.mjs`
  - `src\config\service-tier.mjs`
  - `src\logging\errors.mjs`
  - `src\logging\logger.mjs`
  - `src\providers\codex-config.mjs`
  - `src\runtime\active-runs.mjs`
  - `src\runtime\recalled-messages.mjs`
  - `src\runtime\seen-events.mjs`
  - `src\sessions\normalize.mjs`

进程情况：

- 未重启任何 Bot。

## 2026-07-07 阶段 7：提交、推送和设备同步

改动：

- 提交架构重构：`ac47603e3bf0208890c1962723c4f2b6a7156b70`
- 推送 GitHub `origin/main`
- 旧设备仓库从 `0e57d3206cc75997058c918ec37a7afe26f5716b` 同步到 `ac47603e3bf0208890c1962723c4f2b6a7156b70`

验证：

- 本机 `npm run check` 通过
- 旧设备 `npm run check` 通过
- GitHub `origin/main` 与本机 `HEAD` 一致
- 旧设备 `HEAD` 与 GitHub `origin/main` 一致

进程情况：

- 文档和代码推送后需要重启 Bridge 进程加载 `src` 新模块。

## 2026-07-07 阶段 8：新旧设备空闲 Bot 重启

新设备：

- `codex-assistant-1`：active run = 1，按规则跳过，没有重启
- 已重启并在线：`codex-assistant-11-writing`
- 已重启并在线：`codex-assistant-1-writing`
- 已重启并在线：`codex-assistant-2`
- 已重启并在线：`codex-assistant-2-writing`
- 已重启并在线：`codex-assistant-3`
- 已重启并在线：`codex-assistant-3-writing`
- 已重启并在线：`codex-assistant-4`
- 已重启并在线：`codex-assistant-5`
- 已重启并在线：`codex-assistant-6`
- 已重启并在线：`codex-assistant-7`
- 已重启并在线：`codex-assistant-8`
- 已重启并在线：`codex-assistant-9`

旧设备：

- 17 个 Bot 均 active run = 0，全部重启并在线
- 已重启并在线：`codex-assistant-mobile`
- 已重启并在线：`codex-assistant-old`
- 已重启并在线：`codex-assistant-old1`
- 已重启并在线：`codex-assistant-old2`
- 已重启并在线：`codex-assistant-old3`
- 已重启并在线：`codex-assistant-old4`
- 已重启并在线：`codex-assistant-old5`
- 已重启并在线：`codex-assistant-old6`
- 已重启并在线：`codex-assistant-old7`
- 已重启并在线：`codex-assistant-old8`
- 已重启并在线：`codex-assistant-old9`
- 已重启并在线：`codex-assistant-old-baike`
- 已重启并在线：`codex-assistant-old-baike-1`
- 已重启并在线：`codex-assistant-old-baike-2`
- 已重启并在线：`codex-assistant-old-baike-3`
- 已重启并在线：`codex-assistant-old-baike-4`
- 已重启并在线：`codex-assistant-old-baike-5`

备注：

- 新设备 `codex-assistant-2-writing` 和 `codex-assistant-8` 第一次重启时 lark-cli 拉取飞书 tenant token 超时，第二次触发计划任务后均恢复在线。
- 本阶段未重启控制面板，因为本次未修改控制面板代码。

## 2026-07-07 阶段 9：Feishu、CardKit、进程、会话和控制面板基础层继续拆分

改动：

- 新增 `src/utils/json.mjs`，迁移通用 JSON 读取、宽松 JSON 解析、深层 key 查找。
- 新增 `src/feishu/events.mjs`，迁移飞书事件类型、event id、message id、chat id、撤回事件识别。
- 新增 `src/feishu/lark-cli.mjs`，迁移 lark-cli 调用、重试、文本/Markdown 发送、reply fallback、`--data @temp-file` 逻辑。
- 新增 `src/feishu/cards/managed-card.mjs`，迁移 CardKit 托管卡片创建、发送、节流刷新和关闭逻辑。
- 新增 `src/feishu/cards/primitives.mjs`，迁移 CardKit markdown 元素、notation 元素、卡片文本截断、消息分片、幂等 key。
- 新增 `src/runtime/process-runner.mjs`，迁移 `runTool`、`terminateProcessTree`、`isProcessAlive`。
- 新增 `src/sessions/store.mjs`，迁移 `sessions.json` 基础 store：加载、保存、当前会话获取、默认会话创建、新会话重置。
- 新增 `src/control-panel/http.mjs`，迁移控制面板 JSON/text/binary 响应、文本/JSON 文件读取、请求 JSON 读取。
- 新增 `src/control-panel/validation.mjs`，迁移控制面板字符串和整数输入校验。
- 新增 `src/control-panel/environment.mjs`，迁移 Windows 用户环境变量读取和 Provider env 可见性判断。
- `codex-feishu-bridge.mjs` 改为导入上述 Bridge 模块，保留启动、编排和高耦合运行流。
- `control-panel.mjs` 改为导入控制面板基础模块，业务 route 行为不变。

规模变化：

- `codex-feishu-bridge.mjs`：约 8280 行降至 7866 行。
- `control-panel.mjs`：约 3888 行降至 3787 行。
- 本阶段新增模块均小于 140 行，后续 PR 可以按目录边界继续迁移。

验证：

- `npm run check` 通过。
- 检查覆盖：
  - `codex-feishu-bridge.mjs`
  - `control-panel.mjs`
  - `control-panel/app.js`
  - `register-codex-feishu-bot.mjs`
  - `src/control-panel/*.mjs`
  - `src/feishu/**/*.mjs`
  - `src/runtime/process-runner.mjs`
  - `src/sessions/store.mjs`
  - `src/utils/json.mjs`

进程情况：

- 本阶段已经修改 `codex-feishu-bridge.mjs`、`control-panel.mjs` 和 `src/**/*.mjs`。
- 同步到 GitHub 和旧设备后，需要重启新旧设备所有 active run 为 0 的 Bridge Bot。
- 因为本阶段修改了控制面板后端，控制面板也需要重启。
- 当前记录时尚未推送 GitHub、尚未同步旧设备、尚未重启 Bot；这些动作在本地验证完成后执行。

## 2026-07-07 阶段 10：提交、推送、旧设备同步和空闲 Bot 重启

提交与同步：

- 本机提交并推送 GitHub：`cf678a643809a5e9bc1be40cda8fabf40acc9ae7`
- GitHub `origin/main` 已指向该提交。
- 旧设备仓库 `C:\Users\12644\Documents\Codex\tools\codex-feishu-bridge` 从 `42642de543b24dc15046f58893cfc9020a0f5374` 快进到 `cf678a643809a5e9bc1be40cda8fabf40acc9ae7`。

验证：

- 本机 `npm run check` 通过。
- 新增模块动态 import 验证通过。
- 旧设备 `npm run check` 通过。
- 本机、GitHub、旧设备代码提交一致。

新设备重启结果：

- 控制面板已重启，最终 PID：`78928`
- 总 Bot：14
- 在线 Bot：14
- active run：1
- watchdog 不健康：0
- 代理在线：2/2
- 跳过：`codex-assistant-1`，active run = 1，是当前对话所在 Bot。
- 已重启并在线：`default`
- 已重启并在线：`codex-assistant-2`
- 已重启并在线：`codex-assistant-3`
- 已重启并在线：`codex-assistant-4`
- 已重启并在线：`codex-assistant-5`
- 已重启并在线：`codex-assistant-6`
- 已重启并在线：`codex-assistant-7`
- 已重启并在线：`codex-assistant-8`
- 已重启并在线：`codex-assistant-9`
- 已重启并在线：`codex-assistant-1-writing`
- 已重启并在线：`codex-assistant-2-writing`
- 已重启并在线：`codex-assistant-3-writing`
- 已重启并在线：`codex-assistant-11-writing`

旧设备重启结果：

- 控制面板已通过计划任务重启，最终 PID：`41052`
- 总 Bot：17
- 在线 Bot：17
- active run：1
- watchdog 不健康：0
- 代理在线：2/2
- 跳过：`codex-assistant-old-baike`，active run = 1。
- 已重启并在线：`codex-assistant-old`
- 已重启并在线：`codex-assistant-old1`
- 已重启并在线：`codex-assistant-old2`
- 已重启并在线：`codex-assistant-old3`
- 已重启并在线：`codex-assistant-old4`
- 已重启并在线：`codex-assistant-old5`
- 已重启并在线：`codex-assistant-old6`
- 已重启并在线：`codex-assistant-old7`
- 已重启并在线：`codex-assistant-old8`
- 已重启并在线：`codex-assistant-old9`
- 已重启并在线：`codex-assistant-old-baike-1`
- 已重启并在线：`codex-assistant-old-baike-2`
- 已重启并在线：`codex-assistant-old-baike-3`
- 已重启并在线：`codex-assistant-old-baike-4`
- 已重启并在线：`codex-assistant-old-baike-5`
- 已重启并在线：`codex-assistant-mobile`

备注：

- 批量重启接口是串行处理，单次大批量请求会超过 HTTP 超时；实际采用小批次补重启。
- 旧设备控制面板不能通过临时 SSH 会话里的 `Start-Process` 可靠保活，最终改用已有计划任务 `CodexFeishuBridgeControlPanel` 启动。
- `codex-assistant-old6` 和 `codex-assistant-old-baike-3` 曾出现“启动后未确认到 PID”，后续状态复查均已在线。
- `codex-assistant-old-baike-3` 的 watchdog 初次未刷新健康行，单独触发 `CodexFeishuBridgeWatchdog-codex-assistant-old-baike-3` 后恢复 healthy。

## 2026-07-13 阶段 11：Codex 传输、协议和事件调度边界

改动：

- 新增 `src/codex/app-server-client.mjs`，迁移 app-server 子进程、JSONL 请求响应、通知缓冲和审批响应。
- 新增 `src/codex/app-server-protocol.mjs`，迁移 thread/start、thread/resume、turn/start 和 turn/steer 参数构造。
- 新增 `src/runtime/event-queue.mjs` 和 `src/runtime/event-dispatcher.mjs`，迁移等待队列、并发计数、召回过滤和任务完成后的续调度。
- 新增 `src/runtime/run-watchdog.mjs`，迁移总时长和空闲超时计时。
- 新增 `src/runtime/single-instance-lock.mjs`，迁移单实例锁、陈旧锁接管和所有者释放。
- 新增 `test/architecture-boundaries.test.mjs`，固定上述模块的现有行为契约。
- `codex-feishu-bridge.mjs` 保留依赖组装和高层业务流程，不改变飞书命令、卡片文案、配置、Thread 映射或重启语义。

验证：

- 每个迁移阶段均运行 `npm run check`。
- 静态检查、控制面板 smoke test 和 27 项 Node 测试全部通过。
- `npm run smoke:app-server` 使用真实 Codex CLI 0.133.0 完成 initialize 握手并正常关闭子进程。
- app-server 测试覆盖同步响应竞态、传输不可用和现有权限响应策略。
- 调度测试覆盖 FIFO、并发限制、排队提示和任务完成后的继续调度。
- 单实例测试覆盖活锁拒绝、死锁接管和非所有者禁止释放。

同步状态：

- 本节记录代码提交前的本机验证结果；GitHub、旧设备和 Bot 重启结果在完成后补充。

### 对抗性审查

假设三个月后出现故障，最可能的三项原因及处理如下：

1. app-server 长任务持续输出 stderr，内存随任务时长增长；极快响应可能早于 pending request 注册；正常关闭后的强杀定时器还可能命中复用 PID。现已将 stderr 限制为保留最后 1 MiB，先注册 request 再写入 stdin，并在正常 close 后取消升级强杀；测试覆盖三种情况。
2. `CODEX_FEISHU_MAX_CONCURRENT` 为 0、非数字或任务 Promise 拒绝，等待队列可能停止推进。dispatcher 现在把无效并发数收敛为 1，并在成功或失败后统一从 `finally` 继续 drain；测试覆盖 FIFO、拒绝路径基础结构和无效并发配置。
3. 陈旧 `bridge.lock.json` 无法删除时，抢锁循环可能持续占用 CPU。现在删除失败会显式抛错并进入现有致命错误处理，不再无限循环；测试覆盖不可删除目标。

### 发布和设备同步

- 实现提交：`a4028d6dd57431ea3ed4a98eddcab854af490def`，已推送 GitHub `main`。
- 新设备：`npm run check`、真实 app-server smoke 和 doctor 通过；15 个 Bot 全在线，14 个空闲 Bot 已重启并确认新 PID。承载本次任务的 `codex-assistant-1` 有 active run，因此没有中断，已安排在任务结束并变为空闲后一次性重启。
- 旧设备：仓库快进到实现提交，`npm run check` 和 Codex CLI 0.136.0 app-server smoke 通过；17 个 Bot 全部 active run 为 0，均已重启并确认新 PID。最终 doctor 为 113/113 ok、0 warn、0 bad。
- 旧设备原有的 `tools/codex-browser-control-mcp/scripts/restart-extension-bridge.ps1` 本地修改已保留，没有纳入本次提交或覆盖。
