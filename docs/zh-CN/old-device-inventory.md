# 旧设备部署清单

本文件合并自旧设备 inventory 仓库和后续 2026-06-23 的桌面侧边栏修复记录。它记录旧设备当前的 Bridge 拓扑，不包含密钥、完整日志、SQLite 数据库、飞书附件或会话正文。

## 主要路径

| 用途 | 路径 |
|---|---|
| Bridge 源码仓库 | `C:\Users\12644\Documents\Codex\tools\codex-feishu-bridge` |
| 默认 Codex Home | `C:\Users\12644\.codex` |
| 默认 Codex state DB | `C:\Users\12644\.codex\state_5.sqlite` |
| 默认 Codex sessions | `C:\Users\12644\.codex\sessions` |
| 默认 Codex session index | `C:\Users\12644\.codex\session_index.jsonl` |
| 默认 Codex global state | `C:\Users\12644\.codex\.codex-global-state.json` |
| Workspaces 根目录 | `C:\Users\12644\Documents\Codex\workspaces` |
| 专用 Codex Homes 根目录 | `C:\Users\12644\Documents\Codex\codex-homes` |
| 百科共享 Codex Home | `C:\Users\12644\Documents\Codex\codex-homes\codex-assistant-old-baike` |
| Bridge runtime 根目录 | `C:\Users\12644\AppData\Local\CodexFeishuBridge` |
| 命名实例根目录 | `C:\Users\12644\AppData\Local\CodexFeishuBridge\instances` |
| 社区辅助脚本 | `D:\Codex-Community-Tools` |

## 旧设备的执行形态

旧设备历史上出现过 root/default Bridge、普通命名 Bot、百科 Bot 组三种 Bridge 执行形态。当前这台旧设备在 2026-06-23 核对时：

1. root/default 数据根目录存在，但当前没有可核到的 root/default `state` 和 `logs` 目录。
2. 普通命名 Bot 仍然存在：每个实例独立 workspace、state、logs，使用默认 Codex Home。
3. 百科 Bot 组仍然存在：每个实例独立 workspace、state、logs，但共享百科专用 Codex Home，并镜像到默认 Codex Home 供桌面侧边栏显示。

比较行为时必须比较同一种执行形态。不要把 Desktop 原生线程、root/default Bridge、普通命名 Bot、百科 Bot 的结果混在一起判断。

当前可核到的命名实例：

```text
codex-assistant-mobile
codex-assistant-old
codex-assistant-old1
codex-assistant-old2
codex-assistant-old3
codex-assistant-old4
codex-assistant-old5
codex-assistant-old6
codex-assistant-old7
codex-assistant-old8
codex-assistant-old9
codex-assistant-old-baike
codex-assistant-old-baike-1
codex-assistant-old-baike-2
codex-assistant-old-baike-3
codex-assistant-old-baike-4
codex-assistant-old-baike-5
```

## Windows watchdog 计划任务

旧设备当前共有 17 个 `CodexFeishuBridgeWatchdog-*` 计划任务，均位于 Windows 任务计划程序根路径，对应定义文件由 Windows 保存在：

```text
C:\Windows\System32\Tasks
```

这些文件是计划任务定义，不是 watchdog 源码。实际调用的脚本是：

```text
C:\Users\12644\Documents\Codex\tools\codex-feishu-bridge\watch-codex-feishu-bridge-hidden.vbs
```

计划任务每 5 分钟触发一次。watchdog 内部另有 180 秒 stale watchdog 超时、60 秒重启冷却和 3600 秒 Codex idle timeout。

当前任务分组：

```text
codex-assistant-mobile
codex-assistant-old
codex-assistant-old1 ... codex-assistant-old9
codex-assistant-old-baike
codex-assistant-old-baike-1 ... codex-assistant-old-baike-5
```

合计：

```text
1 mobile + 10 普通/全局 + 6 百科 = 17
```

2026-06-24 旧设备恢复时补齐了 6 个百科 watchdog。它们必须传入各自 workspace、匹配的 `LarkProfile`，并共同指向百科共享 Codex Home：

```text
C:\Users\12644\Documents\Codex\codex-homes\codex-assistant-old-baike
```

修复或重装这些任务时不要使用 PowerShell 变量名 `$home`，它容易和内置 `$HOME` 混淆；建议使用 `$codexHomePath` 这类明确变量名。

## 普通实例

普通旧设备实例大多使用默认 Codex Home：

```text
C:\Users\12644\.codex
```

代表性实例：

| 实例 | Workspace | Lark profile | Codex Home |
|---|---|---|---|
| `codex-assistant-mobile` | `C:\Users\12644\Documents\Codex\workspaces\feishu-bridge-codex-assistant-mobile` | `codex-assistant-mobile` | `C:\Users\12644\.codex` |
| `codex-assistant-old` | `C:\Users\12644\Documents\Codex\workspaces\feishu-bridge-codex-assistant-1` | `codex-assistant-1` | `C:\Users\12644\.codex` |
| `codex-assistant-old1` 到 `codex-assistant-old9` | `C:\Users\12644\Documents\Codex\workspaces\feishu-bridge-codex-assistant-old*` | 对应同名 profile | `C:\Users\12644\.codex` |

注意：`codex-assistant-old` 的 workspace 是 `feishu-bridge-codex-assistant-1`，不是 `feishu-bridge-codex-assistant-old`。

## 百科实例组

百科实例组共享一个源 Codex Home：

```text
C:\Users\12644\Documents\Codex\codex-homes\codex-assistant-old-baike
```

同时把桌面可见状态镜像到：

```text
C:\Users\12644\.codex
```

| 实例 | Workspace | Codex Home | Desktop Codex Home |
|---|---|---|---|
| `codex-assistant-old-baike` | `C:\Users\12644\Documents\Codex\workspaces\feishu-bridge-codex-assistant-old-baike` | 百科共享 Home | `C:\Users\12644\.codex` |
| `codex-assistant-old-baike-1` | `C:\Users\12644\Documents\Codex\workspaces\feishu-bridge-codex-assistant-old-baike-1` | 百科共享 Home | `C:\Users\12644\.codex` |
| `codex-assistant-old-baike-2` | `C:\Users\12644\Documents\Codex\workspaces\feishu-bridge-codex-assistant-old-baike-2` | 百科共享 Home | `C:\Users\12644\.codex` |
| `codex-assistant-old-baike-3` | `C:\Users\12644\Documents\Codex\workspaces\feishu-bridge-codex-assistant-old-baike-3` | 百科共享 Home | `C:\Users\12644\.codex` |
| `codex-assistant-old-baike-4` | `C:\Users\12644\Documents\Codex\workspaces\feishu-bridge-codex-assistant-old-baike-4` | 百科共享 Home | `C:\Users\12644\.codex` |
| `codex-assistant-old-baike-5` | `C:\Users\12644\Documents\Codex\workspaces\feishu-bridge-codex-assistant-old-baike-5` | 百科共享 Home | `C:\Users\12644\.codex` |

重启百科实例时必须保留 `-CodexHome` 和 `-DesktopCodexHome`。否则百科任务仍可能运行，但桌面默认侧边栏可能不再显示对应线程。

## 百科 skills 和 MCP

百科专项 skills 位于百科 Home：

```text
C:\Users\12644\Documents\Codex\codex-homes\codex-assistant-old-baike\skills
```

百科自动化 MCP 对应外部工具目录：

```text
C:\Users\12644\Documents\Codex\tools\baike-entry-automation
```

百科 Home 的 MCP 配置包含普通辅助 MCP，也包含百科专用的 `baike_entry_automation`。通用默认 Codex Home 不应加载百科专用 MCP。

## 2026-06-23 桌面侧边栏修复

旧设备曾出现两个相关问题：

1. Bridge 创建的全局 Bot 线程存在于 SQLite 中，但没有进入 `.codex-global-state.json` 的 `projectless-thread-ids`，所以重启桌面端后侧边栏不显示。
2. 百科 Bot 的源线程在百科专用 Codex Home 中，默认 Codex Desktop 看不到；镜像到默认 Home 时还可能沿用 SQLite 中的乱码标题。

当前修复方向：

- Bridge 启动、定时、以及 global state 变动时会 reconcile 桌面侧边栏索引。
- app-server 和 exec fallback 完成后都会走可见性修复。
- 百科线程保留在百科源 Codex Home，同时把桌面可见 row、rollout copy、session index、global state hints 镜像到默认 Home。
- 写默认 `session_index.jsonl` 时优先使用源 `session_index.jsonl` 中的正常中文标题，避免沿用乱码标题。

用户体验：

- 百科任务仍使用百科专用配置、skills、MCP 和 workspace。
- 线程也能出现在默认 Codex Desktop 侧边栏。
- 桌面侧边栏标题应优先显示源索引中的正常中文标题。

## 排查提醒

行为差异不能只看模型。至少同时核对：

- 实例名
- Lark profile
- workspace
- source Codex Home
- Desktop Codex Home
- thread id
- rollout path
- `originator`
- `source` / `thread_source` / `has_user_event`
- 当前 thread 是否续接了旧上下文

同一问题在 Desktop 原生窗口、普通 Bridge、百科 Bridge 上表现不同是可能的，先对齐执行形态再判断。

## 2026-06-24 百科 watchdog 恢复

旧设备重启后曾出现普通 Bot 正常、百科 Bot 不回复的问题。最终定位为 6 个百科实例缺少 Windows 计划任务 watchdog，导致重启后没有恢复 `im.message.receive_v1` consumer。

已补齐的任务：

```text
CodexFeishuBridgeWatchdog-codex-assistant-old-baike
CodexFeishuBridgeWatchdog-codex-assistant-old-baike-1
CodexFeishuBridgeWatchdog-codex-assistant-old-baike-2
CodexFeishuBridgeWatchdog-codex-assistant-old-baike-3
CodexFeishuBridgeWatchdog-codex-assistant-old-baike-4
CodexFeishuBridgeWatchdog-codex-assistant-old-baike-5
```

详细恢复记录见：

```text
docs/zh-CN/baike-watchdog-recovery-20260624.md
```

排查 stale PID 时必须先确认 PID 对应进程命令行包含 `codex-feishu-bridge.mjs`，不要只因为 PID 文件存在就停止进程。

## GitHub 推送权限

2026-06-23 旧设备新增了一把 GitHub 专用 SSH key，用于从旧设备直接推送本仓库：

| 项 | 值 |
|---|---|
| 公钥标题 | `Codex old device 2026-06-23` |
| Fingerprint | `SHA256:hY5Uil7T+e+ds0GjH2vV4p5q9d6i9Ji2x7t19cMWYuc` |
| 私钥路径 | `C:\Users\12644\.ssh\id_ed25519_github` |
| 公钥路径 | `C:\Users\12644\.ssh\id_ed25519_github.pub` |
| SSH config | `C:\Users\12644\.ssh\config` |

同时修复了 `C:\Users\12644\.ssh\config` 开头的 UTF-8 BOM 问题，修复前备份为：

```text
C:\Users\12644\.ssh\config.bak-20260623214916
```

这项变更只影响旧设备本机的 GitHub SSH 推送能力，不会改变新设备已有的 GitHub key 或读取能力。私钥不得提交到任何仓库。
