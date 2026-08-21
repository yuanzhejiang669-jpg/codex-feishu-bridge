# Pi Agent 接入 Codex 飞书 Bridge 规划

状态：实施中

目标版本：Desktop `0.9.0`
日期：2026-08-20

## 目标

在现有 Codex 飞书 Bridge 桌面客户端中增加 Pi Agent 引擎，并创建 5 个固定使用 Pi 的通用 Bot。Codex 与 Pi 并行存在，但单个 Bot 创建后不得在两个引擎之间切换。

首批 Pi Bot：

| 显示名称 | 内部 ID | 固定引擎 |
| --- | --- | --- |
| Pi Agent 01 | `pi-agent-01` | `pi` |
| Pi Agent 02 | `pi-agent-02` | `pi` |
| Pi Agent 03 | `pi-agent-03` | `pi` |
| Pi Agent 04 | `pi-agent-04` | `pi` |
| Pi Agent 05 | `pi-agent-05` | `pi` |

现有 Bot 升级后统一迁移为 `engine: "codex"`，行为保持不变。

## 已确认的产品边界

1. 继续使用一个桌面客户端，不另做一套 Pi 客户端。
2. Bot 级固定引擎，不支持同一会话在 Codex 与 Pi 之间切换。
3. Codex `threadId` 与 Pi `sessionId`、JSONL 会话文件完全隔离。
4. Provider 的地址、密钥来源和额度可以共用，但必须分别渲染为 Codex 与 Pi 能识别的配置。
5. 当前 Backup API 使用 OpenAI Responses 协议；Pi Provider 适配器使用 `openai-responses`，密钥继续从 `BACKUP_API_KEY` 注入，不写入 Bot 配置或队列。
6. 五个 Pi Bot 共享能力源和 Provider 定义，但不共享会话、运行队列、日志或飞书身份。
7. 通过当前已在线的 Codex Bot，把注册二维码发送到当前飞书对话；用户自行扫码和授权。

## 总体架构

```text
当前飞书对话
  -> Codex 飞书 Bridge 路由层
       -> Bot(engine=codex) -> Codex App Server -> Codex thread
       -> Bot(engine=pi)    -> Pi RPC Adapter   -> Pi session / JSONL

注册协调者（当前已在线 Codex Bot）
  -> 可恢复注册队列
       -> Pi Agent 01：应用注册 -> lark-cli 用户授权 -> 验证
       -> Pi Agent 02：应用注册 -> lark-cli 用户授权 -> 验证
       -> ...
       -> Pi Agent 05：应用注册 -> lark-cli 用户授权 -> 验证
```

Bridge 的飞书收发、卡片、附件、命令和队列层保持公共；Agent 生命周期、会话协议、模型事件和上下文统计进入引擎适配层。

建议新增统一接口：

```text
AgentEngineAdapter
  startSession()
  resumeSession()
  sendTurn()
  steerTurn()
  abortTurn()
  compactSession()
  listSessions()
  getStatus()
  dispose()
```

Codex 和 Pi 分别实现该接口。不得在公共 Bridge 代码中散布大量 `if (engine === "pi")`。

## 数据模型

Bot 配置由当前 schema 迁移到包含下列字段的新版 schema：

```json
{
  "engine": "codex | pi",
  "engineConfig": {
    "providerId": "backup-api",
    "model": "...",
    "configurationSpaceId": "pi-general"
  }
}
```

运行态必须按引擎保存：

- Codex：`threadId`、Codex context usage、compaction、active turn。
- Pi：`sessionId`、session file、Pi usage、compaction、active turn。
- 公共：飞书 conversation、Bridge session、消息去重键、队列和 Bot ID。

任何 Codex 线程字段都不得写入 Pi 会话，Pi 事件也不得更新 Codex 状态。

## 工作空间与配置空间

目录约定已经固定，详细依赖边界见 `docs/pi-agent-architecture.md`。

### 每个 Bot 独立的内容

建议路径：

```text
C:\Users\<user>\Documents\Codex\workspaces\feishu-bridge-pi-agent-01
...
C:\Users\<user>\Documents\Codex\workspaces\feishu-bridge-pi-agent-05
```

共享配置空间固定为：

```text
C:\Users\<user>\Documents\Codex\pi-spaces\pi-general
```

每个 Bot 的 Pi Agent Home 固定为：

```text
C:\Users\<user>\Documents\Codex\pi-homes\pi-agent-01
...
C:\Users\<user>\Documents\Codex\pi-homes\pi-agent-05
```

每个 Bot 独立保存：

- 飞书 App 和 `lark-cli` profile。
- workspace。
- Pi session/JSONL。
- Bridge runtime、PID、日志、消息队列和附件缓存。
- Bot 级运行状态。

### 五个 Bot 共享的内容

建立一个逻辑配置空间 `pi-general`，集中定义：

- Provider 逻辑定义和模型选择。
- `AGENTS.md` 规则来源。
- Skills 来源。
- Pi extensions/tool adapter 来源。
- Browser Control、Desktop Control、Tavily、Firecrawl、MinerU 的能力声明。

Pi `0.84.2` 已确认支持使用 `PI_CODING_AGENT_DIR` 覆盖默认 Agent Home。采用每个 Bot 独立 Pi Agent Home，其中 Skills/extensions 通过目录链接指向同一权威源，Provider 配置由同一逻辑定义生成；不让 5 个进程并发写同一个设置文件或 session 目录。

## 能力复用

当前权威实现位置：

| 能力 | 当前来源 |
| --- | --- |
| Browser Control | `tools/codex-browser-control-mcp` |
| Desktop Control | `tools/codex-desktop-control-mcp` |
| Tavily | `tools/tavily-router` |
| Firecrawl | `tools/firecrawl-router` |
| MinerU | `C:\Users\yzjiang\Documents\Codex\tools\mineru` |

前四项以 Bridge 仓库中的实现为当前权威源，MinerU 继续使用独立工具目录。不得复制出 5 套仓库。

Pi 不会自动读取 Codex 的 `config.toml`，因此增加 Pi capability adapter：

1. 从客户端的公共能力目录读取逻辑定义。
2. 对 MCP 能力启动并管理 stdio 子进程，向 Pi 暴露精简后的工具接口。
3. Browser/Desktop 保留当前完整操作能力，不增加以“安全”为理由的额外限制。
4. Tavily、Firecrawl 继续使用现有 key pool 和 state 文件；密钥只通过环境变量或既有私有状态路径传入。
5. MinerU 先封装为边界清楚的 Pi tool/extension，调用现有转换入口，不复制模型和缓存。
6. 只向 Pi prompt 暴露当前需要的工具说明，避免把完整 MCP 工具目录一次性塞入上下文。

实施前必须对五项能力分别进行最小真实调用，不能只验证“配置可见”。

## Provider 共享

建立与引擎无关的逻辑 Provider：

```text
ProviderDefinition
  id
  baseUrl
  credentialEnvKey
  protocol
  models
```

再由两个 renderer 输出：

- Codex renderer：现有 `config.toml` / `model_providers` 格式。
- Pi renderer：Pi `models.json` 或经真实版本确认的等价配置，协议标记为 `openai-responses`。

配置和日志只记录 `BACKUP_API_KEY` 这个环境变量名，不记录值。Provider 健康检查要分别通过 Codex 和 Pi 发起最小请求。

## 聊天内批量扫码注册

### 原则

新 Bot 注册完成前无法用自己的身份发二维码，因此当前已在线的 Codex Bot 必须作为注册协调者。默认顺序处理，不同时发送 5 个会过期的二维码。

### 单个 Bot 流程

```text
PENDING
 -> APP_QR_REQUESTING
 -> APP_QR_SENT
 -> APP_REGISTERED
 -> PROFILE_CREATED
 -> USER_AUTH_QR_SENT
 -> USER_AUTHORIZED
 -> PERMISSIONS_VERIFIED
 -> READY
```

具体行为：

1. 协调者调用飞书 `registerApp` 获取应用注册 URL。
2. 生成 PNG，使用当前 Bot 上传图片并发送到当前 conversation。
3. 消息明确显示 Bot 名称、序号、有效期和当前阶段。
4. 扫码成功后创建该 Bot 的隔离 `lark-cli` profile。
5. 通过 `lark-cli auth login --no-wait --json` 获取用户授权 URL。
6. 将授权 URL 再生成二维码发到同一对话，用户扫码授予权限。
7. 调用 `auth status --verify`，并按客户端 `DEFAULT_PERMISSION_POLICY` 对齐当前推荐的 tenant/user scopes 与事件订阅。
8. 权限完整、事件消费可启动且 Bot readiness 通过后，才把该项标为 `READY` 并发送下一个 Bot 的二维码。

应用注册二维码和用户授权二维码是两个不同阶段，界面和消息必须明确区分。

### 队列与恢复

队列持久化至少包含：

- batch ID、发起 conversation、协调 Bot ID。
- 5 个目标 Bot 的 engine、name、label、workspace、configuration space。
- 当前阶段、二维码有效期、attempt、错误、创建结果和权限校验结果。
- 已创建但尚未完成授权的 App/Profile 标识；绝不保存 App Secret 明文。
- `createdAt`、`updatedAt`、`completedAt`。

规则：

- 同一时刻只允许一个注册步骤运行。
- 二维码过期后只重试当前步骤，不重建已成功对象。
- 客户端或 Bridge 重启后，从持久化阶段继续。
- 重复消息和重复按钮使用幂等键，不重复创建应用。
- 用户可执行“重发当前二维码”“跳过当前 Bot”“取消批次”“查看进度”。
- 失败时必须指出停在哪一阶段，并保留已完成的前序 Bot。

## UI 与命令

桌面端：

- Bot 创建页增加固定引擎选择；创建后只读展示。
- 工作空间工厂支持 Pi 模板和 5 Bot 队列预览。
- 注册队列显示每个 Bot 的两个授权阶段和验证结果。
- Bot 详情显示引擎、Provider、workspace、配置空间和 session 标识。

飞书端建议增加管理命令或等价卡片操作：

- `/pi setup`：创建并启动 5 Bot 注册计划。
- `/pi setup status`：查看批次进度。
- `/pi setup resend`：重发当前阶段二维码。
- `/pi setup cancel`：停止后续注册，不删除已创建对象。

命令名在实现前需检查现有命令表，避免冲突。

## 实施阶段

1. **Pi 原生能力验证**：锁定包版本，验证 Windows Git Bash、RPC、stream、tool、image、abort、steer/follow-up、compaction、session resume 和 Provider。
2. **引擎抽象**：提取公共 adapter 接口，先用 Codex 适配器证明现有行为不变。
3. **Pi runtime**：实现 Pi 子进程生命周期、RPC 事件映射、session 持久化和恢复。
4. **数据迁移**：现有 Bot 补 `engine: codex`；加入 Pi 专属状态，确保可回滚。
5. **能力适配**：接入 Browser/Desktop/Tavily/Firecrawl/MinerU，并逐项实测。
6. **Provider renderer**：把 Backup API 安全地映射给 Pi，完成最小请求测试。
7. **注册协调器**：在现有工作空间工厂队列上扩展聊天内双阶段扫码与断点恢复。
8. **UI/命令**：增加引擎展示、Pi 状态和注册进度。
9. **创建 5 个 Pi Bot**：由用户逐个扫码，验证权限、消息、工具和会话隔离。
10. **发布**：完整测试后升级为 Desktop `0.9.0`，再按项目规则同步 GitHub、Release 和设备；实施前不执行发布动作。

## 测试要求

至少覆盖：

1. 旧 Bot 迁移后仍固定使用 Codex。
2. Pi Bot 只创建 Pi session，不创建 Codex thread。
3. 5 个 Pi Bot 的 session、队列和日志互不污染。
4. 公共飞书文本、图片、文件和卡片路径在两种引擎下正常。
5. Pi streaming、abort、follow-up/steer、compaction 和恢复正常。
6. Backup API 通过 Pi `openai-responses` 实际请求成功。
7. 五项共享能力分别完成最小真实调用。
8. 工具权威源更新后，5 个 Pi Home 的链接解析到同一新版来源。
9. 应用二维码成功后才进入 profile 创建。
10. 用户授权完成并验证后才进入下一个 Bot。
11. 二维码过期、用户取消、网络断开和客户端重启可恢复。
12. 重复触发不重复创建 App/Profile/Bot。
13. 权限不完整时不得显示 Ready。
14. 注册队列和日志不包含 App Secret、Token 或 API key。
15. Codex 与 Pi 同时运行时，停止一个 Bot 不影响另一引擎。

## 验收标准

- 一个客户端可稳定管理 Codex Bot 和 Pi Bot。
- 现有 Bot 行为无回归。
- 5 个 Pi Bot 固定使用 Pi，且各自能连续恢复原会话。
- 用户可完全通过当前飞书对话依次扫码完成应用注册和用户授权。
- 注册中断后不需要从第一个 Bot 重来。
- Pi 可使用 Backup API，以及 Browser Control、Desktop Control、Tavily、Firecrawl、MinerU。
- 共享能力只有一个权威源码来源，未复制 5 套。
- Provider 密钥、App Secret 和用户 Token 不出现在队列、日志或 Git。
- 根项目与 Desktop 完整检查、Pi 集成测试、安装包 smoke 和对抗性审查全部通过。

## 主要风险

1. **Pi RPC 与 Bridge 事件语义不完全一致**：先做真实协议验证，再稳定 adapter，不直接用文本解析模拟。
2. **Pi 并不原生消费 Codex MCP 配置**：通过 capability adapter 接入，工具可见不等于可用，必须做真实调用。
3. **双二维码存在过期和半完成对象**：用持久化阶段、幂等键和逐个处理解决。
4. **共享目录发生并发写入**：session/runtime 独立，只链接只读或权威能力源；设置文件采用生成和原子写入。
5. **桌面端与当前聊天之间缺少注册事件通道**：由已在线 Bridge Bot 作为协调者，客户端只保存队列和凭据，不让新 Bot 自举。

## 实施前仍需验证的细节

- 锁定的 Pi 包版本及其 Windows RPC 启动参数。
- Pi 当前版本的 Agent Home、session、`models.json`、extensions 和 Skills 的准确目录约定。
- Pi extension 调用 MCP 的最佳适配边界与工具 schema 转换方式。
- 飞书 SDK 注册 URL和 `lark-cli` 用户授权 URL的实际有效期、重复授权行为。
- 当前聊天内管理命令名称是否与现有命令冲突。

这些验证只影响实现细节，不改变本方案的产品边界和总体结构。
