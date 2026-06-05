# Feishu Bot Setup

推荐每台 Windows 设备使用一个独立飞书自建应用/机器人，例如：

- 第一台：`codex-assistant-1`
- 第二台：`codex-assistant-2`

不要让两台设备同时消费同一个 app/bot 的事件，否则回复可能重复、竞争或丢失。

## 推荐：自动注册

优先使用仓库里的注册脚本：

```powershell
.\register-codex-feishu-bot.ps1 -Name codex-assistant-1 -InstallStartup
```

它会打开二维码页面，扫码后自动创建 lark-cli profile，并启动桥接器。

## 手动配置清单

如果你在飞书开放平台手动创建应用，需要确认：

1. 已启用机器人能力。
2. 应用已安装/发布到目标租户。
3. 机器人已加入目标聊天。
4. 已订阅事件：`im.message.receive_v1`。
5. 已授予并发布必要权限：
   - 接收消息。
   - 读取消息详情。
   - 以机器人身份发送消息。
   - 回复消息。
   - 下载消息资源/图片。
   - 创建或更新交互卡片。

权限名称会随飞书控制台变化；缺权限时优先看桥接器日志和 lark-cli 报错。

## 手动写入 lark-cli profile

```powershell
$profile = "codex-assistant-1"
$appId = "cli_xxxxxxxxxxxxx"
$appSecret = Read-Host "Feishu App Secret"

$appSecret | lark-cli profile add `
  --name $profile `
  --app-id $appId `
  --brand feishu `
  --app-secret-stdin

lark-cli profile list
```

不要提交本机 lark-cli 配置。它通常在：

```text
%USERPROFILE%\.lark-cli\config.json
```

## 事件测试

```powershell
lark-cli event consume im.message.receive_v1 --as bot --timeout 60s
```

向机器人发消息。如果终端出现 JSON 事件，说明飞书事件路径正常。
