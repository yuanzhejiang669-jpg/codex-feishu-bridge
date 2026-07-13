# 飞书卡片更新健壮性执行记录

## 执行日期

2026-07-07

## 执行范围

- 本地新设备仓库：`C:\Users\yzjiang\Documents\Codex\tools\codex-feishu-bridge`
- GitHub 远程仓库：`git@github.com:yuanzhejiang669-jpg/codex-feishu-bridge.git`
- 旧设备仓库：`C:\Users\12644\Documents\Codex\tools\codex-feishu-bridge`
- 新旧设备空闲 Bot 重启：已执行

## 已执行变更

### 1. CardKit JSON 传输加固

文件：`codex-feishu-bridge.mjs`

新增：

- `CODEX_FEISHU_LARK_DATA_FILE_THRESHOLD`
- `larkJsonWithData()`
- `shouldUseLarkDataFile()`
- `writeLarkDataFile()`

改动：

- CardKit 创建卡片接口改用 `larkJsonWithData()`
- CardKit 更新运行卡片接口改用 `larkJsonWithData()`
- 启动时修复旧 active run 卡片的接口改用 `larkJsonWithData()`

效果：

- 大卡片 JSON 会写入临时 UTF-8 文件，再通过 `--data @file` 交给 `lark-cli`。
- 临时文件在调用结束后清理。
- 避免 Windows 命令行参数过长触发 `spawn ENAMETOOLONG`。

### 2. 运行中卡片历史步骤限流

文件：`codex-feishu-bridge.mjs`

新增：

- `CODEX_FEISHU_CARD_MAX_RUNNING_TOOL_DETAILS`
- `limitRunningToolDetails()`
- `toolSummaryRunningBody()`

改动：

- 运行中卡片标题从“步骤已执行”调整为“步骤已记录”。
- 运行中卡片默认只展示最近 20 个历史步骤。
- 当前步骤继续单独展开。

效果：

- 长任务卡片不会随着几百个工具步骤无限变长。
- 用户仍能看到总步骤数和当前进度。

## 待执行验证

已完成：

- `npm run check`：通过。
- `lark-cli api --help`：确认 `--data` 支持 `@file` 文件输入。
- `git diff`：代码变更集中在 `codex-feishu-bridge.mjs`，新增本规划和执行文档。
- 临时文件检查：本次语法检查不会执行 Bridge 主流程，因此未产生 `lark-data-*.json` 残留。

本机 active run 检查：

- `codex-assistant-1` 当前有 1 个 active run，是当前对话所在 Bot，不按空闲 Bot 重启。
- 其他已运行实例可按空闲 Bot 重启。

## GitHub 同步

- 代码和初始文档提交：`3b8f95b8ff3d4c1bfa5b288ced93ba425e3208de`
- GitHub `origin/main` 已推送到该提交。
- 旧设备仓库已从 `60b20f9c31fcd7e4331be5347a75d64b9e679e45` 快进到 `3b8f95b8ff3d4c1bfa5b288ced93ba425e3208de`。
- 旧设备 `npm run check`：通过。

## 新设备重启结果

控制面板状态：

- 总 Bot：14
- 在线 Bot：14
- active run：1
- watchdog 不健康：0
- 代理在线：2/2

已重启并在线：

- `default`
- `codex-assistant-2`
- `codex-assistant-3`
- `codex-assistant-4`
- `codex-assistant-5`
- `codex-assistant-6`
- `codex-assistant-7`
- `codex-assistant-8`
- `codex-assistant-9`
- `codex-assistant-1-writing`
- `codex-assistant-2-writing`
- `codex-assistant-3-writing`
- `codex-assistant-11-writing`

跳过：

- `codex-assistant-1`：active run = 1，是当前对话所在 Bot，未重启。

备注：

- `codex-assistant-3-writing` 和 `codex-assistant-11-writing` 的控制面板 API 返回过“启动后未确认到 PID”，原因是 PID 文件读取早于 Bridge 写入；后续状态检查确认两者均已在线且 watchdog healthy。

## 旧设备重启结果

控制面板状态：

- 总 Bot：17
- 在线 Bot：17
- active run：1
- watchdog 不健康：0
- 代理在线：2/2

已重启并在线：

- `codex-assistant-mobile`
- `codex-assistant-old`
- `codex-assistant-old1`
- `codex-assistant-old2`
- `codex-assistant-old3`
- `codex-assistant-old4`
- `codex-assistant-old5`
- `codex-assistant-old6`
- `codex-assistant-old7`
- `codex-assistant-old8`
- `codex-assistant-old9`
- `codex-assistant-old-baike-1`
- `codex-assistant-old-baike-2`
- `codex-assistant-old-baike-3`
- `codex-assistant-old-baike-4`
- `codex-assistant-old-baike-5`

跳过：

- `codex-assistant-old-baike`：active run = 1，未重启。

备注：

- 旧设备批量触发 watchdog 后，部分日志最后一行短暂显示 `another watchdog instance is already running`。逐个触发健康检查后，所有在线 Bot 的 watchdog 状态恢复 healthy。

## 结论

- 新设备、旧设备、GitHub 远程仓库的功能代码已同步。
- 修改了 `codex-feishu-bridge.mjs`，所以空闲 Bot 的 Bridge 进程确实需要重启；已经按 active run 规则完成。
- 仍在运行任务的 Bot 已跳过，避免中断当前任务。

## 2026-07-14 最新进展与残留工具状态修正

问题证据：

- 真实 rollout 显示截图中的 Git 调用在 `21:58:42` 开始并于同一秒返回，实际耗时约 0.4 秒。
- 动态卡片随后仍把该工具视为 `running`，导致步骤数从 65 增长到 74 时，“最近进展”和“本阶段”仍显示二十多分钟。

改动：

- “最近进展”改为从所有工具开始、工具输出、工具完成和模型事件中选择时间最新的有效事件。
- 最近工具事件增加步骤序号，例如 `20秒前 · 第 72 步 · Shell · command_execution 执行完成`。
- 较早但未收到结束状态的工具不再冒充当前工具；存在真实并行或残留状态时显示“等待其余工具结果”和状态提示。
- 新工具开始或模型产生更新事件后，主阶段立即由该最新事件接管。
- 普通 Codex 连接和状态通知不计为有效进展，避免心跳掩盖真正卡住。

对抗性验证：

1. 旧 Git 残留 `running`、后续工具完成：最近进展和本阶段必须跟随后续完成步骤。
2. 真实并行工具：较早工具不得被伪造为完成，但不能覆盖更新的工具或模型事件。
3. 只有普通 Codex 状态通知、没有模型或工具进展：静默时长必须继续增长。

验证：

- `npm run check`：31/31 测试通过。
- `npm run smoke:app-server`：Codex CLI 0.133.0 initialize 握手和正常关闭通过。
- 卡片 Markdown 断言覆盖“等待其余工具结果”“状态提示”“最近进展”和“本阶段”的最终渲染文本。
