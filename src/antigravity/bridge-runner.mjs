import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AntigravityAcpClient, antigravityContent } from './acp-client.mjs';
import configuration from './configuration.cjs';
import accountLock from './account-lock.cjs';
import { feishuMcpConfiguration } from '../claude/feishu-tools.mjs';
import { applyCloakBrowserIsolationToServer, resolveCloakBrowserDirs } from '../config/cloakbrowser.mjs';
import { buildAccessContext, isOwnerDmContext } from '../sessions/access-control.mjs';
import { compressIndexes, parseDeleteSelectionSpec } from '../sessions/delete-selection.mjs';
import {
  STEER_CANCELLED_BY_CLEARQUEUE_REPLY,
  ensureSteerEntry,
  isSteerEntryCancelled,
  markSteerEntryDispatched,
  removeSteerEntry,
} from '../runtime/steer-generation.mjs';
import {
  antigravityNativeArtifacts,
  deleteAntigravityNativeConversation,
  getAntigravityConversationState,
  isAntigravityConversationBusy,
  isInAntigravityDesktopSidebar,
  listAntigravityNativeConversations,
} from './native-sessions.mjs';

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
  pendingAttachments = null, cleanupClearedDownloads = null,
  createClient = (options) => new AntigravityAcpClient(options) }) {
  const withAttachmentLock = (chatId, fn) => (
    pendingAttachments?.withAttachmentLock
      ? pendingAttachments.withAttachmentLock(chatId, fn)
      : Promise.resolve().then(fn)
  );
  const takePendingForChat = (chatId) => (pendingAttachments?.take ? pendingAttachments.take(chatId) : []);
  const restorePendingForChat = (chatId, items) => {
    if (!items?.length) return;
    if (pendingAttachments?.restore) pendingAttachments.restore(chatId, items);
    else if (pendingAttachments?.add) pendingAttachments.add(chatId, items);
  };
  const cleanupPendingForChat = (chatId) => (pendingAttachments?.cleanup ? pendingAttachments.cleanup(chatId) : []);
  const clients = new Set(); const permissions = new Map(); const listViews = new Map(); const deleteViews = new Map();
  const backgroundSessions = new Map();
  const modelCatalogCache = new Map();
  const MODEL_CATALOG_TTL_MS = 5 * 60_000;
  const BG_POLL_MS = Math.max(20, Number(config.antigravityBackgroundPollMs) || 3000);
  const BG_FLUSH_QUIET_MS = Math.max(20, Number(config.antigravityBackgroundFlushMs) || 2500);
  const BG_USAGE_FLUSH_MS = Math.max(10, Number(config.antigravityBackgroundUsageFlushMs) || 600);
  const BG_MAX_MS = Math.max(1000, Number(config.antigravityBackgroundTimeoutMs) || 4 * 60 * 60_000);
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

  function isDesktopSidebarOwned({ geminiDir, appDataDir, conversationId } = {}) {
    return Boolean(
      appDataDir === 'antigravity'
      && conversationId
      && isInAntigravityDesktopSidebar({
        geminiDir: geminiDir || config.antigravityDesktopGeminiDir,
        appDataDir,
        conversationId,
      }),
    );
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
    // New Feishu-created conversations always live in Bridge's own native CLI store
    // (antigravity-cli) rather than polluting Desktop's ~/.gemini/antigravity directory
    // where the running Desktop sidebar does not display them and /delete would refuse to remove them.
    // Conversations created in Desktop still appear in /list all and bind to Desktop via /switch.
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
        const desktopSidebar = src.appDataDir === 'antigravity'
          && isInAntigravityDesktopSidebar({ geminiDir: src.geminiDir, appDataDir: src.appDataDir, conversationId: item.conversationId });
        results.push({
          ...item,
          desktopSidebar,
          sourceLabel: desktopSidebar ? '客户端侧边栏' : 'Bridge 原生库',
        });
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

  function sessionFingerprint(session, selected, target) {
    return JSON.stringify([
      session?.id || '',
      session?.antigravitySessionId || '',
      selected?.provider || '',
      selected?.model || '',
      selected?.reasoning || '',
      selected?.permissionMode || '',
      target?.geminiDir || '',
      target?.appDataDir || '',
      session?.antigravityWorkspace || config.workspace || '',
    ]);
  }

  function flushBackgroundBuffer(entry) {
    if (!entry) return Promise.resolve();
    clearTimeout(entry.flushTimer);
    entry.flushTimer = null;
    const text = entry.outOfTurnText.trim();
    if (!text) {
      entry.outOfTurnText = '';
      return entry.flushChain;
    }
    entry.outOfTurnText = '';
    if (entry.client && !entry.client.turnActive) entry.client.text = '';
    entry.flushChain = entry.flushChain.catch(() => {}).then(async () => {
      try {
        entry.session.messages ||= [];
        entry.session.messages.push({ role: 'assistant', content: text, at: Date.now() });
        saveSessions();
      } catch {}
      try {
        await sendMarkdown(
          entry.chatId,
          `**Antigravity 后台任务进展**\n\n${text}`,
          'antigravity-background-wakeup',
          entry.replyMessageId,
        );
      } catch {}
    });
    return entry.flushChain;
  }

  function clearBackgroundTimers(entry) {
    if (!entry) return;
    clearInterval(entry.pollTimer);
    clearTimeout(entry.flushTimer);
    clearTimeout(entry.maxTimer);
    entry.pollTimer = null;
    entry.flushTimer = null;
    entry.maxTimer = null;
  }

  function releaseEntryLeases(entry) {
    if (!entry || entry.leasesReleased) return;
    entry.leasesReleased = true;
    try { entry.releaseAccount?.(); } catch {}
    try { entry.releaseSession?.(); } catch {}
  }

  async function retireBackgroundSession(chatId, reason = 'retired', { interrupt = false, flush = true } = {}) {
    const entry = backgroundSessions.get(chatId);
    if (!entry) return false;
    backgroundSessions.delete(chatId);
    entry.retired = true;
    clearBackgroundTimers(entry);
    if (flush) await flushBackgroundBuffer(entry);
    else entry.outOfTurnText = '';
    if (interrupt && !entry.client.closed) {
      try { entry.client.interrupt(); } catch {}
    }
    clients.delete(entry.client);
    try { await entry.client.close(); } catch {}
    releaseEntryLeases(entry);
    return true;
  }

  function parkBackgroundSession({ chatId, session, client, target, selected, fingerprint, releaseAccount, releaseSession, replyMessageId, event }) {
    const entry = {
      chatId,
      session,
      client,
      target,
      selected,
      fingerprint,
      releaseAccount,
      releaseSession,
      replyMessageId,
      event,
      outOfTurnText: '',
      flushChain: Promise.resolve(),
      flushTimer: null,
      pollTimer: null,
      maxTimer: null,
      lastEventAt: Date.now(),
      idleStreak: 0,
      parkedAt: Date.now(),
      retired: false,
      leasesReleased: false,
    };
    backgroundSessions.set(chatId, entry);

    const scheduleOutOfTurnFlush = (delayMs) => {
      if (entry.retired) return;
      clearTimeout(entry.flushTimer);
      entry.flushTimer = setTimeout(() => { void flushBackgroundBuffer(entry); }, delayMs);
      entry.flushTimer?.unref?.();
    };

    client.onPermission = (request) => (selected.permissionMode === 'always-proceed' ? true : requestPermission(event, request));
    client.onEvent = (item) => {
      if (entry.retired || backgroundSessions.get(chatId) !== entry) return;
      const update = item.update || {};
      entry.lastEventAt = Date.now();
      entry.idleStreak = 0;
      if (item.type === 'session_info_update' && update.title && !session.userRenamed) {
        session.title = update.title;
        saveSessions();
      }
      if (item.type === 'usage_update') {
        session.lastContextUsage = {
          usedTokens: update.used,
          contextWindow: update.size,
          percent: update.size > 0 ? Math.round(update.used / update.size * 1000) / 10 : null,
          updatedAt: Date.now(),
        };
        saveSessions();
        if (entry.outOfTurnText.trim()) scheduleOutOfTurnFlush(BG_USAGE_FLUSH_MS);
      }
      if (item.type === 'agent_message_chunk' && update.content?.type === 'text') {
        entry.outOfTurnText += update.content.text;
        scheduleOutOfTurnFlush(BG_FLUSH_QUIET_MS);
      }
    };

    entry.pollTimer = setInterval(() => {
      if (entry.retired || backgroundSessions.get(chatId) !== entry) return;
      if (client.closed || client.stopped) {
        void retireBackgroundSession(chatId, 'client-closed', { interrupt: false, flush: true });
        return;
      }
      const hasTools = Boolean(client.hasPendingTools?.());
      const dbState = session.antigravitySessionId
        ? getAntigravityConversationState({ geminiDir: target.geminiDir, appDataDir: target.appDataDir, conversationId: session.antigravitySessionId })
        : { exists: false, running: false, notFullyIdle: false };
      const recentEvent = Date.now() - entry.lastEventAt < BG_POLL_MS;
      const stillActive = hasTools || recentEvent || (dbState.exists && (dbState.running || dbState.notFullyIdle));
      if (stillActive) {
        entry.idleStreak = 0;
      } else {
        entry.idleStreak += 1;
        if (entry.idleStreak >= 2) {
          void retireBackgroundSession(chatId, 'background-completed', { interrupt: false, flush: true });
        }
      }
    }, BG_POLL_MS);
    entry.pollTimer?.unref?.();

    entry.maxTimer = setTimeout(() => {
      if (backgroundSessions.get(chatId) === entry) {
        void retireBackgroundSession(chatId, 'background-timeout', { interrupt: true, flush: true });
      }
    }, BG_MAX_MS);
    entry.maxTimer?.unref?.();

    client.closedPromise?.then(() => {
      if (backgroundSessions.get(chatId) === entry) {
        void retireBackgroundSession(chatId, 'process-exited', { interrupt: false, flush: true });
      }
    });
    return entry;
  }

  async function stopBackground(chatId, { all = false } = {}) {
    if (all) {
      const ids = [...backgroundSessions.keys()];
      let count = 0;
      for (const id of ids) {
        if (await retireBackgroundSession(id, 'stop-all', { interrupt: true, flush: true })) count += 1;
      }
      return count;
    }
    return (await retireBackgroundSession(chatId, 'user-stop', { interrupt: true, flush: true })) ? 1 : 0;
  }

  function hasBackground(chatId) {
    return backgroundSessions.has(chatId);
  }

  async function run(event, session, state, onState, contentOverride) {
    try {
      return await runInternal(event, session, state, onState, contentOverride);
    } catch (error) {
      if (error && typeof error === 'object' && !error.engine) error.engine = 'antigravity';
      throw error;
    }
  }

  async function runInternal(event, session, state, onState, contentOverride) {
    if (session.engine && session.engine !== 'antigravity') throw new Error('此会话属于其他内核，请 /new 创建 Antigravity 会话');
    const selected = settings(session); const startedAt = Date.now();
    const provider = selectProvider(catalogRoot, selected.provider);
    const target = resolveSessionTarget(session, provider);
    const desiredFingerprint = sessionFingerprint(session, selected, target);

    let reusedParked = false;
    let client;
    let releaseSession = null;
    let releaseAccount = null;

    const parked = backgroundSessions.get(event.chat_id);
    if (parked) {
      if (parked.fingerprint === desiredFingerprint && !parked.client.closed && !parked.client.stopped) {
        backgroundSessions.delete(event.chat_id);
        parked.retired = true;
        clearBackgroundTimers(parked);
        await flushBackgroundBuffer(parked);
        client = parked.client;
        releaseSession = parked.releaseSession;
        releaseAccount = parked.releaseAccount;
        reusedParked = true;
      } else {
        await retireBackgroundSession(event.chat_id, 'session-replaced', { interrupt: true, flush: true });
      }
    }

    if (!reusedParked) {
      if (session.antigravitySessionId && target.appDataDir === 'antigravity'
        && isAntigravityConversationBusy({ geminiDir: target.geminiDir, appDataDir: target.appDataDir, conversationId: session.antigravitySessionId })) {
        throw Object.assign(
          new Error('该对话正在 Antigravity 客户端中运行，请等待客户端本轮结束后再在飞书续接。'),
          { engine: 'antigravity', code: 'ANTIGRAVITY_DESKTOP_BUSY' },
        );
      }
      releaseSession = sharedSessions
        ? (sharedSessions.acquireAsync ? await sharedSessions.acquireAsync(session) : sharedSessions.acquire(session))
        : null;
      try { releaseAccount = accountLock.acquireOfficialLease(catalogRoot, provider); }
      catch (error) { releaseSession?.(); throw error; }
    }

    let flushTimer; let flushing = Promise.resolve();
    const flush = () => { clearTimeout(flushTimer); flushTimer = null; flushing = flushing.then(() => onState?.(state)); return flushing; };
    const schedule = () => { if (!flushTimer) flushTimer = setTimeout(() => { void flush().catch(() => {}); }, 150); };
    let initialized = reusedParked;
    const foregroundOnEvent = (item) => {
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
    };
    const foregroundOnPermission = (request) => (selected.permissionMode === 'always-proceed' ? true : requestPermission(event, request));

    if (!reusedParked) {
      try { client = newClient(session, event, foregroundOnEvent, target); }
      catch (error) { releaseAccount?.(); releaseSession?.(); throw error; }
      clients.add(client);
    } else {
      client.onEvent = foregroundOnEvent;
      client.onPermission = foregroundOnPermission;
    }

    const job = {
      client, mode: 'antigravity', sessionId: session.id, messageId: event.message_id || event.id, startedAt,
      clearGeneration: 0, pendingSteerEntries: [], steerInFlight: null,
      ...(reusedParked ? { pid: client.child?.pid, threadId: session.antigravitySessionId } : {}),
    };
    activeJobs.set(event.chat_id, job);
    let runSucceeded = false;
    let shouldPark = false;
    try {
      if (state) { state.meta.engine = 'antigravity'; markPhase(state, reusedParked ? 'model_thinking' : 'initializing', { connection: reusedParked ? 'connected' : 'starting' }); await flush(); }
      // Record the exact source. Switching a channel must not silently replay into an unrelated native session.
      if (session.antigravitySourceId && session.antigravitySourceId !== selected.provider) {
        throw new Error('此原生会话已绑定另一渠道。请切回原渠道继续，或 /new 创建新会话后使用新渠道。');
      }
      if (!reusedParked) {
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
      } else if (state) {
        state.threadId = session.antigravitySessionId || client.sessionId;
        const info = displayModelInfo(session);
        if (info.effectiveModel) state.meta.model = info.effectiveEffort ? `${info.effectiveModel} (${info.effectiveEffort})` : info.effectiveModel;
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
      runSucceeded = true;
      const dbState = session.antigravitySessionId
        ? getAntigravityConversationState({ geminiDir: target.geminiDir, appDataDir: target.appDataDir, conversationId: session.antigravitySessionId })
        : { exists: false, running: false, notFullyIdle: false };
      shouldPark = !client.closed && !client.stopped && (
        Boolean(client.hasPendingTools?.())
        || Boolean(dbState.exists && (dbState.running || dbState.notFullyIdle))
      );
      return { text: result.text || '(Antigravity 没有返回文字)', durationMs: Date.now() - startedAt,
        tokens: `${usage.inputTokens || 0}↑ ${usage.outputTokens || 0}↓` };
    } catch (error) {
      error.engine = 'antigravity';
      if (state) { if (error.code === 'USER_STOP') markInterrupted(state); else markError(state, error); await flush(); }
      throw error;
    } finally {
      for (const [token, pending] of permissions) if (pending.event === event) { clearTimeout(pending.timer); pending.resolve(false); permissions.delete(token); }
      clearTimeout(flushTimer);
      if (activeJobs.get(event.chat_id)?.client === client) activeJobs.delete(event.chat_id);
      if (runSucceeded && shouldPark && !client.closed && !client.stopped) {
        parkBackgroundSession({
          chatId: event.chat_id,
          session,
          client,
          target,
          selected,
          fingerprint: sessionFingerprint(session, selected, target),
          releaseAccount,
          releaseSession,
          replyMessageId: event.message_id || event.id,
          event,
        });
      } else {
        clients.delete(client);
        await client.close();
        releaseAccount?.();
        releaseSession?.();
      }
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
      // agy ACP native steering: another session/prompt during a running turn joins that turn,
      // and the agent reads it after its current step. No new conversation is created.
      const chatId = event.chat_id;
      const messageId = event.message_id || event.id;
      const directAttachments = Array.isArray(event.attachments) ? event.attachments : [];
      const userContent = command.rest.trim();
      const job = event._steerJob || activeJobs.get(chatId);
      const entry = job ? ensureSteerEntry({ event, job, chatId, messageId }) : null;
      const cleanupDirect = () => {
        if (directAttachments.length && typeof cleanupClearedDownloads === 'function') cleanupClearedDownloads(directAttachments);
      };
      if (entry && isSteerEntryCancelled(job, entry)) {
        removeSteerEntry(job, entry);
        cleanupDirect();
        await reply(STEER_CANCELLED_BY_CLEARQUEUE_REPLY);
        return true;
      }
      const failed = event.attachmentDownload?.failed;
      if (failed?.image || failed?.file) {
        if (entry) { entry.state = 'failed'; removeSteerEntry(job, entry); }
        if (directAttachments.length) await withAttachmentLock(chatId, () => restorePendingForChat(chatId, directAttachments));
        throw new Error('附件下载不完整，本次补充指令未发送，请重试');
      }
      const pendingPreview = cleanupPendingForChat(chatId);
      if (!userContent && !directAttachments.length && !pendingPreview.length) {
        if (entry) { entry.state = 'failed'; removeSteerEntry(job, entry); }
        await reply('用法：`/steer <要追加到当前任务的补充指令>`（任务运行中发送，Antigravity 做完当前这一步后读取）');
        return true;
      }
      const liveJob = activeJobs.get(chatId);
      const steerable = (candidate) => Boolean(candidate && candidate.mode === 'antigravity'
        && typeof candidate.client?.steer === 'function' && candidate.client.canSteer?.() !== false);
      if (!steerable(liveJob) || (job && liveJob !== job)) {
        if (entry) { entry.state = 'failed'; removeSteerEntry(job, entry); }
        delete event._steerEntry;
        delete event._steerJob;
        if (directAttachments.length) await withAttachmentLock(chatId, () => restorePendingForChat(chatId, directAttachments));
        const starting = liveJob && liveJob === job && liveJob.mode === 'antigravity';
        await reply(starting
          ? '当前 Antigravity 任务还在启动，尚未进入可追加阶段，请几秒后再发 /steer。'
          : (job && liveJob !== job ? '当前任务已结束，未追加任何内容。' : '当前没有正在运行的 Antigravity 任务；直接发送消息即可开始新一轮。'));
        return true;
      }
      const previous = liveJob.steerInFlight || Promise.resolve();
      let outcome = 'sent';
      let takenAttachments = [];
      const current = previous.catch(() => {}).then(async () => {
        if (entry && isSteerEntryCancelled(liveJob, entry)) { outcome = 'cancelled'; cleanupDirect(); return; }
        if (activeJobs.get(chatId) !== liveJob || !steerable(liveJob)) {
          outcome = 'ended';
          if (directAttachments.length) await withAttachmentLock(chatId, () => restorePendingForChat(chatId, directAttachments));
          return;
        }
        takenAttachments = await withAttachmentLock(chatId, () => [...takePendingForChat(chatId), ...directAttachments]);
        const payload = antigravityContent(userContent, takenAttachments);
        if (entry && isSteerEntryCancelled(liveJob, entry)) {
          outcome = 'cancelled';
          const pendingOnly = takenAttachments.filter((item) => !directAttachments.includes(item));
          if (pendingOnly.length) await withAttachmentLock(chatId, () => restorePendingForChat(chatId, pendingOnly));
          cleanupDirect();
          return;
        }
        // Point of no return: mark dispatched before writing the steer prompt to native agy.
        markSteerEntryDispatched(liveJob, entry);
        liveJob.client.steer(payload);
        const running = chat.sessions.find((s) => s.id === liveJob.sessionId);
        if (running) {
          running.messages ||= [];
          running.messages.push({ role: 'user', content: userContent, at: Date.now() });
          saveSessions();
        }
      });
      liveJob.steerInFlight = current;
      try {
        await current;
        if (outcome === 'cancelled') await reply(STEER_CANCELLED_BY_CLEARQUEUE_REPLY);
        else if (outcome === 'ended') await reply('当前任务已结束，未追加任何内容。');
        else await reply('已将补充指令并入当前 Antigravity 任务，它做完手头这一步后就会读取；不会另开会话。');
      } catch (error) {
        if (entry && entry.state === 'pending') entry.state = 'failed';
        const restore = takenAttachments.length ? takenAttachments : directAttachments;
        if (restore.length) await withAttachmentLock(chatId, () => restorePendingForChat(chatId, restore));
        throw error;
      } finally {
        if (entry) removeSteerEntry(liveJob, entry);
        delete event._steerEntry;
        delete event._steerJob;
        if (liveJob.steerInFlight === current) liveJob.steerInFlight = null;
      }
      return true;
    }
    if (command.name === '/fast') {
      await reply('[原生限制] Antigravity 原生 ACP 协议不支持 Codex /fast 服务档位，当前模型与思考强度保持原设置。');
      return true;
    }
    if (['/approve', '/deny'].includes(command.name)) {
      const pending = permissions.get(command.rest.trim());
      if (!pending || pending.chatId !== event.chat_id || (pending.senderId && pending.senderId !== event.sender_id)) await reply('工具请求已过期或不属于当前用户。');
      else { pending.resolve(command.name === '/approve'); await reply(command.name === '/approve' ? '已允许本次调用。' : '已拒绝本次调用。'); }
      return true;
    }
    if (command.name === '/help') {
      await reply([
        '**Antigravity Bot 命令**',
        '',
        '`/help` — 显示帮助',
        '`/status` / `/now` / `/how` / `/context` — 查看内核、模型、渠道、后台保活与上下文状态',
        '`/new [标题]` — 创建新的独立飞书会话',
        '`/reset` — 重开干净会话，保留当前模型与渠道设置',
        '`/list [all]` / `/sessions [all]` — 列出共享会话（`/list all` 同时列出 Antigravity 客户端侧边栏对话）',
        '`/switch <序号或ID>` — 切换到已有飞书会话或客户端侧边栏对话续聊',
        '`/rename [序号] 新标题` — 修改当前或指定会话名称',
        '`/delete <序号或区间>` — 预览删除（支持 `1 3-14`、`2,5-8`）；需 `/confirm delete <序号或区间>` 确认（客户端侧边栏对话只解绑，需在客户端左侧栏右键删除）',
        '`/provider [list|渠道ID|save|clear]` — 查看、切换或保存当前渠道',
        '`/model` / `/model list` / `/model refresh` / `/model capability` — 查看模型状态、刷新目录或查看支持强度',
        '`/model <模型ID> [强度]` — 切换当前会话模型与思考强度',
        '`/model effort <强度|clear>` / `/effort <强度|clear>` — 独立切换或清除思考强度',
        '`/model save [模型ID] [强度]` / `/model save effort <强度>` — 保存为本 Bot 默认',
        '`/model clear` — 恢复本 Bot 默认模型与强度',
        '`/mode [always-proceed|auto|accept-edits|default|plan]` — 查看或切换工具执行授权模式',
        '`/steer <补充指令>` — 任务运行中追加要求，并入当前这一轮，做完手头这一步后读取',
        '`/stop` / `/stopall` — 停止当前任务或后台等待唤醒会话',
        '`/queue` / `/clearqueue [all]` — 查看或清空等待队列',
        '`/approve 请求码` / `/deny 请求码` — 回答工具授权请求',
        '',
        '原生斜杠指令直接透传执行：`/goal`、`/compact`、`/plan`、`/boost`、`/teamwork`、`/swarm`、`/schedule`、`/browser`、`/grill-me`、`/learn`、`/btw` 及全部原生技能。',
        '不支持的指令（[原生限制]）：`/fast`、`/model test`。',
        '官方账号登录与手动切换请在客户端的 Antigravity 区域操作；不会自动轮换账号。',
      ].join('\n')); return true;
    }
    if (command.name === '/new' || command.name === '/reset') {
      if (activeJobs.has(event.chat_id)) { await reply('当前任务仍在运行，请先 /stop 或等待完成。'); return true; }
      const stoppedBg = await retireBackgroundSession(event.chat_id, 'new-session', { interrupt: true, flush: true });
      const previous = command.name === '/reset' ? currentSession() : null;
      const next = resetSession(event.chat_id, command.rest || '新 Antigravity 会话', accessCtx);
      if (previous) for (const key of ['providerOverride', 'modelOverride', 'reasoningOverride']) next[key] = previous[key];
      saveSessions(); await reply(`已创建 Antigravity 会话：${next.title} (${next.id})${stoppedBg ? '\n（已结束原会话的后台保活）' : ''}`); return true;
    }
    if (['/list', '/sessions'].includes(command.name)) {
      const showAll = /\ball\b/i.test(command.rest || '');
      const nativeAll = collectNativeConversations(chat, accessCtx);
      const workspaceMatches = nativeAll.filter((item) => item.cwd && samePath(item.cwd, config.workspace));
      const visibleNative = showAll ? nativeAll : workspaceMatches;
      const hiddenDesktopCount = showAll ? 0 : Math.max(0, nativeAll.length - visibleNative.length);

      const merged = [
        ...chat.sessions.map((item) => {
          const inDesktopSidebar = isDesktopSidebarOwned({
            geminiDir: item.antigravityHome,
            appDataDir: item.antigravityAppDataDir,
            conversationId: item.antigravitySessionId,
          });
          return {
            kind: 'bridge',
            id: item.id,
            updatedAt: Number(item.updatedAt || item.createdAt || 0),
            current: item.id === chat.currentSessionId,
            label: `${item.id === chat.currentSessionId ? '● ' : ''}${item.title} · ${item.id}${item.antigravityOriginBot ? ` · ${item.antigravityOriginBot}` : ''}${inDesktopSidebar ? ' · 客户端侧边栏' : ''}`,
          };
        }),
        ...visibleNative.map((item) => {
          const dirTag = item.cwd ? ` · ${path.basename(item.cwd)}` : '';
          const busyTag = item.running ? ' · [客户端运行中]' : '';
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
        ? merged.map((entry, index) => `**${index + 1}.** ${entry.label}`).join('\n')
        : '当前作用域下暂无会话，可直接发送消息或使用 `/new` 创建。';
      const footer = [
        hiddenDesktopCount > 0 ? `Antigravity 客户端侧边栏另有 ${hiddenDesktopCount} 条原生对话，发送 \`/list all\` 查看全部并支持 \`/switch <序号>\` 续接。` : '',
        '发送 `/switch <序号或ID>` 切换续接；`/delete 1 3-5` 预览批量删除；`/new [标题]` 新建对话。',
      ].filter(Boolean).join('\n');
      await reply(`${title}\n${body}\n\n${footer}`);
      return true;
    }
    if (command.name === '/switch') {
      if (activeJobs.has(event.chat_id)) { await reply('当前任务仍在运行，请先 /stop 或等待完成。'); return true; }
      const resolved = resolveBridgeOrNativeTarget(event, command.rest.trim());
      if (!resolved) { await reply(`未找到可访问的会话：${command.rest.trim()}，请先发送 /list 或 /list all 查看可用序号。`); return true; }
      const stoppedBg = await retireBackgroundSession(event.chat_id, 'switch-session', { interrupt: true, flush: true });
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
        await reply(`已切换到原生对话：${bound.title} (${bound.id})\n工作区：${bound.antigravityWorkspace || config.workspace}${stoppedBg ? '\n（已结束原会话的后台保活）' : ''}`);
        return true;
      }
      const target = resolved.session;
      sharedSessions?.assertIdle(target);
      chat.currentSessionId = target.id; saveSessions(); await reply(`已切换：${target.title} (${target.id})${stoppedBg ? '\n（已结束原会话的后台保活）' : ''}`); return true;
    }
    if (command.name === '/rename') {
      if (activeJobs.has(event.chat_id)) { await reply('当前会话正在运行，请等待本轮结束后再重命名。'); return true; }
      if (!command.rest.trim()) { await reply('用法：/rename 新标题'); return true; }
      const match = command.rest.trim().match(/^(\d+|[a-f0-9-]{12,})\s+(.+)$/i);
      const target = match ? resolveSession(event, match[1]) : currentSession();
      if (!target) throw new Error(`未找到可访问的会话：${match ? match[1] : ''}，请先发送 /list 查看可用序号。`);
      if (backgroundSessions.get(event.chat_id)?.session?.id !== target.id) sharedSessions?.assertIdle(target);
      target.title = (match ? match[2] : command.rest.trim()).slice(0, 160); target.userRenamed = true; saveSessions(); await reply(`已重命名：${target.title}`); return true;
    }
    if (['/delete', '/del', '/rm'].includes(command.name)) {
      if (activeJobs.has(event.chat_id) || backgroundSessions.has(event.chat_id)) {
        await reply('当前聊天有任务或后台等待唤醒会话正在运行，请先 /stop 或等待结束后再执行 /delete。'); return true;
      }
      const rawSpec = command.rest.trim();
      if (!rawSpec) {
        await reply('用法：`/delete <序号或ID>`，支持批量与区间（例如 `/delete 1 3-14`、`/delete 2,5-8`）。请先 `/list` 或 `/list all` 查看序号。');
        return true;
      }
      for (const token of rawSpec.split(/[\s,，、]+/)) {
        if (/^\d+(?:[-~～]\d+)?$/.test(token) && token.split(/[-~～]/).some((part) => Number(part) > 10_000)) {
          await reply('会话序号超出范围，请先发送 `/list` 或 `/list all` 查看有效序号。');
          return true;
        }
      }
      const parsed = parseDeleteSelectionSpec(rawSpec);
      if (parsed.error) {
        await reply(parsed.error === 'empty' ? '请输入会话序号或 ID。' : parsed.error);
        return true;
      }

      const view = listViews.get(viewKey(event));
      const viewValid = Boolean(view && Date.now() - view.at <= 5 * 60_000 && Array.isArray(view.items));
      const resolvedItems = [];
      // Conversations in the Antigravity Desktop store are owned by the running Desktop app: it keeps
      // its sidebar list in memory and rewrites the index from it, so deleting their files from outside
      // only leaves content-less ghosts that come back. The Bot never deletes them; it lists them and
      // points the user to the Desktop sidebar's own delete.
      const desktopOnlyItems = [];

      const pushResolved = (resolved, index) => {
        if (!resolved) return false;
        if (resolved.kind === 'bridge') {
          const s = resolved.session;
          const nativeId = String(s.antigravitySessionId || '').trim();
          const targetInfo = nativeId ? resolveSessionTarget(s, selectProvider(catalogRoot, settings(s).provider)) : null;
          const desktopOwned = isDesktopSidebarOwned({
            geminiDir: targetInfo?.geminiDir || s.antigravityHome,
            appDataDir: targetInfo?.appDataDir || s.antigravityAppDataDir,
            conversationId: nativeId,
          });
          resolvedItems.push({
            index,
            kind: 'bridge',
            id: s.id,
            nativeId,
            title: s.title || '未命名会话',
            sourceLabel: desktopOwned ? '仅解除飞书关联（原对话在客户端侧边栏）' : '共享会话绑定',
            desktopOwned,
            geminiDir: targetInfo?.geminiDir || '',
            appDataDir: targetInfo?.appDataDir || '',
          });
          return true;
        }
        if (resolved.kind === 'native') {
          if (!isOwnerDmContext(accessCtx)) return false;
          const n = resolved.native;
          const desktopOwned = typeof n.desktopSidebar === 'boolean'
            ? n.desktopSidebar
            : isDesktopSidebarOwned({ geminiDir: n.geminiDir, appDataDir: n.appDataDir, conversationId: n.conversationId });
          const item = {
            index,
            kind: 'native',
            id: n.conversationId.slice(0, 8),
            nativeId: n.conversationId,
            title: n.title || n.conversationId.slice(0, 8),
            sourceLabel: n.sourceLabel || (desktopOwned ? '客户端侧边栏' : 'Bridge 原生库'),
            desktopOwned,
            geminiDir: n.geminiDir,
            appDataDir: n.appDataDir,
          };
          if (item.desktopOwned) desktopOnlyItems.push(item);
          else resolvedItems.push(item);
          return true;
        }
        return false;
      };

      if (parsed.indexes) {
        const directSingle = parsed.indexes.length === 1 && !parsed.isBatch
          ? chat.sessions.find((item) => item.id === rawSpec || item.antigravitySessionId === rawSpec)
          : null;
        if (directSingle) {
          pushResolved({ kind: 'bridge', session: directSingle }, chat.sessions.indexOf(directSingle) + 1);
        } else {
          if (!viewValid && parsed.indexes.some((idx) => idx > chat.sessions.length)) {
            await reply('请先发送 `/list` 或 `/list all` 获取最新会话序号后再删除。');
            return true;
          }
          for (const idx of parsed.indexes) {
            if (viewValid) {
              const entry = view.items[idx - 1];
              if (!entry) { await reply(`未找到序号 ${idx} 对应的会话，请先发送 /list 或 /list all 查看可用序号。`); return true; }
              if (entry.kind === 'native') {
                if (!pushResolved({ kind: 'native', native: entry.native }, idx)) {
                  await reply(`无权删除序号 ${idx} 对应的原生会话。`);
                  return true;
                }
              } else {
                const found = chat.sessions.find((item) => item.id === entry.id);
                if (!found) { await reply(`序号 ${idx} 对应的会话已不存在，请重新 /list。`); return true; }
                pushResolved({ kind: 'bridge', session: found }, idx);
              }
            } else {
              const found = chat.sessions[idx - 1];
              if (!found) { await reply(`未找到序号 ${idx} 对应的会话，请先发送 /list 查看可用序号。`); return true; }
              pushResolved({ kind: 'bridge', session: found }, idx);
            }
          }
        }
      } else {
        const resolved = resolveBridgeOrNativeTarget(event, parsed.target);
        if (!resolved || !pushResolved(resolved, 1)) {
          await reply(`未找到可访问的会话：${rawSpec}，请先发送 /list 或 /list all 查看可用序号。`);
          return true;
        }
      }

      const desktopGuide = (items) => [
        `以下 ${items.length} 条是 Antigravity 客户端侧边栏里的对话，归客户端管理，Bot 不会从外部删除（外部删除会被客户端写回、只剩空壳）。请在 Antigravity 客户端左侧栏对它们右键 → 删除：`,
        ...items.slice(0, 20).map((item) => `**${item.index}.** ${item.title} · \`${item.id}\``),
        ...(items.length > 20 ? [`… 其余 ${items.length - 20} 条已省略`] : []),
      ];

      if (!resolvedItems.length) {
        if (desktopOnlyItems.length) {
          await reply(['**Antigravity 会话删除**', '', ...desktopGuide(desktopOnlyItems), '', '本次没有需要 Bot 删除的会话。'].join('\n'));
          return true;
        }
        await reply(`未找到可访问的会话：${rawSpec}，请先发送 /list 或 /list all 查看可用序号。`);
        return true;
      }

      let artifactCount = 0;
      for (const item of resolvedItems) {
        if (item.kind === 'bridge') {
          const found = chat.sessions.find((s) => s.id === item.id);
          if (!found) throw new Error('会话绑定已变化，请重新 /list 预览');
          if ([...activeJobs.values()].some((job) => job.sessionId === found.id)) {
            throw new Error(`会话「${item.title}」正在运行，不能删除`);
          }
          sharedSessions?.assertIdle(found);
        }
        if (item.nativeId && item.geminiDir && !item.desktopOwned) {
          if (isAntigravityConversationBusy({ geminiDir: item.geminiDir, appDataDir: item.appDataDir, conversationId: item.nativeId })) {
            throw new Error(`对话「${item.title}」正在 Antigravity 客户端中运行，请等待结束后再删除。`);
          }
          artifactCount += antigravityNativeArtifacts({ geminiDir: item.geminiDir, appDataDir: item.appDataDir, conversationId: item.nativeId }).length;
        }
      }

      const confirmText = parsed.indexes ? compressIndexes(resolvedItems.map((item) => item.index)) : rawSpec;
      const ttl = Number(config.deleteConfirmTtlMs) > 0 ? Number(config.deleteConfirmTtlMs) : 5 * 60_000;
      const expiresAt = Date.now() + ttl;
      deleteViews.set(viewKey(event), {
        items: resolvedItems, desktopOnlyItems, confirmText, isIndexSpec: Boolean(parsed.indexes), at: Date.now(), expiresAt,
      });

      const previewLines = resolvedItems.slice(0, 20).map((item) => (
        `**${item.index}.** ${item.title} · \`${item.id}\` · ${item.sourceLabel}${item.kind === 'bridge' && item.id === chat.currentSessionId ? ' · 当前会话' : ''}`
      ));
      if (resolvedItems.length > 20) previewLines.push(`… 其余 ${resolvedItems.length - 20} 条已省略`);
      await reply([
        '**Antigravity 会话删除确认**',
        '',
        `待删除：${resolvedItems.length} 条（关联本地会话文件/目录 ${artifactCount} 个）；工作区代码与文件完整保留。`,
        ...previewLines,
        ...(desktopOnlyItems.length ? ['', ...desktopGuide(desktopOnlyItems)] : []),
        '',
        `确认删除请输入：\`/confirm delete ${confirmText}\``,
      ].join('\n'));
      return true;
    }
    if (command.name === '/confirm') {
      if (activeJobs.has(event.chat_id) || backgroundSessions.has(event.chat_id)) {
        await reply('当前聊天有任务或后台等待唤醒会话正在运行，请先 /stop 或等待结束后再执行 /delete。'); return true;
      }
      const pending = deleteViews.get(viewKey(event));
      const match = command.rest.trim().match(/^delete\s+(.+)$/i);
      if (!pending || !match || Date.now() > (pending.expiresAt || pending.at + 5 * 60_000)) {
        await reply('删除确认无效或过期，请重新 /delete 预览。');
        return true;
      }
      const confirmArg = match[1].trim();
      let matched = confirmArg === pending.confirmText;
      if (!matched && pending.isIndexSpec) {
        const parsedConfirm = parseDeleteSelectionSpec(confirmArg);
        if (parsedConfirm.indexes && compressIndexes(parsedConfirm.indexes) === pending.confirmText) matched = true;
      }
      if (!matched) {
        await reply(`删除确认与预览不一致，请输入 \`/confirm delete ${pending.confirmText}\` 或重新 /delete 预览。`);
        return true;
      }

      const bridgeItems = pending.items.filter((item) => item.kind === 'bridge');
      const nativeItems = pending.items.filter((item) => item.kind === 'native');
      const bridgeTargets = bridgeItems.map((item) => {
        const found = chat.sessions.find((s) => s.id === item.id);
        if (!found || String(found.antigravitySessionId || '').trim() !== item.nativeId) {
          throw new Error('会话绑定已变化，请重新 /list 并 /delete 预览');
        }
        if ([...activeJobs.values()].some((job) => job.sessionId === found.id)) {
          throw new Error(`会话「${item.title}」正在运行，不能删除`);
        }
        return { item, session: found };
      });
      for (const item of pending.items) {
        if (item.nativeId && item.geminiDir && !item.desktopOwned
          && isAntigravityConversationBusy({ geminiDir: item.geminiDir, appDataDir: item.appDataDir, conversationId: item.nativeId })) {
          throw new Error(`对话「${item.title}」正在 Antigravity 客户端中运行，已取消本次删除。`);
        }
      }

      const release = bridgeTargets.length && sharedSessions
        ? (sharedSessions.acquireManyAsync
          ? await sharedSessions.acquireManyAsync(bridgeTargets.map((entry) => entry.session))
          : sharedSessions.acquireMany(bridgeTargets.map((entry) => entry.session)))
        : null;
      let removedBridgeCount = 0;
      let removedNativeCount = 0;
      const deletedNativeIds = new Set();
      const unboundDesktop = bridgeTargets.filter(({ item }) => item.desktopOwned).map(({ item }) => item);
      try {
        if (bridgeTargets.length) {
          const removeIds = bridgeTargets.map((entry) => entry.session.id);
          const removeSet = new Set(removeIds);
          if (sharedSessions?.removeAsync) await sharedSessions.removeAsync(removeIds, accessCtx);
          else sharedSessions?.remove(removeIds, accessCtx);
          chat.sessions = chat.sessions.filter((item) => !removeSet.has(item.id));
          if (removeSet.has(chat.currentSessionId)) chat.currentSessionId = chat.sessions[0]?.id || '';
          if (sharedSessions?.saveSessionsAsync) await sharedSessions.saveSessionsAsync();
          else saveSessions();
          removedBridgeCount = removeIds.length;
        }
        for (const { item } of bridgeTargets) {
          // Desktop-owned conversations are only unbound; their files stay under the Desktop app's control.
          if (item.desktopOwned) continue;
          if (item.nativeId && item.geminiDir && !deletedNativeIds.has(`${item.geminiDir}\0${item.appDataDir}\0${item.nativeId}`)) {
            try {
              deleteAntigravityNativeConversation({ geminiDir: item.geminiDir, appDataDir: item.appDataDir, conversationId: item.nativeId });
              deletedNativeIds.add(`${item.geminiDir}\0${item.appDataDir}\0${item.nativeId}`);
              removedNativeCount += 1;
            } catch {}
          }
        }
        for (const item of nativeItems) {
          if (!isOwnerDmContext(accessCtx)) throw new Error('仅主用户私聊允许删除本机原生对话');
          if (item.desktopOwned) continue;
          const key = `${item.geminiDir}\0${item.appDataDir}\0${item.nativeId}`;
          if (deletedNativeIds.has(key)) continue;
          deleteAntigravityNativeConversation({ geminiDir: item.geminiDir, appDataDir: item.appDataDir, conversationId: item.nativeId });
          deletedNativeIds.add(key);
          removedNativeCount += 1;
        }
        deleteViews.delete(viewKey(event));
        listViews.delete(viewKey(event));
      } finally { release?.(); }
      const desktopLeft = [...unboundDesktop, ...(pending.desktopOnlyItems || [])];
      await reply([
        `已删除 ${pending.items.length} 条会话（共享绑定 ${removedBridgeCount} 条，原生对话记录 ${removedNativeCount} 条），工作区文件已保留。`,
        ...(desktopLeft.length
          ? [`另有 ${desktopLeft.length} 条在 Antigravity 客户端侧边栏中（${desktopLeft.slice(0, 5).map((item) => `「${item.title}」`).join('')}${desktopLeft.length > 5 ? ' 等' : ''}），Bot 未从客户端删除，请在客户端左侧栏右键 → 删除。`]
          : []),
      ].join('\n'));
      return true;
    }
    const session = currentSession();
    const modelStatusMarkdown = (targetSession, title = 'Antigravity 模型设置', explicitCatalog = null) => {
      const info = displayModelInfo(targetSession, explicitCatalog);
      const activeBase = info.catalog?.baseModels?.find((m) => m.id === info.effectiveModel);
      const effortChoices = activeBase?.efforts?.length
        ? activeBase.efforts
        : (info.catalog?.thoughtLevels?.length ? info.catalog.thoughtLevels : []);
      const effortHint = effortChoices.length ? ` · 可选：${effortChoices.map((e) => `\`${e}\``).join(' / ')}` : '';
      const modelValue = info.effectiveModel ? `\`${info.effectiveModel}\`（${info.modelSource}）` : '官方默认（首次运行或 `/model list` 后可见具体 ID）';
      const effortValue = info.effectiveEffort ? `\`${info.effectiveEffort}\`（${info.effortSource}）` : '官方默认';
      return [
        `**${title}**`,
        `当前会话：\`${targetSession.title || '未命名会话'}\` (${targetSession.id})`,
        `模型：${modelValue}`,
        `思考强度：${effortValue}${effortHint}`,
        `渠道：\`${info.selected.provider}\``,
        `权限模式：\`${info.selected.permissionMode}\``,
        '',
        '用法：`/model list`、`/model refresh`、`/model capability`、`/model <模型ID> [强度]`、`/model effort <强度|clear>`、`/model save [模型ID] [强度]`、`/model clear`',
      ].join('\n');
    };
    const modelCapabilityMarkdown = (targetSession, explicitCatalog = null) => {
      const info = displayModelInfo(targetSession, explicitCatalog);
      const activeBase = info.catalog?.baseModels?.find((m) => m.id === info.effectiveModel);
      const options = activeBase?.efforts?.length
        ? activeBase.efforts
        : (info.catalog?.thoughtLevels?.length ? info.catalog.thoughtLevels : [...EFFORTS].filter(Boolean));
      return [
        '**Antigravity 模型能力与思考强度**',
        `当前会话：\`${targetSession.title || '未命名会话'}\` (${targetSession.id})`,
        `当前模型：\`${info.effectiveModel || '官方默认'}\`（${info.modelSource}）`,
        `当前思考强度：\`${info.effectiveEffort || '官方默认'}\`（${info.effortSource}）`,
        `支持档位：${options.map((e) => `\`${e}\``).join('、')}`,
        '',
        `用法：\`/effort ${options.join('|')}|clear\`、\`/model effort <强度|clear>\`、\`/model save effort <强度>\``,
      ].join('\n');
    };
    const applyEffortChange = async (targetSession, rawValue, { persist = false } = {}) => {
      const value = String(rawValue || '').trim().toLowerCase();
      if (!value || ['status', 'view'].includes(value)) {
        await reply(modelCapabilityMarkdown(targetSession));
        return;
      }
      if (activeJobs.has(event.chat_id)) throw new Error('当前任务仍在运行，不能修改思考强度');
      await retireBackgroundSession(event.chat_id, 'effort-change', { interrupt: true, flush: true });
      sharedSessions?.assertIdle(targetSession);
      if (!persist && ['clear', 'default', 'reset'].includes(value)) {
        delete targetSession.reasoningOverride;
        saveSessions();
        await reply(modelStatusMarkdown(targetSession, '已清除会话思考强度覆盖，恢复默认'));
        return;
      }
      const info = displayModelInfo(targetSession);
      const activeBase = info.catalog?.baseModels?.find((m) => m.id === info.effectiveModel);
      const allowed = activeBase?.efforts?.length
        ? activeBase.efforts
        : (info.catalog?.thoughtLevels?.length ? info.catalog.thoughtLevels : [...EFFORTS].filter(Boolean));
      if (!allowed.includes(value)) {
        throw new Error(`思考强度无效，当前模型可用选项：${allowed.join('、')}`);
      }
      targetSession.reasoningOverride = value;
      saveSessions();
      if (persist) {
        const bot = botConfiguration();
        bot.provider = { ...bot.provider, model: settings(targetSession).model, reasoning: value };
        atomicJson(config.antigravityBotConfig, bot);
      }
      await reply(modelStatusMarkdown(
        targetSession,
        persist ? '已切换并保存思考强度为本 Bot 默认（下一轮生效）' : '已保存当前会话思考强度（下一轮生效，不会静默降档）',
      ));
    };

    if (['/status', '/now', '/how', '/context'].includes(command.name)) {
      const info = displayModelInfo(session);
      const usage = session.lastContextUsage;
      const target = resolveSessionTarget(session, info.provider);
      const inDesktopSidebar = isDesktopSidebarOwned({
        geminiDir: target.geminiDir,
        appDataDir: target.appDataDir,
        conversationId: session.antigravitySessionId,
      });
      const usageText = usage
        ? `${Number(usage.usedTokens || 0).toLocaleString('en-US')} / ${usage.contextWindow ? Number(usage.contextWindow).toLocaleString('en-US') : '未知'} tokens${usage.percent != null ? ` (${usage.percent}%)` : ''}`
        : '等待原生使用量事件';
      await reply([
        `**Antigravity Bot ${command.name === '/context' ? '上下文' : '状态'}**`,
        '',
        '内核：`Antigravity CLI / ACP`',
        `当前会话：\`${session.title || '未命名会话'}\` (${session.id})`,
        `原生会话：${session.antigravitySessionId ? `\`${session.antigravitySessionId}\`` : '尚未创建'}`,
        `会话库：${inDesktopSidebar ? 'Antigravity 客户端侧边栏（互通）' : 'Bridge 原生库（飞书独立管理）'}`,
        `渠道：\`${info.selected.provider}\``,
        `模型：${info.effectiveModel ? `\`${info.effectiveModel}\`（${info.modelSource}）` : info.modelText}`,
        `思考强度：${info.effectiveEffort ? `\`${info.effectiveEffort}\`（${info.effortSource}）` : info.effortText}`,
        `权限模式：\`${info.selected.permissionMode}\``,
        `工作区：\`${session.antigravityWorkspace || config.workspace}\``,
        `上下文：${usageText}`,
        backgroundSessions.has(event.chat_id) ? '后台保活：活跃（等待后台任务/定时器唤醒，结果会自动发到本聊天；可发消息续问或 `/stop` 停止）' : '',
        queueSummary?.(event.chat_id) || '',
      ].filter(Boolean).join('\n')); return true;
    }
    if (command.name === '/provider') {
      const parts = command.rest.trim().split(/\s+/).filter(Boolean);
      if (!parts.length || parts[0] === 'list') {
        const activeId = settings(session).provider;
        const lines = readCatalog(catalogRoot).providers.map((item) => (
          `${item.id === activeId ? '● ' : '  '}\`${item.id}\` · ${item.name} · \`${item.mode}\`${item.id === activeId ? ' ← 当前' : ''}`
        ));
        await reply([
          '**Antigravity 渠道列表**',
          `当前渠道：\`${activeId}\``,
          '',
          lines.join('\n'),
          '',
          '用法：`/provider <渠道ID>`、`/provider save`、`/provider clear`',
        ].join('\n')); return true;
      }
      if (activeJobs.has(event.chat_id)) throw new Error('当前任务仍在运行，不能切换渠道');
      await retireBackgroundSession(event.chat_id, 'provider-change', { interrupt: true, flush: true });
      sharedSessions?.assertIdle(session);
      if (parts[0] === 'clear') { delete session.providerOverride; delete session.modelOverride; delete session.reasoningOverride; saveSessions(); await reply('已清除会话渠道覆盖，使用 Bot 默认配置。原生会话仍绑定原渠道。'); return true; }
      if (parts[0] === 'save') { const bot = botConfiguration(); bot.provider = { ...bot.provider, id: settings(session).provider, model: settings(session).model, reasoning: settings(session).reasoning }; atomicJson(config.antigravityBotConfig, bot); await reply('已将当前渠道、模型和强度保存为本 Bot 默认值。'); return true; }
      const provider = selectProvider(catalogRoot, parts[0]); assertOfficialAccount(catalogRoot, provider);
      if (session.antigravitySessionId && session.antigravitySourceId !== provider.id) { await reply('原生会话绑定了原渠道。请先 /new，再切换渠道；已有会话仍可切回继续。'); return true; }
      session.providerOverride = provider.id; session.modelOverride = provider.model || ''; session.reasoningOverride = provider.effort || '';
      saveSessions(); await reply(`已选择渠道 \`${provider.id}\`（${provider.name}）；下一轮由官方 CLI 使用该渠道。`); return true;
    }
    if (command.name === '/model') {
      const parts = command.rest.trim().split(/\s+/).filter(Boolean);
      const sub = String(parts[0] || '').toLowerCase();
      if (!parts.length || ['status', 'view'].includes(sub)) {
        await reply(modelStatusMarkdown(session));
        return true;
      }
      if (['capability', 'capabilities'].includes(sub)) {
        await reply(modelCapabilityMarkdown(session));
        return true;
      }
      if (sub === 'test' || sub === 'check') {
        await reply('[原生限制] Antigravity 暂不支持在飞书内直接测活模型，请在桌面端“渠道与账号”页面测试。');
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
          `当前会话：\`${session.title || '未命名会话'}\` (${session.id})`,
          `当前生效：\`${info.effectiveModel || '官方默认'}\` · 思考强度：\`${info.effectiveEffort || '官方默认'}\`（${info.modelSource}）`,
          '',
          lines.join('\n') || '未返回可用模型',
          '',
          '切换：`/model <模型ID> [强度]` · 调强度：`/model effort <档位>` · 设为默认：`/model save [模型ID] [强度]`',
        ].join('\n'));
        return true;
      }
      if (['effort', 'reasoning'].includes(sub)) {
        await applyEffortChange(session, parts[1] || '', { persist: false });
        return true;
      }
      if (activeJobs.has(event.chat_id)) throw new Error('当前任务运行中不能切换模型，请等待完成或 /stop 后再执行 /model。');
      await retireBackgroundSession(event.chat_id, 'model-change', { interrupt: true, flush: true });
      sharedSessions?.assertIdle(session);
      if (['clear', 'default', 'reset'].includes(sub)) {
        delete session.modelOverride; delete session.reasoningOverride; saveSessions();
        await reply(modelStatusMarkdown(session, '已清除会话模型和强度覆盖，恢复默认')); return true;
      }
      const persist = sub === 'save';
      const args = persist ? parts.slice(1) : parts;
      if (persist && !args.length) {
        const bot = botConfiguration();
        bot.provider = { ...bot.provider, model: settings(session).model, reasoning: settings(session).reasoning };
        atomicJson(config.antigravityBotConfig, bot);
        await reply(modelStatusMarkdown(session, '已保存为本 Bot 默认模型和强度')); return true;
      }
      if (persist && ['effort', 'reasoning'].includes(String(args[0] || '').toLowerCase())) {
        await applyEffortChange(session, args[1] || '', { persist: true });
        return true;
      }
      const result = await probeModelsReadOnly(session, event, { forceRefresh: false });
      const catalog = result.catalog || extractAntigravityModelCatalog(result.models, result.configOptions);
      let requestedModel = args[0];
      let requestedEffort = args[1] ? args[1].trim().toLowerCase() : '';
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
      if (persist) {
        const bot = botConfiguration();
        bot.provider = { ...bot.provider, model: requestedModel, reasoning: requestedEffort || settings(session).reasoning };
        atomicJson(config.antigravityBotConfig, bot);
      }
      await reply(modelStatusMarkdown(
        session,
        persist ? '已切换并保存为本 Bot 默认模型设置' : '已切换当前会话模型设置（下一轮生效）',
        catalog,
      ));
      return true;
    }
    if (command.name === '/effort') {
      await applyEffortChange(session, command.rest, { persist: false });
      return true;
    }
    if (command.name === '/mode') {
      const value = command.rest.trim();
      if (!value) { await reply(`当前权限模式：\`${settings(session).permissionMode}\`\n可选：\`always-proceed\`、\`auto\`、\`accept-edits\`、\`default\`、\`plan\``); return true; }
      if (!NATIVE_MODES.has(value)) throw new Error('支持 always-proceed、auto、accept-edits、default、plan');
      if (activeJobs.has(event.chat_id)) throw new Error('当前任务仍在运行');
      await retireBackgroundSession(event.chat_id, 'mode-change', { interrupt: true, flush: true });
      const bot = botConfiguration(); bot.antigravity = { ...bot.antigravity, permissionMode: value }; atomicJson(config.antigravityBotConfig, bot);
      await reply(`已更新权限模式为：\`${value}\`（下一轮生效）`); return true;
    }
    // Advertised native slash commands and Skills are handled by the regular task queue.
    return false;
  }
  function close() {
    for (const entry of backgroundSessions.values()) {
      entry.retired = true;
      clearBackgroundTimers(entry);
      releaseEntryLeases(entry);
    }
    backgroundSessions.clear();
    for (const client of clients) { client.interrupt(); client.close(); }
    for (const pending of permissions.values()) { clearTimeout(pending.timer); pending.resolve(false); }
    clients.clear(); permissions.clear();
  }
  return { run, handleCommand, settings, stopBackground, hasBackground, close };
}
