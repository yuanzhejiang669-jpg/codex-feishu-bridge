export const store = {
  desktopState: null,
  appVersion: "",
  loading: true,
  lastError: "",
  activeView: "overview",
  botFilters: {
    engine: "all",
    status: "all",
    search: "",
  },
  selectedBotNames: new Set(),
  activeDrawerBotName: "",
  drawerTab: "config",
  drawerFocusField: "",
  providerEngineTab: "codex",
  capabilityTab: "matrix",
  busyActions: new Set(),
  mcpHealth: null,
  restartProgress: null,
  registrationProgress: null,
  factoryProgress: null,
};

const listeners = new Set();

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setState(patch) {
  if (typeof patch === "function") {
    patch(store);
  } else if (patch && typeof patch === "object") {
    Object.assign(store, patch);
  }
  for (const listener of listeners) {
    listener(store);
  }
}

export function normalizeEngine(engine) {
  const value = String(engine || "codex").trim().toLowerCase();
  if (value === "claude" || value === "antigravity") return value;
  return "codex";
}

export function engineLabel(engine) {
  const normalized = normalizeEngine(engine);
  if (normalized === "claude") return "Claude Code";
  if (normalized === "antigravity") return "Antigravity";
  return "Codex";
}

export function isBotFullAutoAuth(bot) {
  const engine = normalizeEngine(bot?.engine);
  if (engine === "claude") {
    return (bot?.claude?.permissionMode || "bypassPermissions") === "bypassPermissions";
  }
  if (engine === "antigravity") {
    return (bot?.antigravity?.permissionMode || "always-proceed") === "always-proceed";
  }
  return true;
}

export function getManagedBots(state = store.desktopState) {
  return Array.isArray(state?.setup?.managedBots) ? state.setup.managedBots : [];
}

export function getFilteredBots(state = store.desktopState, filters = store.botFilters) {
  const bots = getManagedBots(state);
  const engineFilter = filters?.engine || "all";
  const statusFilter = filters?.status || "all";
  const query = String(filters?.search || "").trim().toLowerCase();

  return bots.filter((bot) => {
    const engine = normalizeEngine(bot.engine);
    if (engineFilter !== "all" && engine !== engineFilter) return false;
    if (statusFilter === "idle" && !(bot.online && Number(bot.activeRunCount || 0) === 0)) return false;
    if (statusFilter === "busy" && !(bot.online && Number(bot.activeRunCount || 0) > 0)) return false;
    if (statusFilter === "offline" && bot.online) return false;
    if (statusFilter === "non-full-auth" && isBotFullAutoAuth(bot)) return false;
    if (query) {
      const hay = [
        bot.label,
        bot.name,
        bot.provider?.id,
        bot.provider?.name,
        bot.provider?.model,
        bot.workspace,
        bot.profile,
      ].join(" ").toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });
}

function summarizeLocalMcpServers(state, mcpHealth) {
  if (mcpHealth && Array.isArray(mcpHealth.servers)) {
    const active = mcpHealth.servers.filter((server) => server.active && !server.disabled);
    const healthy = active.filter((server) => server.status === "ok");
    const unhealthy = active.filter((server) => server.status === "warn" || server.status === "error");
    return {
      totalActive: active.length,
      healthyCount: healthy.length,
      unhealthyCount: unhealthy.length,
      probed: true,
      unhealthy,
      mineru: mcpHealth.documentToolchain?.mineru || null,
    };
  }
  const byName = new Map();
  for (const server of state?.capabilities?.mcpServers || []) {
    byName.set(server.name, {
      name: server.name,
      disabled: false,
      healthy: server.commandAvailable !== false && server.entryAvailable !== false,
    });
  }
  for (const list of [state?.claudeCapabilities?.mcpServers || [], state?.antigravityCapabilities?.mcpServers || []]) {
    for (const server of list) {
      if (server.disabled === true) continue;
      if (!byName.has(server.name)) {
        byName.set(server.name, { name: server.name, disabled: false, healthy: true });
      }
    }
  }
  const entries = [...byName.values()];
  const unhealthy = entries.filter((item) => !item.healthy);
  return {
    totalActive: entries.length,
    healthyCount: entries.length - unhealthy.length,
    unhealthyCount: unhealthy.length,
    probed: false,
    unhealthy,
    mineru: null,
  };
}

export function computeOverviewMetrics(state = store.desktopState, mcpHealth = store.mcpHealth) {
  const bots = getManagedBots(state);
  const totalCount = bots.length;
  const onlineBots = bots.filter((bot) => bot.online);
  const onlineCount = onlineBots.length;
  const activeRunsTotal = bots.reduce((sum, bot) => sum + Number(bot.activeRunCount || 0), 0);
  const idleOnlineCount = onlineBots.filter((bot) => Number(bot.activeRunCount || 0) === 0).length;
  const nonFullAuthBots = bots.filter((bot) => !isBotFullAutoAuth(bot));
  const fullAuthCount = totalCount - nonFullAuthBots.length;

  const byEngine = {
    codex: bots.filter((bot) => normalizeEngine(bot.engine) === "codex"),
    claude: bots.filter((bot) => normalizeEngine(bot.engine) === "claude"),
    antigravity: bots.filter((bot) => normalizeEngine(bot.engine) === "antigravity"),
  };

  const mcpSummary = summarizeLocalMcpServers(state, mcpHealth);
  const alerts = [];

  if (nonFullAuthBots.length > 0) {
    alerts.push({
      id: "non-full-auth",
      severity: "warn",
      title: `${nonFullAuthBots.length} 个 Bot 尚未开启默认完全授权`,
      detail: `涉及：${nonFullAuthBots.map((bot) => bot.label || bot.name).join("、")}。执行敏感工具时将等待飞书内逐次审批。`,
      actionLabel: "查看并切换",
      actionType: "open-bot-auth",
      botName: nonFullAuthBots[0].name,
    });
  }

  if (state?.setup?.startupError || state?.app?.credentialStorageAvailable === false) {
    alerts.push({
      id: "startup-or-storage",
      severity: "danger",
      title: state?.setup?.startupError ? "客户端启动初始化存在异常" : "系统安全凭据存储不可用",
      detail: state?.setup?.startupError || state?.app?.credentialStorageError || "无法读写加密密钥存储。",
      actionLabel: "前往系统诊断",
      actionType: "goto-view",
      view: "system",
    });
  }

  if (mcpSummary.unhealthyCount > 0) {
    alerts.push({
      id: "mcp-unhealthy",
      severity: "danger",
      title: `${mcpSummary.unhealthyCount} 个活跃 MCP 存在异常或命令不可达`,
      detail: `受影响服务：${mcpSummary.unhealthy.map((item) => item.name).join("、")}。`,
      actionLabel: "前往工具与技能",
      actionType: "goto-view",
      view: "capabilities",
    });
  }

  const pendingNames = [
    ...Object.keys(state?.claudePendingConfiguration?.bots || {}),
    ...Object.keys(state?.antigravityPendingConfiguration?.bots || {}),
    ...Object.keys(state?.codexPendingConfiguration?.bots || {}),
  ];
  if (pendingNames.length > 0) {
    alerts.push({
      id: "pending-reload",
      severity: "info",
      title: `${pendingNames.length} 个忙碌 Bot 正在等待空闲重载新配置`,
      detail: `等待名单：${pendingNames.join("、")}（当前任务结束后自动应用，不会中断在途任务）。`,
      actionLabel: "查看 Bot 中心",
      actionType: "goto-view",
      view: "bots",
    });
  }

  const recovery = state?.setup?.recovery || {};
  const failedRecoveryBots = bots.filter((bot) => !bot.online && bot.autoStart && recovery[bot.name]?.status === "failed");
  if (failedRecoveryBots.length > 0) {
    const first = failedRecoveryBots[0];
    const lastError = recovery[first.name]?.lastError || "启动失败";
    alerts.push({
      id: "recovery-failed",
      severity: "danger",
      title: `${failedRecoveryBots.length} 个开机自启 Bot 恢复失败`,
      detail: `${first.label || first.name}：${lastError}`,
      actionLabel: "打开抽屉查看日志",
      actionType: "open-bot-logs",
      botName: first.name,
    });
  }

  const factoryBots = state?.setup?.workspaceFactory?.bots || [];
  const remainingFactory = factoryBots.filter((bot) => bot.status === "pending" || bot.status === "failed");
  if (remainingFactory.length > 0) {
    const failedCount = remainingFactory.filter((bot) => bot.status === "failed").length;
    alerts.push({
      id: "factory-queue",
      severity: failedCount > 0 ? "warn" : "info",
      title: `批量空间工厂队列尚有 ${remainingFactory.length} 个待完成 Bot`,
      detail: failedCount > 0
        ? `其中 ${failedCount} 个注册失败，可一键重试或废弃队列。`
        : "可在批量队列中逐个扫码完成飞书应用注册。",
      actionLabel: "继续批量队列",
      actionType: "open-wizard-queue",
    });
  }

  return {
    totalCount,
    onlineCount,
    idleOnlineCount,
    activeRunsTotal,
    fullAuthCount,
    nonFullAuthBots,
    byEngine,
    mcpSummary,
    alerts,
  };
}
