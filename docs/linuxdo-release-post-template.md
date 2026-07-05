# Codex 飞书 Bridge 开源发布帖模板

> 用途：发布到 Linux.do 或类似技术社区前的草稿。根据 Linux.do 常见开源分享帖结构整理：先讲背景和痛点，再给项目地址、功能、截图/演示、安装方式、适用人群、风险边界和反馈入口。

## 标题建议

开源一个把飞书 Bot 接到本机 Codex 的 Windows Bridge：支持多 Bot、工作空间工厂、控制面板和安全删除

## 正文模板

#### 本帖使用社区开源推广，符合推广要求。我申明并遵循社区要求的以下内容：

- 我的帖子已经打上开源推广标签：是
- 我的开源项目完整开源，无未开源部分：是
- 我的开源项目已链接认可 LINUX DO 社区：是
- 我帖子内的项目介绍，AI 生成、润色内容部分已截图发出：按实际情况填写
- 以上选择我承诺是永久有效的，接受社区和佬友监督：是

---

大家好，我把最近自用的 Codex 飞书 Bridge 整理成了一个可以公开使用的项目。

项目地址：

- GitHub：https://github.com/yuanzhejiang669-jpg/codex-feishu-bridge

## 这个项目解决什么问题

我平时希望在飞书 APP 里直接使用本机 Codex：发送消息、继续上下文、切换线程、删除会话、管理多个垂类 Bot。原生 Codex 桌面端适合桌面使用，但飞书侧需要一个稳定的 Bridge，把飞书 Bot、lark-cli、本机 Codex app-server、Codex Home 和 workspace 串起来。

这个项目就是做这件事：飞书消息进来，Bridge 调用本机 Codex，最后把进度和结果回写到飞书。

## 主要功能

- 飞书 Bot 对接本机 Codex。
- 多 Bot 独立运行：每个 Bot 有独立 profile、运行目录、日志、workspace 和 watchdog。
- 控制面板：查看进程、日志、Provider、MCP、注册队列和卸载计划。
- 工作空间工厂：批量创建写作、百科、画图等垂类 Bot。
- 自动注册辅助：生成二维码、写入 lark-cli profile、校验 scopes、安装 watchdog。
- 会话命令：`/list`、`/switch`、`/new`、`/rename`、`/delete`、`/confirm delete`。
- 安全删除：按 threadId 快照删除，清理 DB、rollout、session_index、global-state 和 Bridge 绑定。
- Provider 同步：全局 Provider 可以同步到空间 Codex Home，密钥走环境变量。

## 适合谁

- Windows 上使用 Codex Desktop / Codex CLI 的用户。
- 希望在飞书 APP 里使用本机 Codex 的用户。
- 需要多个垂类 Bot，例如写作、百科、画图、资料整理等。
- 愿意自己准备飞书开放平台应用和 lark-cli 登录环境的用户。

## 不适合谁

- 想要纯云端托管服务的用户。
- 不想碰本机 Node.js、PowerShell、lark-cli、飞书开放平台配置的用户。
- 希望一键商业级部署、多人权限后台、云端审计的团队。

## 快速开始

```powershell
git clone git@github.com:yuanzhejiang669-jpg/codex-feishu-bridge.git
cd codex-feishu-bridge
npm install
Copy-Item .\bridge.instances.json .\bridge.instances.local.json
npm run check
npm run panel
```

打开：

```text
http://127.0.0.1:8320/
```

然后按 README 配置自己的飞书 profile、workspace、Codex Home 和 Bot 实例。

## 安全说明

仓库不会提交真实密钥、lark-cli profile、运行日志、二维码、会话数据库、rollout、附件和本机实例配置。真实配置放在 `bridge.instances.local.json`，并已加入 `.gitignore`。

## 目前限制

- 主要适配 Windows。
- 依赖本机 Codex app-server 行为，Codex 上游变动时可能需要跟进。
- 飞书开放平台权限和 lark-cli 登录仍需要用户自己确认。
- 控制面板是本机工具，不建议暴露到公网。

## 欢迎反馈

如果你也在折腾 Codex、飞书 Bot、多工作空间或本机自动化，可以提 issue 或 PR。尤其欢迎反馈：

- 不同 Windows 环境下的启动问题。
- 飞书权限/scopes 兼容问题。
- Codex app-server 上游变动导致的协议问题。
- 多 Bot / 多空间的实际使用体验。

## 可附截图

- 控制面板总览。
- 工作空间工厂。
- 飞书 `/list` 展示。
- Provider 同步页面。

## 发布前检查

- README 链接是否都能打开。
- GitHub 仓库是否已经设置 License。
- 是否误提交 `bridge.instances.local.json`、日志、二维码、密钥。
- `npm run check` 是否通过。
- 截图是否遮挡了 app_id、profile、key、真实路径中不想公开的部分。
