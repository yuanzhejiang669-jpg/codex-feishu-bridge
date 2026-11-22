import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ClaudeCliClient } from './cli-client.mjs';
import { writeJsonFileAtomicSync } from '../utils/json.mjs';
import { feishuMcpConfiguration } from './feishu-tools.mjs';
import { createClaudeSessionDeletion } from './session-deletion.mjs';
import { createClaudeCommands } from './commands.mjs';

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function claudeContent(text, attachments = []) {
  const content = [];
  if (text) content.push({ type: 'text', text });
  if (attachments.length) content.push({ type: 'text', text: '[附件信息]\n' + JSON.stringify(attachments.map((item) => ({
    name: item.name || item.file_name || path.basename(item.path || ''), type: item.type, path: item.path,
  })), null, 2) });
  for (const attachment of attachments) {
    if (attachment.type !== 'image' || !attachment.path || !fs.existsSync(attachment.path)) continue;
    const mediaType = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.webp': 'image/webp', '.gif': 'image/gif' })[path.extname(attachment.path).toLowerCase()];
    if (!mediaType) continue;
    if (fs.statSync(attachment.path).size > 20 * 1024 * 1024) throw new Error('Claude 图片附件超过 20 MiB，请使用较小图片');
    content.push({ type: 'image', source: { type: 'base64', media_type: mediaType,
      data: fs.readFileSync(attachment.path).toString('base64') } });
  }
  return content.length ? content : [{ type: 'text', text: '(attachment only)' }];
}

export function createClaudeBridge({ config, getSession, getChatState, getChats, resetSession, saveSessions,
  userText, sendText, sendMarkdown, activeChildren, activeJobs, appendText, reduceEvent,
  markPhase, ensureDone, markInterrupted, markError, terminateProcessTree, log,
  queueSummary, refreshModels, sharedSessions,
  createClient = (options) => new ClaudeCliClient(options) }) {
  const permissions = new Map();
  const permissionTimers = new Set();
  const commandJobs = new Set();
  const listViews = new Map();
  const viewKey = (event) => JSON.stringify([event.chat_id, event.sender_id || '']);
  function resolveSession(event, target) {
    const chat = getChatState(event.chat_id);
    if (/^[1-9]\d*$/.test(target)) {
      const view = listViews.get(viewKey(event));
      const id = view && Date.now() - view.at < 5 * 60_000 ? view.ids[Number(target) - 1] : chat.sessions[Number(target) - 1]?.id;
      return chat.sessions.find((s) => s.id === id);
    }
    return chat.sessions.find((s) => s.id === target || s.claudeSessionId === target);
  }
  const sessionDeletion = createClaudeSessionDeletion({ config, getChatState, getChats, saveSessions, activeJobs, sharedSessions });
  const commands = createClaudeCommands({ config, settings, botConfiguration, providers, saveSessions,
    activeJobs, getChatState, getSession, queueSummary, refreshModels, sharedSessions, resolveSession,
    testModel: async (event, session, model) => {
      const selected = settings(session);
      const definition = providers().find((p) => p.id === selected.provider);
      const started = Date.now();
      const client = createClient({ command: config.claudeCli.command, cwd: config.workspace, home: config.claudeHome,
        provider: { ...definition, model, apiKey: process.env[definition.envKey] }, model, effort: selected.reasoning,
        disableMcp: true, tools: '', persistSession: false, permissionMode: selected.permissionMode,
        totalTimeoutMs: 90_000, upstreamTimeoutMs: 60_000,
        onStarted: (child) => {
          activeChildren.set(child.pid, { child, label: 'Claude model test' });
          activeJobs.set(event.chat_id, { pid: child.pid, mode: 'claude', client, sessionId: session.id, startedAt: started });
        },
        onClosed: (child) => { activeChildren.delete(child.pid); if (activeJobs.get(event.chat_id)?.pid === child.pid) activeJobs.delete(event.chat_id); },
      });
      const result = await client.run([{ type: 'text', text: 'Reply only OK.' }]);
      return { text: String(result.result || '').slice(0, 200), durationMs: Date.now() - started };
    } });

  function botConfiguration() {
    if (!config.claudeBotConfig) return {};
    return JSON.parse(fs.readFileSync(config.claudeBotConfig, 'utf8'));
  }

  function providers() {
    if (!config.claudeProviderCatalog) return [];
    const catalog = JSON.parse(fs.readFileSync(config.claudeProviderCatalog, 'utf8'));
    return catalog.providers || [];
  }

  function settings(session) {
    const bot = botConfiguration();
    const providerId = session?.providerOverride || bot.provider?.id || config.claudeProviderId;
    const provider = providers().find((item) => item.id === providerId);
    if (!provider) throw new Error(`Claude Provider 未配置：${providerId || '请选择渠道'}`);
    const model = session?.modelOverride || bot.provider?.model || provider.model;
    const effort = session?.reasoningOverride || bot.provider?.reasoning || provider.effort || 'high';
    if (!EFFORTS.has(effort)) throw new Error('Claude 思考强度无效');
    return { model, provider: provider.id, reasoning: effort, requestedReasoning: effort,
      permissionMode: bot.claude?.permissionMode || config.claudePermissionMode || 'manual',
      reasoningMapping: { supported: true, mapped: false }, serviceTier: '', accountAlias: '' };
  }

  async function requestPermission(event, request) {
    const token = crypto.randomBytes(6).toString('hex');
    let resolve;
    const answer = new Promise((done) => { resolve = done; });
    const pending = { ...request, chatId: event.chat_id, senderId: event.sender_id || '', token, resolve };
    permissions.set(token, pending);
    const timer = setTimeout(() => { permissions.delete(token); resolve(false); }, 30 * 60_000);
    timer.unref?.(); permissionTimers.add(timer);
    try {
      await sendMarkdown(event.chat_id, `Claude Code 申请调用 **${request.toolName}**\n\n`
        + `参数：\n\`\`\`json\n${JSON.stringify(request.input, null, 2).slice(0, 5000)}\n\`\`\`\n\n`
        + `允许本次调用：\`/approve ${token}\`\n拒绝：\`/deny ${token}\``, 'claude-permission', event.message_id);
      return await answer;
    } finally {
      clearTimeout(timer); permissionTimers.delete(timer); permissions.delete(token);
    }
  }

  async function run(event, session, state, onState, contentOverride) {
    if (session.engine && session.engine !== 'claude') throw new Error('该会话属于其他内核，请新建 Claude 会话');
    const selected = settings(session);
    const definition = providers().find((item) => item.id === selected.provider);
    const apiKey = process.env[definition.envKey];
    if (!apiKey) throw new Error(`Claude 渠道 ${definition.name} 的密钥不可用，请应用最新 Provider 配置`);
    const startedAt = Date.now();
    let flushTimer;
    let flushPromise = Promise.resolve();
    const flush = () => {
      clearTimeout(flushTimer); flushTimer = null;
      flushPromise = flushPromise.then(() => onState?.(state));
      return flushPromise;
    };
    const schedule = () => { if (!flushTimer) flushTimer = setTimeout(() => { void flush().catch(() => {}); }, 100); };
    let contextTokens = null;
    const sessionId = session.claudeSessionId || crypto.randomUUID();
    const text = contentOverride ?? userText(event.content);
    const nativeHome = sharedSessions ? sharedSessions.sessionHome(session) : config.claudeHome;
    const workspace = sharedSessions ? session.claudeWorkspace || config.workspace : config.workspace;
    const sharedMcpFile = config.claudeToolsRoot ? path.join(config.claudeToolsRoot, '.mcp.json') : '';
    let sharedMcpConfig = sharedMcpFile;
    if (sharedSessions && !config.disableMcp && sharedMcpFile && fs.existsSync(sharedMcpFile)) {
      const mcp = JSON.parse(fs.readFileSync(sharedMcpFile, 'utf8'));
      const cloak = mcp.mcpServers?.cloakbrowser;
      if (cloak) cloak.env = { ...cloak.env,
        PLAYWRIGHT_MCP_USER_DATA_DIR: path.join(config.claudeHome, 'browser-profiles', 'cloakbrowser'),
        PLAYWRIGHT_MCP_OUTPUT_DIR: path.join(config.claudeHome, 'browser-output', 'cloakbrowser') };
      sharedMcpConfig = JSON.stringify(mcp);
    }
    const releaseSession = sharedSessions?.acquire(session);
    let client;
    try { client = createClient({ command: config.claudeCli.command, cwd: workspace,
      home: nativeHome, toolHome: config.claudeHome, provider: { ...definition, model: selected.model, apiKey },
      sessionId, resume: Boolean(session.claudeSessionId), model: selected.model, effort: selected.reasoning,
      permissionMode: selected.permissionMode, disableMcp: config.disableMcp,
      allowedTools: ['Read', 'Glob', 'Grep', 'LS', 'Skill', 'mcp__feishu_bridge__current_conversation'],
      additionalDirectories: [config.claudeToolsRoot, workspace !== config.workspace ? config.workspace : ''].filter((dir) => dir && fs.existsSync(dir)),
      mcpConfigs: [sharedMcpFile && fs.existsSync(sharedMcpFile) ? sharedMcpConfig : '',
        ...[path.join(config.claudeHome, '.mcp.json'), path.join(workspace, '.mcp.json')].filter((file) => fs.existsSync(file))].filter(Boolean)
        .concat(config.larkCli ? [feishuMcpConfiguration({ ...config, workspace }, event)] : []),
      totalTimeoutMs: config.codexTimeoutMs, idleTimeoutMs: config.codexIdleTimeoutMs,
      dispatchCommand: /^\/[\w:-]+(?:\s|$)/u.test(text),
      onSession: (id) => { session.engine = 'claude'; session.claudeSessionId = id; saveSessions(); },
      onPermission: (request) => requestPermission(event, request),
      onStarted: (child) => {
        activeChildren.set(child.pid, { child, label: 'Claude Code CLI' });
        activeJobs.set(event.chat_id, { pid: child.pid, mode: 'claude', client, startedAt,
          messageId: event.message_id || event.id, sessionId: session.id });
      },
      onClosed: (child) => { activeChildren.delete(child.pid); if (activeJobs.get(event.chat_id)?.pid === child.pid) activeJobs.delete(event.chat_id); },
      onEvent: (item) => {
        if (item.type === 'permission_cancelled') {
          for (const [token, pending] of permissions) if (pending.id === item.id) { pending.resolve(false); permissions.delete(token); }
        }
        if (item.type === 'compacted') {
          session.lastCompactedAt = item.at;
          session.lastContextUsage = null;
          if (state) state.meta.contextUsage = null;
          saveSessions();
        }
        if (!state) return;
        if (item.type === 'api_retry') {
          state.meta.upstreamRetry = { statusCode: item.statusCode, attempt: item.attempt,
            maxRetries: item.maxRetries, delayMs: item.delayMs, at: Date.now(), provider: definition.name || selected.provider };
          markPhase(state, 'reconnecting', { connection: 'connected', retryAttempt: item.attempt, progress: false });
          log?.('WARN', 'Claude upstream request retry', { provider: selected.provider,
            statusCode: item.statusCode, attempt: item.attempt, maxRetries: item.maxRetries, delayMs: item.delayMs });
        } else if (item.type === 'model_progress') {
          delete state.meta.upstreamRetry;
          markPhase(state, 'model_thinking', { connection: 'connected' });
          if (state.activity) state.activity.lastModelEventAt = Date.now();
        } else if (item.type === 'initialized') {
          state.threadId = item.sessionId;
          state.meta.engine = 'claude'; state.meta.model = item.model || selected.model;
          writeJsonFileAtomicSync(path.join(config.stateDir, 'claude-runtime.json'), {
            engine: 'claude', pid: client.child.pid, sessionId: item.sessionId,
            version: item.version, model: item.model, permissionMode: item.permissionMode,
            tools: item.tools, mcpServers: item.mcpServers, skills: item.skills,
            configHome: nativeHome, botConfigHome: config.claudeHome, workspace, observedAt: new Date().toISOString(),
          });
          markPhase(state, 'model_thinking', { connection: 'connected' });
        } else if (item.type === 'text_delta') {
          delete state.meta.upstreamRetry;
          appendText(state, item.text);
          markPhase(state, 'model_streaming', { connection: 'connected' });
        } else if (item.type === 'tool_start') {
          reduceEvent(state, { type: 'item.started', item: { type: 'tool', id: item.id, name: item.name, input: item.input } });
        } else if (item.type === 'tool_update') {
          const tool = state.blocks.find((block) => block.tool?.id === item.id)?.tool;
          if (tool) tool.input = item.input;
        } else if (item.type === 'tool_end') {
          reduceEvent(state, { type: 'item.completed', item: { type: 'tool', id: item.id, name: item.name,
            output: item.output, status: item.error ? 'error' : 'completed' } });
        } else if (item.type === 'context') {
          contextTokens = item.usedTokens;
          session.lastContextUsage = { usedTokens: contextTokens, contextWindow: null, percent: null, updatedAt: Date.now() };
          state.meta.contextUsage = session.lastContextUsage;
        } else if (item.type === 'compacting_started') {
          markPhase(state, 'compacting', { connection: 'connected' });
        } else if (item.type === 'compacted') {
          session.lastCompactedAt = item.at; state.meta.compactedAt = item.at;
          markPhase(state, 'model_thinking', { connection: 'connected' });
        } else if (item.type === 'result') {
          const usage = item.result.usage || {};
          state.meta.inputTokens = Number(usage.input_tokens || 0) + Number(usage.cache_read_input_tokens || 0)
            + Number(usage.cache_creation_input_tokens || 0);
          state.meta.outputTokens = Number(usage.output_tokens || 0);
          session.lastTokenUsage = { total: { inputTokens: state.meta.inputTokens, outputTokens: state.meta.outputTokens,
            totalTokens: state.meta.inputTokens + state.meta.outputTokens }, last: { inputTokens: contextTokens || 0 }, modelContextWindow: null };
          saveSessions();
        }
        schedule();
      },
    }); } catch (error) { releaseSession?.(); throw error; }
    try {
      if (state) { state.meta.engine = 'claude'; markPhase(state, 'model_thinking', { connection: 'starting' }); await flush(); }
      const result = await client.run(claudeContent(text, event.attachments));
      if (state) { ensureDone(state, result.result || ''); state.meta.durationMs = Date.now() - startedAt; await flush(); }
      return { text: result.result || '(Claude 没有返回文字)', durationMs: Date.now() - startedAt,
        tokens: `${state?.meta?.inputTokens || 0}↑ ${state?.meta?.outputTokens || 0}↓` };
    } catch (error) {
      if (error && typeof error === 'object') error.engine = 'claude';
      if (state) { if (error.code === 'USER_STOP') markInterrupted(state); else markError(state, error); await flush(); }
      throw error;
    } finally {
      clearTimeout(flushTimer);
      releaseSession?.();
      for (const [token, pending] of permissions) if (pending.sessionId === sessionId) {
        permissions.delete(token); pending.resolve(false);
      }
    }
  }

  async function handleCommand(event, command) {
    const chatId = event.chat_id;
    const messageId = event.message_id || event.id || chatId;
    const session = getSession(chatId);
    const reply = (text) => sendMarkdown(chatId, text, `claude-${command.name.slice(1)}`, messageId);
    const chat = getChatState(chatId);
    if (await sessionDeletion.handle(event, command, reply)) return true;
    if (await commands.handle(event, command, reply)) return true;
    if (['/approve', '/deny'].includes(command.name)) {
      const pending = permissions.get(command.rest.trim());
      if (!pending || pending.chatId !== chatId || (pending.senderId && pending.senderId !== event.sender_id)) {
        await reply('该工具请求不存在、已过期，或不属于当前用户。');
      } else { pending.resolve(command.name === '/approve'); permissions.delete(pending.token); await reply(command.name === '/approve' ? '已允许本次工具调用。' : '已拒绝本次工具调用。'); }
      return true;
    }
    if (command.name === '/new') { const next = resetSession(chatId, command.rest || '新会话'); await reply(`已创建 Claude 会话：${next.title} (${next.id})`); return true; }
    if (['/sessions', '/list'].includes(command.name)) {
      listViews.set(viewKey(event), { ids: chat.sessions.map((s) => s.id), at: Date.now() });
      sessionDeletion.rememberList(event, chat.sessions);
      await reply((sharedSessions ? '**Claude 共享会话库 · 所有 Claude Bot 可切换续接**\n\n' : '')
        + chat.sessions.map((item, i) => `${i+1}. ${item.id === chat.currentSessionId ? '当前 · ' : ''}${item.title} (${item.id})${sharedSessions ? ` · 来自 ${item.claudeOriginBot || 'Claude'}` : ''}`).join('\n')
        + '\n\n使用 `/switch 序号或ID` 切换；`/rename 新标题` 或 `/rename 序号 新标题` 改名；`/new [标题]` 创建会话；`/delete 序号或ID` 预览删除，支持 `1 2`、`1-3`；按预览中的 `/confirm delete 序号或区间` 确认。'); return true;
    }
    if (command.name === '/switch') {
      if (activeJobs.has(chatId)) throw new Error('请在当前任务结束后切换会话');
      const target = resolveSession(event, command.rest);
      if (!target) throw new Error('Claude 会话不存在');
      sharedSessions?.assertIdle(target);
      chat.currentSessionId = target.id; saveSessions(); await reply(`当前 Claude 会话：${target.title} (${target.id})`); return true;
    }
    if (command.name === '/reset') {
      if (activeJobs.has(chatId)) throw new Error('请先停止当前任务');
      const release = sharedSessions?.acquire(session, 'reset');
      try {
        session.claudeSessionId = ''; session.messages = []; session.lastContextUsage = null; session.lastTokenUsage = null;
        session.lastCompactedAt = null; saveSessions();
      } finally { release?.(); }
      await reply(`已清空当前 Claude ${sharedSessions ? '共享' : ''}会话上下文。下一条普通消息从空白上下文开始。`); return true;
    }
    if (command.name === '/compact') {
      if (activeJobs.size || commandJobs.size) throw new Error('当前 Claude 任务还在运行，请等这一轮结束或先 /stop，再 /compact');
      if (!session.claudeSessionId) { await reply('当前会话尚无 Claude 原生聊天记录，先发送一条普通消息再 /compact。'); return true; }
      sharedSessions?.assertIdle(session);
      commandJobs.add(chatId);
      const previous = session.lastCompactedAt;
      try {
        await reply('开始压缩当前 Claude 原生会话。');
        const result = await run(event, session, null, null, `/compact${command.rest ? ` ${command.rest}` : ''}`);
        await reply(session.lastCompactedAt !== previous
          ? `Claude 上下文已压缩。\n时间：${new Date(session.lastCompactedAt).toLocaleString('zh-CN')}\n耗时：${Math.round(result.durationMs / 1000)} 秒`
          : `本次未发生压缩：${result.text}`);
      } finally { commandJobs.delete(chatId); }
      return true;
    }
    if (command.name === '/steer') {
      const job = activeJobs.get(chatId);
      if (!command.rest.trim() && !event.attachments?.length) { await reply('用法：/steer <要追加到当前任务的补充指令>'); return true; }
      if (!job || job.mode !== 'claude' || !job.client?.steer) { await reply('当前没有可追加指令的 Claude 任务。'); return true; }
      const failed = event.attachmentDownload?.failed;
      if (failed?.image || failed?.file) throw new Error('附件下载不完整，本次补充指令未发送，请重试');
      job.client.steer(claudeContent(command.rest, event.attachments));
      const running = chat.sessions.find((s) => s.id === job.sessionId);
      if (running) {
        running.messages ||= []; running.messages.push({ role: 'user', content: command.rest, at: Date.now() }); saveSessions();
      }
      await reply('已将补充指令发送到当前 Claude 任务，在工具调用结束后读取；不会另开会话。'); return true;
    }
    if (['/goal', '/fast'].includes(command.name)) {
      await reply(command.name === '/goal'
        ? 'Codex 原生 Goal 是 Codex 专属能力，当前 Claude CLI 未接入等价接口。可直接发送目标让 Claude 执行。'
        : 'Codex Fast 是 Codex 专属服务档位，不能直接应用于 Claude 渠道。当前 Claude 模型和思考强度保持原设置。'); return true;
    }
    return false;
  }

  function close() { listViews.clear(); sessionDeletion.close(); for (const pending of permissions.values()) pending.resolve(false); permissions.clear(); for (const timer of permissionTimers) clearTimeout(timer); }
  return { run, settings, handleCommand, close };
}
