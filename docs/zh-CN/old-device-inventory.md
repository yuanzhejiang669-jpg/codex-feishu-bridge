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

旧设备至少有三种 Bridge 执行形态：

1. root/default Bridge：共享默认 workspace，使用 root runtime 目录。
2. 普通命名 Bot：每个实例独立 workspace、state、logs，使用默认 Codex Home。
3. 百科 Bot 组：每个实例独立 workspace、state、logs，但共享百科专用 Codex Home，并镜像到默认 Codex Home 供桌面侧边栏显示。

比较行为时必须比较同一种执行形态。不要把 Desktop 原生线程、root/default Bridge、普通命名 Bot、百科 Bot 的结果混在一起判断。

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
