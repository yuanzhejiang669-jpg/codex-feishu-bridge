import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AntigravityAcpClient, antigravityContent } from './acp-client.mjs';
import configuration from './configuration.cjs';
import accountLock from './account-lock.cjs';
import { feishuMcpConfiguration } from '../claude/feishu-tools.mjs';

const { readCatalog, readJson, atomicJson, selectProvider, assertOfficialAccount, EFFORTS, NATIVE_MODES } = configuration;

export function nativeMcpServers(config, event, environment = process.env) {
  if (config.disableMcp) return [];
  const definitions = {};
  for (const file of [config.antigravityMcpConfig, path.join(config.antigravityHome, 'config', 'mcp_config.json'), path.join(config.workspace, '.mcp.json')]) {
    if (!file || !fs.existsSync(file)) continue;
    // The native CLI creates an empty global MCP file on first startup.
    // Empty means no global servers; malformed non-empty JSON still fails.
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
    if (text) Object.assign(definitions, JSON.parse(text).mcpServers || {});
  }
  if (config.larkCli && event) Object.assign(definitions, JSON.parse(feishuMcpConfiguration(config, event)).mcpServers);
  const expand = (value) => String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, key, fallback) => {
    if (environment[key] != null) return environment[key];
    if (fallback != null) return fallback;
    throw new Error(`MCP 需要环境变量 ${key}，当前进程未加载`);
  });
  return Object.entries(definitions).filter(([, item]) => item && item.disabled !== true).map(([name, item]) => {
    if (item.command) return { name, command: expand(item.command), args: (item.args || []).map(expand), env: Object.entries(item.env || {}).map(([key, value]) => ({ name: key, value: expand(value) })) };
    if (item.type && !['http', 'sse'].includes(item.type)) throw new Error(`MCP ${name} 的传输类型不受 ACP 支持`);
    if (item.serverUrl || item.url) return { type: item.type === 'sse' ? 'sse' : 'http', name, url: item.serverUrl || item.url,
      headers: Object.entries(item.headers || {}).map(([key, value]) => ({ name: key, value: expand(value) })) };
    throw new Error(`MCP ${name} 缺少 command 或 URL`);
  });
}

export function createAntigravityBridge({ config, getSession, getChatState, getChats, resetSession, saveSessions,
  userText, sendMarkdown, activeChildren, activeJobs, appendText, reduceEvent, markPhase,
  ensureDone, markInterrupted, markError, queueSummary, sharedSessions,
  createClient = (options) => new AntigravityAcpClient(options) }) {
  const clients = new Set(); const permissions = new Map(); const listViews = new Map(); const deleteViews = new Map();
  const runtimePath = path.join(config.stateDir, 'antigravity-runtime.json');
  const catalogRoot = config.antigravityDataRoot;
  const botConfiguration = () => config.antigravityBotConfig ? readJson(config.antigravityBotConfig, {}) : {};
  function settings(session) {
    const bot = botConfiguration();
    const provider = selectProvider(catalogRoot, session?.providerOverride || bot.provider?.id || 'official');
    return { model: session?.modelOverride || bot.provider?.model || provider.model || '', provider: provider.id,
      accountAlias: provider.accountId || '', reasoning: session?.reasoningOverride || bot.provider?.reasoning || provider.effort || '',
      requestedReasoning: session?.reasoningOverride || bot.provider?.reasoning || provider.effort || '',
      permissionMode: bot.antigravity?.permissionMode || 'default', reasoningMapping: { supported: true, mapped: false }, serviceTier: '' };
  }
  const viewKey = (event) => `${event.chat_id}\0${event.sender_id || ''}`;
  function resolveSession(event, target) {
    const chat = getChatState(event.chat_id);
    if (/^[1-9]\d*$/.test(target)) {
      const view = listViews.get(viewKey(event));
      if (!view || Date.now() - view.at > 5 * 60_000) throw new Error('请先 /list 获取最新会话序号');
      return chat.sessions.find((item) => item.id === view.ids[Number(target) - 1]);
    }
    return chat.sessions.find((item) => item.id === target || item.antigravitySessionId === target);
  }
  async function requestPermission(event, request) {
    const token = crypto.randomBytes(6).toString('hex');
    let resolve;
    const answer = new Promise((done) => { resolve = done; });
    const timer = setTimeout(() => { permissions.delete(token); resolve(false); }, 30 * 60_000); timer.unref?.();
    permissions.set(token, { resolve, timer, event, chatId: event.chat_id, senderId: event.sender_id || '' });
    try {
      const tool = request.toolCall || {};
      await sendMarkdown(event.chat_id, `Antigravity 申请执行 **${tool.title || tool.name || tool.kind || '工具'}**\n\n`
        + `\`\`\`json\n${JSON.stringify(tool.rawInput || tool.args || {}, null, 2).slice(0, 4500)}\n\`\`\`\n\n`
        + `允许一次：\`/approve ${token}\`\n拒绝：\`/deny ${token}\``, 'antigravity-permission', event.message_id);
      return await answer;
    } finally { clearTimeout(timer); permissions.delete(token); }
  }
  function newClient(session, event, onEvent = () => {}) {
    const selected = settings(session);
    const provider = selectProvider(catalogRoot, selected.provider);
    assertOfficialAccount(catalogRoot, provider);
    const apiKey = provider.mode === 'gemini-api' ? process.env[provider.envKey] : '';
    if (provider.mode === 'gemini-api' && !apiKey) throw new Error(`渠道 ${provider.name} 密钥尚未加载，请在客户端保存渠道后重启空闲 Bot`);
    return createClient({ command: config.antigravityCli.command, cwd: session.antigravityWorkspace || config.workspace,
      geminiDir: sharedSessions?.sessionHome(session) || config.antigravityHome, logFile: path.join(config.logDir, 'antigravity-acp.log'),
      provider: { ...provider, apiKey }, permissionMode: selected.permissionMode,
      additionalDirectories: [config.antigravityToolsRoot].filter(Boolean), idleTimeoutMs: config.codexIdleTimeoutMs,
      onPermission: (request) => requestPermission(event, request), onEvent,
      onStarted: (child) => { activeChildren.set(child.pid, { child, label: 'Antigravity CLI' }); },
      onClosed: (child) => { activeChildren.delete(child.pid); },
    });
  }
  async function run(event, session, state, onState, contentOverride) {
    if (session.engine && session.engine !== 'antigravity') throw new Error('此会话属于其他内核，请 /new 创建 Antigravity 会话');
    const selected = settings(session); const startedAt = Date.now();
    const releaseSession = sharedSessions?.acquire(session);
    let releaseAccount;
    try { releaseAccount = accountLock.acquireOfficialLease(catalogRoot, selectProvider(catalogRoot, selected.provider)); }
    catch (error) { releaseSession?.(); throw error; }
    let flushTimer; let flushing = Promise.resolve();
    const flush = () => { clearTimeout(flushTimer); flushTimer = null; flushing = flushing.then(() => onState?.(state)); return flushing; };
    const schedule = () => { if (!flushTimer) flushTimer = setTimeout(() => { void flush().catch(() => {}); }, 150); };
    let initialized = false;
    let client;
    try { client = newClient(session, event, (item) => {
      const update = item.update;
      if (item.type === 'session_info_update' && update.title && !session.userRenamed) { session.title = update.title; saveSessions(); }
      if (item.type === 'usage_update') {
        session.lastContextUsage = { usedTokens: update.used, contextWindow: update.size,
          percent: update.size > 0 ? Math.round(update.used / update.size * 1000) / 10 : null, updatedAt: Date.now() };
        if (state) state.meta.contextUsage = session.lastContextUsage;
        saveSessions();
      }
      if (!state) return;
      if (item.type === 'agent_message_chunk' && update.content?.type === 'text') { appendText(state, update.content.text); markPhase(state, 'model_streaming', { connection: 'connected' }); }
      else if (item.type === 'agent_thought_chunk') markPhase(state, 'model_thinking', { connection: 'connected' });
      else if (item.type === 'tool_call') reduceEvent(state, { type: 'item.started', item: { type: 'tool', id: update.toolCallId, name: update.name || update.title || update.kind, input: update.rawInput || update.args } });
      else if (item.type === 'tool_call_update' && ['completed', 'failed'].includes(update.status)) reduceEvent(state, { type: 'item.completed', item: { type: 'tool', id: update.toolCallId, name: update.name || update.title || update.kind, output: update.rawOutput || update.content, status: update.status === 'failed' ? 'error' : 'completed' } });
      else if (initialized) markPhase(state, 'model_thinking', { connection: 'connected' });
      schedule();
    }); } catch (error) { releaseAccount(); releaseSession?.(); throw error; }
    clients.add(client);
    const job = { client, mode: 'antigravity', sessionId: session.id, messageId: event.message_id || event.id, startedAt };
    activeJobs.set(event.chat_id, job);
    try {
      if (state) { state.meta.engine = 'antigravity'; markPhase(state, 'initializing', { connection: 'starting' }); await flush(); }
      // Record the exact source. Switching a channel must not silently replay into an unrelated native session.
      if (session.antigravitySourceId && session.antigravitySourceId !== selected.provider) {
        throw new Error('此原生会话已绑定另一渠道。请切回原渠道继续，或 /new 创建新会话后使用新渠道。');
      }
      const opened = await client.openSession({ sessionId: session.antigravitySessionId || '',
        mcpServers: nativeMcpServers({ ...config, workspace: session.antigravityWorkspace || config.workspace }, event), model: selected.model, effort: selected.reasoning, mode: selected.permissionMode });
      initialized = true;
      session.engine = 'antigravity'; session.antigravitySessionId = opened.sessionId; session.antigravitySourceId = selected.provider;
      session.antigravityHome ||= config.antigravityHome; session.antigravityWorkspace ||= config.workspace; saveSessions();
      atomicJson(runtimePath, { engine: 'antigravity', version: client.runtime.agentInfo?.version,
        sessionId: opened.sessionId, pid: client.child?.pid, provider: selected.provider,
        accountId: selected.accountAlias, models: opened.models, configOptions: opened.configOptions,
        modes: opened.modes, observedAt: new Date().toISOString(), geminiDir: config.antigravityHome });
      Object.assign(job, { pid: client.child.pid, threadId: opened.sessionId });
      if (state) { state.threadId = opened.sessionId; markPhase(state, 'model_thinking', { connection: 'connected' }); await flush(); }
      const result = await client.prompt(antigravityContent(contentOverride ?? userText(event.content), event.attachments));
      if (/^\s*⚠\s*agent executor error:/u.test(result.text)) throw new Error(result.text.trim());
      const usage = result.usage || {};
      session.lastTokenUsage = { total: { inputTokens: usage.inputTokens || 0, outputTokens: usage.outputTokens || 0,
        totalTokens: usage.totalTokens || 0 }, modelContextWindow: session.lastContextUsage?.contextWindow || null };
      saveSessions();
      if (state) { state.meta.inputTokens = usage.inputTokens || 0; state.meta.outputTokens = usage.outputTokens || 0;
        ensureDone(state, result.text); state.meta.durationMs = Date.now() - startedAt; await flush(); }
      return { text: result.text || '(Antigravity 没有返回文字)', durationMs: Date.now() - startedAt,
        tokens: `${usage.inputTokens || 0}↑ ${usage.outputTokens || 0}↓` };
    } catch (error) {
      error.engine = 'antigravity';
      if (state) { if (error.code === 'USER_STOP') markInterrupted(state); else markError(state, error); await flush(); }
      throw error;
    } finally {
      for (const [token, pending] of permissions) if (pending.event === event) { clearTimeout(pending.timer); pending.resolve(false); permissions.delete(token); }
      clearTimeout(flushTimer); clients.delete(client); await client.close();
      releaseAccount(); releaseSession?.();
      if (activeJobs.get(event.chat_id)?.client === client) activeJobs.delete(event.chat_id);
    }
  }
  async function discoverModels(session, event) {
    const releaseSession = sharedSessions?.acquire(session);
    let releaseAccount; let client;
    try {
      releaseAccount = accountLock.acquireOfficialLease(catalogRoot, selectProvider(catalogRoot, settings(session).provider));
      client = newClient(session, event); clients.add(client);
      const result = await client.openSession({ sessionId: session.antigravitySessionId || '', mcpServers: nativeMcpServers(config, event) });
      if (!session.antigravitySessionId) { session.antigravitySessionId = result.sessionId; session.antigravitySourceId = settings(session).provider; saveSessions(); }
      atomicJson(runtimePath, { models: result.models, configOptions: result.configOptions, modes: result.modes,
        version: client.runtime.agentInfo?.version, observedAt: new Date().toISOString(), provider: settings(session).provider });
      return result;
    } finally { clients.delete(client); await client?.close(); releaseAccount?.(); releaseSession?.(); }
  }
  async function handleCommand(event, command) {
    const chat = getChatState(event.chat_id); const session = getSession(event.chat_id);
    const reply = (text) => sendMarkdown(event.chat_id, text, `antigravity-${command.name.slice(1)}`, event.message_id || event.id);
    if (['/stop', '/stopall', '/queue', '/clearqueue', '/clearqueueall'].includes(command.name)) return false;
    if (['/approve', '/deny'].includes(command.name)) {
      const pending = permissions.get(command.rest.trim());
      if (!pending || pending.chatId !== event.chat_id || (pending.senderId && pending.senderId !== event.sender_id)) await reply('工具请求已过期或不属于当前用户。');
      else { pending.resolve(command.name === '/approve'); await reply(command.name === '/approve' ? '已允许本次调用。' : '已拒绝本次调用。'); }
      return true;
    }
    if (command.name === '/help') {
      await reply(['**Antigravity Bot · 官方 CLI / ACP**',
        '/new [标题] · /list · /switch 序号 · /rename 标题 · /reset',
        '/delete 序号 · /confirm delete 序号（删除共享 Bridge 绑定，保留原生历史）',
        '/provider list · /provider 渠道ID · /model list · /model 模型ID',
        '/effort low|medium|high|xhigh|max（以原生模型实际支持为准）',
        '/mode default|accept-edits|auto|plan · /context · /status',
        '/stop · /stopall · /queue · /clearqueue',
        '原生技能与 /compact、/plan、/goal 等命令通过正常任务队列交给 Antigravity。',
        '官方账号登录与手动切换请在客户端的 Antigravity 区域操作；不会自动轮换账号。'].join('\n')); return true;
    }
    if (command.name === '/new' || command.name === '/reset') {
      if (activeJobs.has(event.chat_id)) { await reply('当前任务仍在运行，请先 /stop 或等待完成。'); return true; }
      const next = resetSession(event.chat_id, command.rest || '新 Antigravity 会话');
      if (command.name === '/reset') for (const key of ['providerOverride', 'modelOverride', 'reasoningOverride']) next[key] = session[key];
      saveSessions(); await reply(`已创建 Antigravity 会话：${next.title} (${next.id})`); return true;
    }
    if (['/list', '/sessions'].includes(command.name)) {
      listViews.set(viewKey(event), { at: Date.now(), ids: chat.sessions.map((item) => item.id) });
      await reply('**Antigravity 共享会话库**\n' + chat.sessions.map((item, index) => `${index + 1}. ${item.id === chat.currentSessionId ? '● ' : ''}${item.title} · ${item.id}${item.antigravityOriginBot ? ` · ${item.antigravityOriginBot}` : ''}`).join('\n')); return true;
    }
    if (command.name === '/switch') {
      if (activeJobs.has(event.chat_id)) { await reply('当前任务仍在运行，请先 /stop 或等待完成。'); return true; }
      const target = resolveSession(event, command.rest.trim());
      if (!target) { await reply('未找到会话，请先 /list。'); return true; }
      sharedSessions?.assertIdle(target);
      chat.currentSessionId = target.id; saveSessions(); await reply(`已切换：${target.title} (${target.id})`); return true;
    }
    if (command.name === '/rename') {
      if (!command.rest.trim()) { await reply('用法：/rename 新标题'); return true; }
      const match = command.rest.trim().match(/^(\d+|[a-f0-9-]{12,})\s+(.+)$/i);
      const target = match ? resolveSession(event, match[1]) : session;
      if (!target) throw new Error('未找到会话，请先 /list');
      sharedSessions?.assertIdle(target);
      target.title = (match ? match[2] : command.rest.trim()).slice(0, 160); target.userRenamed = true; saveSessions(); await reply(`已重命名：${target.title}`); return true;
    }
    if (['/delete', '/del', '/rm'].includes(command.name)) {
      const target = resolveSession(event, command.rest.trim());
      if (!target) { await reply('未找到会话，请先 /list，再 /delete 序号。'); return true; }
      deleteViews.set(viewKey(event), { id: target.id, nativeId: target.antigravitySessionId || '', selector: command.rest.trim(), at: Date.now() });
      sharedSessions?.assertIdle(target);
      await reply(`删除预览：${target.title} (${target.id})\n确认：/confirm delete ${command.rest.trim()}\n删除所有 Antigravity Bot 中的此共享 Bridge 绑定；原生历史和工作区文件保留。`); return true;
    }
    if (command.name === '/confirm') {
      const pending = deleteViews.get(viewKey(event));
      if (!pending || Date.now() - pending.at > 5 * 60_000 || command.rest.trim() !== `delete ${pending.selector}`) { await reply('删除确认无效或过期，请重新 /delete 预览。'); return true; }
      const target = chat.sessions.find((item) => item.id === pending.id);
      if (!target || (target.antigravitySessionId || '') !== pending.nativeId) throw new Error('会话绑定已变化，请重新预览');
      if ([...activeJobs.values()].some((job) => job.sessionId === target.id)) throw new Error('会话正在运行，不能删除');
      const release = sharedSessions?.acquireMany([target]);
      try {
        sharedSessions?.remove([target.id]);
        chat.sessions = chat.sessions.filter((item) => item.id !== target.id);
        if (chat.currentSessionId === target.id) chat.currentSessionId = chat.sessions[0]?.id || '';
        deleteViews.delete(viewKey(event)); saveSessions();
      } finally { release?.(); }
      await reply('已删除所选共享 Bridge 会话绑定，原生历史与文件保留。'); return true;
    }
    if (['/status', '/now', '/how', '/context'].includes(command.name)) {
      const selected = settings(session); const usage = session.lastContextUsage;
      await reply(`内核：Antigravity CLI / ACP\n渠道：${selected.provider}\n模型：${selected.model || '官方默认'}\n思考强度：${selected.reasoning || '官方默认'}\n权限：${selected.permissionMode}\n工作区：${config.workspace}\n会话：${session.title} (${session.id})\n原生会话：${session.antigravitySessionId || '尚未创建'}\n上下文：${usage ? `${usage.usedTokens} / ${usage.contextWindow || '未知'} tokens` : '等待原生使用量事件'}\n${queueSummary?.(event.chat_id) || ''}`); return true;
    }
    if (command.name === '/provider') {
      const parts = command.rest.trim().split(/\s+/).filter(Boolean);
      if (!parts.length || parts[0] === 'list') { await reply(`当前渠道：${settings(session).provider}\n` + readCatalog(catalogRoot).providers.map((item) => `${item.id} · ${item.name} · ${item.mode}`).join('\n')); return true; }
      if (activeJobs.has(event.chat_id)) throw new Error('当前任务仍在运行，不能切换渠道');
      sharedSessions?.assertIdle(session);
      if (parts[0] === 'clear') { delete session.providerOverride; delete session.modelOverride; delete session.reasoningOverride; saveSessions(); await reply('已清除会话渠道覆盖，使用 Bot 默认配置。原生会话仍绑定原渠道。'); return true; }
      if (parts[0] === 'save') { const bot = botConfiguration(); bot.provider = { ...bot.provider, id: settings(session).provider, model: settings(session).model, reasoning: settings(session).reasoning }; atomicJson(config.antigravityBotConfig, bot); await reply('已将当前渠道、模型和强度保存为本 Bot 默认值。'); return true; }
      const provider = selectProvider(catalogRoot, parts[0]); assertOfficialAccount(catalogRoot, provider);
      if (session.antigravitySessionId && session.antigravitySourceId !== provider.id) { await reply('原生会话绑定了原渠道。请先 /new，再切换渠道；已有会话仍可切回继续。'); return true; }
      session.providerOverride = provider.id; session.modelOverride = provider.model || ''; session.reasoningOverride = provider.effort || '';
      saveSessions(); await reply(`已选择渠道 ${provider.name}；下一轮由官方 CLI 使用该渠道。`); return true;
    }
    if (command.name === '/model') {
      const parts = command.rest.trim().split(/\s+/).filter(Boolean);
      if (!parts.length || ['list', 'refresh'].includes(parts[0])) {
        if (activeJobs.has(event.chat_id)) throw new Error('当前任务仍在运行，请结束后查询原生模型目录');
        const result = await discoverModels(session, event);
        await reply(`原生 CLI 实时模型目录：\n${(result.models?.availableModels || []).map((item) => `${item.modelId} · ${item.name}`).join('\n')}`); return true;
      }
      if (activeJobs.has(event.chat_id)) throw new Error('当前任务仍在运行，不能切换模型');
      sharedSessions?.assertIdle(session);
      if (parts[0] === 'clear') { delete session.modelOverride; delete session.reasoningOverride; saveSessions(); await reply('已清除会话模型和强度覆盖。'); return true; }
      if (parts[0] === 'save') { const bot = botConfiguration(); bot.provider = { ...bot.provider, model: settings(session).model, reasoning: settings(session).reasoning }; atomicJson(config.antigravityBotConfig, bot); await reply('已保存为本 Bot 默认模型和强度。'); return true; }
      const result = await discoverModels(session, event);
      if (!(result.models?.availableModels || []).some((item) => item.modelId === parts[0])) throw new Error('模型不在当前 CLI 原生目录中，请 /model list 查看');
      session.modelOverride = parts[0]; if (parts[1]) { if (!EFFORTS.has(parts[1])) throw new Error('思考强度无效'); session.reasoningOverride = parts[1]; }
      saveSessions(); await reply(`已选择模型：${session.modelOverride}`); return true;
    }
    if (command.name === '/effort') {
      if (!command.rest) { await reply(`当前：${settings(session).reasoning || '官方默认'}。用法：/effort low|medium|high|xhigh|max`); return true; }
      if (activeJobs.has(event.chat_id)) throw new Error('当前任务仍在运行，不能修改思考强度');
      sharedSessions?.assertIdle(session);
      if (!EFFORTS.has(command.rest.trim())) throw new Error('思考强度无效');
      session.reasoningOverride = command.rest.trim(); saveSessions(); await reply('已保存强度；下一轮交给原生模型校验，不会静默降档。'); return true;
    }
    if (command.name === '/mode') {
      const value = command.rest.trim();
      if (!value) { await reply(`当前权限模式：${settings(session).permissionMode}`); return true; }
      if (!NATIVE_MODES.has(value) || value === 'always-proceed') throw new Error('支持 default、accept-edits、auto、plan；全自动授权请在客户端显式设置');
      if (activeJobs.has(event.chat_id)) throw new Error('当前任务仍在运行');
      const bot = botConfiguration(); bot.antigravity = { ...bot.antigravity, permissionMode: value }; atomicJson(config.antigravityBotConfig, bot);
      await reply(`下一轮使用原生模式：${value}`); return true;
    }
    // Advertised native slash commands and Skills are handled by the regular task queue.
    return false;
  }
  function close() {
    for (const client of clients) { client.interrupt(); client.close(); }
    for (const pending of permissions.values()) { clearTimeout(pending.timer); pending.resolve(false); }
    clients.clear(); permissions.clear();
  }
  return { run, handleCommand, settings, close };
}
