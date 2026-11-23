import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { hasDuration } from "../config/env.mjs";
import { sameResolvedPath } from "../config/paths.mjs";
import { codexCloakBrowserArgs } from "../config/cloakbrowser.mjs";
import {
  markdown,
  truncateCardText,
} from "../feishu/cards/primitives.mjs";
import { AppServerClient } from "./app-server-client.mjs";
import openaiAccounts from "./openai-accounts.cjs";
import {
  prepareThreadContinuation,
  commitThreadBinding,
} from "./thread-continuity.mjs";
import { probeAppServerModel } from "./model-probe.mjs";
import {
  receiveNativeInput,
  nativeInputContext,
  markNativeInputSubmitting,
  acknowledgeNativeInput,
} from "../sessions/native-inputs.mjs";
import { parseCodexCliVersion } from "./runtime-version.mjs";
import { fetchOpenaiModelCatalog } from "../providers/openai-model-catalog.mjs";
import { createRunWatchdog as createBaseRunWatchdog } from "../runtime/run-watchdog.mjs";
import {
  markModelEvent,
  markRunPhase,
} from "../runtime/run-activity.mjs";
import { flushGoalSteersWithGeneration } from "../runtime/steer-generation.mjs";
import { normalizeGoal } from "../sessions/normalize.mjs";
import {
  loadRegisteredBridgeBindings,
  stateDirsForCodexHome,
} from "../sessions/codex-home-registry.mjs";
import { readJsonFile } from "../utils/json.mjs";
import {
  bridgeTimeoutError,
  classifyCodexFailure,
  emptyCompletionError,
  errorFromFailure,
  errorText,
  failureDetailText,
  failureShortText,
  isNoGoalExistsError,
  nativeRetryExhaustedFailure,
  shouldWaitForNativeRetry,
} from "../logging/errors.mjs";

export function createCodexRunner(deps = {}) {
  const {
    CONFIG,
    log,
    outputDir,
    promptDir,
    activeChildren,
    activeCodexJobs,
    activeGoalRuns,
    stoppedJobs,
    runTool,
    terminateProcessTree,
    sendMarkdown,
    sendText,
    ManagedCard,
    PROVIDER_MODEL_LIST_TIMEOUT_MS,
    PROVIDER_MODEL_TEST_TIMEOUT_MS,
    codexProviderConfig,
    findCodexProvider,
    providerModelsUrl,
    providerResponsesUrl,
    writeTopLevelCodexConfigValue,
    serviceTierFallbackFailure,
    serviceTierPlanForExecSettings,
    serviceTierPlanForTurnSettings,
    shouldRetryWithoutServiceTier,
    saveSessions,
    stats,
    clearActiveRunSafely,
    recordActiveRunSafely,
    touchActiveRunSafely,
    parseTokens,
    safeFilePart,
  } = deps;
  const appServerStartParams = (...args) => deps.appServerStartParams(...args);
  const appServerSteerParams = (...args) => deps.appServerSteerParams(...args);
  const appServerTurnParams = (...args) => deps.appServerTurnParams(...args);
  const appServerPool = deps.appServerPool;
  const verifiedModels = deps.verifiedModels;
  const providerSwitcher = deps.providerSwitcher;
  const claudeBridge = deps.claudeBridge;
  const antigravityBridge = deps.antigravityBridge;

  const userTextFromContent = (...args) => deps.userTextFromContent(...args);
  const buildPrompt = (...args) => deps.buildPrompt(...args);
  const registeredCodexHomeRegistry = (...args) => deps.registeredCodexHomeRegistry(...args);
  const scheduleAppServerThreadMaintenance = (...args) => deps.scheduleAppServerThreadMaintenance(...args);
  const syncCodexSidebarThread = (...args) => deps.syncCodexSidebarThread(...args);
  const cleanOverride = (...args) => deps.cleanOverride(...args);
  const effectiveSessionSettings = (...args) => deps.effectiveSessionSettings(...args);
  const assertReasoningSupported = (...args) => deps.assertReasoningSupported(...args);
  const recordFailureStats = (...args) => deps.recordFailureStats(...args);
  const normalizeSessionData = (...args) => deps.normalizeSessionData(...args);
  const updateSessionTokenUsage = (...args) => deps.updateSessionTokenUsage(...args);
  const updateSessionThreadStatus = (...args) => deps.updateSessionThreadStatus(...args);
  const updateSessionGoal = (...args) => deps.updateSessionGoal(...args);
  const updateSessionFailure = (...args) => deps.updateSessionFailure(...args);
  const markSessionCompacted = (...args) => deps.markSessionCompacted(...args);
  const loadCodexThreadResumeInfo = (...args) => deps.loadCodexThreadResumeInfo(...args);
  const missingRolloutFailureForThread = (...args) => deps.missingRolloutFailureForThread(...args);
  const markSessionResumeFailure = (...args) => deps.markSessionResumeFailure(...args);
  const appendHistory = (...args) => deps.appendHistory(...args);
  const createRunState = (...args) => deps.createRunState(...args);
  const reduceCodexJsonEvent = (...args) => deps.reduceCodexJsonEvent(...args);
  const reduceAppServerEvent = (...args) => deps.reduceAppServerEvent(...args);
  const markRunError = (...args) => deps.markRunError(...args);
  const markRunRecovering = (...args) => deps.markRunRecovering(...args);
  const markRunInterrupted = (...args) => deps.markRunInterrupted(...args);
  const ensureRunDone = (...args) => deps.ensureRunDone(...args);
  const shouldRecoverCodexRun = (...args) => deps.shouldRecoverCodexRun(...args);
  const recoveryEventFromFailure = (...args) => deps.recoveryEventFromFailure(...args);
  const renderRunCard = (...args) => deps.renderRunCard(...args);
  const goalStatusLabel = (...args) => deps.goalStatusLabel(...args);
  const goalMarkdown = (...args) => deps.goalMarkdown(...args);
  const formatNumber = (...args) => deps.formatNumber(...args);

  function startAppServerClient({ cwd = CONFIG.workspace, label = "codex-app-server", accountAlias = "", provider = "", environment = {} } = {}) {
    let previousToken = "";
    const root = openaiAccounts.accountsRoot();
    const cloakArgs = codexCloakBrowserArgs(codexProviderConfig.readCodexConfigText(), CONFIG, process.env);
    return new AppServerClient({
      tool: {
        ...CONFIG.codexCli,
        argsPrefix: [
          ...CONFIG.codexCli.argsPrefix,
          ...(provider ? ["-c", `model_provider=${JSON.stringify(provider)}`] : []),
          ...(accountAlias ? ["-c", 'cli_auth_credentials_store="ephemeral"'] : []),
          ...cloakArgs,
        ],
      },
      codexHome: CONFIG.codexHome,
      workspace: CONFIG.workspace,
      cwd,
      label,
      activeChildren,
      log,
      formatError: errorText,
      terminateProcessTree,
      accountAlias,
      environment: { ...environment, ...(accountAlias ? { OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined, CODEX_ACCESS_TOKEN: undefined } : {}) },
      refreshAccountTokens: accountAlias ? async (params) => {
        const identity = openaiAccounts.readAccountAuth(root, accountAlias).identity;
        if (params.previousAccountId && params.previousAccountId !== identity.accountId) throw new Error("账号身份不匹配");
        const tokens = await openaiAccounts.accountTokens(root, accountAlias, { codexPath: CONFIG.codexCli.command, force: true, previousToken: params.previousToken || previousToken });
        previousToken = tokens.accessToken;
        return tokens;
      } : null,
    }).start();
  }

  function runtimeOptionsForSession(session) {
    const settings = effectiveSessionSettings(session);
    const provider = findCodexProvider(settings.provider);
    if (!provider) throw new Error('model provider ' + settings.provider + ' not configured');
    const credential = provider.envKey ? process.env[provider.envKey] || '' : '';
    if (provider.envKey && !credential) throw new Error('Provider 凭据环境变量不可用：' + provider.envKey);
    const accountIdentity = settings.accountAlias ? openaiAccounts.readAccountAuth(openaiAccounts.accountsRoot(), settings.accountAlias).identity.key : '';
    const hash = value => crypto.createHash('sha256').update(value).digest('hex');
    const credentialIdentity = hash(credential + '\0' + accountIdentity);
    const codexConfigText = codexProviderConfig.readCodexConfigText();
    const cloakArgsKey = codexCloakBrowserArgs(codexConfigText, CONFIG, process.env).join('\0');
    return { cwd: CONFIG.workspace, codexHome: CONFIG.codexHome, provider: settings.provider,
      accountAlias: settings.accountAlias, settings, credentialIdentity,
      configIdentity: hash(CONFIG.codexCli.command + '\0' + codexConfigText + '\0' + cloakArgsKey),
      verificationIdentity: hash(JSON.stringify(provider) + '\0' + credentialIdentity + '\0' + settings.accountAlias),
      environment: provider.envKey ? { [provider.envKey]: credential } : {} };
  }

  function assertDefaultValuesUnchanged(expected, alternate) {
    const current = codexProviderConfig.readTopLevelValues(Object.keys(expected));
    for (const key of Object.keys(expected)) if (current[key] !== expected[key] && current[key] !== alternate[key]) {
      throw new Error('默认配置已被其他操作修改，已保留当前设置：' + key);
    }
  }

  async function prepareProviderBinding(session, staged) {
    const snapshot = runtimeOptionsForSession(staged);
    let model = snapshot.settings.model;
    if (!model) {
      const models = await listCodexModels(staged);
      const selected = models.find(x => x.isDefault) || models[0];
      model = selected?.model || selected?.id;
      if (!model) throw new Error('目标渠道没有可用于验证的模型；请明确选择模型');
    }
    const current = effectiveSessionSettings(session);
    const targetChanged = current.provider !== snapshot.provider || current.accountAlias !== snapshot.accountAlias
      || Boolean(session.codexThreadId && session.codexThreadProvider !== snapshot.provider);
    const previousFailure = ['auth', 'quota', 'model_provider_mismatch', 'configuration'].includes(session.lastFailure?.kind);
    if (targetChanged || previousFailure || !verifiedModels.has(snapshot.verificationIdentity, model)) await testCurrentProviderModel(staged, model);
    if (runtimeOptionsForSession(staged).configIdentity !== snapshot.configIdentity) throw new Error('Provider 配置在准备期间发生变化，原会话保持不变');
    const client = startAppServerClient(snapshot);
    try {
      await initializeAppServerClient(client);
      return await prepareThreadContinuation({ client, session,
        params: { ...appServerStartParams(staged), model }, save: saveSessions,
        isBusy: sourceThreadIsBusy,
        targetKey: snapshot.verificationIdentity + ':' + model });
    } finally { await client.stop(); }
  }

  function sourceThreadIsBusy(threadId) {
    if ([...activeCodexJobs.values()].some(job => job.threadId === threadId)) return true;
    const registry = registeredCodexHomeRegistry();
    for (const binding of loadRegisteredBridgeBindings(stateDirsForCodexHome(registry, CONFIG.codexHome))) {
      if (binding.threadId !== threadId || sameResolvedPath(binding.stateDir, CONFIG.stateDir)) continue;
      const runs = readJsonFile(path.join(binding.stateDir, 'active-runs.json'))?.runs || {};
      if (Object.values(runs).some(run => run && run.sessionId === binding.session.id)) return true;
    }
    return false;
  }

  function normalizeSessionIdentity(session) {
    const normalized = normalizeSessionData(session);
    return session && typeof session === 'object' ? Object.assign(session, normalized) : normalized;
  }

  function resultTextFromState(state) {
    return state.blocks
      .filter((block) => block.kind === "text")
      .map((block) => block.content)
      .join("")
      .trim();
  }

  function tokenStringFromState(state) {
    if (!state?.meta) return "";
    if (state.meta.inputTokens === undefined && state.meta.outputTokens === undefined) return "";
    const parts = [
      `input ${formatNumber(state.meta.inputTokens || 0)}`,
      `output ${formatNumber(state.meta.outputTokens || 0)}`,
    ];
    if (state.meta.reasoningOutputTokens) parts.push(`reasoning ${formatNumber(state.meta.reasoningOutputTokens)}`);
    return parts.join(" / ");
  }

  async function initializeAppServerClient(client) {
    const initialized = await client.request("initialize", {
      clientInfo: { name: "codex-feishu-bridge", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    }, 60_000);
    client.notify("initialized");
    await synchronizeAppServerAccount(client);
    // Record the server's own handshake, not --version from a possibly upgraded disk file.
    try {
      const target = path.join(CONFIG.stateDir, 'runtime-backends.json');
      let previous;
      try { previous = JSON.parse(fs.readFileSync(target, 'utf8')); } catch {}
      const backends = previous?.bridgePid === process.pid ? (previous.backends || []) : [];
      const live = backends.filter((item) => {
        if (item.pid === client.child?.pid) return false;
        try { process.kill(item.pid, 0); return true; } catch { return false; }
      });
      live.push({ pid: client.child?.pid, path: client.tool.command,
        source: process.env.CODEX_BRIDGE_RUNTIME_SOURCE || 'configured',
        userAgent: initialized.userAgent || '',
        version: String(initialized.userAgent || '').match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] || '',
        initializedAt: new Date().toISOString() });
      const temporary = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ bridgePid: process.pid, backends: live }), 'utf8');
      fs.renameSync(temporary, target);
    } catch (error) { log('WARN', 'Could not record backend handshake', { error: String(error) }); }
    return initialized;
  }

  async function synchronizeAppServerAccount(client) {
    if (!client.accountAlias) return;
    // Revalidate even a warm client: a removed or reauthenticated account must not
    // keep using credentials cached in its process on the next turn.
    const tokens = await openaiAccounts.accountTokens(openaiAccounts.accountsRoot(), client.accountAlias, { codexPath: CONFIG.codexCli.command });
    if (client.currentAccountToken !== tokens.accessToken) {
      await client.request("account/login/start", { type: "chatgptAuthTokens", ...tokens }, 15_000);
      client.currentAccountToken = tokens.accessToken;
    }
  }

  function observeAppServerSessionEvent(session, message) {
    if (!session || !message?.method) return;
    const params = message.params || {};
    if (message.method === "thread/status/changed") {
      updateSessionThreadStatus(session, params.status?.type || "");
    } else if (message.method === "thread/tokenUsage/updated") {
      updateSessionTokenUsage(session, params.tokenUsage);
    } else if (message.method === "thread/goal/updated") {
      updateSessionGoal(session, params.goal || null);
    } else if (message.method === "thread/goal/cleared") {
      updateSessionGoal(session, null);
    }
  }

  async function waitForAppServerNotification(client, predicate, timeoutMs) {
    const useDeadline = hasDuration(timeoutMs);
    const deadline = Date.now() + (useDeadline ? timeoutMs : 0);
    while (!useDeadline || Date.now() < deadline) {
      const remaining = useDeadline ? Math.max(1, deadline - Date.now()) : 1000;
      const message = await client.nextNotification(Math.min(1000, remaining));
      if (!message) {
        if (client.closed) break;
        continue;
      }
      if (message.method === "error") {
        throw errorFromFailure(classifyCodexFailure(message.params, "codex app-server error"));
      }
      if (predicate(message)) return message;
    }
    return null;
  }

  function createRunWatchdog(label, onTimeout, {
    totalMs = CONFIG.codexTimeoutMs,
    idleMs = CONFIG.codexIdleTimeoutMs,
  } = {}) {
    return createBaseRunWatchdog(label, onTimeout, { totalMs, idleMs });
  }

  async function compactAppServerThread(session) {
    const client = startAppServerClient(runtimeOptionsForSession(session));
    const startedAt = Date.now();
    const watchdog = createRunWatchdog("codex app-server compaction", () => {
      void client.stop();
      setTimeout(() => terminateProcessTree(client.child?.pid, true), 5000).unref?.();
    });

    try {
      log("INFO", "starting codex app-server compaction", {
        sessionId: session.id,
        threadId: session.codexThreadId || "",
        timeoutMs: CONFIG.codexTimeoutMs,
        idleTimeoutMs: CONFIG.codexIdleTimeoutMs,
      });

      await initializeAppServerClient(client);
      watchdog.touch();
      const resumed = { thread: { id: await startOrResumeAppServerThread(client, session) } };
      watchdog.touch();
      const threadId = resumed?.thread?.id || session.codexThreadId;
      if (threadId && threadId !== session.codexThreadId) {
        session.codexThreadId = threadId;
        session.updatedAt = Date.now();
        saveSessions();
      }

      await client.request("thread/compact/start", { threadId }, 60_000);
      watchdog.touch();
      const compacted = await waitForAppServerNotification(
        client,
        (message) => {
          watchdog.touch();
          observeAppServerSessionEvent(session, message);
          if (message.method === "thread/compacted") {
            return !message.params?.threadId || message.params.threadId === threadId;
          }
          return message.method === "item/completed" && message.params?.item?.type === "contextCompaction";
        },
        hasDuration(CONFIG.codexTimeoutMs) ? CONFIG.codexTimeoutMs : CONFIG.codexIdleTimeoutMs,
      );

      if (watchdog.timedOut || !compacted) {
        throw bridgeTimeoutError(
          watchdog.reason || `codex app-server compaction idle timed out after ${Math.round(CONFIG.codexIdleTimeoutMs / 1000)}s`,
          "idle",
        );
      }

      markSessionCompacted(session);
      return { threadId, durationMs: Date.now() - startedAt };
    } finally {
      watchdog.clear();
      await client.stop();
    }
  }

  async function withAppServerThread(session, { createIfMissing = true, timeoutMs = 60_000 } = {}, fn) {
    if (CONFIG.runMode === "exec") {
      throw new Error("当前 runMode=exec，没有可管理的 app-server 原生 thread。");
    }
    if (!createIfMissing && !session.codexThreadId) {
      throw new Error("当前会话还没有创建 Codex 原生 thread。");
    }

    const client = startAppServerClient(runtimeOptionsForSession(session));
    try {
      await initializeAppServerClient(client);
      const threadId = await startOrResumeAppServerThread(client, session);
      if (threadId && threadId !== session.codexThreadId) {
        session.codexThreadId = threadId;
        session.updatedAt = Date.now();
        saveSessions();
      }
      return await fn(client, threadId);
    } finally {
      await client.stop();
    }
  }

  async function getAppServerGoal(session) {
    if (!session.codexThreadId) return null;
    try {
      return await withAppServerThread(session, { createIfMissing: false }, async (client, threadId) => {
        const result = await client.request("thread/goal/get", { threadId }, 60_000);
        updateSessionGoal(session, result?.goal || null);
        return session.lastGoal;
      });
    } catch (error) {
      if (!isNoGoalExistsError(error)) throw error;
      updateSessionGoal(session, null);
      return null;
    }
  }

  async function setAppServerGoal(session, goalPatch) {
    try {
      return await withAppServerThread(session, { createIfMissing: true }, async (client, threadId) => {
        const result = await client.request("thread/goal/set", { threadId, ...goalPatch }, 60_000);
        return updateSessionGoal(session, result?.goal || null);
      });
    } catch (error) {
      if (!isNoGoalExistsError(error)) throw error;
      updateSessionGoal(session, null);
      return null;
    }
  }

  async function clearAppServerGoal(session) {
    if (!session.codexThreadId) return false;
    try {
      return await withAppServerThread(session, { createIfMissing: false }, async (client, threadId) => {
        const result = await client.request("thread/goal/clear", { threadId }, 60_000);
        updateSessionGoal(session, null);
        return Boolean(result?.cleared);
      });
    } catch (error) {
      if (!isNoGoalExistsError(error)) throw error;
      updateSessionGoal(session, null);
      return false;
    }
  }

  function applyGoalRunNativeState(run, goal) {
    const next = normalizeGoal(goal);
    if (next) {
      run.goalCleared = false;
      run.goal = setRunGoalState(run.state, next);
      updateSessionGoal(run.session, run.goal);
      return run.goal;
    }

    run.goalCleared = true;
    run.goal = null;
    setRunGoalState(run.state, null);
    updateSessionGoal(run.session, null);
    return null;
  }

  async function getGoalRunNativeState(run) {
    if (!run?.client || !run.threadId) return normalizeGoal(run?.goal || run?.session?.lastGoal);
    try {
      const result = await run.client.request("thread/goal/get", { threadId: run.threadId }, 60_000);
      return applyGoalRunNativeState(run, result?.goal || null);
    } catch (error) {
      if (!isNoGoalExistsError(error)) throw error;
      if (goalStatusIsTerminal(normalizeGoal(run.goal)?.status)) {
        updateSessionGoal(run.session, run.goal);
        return run.goal;
      }
      return applyGoalRunNativeState(run, null);
    }
  }

  function activeGoalRunForChat(chatId, session = null) {
    const run = activeGoalRuns.get(chatId);
    if (!run || run.done) return null;
    if (session && run.sessionId !== session.id) return null;
    return run;
  }

  async function refreshGoalRunForNativeState(chatId, session, run) {
    if (!run) return null;
    if (run.done || run.client?.closed) {
      if (activeGoalRuns.get(chatId) === run) activeGoalRuns.delete(chatId);
      return null;
    }
    const nativeGoal = await getGoalRunNativeState(run);
    if (!nativeGoal && run.goalCleared) {
      if (activeGoalRuns.get(chatId) === run) activeGoalRuns.delete(chatId);
      return null;
    }
    if (session && run.sessionId !== session.id) return null;
    return run;
  }

  function goalStatusIsTerminal(status) {
    const value = String(status || "").trim();
    return Boolean(value && value !== "active");
  }

  function goalStatusIsActive(status) {
    return String(status || "").trim() === "active";
  }

  function goalRunTerminal(run) {
    if (run.goalCleared) return true;
    return goalStatusIsTerminal(normalizeGoal(run.goal || run.session.lastGoal)?.status);
  }

  function previewGoalFromPatch(session, patch) {
    const current = normalizeGoal(session.lastGoal) || {};
    const objective = String(patch.objective ?? current.objective ?? "").trim();
    if (!objective) return null;
    return normalizeGoal({
      ...current,
      ...patch,
      objective,
      status: patch.status || current.status || "active",
      threadId: current.threadId || session.codexThreadId || "",
      updatedAt: Date.now(),
    });
  }

  function setRunGoalState(state, goal) {
    state.goalMode = true;
    state.goal = normalizeGoal(goal);
    return state.goal;
  }

  function settleGoalRunReady(run, error = null) {
    if (run.readySettled) return;
    run.readySettled = true;
    if (error) run.readyReject(error);
    else run.readyResolve(run);
  }

  function nativeGoalRunFinalText(run) {
    const goal = normalizeGoal(run.goal || run.session.lastGoal);
    if (run.goalCleared || !goal) return "Codex goal 已清除。";
    switch (goal.status) {
      case "active":
        return "Codex goal 仍在进行中。后续消息会继续作为当前 goal 的补充指令处理。";
      case "complete":
        return "Codex goal 已完成。";
      case "paused":
        return "Codex goal 已暂停。后续可用 `/goal resume` 继续。";
      case "blocked":
        return "Codex goal 已受阻。";
      case "usageLimited":
        return "Codex goal 因使用量限制停止。";
      case "budgetLimited":
        return "Codex goal 因 token 预算限制停止。";
      default:
        return `Codex goal 当前状态：${goalStatusLabel(goal.status)}。`;
    }
  }

  function nativeGoalRunHeading(run) {
    const goal = normalizeGoal(run.goal || run.session.lastGoal);
    if (run.goalCleared || !goal) return "Codex goal 已清除";
    if (goal.status === "active") return "Codex goal 进行中";
    if (goal.status === "complete") return "Codex goal 已完成";
    if (goal.status === "paused") return "Codex goal 已暂停";
    if (goal.status === "blocked") return "Codex goal 受阻";
    if (goal.status === "usageLimited") return "Codex goal 使用量受限";
    if (goal.status === "budgetLimited") return "Codex goal 预算受限";
    return "Codex goal 状态";
  }

  function nativeGoalRunResultMarkdown(run) {
    const text = resultTextFromState(run.state) || nativeGoalRunFinalText(run);
    return [
      `**${nativeGoalRunHeading(run)}**`,
      "",
      run.goal ? goalMarkdown(run.session, run.goal).replace(/^.*?\n\n/s, "") : "当前 goal 已清除。",
      "",
      "---",
      text,
    ].join("\n");
  }

  function goalRunFinalText(run) {
    return nativeGoalRunFinalText(run);
  }

  function goalRunResultMarkdown(run) {
    return nativeGoalRunResultMarkdown(run);
  }

  async function openGoalRunCard(chatId, messageId, state) {
    if (!CONFIG.useCards) return null;
    return await ManagedCard.open(
      chatId,
      CONFIG.replyToMessage || CONFIG.useThreadReply ? messageId : "",
      renderRunCard(state),
      messageId,
    );
  }

  async function startGoalRun(chatId, event, session, goalPatch, options = {}) {
    const existing = await refreshGoalRunForNativeState(chatId, session, activeGoalRunForChat(chatId, session));
    if (existing) {
      const goal = await updateGoalRunGoal(existing, goalPatch);
      if (options.initialSteer) await queueGoalSteer(existing, options.initialSteer, { quiet: true });
      return { run: existing, goal, started: false };
    }

    const messageId = event.message_id || event.id || crypto.randomUUID();
    const userContent = userTextFromContent(event.content) || goalPatch.objective || session.lastGoal?.objective || "Codex goal";
    const state = createRunState(session, event, userContent);
    state.goalMode = true;
    setRunGoalState(state, previewGoalFromPatch(session, goalPatch));

    let card = null;
    let activeRunRecorded = false;
    let finalCardFlushOk = true;
    try {
      card = await openGoalRunCard(chatId, messageId, state);
      if (card) {
        activeRunRecorded = recordActiveRunSafely({
          chatId,
          messageId,
          sessionId: session.id,
          cardId: card.cardId,
          cardMessageId: card.messageId,
          startedAt: state.startedAt,
        }, "goal-card-open");
      }
    } catch (error) {
      log("WARN", "goal card open failed; falling back to markdown", {
        messageId,
        error: String(error.message || error).slice(0, 1200),
      });
    }

    if (!card) {
      await sendMarkdown(
        chatId,
        goalMarkdown(session, state.goal, "Codex goal 正在启动"),
        "goal-start",
        messageId,
      );
    }

    const run = {
      chatId,
      messageId,
      rootMessageId: messageId,
      sessionId: session.id,
      session,
      event,
      state,
      card,
      activeRunRecorded,
      finalCardFlushOk,
      client: null,
      threadId: "",
      currentTurnId: "",
      turnActive: false,
      goal: state.goal,
      goalCleared: false,
      detached: false,
      clearGeneration: 0,
      pendingSteers: options.initialSteer ? [{ ...options.initialSteer, capturedGeneration: 0 }] : [],
      steeringInFlight: null,
      done: false,
      readySettled: false,
      readyResolve: null,
      readyReject: null,
    };
    run.ready = new Promise((resolve, reject) => {
      run.readyResolve = resolve;
      run.readyReject = reject;
    });
    run.updateCard = async () => {
      if (!run.card) return;
      if (run.activeRunRecorded && run.state.terminal === "running") touchActiveRunSafely(run.messageId);
      const rendered = renderRunCard(run.state);
      if (run.state.terminal === "running") {
        run.card.update(rendered);
      } else {
        const ok = await run.card.flush(rendered);
        run.finalCardFlushOk = ok !== false;
        run.card.close();
      }
    };

    activeGoalRuns.set(chatId, run);
    run.promise = runGoalLoop(run, goalPatch).catch((error) => {
      log("ERROR", "goal runner failed unexpectedly", {
        chatId,
        messageId,
        error: String(error.stack || error).slice(0, 2000),
      });
    });

    await run.ready;
    return { run, goal: run.goal, started: true };
  }

  async function updateGoalRunGoal(run, goalPatch) {
    await run.ready.catch(() => {});
    if (!run.client || !run.threadId || run.done) throw new Error("当前 Codex goal runner 不可用。");
    let result = null;
    try {
      result = await run.client.request("thread/goal/set", { threadId: run.threadId, ...goalPatch }, 60_000);
    } catch (error) {
      if (!isNoGoalExistsError(error)) throw error;
      applyGoalRunNativeState(run, null);
      await run.updateCard?.();
      return null;
    }
    applyGoalRunNativeState(run, result?.goal || previewGoalFromPatch(run.session, goalPatch));
    run.state.footer = "thinking";
    await run.updateCard?.();
    return run.goal;
  }

  async function clearGoalRun(run) {
    await run.ready.catch(() => {});
    if (!run.client || !run.threadId || run.done) throw new Error("当前 Codex goal runner 不可用。");
    let result = null;
    try {
      result = await run.client.request("thread/goal/clear", { threadId: run.threadId }, 60_000);
    } catch (error) {
      if (!isNoGoalExistsError(error)) throw error;
    }
    applyGoalRunNativeState(run, null);
    run.state.footer = "thinking";
    await run.updateCard?.();
    return Boolean(result?.cleared);
  }

  async function queueGoalSteer(run, steer, { quiet = false } = {}) {
    run.pendingSteers.push({
      ...steer,
      capturedGeneration: Number(run.clearGeneration || 0),
    });
    if (!quiet) {
      await sendText(
        run.chatId,
        "已收到，作为当前 Codex goal 的补充指令处理。当前 goal 卡片会继续更新。",
        "goal-steer-ack",
        steer.messageId || steer.event?.message_id || run.messageId,
      );
    }
    await flushGoalSteers(run);
  }

  async function maybeRouteMessageToGoal(chatId, event, session, userContent, messageId) {
    if (CONFIG.runMode === "exec") return false;
    const steer = { event, userContent, messageId };
    const run = await refreshGoalRunForNativeState(chatId, session, activeGoalRunForChat(chatId, session));
    if (run) {
      const nativeGoal = await getGoalRunNativeState(run);
      if (nativeGoal?.status !== "active") return false;
      await queueGoalSteer(run, steer);
      return true;
    }

    const cachedGoal = normalizeGoal(session.lastGoal);
    if (!goalStatusIsActive(cachedGoal?.status)) return false;

    let goal = null;
    try {
      goal = await getAppServerGoal(session);
    } catch (error) {
      const failure = classifyCodexFailure(error);
      log("WARN", "goal state preflight failed; continuing as normal message", {
        chatId,
        messageId,
        sessionId: session.id,
        kind: failure.kind,
        detail: failure.detail.slice(0, 1000),
      });
      return false;
    }
    if (goal?.status !== "active") return false;
    const job = activeCodexJobs.get(chatId);
    if (job && job.mode !== "app-server-goal") return false;

    try {
      await startGoalRun(chatId, event, session, { status: "active" }, { initialSteer: steer });
    } catch (error) {
      if (!isNoGoalExistsError(error)) throw error;
      updateSessionGoal(session, null);
      return false;
    }
    return true;
  }

  async function flushGoalSteers(run) {
    return flushGoalSteersWithGeneration(run, submitGoalSteer);
  }

  async function submitGoalSteer(run, steer) {
    const event = steer.event;
    const userContent = steer.userContent ?? userTextFromContent(event.content);
    const messageId = steer.messageId || event.message_id || event.id || crypto.randomUUID();
    let submitted = false;

    if (run.turnActive && run.currentTurnId) {
      try {
        const result = await run.client.request(
          "turn/steer",
          appServerSteerParams(run.threadId, run.currentTurnId, event, userContent),
          60_000,
        );
        run.currentTurnId = result?.turnId || run.currentTurnId;
        submitted = true;
      } catch (error) {
        log("WARN", "goal turn steer failed; falling back to turn/start", {
          messageId,
          threadId: run.threadId,
          turnId: run.currentTurnId,
          error: String(error.message || error).slice(0, 1000),
        });
      }
    }

    if (!submitted) {
      try {
        const turn = await run.client.request(
          "turn/start",
          appServerTurnParams(run.threadId, event, userContent, run.session),
          60_000,
        );
        run.currentTurnId = turn?.turn?.id || run.currentTurnId;
        run.turnActive = Boolean(run.currentTurnId);
        submitted = true;
      } catch (error) {
        if (isNoGoalExistsError(error)) {
          applyGoalRunNativeState(run, null);
          await run.updateCard?.();
          return false;
        }
        if (!run.turnActive && isActiveTurnRaceError(error)) {
          log("INFO", "goal steer deferred until active turn notification", {
            messageId,
            threadId: run.threadId,
            error: String(error.message || error).slice(0, 500),
          });
          return false;
        }
        await sendMarkdown(
          run.chatId,
          [
            "**Codex goal 补充指令发送失败**",
            "",
            "```",
            truncateCardText(errorText(error), 1200),
            "```",
          ].join("\n"),
          "goal-steer-error",
          messageId,
        );
        return true;
      }
    }

    if (submitted) {
      run.state.goalSteerCount += 1;
      run.state.footer = "thinking";
      appendHistory(run.session, "user", userContent || `${event.attachments?.length || 0} attachment(s)`);
      await run.updateCard?.();
    }
    return true;
  }

  function isActiveTurnRaceError(error) {
    const text = errorText(error).toLowerCase();
    return text.includes("active turn")
      || text.includes("in-flight")
      || text.includes("in flight")
      || text.includes("not idle")
      || text.includes("already running")
      || text.includes("turn is active");
  }

  async function runGoalLoop(run, goalPatch) {
    const { chatId, messageId, session, state } = run;
    const startedAt = Date.now();
    const client = startAppServerClient(runtimeOptionsForSession(session));
    run.client = client;
    const activeJob = {
      pid: client.child.pid,
      client,
      messageId,
      rootMessageId: run.rootMessageId,
      startedAt,
      sessionId: session.id,
      threadId: "",
      turnId: "",
      mode: "app-server-goal",
      clearGeneration: 0,
      pendingSteerEntries: [],
      steerInFlight: null,
    };
    let finishJob;
    activeJob.finished = new Promise((resolve) => { finishJob = resolve; });
    activeCodexJobs.set(chatId, activeJob);

    const watchdog = createRunWatchdog("codex app-server goal", () => {
      void client.stop();
      setTimeout(() => terminateProcessTree(client.child?.pid, true), 5000).unref?.();
    });

    try {
      appendHistory(session, "user", `/goal ${goalPatch.objective || run.goal?.objective || ""}`.trim());
      const initialized = await initializeAppServerClient(client);
      watchdog.touch();
      state.meta.runtimeUserAgent = initialized.userAgent || "";

      const threadId = await startOrResumeAppServerThread(client, session);
      if (stoppedJobs.has(messageId) || stoppedJobs.has(run.rootMessageId)) {
        throw new Error("codex job stopped by user");
      }
      watchdog.touch();
      run.threadId = threadId;
      state.threadId = threadId;
      activeJob.threadId = threadId;

      if (stoppedJobs.has(messageId) || stoppedJobs.has(run.rootMessageId)) {
        throw new Error("codex job stopped by user");
      }
      const result = await client.request("thread/goal/set", { threadId, ...goalPatch }, 60_000);
      watchdog.touch();
      applyGoalRunNativeState(run, result?.goal || previewGoalFromPatch(session, goalPatch));
      log("INFO", "codex goal native state set", {
        chatId,
        messageId,
        threadId,
        status: run.goal?.status || "",
        objectiveLength: String(run.goal?.objective || "").length,
      });
      settleGoalRunReady(run);
      await run.updateCard?.();
      await flushGoalSteers(run);

      while (!watchdog.timedOut) {
        if (stoppedJobs.has(messageId) || stoppedJobs.has(run.rootMessageId)) {
          throw new Error("codex job stopped by user");
        }

        const message = await client.nextNotification(1000);
        if (!message) {
          if (client.closed) {
            if (goalStatusIsActive(normalizeGoal(run.goal || session.lastGoal)?.status)) {
              run.detached = true;
              log("INFO", "codex goal runner detached while native goal remains active", {
                chatId,
                messageId,
                threadId,
                status: normalizeGoal(run.goal || session.lastGoal)?.status || "",
              });
            }
            break;
          }
          await flushGoalSteers(run);
          if (goalRunTerminal(run) && !run.turnActive) break;
          continue;
        }

        watchdog.touch();
        const params = message.params || {};
        if (message.method === "turn/started") {
          run.currentTurnId = params.turn?.id || params.turnId || run.currentTurnId;
          run.turnActive = Boolean(run.currentTurnId);
          activeJob.turnId = run.currentTurnId;
        }

        let stateChanged = false;
        if (message.method === "thread/goal/updated") {
          applyGoalRunNativeState(run, params.goal || null);
          stateChanged = true;
        } else if (message.method === "thread/goal/cleared") {
          applyGoalRunNativeState(run, null);
          stateChanged = true;
        } else if (message.method === "turn/completed") {
          const completedTurnId = params.turn?.id || params.turnId || "";
          if (!completedTurnId || !run.currentTurnId || completedTurnId === run.currentTurnId) {
            run.turnActive = false;
            run.currentTurnId = "";
            activeJob.turnId = "";
          }
        } else if (message.method === "error") {
          const failure = nativeRetryExhaustedFailure(
            classifyCodexFailure(params, "codex app-server goal error"),
            params.willRetry,
          );
          if (shouldWaitForNativeRetry(failure, params.willRetry)) continue;
          throw errorFromFailure(failure);
        }

        if (reduceAppServerEvent(state, message)) stateChanged = true;
        if (stateChanged) await run.updateCard?.();

        await flushGoalSteers(run);
        if (goalRunTerminal(run) && !run.turnActive) break;
      }

      if (watchdog.timedOut) {
        const reason = watchdog.reason || "codex app-server goal timed out";
        throw bridgeTimeoutError(reason, reason.includes(" idle timed out ") ? "idle" : "total");
      }
      if (stoppedJobs.has(messageId) || stoppedJobs.has(run.rootMessageId)) {
        throw new Error("codex job stopped by user");
      }

      if (!client.closed) await getGoalRunNativeState(run);

      const finalText = resultTextFromState(state) || goalRunFinalText(run);
      ensureRunDone(state, finalText);
      state.meta.durationMs = Date.now() - startedAt;
      await run.updateCard?.();
      if (!run.card || !run.finalCardFlushOk) {
        await sendMarkdown(chatId, goalRunResultMarkdown(run), "goal-done", messageId);
      }
      appendHistory(session, "assistant", finalText);
      stats.answered += 1;
    } catch (error) {
      settleGoalRunReady(run, error);
      if (stoppedJobs.has(messageId) || stoppedJobs.has(run.rootMessageId)) {
        markRunInterrupted(state);
        await run.updateCard?.();
        log("INFO", "codex goal stopped by user", { messageId, chatId });
      } else {
        stats.failed += 1;
        const failure = classifyCodexFailure(error);
        recordFailureStats(failure);
        markRunError(state, error);
        await run.updateCard?.();
        if (!run.card || !run.finalCardFlushOk) {
          await sendMarkdown(
            chatId,
            [
              "**Codex goal 运行失败**",
              "",
              failureShortText(failure),
              "",
              "```",
              truncateCardText(errorText(error), 1500),
              "```",
            ].join("\n"),
            "goal-error",
            messageId,
          );
        }
      }
    } finally {
      watchdog.clear();
      run.done = true;
      const job = activeCodexJobs.get(chatId);
      if (job?.pid === client.child?.pid) activeCodexJobs.delete(chatId);
      const currentRun = activeGoalRuns.get(chatId);
      if (currentRun === run) activeGoalRuns.delete(chatId);
      if (run.activeRunRecorded) clearActiveRunSafely(messageId, "goal-finally");
      await client.stop();
      finishJob();
    }
  }

  async function withConfigClient(fn, session = null) {
    const settings = effectiveSessionSettings(session);
    const client = startAppServerClient(runtimeOptionsForSession(session));
    try {
      await initializeAppServerClient(client);
      return await fn(client);
    } finally {
      await client.stop();
    }
  }

  async function writeCodexConfigValue(keyPath, value) {
    return writeTopLevelCodexConfigValue(keyPath, value);
  }

  async function listCodexModels(session = null) {
    return await withConfigClient(async (client) => {
      const models = [];
      let cursor;
      do {
        const result = await client.request("model/list", { includeHidden: false, limit: 100, ...(cursor ? { cursor } : {}) }, 60_000);
        if (Array.isArray(result?.data)) models.push(...result.data);
        cursor = result?.nextCursor;
      } while (cursor);
      return models;
    }, session);
  }

  async function listCurrentProviderModels(session) {
    const settings = effectiveSessionSettings(session);
    const provider = findCodexProvider(settings.provider);
    if (!provider) {
      throw new Error(`当前 provider 未在 config.toml 中找到：${settings.provider || "默认"}`);
    }
    const url = providerModelsUrl(provider);
    if (provider.id === "openai" && !url && settings.accountAlias) {
      const tokens = await openaiAccounts.accountTokens(openaiAccounts.accountsRoot(), settings.accountAlias, { codexPath: CONFIG.codexCli.command });
      const runtime = await runTool(CONFIG.codexCli, ["--version"], { timeoutMs: 5_000 });
      const clientVersion = runtime.code === 0 ? parseCodexCliVersion(runtime.stdout) : "";
      return { ...await fetchOpenaiModelCatalog({ tokens, clientVersion, timeoutMs: PROVIDER_MODEL_LIST_TIMEOUT_MS }), provider, settings };
    }
    if (!url) {
      if (provider.builtIn || provider.requiresOpenaiAuth) {
        return {
          source: "codex",
          provider,
          settings,
          models: await listCodexModels(session),
        };
      }
      throw new Error(`provider ${provider.id} 未配置 base_url，无法查询 /models。`);
    }
    if (provider.envKey && !process.env[provider.envKey]) {
      throw new Error(`当前 Bridge 进程看不到环境变量 ${provider.envKey}；设置后需要重启对应 Bridge。`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROVIDER_MODEL_LIST_TIMEOUT_MS);
    try {
      const headers = { Accept: "application/json" };
      if (provider.envKey) headers.Authorization = `Bearer ${process.env[provider.envKey]}`;
      const response = await fetch(url, { method: "GET", headers, signal: controller.signal });
      const bodyText = await response.text();
      let body = null;
      if (bodyText.trim()) {
        try {
          body = JSON.parse(bodyText);
        } catch {
          throw new Error(`provider ${provider.id} /models 返回的不是 JSON：${bodyText.slice(0, 300)}`);
        }
      }
      if (!response.ok) {
        const message = body?.error?.message || body?.message || bodyText.slice(0, 300) || response.statusText;
        throw new Error(`provider ${provider.id} /models 失败：HTTP ${response.status} ${message}`);
      }
      return {
        source: "provider",
        provider,
        settings,
        url,
        models: normalizeProviderModels(body),
        rawCount: Array.isArray(body?.data) ? body.data.length : 0,
      };
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(`provider ${provider.id} /models 查询超时（${Math.round(PROVIDER_MODEL_LIST_TIMEOUT_MS / 1000)} 秒）。`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function normalizeProviderModels(body) {
    const data = Array.isArray(body?.data) ? body.data : [];
    const models = [];
    const seen = new Set();
    for (const item of data) {
      const id = String(
        typeof item === "string"
          ? item
          : item?.id || item?.model || item?.name || "",
      ).trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({
        id,
        displayName: String(item?.displayName || item?.display_name || item?.name || id).trim(),
        ownedBy: String(item?.owned_by || item?.ownedBy || "").trim(),
        object: String(item?.object || "").trim(),
      });
    }
    return models.sort((a, b) => a.id.localeCompare(b.id));
  }

  async function testCurrentProviderModel(session, modelId) {
    const model = cleanOverride(modelId);
    if (!model) throw new Error('缺少模型 ID。用法：/model test <模型ID>');
    const snapshot = runtimeOptionsForSession(session);
    const provider = findCodexProvider(snapshot.provider);
    const cwd = path.join(CONFIG.stateDir, 'model-verification');
    fs.mkdirSync(cwd, { recursive: true });
    const client = startAppServerClient({ ...snapshot, cwd });
    const startedAt = Date.now();
    try {
      await initializeAppServerClient(client);
      const result = await probeAppServerModel(client, { provider: snapshot.provider, model, cwd, timeoutMs: PROVIDER_MODEL_TEST_TIMEOUT_MS });
      verifiedModels.record(snapshot.verificationIdentity, result);
      return { provider, settings: snapshot.settings, model, url: providerResponsesUrl(provider) || 'Codex app-server',
        elapsedMs: Date.now() - startedAt, responseId: '', source: 'native-probe', verifiedAt: result.verifiedAt };
    } finally { await client.stop(); }
  }

  async function assertCurrentProviderModelAvailable(session, modelId) {
    const model = cleanOverride(modelId);
    if (!model || model.toLowerCase() === 'default') return;
    const result = await listCurrentProviderModels(session);
    if (result.source !== 'provider' || result.models.some(item => item.id === model)) return;
    const snapshot = runtimeOptionsForSession(session);
    if (!verifiedModels.has(snapshot.verificationIdentity, model)) await testCurrentProviderModel(session, model);
  }

  async function startOrResumeAppServerThread(client, session, options = {}) {
    if (session.codexThreadId) {
      const info = await loadCodexThreadResumeInfo(session.codexThreadId);
      if (!info.resumeable) {
        markSessionResumeFailure(session, info);
        throw errorFromFailure(missingRolloutFailureForThread(session.codexThreadId, info.reason || ''));
      }
    }
    const binding = await prepareThreadContinuation({ client, session,
      params: appServerStartParams(session, options), save: saveSessions,
      isBusy: sourceThreadIsBusy,
      targetKey: (options.settings || effectiveSessionSettings(session)).provider });
    return commitThreadBinding(session, binding, saveSessions);
  }

  async function runCodexAppServer(event, session, state = null, onState = null, options = {}) {
    const chatId = event.chat_id;
    const messageId = event.message_id || event.id || crypto.randomUUID();
    const startedAt = Date.now();
    const recoveryAttempt = Number(options.recoveryAttempt || 0);
    const userContent = userTextFromContent(event.content);
    const liveState = state || createRunState(session, event, userContent);
    const poolWaitStartedAt = Date.now();
    const snapshot = runtimeOptionsForSession(session);
    options = { ...options, settings: snapshot.settings };
    const lease = await appServerPool.acquire(snapshot);
    const poolWaitMs = Date.now() - poolWaitStartedAt;
    const client = lease.client;
    const activeJob = {
      pid: client.child.pid,
      client,
      messageId,
      rootMessageId: options.rootMessageId || messageId,
      startedAt,
      sessionId: session.id,
      threadId: "",
      turnId: "",
      mode: "app-server",
      clearGeneration: 0,
      pendingSteerEntries: [],
      steerInFlight: null,
    };
    let finishJob;
    activeJob.finished = new Promise((resolve) => { finishJob = resolve; });
    activeCodexJobs.set(chatId, activeJob);

    const flushState = async () => {
      if (state && onState) await onState(state);
    };

    const watchdog = createRunWatchdog("codex app-server", () => {
      void client.stop();
      setTimeout(() => terminateProcessTree(client.child?.pid, true), 5000).unref?.();
    });
    let serviceTierPlan = null;
    let discardClient = false;

    try {
      const settings = assertReasoningSupported(effectiveSessionSettings(session));
      serviceTierPlan = serviceTierPlanForTurnSettings(settings, options);
      const serviceTier = serviceTierPlan.serviceTier;
      log("INFO", "starting codex app-server turn", {
        messageId,
        sessionId: session.id,
        existingThreadId: session.codexThreadId || "",
        model: settings.model || "",
        provider: settings.provider || "",
        reasoning: settings.reasoning || "",
        serviceTier,
        requestedServiceTier: settings.serviceTier || "",
        serviceTierPolicy: serviceTierPlan.policy,
        serviceTierAutoFallback: Boolean(serviceTierPlan.autoFallback),
        timeoutMs: CONFIG.codexTimeoutMs,
        idleTimeoutMs: CONFIG.codexIdleTimeoutMs,
        appServerWarm: lease.initializedBeforeAcquire,
        appServerPoolWaitMs: poolWaitMs,
        appServerPool: appServerPool.stats(),
        disableMcp: CONFIG.disableMcp,
      });

      const initialization = await lease.ensureInitialized(initializeAppServerClient);
      if (initialization.warm) await synchronizeAppServerAccount(client);
      const initialized = initialization.result;
      const initializedAt = Date.now();
      const initializeStartedAt = initializedAt - initialization.durationMs;
      const drainedNotifications = client.drainNotifications();
      if (drainedNotifications) {
        log("INFO", "drained stale app-server notifications before turn", {
          messageId,
          sessionId: session.id,
          count: drainedNotifications,
        });
      }
      watchdog.touch();
      markRunPhase(liveState, "initializing", { connection: "connected" });
      liveState.meta.runtimeUserAgent = initialized.userAgent || "";

      const threadId = await startOrResumeAppServerThread(client, session, options);
      const threadReadyAt = Date.now();
      watchdog.touch();
      liveState.threadId = threadId;
      activeJob.threadId = threadId;

      if (stoppedJobs.has(messageId) || stoppedJobs.has(activeJob.rootMessageId)) {
        throw new Error("codex job stopped by user");
      }
      const carried = nativeInputContext(session, messageId);
      const inputEvent = { ...event, attachments: [...carried.attachments, ...(event.attachments || [])] };
      const turnParams = appServerTurnParams(threadId, inputEvent, carried.text + userContent, session, options);
      markNativeInputSubmitting(session, messageId);
      saveSessions();
      activeJob.turnRequestSubmitted = true;
      const turn = await client.request("turn/start", turnParams, 60_000);
      acknowledgeNativeInput(session, messageId, carried.messageIds);
      saveSessions();
      const turnStartedAt = Date.now();
      watchdog.touch();
      markModelEvent(liveState, "model_thinking");
      const turnId = turn?.turn?.id || "";
      activeJob.turnId = turnId;
      log("INFO", "codex app-server turn accepted", {
        messageId,
        sessionId: session.id,
        threadId,
        turnId,
        initializeMs: initializedAt - initializeStartedAt,
        appServerWarm: initialization.warm,
        appServerPoolWaitMs: poolWaitMs,
        threadMs: threadReadyAt - initializedAt,
        turnStartMs: turnStartedAt - threadReadyAt,
        preTurnMs: turnStartedAt - startedAt,
      });
      if (state) {
        await flushState();
      }

      let completed = false;
      let lastWaitingUpdateAt = Date.now();
      while (!completed && !watchdog.timedOut) {
        const message = await client.nextNotification(1000);
        if (!message) {
          if (client.closed) break;
          if (
            state
            && Date.now() - lastWaitingUpdateAt > 60_000
          ) {
            liveState.footer = "waiting";
            liveState.meta.durationMs = Date.now() - startedAt;
            lastWaitingUpdateAt = Date.now();
            await flushState();
          }
          continue;
        }
        watchdog.touch();
        if (!appServerNotificationMatchesRun(message, threadId, turnId)) {
          log("INFO", "ignored app-server notification for another run", {
            messageId,
            sessionId: session.id,
            method: message.method || "",
            expectedThreadId: threadId,
            expectedTurnId: turnId,
            actualThreadId: appServerNotificationThreadId(message),
            actualTurnId: appServerNotificationTurnId(message),
          });
          continue;
        }
        if (reduceAppServerEvent(liveState, message)) await flushState();
        if (message.method === "turn/completed" && (!turnId || message.params?.turn?.id === turnId)) {
          completed = true;
        }
        if (message.method === "error") {
          const failure = nativeRetryExhaustedFailure(
            classifyCodexFailure(message.params, "codex app-server error"),
            message.params?.willRetry,
          );
          if (shouldWaitForNativeRetry(failure, message.params?.willRetry)) {
            log("WARN", "codex app-server transient error; waiting for native retry", {
              messageId,
              sessionId: session.id,
              kind: failure.kind,
              detail: failure.detail.slice(0, 1000),
            });
            continue;
          }
          throw errorFromFailure(failure);
        }
      }

      if (watchdog.timedOut) {
        const reason = watchdog.reason || "codex app-server timed out";
        throw bridgeTimeoutError(reason, reason.includes(" idle timed out ") ? "idle" : "total");
      }
      if (!completed) {
        const error = new Error(`codex app-server ended before turn completed: ${client.stderrText().slice(-2000)}`);
        if (liveState.failure?.recoverable) error.codexFailure = liveState.failure;
        throw error;
      }
      if (stoppedJobs.has(messageId) || stoppedJobs.has(activeJob.rootMessageId)) {
        throw new Error("codex job stopped by user");
      }

      const durationMs = Date.now() - startedAt;
      const finalText = resultTextFromState(liveState);
      if (!finalText) {
        const context = {
          messageId,
          sessionId: session.id,
          threadId,
          turnId,
          durationMs,
          tokens: tokenStringFromState(liveState),
        };
        log("WARN", "codex app-server completed without assistant output", context);
        throw emptyCompletionError(context);
      }
      ensureRunDone(liveState, finalText);
      liveState.meta.durationMs = durationMs;
      scheduleAppServerThreadMaintenance(threadId, "turn/completed");
      if (state) {
        await flushState();
      }
      return {
        text: finalText || resultTextFromState(liveState) || "(Codex 没有返回内容)",
        durationMs,
        tokens: tokenStringFromState(liveState),
        mode: "app-server",
        threadId,
        threadResumeMs: threadReadyAt - initializedAt,
      };
    } catch (error) {
      discardClient = true;
      error.nativeTurnSubmitted = Boolean(activeJob.turnRequestSubmitted);
      if (!activeJob.turnId && typeof error.code === 'number' && error.method === 'turn/start') {
        const pending = session.pendingNativeInputs?.find(input => input.messageId === messageId);
        if (pending) pending.state = 'received';
        saveSessions();
      }
      if (stoppedJobs.has(messageId) || stoppedJobs.has(activeJob.rootMessageId)) {
        markRunInterrupted(liveState);
      } else {
        const failure = classifyCodexFailure(error);
        if (failure.kind === "empty_completion") {
          liveState.terminal = "running";
          liveState.footer = "thinking";
          liveState.failure = failure;
          liveState.errorMsg = failureDetailText(failure).slice(0, 1500);
          updateSessionFailure(liveState.session, failure);
        } else if (shouldRetryWithoutServiceTier(failure, serviceTierPlan, { ...options, hasExecutedTools: liveState.blocks.some(block => block.kind === "tool") })) {
          const fallbackFailure = serviceTierFallbackFailure(failure, serviceTierPlan);
          markRunRecovering(liveState, fallbackFailure, 1);
          if (state) await flushState();
          log("WARN", "retrying codex app-server turn without service_tier", {
            messageId,
            sessionId: session.id,
            provider: effectiveSessionSettings(session).provider || "",
            requestedServiceTier: serviceTierPlan?.requestedServiceTier || "",
            serviceTierPolicy: serviceTierPlan?.policy || "",
            kind: failure.kind,
            detail: failure.detail.slice(0, 1000),
          });
          await lease.release({ discard: true, reason: "service-tier-fallback" });
          return await runCodexAppServer(event, session, liveState, onState, {
            ...options,
            disableServiceTier: true,
            serviceTierFallbackAttempt: true,
            rootMessageId: activeJob.rootMessageId,
          });
        } else if (shouldRecoverCodexRun(failure, recoveryAttempt)) {
          stats.recovered += 1;
          markRunRecovering(liveState, failure, recoveryAttempt + 1);
          if (state) await flushState();
          log("WARN", "attempting codex stream recovery", {
            messageId,
            sessionId: session.id,
            attempt: recoveryAttempt + 1,
            kind: failure.kind,
            detail: failure.detail.slice(0, 1000),
          });
          await lease.release({ discard: true, reason: "stream-recovery" });
          const recoveryEvent = recoveryEventFromFailure(event, liveState, failure, recoveryAttempt + 1);
          return await runCodexAppServer(recoveryEvent, session, liveState, onState, {
            recoveryAttempt: recoveryAttempt + 1,
            rootMessageId: activeJob.rootMessageId,
          });
        }
        markRunError(liveState, error);
      }
      if (state) {
        await flushState();
      }
      throw error;
    } finally {
      watchdog.clear();
      const job = activeCodexJobs.get(chatId);
      if (job?.pid === client.child?.pid) activeCodexJobs.delete(chatId);
      await lease.release({
        discard: discardClient || client.closed,
        reason: discardClient ? "turn-failed" : "turn-completed",
      });
      finishJob();
    }
  }

  function appServerNotificationThreadId(message) {
    return String(
      message?.params?.threadId
        || message?.params?.thread?.id
        || message?.params?.turn?.threadId
        || message?.params?.item?.threadId
        || "",
    );
  }

  function appServerNotificationTurnId(message) {
    return String(
      message?.params?.turnId
        || message?.params?.turn?.id
        || message?.params?.item?.turnId
        || "",
    );
  }

  function appServerNotificationMatchesRun(message, threadId, turnId) {
    const actualThreadId = appServerNotificationThreadId(message);
    const actualTurnId = appServerNotificationTurnId(message);
    if (actualThreadId && threadId && actualThreadId !== threadId) return false;
    if (actualTurnId && turnId && actualTurnId !== turnId) return false;
    return true;
  }

  async function runCodex(event, session, state = null, onState = null) {
    if (CONFIG.engine === 'antigravity') return antigravityBridge.run(event, session, state, onState);
    if (CONFIG.engine === 'claude') return claudeBridge.run(event, session, state, onState);
    await providerSwitcher.recover(session);
    receiveNativeInput(session, event.message_id || event.id, userTextFromContent(event.content), event.attachments || []);
    saveSessions();
    const selectedAccount = effectiveSessionSettings(session).accountAlias;
    if (selectedAccount || CONFIG.runMode === "app-server" || CONFIG.runMode === "auto") {
      try {
        return await runCodexAppServer(event, session, state, onState);
      } catch (error) {
        const failure = classifyCodexFailure(error);
        const canFallback = !selectedAccount && CONFIG.runMode === "auto" && !session.codexThreadId && !error.nativeTurnSubmitted && failure.kind === "app_server";
        if (!canFallback) throw error;
        if (["auth", "quota", "rate_limit", "user_stop"].includes(failure.kind)) throw error;
        log("WARN", "app-server mode failed; falling back to codex exec", {
          messageId: event.message_id || event.id,
          sessionId: session.id,
          kind: failure.kind,
          error: String(error.message || error).slice(0, 1500),
        });
        if (state?.terminal === "running") {
          state.blocks.push({
            kind: "tool",
            tool: {
              id: crypto.randomUUID(),
              name: "app_server_fallback",
              input: "codex app-server",
              output: String(error.message || error).slice(0, 1200),
              status: "error",
            },
          });
          state.footer = "thinking";
          await onState?.(state);
        }
      }
    }

    const chatId = event.chat_id;
    const messageId = event.message_id || event.id || crypto.randomUUID();
    const outFile = path.join(outputDir, `${Date.now()}-${safeFilePart(messageId)}.txt`);
    const promptFile = path.join(promptDir, `${Date.now()}-${safeFilePart(messageId)}.md`);
    fs.writeFileSync(promptFile, buildPrompt(event, session), "utf8");
    const settings = assertReasoningSupported(effectiveSessionSettings(session));
    const serviceTierPlan = serviceTierPlanForExecSettings(settings);
    const serviceTier = serviceTierPlan.serviceTier;

    const args = [
      "exec",
      "-C",
      CONFIG.workspace,
      "--skip-git-repo-check",
      "--sandbox",
      CONFIG.codexSandbox,
      "-c",
      "approval_policy=\"never\"",
      "--json",
      "--output-last-message",
      outFile,
    ];
    if (settings.model) args.push("-m", settings.model);
    if (settings.provider) args.push("-c", `model_provider="${settings.provider}"`);
    if (settings.reasoning) args.push("-c", `model_reasoning_effort="${settings.reasoning}"`);
    if (serviceTier) args.push("-c", `service_tier="${serviceTier}"`);
    for (const attachment of Array.isArray(event.attachments) ? event.attachments : []) {
      if (attachment?.type === "image" && attachment.path && fs.existsSync(attachment.path)) {
        args.push("--image", attachment.path);
      }
    }
    if (CONFIG.disableMcp) args.push("-c", "mcp_servers={}");
    else args.push(...codexCloakBrowserArgs(codexProviderConfig.readCodexConfigText(), CONFIG, process.env));
    args.push("--");
    args.push(`读取这个 UTF-8 任务文件，并完成用户任务。任务文件：${promptFile}`);

    const startedAt = Date.now();
    log("INFO", "starting codex", {
      messageId,
      sessionId: session.id,
      promptFile,
      outFile,
      model: settings.model || "",
      provider: settings.provider || "",
      reasoning: settings.reasoning || "",
      serviceTier,
      requestedServiceTier: settings.serviceTier || "",
      serviceTierPolicy: serviceTierPlan.policy,
      serviceTierAutoFallback: Boolean(serviceTierPlan.autoFallback),
      timeoutMs: CONFIG.codexTimeoutMs,
      idleTimeoutMs: CONFIG.codexIdleTimeoutMs,
      disableMcp: CONFIG.disableMcp,
    });

    const finalArgs = [...CONFIG.codexCli.argsPrefix, ...args];
    const child = spawn(CONFIG.codexCli.command, finalArgs, {
      cwd: CONFIG.workspace,
      env: {
        ...process.env,
        CODEX_FEISHU_BRIDGE: "1",
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    activeChildren.set(child.pid, { child, label: `${CONFIG.codexCli.command} ${finalArgs.join(" ")}` });
    activeCodexJobs.set(chatId, {
      pid: child.pid,
      messageId,
      startedAt,
      sessionId: session.id,
      mode: "exec",
      clearGeneration: 0,
      pendingSteerEntries: [],
      steerInFlight: null,
    });

    let timedOut = false;
    let timeoutReason = "";
    let stdoutRaw = "";
    const stderrChunks = [];
    const watchdog = createRunWatchdog("codex exec", (reason) => {
      timedOut = true;
      timeoutReason = reason;
      terminateProcessTree(child.pid, false);
      setTimeout(() => terminateProcessTree(child.pid, true), 5000).unref?.();
    });

    child.stderr.on("data", (chunk) => {
      watchdog.touch();
      stderrChunks.push(chunk);
    });

    const flushState = async () => {
      if (state && onState) await onState(state);
    };

    if (state) {
      markRunPhase(state, "model_thinking", { connection: "connected" });
      await flushState();
    }

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    const streamPromise = (async () => {
      for await (const line of rl) {
        watchdog.touch();
        stdoutRaw += `${line}\n`;
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (state && reduceCodexJsonEvent(state, parsed)) {
          await flushState();
        }
      }
    })();

    const closePromise = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal }));
    });

    let closeResult;
    try {
      closeResult = await closePromise;
      await streamPromise.catch(() => {});
    } finally {
      watchdog.clear();
      rl.close();
      activeChildren.delete(child.pid);
      const job = activeCodexJobs.get(chatId);
      if (job?.pid === child.pid) activeCodexJobs.delete(chatId);
    }

    let finalText = "";
    try {
      finalText = fs.readFileSync(outFile, "utf8").trim();
    } catch {
      finalText = "";
    }

    if (timedOut) {
      const reason = timeoutReason || "codex exec timed out";
      const timeoutError = bridgeTimeoutError(reason, reason.includes(" idle timed out ") ? "idle" : "total");
      if (state) {
        markRunError(state, timeoutError);
        await flushState();
      }
      throw timeoutError;
    }
    if (closeResult.code !== 0) {
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const tail = (stderr || stdoutRaw || "").slice(-3000);
      if (state) {
        if (stoppedJobs.has(messageId)) {
          markRunInterrupted(state);
        } else {
          markRunError(state, `codex exec failed (${closeResult.code}): ${tail}`);
        }
        await flushState();
      }
      throw new Error(`codex exec failed (${closeResult.code}): ${tail}`);
    }

    const durationMs = Date.now() - startedAt;
    const tokens = state?.meta?.inputTokens !== undefined || state?.meta?.outputTokens !== undefined
      ? `${state.meta.inputTokens || 0}↑ ${state.meta.outputTokens || 0}↓`
      : parseTokens(stdoutRaw);
    if (state) {
      ensureRunDone(state, finalText);
      state.meta.durationMs = durationMs;
      await flushState();
    }
    await syncCodexSidebarThread({ event, session, promptFile, outFile, stdoutRaw });
    return {
      text: finalText || extractFinalTextFromJsonl(stdoutRaw) || "(Codex 没有返回内容)",
      durationMs,
      tokens,
    };
  }

  function extractFinalTextFromJsonl(stdout) {
    let text = "";
    for (const line of String(stdout || "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed?.type === "item.completed" && parsed.item?.type === "agent_message" && typeof parsed.item.text === "string") {
          text = parsed.item.text;
        }
      } catch {}
    }
    return text.trim();
  }

  return {
    startAppServerClient,
    runtimeOptionsForSession,
    assertDefaultValuesUnchanged,
    prepareProviderBinding,
    sourceThreadIsBusy,
    normalizeSessionIdentity,
    resultTextFromState,
    tokenStringFromState,
    initializeAppServerClient,
    synchronizeAppServerAccount,
    observeAppServerSessionEvent,
    waitForAppServerNotification,
    createRunWatchdog,
    compactAppServerThread,
    withAppServerThread,
    getAppServerGoal,
    setAppServerGoal,
    clearAppServerGoal,
    applyGoalRunNativeState,
    getGoalRunNativeState,
    activeGoalRunForChat,
    refreshGoalRunForNativeState,
    goalStatusIsTerminal,
    goalStatusIsActive,
    goalRunTerminal,
    previewGoalFromPatch,
    setRunGoalState,
    settleGoalRunReady,
    nativeGoalRunFinalText,
    nativeGoalRunHeading,
    nativeGoalRunResultMarkdown,
    goalRunFinalText,
    goalRunResultMarkdown,
    openGoalRunCard,
    startGoalRun,
    updateGoalRunGoal,
    clearGoalRun,
    queueGoalSteer,
    maybeRouteMessageToGoal,
    flushGoalSteers,
    submitGoalSteer,
    isActiveTurnRaceError,
    runGoalLoop,
    withConfigClient,
    writeCodexConfigValue,
    listCodexModels,
    listCurrentProviderModels,
    normalizeProviderModels,
    testCurrentProviderModel,
    assertCurrentProviderModelAvailable,
    startOrResumeAppServerThread,
    runCodexAppServer,
    appServerNotificationThreadId,
    appServerNotificationTurnId,
    appServerNotificationMatchesRun,
    runCodex,
    extractFinalTextFromJsonl,
  };
}
