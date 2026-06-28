# 架构说明

## 结论

Codex Feishu Bridge 只有一套 Bridge 代码。通用 Bot、旧设备 Bot、百科 Bot 都运行同一份 `codex-feishu-bridge.mjs`，真正决定一个 Bot 读哪套规则、skills、MCP 和本地 Codex 会话状态的是启动时传给 Codex 的 `CODEX_HOME`。

基本分层是：

| 层 | 含义 |
|---|---|
| Bridge 源码 | 所有 Bot 共用，位于 `Documents\Codex\tools\codex-feishu-bridge`。 |
| Workspace | 每个 Bot 实例自己的工作目录，保存附件、中间文件和运行输出。 |
| Bridge runtime state | 每个 Bot 实例自己的 Bridge 状态、日志、PID、队列和 session 映射。 |
| Codex Home | Codex 进程读取的配置、AGENTS、skills、MCP、sessions 和 SQLite 状态。 |
| Desktop Codex Home | 可选镜像目标，用于让专用 Codex Home 创建的线程出现在默认 Codex Desktop 侧边栏。 |

## 主链路

```text
飞书消息
  -> lark-cli event consume im.message.receive_v1 --as bot
  -> codex-feishu-bridge.mjs
  -> 当前 Bot 的 workspace
  -> codex app-server --listen stdio://
  -> 本机 Codex runtime
  -> 飞书进度卡片和最终回复
```

默认使用 `app-server` 模式，`exec` 只是 fallback 或显式配置时使用。

## 关键环境变量

| 名称 | 作用 |
|---|---|
| `CODEX_FEISHU_WORKSPACE` | 当前 Bot 的 workspace。 |
| `CODEX_HOME` | 传给 Codex 进程的源 Codex Home。 |
| `CODEX_FEISHU_DESKTOP_CODEX_HOME` | 可选的桌面端镜像 Codex Home。 |
| `CODEX_FEISHU_INSTANCE_NAME` | 当前 Bridge 实例名。 |
| `CODEX_FEISHU_LARK_PROFILE` | 当前实例使用的 `lark-cli` profile。 |
| `CODEX_FEISHU_RUN_MODE` | `app-server` 或 `exec`。 |
| `MIMO2CODEX_KEY` | Codex 访问本机 mimo2codex Responses 兼容代理时使用的本地代理 key。 |
| `APIDEEPSEEK_API_KEY`、`KIMI_API_KEY`、`GLM_API_KEY` | mimo2codex 上游 provider 使用的真实第三方 API key，只放在 Windows 用户环境变量里。 |

## 第三方模型路由层

非 GPT 第三方模型不直接并入 Bridge 源码。当前架构把 [7as0nch/mimo2codex](https://github.com/7as0nch/mimo2codex) 作为单独本地代理运行，Bridge 只负责让 Codex 指向本地 Responses 兼容端点，并在飞书命令层做组合 provider 切换。

分层关系是：

```text
飞书 /provider m2c-deepseek
  -> Bridge session provider bundle
  -> Codex model_provider = mimo2codex
  -> http://127.0.0.1:8788/v1
  -> mimo2codex
  -> DeepSeek / Kimi / GLM 等上游 Chat Completions 或 Responses API
```

当前本地代理约定：

| 本地端点 | 数据目录 | 用途 |
|---|---|---|
| `http://127.0.0.1:8788/v1` | `%USERPROFILE%\.mimo2codex` | DeepSeek 官方路由，以及可选 Kimi / GLM generic provider。 |
| `http://127.0.0.1:8789/v1` | `%USERPROFILE%\.mimo2codex-apideepseek` | API DeepSeek 独立路由。 |

Bridge 侧组合 provider 会同时设置底层 provider、模型和推理强度：

| 组合 ID | Codex provider | 模型 | 推理强度 |
|---|---|---|---|
| `m2c-deepseek` | `mimo2codex` | `deepseek-v4-pro` | `xhigh` |
| `m2c-deepseek-flash` | `mimo2codex` | `deepseek-v4-flash` | `xhigh` |
| `m2c-apideepseek` | `mimo2codex-apideepseek` | `deepseek-v4-pro` | `xhigh` |
| `m2c-apideepseek-flash` | `mimo2codex-apideepseek` | `deepseek-v4-flash` | `xhigh` |
| `m2c-kimi` | `mimo2codex` | `kimi-k2.6` | `xhigh` |
| `m2c-glm` | `mimo2codex` | `glm-5.2` | `xhigh` |

`/provider <id>` 只改变当前 Bridge session；`/provider save <id>` 会额外写入用户级 `%USERPROFILE%\.codex\config.toml`。真实 API key、mimo2codex SQLite 数据库和 Bridge 运行状态都不进入 Git。

## 通用 Bot

通用 Bot 默认使用用户全局 Codex Home：

```text
C:\Users\<user>\.codex
```

它读取全局的：

```text
AGENTS.md
config.toml
skills\
sessions\
state_5.sqlite
session_index.jsonl
.codex-global-state.json
```

通用 Bot 适合处理普通任务，不应该加载百科专项 skills 或百科专用 MCP。

## 百科 Bot

旧设备上的百科 Bot 使用一个共享的专用 Codex Home：

```text
C:\Users\12644\Documents\Codex\codex-homes\codex-assistant-old-baike
```

当前百科 Bot 组包括：

```text
codex-assistant-old-baike
codex-assistant-old-baike-1
codex-assistant-old-baike-2
codex-assistant-old-baike-3
codex-assistant-old-baike-4
codex-assistant-old-baike-5
```

这些实例各自有独立 workspace、状态目录和日志目录，但共享同一个百科 Codex Home。这样百科规则、百科 SOP、百科 skills、百科 MCP 和百科 thread DB 可以统一管理。

## 桌面侧边栏镜像

专用 Codex Home 有一个天然问题：Codex Desktop 默认只看用户全局 Codex Home，所以百科 Bot 在专用 Home 创建的线程不会自动出现在桌面端默认侧边栏。

当前 Bridge 支持两个 Home：

| 概念 | 旧设备百科 Bot 的值 |
|---|---|
| 源 Codex Home | `C:\Users\12644\Documents\Codex\codex-homes\codex-assistant-old-baike` |
| 桌面镜像 Codex Home | `C:\Users\12644\.codex` |

镜像层会把桌面可见所需的最小状态写入默认 Codex Home：

```text
C:\Users\12644\.codex\state_5.sqlite
C:\Users\12644\.codex\sessions\...
C:\Users\12644\.codex\session_index.jsonl
C:\Users\12644\.codex\.codex-global-state.json
```

用户体验是：百科任务仍然使用百科专用 Codex Home、skills 和 MCP，但生成的线程也能显示在普通 Codex Desktop 侧边栏里。

## 为什么不同入口答案可能不同

即使用同一个模型、provider 和 reasoning effort，下面这些差异仍然会影响结果：

- Codex Desktop 原生线程还是 Bridge 创建的线程。
- root/default Bridge 还是 per-instance Bridge。
- `cwd` 和 workspace 是否相同。
- `CODEX_HOME` 是否相同。
- `AGENTS.md`、skills、MCP、plugins 是否相同。
- 线程是新建还是继续已有上下文。
- Bridge 是否附加了附件说明或历史上下文。
- `originator`、`clientInfo`、`serviceName` 等元数据是否不同。

所以排查时不能只比较模型名。应该同时比较实例名、workspace、Codex Home、thread id、rollout、Bridge 日志和 Codex thread 元数据。

## 文档维护原则

架构事实以后维护在本文件。飞书文档只保留入口，不再复制完整架构说明。设备现场差异维护在 [旧设备部署清单](old-device-inventory.md) 和 [新设备部署清单](new-device-inventory.md)。
