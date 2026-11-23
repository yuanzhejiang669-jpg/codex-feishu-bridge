import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AntigravityAcpClient, antigravityContent } from './acp-client.mjs';
import configuration from './configuration.cjs';
import accountLock from './account-lock.cjs';
import { feishuMcpConfiguration } from '../claude/feishu-tools.mjs';
import { applyCloakBrowserIsolationToServer, resolveCloakBrowserDirs } from '../config/cloakbrowser.mjs';
import { buildAccessContext, isOwnerDmContext } from '../sessions/access-control.mjs';
import { isAntigravityConversationBusy, listAntigravityNativeConversations } from './native-sessions.mjs';

const { readCatalog, readJson, atomicJson, selectProvider, assertOfficialAccount, EFFORTS, NATIVE_MODES } = configuration;
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_SUFFIX_RE = /-(low|medium|high|xhigh|max)$/i;

function samePath(a, b) {
  if (!a || !b) return false;
  const pa = path.resolve(a);
  const pb = path.resolve(b);
  return process.platform === 'win32' ? pa.toLowerCase() === pb.toLowerCase() : pa === pb;
}

export function extractAntigravityModelCatalog(models, configOptions) {
  const optionsList = Array.isArray(configOptions) ? configOptions : [];
  const available = Array.isArray(models?.availableModels) ? models.availableModels : [];
  const modelOpt = optionsList.find((item) => String(item?.id || item?.category || '').toLowerCase() === 'model');
  const effortOpt = optionsList.find((item) => {
    const id = String(item?.id || item?.name || item?.category || '').toLowerCase();
    return id === 'thought_level' || id === 'reasoning_effort' || id === 'effort';
  });
  const thoughtLevels = Array.isArray(effortOpt?.options)
    ? effortOpt.options.map((item) => (typeof item === 'string' ? item : String(item?.value || item?.id || '').trim())).filter(Boolean)
    : [];

  let currentBaseModel = String(modelOpt?.currentValue || '').trim();
  let currentEffort = String(effortOpt?.currentValue || '').trim().toLowerCase();
  const currentModelId = String(models?.currentModelId || '').trim();

  const baseModels = [];
  if (Array.isArray(modelOpt?.options) && modelOpt.options.length) {
    for (const opt of modelOpt.options) {
      const id = typeof opt === 'string' ? opt.trim() : String(opt?.value || opt?.id || '').trim();
      if (!id) continue;
      const name = typeof opt === 'string' ? id : String(opt?.name || id).trim();
      const matchedEfforts = new Set();
      for (const flat of available) {
        const flatId = String(flat?.modelId || '').trim();
        if (!flatId.startsWith(`${id}-`)) continue;
        const suffix = flatId.slice(id.length + 1).toLowerCase();
        if (EFFORT_ORDER.includes(suffix)) matchedEfforts.add(suffix);
      }
      if (!matchedEfforts.size && id === currentBaseModel && thoughtLevels.length) {
        for (const lvl of thoughtLevels) matchedEfforts.add(lvl.toLowerCase());
      }
      const efforts = EFFORT_ORDER.filter((lvl) => matchedEfforts.has(lvl));
      baseModels.push({ id, name, efforts });
    }
    if (!currentBaseModel && currentModelId) {
      const direct = baseModels.find((m) => m.id === currentModelId);
      if (direct) {
        currentBaseModel = direct.id;
      } else {
        const suffixMatch = currentModelId.match(EFFORT_SUFFIX_RE);
        if (suffixMatch) {
          const stripped = currentModelId.slice(0, -suffixMatch[0].length);
          if (baseModels.some((m) => m.id === stripped)) {
            currentBaseModel = stripped;
            if (!currentEffort) currentEffort = suffixMatch[1].toLowerCase();
          }
        }
      }
    }
  } else {
    for (const flat of available) {
      const id = String(flat?.modelId || '').trim();
      if (!id) continue;
      baseModels.push({ id, name: String(flat?.name || id).trim(), efforts: [...thoughtLevels] });
    }
    if (!currentBaseModel && currentModelId) currentBaseModel = currentModelId;
  }

  return {
    baseModels,
    availableModels: available,
    thoughtLevels: thoughtLevels.length ? thoughtLevels : null,
    currentModelId,
    currentBaseModel,
    currentEffort,
    hasSplitConfig: Boolean(Array.isArray(modelOpt?.options) && modelOpt.options.length),
  };
}

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
  if (definitions.cloakbrowser) {
    definitions.cloakbrowser = applyCloakBrowserIsolationToServer(definitions.cloakbrowser, resolveCloakBrowserDirs(config, environment));
  }
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
  const modelCatalogCache = new Map();
  const MODEL_CATALOG_TTL_MS = 5 * 60_000;
  const runtimePath = path.join(config.stateDir, 'antigravity-runtime.json');
  const catalogRoot = config.antigravityDataRoot;
  const botConfiguration = () => config.antigravityBotConfig ? readJson(config.antigravityBotConfig, {}) : {};

  function catalogCacheKey(provider) {
    return `${provider?.id || 'official'}\0${provider?.accountId || ''}`;
  }

  function settings(session) {
    const bot = botConfiguration();
    const provider = selectProvider(catalogRoot, session?.providerOverride || bot.provider?.id || 'official');
    return { model: session?.modelOverride || bot.provider?.model || provider.model || '', provider: provider.id,
      accountAlias: provider.accountId || '', reasoning: session?.reasoningOverride || bot.provider?.reasoning || provider.effort || '',
      requestedReasoning: session?.reasoningOverride || bot.provider?.reasoning || provider.effort || '',
      permissionMode: bot.antigravity?.permissionMode || 'always-proceed', reasoningMapping: { supported: true, mapped: false }, serviceTier: '' };
  }

  function observedCatalogFor(provider) {
    const cached = modelCatalogCache.get(catalogCacheKey(provider));
    if (cached) return cached.catalog || extractAntigravityModelCatalog(cached.models, cached.configOptions);
    const runtime = readJson(runtimePath, null);
    if (runtime && (!runtime.provider || runtime.provider === provider.id)) {
      return extractAntigravityModelCatalog(runtime.models, runtime.configOptions);
    }
    return null;
  }

  function displayModelInfo(session, explicitCatalog = null) {
    const selected = settings(session);
    const bot = botConfiguration();
    const provider = selectProvider(catalogRoot, selected.provider);
    const catalog = explicitCatalog || observedCatalogFor(provider);
    let configuredModel = selected.model;
    let configuredEffort = selected.reasoning;
    if (catalog?.hasSplitConfig && configuredModel) {
      const direct = catalog.baseModels.find((m) => m.id === configuredModel);
      if (!direct) {
        const suffixMatch = configuredModel.match(EFFORT_SUFFIX_RE);
        if (suffixMatch) {
          const stripped = configuredModel.slice(0, -suffixMatch[0].length);
          if (catalog.baseModels.some((m) => m.id === stripped)) {
            configuredModel = stripped;
            if (!configuredEffort) configuredEffort = suffixMatch[1].toLowerCase();
          }
        }
      }
    }
    const effectiveModel = configuredModel || catalog?.currentBaseModel || catalog?.currentModelId || '';
    const effectiveEffort = configuredEffort || catalog?.currentEffort || '';
    const modelSource = session.modelOverride ? '会话覆盖' : bot.provider?.model ? 'Bot 默认' : provider.model ? '渠道默认' : '官方默认';
    const effortSource = session.reasoningOverride ? '会话覆盖' : bot.provider?.reasoning ? 'Bot 默认' : provider.effort ? '渠道默认' : '官方默认';
    return {
      selected,
      provider,
      catalog,
      effectiveModel,
      effectiveEffort,
      modelSource,
      effortSource,
      modelText: effectiveModel ? `${effectiveModel}（${modelSource}）` : '官方默认（首次运行或 `/model list` 后可见具体 ID）',
      effortText: effectiveEffort ? `${effectiveEffort}（${effortSource}）` : '官方默认',
    };
  }

  function resolveSessionTarget(session, provider) {
    if (provider.mode === 'gemini-api') {
      return { geminiDir: config.antigravityHome, appDataDir: undefined };
    }
    const desktopDir = String(config.antigravityDesktopGeminiDir || '').trim();
    if (session?.antigravitySessionId) {
      const existingHome = session.antigravityHome || '';
      const existingAppDir = session.antigravityAppDataDir || '';
      if (existingAppDir === 'antigravity' && existingHome) {
        return { geminiDir: sharedSessions?.sessionHome(session) || existingHome, appDataDir: 'antigravity' };
      }
      if (existingHome && (!desktopDir || !samePath(existingHome, desktopDir))) {
        return { geminiDir: sharedSessions?.sessionHome(session) || existingHome, appDataDir: existingAppDir || 'antigravity-cli' };
      }
    }
    if (desktopDir) {
      return { geminiDir: desktopDir, appDataDir: 'antigravity' };
    }
    return { geminiDir: sharedSessions?.sessionHome(session) || config.antigravityHome, appDataDir: 'antigravity-cli' };
  }

  const viewKey = (event) => `${event.chat_id}\0${event.sender_id || ''}`;
  const accessContextFor = (event) => (
    sharedSessions?.accessContextForEvent
      ? sharedSessions.accessContextForEvent(event)
      : buildAccessContext(event, { config })
  );

  function collectNativeConversations(chat, accessCtx) {
    if (!isOwnerDmContext(accessCtx)) return [];
    const seenNativeIds = new Set(
      (chat.sessions || []).map((item) => String(item.antigravitySessionId || '').trim()).filter(Boolean),
    );
    const sources = [];
    if (config.antigravityDesktopGeminiDir) {
      sources.push({ geminiDir: config.antigravityDesktopGeminiDir, appDataDir: 'antigravity', sourceLabel: '客户端侧边栏' });
    }
    if (config.antigravityHome) {
      sources.push({ geminiDir: config.antigravityHome, appDataDir: 'antigravity-cli', sourceLabel: 'Bridge 原生库' });
    }
    const results = [];
    for (const src of sources) {
      for (const item of listAntigravityNativeConversations({ geminiDir: src.geminiDir, appDataDir: src.appDataDir, limit: 100 })) {
        if (seenNativeIds.has(item.conversationId)) continue;
        seenNativeIds.add(item.conversationId);
        results.push({ ...item, sourceLabel: src.sourceLabel });
      }
    }
    return results.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  }

  function resolveBridgeOrNativeTarget(event, target) {
    const accessCtx = accessContextFor(event);
    const chat = getChatState(event.chat_id, accessCtx);
    const trimmed = String(target || '').trim();
    const direct = chat.sessions.find((item) => item.id === trimmed || item.antigravitySessionId === trimmed);
    if (direct) return { kind: 'bridge', session: direct };
    if (/^[1-9]\d*$/.test(trimmed)) {
      const view = listViews.get(viewKey(event));
      if (view && Date.now() - view.at <= 5 * 60_000) {
        const entry = view.items?.[Number(trimmed) - 1];
        if (entry) {
          if (entry.kind === 'native') return { kind: 'native', native: entry.native };
          const found = chat.sessions.find((item) => item.id === entry.id);
          if (found) return { kind: 'bridge', session: found };
        }
        if (trimmed.length < 6) return null;
      } else if (trimmed.length < 6) {
        throw new Error('请先 /list 获取最新会话序号');
      }
    }
    const nativeMatch = collectNativeConversations(chat, accessCtx)
      .find((item) => item.conversationId === trimmed || item.conversationId.startsWith(trimmed));
    if (nativeMatch) return { kind: 'native', native: nativeMatch };
    return null;
  }

  function resolveSession(event, target) {
    const resolved = resolveBridgeOrNativeTarget(event, target);
    return resolved?.kind === 'bridge' ? resolved.session : null;
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

  function newClient(session, event, onEvent = () => {}, targetOverride = null) {
    const selected = settings(session);
    const provider = selectProvider(catalogRoot, selected.provider);
    assertOfficialAccount(catalogRoot, provider);
    const apiKey = provider.mode === 'gemini-api' ? process.env[provider.envKey] : '';
    if (provider.mode === 'gemini-api' && !apiKey) throw new Error(`渠道 ${provider.name} 密钥尚未加载，请在客户端保存渠道后重启空闲 Bot`);
    const target = targetOverride || resolveSessionTarget(session, provider);
    return createClient({
      command: config.antigravityCli.command,
      cwd: session?.antigravityWorkspace || config.workspace,
      geminiDir: target.geminiDir,
      appDataDir: target.appDataDir,
      logFile: path.join(config.logDir, 'antigravity-acp.log'),
      provider: { ...provider, apiKey },
      permissionMode: selected.permissionMode,
      additionalDirectories: [config.antigravityToolsRoot].filter(Boolean),
      idleTimeoutMs: config.codexIdleTimeoutMs,
      onPermission: (request) => (selected.permissionMode === 'always-proceed' ? true : requestPermission(event, request)),
      onEvent,
      onStarted: (child) => { activeChildren.set(child.pid, { child, label: 'Antigravity CLI' }); },
      onClosed: (child) => { activeChildren.delete(child.pid); },
    });
  }

  async function run(event, session, state, onState, contentOverride) {
    if (session.engine && session.engine !== 'antigravity') throw new Error('此会话属于其他内核，请 /new 创建 Antigravity 会话');
    const selected = settings(session); const startedAt = Date.now();
    const provider = selectProvider(catalogRoot, selected.provider);
    const target = resolveSessionTarget(session, provider);
    if (session.antigravitySessionId && target.appDataDir === 'antigravity'
      && isAntigravityConversationBusy({ geminiDir: target.geminiDir, appDataDir: target.appDataDir, conversationId: session.antigravitySessionId })) {
      throw new Error('该对话正在 Antigravity 客户端中运行，请等待客户端本轮结束后再在飞书续接。');
    }
    const releaseSession = sharedSessions
      ? (sharedSessions.acquireAsync ? await sharedSessions.acquireAsync(session) : sharedSessions.acquire(session))
      : null;
    let releaseAccount;
    try { releaseAccount = accountLock.acquireOfficialLease(catalogRoot, provider); }
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
    }, target); } catch (error) { releaseAccount(); releaseSession?.(); throw error; }
    clients.add(client);
    const job = {
      client, mode: 'antigravity', sessionId: session.id, messageId: event.message_id || event.id, startedAt,
      clearGeneration: 0, pendingSteerEntries: [], steerInFlight: null,
    };
    activeJobs.set(event.chat_id, job);
    try {
      if (state) { state.meta.engine = 'antigravity'; markPhase(state, 'initializing', { connection: 'starting' }); await flush(); }
      // Record the exact source. Switching a channel must not silently replay into an unrelated native session.
      if (session.antigravitySourceId && session.antigravitySourceId !== selected.provider) {
        throw new Error('此原生会话已绑定另一渠道。请切回原渠道继续，或 /new 创建新会话后使用新渠道。');
      }
      const opened = await client.openSession({
        sessionId: session.antigravitySessionId || '',
        mcpServers: nativeMcpServers({ ...config, workspace: session.antigravityWorkspace || config.workspace }, event),
        model: selected.model,
        effort: selected.reasoning,
        mode: selected.permissionMode,
      });
      initialized = true;
      session.engine = 'antigravity';
      session.antigravitySessionId = opened.sessionId;
      session.antigravitySourceId = selected.provider;
      session.antigravityHome = target.geminiDir || session.antigravityHome || config.antigravityHome;
      if (target.appDataDir) session.antigravityAppDataDir = target.appDataDir;
      session.antigravityWorkspace ||= config.workspace;
      saveSessions();
      const observedCatalog = extractAntigravityModelCatalog(opened.models, opened.configOptions);
      atomicJson(runtimePath, { engine: 'antigravity', version: client.runtime.agentInfo?.version,
        sessionId: opened.sessionId, pid: client.child?.pid, provider: selected.provider,
        accountId: selected.accountAlias, models: opened.models, configOptions: opened.configOptions,
        modes: opened.modes, observedAt: new Date().toISOString(), geminiDir: target.geminiDir, appDataDir: target.appDataDir || 'antigravity-cli' });
      Object.assign(job, { pid: client.child.pid, threadId: opened.sessionId });
      if (state) {
        state.threadId = opened.sessionId;
        const resolvedModel = observedCatalog.currentBaseModel || selected.model || observedCatalog.currentModelId;
        const resolvedEffort = observedCatalog.currentEffort || selected.reasoning;
        if (resolvedModel) state.meta.model = resolvedEffort ? `${resolvedModel} (${resolvedEffort})` : resolvedModel;
        markPhase(state, 'model_thinking', { connection: 'connected' });
        await flush();
      }
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

  async function probeModelsReadOnly(session, event, { forceRefresh = false } = {}) {
    const selected = settings(session);
    const provider = selectProvider(catalogRoot, selected.provider);
    const cacheKey = catalogCacheKey(provider);
    const cached = modelCatalogCache.get(cacheKey);
    if (!forceRefresh && cached && Date.now() - cached.fetchedAt < MODEL_CATALOG_TTL_MS) {
      return { ...cached, fromCache: true };
    }
    let releaseAccount;
    let client;
    try {
      releaseAccount = accountLock.acquireOfficialLease(catalogRoot, provider);
      // Read-only probe uses isolated antigravityHome so it never adds blank conversations to Desktop sidebar
      client = newClient(session, event, () => {}, { geminiDir: config.antigravityHome, appDataDir: provider.mode === 'gemini-api' ? undefined : 'antigravity-cli' });
      clients.add(client);
      // Read-only probe: zero MCP servers, fresh ephemeral ACP session, never mutates session or antigravity-runtime.json
      const result = await client.openSession({ sessionId: '', mcpServers: [] });
      const catalog = extractAntigravityModelCatalog(result.models, result.configOptions);
      const entry = {
        models: result.models || { availableModels: [] },
        configOptions: result.configOptions || [],
        modes: result.modes || null,
        thoughtLevels: catalog.thoughtLevels,
        catalog,
        fetchedAt: Date.now(),
      };
      modelCatalogCache.set(cacheKey, entry);
      return { ...entry, fromCache: false };
    } finally {
      clients.delete(client);
      await client?.close();
      releaseAccount?.();
    }
  }

  async function handleCommand(event, command) {
    const accessCtx = accessContextFor(event);
    const chat = getChatState(event.chat_id, accessCtx);
    const currentSession = () => getSession(event.chat_id, accessCtx);
    const reply = (text) => sendMarkdown(event.chat_id, text, `antigravity-${command.name.slice(1)}`, event.message_id || event.id);
    if (['/stop', '/stopall', '/queue', '/clearqueue', '/clearqueueall'].includes(command.name)) return false;
    if (command.name === '/steer') {
      await reply('[原生限制] Antigravity 原生 ACP 协议不支持回合内 /steer，请等待本轮结束或发送 /stop 后重新提问。');
      return true;
    }
    if (command.name === '/goal') {
      await reply('[原生限制] Antigravity 原生 ACP 协议不支持 Codex /goal 模式，请直接发送任务目标。');
      return true;
    }
    if (command.name === '/fast') {
      await reply('[原生限制] Antigravity 原生 ACP 协议不支持 Codex /fast 服务档位，当前模型与思考强度保持原设置。');
      return true;
    }
    if (command.name === '/compact') {
      await reply('[原生限制] Antigravity 原生 ACP 协议暂不支持 Bridge /compact 指令，请使用 /new 开启新会话。');
      return true;
    }
    if (['/approve', '/deny'].includes(command.name)) {
      const pending = permissions.get(command.rest.trim());
      if (!pending || pending.chatId !== event.chat_id || (pending.senderId && pending.senderId !== event.sender_id)) await reply('工具请求已过期或不属于当前用户。');
      else { pending.resolve(command.name === '/approve'); await reply(command.name === '/approve' ? '已允许本次调用。' : '已拒绝本次调用。'); }
      return true;
    }
    if (command.name === '/help') {
      await reply(['**Antigravity Bot · 官方 CLI / ACP**',
        '/new [标题] · /list [all] · /switch 序号或ID · /rename 标题 · /reset',
        '/delete 序号 · /confirm delete 序号（删除共享 Bridge 绑定，保留原生历史）',
        '/provider [list|渠道ID|save|clear] · /model [status|list|refresh|模型ID [强度]|save|clear]',
        '/effort [low|medium|high|xhigh|max|clear]（独立切换思考强度，以所选模型支持为准）',
        '/mode [always-proceed|auto|accept-edits|default|plan] · /context · /status',
        '/stop · /stopall · /queue · /clearqueue [all] · /approve · /deny',
        '原生技能与 /plan 等斜杠指令通过正常任务队列交给 Antigravity。',
        '不支持的指令（[原生限制]）：/steer、/goal、/fast、/compact、/model test。',
        '官方账号登录与手动切换请在客户端的 Antigravity 区域操作；不会自动轮换账号。'].join('\n')); return true;
    }
    if (command.name === '/new' || command.name === '/reset') {
      if (activeJobs.has(event.chat_id)) { await reply('当前任务仍在运行，请先 /stop 或等待完成。'); return true; }
      const previous = command.name === '/reset' ? currentSession() : null;
      const next = resetSession(event.chat_id, command.rest || '新 Antigravity 会话', accessCtx);
      if (previous) for (const key of ['providerOverride', 'modelOverride', 'reasoningOverride']) next[key] = previous[key];
      saveSessions(); await reply(`已创建 Antigravity 会话：${next.title} (${next.id})`); return true;
    }
    if (['/list', '/sessions'].includes(command.name)) {
      const showAll = /\ball\b/i.test(command.rest || '');
      const nativeAll = collectNativeConversations(chat, accessCtx);
      const workspaceMatches = nativeAll.filter((item) => item.cwd && samePath(item.cwd, config.workspace));
      const visibleNative = showAll ? nativeAll : workspaceMatches;
      const hiddenDesktopCount = showAll ? 0 : Math.max(0, nativeAll.length - visibleNative.length);

      const merged = [
        ...chat.sessions.map((item) => ({
          kind: 'bridge',
          id: item.id,
          updatedAt: Number(item.updatedAt || item.createdAt || 0),
          current: item.id === chat.currentSessionId,
          label: `${item.id === chat.currentSessionId ? '● ' : ''}${item.title} · ${item.id}${item.antigravityOriginBot ? ` · ${item.antigravityOriginBot}` : ''}${item.antigravityAppDataDir === 'antigravity' ? ' · 客户端侧边栏' : ''}`,
        })),
        ...visibleNative.map((item) => {
          const dirTag = item.cwd ? ` · ${path.basename(item.cwd)}` : '';
          const busyTag = item.notFullyIdle ? ' · [客户端运行中]' : '';
          return {
            kind: 'native',
            native: item,
            updatedAt: Number(item.updatedAt || 0),
            current: false,
            label: `${item.title} · ${item.conversationId.slice(0, 8)} · ${item.sourceLabel}${dirTag}${busyTag}`,
          };
        }),
      ].sort((a, b) => Number(b.current) - Number(a.current) || b.updatedAt - a.updatedAt);

      listViews.set(viewKey(event), { at: Date.now(), items: merged });
      const title = showAll ? '**Antigravity 全部会话（共享库 + 客户端侧边栏）**' : '**Antigravity 共享会话库**';
      const body = merged.length
        ? merged.map((entry, index) => `${index + 1}. ${entry.label}`).join('\n')
        : '当前作用域下暂无会话，可直接发送消息或使用 `/new` 创建。';
      const footer = [
        hiddenDesktopCount > 0 ? `Antigravity 客户端侧边栏另有 ${hiddenDesktopCount} 条原生对话，发送 \`/list all\` 查看全部并支持 \`/switch <序号>\` 续接。` : '',
        '发送 `/switch <序号或ID>` 切换续接；`/new [标题]` 新建对话。',
      ].filter(Boolean).join('\n');
      await reply(`${title}\n${body}\n\n${footer}`);
      return true;
    }
    if (command.name === '/switch') {
      if (activeJobs.has(event.chat_id)) { await reply('当前任务仍在运行，请先 /stop 或等待完成。'); return true; }
      const resolved = resolveBridgeOrNativeTarget(event, command.rest.trim());
      if (!resolved) { await reply(`未找到可访问的会话：${command.rest.trim()}，请先发送 /list 或 /list all 查看可用序号。`); return true; }
      if (resolved.kind === 'native') {
        const native = resolved.native;
        if (isAntigravityConversationBusy({ geminiDir: native.geminiDir, appDataDir: native.appDataDir, conversationId: native.conversationId })) {
          await reply(`对话「${native.title}」正在 Antigravity 客户端中运行，请等待客户端本轮结束后再从飞书续接。`);
          return true;
        }
        const seed = {
          title: native.title,
          engine: 'antigravity',
          antigravitySessionId: native.conversationId,
          antigravityHome: native.geminiDir,
          antigravityAppDataDir: native.appDataDir,
          antigravityWorkspace: native.cwd || config.workspace,
          antigravitySourceId: 'official',
          antigravityOriginBot: native.sourceLabel,
        };
        let bound;
        if (sharedSessions?.bindNativeSession) {
          bound = sharedSessions.bindNativeSession(event.chat_id, seed, accessCtx);
        } else {
          bound = resetSession(event.chat_id, native.title, accessCtx);
          Object.assign(bound, seed);
          saveSessions();
        }
        await reply(`已切换到原生对话：${bound.title} (${bound.id})\n工作区：${bound.antigravityWorkspace || config.workspace}`);
        return true;
      }
      const target = resolved.session;
      sharedSessions?.assertIdle(target);
      chat.currentSessionId = target.id; saveSessions(); await reply(`已切换：${target.title} (${target.id})`); return true;
    }
    if (command.name === '/rename') {
      if (activeJobs.has(event.chat_id)) { await reply('当前会话正在运行，请等待本轮结束后再重命名。'); return true; }
      if (!command.rest.trim()) { await reply('用法：/rename 新标题'); return true; }
      const match = command.rest.trim().match(/^(\d+|[a-f0-9-]{12,})\s+(.+)$/i);
      const target = match ? resolveSession(event, match[1]) : currentSession();
      if (!target) throw new Error(`未找到可访问的会话：${match ? match[1] : ''}，请先发送 /list 查看可用序号。`);
      sharedSessions?.assertIdle(target);
      target.title = (match ? match[2] : command.rest.trim()).slice(0, 160); target.userRenamed = true; saveSessions(); await reply(`已重命名：${target.title}`); return true;
    }
    if (['/delete', '/del', '/rm'].includes(command.name)) {
      if (activeJobs.has(event.chat_id)) { await reply('当前聊天有任务正在运行，请先 /stop 或等待结束后再执行 /delete。'); return true; }
      const target = resolveSession(event, command.rest.trim());
      if (!target) { await reply(`未找到可访问的会话：${command.rest.trim()}，请先发送 /list 查看可用序号。`); return true; }
      deleteViews.set(viewKey(event), { id: target.id, nativeId: target.antigravitySessionId || '', selector: command.rest.trim(), at: Date.now() });
      sharedSessions?.assertIdle(target);
      await reply(`删除预览：${target.title} (${target.id})\n确认：/confirm delete ${command.rest.trim()}\n删除所有 Antigravity Bot 中的此共享 Bridge 绑定；原生历史和工作区文件保留。`); return true;
    }
    if (command.name === '/confirm') {
      if (activeJobs.has(event.chat_id)) { await reply('当前聊天有任务正在运行，请先 /stop 或等待结束后再执行 /delete。'); return true; }
      const pending = deleteViews.get(viewKey(event));
      if (!pending || Date.now() - pending.at > 5 * 60_000 || command.rest.trim() !== `delete ${pending.selector}`) { await reply('删除确认无效或过期，请重新 /delete 预览。'); return true; }
      const target = chat.sessions.find((item) => item.id === pending.id);
      if (!target || (target.antigravitySessionId || '') !== pending.nativeId) throw new Error('会话绑定已变化，请重新预览');
      if ([...activeJobs.values()].some((job) => job.sessionId === target.id)) throw new Error('会话正在运行，不能删除');
      const release = sharedSessions
        ? (sharedSessions.acquireManyAsync ? await sharedSessions.acquireManyAsync([target]) : sharedSessions.acquireMany([target]))
        : null;
      try {
        if (sharedSessions?.removeAsync) await sharedSessions.removeAsync([target.id], accessCtx);
        else sharedSessions?.remove([target.id], accessCtx);
        chat.sessions = chat.sessions.filter((item) => item.id !== target.id);
        if (chat.currentSessionId === target.id) chat.currentSessionId = chat.sessions[0]?.id || '';
        deleteViews.delete(viewKey(event));
        if (sharedSessions?.saveSessionsAsync) await sharedSessions.saveSessionsAsync();
        else saveSessions();
      } finally { release?.(); }
      await reply('已删除所选共享 Bridge 会话绑定，原生历史与文件保留。'); return true;
    }
    const session = currentSession();
    if (['/status', '/now', '/how', '/context'].includes(command.name)) {
      const info = displayModelInfo(session);
      const usage = session.lastContextUsage;
      const target = resolveSessionTarget(session, info.provider);
      await reply([
        '内核：Antigravity CLI / ACP',
        `渠道：${info.selected.provider}`,
        `模型：${info.modelText}`,
        `思考强度：${info.effortText}`,
        `权限：${info.selected.permissionMode}`,
        `工作区：${session.antigravityWorkspace || config.workspace}`,
        `会话库：${target.appDataDir === 'antigravity' ? 'Antigravity 客户端原生库（互通）' : 'Bridge 独立会话库'}`,
        `会话：${session.title} (${session.id})`,
        `原生会话：${session.antigravitySessionId || '尚未创建'}`,
        `上下文：${usage ? `${usage.usedTokens} / ${usage.contextWindow || '未知'} tokens` : '等待原生使用量事件'}`,
        queueSummary?.(event.chat_id) || '',
      ].filter(Boolean).join('\n')); return true;
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
      const sub = String(parts[0] || '').toLowerCase();
      if (!parts.length || ['status', 'view'].includes(sub)) {
        const info = displayModelInfo(session);
        const activeBase = info.catalog?.baseModels?.find((m) => m.id === info.effectiveModel);
        const effortHint = activeBase?.efforts?.length ? `（支持：${activeBase.efforts.join(' / ')}）` : '';
        await reply([
          '**Antigravity 模型状态**',
          `渠道：${info.selected.provider}`,
          `模型：${info.modelText}`,
          `思考强度：${info.effortText}${effortHint}`,
          `权限模式：${info.selected.permissionMode}`,
          '',
          '用法：`/model list`、`/model refresh`、`/model <模型ID> [强度]`、`/effort <强度|clear>`、`/model save`、`/model clear`',
        ].join('\n'));
        return true;
      }
      if (sub === 'test' || sub === 'check') {
        await reply('[原生限制] Antigravity 暂不支持在飞书内直接测活模型，请在桌面端“模型渠道”页面测试。');
        return true;
      }
      if (['list', 'refresh'].includes(sub)) {
        const result = await probeModelsReadOnly(session, event, { forceRefresh: sub === 'refresh' });
        const catalog = result.catalog || extractAntigravityModelCatalog(result.models, result.configOptions);
        const info = displayModelInfo(session, catalog);
        const cacheNote = result.fromCache
          ? '（来自 5 分钟内缓存，发送 `/model refresh` 强刷）'
          : '（实时只读探针，已缓存 5 分钟）';
        const lines = catalog.baseModels.map((item) => {
          const isCurrent = Boolean(info.effectiveModel && item.id === info.effectiveModel);
          const prefix = isCurrent ? '● ' : '  ';
          const effortSuffix = item.efforts?.length ? `（强度：${item.efforts.join(' / ')}）` : '';
          return `${prefix}\`${item.id}\` · ${item.name}${effortSuffix}`;
        });
        await reply([
          `**Antigravity 原生模型目录** ${cacheNote}`,
          `当前生效：\`${info.effectiveModel || '官方默认'}\` · 思考强度：\`${info.effectiveEffort || '官方默认'}\`（${info.modelSource}）`,
          '',
          lines.join('\n') || '未返回可用模型',
          '',
          '切换模型：`/model <模型ID>` · 切换强度：`/effort <档位>`（也可 `/model <模型ID> <强度>`）',
        ].join('\n'));
        return true;
      }
      if (activeJobs.has(event.chat_id)) throw new Error('当前任务运行中不能切换模型，请等待完成或 /stop 后再执行 /model。');
      sharedSessions?.assertIdle(session);
      if (['clear', 'default', 'reset'].includes(sub)) {
        delete session.modelOverride; delete session.reasoningOverride; saveSessions();
        await reply('已清除会话模型和强度覆盖。'); return true;
      }
      if (sub === 'save') {
        const bot = botConfiguration();
        bot.provider = { ...bot.provider, model: settings(session).model, reasoning: settings(session).reasoning };
        atomicJson(config.antigravityBotConfig, bot);
        await reply('已保存为本 Bot 默认模型和强度。'); return true;
      }
      const result = await probeModelsReadOnly(session, event, { forceRefresh: false });
      const catalog = result.catalog || extractAntigravityModelCatalog(result.models, result.configOptions);
      let requestedModel = parts[0];
      let requestedEffort = parts[1] ? parts[1].trim().toLowerCase() : '';
      let matchedBase = catalog.baseModels.find((item) => item.id === requestedModel);
      if (!matchedBase && catalog.hasSplitConfig) {
        const suffixMatch = requestedModel.match(EFFORT_SUFFIX_RE);
        if (suffixMatch) {
          const stripped = requestedModel.slice(0, -suffixMatch[0].length);
          const baseCandidate = catalog.baseModels.find((item) => item.id === stripped);
          if (baseCandidate) {
            matchedBase = baseCandidate;
            requestedModel = baseCandidate.id;
            if (!requestedEffort) requestedEffort = suffixMatch[1].toLowerCase();
          }
        }
      }
      const matchedFlat = (result.models?.availableModels || []).some((item) => item.modelId === requestedModel);
      if (!matchedBase && !matchedFlat) {
        throw new Error('模型不在当前 CLI 原生目录中，请 /model list 查看');
      }
      if (requestedEffort) {
        const allowed = matchedBase?.efforts?.length ? matchedBase.efforts : (result.thoughtLevels || [...EFFORTS].filter(Boolean));
        if (!allowed.includes(requestedEffort)) throw new Error(`思考强度无效，该模型可选：${allowed.join('、')}`);
        session.reasoningOverride = requestedEffort;
      }
      session.modelOverride = requestedModel;
      saveSessions();
      await reply(`已选择模型：\`${session.modelOverride}\`${requestedEffort ? `（思考强度：\`${session.reasoningOverride}\`）` : ''}`);
      return true;
    }
    if (command.name === '/effort') {
      const value = command.rest.trim().toLowerCase();
      if (!value || ['status', 'view'].includes(value)) {
        const info = displayModelInfo(session);
        const activeBase = info.catalog?.baseModels?.find((m) => m.id === info.effectiveModel);
        const optionsText = activeBase?.efforts?.length ? activeBase.efforts.join('|') : 'low|medium|high|xhigh|max';
        await reply(`当前模型：\`${info.effectiveModel || '官方默认'}\`\n当前思考强度：${info.effortText}。用法：\`/effort ${optionsText}|clear\``);
        return true;
      }
      if (activeJobs.has(event.chat_id)) throw new Error('当前任务仍在运行，不能修改思考强度');
      sharedSessions?.assertIdle(session);
      if (['clear', 'default', 'reset'].includes(value)) {
        delete session.reasoningOverride;
        saveSessions();
        const info = displayModelInfo(session);
        await reply(`已清除会话思考强度覆盖，恢复默认：${info.effortText}。`);
        return true;
      }
      const info = displayModelInfo(session);
      const activeBase = info.catalog?.baseModels?.find((m) => m.id === info.effectiveModel);
      const allowed = activeBase?.efforts?.length
        ? activeBase.efforts
        : (info.catalog?.thoughtLevels?.length ? info.catalog.thoughtLevels : [...EFFORTS].filter(Boolean));
      if (!allowed.includes(value)) {
        throw new Error(`思考强度无效，当前模型可用选项：${allowed.join('、')}`);
      }
      session.reasoningOverride = value;
      saveSessions();
      await reply(`已保存思考强度：\`${value}\`；下一轮交给原生模型生效，不会静默降档。`);
      return true;
    }
    if (command.name === '/mode') {
      const value = command.rest.trim();
      if (!value) { await reply(`当前权限模式：${settings(session).permissionMode}`); return true; }
      if (!NATIVE_MODES.has(value)) throw new Error('支持 always-proceed、auto、accept-edits、default、plan');
      if (activeJobs.has(event.chat_id)) throw new Error('当前任务仍在运行');
      const bot = botConfiguration(); bot.antigravity = { ...bot.antigravity, permissionMode: value }; atomicJson(config.antigravityBotConfig, bot);
      await reply(`已更新权限模式为：${value}（下一轮生效）`); return true;
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
