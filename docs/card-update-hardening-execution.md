# 飞书卡片更新健壮性执行记录

## 执行日期

2026-07-07

## 执行范围

- 本地新设备仓库：`C:\Users\yzjiang\Documents\Codex\tools\codex-feishu-bridge`
- GitHub 远程仓库：`git@github.com:yuanzhejiang669-jpg/codex-feishu-bridge.git`
- 旧设备同步：待执行
- 新旧设备空闲 Bot 重启：待执行

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

## 待同步和重启

- 提交并推送 GitHub
- 同步旧设备仓库
- 重启新设备空闲 Bot
- 重启旧设备空闲 Bot
- 验证新旧设备 Bridge 进程存活
