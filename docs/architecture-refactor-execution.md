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

## 当前待执行

- 最终本机验证
- 提交并推送 GitHub
- 同步旧设备
- 重启新旧设备 active run 为 0 的空闲 Bot
- 跳过仍有 active run 的 Bot，并记录跳过名单
