# 工作空间与 Bot 队列

桌面客户端的“工作空间”页用于批量创建垂类 Bot，例如写作、百科或画图空间。它把工作目录、隔离 Codex Home、Provider、推理档位、MCP / Skills 迁移和飞书扫码注册组织成可恢复的队列。

![工作空间页面](assets/desktop/workspaces.png)

## 推荐流程

1. 打开客户端“工作空间”页，点击“新建空间 Bot”。
2. 填写空间名称、slug、起始序号、数量和 Codex Home 名称。
3. 选择空间默认 Provider、模型和推理档位。
4. 选择是否复制工作空间 `AGENTS.md`，以及要迁移的 Skills 和 MCP。
5. 先预览路径、配置来源和创建数量，再加入队列。
6. 逐个 Bot 扫码创建飞书应用；队列保存进度，但不保存 App Secret、Token 或 API key。
7. 创建完成后在“Bot”页检查并启动实例。

每个队列项都有独立状态。某个 Bot 注册失败不会要求重做其他已完成项；取消扫码也不会把凭据写入残留文件。

## Codex Home

同一垂类空间的多个 Bot 通常共享一个隔离 Codex Home：

```text
C:\Users\<you>\Documents\Codex\codex-homes\codex-space-writing
```

它们会共享该空间的 Provider、模型选择、Skills、MCP 和会话库，但保留各自的飞书身份、workspace 和 Bridge 运行数据。不同 Codex Home 的会话不会出现在彼此的 `/list` 中。

## MCP 与 Skills

创建前可以从全局 Codex Home 选择性迁移能力。创建后也可在“MCP / Skills”页重新预览源与目标库存，再补充迁移。

![MCP 与 Skills 迁移](assets/desktop/capabilities.png)

迁移只处理已选择的配置或目录，不会把环境变量中的 API key 写入公开配置。目标空间已有内容会先参与差异检查，避免无提示覆盖。

## Provider

空间默认 Provider 来自客户端可见的全局目录。实际密钥保存在操作系统凭据存储或环境变量中，不写入队列。改变整个空间的模型来源会生成预览，并在确认后清理会话级覆盖、重启空闲的客户端 Bot。

## 删除

删除单个 Bot 或整个空间前，客户端会展示将处理的 runtime、workspace、Codex Home 和 Provider 引用。活动任务会阻止破坏性操作。飞书开放平台中的应用仍需用户在飞书后台自行删除。

## 旧网页工厂

仓库中的旧网页控制面板仍保留工作空间工厂，供兼容脚本部署使用。新安装不需要先运行 `npm run panel`，也不需要手工安装 watchdog。
