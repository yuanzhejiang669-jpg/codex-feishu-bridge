# Pi Agent 接入 Codex 飞书 Bridge 执行记录

状态：实施中

目标版本：Desktop `0.9.0`
建立日期：2026-08-20

## 记录规则

从本次规划之后，每次实际修改都必须按时间追加记录，包含：

- 修改目标和对应规划阶段。
- 创建或修改的文件及原因。
- 数据结构、协议、UI 和用户行为变化。
- 执行的验证、结果和失败项。
- 发现的风险、回滚方式和剩余工作。
- Git 提交、推送、Release、设备同步、客户端安装和 Bot 重启状态。

不得只写“已完成”。尚未验证、尚未发布或尚未同步的部分必须明确标注。

## 2026-08-20：规划与现状核对

### 已完成

- 阅读项目 `AGENTS.md`、根 `package.json`、Desktop `package.json`。
- 核对现有飞书应用扫码注册：`apps/desktop/src/main/services/feishu-registration.cjs`。
- 核对现有 `lark-cli` 用户授权：`apps/desktop/src/main/services/lark-user-auth.cjs`。
- 核对现有 Bot 创建和 Profile 隔离：`apps/desktop/src/main/services/bot-setup.cjs`。
- 核对现有批量空间队列：`apps/desktop/src/main/services/workspace-factory.cjs`。
- 核对现有 MCP/Skills 迁移和目录链接机制：`apps/desktop/src/main/services/capability-migration.cjs`。
- 确认 Desktop 当前源码版本为 `0.8.19`。
- 建立 `docs/pi-agent-integration-plan.md`。

### 已确认现状

- 当前工作空间工厂已有可持久化、逐 Bot 注册的队列基础。
- 应用注册二维码目前只通过 Desktop renderer 展示，不会发送到当前飞书聊天。
- `lark-cli` 用户授权目前打开外部授权页面，随后执行 `auth status --verify`。
- 应用注册与用户授权是两个独立阶段。
- 客户端已有推荐权限策略和权限完整性比较逻辑，可以作为“与当前 Bot 对齐”的权威策略。
- 当前 Codex MCP 配置包含 Browser Control、Desktop Control、Tavily 和 Firecrawl；MinerU 是独立本地工具目录。
- Pi 相关业务源码尚未存在。

### 本次实际文件变化

- 新增 `docs/pi-agent-integration-plan.md`。
- 新增 `docs/pi-agent-integration-execution.md`。

### 本次未执行

- 未修改 Bridge、Desktop 或工具业务源码。
- 未安装 Pi 包。
- 未创建 Pi 配置空间、workspace、session 或 Bot。
- 未请求或发送注册二维码。
- 未读取、复制或更改任何密钥。
- 未运行 Bot、重启 Bridge/客户端、提交 Git、推送 GitHub或发布 Release。

## 2026-08-21：Pi 0.84.2 协议实证与架构冻结

### 已完成

- 从 NPM 下载并只读检查 `@earendil-works/pi-coding-agent@0.84.2`。
- 确认 Node.js 要求为 `>=22.19.0`；Desktop 内置 Node.js `24.18.0` 满足要求。
- 确认官方 RPC 为 `pi --mode rpc`，使用严格 LF 分隔 JSONL。
- 确认 RPC 支持 prompt、图片、steer、follow-up、abort、compaction、retry、状态、usage、session 切换和持久化。
- 确认 `PI_CODING_AGENT_DIR` 可隔离 Agent Home，`--session-dir` 可隔离 JSONL 会话目录。
- 确认自定义 Provider 通过 `models.json` 支持 `openai-responses` 和环境变量形式 API key。
- 确认 Pi 核心不内置 MCP，Browser/Desktop/Tavily/Firecrawl 必须通过 extension/adapter 接入。
- 新增 `docs/pi-agent-architecture.md`，冻结双引擎依赖方向、目录、身份、Provider 和能力边界。
- 将规划状态改为实施中，并固定配置空间与 Pi Agent Home 路径约定。

### 关键架构决定

- 保持模块化单体和一 Bot 一 Bridge 进程。
- 飞书、队列、附件、卡片为公共层；Codex App Server 和 Pi RPC 为并列 adapter。
- 每个 Pi Bot 使用独立 Agent Home/session directory；五个 Bot 只共享只读或权威能力源。
- 使用 NPM 精确版本依赖随 Desktop Engine 打包，不使用全局 NPM 安装或外部可执行文件。

### 临时文件

- 创建 NPM 审计目录：`C:\Users\yzjiang\AppData\Local\Temp\cfb-pi-audit-1fc3f52cf8d44b15a052cd055f00f60b`。
- 其中包含下载的 `earendil-works-pi-coding-agent-0.84.2.tgz` 和解压的 `package` 目录。
- 该目录仅用于协议审计，完成实现验证后删除。

## 2026-08-21：Pi 基础模块与真实 RPC smoke 断点确认

### 目标

- 完成规划阶段 1 的首批基础模块：引擎标识、Pi 目录与 Provider 配置、RPC 参数、事件归一化和严格 JSONL 客户端。
- 用锁定版本 `@earendil-works/pi-coding-agent@0.84.2` 验证真实 Pi RPC 能启动并返回 session 与模型列表。

### 修改

- `package.json`、`package-lock.json`：加入精确版本依赖 `@earendil-works/pi-coding-agent@0.84.2`。
- `src/agents/engine.mjs`：新增 `codex` / `pi` 引擎常量、兼容旧数据的归一化、显示标签和严格校验。
- `src/pi/config.mjs`：新增独立 workspace、配置空间、Pi Agent Home、session directory 解析；生成不含密钥值的 `models.json`、`settings.json` 和 RPC 参数。
- `src/pi/events.mjs`：将 Pi text、thinking、tool、usage、compaction、retry 和协议错误事件归一化为引擎无关事件。
- `src/pi/rpc-client.mjs`：新增严格 LF JSONL、UTF-8 跨 chunk 解码、请求 ID 关联、事件监听/等待、stderr 尾部诊断、停止和进程错误处理。
- `scripts/smoke-pi-rpc.mjs`：新增锁定包版本的真实 Pi RPC smoke。
- `test/agent-engine.test.mjs`、`test/pi-config.test.mjs`、`test/pi-events.test.mjs`、`test/pi-rpc-client.test.mjs`：新增 11 项定向测试。

### 验证

- 定向测试：4 个测试文件共 11 项，全部通过。
- 真实 smoke：`npm run smoke:pi` 已通过；Pi RPC 返回有效 `sessionId` 和 2 个可用模型。
- 首次真实 smoke 曾在 Pi 冷启动后立即发送 `get_state`，请求在 30 秒内未返回；改用管道方式独立调用同一真实 RPC 后成功，证明协议和进程管道可用，问题集中在冷启动就绪时序。
- 当前 smoke 临时等待 8 秒后再请求，可稳定通过，但固定等待不属于最终可靠实现。

### 风险、回滚和剩余工作

- 主要风险：Pi 进程已触发 `spawn` 不代表 RPC 已完成初始化；过早请求可能被延迟或超时。下一步必须实现确定性的就绪探测或有界重试，并保留请求超时、提前退出和 stderr 尾部诊断。
- 当前测试尚未覆盖慢启动、启动期间提前退出、stderr 诊断、请求超时后的清理和停止行为。
- 当前模块尚未接入 Bridge 主流程、Codex adapter、Bot/session schema、Desktop supervisor 或 UI；现有 Codex 行为尚未改变。
- 回滚边界为移除上述新增 Pi/agent 文件及精确依赖；不得触碰与本项目无关的 `start-mimo2codex-proxies.ps1`、`.codex-work/` 和 `creative-preset-adapter/`。
- 未创建 Pi workspace、Agent Home、session、Bot 或配置空间；未读取、复制或写入 Provider 密钥；未重启 Bot/Bridge/客户端；未提交、推送、发布或同步设备。

## 2026-08-21：Pi RPC 确定性冷启动就绪

### 目标

- 去除真实 smoke 对固定 8 秒等待的依赖，以成功的 RPC 协议响应作为 Pi runtime 就绪信号。
- 覆盖慢启动、启动期间退出、stderr、请求超时和停止行为。

### 修改

- `src/pi/rpc-client.mjs`：新增 `waitUntilReady()`，在总启动时限内用有界 `get_state` 探测确认 RPC reader 和 session runtime 已就绪；单次探测有独立时限和短退避，进程退出会立即失败。
- `src/pi/rpc-client.mjs`：请求/事件超时、stdin 错误和进程退出错误现在附带最多 2000 字符的 stderr 尾部；关闭时清理全部 pending request/event waiter，并重置 ready 状态。
- `scripts/smoke-pi-rpc.mjs`：移除固定 8 秒 sleep，改为 60 秒总时限、5 秒单次探测时限的确定性就绪等待。
- `test/pi-rpc-client.test.mjs`：新增慢启动重试、提前退出、stderr 诊断、请求超时清理和 graceful stop 共 5 项测试。

### 验证

- 定向测试：4 个文件共 16 项，16/16 通过。
- 真实 smoke：`npm run smoke:pi` 通过，返回 session `01a02015-bf56-7f86-8233-baab59d0d326` 和 2 个模型；包含 npm 启动开销的实测耗时约 1748 ms。
- smoke 不再包含任何固定冷启动等待；仅在协议探测失败时按边界重试。

### 风险、回滚和剩余工作

- Pi 0.84.2 没有独立 ready 事件；当前以有效 `get_state.data.sessionId` 作为确定性就绪契约。升级 Pi 版本时需重新验证该响应结构。
- 超时探测的旧请求可能在 Pi 最终启动后返回；请求 ID 已从 pending map 删除，因此迟到响应不会错误完成新请求。
- 尚未接入 Bridge 生命周期；下一阶段建立 Agent Engine contract/registry，并先用 Codex adapter 做行为等价测试。

## 2026-08-21：Agent Engine contract、registry 与 Codex 等价适配

### 目标

- 建立公共 Agent Engine contract/registry，先让现有 Codex 普通消息路径通过 adapter 调度并证明行为不变。

### 修改

- `src/agents/contract.mjs`：固定 `run`、`steer`、`abort`、`compact`、`status`、`dispose` 六个 adapter 方法并提供完整性校验。
- `src/agents/registry.mjs`：新增引擎注册、重复注册拒绝、旧数据默认解析为 Codex、按引擎查找和统一 dispose。
- `src/codex/engine-adapter.mjs`：新增 Codex adapter，以不改参数和返回值的方式委托现有 Codex run/steer/abort/compact/status/dispose 实现。
- `codex-feishu-bridge.mjs`：普通消息由 `agentEngineRegistry.get(session.engine).run(...)` 调度；Bridge shutdown 通过 registry 释放 adapter。旧 session 尚无 engine 时 registry 按既定兼容规则选择 Codex。
- `test/agent-engine-registry.test.mjs`：新增旧数据选择 Codex、参数/返回值等价和不完整/重复 adapter 拒绝测试。
- `test/architecture-boundaries.test.mjs`：原静态断言从直接 `runCodex` 更新为 registry 调度，继续验证模型运行不等待 CardKit 且 Codex 使用 warm app-server pool。

### 验证

- contract/registry 与 Pi 定向测试：19/19 通过。
- 首次 `npm run check`：135/136 通过；唯一失败是旧静态测试仍搜索 `await runCodex(` 字面量，不是运行行为回归。
- 更新静态架构断言后再次执行 `npm run check`：语法、控制面板静态 smoke、模型能力检查和全部 136 项测试均通过。

### 风险、回滚和剩余工作

- 本阶段只把普通消息入口切到 registry；Codex 专用 goal、显式 steer 和 compact 命令仍调用既有实现，用户行为和文案未改变。
- registry 当前只注册 Codex；下一阶段完成 PiEngineAdapter 后才允许 Pi session 进入公共消息入口。
- session schema 尚未持久化 `engine`，当前缺失值按 Codex 处理；正式数据迁移仍未完成。

## 2026-08-21：PiEngineAdapter、Bridge runtime 与 session 隔离迁移

### 目标

- 完成规划阶段 3 和 4：把 Pi RPC 生命周期接入 Agent Engine registry，并迁移 Bot 固定引擎所需的 Bridge session schema。

### 修改

- `src/pi/engine-adapter.mjs`：实现每 Bridge session 独立 RPC client、确定性启动、streaming、图片输入、steer、follow-up、abort、compaction、status、dispose、session resume 身份校验、usage 收集和故障分类。
- `codex-feishu-bridge.mjs`：注册 `PiEngineAdapter`；从固定环境变量读取 Pi Agent Home、session directory、Provider、模型、thinking、extension/skill 路径，并用锁定包的 CLI 启动 RPC 子进程。
- `codex-feishu-bridge.mjs`：新增 Pi 事件到现有卡片运行状态的 reducer，覆盖文本、thinking、tool、usage、compaction、retry 和 settled；公共消息入口不包含 Pi 私有 RPC 分支。
- `src/sessions/engine-state.mjs`：新增旧 session 缺 engine 时迁移为 Codex、按引擎隔离 Codex thread 与 Pi session identity 的归一化。
- `src/sessions/store.mjs`：支持注入 session 兼容性规则；当前 session 与 Bot 固定引擎不一致时保留旧 session 并创建该 Bot 引擎的新 Bridge session。
- `codex-feishu-bridge.mjs` session schema 新增 `engine`、`piSessionId`、`piSessionFile`、`piUsage`、`piCompactedAt`；Pi session 的 Codex token/context/thread/goal/health 字段归一化为空，Codex session 的 Pi 字段归一化为空。
- `test/pi-engine-adapter.test.mjs`：新增完整 turn、图片、streaming、usage、steer/follow-up/abort/compact/status/dispose、resume mismatch 和故障映射测试。
- `test/session-engine-migration.test.mjs`：新增旧 session 迁移、Pi 不保留 Codex thread、固定引擎不匹配时新建 Bridge session 测试。

### 验证

- Pi adapter/RPC/events 定向测试：15/15 通过。
- engine registry、Pi adapter、RPC 和 session migration 集成测试：17/17 通过。
- `npm run check`：语法、控制面板静态 smoke、模型能力检查和全部 142 项测试均通过。

### 风险、回滚和剩余工作

- Pi adapter 的真实 provider turn 尚未执行；当前真实验证只到 RPC 启动/state/model list，下一阶段通过 Backup API `openai-responses` 做最小真实请求。
- Desktop supervisor 尚未注入新增 Pi 环境变量，现有 Codex Bot 不受影响；在 Desktop schema/factory 完成前不能从 UI 创建可运行 Pi Bot。
- 显式 `/steer`、`/compact` 和 `/stop` 命令仍使用 Codex 专用 job map；Pi adapter 方法已实现并测试，但命令路由需在 Desktop/Bridge 产品接入阶段切到 registry。
- 测试创建并清理过系统临时目录 `cfb-session-engine-*`，未在仓库或临时目录留下文件。

## 2026-08-21：Backup API Pi Provider renderer 与真实请求

### 目标

- 将现有 Backup API 安全渲染为 Pi `models.json` 的 `openai-responses` Provider，并完成最小真实模型请求。

### 修改

- `src/pi/config.mjs`：新增 `writePiRuntimeConfig()`，原子写入 `models.json` 和 `settings.json`；渲染前后只使用 Provider 环境变量名，并防止当前环境中的密钥值进入序列化结果。
- `scripts/smoke-pi-backup-provider.mjs`：新增隔离临时 Pi Home/session 的真实 Backup API smoke，验证 Provider 加载、最小 prompt、期望响应和 `get_session_stats` 非零 usage，完成后清理全部临时文件。
- `package.json`：新增 `smoke:pi:backup`。
- `test/pi-config.test.mjs`：新增原子配置文件、`openai-responses` 协议、`$BACKUP_API_KEY` 占位符和密钥值不落盘测试。

### 验证

- Provider renderer 与 Pi adapter 定向测试：8/8 通过。
- 当前权威配置核对：Provider `backup-api`，Responses base URL `https://backup.s2a.kdns.fr:9443/v1`，模型 `gpt-5.6-sol`，credential env 为 `BACKUP_API_KEY`；只确认环境变量存在，未输出值。
- 第一次真实 smoke 已收到期望文本，但因只检查 `message_update.usage.totalTokens` 而在 usage 断言失败；临时目录正常清理。此结果说明请求本身成功，断言位置不兼容真实事件形态。
- 改用 Pi 官方 `get_session_stats.tokens.total` 后重跑：`npm run smoke:pi:backup` 通过，收到指定响应和非零 usage，耗时约 5177 ms。

### 风险、回滚和剩余工作

- 两次真实 smoke 均创建并清理了系统临时目录 `cfb-pi-backup-smoke-*`；renderer 测试创建并清理 `cfb-pi-config-*`，没有留下配置、session 或密钥文件。
- 真实请求使用了 Backup API 的最小模型额度；未记录 response body、API key 或完整 usage 明细。
- Desktop 还需在启动 Pi Bot 前调用 renderer 并注入 `BACKUP_API_KEY`；当前只完成公共 renderer、Bridge runtime 消费和真实协议验证。

## 2026-08-21：Pi capability adapter 与五项真实能力验证

### 目标

- 建立 Pi capability extension/adapter，复用 Browser Control、Desktop Control、Tavily、Firecrawl 和 MinerU 的单一权威源码。

### 修改

- `src/pi/capabilities/mcp-client.mjs`：新增严格 JSONL MCP stdio client，覆盖 initialize、initialized notification、tools/list、tools/call、超时、stderr、停止和 text/image/resource 结果归一化。
- `extensions/pi-capabilities.ts`：新增共享 Pi extension；session 启动时按配置动态注册 MCP 工具原始 schema，执行时透传工具调用；MinerU 注册为 `mineru_convert` 并调用既有 PowerShell 入口。
- `src/pi/capabilities/config.mjs`：生成五项能力配置，前四项引用 Bridge 仓库权威入口，MinerU 引用独立工具目录；Tavily/Firecrawl 只引用既有 key-pool/state 路径，不复制或写入密钥。
- `scripts/smoke-pi-capabilities.mjs`、`package.json`：新增五项顺序真实 smoke。
- `test/pi-capabilities.test.mjs`：新增 MCP initialize/list/call、五项权威源和 text/image 结果测试。

### 验证

- capability adapter 定向测试：3/3 通过。
- Browser：真实 `browser_status` 通过；smoke 显式关闭 extension bridge 以测试 CDP status，生产配置不关闭完整 Browser 能力。
- Desktop：真实 `codex_desktop_control_status` 通过。
- Tavily：显式注入既有私有 key-pool/state 路径后，真实 `tavily_search` 通过。
- Firecrawl：真实 `firecrawl_search` 到达 router，但 6 个现有 key 全部处于长期 cooldown，返回 `All keys are cooling down`；随后真实 `firecrawl_pool_status` 通过，确认 MCP server、key pool、state 和额度状态链路可用。没有清除或绕过 cooldown。
- MinerU：用权威目录的 `test-inputs/mineru-smoke-test.pdf` 调用现有 `convert-with-mineru.ps1`，pipeline 完成并生成 Markdown；五项整轮 smoke 约 104 秒。

### 风险、回滚和剩余工作

- Firecrawl 搜索功能受外部 key cooldown 阻塞，adapter 本身和状态查询已验证；在 key 恢复前不能宣称搜索请求成功。
- Browser 完整 extension bridge 仍要求 supervisor 注入当前私有 token；能力配置不保存 token 值。
- MinerU smoke 创建并清理了系统临时目录 `cfb-pi-mineru-smoke-*` 及其转换产物，没有复制模型或缓存。
- Desktop 需生成 `capabilities.json`、设置 `CODEX_FEISHU_PI_CAPABILITIES_CONFIG` 并把共享 extension 路径传给 Pi runtime。

## 2026-08-21：Desktop Bot engine schema 与 Pi runtime 配置

### 目标

- 让 Desktop 管理的 Bot 在创建时固化 `engine`，并为 Pi Bot 生成隔离运行目录和无密钥配置。

### 修改

- `apps/desktop/src/main/services/bot-setup.cjs`：新 Bot 写入 schema v2 和固定 `engine`；读取旧 Bot 时缺失 engine 默认迁移为 `codex`。
- Pi Bot 使用独立 workspace、Agent Home 和 session directory，共享 `pi-general` 配置空间；目录根可由 Desktop 测试和部署参数显式注入。
- Pi Bot 只接受已保存的全局 Provider，读取 `env_key` 并生成 Pi `models.json`、`settings.json`、共享 `capabilities.json`；`bot.json` 只保存环境变量名和公开 Provider 元数据。
- 创建事务记录共享 capability 配置原内容；后续步骤失败时删除新 Agent Home，并恢复或移除本次写入的共享配置。
- `apps/desktop/test/bot-setup.test.cjs`：新增旧 Bot engine 默认值、Pi 目录/配置、密钥不落盘及失败回滚测试。

### 验证

- `node --check apps/desktop/src/main/services/bot-setup.cjs`：通过。
- `node --test apps/desktop/test/bot-setup.test.cjs`：13/13 通过。
- `git diff --check`：无空白错误；仅提示仓库既有 Windows 行尾转换策略。

### 风险、回滚和剩余工作

- `pi-general/capabilities.json` 是共享权威配置，多个 Pi Bot 会写入同一确定性内容；创建失败已有原内容恢复，但并发创建仍需由 Desktop 创建队列串行化保证。
- Desktop supervisor 尚未按 engine 分流可执行前置检查、启动环境和 Provider 密钥注入；下一阶段处理。
- 测试创建并清理了 `cfb-desktop-bot-test-*` 系统临时目录，没有在仓库留下临时配置或密钥。

## 2026-08-21：Desktop supervisor Pi engine 启动分流

### 目标

- 让 Desktop supervisor 在不依赖 Codex runtime 的前提下启动 Pi Bot，并安全注入完整运行环境。

### 修改

- `apps/desktop/src/main/services/supervisor.cjs`：按 Bot engine 执行 runtime 前置检查；Codex 路径保持原检查，Pi 路径验证 Agent Home、session、models/settings、extension 和 capability 配置。
- Pi 子进程环境新增 `CODEX_FEISHU_AGENT_ENGINE`、`PI_CODING_AGENT_DIR`、Pi session/provider/model/thinking/extension/capability 变量；Provider 密钥按 `envKey` 只进入派生子进程环境，缺失时拒绝启动。
- POSIX 和 Windows launch config 新增 engine 与公开 Pi 路径，不记录密钥；`start-codex-feishu-bridge.ps1` 保持同一 Bridge 启动入口。
- `apps/desktop/src/main/index.cjs`：向 Bot setup 注入 Pi 根目录/engine root，向 supervisor 注入已水合的进程环境。
- `apps/desktop/test/supervisor.test.cjs`：新增 Pi 环境契约、缺失密钥拒绝、无 Codex runtime 启停和 launch metadata 保密测试。

### 验证

- supervisor 定向测试：27/27 通过，另 2 项 macOS 条件测试按当前平台跳过。
- `node --check`：supervisor、Desktop main 和测试文件通过。
- PowerShell AST parser：`start-codex-feishu-bridge.ps1` 无解析错误。
- `git diff --check`：无空白错误；仅有 Windows 行尾策略提示。

### 风险、回滚和剩余工作

- Windows 真实 Pi Bot 尚未创建，当前 Windows launcher 由解析测试和既有打包契约测试覆盖，真实进程将在首个扫码 Bot 完成后验证。
- Provider credential store 会在 Desktop 启动时水合 `process.env`；Pi 启动显式拒绝缺失密钥，不会回退到配置文件或日志。
- 测试创建并清理 `cfb-pi-supervisor-env-*`、`cfb-desktop-supervisor-test-*` 临时目录及测试子进程状态。

## 2026-08-21：固定五 Bot Pi workspace factory preset

### 目标

- 通过现有可恢复 workspace factory 队列生成固定的 Pi Agent 01 至 Pi Agent 05，保持每 Bot 隔离和共享配置空间约束。

### 修改

- `apps/desktop/src/main/services/workspace-factory.cjs`：新增 engine 维度和固定 Pi preset；强制生成 `pi-agent-01` 至 `pi-agent-05` / `Pi Agent 01` 至 `Pi Agent 05`。
- 五个 Pi 队列项拥有独立 workspace、Agent Home 和 session directory，只共享 `pi-general`；Pi preset 不创建或复用 Codex Home 配置。
- Provider 仍从全局权威 `config.toml` 解析，队列只保存 Provider 公开引用和 `envKey`；逐项注册时把固定 engine 与 Provider 引用传入 Bot 创建事务。
- `apps/desktop/src/main/index.cjs`：为 factory 注入 Pi Agent Home 和 configuration-space 根目录。
- `apps/desktop/test/workspace-factory.test.cjs`：新增固定命名、目录隔离、共享空间、无 Codex space、无密钥队列和注册输入测试。

### 验证

- workspace factory 定向测试：12/12 通过。
- service/test `node --check` 通过；`git diff --check` 无空白错误，仅有 Windows 行尾策略提示。

### 风险、回滚和剩余工作

- 当前复用的是既有单阶段应用注册队列；用户授权二维码、权限验证和 readiness 的第二阶段状态仍需扩展。
- Desktop renderer 尚未暴露 Pi preset 和普通 Bot engine 选择，下一阶段接入 UI。
- 测试创建并清理 `cfb-workspace-factory-*` 临时目录，没有留下队列或配置。

## 2026-08-21：Desktop engine UI 与打包引擎同步

### 目标

- 在 Desktop 创建页和工作空间工厂暴露固定 engine，并展示 Pi 的独立运行路径。

### 修改

- `apps/desktop/src/renderer/index.html`、`app.js`：普通 Bot 创建新增 Codex/Pi 选择；Pi 模式锁定全局 Provider，路径预览展示 Agent Home、session 和 `pi-general`，Bot 列表显示只读 engine 标识。
- workspace factory 新增 Pi 固定五 Bot 入口；Pi 模式禁用 Codex 专属数量、模板、Codex Home 和 AGENTS 控件，预览显示共享 configuration space 与五个固定 Bot。
- `apps/desktop/engine/`：通过仓库自带 `stage:engine` 同步当前 Bridge engine、Pi adapter/capability extension、依赖和测试要求的发布输入。

### 验证

- renderer/Desktop main `node --check` 通过。
- 第一次 Desktop 检查仅 staged-engine parity 失败，准确指出打包副本过期；运行 `npm --prefix apps/desktop run stage:engine --ignore-scripts` 后重跑。
- Desktop 全套：200/200 通过，3 项按当前平台跳过；staged engine parity 通过。
- UI diff 无空白错误。

### 风险、回滚和剩余工作

- renderer 当前由语法、静态契约和 Desktop 全套测试覆盖，尚未启动 Electron 做人工交互截图检查。
- 本阶段生成/修改 `apps/desktop/engine/` 发布输入；失败的不存在脚本 `check:desktop` 仅留下 npm 自身日志 `C:\Users\yzjiang\AppData\Local\CodexFeishuBridgeDesktop\runtime-localappdata\npm-cache\_logs\2026-08-20T17_34_28_969Z-debug-0.log`，未修改项目文件。
- 双阶段用户授权与聊天内二维码投递尚未实现。

## 2026-08-21：Pi 控制命令 registry 路由

### 目标

- 消除 `/steer`、`/stop`、`/compact` 对 Codex 私有 job map 的单一依赖，让 Pi session 使用 adapter contract。

### 修改

- `codex-feishu-bridge.mjs`：三个命令先按 session engine 分流；Pi 分支分别调用 registry 的 `steer`、`abort`、`status`/`compact`，Codex 分支原样保留。
- Pi `/steer` 支持现有附件暂存/重试语义；`/compact` 拒绝活动 turn，完成后持久化 Pi session；`/stop queue|all` 继续复用公共队列清理。
- `src/pi/engine-adapter.mjs`：steer 自动把事件图片转换为 Pi image input，status 返回 adapter 的活动 turn 状态。
- `test/architecture-boundaries.test.mjs`：新增三条 Pi 控制命令必须经 registry 的边界断言。
- `apps/desktop/engine/`：再次同步包含控制路由的当前 Bridge engine。

### 验证

- Pi adapter 与架构定向测试：34/34 通过。
- 根 `npm run check`：147/147 通过。
- Bridge/Pi adapter 语法和 diff 检查通过。

### 风险、回滚和剩余工作

- Pi 控制命令已完成单元/架构验证，尚待首个真实 Pi 飞书会话完成端到端命令验证。
- 双阶段扫码队列、聊天内二维码投递、用户授权和 readiness 串行推进仍是当前主要未完成阶段。

## 2026-08-21：双阶段授权原子 API 与 Pi setup 持久状态

### 目标

- 为聊天内双阶段扫码建立可恢复、跨进程且无密钥的状态基础，并修正 Pi readiness 的运行时判定。

### 修改

- `apps/desktop/src/main/services/lark-user-auth.cjs`：把用户授权拆成 begin（取得授权 URL/device code）和 complete（等待并验证）两个原子阶段；既有 `authorizeLarkUser` 继续组合两者，行为不变。
- `apps/desktop/src/main/services/bot-readiness.cjs`：Pi Bot 检查 Agent Home、session、models/settings、extension 和 capability 配置，不再错误要求 Codex runtime。
- `src/pi/setup-state.mjs`：新增固定五 Bot 批次 schema、阶段常量、跨进程锁、原子 revision 更新、中断/失效二维码恢复和敏感字段拒绝。
- setup state 只保存 conversation、协调 Bot、公开 App ID、阶段、attempt、二维码临时文件路径/有效期和公开验证摘要；显式拒绝 App Secret、device code、授权 URL、Token 与 API key 字段。
- 新增/扩展 `test/pi-setup-state.test.mjs`、Desktop 用户授权和 readiness 测试。

### 验证

- Pi setup state：3/3 通过，包括四路并发 mutation 不丢更新。
- Pi-aware readiness：10/10 通过；确认 `codexAvailable=false` 时完整 Pi runtime 仍可启动。
- 用户授权与原 readiness 定向测试：13/13 通过。
- 语法和 diff 检查通过。

### 风险、回滚和剩余工作

- device code 只存在于 Desktop 当前异步调用内，不持久化；客户端重启后从 `PROFILE_CREATED` 重新申请用户授权二维码，符合只重试当前阶段的约束。
- 二维码内容将使用短生命周期临时 PNG 跨进程交付，状态只记录路径；后续协调器必须在发送、过期、取消和失败时清理文件。
- Desktop 后台执行器与 Bridge `/pi setup` 命令尚未接线。

## 2026-08-21：五 Bot 双阶段 setup 协调器与竞态收口

### 目标

- 让 Desktop 按固定顺序执行应用注册、Profile 创建、用户授权、权限/readiness 验证和启动，并允许当前 Codex Bot 在飞书会话中控制批次和发送两类二维码。

### 修改

- `apps/desktop/src/main/services/pi-setup-coordinator.cjs`：新增可恢复的串行协调器和短生命周期二维码文件；完成应用注册、用户授权、readiness、启动及自动推进下一 Bot。
- `apps/desktop/src/main/index.cjs`：初始化/停止协调器，并在 Desktop 状态中公开无密钥的 `setup.piSetup` 快照。
- `codex-feishu-bridge.mjs`、`src/feishu/lark-cli.mjs`：新增 `/pi setup [status|resend|skip|cancel]` 和飞书图片消息发送；仅批次指定的 Codex Bot/conversation 可创建、操作和接收二维码。
- `apps/desktop/src/main/services/feishu-registration.cjs`、`workspace-factory.cjs`、`lark-user-auth.cjs`：进度回调可等待，授权拆分为 begin/complete，保证二维码先进入公共状态再等待扫码。
- setup 状态和二维码文件不保存 App Secret、device code、授权 URL、Token 或 Provider key；上传后删除 PNG，仅保留公开 image key 和投递时间。
- 竞态保护将迟到完成限定为同一 active 批次/current Bot；cancel/skip 会中止当前可中止操作、清理临时二维码，并阻止迟到的注册或用户授权覆盖终态。失败归属锁定到实际执行 Bot，避免把下一 Bot 误标为 FAILED。
- `apps/desktop/scripts/stage-engine.cjs`：把 `extensions/` 纳入 Desktop engine 暂存输入，防止发布包缺少 `pi-capabilities.ts`。
- `apps/desktop/package.json`：Desktop `check` 纳入新协调器语法检查。

### 验证

- 协调器定向测试：5/5 通过，覆盖双二维码可见与清理、正常推进、保留前序状态的失败、注册期间 cancel、注册期间 skip、用户授权迟到完成。
- Pi setup state：3/3 通过，包括四路并发 mutation 不丢更新。
- 飞书图片发送契约所在测试：20/20 通过，确认 `lark-cli im +messages-send --as bot --chat-id ... --image ... --idempotency-key ...` 参数。
- `pi-setup-coordinator.cjs`、Desktop main、Bridge main、lark client 的 `node --check` 全部通过。
- Bridge setup 架构契约确认协调身份、conversation、锁内单次创建、图片上传后身份复核和幂等发送；根全套 152/152 通过。
- Desktop renderer 新增只读 Pi 批次面板，显示双二维码阶段、当前 Bot、权限计数、readiness 和 online；renderer 定向测试通过。
- 重新执行 `stage:engine` 后，发布输入确认包含 Pi 依赖、`src/pi/setup-state.mjs`、adapter 和 `extensions/pi-capabilities.ts`；Desktop 全套 209/209 通过，3 项平台测试按预期跳过。

### 风险、回滚和剩余工作

- 尚未启动真实五 Bot 注册；必须由用户逐个扫描应用注册和用户授权二维码后，才能完成真实权限、online、消息、工具和 session 隔离验证。
- Desktop 版本已更新为 `0.9.0`；本地 `dist:win` 完整通过 PowerShell 解析、proxy install/smoke、图标、engine staging、NSIS、blockmap、校验和和 release verification。
- Windows 安装候选为 `apps/desktop/out/Codex-Feishu-Bridge-Setup-0.9.0.exe`，大小 `203573236` bytes，SHA-256 `cfc2fa0550f374ccd0dc474c825825d90987e4c0494b2995ae5c1cb1f40b8d4b`；unpacked 包确认包含 Pi dependency、adapter、setup state 和 capability extension。
- 构建期间 `proxy-runtime npm ci` 报告一项 moderate dependency audit 告警，没有自动改依赖；需要在对抗性审查中判断是否属于可利用的发布风险。
- 本阶段构建完成时，已安装客户端仍为 `0.8.19`；后续安装结果见下一节。
- 尚未提交、推送、创建 GitHub Release、同步旧 Windows/macOS 或升级当前设备；这些操作需在真实扫码和对抗性审查完成后执行。

## 2026-08-21：当前 Windows 客户端安装 0.9.0

### 结果

- 使用本地已验证 NSIS 安装包静默升级当前客户端，安装器退出码为 0。
- 已安装 EXE 文件版本为 `0.9.0.0`，卸载注册表为 `Codex Feishu Bridge 0.9.0` / `0.9.0`，新 Desktop 主进程已启动。
- 已安装 engine 确认包含 Pi dependency、`src/pi/engine-adapter.mjs`、`src/pi/setup-state.mjs` 和 `extensions/pi-capabilities.ts`。
- 安装时 `codex-assistant-1` 有 1 个 active run；只关闭 Desktop UI，没有停止该 Bridge，原 PID `46744` 在安装后仍存活。
- 已启动一次性 idle watcher：连续确认 active run 为 0 后优雅停止 `codex-assistant-1`，由 0.9.0 recovery supervisor 恢复，并要求新 PID 稳定 60 秒；结果写入 `C:\Users\yzjiang\AppData\Local\CodexFeishuBridgeDesktop\update-restart-0.9.0.json`。

### 剩余工作

- 等待当前回复结束后的 Bot engine 重载结果；随后开始真实五 Bot 双阶段扫码。
- Git 提交、推送、Release 和设备同步仍未执行。

## 2026-08-21：Pi Skills 权威源与真实扫码批次启动

### 修改与验证

- 发现 0.9.0 初版已自动接入 Browser/Desktop/Tavily/Firecrawl/MinerU capability，但没有把 Skills 路径注入 Pi RPC；在创建真实 Bot 前修复，避免产生能力不完整的五 Bot。
- `apps/desktop/src/main/index.cjs`、`bot-setup.cjs`、`supervisor.cjs`、`bot-readiness.cjs`：Pi Bot 记录并校验 `C:\Users\yzjiang\.codex\skills` 与 `C:\Users\yzjiang\.agents\skills` 两个权威根，通过 `CODEX_FEISHU_PI_SKILLS` 转为多个 Pi `--skill` 参数；不复制 Skills，不让五个 Agent Home 共享写目录。
- Skills 定向测试通过；Desktop 全套 209/209 通过，3 项平台测试按预期跳过。修复版 0.9.0 重新完成 `dist:win`，安装包 SHA-256 为 `8b8b5491596c940fb2075a2e3a065e6921ef6aa46472e70268f100019bf9fa4e`，并覆盖安装成功。
- 安装后的 Desktop 最初从 Bot 隔离环境启动，错误继承了嵌套 `LOCALAPPDATA/USERPROFILE`，导致 production setup state 未被协调器读取；重新以真实用户环境启动 Desktop PID `59628`，当前 Codex Bot PID `63356` 未中断。
- 创建真实批次 `4b6d3be9-0fa4-4bad-a6d9-5f5fc8ee5eb4`，conversation 为当前飞书聊天；Pi Agent 01 已进入 `APP_QR_SENT`，二维码 image key 与发送时间已持久确认，状态不含凭据。

### 当前扫码断点

- 等待用户扫描 Pi Agent 01 应用注册二维码。完成后协调器将自动生成并发送 Pi Agent 01 用户授权二维码，再按同样顺序推进 Pi Agent 02 至 05。

## 2026-08-21：真实注册失败恢复与 Pi Agent 01 二维码重发

### 结果与修复

- 首次真实注册请求因 `open.feishu.cn` 经本机网络映射到 `198.18.0.136:443` 后连接超时而失败；网络恢复后确认 TCP 443 和 HTTPS 均可用。
- `/pi setup resend` 已把 setup 阶段恢复，但 workspace factory 仍把同一 Bot 保留为 `failed`，导致第二次注册被“Bot 当前不能创建：failed”拦截。
- `apps/desktop/src/main/services/workspace-factory.cjs`：仅在调用方显式传入 `retryFailed: true` 时允许重试失败队列项；普通创建路径继续拒绝失败项的隐式重跑。
- `apps/desktop/src/main/services/pi-setup-coordinator.cjs`：Pi 扫码恢复路径显式启用失败项重试。
- `apps/desktop/test/workspace-factory.test.cjs`：新增默认拒绝失败项、显式恢复后创建成功的回归测试。
- 当前运行态确认 `pi-agent-01` 没有 `createdBot` 或 App ID 后，将 factory/setup 两份状态恢复到可重试阶段。第三次请求曾发送二维码，但后续轮询再次因同一端点超时而失效；确认 `accounts.feishu.cn/oauth/v1/app/registration` 在 Desktop 同款 Node 运行时连续 12 次连接成功后执行第四次请求。最新状态稳定为 `APP_QR_SENT`，图片已上传并发送，临时 PNG 已删除，二维码有效期至 `2026-08-21T02:35:24.658Z`。

### 验证与剩余项

- workspace factory 与 Pi setup coordinator 定向测试 18/18 通过；两个修改模块的 `node --check` 通过。
- 当前安装客户端仍是运行中的 `0.9.0.0`，本次失败恢复修复尚未重新构建并覆盖安装；当前 Bot 有 active run，按安全规则延后到会话结束后的 idle 窗口。
- 等待用户扫描 Pi Agent 01 应用注册二维码；随后继续用户授权二维码、权限/readiness 和 Pi Agent 02-05。

## 2026-08-21：当前设备回退 Desktop 0.8.19

### 结果

- 按用户决定暂停 Pi 接入，当前 Windows 已安装客户端从 `0.9.0` 回退到 `0.8.19`；安装 EXE 和卸载注册表均确认版本 `0.8.19`。
- 已安装 engine 不再包含 `@earendil-works/pi-coding-agent` 或 `extensions/pi-capabilities.ts`。
- 降级前将已创建但未运行的 `pi-agent-01` 设为不自启；未删除本地 Pi Bot/Profile/session 数据，也未删除飞书后台应用。
- 安装期间当前会话 Codex Bridge PID `63356` 保持存活且启动时间未变化。
- 所有本地未提交修改保留在 `wip/pi-agent-integration` 分支；`main` 与 `origin/main` 均保持在 `99d310a535ed8c4aab9036cd060447c90faeefa9`。

### 状态

- Pi 项目不再继续注册、启动、发布或设备同步；除非用户以后明确恢复该分支。
- 本次没有提交或推送分支。

## 2026-08-21：三个通用 Pi Bot 的独立 Bridge 运行层

### 目标

- 保持已安装 Desktop `0.8.19` 不变，改用仓库源码运行独立 Pi Bridge。
- 固定生成 `pi-global-01`、`pi-global-02`、`pi-global-03` 三个通用 Bot；不创建垂类预设，但继续保持 workspace、Agent Home、session、profile、日志和进程隔离。
- 三个 Agent Home 同时声明 `deepseek-direct` 与 `backup-api`，密钥仍只从环境变量读取；默认分配为 01 DeepSeek、02/03 Backup。

### 修改

- `src/pi/config.mjs`：`models.json` renderer 支持多个 Provider，同时保留原单 Provider 调用兼容性、重复 ID 拒绝和逐 Provider 密钥泄漏检查。
- `src/pi/standalone.mjs`：新增三个固定通用 Bot preset、隔离目录生成、共享 `pi-general/capabilities.json`、双 Provider 配置和无密钥 `bridge.json` manifest。
- `scripts/provision-pi-global-bots.mjs`：从全局 Codex Provider 权威配置读取 DeepSeek/Backup 的公开字段，生成三个独立运行配置；不读取或输出密钥值。
- `start-pi-feishu-bridge.ps1`：读取单 Bot manifest，验证路径和 Provider 用户环境变量，然后为现有 `start-codex-feishu-bridge.ps1` 注入 Pi engine/RPC/Skills/Extension 环境。未复制 Bridge 主流程，也未修改 Desktop 启动入口。
- `test/pi-standalone.test.mjs`：覆盖三个 Bot 隔离、共享 capability、双 Provider、环境变量占位符、manifest 保密及缺失默认 Provider 拒绝。
- `package.json`：新增 `provision:pi:global` 命令。

### 验证

- `node --check`：Pi config、standalone provisioner 和 CLI 脚本通过。
- `test/pi-config.test.mjs` + `test/pi-standalone.test.mjs`：6/6 通过。
- `start-pi-feishu-bridge.ps1`：Windows PowerShell AST 解析通过。
- `git diff --check`：本阶段文件无空白错误。

### 边界、风险和下一步

- 本阶段未修改 `apps/desktop/`，未构建或安装 Desktop，未重启任何现有 Bot；`main`/`origin/main` 未改变，也没有 commit、push 或 Release。
- 三个真实运行目录尚未生成；Provider、五项 capability 和飞书事件仍需真实验证。
- 飞书应用注册继续复用现有二维码注册器并使用独立 `lark-cli` profile；进入扫码等待后由用户逐个完成。

## 2026-08-21：独立三 Bot 配置生成与真实 Provider/capability 验证

### 结果与修复

- 首次真实 provision 被路径守卫拒绝：当前会话继承 Desktop 隔离 `USERPROFILE=C:\Users\yzjiang\AppData\Local\CodexFeishuBridgeDesktop\profile-home`，默认 Skills 根因此不存在；失败发生在任何运行目录写入之前。
- `src/pi/standalone.mjs` 与 `scripts/provision-pi-global-bots.mjs` 改为优先从权威 `CODEX_HOME=C:\Users\yzjiang\.codex` 推导真实用户根；`start-pi-feishu-bridge.ps1` 使用 Windows 实际 UserProfile，并允许显式 `-UserHome`。新增回归测试覆盖受污染 `USERPROFILE` 场景。
- 已生成三个通用 Bot：
  - `C:\Users\yzjiang\Documents\Codex\pi-homes\pi-global-01`，默认 `deepseek-direct/deepseek-chat`。
  - `C:\Users\yzjiang\Documents\Codex\pi-homes\pi-global-02`，默认 `backup-api/gpt-5.6-sol`。
  - `C:\Users\yzjiang\Documents\Codex\pi-homes\pi-global-03`，默认 `backup-api/gpt-5.6-sol`。
- 三者 workspace 分别位于 `C:\Users\yzjiang\Documents\Codex\workspaces\feishu-bridge-pi-global-01` 至 `03`，session、Agent Home 和 manifest 互不共享；只共享 `C:\Users\yzjiang\Documents\Codex\pi-spaces\pi-general\capabilities.json`。
- `scripts/smoke-pi-deepseek-provider.mjs`：新增 DeepSeek 官方 Responses Provider 的真实 Pi RPC smoke，密钥只从 `DEEPSEEK_API_KEY` 环境变量注入。

### 验证

- 路径修复后的 Pi config/standalone 定向测试：7/7 通过；PowerShell AST 和 diff 检查通过。
- 根 `npm run check`：154/154 通过。
- `npm run smoke:pi:deepseek`：真实返回 `PI_DEEPSEEK_OK`，session stats 含正数 usage。
- `npm run smoke:pi:backup`：真实返回 `PI_BACKUP_OK`，session stats 含正数 usage。
- `npm run smoke:pi:capabilities`：Browser Control、Desktop Control、Tavily、Firecrawl、MinerU 五项全部真实通过；MinerU 测试输出目录已由 smoke 清理。
- 两个 Provider smoke 的系统临时 Agent Home/session 均在 `finally` 中清理；没有把 Provider 密钥写入 models、manifest、日志或仓库。

### 剩余工作

- 三个飞书 App/profile 尚未创建，Bridge 尚未启动；下一阶段逐个扫码注册、用户授权、事件 readiness 和飞书消息端到端验证。
- `scripts/smoke-pi-capabilities.mjs` 已验证 capability adapter 的真实下游调用；完整 Extension 注册与飞书内工具选择仍将在首个 Bot 在线后验证。

## 2026-08-21：Pi Global 01 真实注册、上线与状态页分流

### 注册与故障处理

- 第一次应用注册继承了当前 Desktop 隔离 `USERPROFILE/LOCALAPPDATA`，profile 落入 Desktop profile-home；随后尝试迁移时，PowerShell 管道给 `--app-secret-stdin` 追加换行，并覆盖了 `lark-cli` 以 App ID 为键的 keychain 凭据。该 App 能打开聊天但无法取得 bot token，现保留为未使用对象，没有擅自删除飞书应用。
- 第二次注册在命令启动前显式恢复真实 `USERPROFILE/HOME/APPDATA/LOCALAPPDATA`，workspace 也显式指向既定通用目录。新应用显示名为 `Pi Global 01 Bridge`，真实用户配置中的 `pi-global-01` profile 创建成功。
- `lark-cli auth status --verify` 确认新 profile 为 `identity=bot`、`verified=true`、`botStatus=ready`；用户身份授权仍为 missing，后续单独完成第二阶段二维码。
- 首次启动在进程创建前被 capability 路径守卫拒绝：PowerShell 将 Extensions/Skills 两个数组错误合并为空格字符串。`start-pi-feishu-bridge.ps1` 改用显式数组拼接，新增静态回归断言，修复后成功启动。

### 状态页修复

- 真实 launch-config 和 session 均确认 `engine=pi`，Provider 为 `deepseek-direct/deepseek-chat`，没有 Codex thread 字段污染。
- 发现公共 `/status` 仍无条件执行 Codex runtime/thread 渲染，导致 Pi Bot 错报 Backup Provider、Codex CLI、app-server、MCP 和 Codex Home。
- `codex-feishu-bridge.mjs`：`/status` 按 session engine 分流；Pi 状态页查询 Pi adapter，展示 Pi RPC/session/session file/usage/compaction、Agent Home、Provider/model/thinking、Extension/Skills/capability，不调用 Codex runtime 或 thread 同步。
- `test/architecture-boundaries.test.mjs`：新增 Pi 状态不得读取 Codex runtime 字段的边界测试。

### 验证与运行状态

- Pi 状态、adapter、standalone 定向测试：41/41 通过；Bridge 语法和 diff 检查通过。
- 重启前 `pi-global-01` active run 为 0；只优雅重启该新 Bot，旧 PID `33788` 已停止，当前 PID `59256` 存活。
- `im.message.receive_v1` consumer ready、Feishu WebSocket connected，最新日志无 ERROR。
- 当前在线 `codex-assistant-1` 未停止或重启，当前对话未中断。

### 剩余工作

- 用户需重新调用 `/status` 验证 Pi 状态文案，并发送普通消息触发首个真实 Pi session/model turn。
- 完成 `pi-global-01` 用户授权二维码、飞书内工具调用；随后按修正后的真实环境顺序注册 02、03。

## 2026-08-21：Pi 动态卡片完成态与引擎品牌修复

### 现象与根因

- `Pi Global 01 Bridge` 的普通消息已在约 5.2 秒内完成，日志存在 `message answered`，`active-runs.json` 为空，但飞书动态卡片仍显示“Codex 正在回复”。
- 根因一：公共 engine dispatch 在 adapter 返回后没有统一调用 `ensureRunDone()` 和最终 `updateCard()`；现有 Codex delegate 会在内部收口，Pi adapter 只返回结果，因此 Pi 卡片保留 `terminal=running/footer=streaming`。
- 根因二：`cardTitle()` 的非 Goal 分支硬编码所有 `Codex` 文案，没有使用 session engine。

### 修改

- `codex-feishu-bridge.mjs`：engine registry `run()` 成功返回后，公共层统一执行 `ensureRunDone(cardState, result.text)`、最终 card update/flush，再等待并行 card open；Codex 重复收口保持幂等。
- 卡片标题与无输出/失败兜底使用 `agentEngineLabel(session.engine)`；Pi 显示“Pi 正在回复/已完成/已停止”，Codex 文案保持不变。
- 停止日志改为 engine-neutral，并记录实际 engine。
- `test/architecture-boundaries.test.mjs`：新增公共完成收口顺序、Pi/Codex 标题不得硬编码串线的边界断言。

### 验证与运行状态

- 故障现场确认没有活动任务，属于 UI 最终态遗漏而非 Pi RPC 卡死。
- 定向测试：40/40 通过；根 `npm run check`：158/158 通过。
- 重启前再次确认 `pi-global-01` active run 为 0；只优雅重启该 Bot，当前真实 PID 为 `16212`，event consumer ready，日志无 ERROR。
- 旧的已发送 CardKit 卡片不会由重启后的新进程追溯更新；新消息用于端到端验证修复。

## 2026-08-21：Pi 完成卡片上下文统计修复

### 现象与根因

- `Pi Global 01 Bridge` 已正确显示“Pi 已完成”，但完成卡片底部只有“未压缩”，缺少 Codex 卡片已有的当前上下文窗口、token 比例和最近压缩时间。
- Pi RPC 已提供权威 `get_session_stats`，其中 `tokens` 是全 session 累计 usage，`contextUsage` 是 Pi 实际用于压缩和 footer 的当前窗口估算；现有 adapter 完成后只调用 `get_state`，没有采集该统计。
- 公共 `createRunState()` 只从 Codex 的 `lastContextUsage/lastCompactedAt` 建立卡片快照；Pi 的 usage/compaction 使用独立字段，而且任务结束后取得的新统计没有同步回最终卡片状态。

### 修改

- `src/pi/engine-adapter.mjs`：每轮完成后调用官方 `get_session_stats`，将累计 usage、当前 context usage 和峰值写入 Pi 专属 session 字段；统计请求使用独立 3 秒上限，失败仅记录 warning，不把已经成功的回答改为失败。手动 compaction 同步记录 Pi 压缩时间并刷新统计。
- `codex-feishu-bridge.mjs`：Pi session schema 新增 `piContextUsage/piContextPeakUsage`，Codex session 对应字段保持隔离；运行状态创建时在 engine 边界映射为公共卡片 metadata，并在 adapter 返回后、最终 card flush 前重新同步，确保显示本轮刚取得的数据。Pi 自动压缩完成事件也立即更新当前卡片的压缩时间。
- `test/pi-engine-adapter.test.mjs`：覆盖官方 stats 字段映射、累计 usage、当前窗口、峰值、手动压缩时间，以及 stats 超时后回答仍成功的降级行为。
- `test/architecture-boundaries.test.mjs`：覆盖 Pi/Codex context 字段映射和最终 card flush 前的统计同步顺序。

### 验证、运行状态与风险

- Pi adapter、event、session migration、architecture 定向测试：45/45 通过；首次完整 `npm run check`：160/160 通过。
- Pi 当前窗口数据不再从累计 token 猜测，直接使用 Pi 官方 `contextUsage`；刚完成压缩且 Pi 返回 `tokens/percent=null` 时不会显示虚假的 0% 数据。
- 重启前解析 `pi-global-01` 的 `active-runs.json.runs` 为 0；仅优雅重启该 Pi Bot。初次修复后的 PID `57664` 在对抗性审查修复后再次优雅退出，最终 PID `64380` 存活，event consumer ready，最新日志无 ERROR。当前对话的 Codex Bot 未重启。
- 飞书端仍需由用户发送一条新的普通消息验证完成卡片；旧的已发送卡片不会被追溯更新。

### 对抗性审查

- 最可能原因一：完成后的 stats RPC 变慢或暂时不可用，拖住每次成功回答。验证发现统计已软失败，但原上限 10 秒偏长；已收紧为独立 3 秒上限，并用 adapter 测试确认失败只告警、回答仍成功。
- 最可能原因二：Pi 官方在刚压缩后返回 `contextUsage.tokens/percent=null`，session 重载时被 `Number(null)` 错误归一化为 0。验证确认该风险真实存在；已修复 `src/sessions/normalize.mjs` 的 nullable number 语义，并新增跨 reload 回归测试。
- 最可能原因三：adapter 在任务结束后才取得统计，而动态卡片仍使用任务开始时的旧快照。已验证最终顺序为 `run -> syncRunContextMeta -> ensureRunDone -> final updateCard`，并由架构边界测试锁定。
- 审查修复后的定向测试：43/43 通过；完整 `npm run check`：161/161 通过；`git diff --check` 无空白错误。

## 2026-08-21：Pi 会话命令与 Codex inventory 严格隔离

### 现象与根因

- 用户在 `Pi Global 01 Bridge` 执行 `/list`，真实结果包含 `codex://threads/...`、全局 Codex Home 和 Desktop Bridge `sessions.json` 路径。
- 根因是 `/list`、`/sessions`、`/switch`、`/rename`、`/delete`、`/reset`、`/now`、`/context` 仍复用 Codex thread inventory/metadata；`/goal`、`/provider`、`/model`、`/fast` 也未在命令入口阻止 Pi session 进入 Codex 私有 handler。
- 这是运行态数据边界错误，不只是显示文案错误，违反 Codex thread 与 Pi JSONL 严格隔离约束。

### 修改

- `codex-feishu-bridge.mjs`：Pi `/list` 与 `/sessions` 只读取当前 Pi 实例、当前聊天的 `state/sessions.json`，只显示 Bridge session、Pi session ID 和 JSONL；Pi 引擎下 `syncChatSessionsWithCodex()` 直接返回，不扫描 Codex Home、Desktop mirror 或跨实例绑定。
- Pi `/switch` 只接受当前聊天内 Pi Bridge session；`/rename` 同步 Bridge 标题，并在已有 Pi JSONL 时调用 Pi 官方 `set_session_name`；`/reset` 调用 Pi 官方 `new_session`，保留 Bridge session 但切换到空白 Pi JSONL；`/delete` 二次确认后移除 Bridge binding 并删除对应 JSONL。
- `src/pi/engine-adapter.mjs`：新增 Pi session reset/rename/delete 操作；删除前要求无 active turn，解析绝对路径并强制目标位于当前 Bot 的 `piSessionDir` 内且扩展名为 `.jsonl`，拒绝目录越界。
- `/help`、`/now`、`/context`、`/new` 和 `/reset` 使用 Pi 身份、RPC/session/usage/compaction 文案；`/goal`、`/provider`、`/model`、`/fast` 在 Pi 命令入口明确说明固定 Provider/model 或无 Pi 等价能力，不再调用 Codex handler。
- `test/pi-engine-adapter.test.mjs`：真实临时 JSONL 覆盖 reset、native rename、目录内删除和目录外拒绝；临时目录在测试结束后清理。
- `test/architecture-boundaries.test.mjs`：锁定 Pi list 分流发生在任何 Codex sync 前、Pi session 命令边界，以及四个 Codex 私有命令 guard 的执行顺序。

### 验证与剩余项

- Pi adapter、session migration、architecture 定向测试：51/51 通过。
- 完整 `npm run check`：169/169 通过；`node --check` 与 `git diff --check` 通过。
- 尚未重启在线 `pi-global-01`；飞书端 `/list`、`/context`、`/new`、`/switch`、`/rename`、`/reset`、`/delete` 验证仍待执行。
- 本阶段不执行需要用户扫码的 user identity 授权，也不注册 02/03；这些保持为后续外部交互阶段。

### 对抗性审查

- 最可能原因一：Pi JSONL 已删除，但 `sessions.json` 原子保存失败，留下指向不存在文件的 Bridge binding。验证确认原删除顺序存在该风险；现由 `PiEngineAdapter.deleteSession()` 对 session 加互斥锁，并通过 `beforeDelete` 回调先原子保存 Bridge 解绑，成功后才 unlink JSONL。保存失败会恢复内存 binding 且不删除文件；unlink 失败最多留下不可达的孤立 JSONL，不会留下断裂 binding。
- 最可能原因二：普通消息处于 Pi RPC 冷启动、附件预处理、卡片收尾或等待队列时，旁路 `/new`、`/switch`、`/reset`、`/delete` 改变 binding，导致旧消息落入错误会话。验证确认 `run()` 原先在 client ready 后才登记 active，队列统计也不包含 in-flight 工作；现从冷启动第一步即登记 active，启动期 `/stop` 可登记取消，并由 event dispatcher 暴露当前聊天全部 in-flight + queued 工作。上述四个 session mutation 命令在工作归零前拒绝执行并提示等待或 `/stop queue`。
- 最可能原因三：Pi `/list` 的其他入口仍可能绕过分流，扫描 Codex Home、Desktop mirror 或跨实例 session。逐项检查 `/list`、`/sessions`、`findSessionEntry`、`syncChatSessionsWithCodex` 及命令入口后，确认 Pi 分流均发生在 Codex inventory helper 前；架构测试继续锁定该顺序，同时锁定 `/goal`、`/provider`、`/model`、`/fast` 不进入 Codex 私有 handler。
- 审查新增 adapter 冷启动取消、删除互斥、持久化先于 unlink、dispatcher in-flight 计数和 session mutation guard 回归测试；测试临时目录均由 test cleanup 删除。
- 本阶段未构建、安装或发布 Desktop；已安装客户端继续保持 0.8.19，不修改 `main`/`origin/main`，不 commit、不 push。

### 部署验证

- 重启前按 `active-runs.json.runs` 的非 null property 统计为 0；仅通过 `bridge.stop` 优雅停止 `pi-global-01` 旧 PID `64380`，未重启当前对话的 Codex Bot。
- 使用 `start-pi-feishu-bridge.ps1 -Name pi-global-01 -UserHome C:\Users\yzjiang` 启动修改后的共享 Bridge；新 PID `68076`，StartTime `2026-08-21T12:33:43.5374635+08:00`。
- 新进程日志确认 `pi-global-01` profile、App `cli_aa0d031766e21bd9`、`im.message.receive_v1` consumer ready；本次启动后的日志无 ERROR。
- 运行态 `sessions.json` 当前共 1 个 session，engine 集合仅为 `pi`，Pi session ID 为 `01a02252-f30d-7a95-aa14-0c58df37a256`，非空 `codexThreadId` 数量为 0。
- 飞书 UI 行为仍需用户在 `Pi Global 01 Bridge` 发送 `/list`、`/context`、`/now`、`/help` 验证；`/delete` 是真实破坏性操作，不对现有 session 自动执行。

## 后续执行记录模板

### YYYY-MM-DD：阶段名称

**目标**

-

**修改**

- 文件：
- 原因：
- 行为变化：

**验证**

- 命令或场景：
- 结果：

**发布与同步**

- 本地源码：
- `origin/main`：
- GitHub Release：
- 当前设备客户端/Bot：
- 旧 Windows 客户端/Bot：
- macOS 客户端/Bot：

**剩余风险和下一步**

-
