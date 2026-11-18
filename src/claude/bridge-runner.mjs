import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ClaudeCliClient } from './cli-client.mjs';
import { writeJsonFileAtomicSync } from '../utils/json.mjs';
import { feishuMcpConfiguration } from './feishu-tools.mjs';

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

export function createClaudeBridge({ config, getSession, getChatState, resetSession, saveSessions,
  userText, sendText, sendMarkdown, activeChildren, activeJobs, appendText, reduceEvent,
  markPhase, ensureDone, markInterrupted, markError, terminateProcessTree, log,
  createClient = (options) => new ClaudeCliClient(options) }) {
  const permissions = new Map();
  const permissionTimers = new Set();

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

  async function run(event, session, state, onState) {
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
    const client = createClient({ command: config.claudeCli.command, cwd: config.workspace,
      home: config.claudeHome, provider: { ...definition, model: selected.model, apiKey },
      sessionId, resume: Boolean(session.claudeSessionId), model: selected.model, effort: selected.reasoning,
      permissionMode: selected.permissionMode, disableMcp: config.disableMcp,
      allowedTools: ['Read', 'Glob', 'Grep', 'LS', 'Skill', 'mcp__feishu_bridge__current_conversation'],
      additionalDirectories: config.claudeToolsRoot && fs.existsSync(config.claudeToolsRoot) ? [config.claudeToolsRoot] : [],
      mcpConfigs: [config.claudeToolsRoot ? path.join(config.claudeToolsRoot, '.mcp.json') : '',
        path.join(config.claudeHome, '.mcp.json'), path.join(config.workspace, '.mcp.json')].filter((file) => file && fs.existsSync(file))
        .concat(config.larkCli ? [feishuMcpConfiguration(config, event)] : []),
      totalTimeoutMs: config.codexTimeoutMs, idleTimeoutMs: config.codexIdleTimeoutMs,
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
        if (!state) return;
        if (item.type === 'initialized') {
          state.threadId = item.sessionId;
          state.meta.engine = 'claude'; state.meta.model = item.model || selected.model;
          writeJsonFileAtomicSync(path.join(config.stateDir, 'claude-runtime.json'), {
            engine: 'claude', pid: client.child.pid, sessionId: item.sessionId,
            version: item.version, model: item.model, permissionMode: item.permissionMode,
            tools: item.tools, mcpServers: item.mcpServers, skills: item.skills,
            configHome: config.claudeHome, observedAt: new Date().toISOString(),
          });
          markPhase(state, 'model_thinking', { connection: 'connected' });
        } else if (item.type === 'text_delta') {
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
        } else if (item.type === 'compacted') {
          session.lastCompactedAt = item.at; state.meta.compactedAt = item.at;
          markPhase(state, 'compacting', { connection: 'connected' });
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
    });
    try {
      if (state) { state.meta.engine = 'claude'; markPhase(state, 'model_thinking', { connection: 'starting' }); await flush(); }
      const result = await client.run(claudeContent(userText(event.content), event.attachments));
      if (state) { ensureDone(state, result.result || ''); state.meta.durationMs = Date.now() - startedAt; await flush(); }
      return { text: result.result || '(Claude 没有返回文字)', durationMs: Date.now() - startedAt,
        tokens: `${state?.meta?.inputTokens || 0}↑ ${state?.meta?.outputTokens || 0}↓` };
    } catch (error) {
      if (state) { if (error.code === 'USER_STOP') markInterrupted(state); else markError(state, error); await flush(); }
      throw error;
    } finally {
      clearTimeout(flushTimer);
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
    if (['/approve', '/deny'].includes(command.name)) {
      const pending = permissions.get(command.rest.trim());
      if (!pending || pending.chatId !== chatId || (pending.senderId && pending.senderId !== event.sender_id)) {
        await reply('该工具请求不存在、已过期，或不属于当前用户。');
      } else { pending.resolve(command.name === '/approve'); permissions.delete(pending.token); await reply(command.name === '/approve' ? '已允许本次工具调用。' : '已拒绝本次工具调用。'); }
      return true;
    }
    if (command.name === '/new') { const next = resetSession(chatId, command.rest || '新会话'); await reply(`已创建 Claude 会话：${next.title} (${next.id})`); return true; }
    if (['/sessions', '/list'].includes(command.name)) {
      await reply(chat.sessions.map((item, i) => `${i+1}. ${item.id === chat.currentSessionId ? '当前 · ' : ''}${item.title} (${item.id})`).join('\n')); return true;
    }
    if (command.name === '/switch') {
      if (activeJobs.has(chatId)) throw new Error('请在当前任务结束后切换会话');
      const target = chat.sessions[Number(command.rest)-1] || chat.sessions.find((item) => item.id === command.rest);
      if (!target) throw new Error('Claude 会话不存在');
      chat.currentSessionId = target.id; saveSessions(); await reply(`当前 Claude 会话：${target.title} (${target.id})`); return true;
    }
    if (command.name === '/rename') { if (!command.rest.trim()) throw new Error('请输入会话名称'); session.title = command.rest.trim().slice(0,120); saveSessions(); await reply(`会话已命名为：${session.title}`); return true; }
    if (command.name === '/reset') {
      if (activeJobs.has(chatId)) throw new Error('请先停止当前任务');
      session.claudeSessionId = ''; session.messages = []; session.lastContextUsage = null; session.lastTokenUsage = null; saveSessions(); await reply('已重置当前 Claude 会话的上下文绑定。'); return true;
    }
    if (['/status', '/context', '/how', '/now'].includes(command.name)) {
      const selected = settings(session); const job = activeJobs.get(chatId);
      await reply(`内核：Claude Code CLI\nBot：${config.larkProfile}\n会话：${session.title} (${session.id})\n`
        + `Provider：${selected.provider}\n模型：${selected.model}\n思考强度：${selected.reasoning}\n`
        + `权限模式：${selected.permissionMode === 'bypassPermissions' ? '完全授权（bypassPermissions）' : selected.permissionMode}\n`
        + `任务：${job ? '运行中' : '空闲'}\n当前请求上下文：${session.lastContextUsage?.usedTokens ?? '未知'} tokens\n`
        + `压缩阈值：由 Claude Code 管理，Bridge 未获得精确阈值\nMCP／Skills：${config.claudeHome}`); return true;
    }
    if (command.name === '/provider') {
      const target = command.rest.trim();
      if (!target || target === 'list') { await reply(providers().map((p) => `${p.id} · ${p.name} · ${p.baseUrl}`).join('\n') || '尚无 Claude Provider'); return true; }
      if (activeJobs.has(chatId)) throw new Error('请在当前任务结束后更换渠道');
      const provider = providers().find((p) => p.id === target);
      if (!provider || !process.env[provider.envKey]) throw new Error('Claude 渠道或密钥不可用，请在客户端配置并应用');
      session.providerOverride = target; session.modelOverride = provider.model; session.reasoningOverride = provider.effort; saveSessions(); await reply(`当前会话使用 Claude 渠道 ${provider.name}`); return true;
    }
    if (command.name === '/model') {
      const provider = providers().find((p) => p.id === settings(session).provider);
      const target = command.rest.trim();
      if (!target || target === 'list') { await reply(`当前模型：${settings(session).model}\n可选模型：\n${provider.models.join('\n')}`); return true; }
      if (activeJobs.has(chatId)) throw new Error('请在当前任务结束后更换模型');
      if (!provider.models.includes(target)) throw new Error('模型不在该渠道已发现的列表中，请先在客户端刷新');
      session.modelOverride = target; saveSessions(); await reply(`Claude 模型已切换为 ${target}`); return true;
    }
    if (command.name === '/effort') {
      if (!EFFORTS.has(command.rest)) throw new Error('可用强度：low、medium、high、xhigh、max');
      session.reasoningOverride = command.rest; saveSessions(); await reply(`Claude 思考强度：${command.rest}`); return true;
    }
    if (command.name === '/help') {
      await reply('Claude Code CLI\n\n/new · /list · /switch 序号 · /rename 名称 · /reset\n/status · /context · /model list · /model 模型\n/provider list · /provider 渠道 · /effort high\n/stop · /stopall · /queue · /approve 请求码 · /deny 请求码\n\n消息正文原样交给 Claude Code；附件信息另附。'); return true;
    }
    if (['/goal', '/fast', '/compact', '/delete', '/del', '/rm', '/confirm', '/steer'].includes(command.name)) {
      await reply('该命令尚未映射到 Claude Code。普通消息、会话管理和 /stop 可用；压缩由原生 CLI 自动管理。'); return true;
    }
    return false;
  }

  function close() { for (const pending of permissions.values()) pending.resolve(false); permissions.clear(); for (const timer of permissionTimers) clearTimeout(timer); }
  return { run, settings, handleCommand, close };
}
