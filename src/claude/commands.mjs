import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile, writeJsonFileAtomicSync } from '../utils/json.mjs';
import { claudeSessionArtifacts } from './session-deletion.mjs';
import nativeLock from '../sessions/native-lock.cjs';
import claudeDefaults from './defaults.cjs';
const { lockDirectoryAsync } = nativeLock;
const { claudeDataRootFromConfig, readClaudeEngineDefaults, writeClaudeEngineDefaults } = claudeDefaults;

export const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const effortOf = (value) => String(value || '').trim().toLowerCase();

export function claudeCompactionSettings(config) {
  const home = readJsonFile(path.join(config.claudeHome, 'settings.json')) || {};
  const raw = home.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? home.autoCompactWindow;
  const window = Number(raw);
  return { window: window > 0 && Number.isFinite(window) ? window : null,
    enabled: home.autoCompactEnabled !== false && !['1', 'true'].includes(String(home.env?.DISABLE_AUTO_COMPACT || '').toLowerCase()) };
}

export function claudeHelpMarkdown({ shared = false } = {}) {
  return [
    '**Claude Bot 命令**', '',
    '`/help` — 显示帮助',
    '`/status` — 查看内核、模型、渠道、权限和工具状态',
    '`/now` / `/how` — 查看工作区、当前会话、任务和队列',
    '`/context` — 查看原生会话、请求 tokens、配置压缩窗口和最近压缩时间',
    '`/new [标题]` — 创建独立会话',
    shared ? '`/list [all]` / `/sessions [all]` — 列出全部 Claude Bot 共用的会话（`/list all` 含本机原生 CLI 会话）；序号以最近一次列表为准' : '`/list [all]` / `/sessions` — 列出当前 Bot 的会话',
    '`/switch <序号或ID>` — 切换会话',
    '`/rename 新标题` / `/rename <序号> 新标题` — 修改当前或指定会话名称',
    '`/delete 序号或ID` — 预览删除，支持 `1 2 3`、`1-18`、`3-7 8-12`',
    shared ? '`/confirm delete <序号或区间>` — 从所有 Claude Bot 的共享会话库删除；保留工作区文件' : '`/confirm delete <序号或区间>` — 确认删除当前 Bot 的本地会话记录；保留工作区文件',
    '`/reset` — 清空当前会话上下文，保留模型与渠道设置',
    '`/provider` / `/provider list` — 查看当前渠道或全部 Claude 渠道',
    '`/provider <id>` / `/provider save <id>` / `/provider clear` — 切换渠道、保存为全部 Claude Bot 引擎默认或恢复默认',
    '`/provider shortcuts` — 查看渠道快捷方式',
    '`/model` / `/model list` / `/model capability` — 查看当前模型、刷新渠道模型或查看 CLI 强度选项',
    '`/model <模型ID> [强度]` — 切换当前会话模型和思考强度',
    '`/model effort <强度|clear>` / `/model reasoning <强度|clear>` / `/effort <强度|clear>` — 切换或清除强度覆盖',
    '`/model save [模型ID] [强度]` / `/model save effort <强度>` — 保存为全部 Claude Bot 引擎默认',
    '`/model clear` — 恢复 Claude 引擎默认模型与强度',
    '`/model test <模型ID>` — 独立短请求测活，不续写当前会话',
    '`/compact [保留重点]` — 调用 Claude 原生手动压缩；任务运行中请先等结束或 /stop',
    '`/steer <补充内容>` — 向运行中的同一个 Claude 任务追加指令，在工具调用结束后读取',
    '`/stop` — 停止当前任务',
    '`/stop queue` — 停止当前任务并清空当前聊天等待队列',
    '`/stop all` / `/stopall` — 停止当前任务并清空本 Bot 全部等待队列',
    '`/queue` / `/clearqueue [all]` / `/clearqueueall` — 查看或清空等待队列',
    '`/approve 请求码` / `/deny 请求码` — 回答工具授权请求', '',
    `强度：low、medium、high、xhigh、max。切换自动保存于当前${shared ? '共享' : ''}会话；save 同步为全部 Claude Bot 引擎默认，下一轮生效。`,
    shared ? '各 Bot 当前选择独立；同一共享会话同时只允许一个 Bot 执行。' : '',
    '自定义 /技能名 交给 Claude 原生 CLI；普通消息正文原样传递。',
    'Codex 原生 Goal 与 Codex Fast 不适用于 Claude CLI；/goal、/fast 会说明这一限制。',
  ].join('\n');
}

export function createClaudeCommands({ config, settings, botConfiguration, providers, saveSessions,
  activeJobs, getChatState, getSession, queueSummary = () => '无', testModel,
  refreshModels = null, now = Date.now, sharedSessions, resolveSession, accessContextFor,
  onConfigChange = null, hasWarm = null }) {
  const dataRoot = claudeDataRootFromConfig(config);
  function currentProvider(session) { return providers().find((p) => p.id === settings(session).provider); }
  function persistDefaults(patch, { enginePatch = null, providerMeta = null } = {}) {
    if (!config.claudeBotConfig) throw new Error('当前 Bot 没有可写的默认配置路径');
    const bot = botConfiguration();
    const provider = { ...bot.provider, ...patch };
    const nativePath = path.join(config.claudeHome, 'settings.json');
    const originalNative = readJsonFile(nativePath);
    const native = structuredClone(originalNative || {});
    if (provider.model) {
      native.model = provider.model;
      native.modelSettings = { ...native.modelSettings,
        [provider.model]: { ...native.modelSettings?.[provider.model], effortLevel: provider.reasoning || 'high' } };
    }
    const nowIso = new Date(now()).toISOString();
    // The Bot file is authoritative for subsequent launches. Preserve all unrelated settings.
    writeJsonFileAtomicSync(nativePath, native);
    try { writeJsonFileAtomicSync(config.claudeBotConfig, { ...bot, provider, configurationChangedAt: nowIso }); }
    catch (error) {
      // Roll back this operation's own native-settings write if the authoritative Bot write failed.
      if (originalNative) writeJsonFileAtomicSync(nativePath, originalNative);
      else fs.rmSync(nativePath, { force: true });
      throw error;
    }
    if (dataRoot) {
      writeClaudeEngineDefaults(dataRoot, enginePatch || patch, {
        currentBotConfig: config.claudeBotConfig,
        providerMeta,
        nowIso,
      });
    }
  }
  function changed(session) { session.updatedAt = now(); saveSessions(); }
  function validEffort(raw) {
    const value = effortOf(raw);
    if (!CLAUDE_EFFORTS.has(value)) throw new Error('Claude 可用强度：low、medium、high、xhigh、max');
    return value;
  }
  function modelStatus(session, title = 'Claude 模型设置') {
    const selected = settings(session);
    const bot = botConfiguration();
    const engineDefaults = dataRoot ? readClaudeEngineDefaults(dataRoot) : null;
    const botTs = Date.parse(bot?.configurationChangedAt || '') || 0;
    const defTs = Date.parse(engineDefaults?.updatedAt || '') || 0;
    const botNewer = botTs > 0 && defTs > 0 && botTs > defTs;
    const modelFromEngine = !botNewer && Boolean(engineDefaults?.model)
      && (!engineDefaults.modelProvider || engineDefaults.modelProvider === selected.provider)
      && engineDefaults.model === selected.model;
    const effortFromEngine = !botNewer && Boolean(engineDefaults?.reasoning)
      && engineDefaults.reasoning === selected.reasoning;
    const permLabel = selected.permissionMode === 'bypassPermissions'
      ? '`完全授权（bypassPermissions）`'
      : `\`${selected.permissionMode}\``;
    return [
      `**${title}**`,
      `当前会话：\`${session?.title || '未命名会话'}\` (${session?.id || '-'})`,
      `模型：\`${selected.model}\`${session.modelOverride ? '（会话覆盖）' : modelFromEngine ? '（引擎默认）' : '（Bot 默认）'}`,
      `思考强度：\`${selected.reasoning}\`${session.reasoningOverride ? '（会话覆盖）' : effortFromEngine ? '（引擎默认）' : '（Bot 默认）'}`,
      `渠道：\`${selected.provider}\``,
      `权限模式：${permLabel}`,
      '',
      '用法：`/model list`、`/model refresh`、`/model capability`、`/model test <模型ID>`、`/model <模型ID> [强度]`、`/model effort <强度|clear>`、`/model save [模型ID] [强度]`、`/model clear`',
    ].join('\n');
  }
  async function fetchModels(provider) {
    if (refreshModels) return refreshModels(provider);
    const apiKey = process.env[provider.envKey];
    if (!apiKey) throw new Error('渠道密钥不可用，请在客户端配置并应用');
    const url = `${provider.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/models`;
    const headers = { 'anthropic-version': '2023-06-01',
      ...(provider.auth === 'x-api-key' ? { 'x-api-key': apiKey } : { authorization: `Bearer ${apiKey}` }) };
    let response;
    try { response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) }); }
    catch { throw new Error('渠道 /models 查询超时或网络不可用'); }
    if (!response.ok) throw new Error(`渠道 /models 返回 HTTP ${response.status}`);
    let body;
    try { body = await response.json(); } catch { throw new Error('渠道 /models 未返回有效 JSON'); }
    const models = (body.data || body.models || []).map((m) => typeof m === 'string' ? m : m.id).filter((m) => typeof m === 'string' && m);
    if (!models.length) throw new Error('渠道 /models 没有返回模型');
    return [...new Set(models)];
  }
  async function handle(event, command, reply) {
    const accessCtx = accessContextFor ? accessContextFor(event) : undefined;
    const args = command.rest.trim().split(/\s+/).filter(Boolean);
    const action = (args[0] || '').toLowerCase();
    if (command.name === '/help') { await reply(claudeHelpMarkdown({ shared: Boolean(sharedSessions) })); return true; }
    if (!['/status', '/context', '/how', '/now', '/rename', '/provider', '/model', '/effort'].includes(command.name)) return false;
    const session = getSession(event.chat_id, accessCtx);
    if (['/status', '/context', '/how', '/now'].includes(command.name)) {
      const selected = settings(session); const job = activeJobs.get(event.chat_id);
      const compact = claudeCompactionSettings(config);
      const runtime = readJsonFile(path.join(config.stateDir, 'claude-runtime.json')) || {};
      await reply([`**Claude Bot ${command.name === '/context' ? '上下文' : '状态'}**`,
        '',
        '内核：`Claude Code CLI`', `Bot：\`${config.larkProfile}\``, `工作区：\`${config.workspace}\``,
        `当前会话：\`${session.title || '未命名会话'}\` (${session.id})`, `原生会话：${session.claudeSessionId ? `\`${session.claudeSessionId}\`` : '尚未创建'}`,
        `会话索引：\`${sharedSessions?.catalogFile || path.join(config.stateDir, 'sessions.json')}\``,
        `会话模式：${sharedSessions ? '全部 Claude Bot 共用；当前选择各自独立' : '当前 Bot 独立'}`,
        `Claude Home：\`${config.claudeHome}\``,
        ...(sharedSessions ? [`原生会话 Home：\`${sharedSessions.sessionHome(session)}\``, `会话工作区：\`${session.claudeWorkspace || config.workspace}\``] : []),
        `渠道：\`${selected.provider}\``, `模型：\`${selected.model}\``, `思考强度：\`${selected.reasoning}\``,
        `权限模式：${selected.permissionMode === 'bypassPermissions' ? '`完全授权（bypassPermissions）`' : `\`${selected.permissionMode}\``}`,
        `任务：${job ? '运行中' : '空闲'}${!job && hasWarm?.(event.chat_id) ? '（温热保活就绪，下轮免冷启动）' : ''}`, `队列：${queueSummary(event.chat_id)}`,
        `当前请求上下文：${session.lastContextUsage?.usedTokens ?? '未知'} tokens`,
        `配置压缩窗口：${compact.window ? `${compact.window.toLocaleString('en-US')} tokens` : '由 Claude Code 决定'}；自动压缩${compact.enabled ? '开启' : '关闭'}`,
        '实际触发时间由原生 CLI 决定，配置窗口不等于固定触发点。',
        `上次压缩：${session.lastCompactedAt ? new Date(session.lastCompactedAt).toLocaleString('zh-CN') : '未观察到'}`,
        `MCP：${runtime.mcpServers?.map((m) => `\`${m.name}\`（${m.status || '已发现'}）`).join('、') || '尚无本轮发现记录'}`,
        `Skills：${runtime.skills?.length ?? '未知'} 个；共享工具目录：${config.claudeToolsRoot ? `\`${config.claudeToolsRoot}\`` : '未配置'}`,
      ].join('\n')); return true;
    }
    if (command.name === '/rename') {
      if (activeJobs.has(event.chat_id)) throw new Error('当前会话正在运行，请等待本轮结束后再重命名。');
      const match = command.rest.trim().match(/^(\d+)\s+(.+)$/s);
      if (!command.rest.trim() || /^\d+$/.test(command.rest.trim())) {
        await reply('用法：/rename 新标题；或 /rename <list序号> 新标题。'); return true;
      }
      const target = match ? (resolveSession ? resolveSession(event, match[1]) : getChatState(event.chat_id, accessCtx).sessions[Number(match[1]) - 1]) : session;
      if (!target) throw new Error(`未找到可访问的会话：${match ? match[1] : ''}，请先发送 /list 查看可用序号。`);
      const title = (match ? match[2] : command.rest).trim().replace(/[\r\n]+/g, ' ').slice(0, 120);
      if (target.claudeSessionId) {
        for (const file of claudeSessionArtifacts(sharedSessions ? sharedSessions.sessionHome(target) : config.claudeHome, target.claudeSessionId).filter((p) => p.endsWith('.jsonl'))) {
          fs.appendFileSync(file, JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: target.claudeSessionId }) + '\n', 'utf8');
        }
      }
      target.title = title; changed(target); await reply(`会话已命名为：${title}`); return true;
    }
    if (command.name === '/provider') {
      if (!action) {
        const p = currentProvider(session);
        await reply(`当前 Claude 渠道：${p.name || p.id} (${p.id})\n${p.baseUrl}\n\n用法：/provider list、/provider <id>、/provider save <id>、/provider clear`); return true;
      }
      if (action === 'list' && !args[1]) {
        await reply(providers().map((p) => `${p.id}${p.id === settings(session).provider ? ' ← 当前' : ''} · ${p.name || p.id} · ${p.baseUrl}`).join('\n') || '尚无 Claude Provider'); return true;
      }
      if (['shortcuts', 'shortcut', 'bundles', 'bundle'].includes(action) || (action === 'list' && ['shortcuts', 'shortcut', 'bundles', 'bundle'].includes(args[1]))) {
        await reply('Claude 当前未配置旧渠道组合快捷方式。使用 /provider list 查看真实渠道。'); return true;
      }
      if (activeJobs.has(event.chat_id)) throw new Error('请在当前任务结束后更换渠道');
      if (['clear', 'default', 'reset'].includes(action)) {
        await onConfigChange?.(event.chat_id, 'provider-change');
        session.providerOverride = ''; session.modelOverride = ''; session.reasoningOverride = '';
        changed(session); await reply(modelStatus(session, '已恢复 Claude 引擎默认渠道、模型与强度')); return true;
      }
      const persist = action === 'save';
      const id = persist ? args[1] : args[0];
      if (!id || args.length > (persist ? 2 : 1)) throw new Error('用法：/provider <id>；或 /provider save <id>');
      const p = providers().find((item) => item.id === id);
      if (!p || !process.env[p.envKey]) throw new Error('Claude 渠道或密钥不可用，请在客户端配置并应用');
      await onConfigChange?.(event.chat_id, 'provider-change');
      if (persist) {
        persistDefaults(
          { mode: 'claude', id: p.id, name: p.name, baseUrl: p.baseUrl,
            envKey: p.envKey, wireApi: 'anthropic-messages', model: p.model, reasoning: p.effort || 'high' },
          { enginePatch: { provider: p.id, model: p.model, modelProvider: p.id, reasoning: p.effort || 'high' }, providerMeta: p },
        );
        session.providerOverride = ''; session.modelOverride = ''; session.reasoningOverride = '';
      } else {
        session.providerOverride = p.id; session.modelOverride = p.model; session.reasoningOverride = p.effort || 'high';
      }
      changed(session); await reply(modelStatus(session, persist ? '已切换并保存为全部 Claude Bot 引擎默认渠道' : '已切换当前会话渠道')); return true;
    }
    if (!['/model', '/effort'].includes(command.name)) return false;
    if (command.name === '/effort') {
      if (!action || ['status', 'view'].includes(action)) { await reply(modelStatus(session)); return true; }
      if (action === 'save') args.splice(0, 1, 'save', 'effort');
      else args.unshift('effort');
    }
    const op = (args[0] || '').toLowerCase();
    if (!op || ['status', 'view'].includes(op)) { await reply(modelStatus(session)); return true; }
    const provider = currentProvider(session);
    if (['list', 'refresh'].includes(op)) {
      let models = provider.models || [provider.model]; let notice = '';
      try {
        models = await fetchModels(provider);
        // Hold the shared cross-process lock around catalog read-modify-write so desktop & bridge edits never clobber each other.
        const lockDir = path.join(path.dirname(config.claudeProviderCatalog), 'claude-providers.lock');
        const releaseLock = await lockDirectoryAsync(lockDir, { purpose: 'claude-providers', bot: config.larkProfile || 'bridge' }, 3000);
        try {
          const catalog = JSON.parse(fs.readFileSync(config.claudeProviderCatalog, 'utf8'));
          const current = catalog.providers.find((p) => p.id === provider.id);
          if (current) {
            current.models = models;
            writeJsonFileAtomicSync(config.claudeProviderCatalog, catalog);
          }
        } finally {
          releaseLock();
        }
      } catch (error) { notice = `\n查询失败：${error.message}；以下使用已保存的模型列表。`; }
      const activeModel = settings(session).model;
      const formatted = models.map((m) => (m === activeModel ? `● \`${m}\` ← 当前` : `  \`${m}\``));
      await reply([
        '**Claude 可用模型列表**',
        `当前模型：\`${activeModel}\` · 思考强度：\`${settings(session).reasoning}\` · 渠道：\`${provider.id}\`${notice}`,
        '',
        formatted.join('\n'),
        '',
        '切换：`/model <模型ID> [强度]` · 测活：`/model test <模型ID>` · 设为默认：`/model save <模型ID> [强度]`',
      ].join('\n')); return true;
    }
    if (['capability', 'capabilities'].includes(op)) {
      await reply([
        '**Claude 模型能力说明**',
        `当前模型：\`${settings(session).model}\` · 思考强度：\`${settings(session).reasoning}\``,
        'Claude CLI 接受的强度：`low`、`medium`、`high`、`xhigh`、`max`。',
        '强度原样传给 CLI，渠道实际支持情况以请求结果为准。',
        '',
        '用法：`/model effort high`、`/effort high`、`/model <模型ID> high`、`/model test <模型ID>`',
      ].join('\n')); return true;
    }
    if (op === 'test') {
      const model = args[1] || settings(session).model;
      if (!(provider.models || [provider.model]).includes(model)) throw new Error('模型不在渠道列表中，请先 /model list');
      if (activeJobs.has(event.chat_id)) throw new Error('请在当前任务结束后测试模型');
      const result = await testModel(event, session, model);
      await reply(`Claude 模型测试成功\n模型：${model}\n渠道：${provider.id}\n耗时：${result.durationMs} ms\n结果：${result.text}`); return true;
    }
    if (activeJobs.has(event.chat_id)) throw new Error('当前任务运行中不能切换模型，请等待完成或 /stop 后再执行 /model。');
    if (['clear', 'default', 'reset'].includes(op)) {
      await onConfigChange?.(event.chat_id, 'model-change');
      session.modelOverride = ''; session.reasoningOverride = ''; changed(session);
      await reply(modelStatus(session, '已恢复 Claude 引擎默认模型与强度')); return true;
    }
    const persist = op === 'save';
    if (persist) args.shift();
    if (persist && !args.length) {
      const current = settings(session);
      await onConfigChange?.(event.chat_id, 'model-change');
      persistDefaults(
        { mode: 'claude', id: provider.id, name: provider.name, baseUrl: provider.baseUrl,
          envKey: provider.envKey, wireApi: 'anthropic-messages', model: current.model, reasoning: current.reasoning },
        { enginePatch: { model: current.model, modelProvider: provider.id, reasoning: current.reasoning } },
      );
      session.modelOverride = ''; session.reasoningOverride = '';
      changed(session);
      await reply(modelStatus(session, '已保存为全部 Claude Bot 引擎默认模型与强度'));
      return true;
    }
    const effortOnly = ['effort', 'reasoning'].includes((args[0] || '').toLowerCase());
    if (!args[0] || args.length > 2) throw new Error('用法：/model <模型ID> [强度]；/model effort <强度|clear>；可加 save 保存为引擎默认');
    if (effortOnly && !persist && ['clear', 'default', 'reset'].includes(effortOf(args[1]))) {
      await onConfigChange?.(event.chat_id, 'effort-change');
      session.reasoningOverride = '';
      changed(session);
      await reply(modelStatus(session, '已清除会话思考强度覆盖，恢复默认'));
      return true;
    }
    const model = effortOnly ? settings(session).model : args[0];
    const effort = effortOnly || args[1] ? validEffort(args[1]) : null;
    if (!(provider.models || [provider.model]).includes(model)) throw new Error('模型不在该渠道列表中，请先 /model list');
    await onConfigChange?.(event.chat_id, effortOnly ? 'effort-change' : 'model-change');
    if (persist) {
      if (effortOnly) {
        persistDefaults({ reasoning: effort }, { enginePatch: { reasoning: effort } });
        session.reasoningOverride = '';
      } else {
        const nextEffort = effort || settings(session).reasoning;
        persistDefaults(
          { mode: 'claude', id: provider.id, name: provider.name,
            baseUrl: provider.baseUrl, envKey: provider.envKey, wireApi: 'anthropic-messages',
            model, reasoning: nextEffort },
          { enginePatch: { model, modelProvider: provider.id, reasoning: nextEffort } },
        );
        session.modelOverride = '';
        session.reasoningOverride = '';
      }
    } else {
      if (!effortOnly) session.modelOverride = model;
      if (effort) session.reasoningOverride = effort;
    }
    changed(session); await reply(modelStatus(session, persist ? '已切换并保存为全部 Claude Bot 引擎默认' : '已切换当前会话设置；下一轮生效')); return true;
  }
  return { handle };
}
