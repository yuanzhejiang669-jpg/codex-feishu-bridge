# Pi Agent 双引擎架构

状态：实施中

目标版本：Desktop `0.9.0`
日期：2026-08-21

## 设计结论

Codex 飞书 Bridge 保持模块化单体和“一 Bot 一 Bridge 进程”。飞书接入、消息队列、附件、卡片、日志和进程监督属于公共层；Codex App Server 与 Pi RPC 是两个并列的 Agent Engine Adapter。

Bot 创建时固定 `engine`。同一个 Bridge session 不允许在 Codex thread 与 Pi session 之间切换。

```text
Feishu event
  -> Bridge common pipeline
       -> AgentEngineRegistry
            -> CodexEngineAdapter -> Codex App Server -> thread
            -> PiEngineAdapter    -> Pi RPC process    -> JSONL session
  -> Bridge common card/message output
```

## 依赖方向

```text
src/feishu, src/runtime, src/attachments, src/sessions
                  |
                  v
           src/agents contract
              /         \
             v           v
       src/codex       src/pi
```

公共层不得导入 Pi 或 Codex 的私有协议类型。`src/codex` 和 `src/pi` 可以依赖公共契约，两个引擎目录之间不得互相导入。

## 进程模型

每个 Bot 继续只有一个长期 Bridge 进程。Codex adapter 使用现有 App Server pool；Pi adapter 为当前活动 Bridge session 启动或恢复一个 RPC 子进程，并在空闲、停止或 Bridge 退出时释放。

Pi RPC 使用严格 LF 分隔 JSONL。读取器只按 `\n` 切分，保留 UTF-8 跨 chunk 状态，不使用 Node `readline`，避免合法 JSON 字符串中的 Unicode 行分隔符被误切。

## 统一契约

公共层使用下列语义，不直接调用 `thread/start` 或 Pi `prompt`：

```text
AgentEngineAdapter
  run(event, session, state, onState)
  steer(activeRun, input)
  abort(activeRun)
  compact(session)
  status(session)
  dispose(reason)
```

统一事件至少覆盖：

- agent started / settled
- text delta / final text
- thinking delta
- tool started / updated / completed
- usage updated
- compaction started / completed
- retry scheduled / completed
- failure / process exit

Codex 的 thread/turn 事件和 Pi 的 agent/turn/message/tool 事件分别由 reducer 映射到现有运行卡片状态。

## 身份与持久化

三类身份必须同时存在：

```text
Feishu conversation
  -> Bridge logical session
       -> engine = codex -> codexThreadId
       -> engine = pi    -> piSessionId + piSessionFile
```

会话字段：

```json
{
  "id": "bridge-session-id",
  "engine": "codex",
  "codexThreadId": "...",
  "piSessionId": "",
  "piSessionFile": ""
}
```

规则：

1. 旧 session 没有 `engine` 时迁移为 `codex`。
2. 当前 Bot 的固定引擎与 session 引擎不一致时，不静默复用；建立该 Bot 引擎的新 Bridge session。
3. Codex token/compaction 状态不得写入 Pi session；Pi 指标不得更新 Codex thread。
4. Pi session file 必须位于该 Bot 的独立 session directory。

## 三类目录

### 工作空间

Agent 实际读取和修改用户文件的位置，每个 Bot 独立：

```text
<Documents>/Codex/workspaces/feishu-bridge-pi-agent-01
```

### 配置空间

五个通用 Pi Bot 共用的逻辑能力定义：

```text
<Documents>/Codex/pi-spaces/pi-general
  AGENTS.md
  provider.json
  capabilities.json
  skills/
  extensions/
```

配置空间保存规则、Provider 引用和能力来源，不保存聊天记录、PID、Token 或队列。

### Pi Agent Home

每个 Bot 的私人运行与会话目录：

```text
<Documents>/Codex/pi-homes/pi-agent-01
  settings.json
  models.json
  sessions/
  skills/       -> 配置空间或权威 Skill 源的链接
  extensions/   -> 配置空间 extension 的链接
```

通过 `PI_CODING_AGENT_DIR` 指向该目录。五个 Bot 不并发写同一个 Agent Home。

## Provider

客户端 Provider 目录是逻辑权威源。Renderer 分别生成：

- Codex：`config.toml`。
- Pi：`models.json`，API 为 `openai-responses` 或对应协议。

`models.json` 只保存 `"apiKey": "$ENV_NAME"`，密钥值由 supervisor 注入环境。Pi Bot 启动前原子生成配置并验证所选模型可见。

## 能力层

Pi 核心不内置 MCP。Bridge 提供一个 Pi extension：

```text
Pi capability extension
  -> read capabilities.json
  -> spawn configured MCP stdio server
  -> initialize + tools/list
  -> register Pi tools dynamically
  -> tools/call
  -> normalize text/image/resource result
```

第一批配置：Browser Control、Desktop Control、Tavily、Firecrawl。MinerU 使用现有稳定 CLI 入口封装为 Pi tool。能力配置引用权威源码，不复制五套工具仓库。

extension 只做协议转换，不增加额外审批或保守限制，保持现有工具自由度。进程退出、超时和协议错误必须作为明确 tool error 返回。

## 桌面客户端

Bot schema 新增：

```json
{
  "schemaVersion": 2,
  "engine": "codex | pi",
  "agentHome": "...",
  "configurationSpace": {
    "id": "pi-general",
    "home": "..."
  }
}
```

旧 Bot 读取时归一化为 `engine: codex`。创建页先选引擎，再选择全局/已有配置空间。Pi Bot 不显示 Codex Home 字样；Codex Bot 的现有流程不变。

supervisor 根据 engine 注入不同环境：

- 公共：workspace、profile、runtime paths、Provider secret。
- Codex：`CODEX_HOME`、Codex CLI/App Server 设置。
- Pi：`CODEX_FEISHU_AGENT_ENGINE=pi`、`PI_CODING_AGENT_DIR`、Pi session dir、extension/config path。

## 注册协调器

当前已在线 Bot 是协调者，因为新 Bot 完成注册前无法发送自己的二维码。批次队列顺序为：

```text
app QR -> app registered -> profile created
-> user auth QR -> permissions verified -> readiness -> next bot
```

二维码 PNG 由协调者上传并发送到发起命令的 conversation。队列阶段、有效期和幂等键持久化；客户端重启后从当前阶段继续，不重复创建已成功对象。

## 失败边界

- Pi RPC 未启动：该 Pi Bot 离线，Codex Bot 不受影响。
- 单个 MCP server 失败：对应工具不可用，Pi 普通对话仍可工作。
- Provider 配置生成失败：拒绝启动 Pi Bot，不覆盖上一次有效配置。
- session 恢复失败：保留原 session file，明确报错，不静默创建空白 session。
- 二维码过期：只重发当前阶段，不重建已完成 App/Profile。

## 演进规则

1. 新引擎只需实现 Agent Engine contract，不修改飞书事件入口。
2. 新共享能力通过 capability registry 增加，不修改 Pi runner。
3. 引擎特有命令由 adapter 声明能力；公共命令根据 capability 显示或拒绝。
4. 每个阶段先加契约测试和故障注入，再接入主流程。
5. 入口文件只负责组装和调度，新增协议代码必须进入 `src/pi` 或 `src/agents`。
