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
