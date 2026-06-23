# 中文文档地图

这个目录是 Codex Feishu Bridge 的中文文档中心。目标是把原本分散在飞书文档、主项目仓库、新设备 inventory 仓库、旧设备 inventory 仓库里的说明统一到一个 GitHub 仓库中。

## 先看哪篇

| 你想了解 | 阅读 |
|---|---|
| 整体架构、Workspace、Codex Home、桌面侧边栏镜像 | [架构说明](architecture.md) |
| 旧设备当前部署、百科 Bot、旧设备特殊问题 | [旧设备部署清单](old-device-inventory.md) |
| 新设备当前部署、实例和工具链状态 | [新设备部署清单](new-device-inventory.md) |
| 哪些文件能提交，哪些必须排除 | [安全与脱敏边界](security-and-redaction.md) |
| Windows 安装、飞书 Bot 配置、故障排查 | 根目录 `README.zh-CN.md` 和旧版 `docs/*.md` |

## 统一口径

以后按下面的口径维护：

1. `codex-feishu-bridge` 是唯一主仓库。
2. Bridge 源码、部署说明、中文架构说明、新旧设备清单都放在这个仓库。
3. 飞书文档只保留短入口，不再复制详细内容。
4. `new-device-codex-feishu-bridge-inventory` 和 `old-device-codex-feishu-bridge-inventory` 只作为历史快照。
5. 运行日志、数据库、session、附件、token、二维码和个人聊天内容永远不进入 GitHub。

## 建议的飞书入口

飞书入口文档可以压缩成下面这类短文本：

```text
Codex 飞书 Bridge 的统一中文文档已经迁移到 GitHub 主仓库：

https://github.com/yuanzhejiang669-jpg/codex-feishu-bridge

阅读顺序：
1. README.zh-CN.md
2. docs/zh-CN/architecture.md
3. docs/zh-CN/old-device-inventory.md
4. docs/zh-CN/new-device-inventory.md
5. docs/zh-CN/security-and-redaction.md

飞书本文档只作为入口，不再维护重复说明。
```

这样可以避免同一条事实在四个地方各写一遍，后续排查时也不会不知道该相信哪一份。
