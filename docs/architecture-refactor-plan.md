# Codex 飞书 Bridge 架构重构规划

## 目标

本规划的目标是在不削减任何现有功能、不改变 Bot 使用方式、不改变 Windows 自启动/控制面板/旧设备同步方式的前提下，把 `codex-feishu-bridge.mjs` 从“超大单文件”演进成可长期维护、方便开源 PR 的模块化单体。

当前项目的核心价值是稳定连接飞书消息、本地 Codex、Provider 配置、控制面板和 Windows 多 Bot 运行时。重构不能牺牲这条主链路。正确方向不是拆成微服务，而是保留单进程部署，把边界清楚的能力迁移到 `src/` 下的领域模块，让入口文件逐步变成编排层。

## 参考项目

以下 stars 数据来自 GitHub API，采集时间为 2026-07-06。

| 项目 | Stars | 参考理由 |
| --- | ---: | --- |
| [n8n](https://github.com/n8n-io/n8n) | 195417 | 工作流自动化平台，核心形态也是“外部事件输入 + 执行引擎 + 集成节点 + 状态管理”。它证明大量外部集成必须通过清晰 registry/adapter 边界维护，不能把所有集成逻辑堆进主流程。 |
| [Open WebUI](https://github.com/open-webui/open-webui) | 144429 | AI interface，长期维护多模型、多 Provider、工具、会话和 UI。它适合作为 Provider/模型/会话边界参考：用户态配置、运行态状态、模型适配层要分开。 |
| [Telegraf](https://github.com/influxdata/telegraf) | 17691 | 长期维护的 agent/pipeline 项目，强调 input/process/output 插件边界。Bridge 的飞书事件、队列、Codex 执行、飞书回复也适合按这种 pipeline 思路拆分。 |

这些项目不是照抄对象。Codex 飞书 Bridge 仍应保持轻量、单机、Windows 友好；借鉴的是边界划分和贡献入口，而不是引入重型框架。

## 设计原则

1. 行为优先：每次迁移先保持行为不变，再谈抽象优化。
2. 小步验证：每拆一个边界就运行 `npm run check`，避免累计破坏。
3. 模块化单体：不引入服务拆分，不新增数据库服务，不改变每个 Bot 的进程模型。
4. 入口编排化：`codex-feishu-bridge.mjs` 保留启动、组装和核心流程，工具、状态、Provider、命令、附件等逐步外移。
5. 运行安全：重启只处理 active run 为 0 的 Bot；有 active run 的 Bot 跳过。
6. 开源友好：新增功能必须有明确目录归属，PR 不应要求编辑上万行主文件。

## 目标目录树

```text
codex-feishu-bridge/
  codex-feishu-bridge.mjs
  src/
    attachments/
      pending.mjs
      download.mjs
    codex/
      app-server-client.mjs
      app-server-runner.mjs
      exec-runner.mjs
      thread-registry.mjs
    commands/
      parser.mjs
      registry.mjs
      handlers/
        admin.mjs
        goal.mjs
        provider.mjs
        queue.mjs
        session.mjs
    config/
      env.mjs
      paths.mjs
      service-tier.mjs
    feishu/
      events.mjs
      lark-cli.mjs
      messages.mjs
      cards/
        managed-card.mjs
        render-run-card.mjs
    goals/
      goal-runner.mjs
      steer.mjs
    logging/
      errors.mjs
      logger.mjs
    providers/
      codex-config.mjs
      registry.mjs
    queue/
      dispatcher.mjs
      pending-events.mjs
    runtime/
      active-runs.mjs
      recalled-messages.mjs
      seen-events.mjs
      shutdown.mjs
      single-instance-lock.mjs
    sessions/
      normalize.mjs
      store.mjs
      codex-index.mjs
      list-renderer.mjs
  scripts/
    check-syntax.mjs
  docs/
  test/
```

## 已落地的第一版骨架

本次重构先完成低风险、高复用边界，形成后续继续拆分的稳定骨架：

- `src/logging/errors.mjs`：错误文本、失败分类、空响应失败、失败对象归一化。
- `src/logging/logger.mjs`：日志行格式和输出。
- `src/config/env.mjs`：默认工具、数据目录、环境变量解析、超时、profile、run mode。
- `src/config/paths.mjs`：Windows 长路径前缀剥离和路径等价判断。
- `src/config/service-tier.mjs`：fast/standard/service_tier 计划、降级判断、Provider 展示文本。
- `src/providers/codex-config.mjs`：Codex `config.toml` 读取、Provider 列表、Provider bundle、顶层配置写入。
- `src/runtime/seen-events.mjs`：飞书事件去重、event-lock 文件、历史 seen-events。
- `src/runtime/active-runs.mjs`：`active-runs.json` 加载、保存、record/touch/clear。
- `src/runtime/recalled-messages.mjs`：撤回消息 TTL 缓存。
- `src/attachments/pending.mjs`：附件 pending、过期清理、取出、按消息删除。
- `src/commands/parser.mjs`：斜杠命令解析和用户文本归一化。
- `src/sessions/normalize.mjs`：Goal、时间戳、token usage、context usage 归一化。
- `scripts/check-syntax.mjs`：递归检查入口、控制面板和 `src` 模块语法。

## 后续迁移路线

### 阶段 1：运行时状态继续收口

目标：把进程锁、shutdown、pending queue 这类运行时状态从主文件移出。

候选模块：

- `src/runtime/single-instance-lock.mjs`
- `src/runtime/shutdown.mjs`
- `src/queue/pending-events.mjs`
- `src/queue/dispatcher.mjs`

验收标准：

- `bridge.pid`、`bridge.lock.json`、`bridge.stop` 行为不变。
- `/queue`、`/clearqueue`、`/stop queue` 行为不变。
- active run 计数不误判。

### 阶段 2：Feishu adapter

目标：把 lark-cli 调用、事件字段解析、文本/markdown 回复、卡片发送与刷新拆出。

候选模块：

- `src/feishu/events.mjs`
- `src/feishu/lark-cli.mjs`
- `src/feishu/messages.mjs`
- `src/feishu/cards/managed-card.mjs`
- `src/feishu/cards/render-run-card.mjs`

验收标准：

- 普通消息、回复消息、线程回复、撤回消息都正常。
- 动态卡片创建、节流刷新、最终 flush 行为不变。
- 飞书接口失败分类仍能显示给用户。

### 阶段 3：Sessions 和 Codex thread inventory

目标：把 `sessions.json` store、Codex DB/session_index/global-state 合并列表、异常绑定修复拆出。

候选模块：

- `src/sessions/store.mjs`
- `src/sessions/codex-index.mjs`
- `src/sessions/list-renderer.mjs`
- `src/codex/thread-registry.mjs`

验收标准：

- `/list`、`/new`、`/switch`、`/delete` 行为不变。
- 缺失 rollout、桌面镜像、源空间完整等状态展示不变。
- 空当前会话保留策略不变。

### 阶段 4：Codex runner

目标：把 app-server turn、resume、stream recovery、exec fallback 从主文件抽成 runner。

候选模块：

- `src/codex/app-server-client.mjs`
- `src/codex/app-server-runner.mjs`
- `src/codex/exec-runner.mjs`

验收标准：

- 普通提问、长任务、工具流式输出、断流恢复、空响应 fallback 行为不变。
- 之前修过的“队列任务结束后不继续处理下一条消息”不能回退。
- `active-runs.json` 仍能准确记录和清理。

### 阶段 5：Commands registry 和 handlers

目标：把超长 `handleCommand` 拆成 registry + handler。

候选模块：

- `src/commands/registry.mjs`
- `src/commands/handlers/provider.mjs`
- `src/commands/handlers/session.mjs`
- `src/commands/handlers/goal.mjs`
- `src/commands/handlers/queue.mjs`
- `src/commands/handlers/admin.mjs`

验收标准：

- 所有斜杠命令行为不变。
- 新增命令只需新增 handler 并注册。
- 命令 handler 不直接依赖无关全局变量，通过 context 注入能力。

## 为什么不是一次性拆完

`codex-feishu-bridge.mjs` 的剩余大块主要集中在 Codex 执行流、飞书卡片渲染、Goal loop、会话索引合并和命令 handler。这些部分共享大量运行时状态，且当前多 Bot 在线运行。一次性大搬迁会增加三个风险：

- 出现循环依赖或初始化顺序错误。
- 语法检查通过但运行期事件流中断。
- 重启后 active run、卡片、队列状态与真实 Codex 进程不一致。

因此最佳架构不是“今天强行拆空主文件”，而是先建立模块化骨架和检查机制，再按业务边界逐段迁移。入口文件会逐步变薄，但每一步都必须可验证、可回滚、可同步到旧设备。

## 重启策略

- 只改文档：不需要重启 Bot。
- 修改 `codex-feishu-bridge.mjs` 或 `src/**/*.mjs`：需要重启对应 Bot 的 Bridge 进程。
- 修改控制面板后端：需要重启控制面板。
- 重启时只处理 active run 为 0 的 Bot。
- active run 大于 0 的 Bot 明确跳过，等空闲后补重启。

## 完成标准

- `npm run check` 通过，并覆盖 `src` 模块。
- GitHub、本机、旧设备处于同一 commit。
- 新旧设备空闲 Bot 已重启并在线。
- 有 active run 的 Bot 被明确列出并跳过。
- 后续新增 Provider、命令、附件、运行时状态、会话归一化时有清晰目录入口。
