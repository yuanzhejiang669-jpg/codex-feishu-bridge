const elements = {
  loading: document.querySelector("#loading"),
  error: document.querySelector("#error-band"),
  refresh: document.querySelector("#refresh-button"),
  generatedAt: document.querySelector("#generated-at"),
  appVersion: document.querySelector("#app-version"),
  codexSummary: document.querySelector("#codex-summary"),
  bridgeSummary: document.querySelector("#bridge-summary"),
  onlineSummary: document.querySelector("#online-summary"),
  runsSummary: document.querySelector("#runs-summary"),
  codexBadge: document.querySelector("#codex-status-badge"),
  codexDetails: document.querySelector("#codex-details"),
  botCount: document.querySelector("#bot-count"),
  tableBody: document.querySelector("#bot-table-body"),
  botList: document.querySelector("#bot-list"),
  botsViewCount: document.querySelector("#bots-view-count"),
  systemPaths: document.querySelector("#system-paths"),
  engineStatus: document.querySelector("#engine-status"),
  engineDetails: document.querySelector("#engine-details"),
  workspaceCount: document.querySelector("#workspace-count"),
  workspaceTableBody: document.querySelector("#workspace-table-body"),
  mcpCount: document.querySelector("#mcp-count"),
  mcpList: document.querySelector("#mcp-list"),
  skillCount: document.querySelector("#skill-count"),
  skillList: document.querySelector("#skill-list"),
  setupMode: document.querySelector("#setup-mode"),
  createBot: document.querySelector("#create-bot-button"),
  botDialog: document.querySelector("#bot-dialog"),
  botForm: document.querySelector("#bot-form"),
  botFormMode: document.querySelector("#bot-form-mode"),
  botFormError: document.querySelector("#bot-form-error"),
  closeBotDialog: document.querySelector("#close-bot-dialog"),
  createWithCredentials: document.querySelector("#create-with-credentials-button"),
  createWithQr: document.querySelector("#create-with-qr-button"),
  cancelRegistration: document.querySelector("#cancel-registration-button"),
  qrPanel: document.querySelector("#qr-panel"),
  registrationQr: document.querySelector("#registration-qr"),
  registrationMessage: document.querySelector("#registration-message"),
  migrationTarget: document.querySelector("#migration-target"),
  previewMigration: document.querySelector("#preview-migration-button"),
  migrationPreview: document.querySelector("#migration-preview"),
  providerMode: document.querySelector("#provider-mode"),
  customProviderFields: document.querySelector("#custom-provider-fields"),
  testProvider: document.querySelector("#test-provider-button"),
  providerTestStatus: document.querySelector("#provider-test-status"),
  compatibilityStatus: document.querySelector("#compatibility-status"),
  compatibilityList: document.querySelector("#compatibility-list"),
  botReadinessPanel: document.querySelector("#bot-readiness-panel"),
  botReadinessTitle: document.querySelector("#bot-readiness-title"),
  botReadinessStatus: document.querySelector("#bot-readiness-status"),
  botReadinessSummary: document.querySelector("#bot-readiness-summary"),
  botReadinessList: document.querySelector("#bot-readiness-list"),
  botReadinessActions: document.querySelector("#bot-readiness-actions"),
  botReadinessActionStatus: document.querySelector("#bot-readiness-action-status"),
  launchAtLoginSetting: document.querySelector("#launch-at-login-setting"),
  closeToTraySetting: document.querySelector("#close-to-tray-setting"),
  desktopRuntimeStatus: document.querySelector("#desktop-runtime-status"),
  recoverySummary: document.querySelector("#recovery-summary"),
  updateStatus: document.querySelector("#update-status"),
  updateDetails: document.querySelector("#update-details"),
  updateProgress: document.querySelector("#update-progress"),
  updateMessage: document.querySelector("#update-message"),
  checkUpdate: document.querySelector("#check-update-button"),
  installUpdate: document.querySelector("#install-update-button"),
  providerCatalogCount: document.querySelector("#provider-catalog-count"),
  providerCatalogBody: document.querySelector("#provider-catalog-body"),
  providerCatalogError: document.querySelector("#provider-catalog-error"),
  providerAddForm: document.querySelector("#provider-add-form"),
  providerAddModels: document.querySelector("#provider-add-models"),
  providerAddProbe: document.querySelector("#provider-add-probe"),
  providerReplaceForm: document.querySelector("#provider-replace-form"),
  providerReplaceModels: document.querySelector("#provider-replace-models"),
  providerSyncTargetCount: document.querySelector("#provider-sync-target-count"),
  providerSyncPreview: document.querySelector("#provider-sync-preview-button"),
  providerSyncApply: document.querySelector("#provider-sync-apply-button"),
  providerOperationResult: document.querySelector("#provider-operation-result"),
  createWorkspaceFactory: document.querySelector("#create-workspace-factory-button"),
  workspaceFactoryEditor: document.querySelector("#workspace-factory-editor"),
  workspaceFactoryForm: document.querySelector("#workspace-factory-form"),
  workspaceFactoryPreviewButton: document.querySelector("#workspace-factory-preview-button"),
  workspaceFactoryQueueButton: document.querySelector("#workspace-factory-queue-button"),
  workspaceFactoryPreview: document.querySelector("#workspace-factory-preview"),
  workspaceFactoryQueueSection: document.querySelector("#workspace-factory-queue-section"),
  workspaceFactoryQueueSummary: document.querySelector("#workspace-factory-queue-summary"),
  workspaceFactoryQueue: document.querySelector("#workspace-factory-queue"),
  workspaceFactoryQr: document.querySelector("#workspace-factory-qr"),
  workspaceFactoryQrImage: document.querySelector("#workspace-factory-qr-image"),
  workspaceFactoryQrMessage: document.querySelector("#workspace-factory-qr-message"),
  workspaceFactoryCancel: document.querySelector("#workspace-factory-cancel-button"),
  capabilitySourceHome: document.querySelector("#capability-source-home"),
  capabilitySourceConfig: document.querySelector("#capability-source-config"),
  capabilitySourceSkills: document.querySelector("#capability-source-skills"),
  migrationTargetDetail: document.querySelector("#migration-target-detail"),
  globalProviderFields: document.querySelector("#global-provider-fields"),
  botGlobalProvider: document.querySelector("#bot-global-provider"),
  botGlobalModel: document.querySelector("#bot-global-model"),
  botGlobalReasoning: document.querySelector("#bot-global-reasoning"),
  previewBotPaths: document.querySelector("#preview-bot-paths-button"),
  botPathPreview: document.querySelector("#bot-path-preview"),
  botConfigurationTarget: document.querySelector("#bot-configuration-target"),
  botSpaceTargetField: document.querySelector("#bot-space-target-field"),
  botSpaceTarget: document.querySelector("#bot-space-target"),
  botConfigurationSummary: document.querySelector("#bot-configuration-summary"),
  botProviderSection: document.querySelector("#bot-provider-section"),
  workspaceAgentsPaths: document.querySelector("#workspace-agents-paths"),
  protocolProxyStatus: document.querySelector("#protocol-proxy-status"),
  protocolProxyDetail: document.querySelector("#protocol-proxy-detail"),
  removalDialog: document.querySelector("#removal-dialog"),
  removalForm: document.querySelector("#removal-form"),
  removalTitle: document.querySelector("#removal-title"),
  removalError: document.querySelector("#removal-error"),
  removalImpact: document.querySelector("#removal-impact"),
  removalDeleteWorkspaces: document.querySelector("#removal-delete-workspaces"),
  removalDeleteHomeField: document.querySelector("#removal-delete-home-field"),
  removalDeleteHome: document.querySelector("#removal-delete-home"),
  removalConfirm: document.querySelector("#removal-confirm"),
  closeRemovalDialog: document.querySelector("#close-removal-dialog"),
  cancelRemoval: document.querySelector("#cancel-removal-button"),
  applyRemoval: document.querySelector("#apply-removal-button"),
};

let state = null;
let removalPreview = null;

function text(value, fallback = "-") {
  const result = String(value ?? "").trim();
  return result || fallback;
}

function escapeHtml(value) {
  return text(value, "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[char]);
}

function detailRows(entries) {
  return entries.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("");
}

function isolatedSpaceGroups(setup = {}, { spacesOnly = false } = {}) {
  const groups = new Map();
  (setup.managedBots || []).filter((bot) => (
    bot.codexHomeMode === "isolated"
    && bot.codexHome
    && (!spacesOnly || (bot.workspaceFactory?.spaceName && bot.provider?.mode === "global"))
  )).forEach((bot) => {
    const key = String(bot.codexHome).toLowerCase();
    if (!groups.has(key)) groups.set(key, { codexHome: bot.codexHome, bots: [] });
    groups.get(key).bots.push(bot);
  });
  return [...groups.values()].map((group) => {
    const first = group.bots[0];
    return {
      ...group,
      sourceName: first.name,
      spaceName: first.workspaceFactory?.spaceName || first.label || first.name,
      slug: first.workspaceFactory?.slug || first.name,
    };
  });
}

function badgeClass(kind) {
  return `badge ${kind}`;
}

function pathActions(value) {
  if (!value || !/^(?:[A-Za-z]:[\\/]|\/)/.test(String(value))) return "";
  return `<span class="path-actions"><button class="icon-path-button copy-known-path" data-path="${escapeHtml(value)}" type="button" title="复制路径" aria-label="复制路径">复制</button><button class="icon-path-button open-known-path" data-path="${escapeHtml(value)}" type="button" title="打开" aria-label="打开">打开</button></span>`;
}

function pathLine(label, value) {
  return `<div class="capability-path"><span>${escapeHtml(label)}</span><code>${escapeHtml(value || "-")}</code>${pathActions(value)}</div>`;
}

function renderCodex(codex, provider) {
  const good = codex.packageFound && codex.runtimeFound;
  const status = good ? "可用" : "不可用";
  elements.codexSummary.textContent = status;
  elements.codexBadge.textContent = status;
  elements.codexBadge.className = badgeClass(good ? "good" : "bad");
  elements.codexDetails.innerHTML = detailRows([
    ["桌面端", codex.packageFound ? `OpenAI.Codex ${text(codex.packageVersion)}` : "未检测到"],
    ["Codex CLI", text(codex.cliVersion, codex.runtimeFound ? "版本未知" : "不可用")],
    ["模型来源", provider.configured ? `${text(provider.id)} · ${text(provider.model, "模型未设置")}` : "未配置"],
    ["Provider 凭据", provider.envKey ? (provider.credentialAvailable ? `${provider.envKey} 可用` : `${provider.envKey} 未找到`) : "不需要或未知"],
    ["OpenAI 登录", provider.thirdParty ? "不需要（第三方 Provider）" : (({ "signed-in": "已登录", "signed-out": "未登录" })[codex.loginState] || "未知")],
    ["运行时", text(codex.runtimePath, "未检测到")],
    ["检测结果", text(codex.error, good ? "正常" : "不可用")],
  ]);
}

function statusBadge(instance) {
  return `<span class="${badgeClass(instance.online ? "good" : "bad")}">${instance.online ? "在线" : "离线"}</span>`;
}

function renderBots(bridge, setup = {}) {
  const instances = bridge.instances || [];
  const managedBots = setup.managedBots || [];
  const managedNames = new Set(managedBots.map((bot) => bot.name));
  const legacyBots = instances.filter((instance) => !managedNames.has(instance.name));
  const allBots = [
    ...managedBots.map((bot, managedIndex) => ({ ...bot, owner: "客户端管理", managedIndex })),
    ...legacyBots.map((bot, legacyIndex) => ({ ...bot, owner: "现有只读", legacyIndex })),
  ];
  elements.bridgeSummary.textContent = `${managedBots.length} 客户端 · ${legacyBots.length} 只读`;
  elements.onlineSummary.textContent = `${allBots.filter((bot) => bot.online).length}/${allBots.length}`;
  elements.runsSummary.textContent = String(allBots.reduce((sum, bot) => sum + Number(bot.activeRunCount || 0), 0));
  elements.botCount.textContent = `${allBots.length} 个实例`;
  elements.botsViewCount.textContent = `${managedBots.length} 个客户端管理 · ${legacyBots.length} 个现有只读`;

  if (!instances.length) {
    elements.tableBody.innerHTML = '<tr><td colspan="6" class="empty-row">未发现本机 Bridge 实例</td></tr>';
    elements.botList.innerHTML = managedBots.length ? "" : '<div class="empty-row">未发现本机 Bridge 实例</div>';
    elements.workspaceCount.textContent = "0 个工作空间";
    elements.workspaceTableBody.innerHTML = '<tr><td colspan="4" class="empty-row">未发现工作空间</td></tr>';
    if (!managedBots.length) return;
  }

  elements.tableBody.innerHTML = allBots.map((instance) => `
    <tr>
      <td title="${escapeHtml(instance.name)}"><strong>${escapeHtml(instance.name)}</strong><small>${escapeHtml(instance.owner)}</small></td>
      <td>${statusBadge(instance)}</td>
      <td>${escapeHtml(instance.processId)}</td>
      <td>${instance.activeRunCount}</td>
      <td title="${escapeHtml(instance.workspace)}">${escapeHtml(instance.workspace)}</td>
      <td><button class="link-button open-known-path" data-path="${escapeHtml(instance.workspace)}" type="button" ${instance.workspace ? "" : "disabled"}>打开</button></td>
    </tr>`).join("");

  elements.botList.innerHTML = managedBots.map((bot, index) => {
    const recovery = setup.recovery?.[bot.name];
    const recoveryFailed = recovery?.status === "failed";
    const stateLabel = recoveryFailed ? "恢复失败" : bot.online ? "在线" : "已配置";
    const stateKind = recoveryFailed ? "bad" : bot.online ? "good" : "warn";
    return `
    <div class="bot-row">
      <strong>${escapeHtml(bot.label || bot.name)}<small>客户端管理</small></strong>
      <span><span class="${badgeClass(stateKind)}" title="${escapeHtml(recovery?.lastError || "")}">${stateLabel}</span></span>
      <span>${bot.activeRunCount} 个任务</span>
      <span class="path-text">${escapeHtml(bot.workspace)}</span>
      <div class="bot-actions">
        <label class="auto-start-toggle" title="Windows 登录后启动，并在意外离线时自动恢复"><input class="managed-bot-autostart" data-managed-index="${index}" type="checkbox" ${bot.autoStart ? "checked" : ""}>自启</label>
        <button class="link-button managed-bot-readiness" data-managed-index="${index}" type="button">检查</button>
        <button class="link-button managed-bot-action" data-managed-index="${index}" type="button">${bot.online ? "停止" : "启动"}</button>
        <button class="link-button danger-link managed-bot-remove" data-managed-index="${index}" type="button">删除</button>
      </div>
    </div>`;
  }).join("") + legacyBots.map((instance) => `
    <div class="bot-row">
      <strong>${escapeHtml(instance.name)}<small>现有 Bridge · 只读</small></strong>
      <span>${statusBadge(instance)}</span>
      <span>${instance.activeRunCount} 个任务</span>
      <span class="path-text">${escapeHtml(instance.workspace)}</span>
      <span></span>
    </div>`).join("");

  const spaces = setup.managedSpaces || [];
  const managedHomes = new Set(spaces.map((space) => String(space.codexHome || "").toLowerCase()));
  const otherWorkspaces = allBots.filter((instance) => instance.workspace && !managedHomes.has(String(instance.codexHome || "").toLowerCase()));
  elements.workspaceCount.textContent = `${spaces.length} 个客户端空间 · ${otherWorkspaces.length} 个其他工作空间`;
  elements.workspaceTableBody.innerHTML = spaces.length || otherWorkspaces.length
    ? spaces.map((space, index) => `<tr><td><strong>${escapeHtml(space.spaceName)}</strong><small>${space.bots.length} 个 Bot</small></td><td>${escapeHtml(space.bots.map((bot) => bot.workspace).join("；"))}</td><td title="${escapeHtml(space.codexHome)}">${escapeHtml(space.codexHome)}</td><td><button class="link-button danger-link managed-space-remove" data-space-index="${index}" type="button">删除空间</button></td></tr>`).join("")
      + otherWorkspaces.map((instance) => `<tr><td>${escapeHtml(instance.name)}</td><td title="${escapeHtml(instance.workspace)}">${escapeHtml(instance.workspace)}</td><td title="${escapeHtml(instance.codexHome)}">${escapeHtml(instance.codexHome)}</td><td><span class="section-meta">只读</span></td></tr>`).join("")
    : '<tr><td colspan="4" class="empty-row">未发现工作空间</td></tr>';
}

function renderBotReadiness(result) {
  const labels = { good: "正常", warn: "待验证", bad: "有阻塞" };
  elements.botReadinessPanel.classList.remove("hidden");
  elements.botReadinessTitle.textContent = `${result.label} · 运行准备检查`;
  elements.botReadinessStatus.textContent = labels[result.status] || "未知";
  elements.botReadinessStatus.className = badgeClass(result.status || "neutral");
  elements.botReadinessSummary.textContent = result.summary;
  elements.botReadinessList.innerHTML = (result.checks || []).map((entry) => `
    <div class="compatibility-row">
      <strong>${escapeHtml(entry.label)}</strong>
      <span><span class="${badgeClass(entry.status)}">${escapeHtml(labels[entry.status] || "未知")}</span></span>
      <span>${escapeHtml(entry.detail)}</span>
    </div>`).join("");
  elements.botReadinessActions.dataset.botName = result.name || "";
  elements.botReadinessActions.classList.toggle("hidden", !result.actions?.appId);
  elements.botReadinessActionStatus.textContent = result.actions?.userIdentityReady
    ? `用户身份已登录；目标事件：${(result.actions.requiredEventKeys || []).join(", ")}`
    : `目标事件：${(result.actions?.requiredEventKeys || []).join(", ")}。权限发布完成后再登录用户身份。`;
  const authorizeButton = elements.botReadinessActions.querySelector('[data-readiness-action="authorize-user"]');
  if (authorizeButton) {
    const verified = result.actions?.userIdentityReady === true;
    authorizeButton.textContent = verified ? "重新授权用户身份" : "登录 Lark CLI 用户身份";
    authorizeButton.className = verified ? "secondary-button" : "primary-button";
  }
}

function renderDesktopSettings(settings = {}, setup = {}) {
  elements.launchAtLoginSetting.checked = settings.launchAtLogin === true;
  elements.launchAtLoginSetting.disabled = settings.launchAtLoginSupported !== true;
  elements.closeToTraySetting.checked = settings.closeToTray !== false;
  const available = settings.launchAtLoginSupported && settings.trayAvailable;
  elements.desktopRuntimeStatus.textContent = available ? "可用" : "受限";
  elements.desktopRuntimeStatus.className = badgeClass(available ? "good" : "warn");
  const recovery = Object.values(setup.recovery || {});
  const failed = recovery.filter((item) => item.status === "failed").length;
  const automatic = (setup.managedBots || []).filter((bot) => bot.autoStart).length;
  elements.recoverySummary.textContent = settings.error
    ? `设置读取失败：${settings.error}`
    : `开机启动 Bot ${automatic} 个${failed ? `，恢复失败 ${failed} 个` : ""}`;
}

function renderUpdater(update = {}) {
  const labels = {
    unsupported: "不可用",
    idle: "待检查",
    checking: "检查中",
    available: "发现更新",
    downloading: "下载中",
    downloaded: "可安装",
    "not-available": "已是最新",
    blocked: "等待任务",
    installing: "正在安装",
    error: "检查失败",
  };
  const kinds = {
    downloaded: "good",
    "not-available": "good",
    available: "warn",
    downloading: "warn",
    blocked: "warn",
    error: "bad",
  };
  const status = update.status || "idle";
  elements.updateStatus.textContent = labels[status] || "未知";
  elements.updateStatus.className = badgeClass(kinds[status] || "neutral");
  elements.updateDetails.innerHTML = detailRows([
    ["当前版本", text(update.currentVersion)],
    ["最新版本", text(update.latestVersion, status === "idle" ? "尚未检查" : "-")],
    ["更新通道", "GitHub Releases · stable"],
  ]);
  const progressVisible = status === "downloading";
  elements.updateProgress.classList.toggle("hidden", !progressVisible);
  elements.updateProgress.value = Number(update.progress || 0);
  const active = (update.activeBots || []).map((bot) => `${bot.name}（${bot.activeRunCount} 个任务）`).join("、");
  elements.updateMessage.textContent = ({
    unsupported: "开发模式不连接更新服务",
    idle: "可以手动检查；安装版启动后也会定期检查",
    checking: "正在读取 GitHub 最新发行版",
    available: `发现 ${text(update.latestVersion)}，正在准备下载`,
    downloading: `已下载 ${Math.round(Number(update.progress || 0))}%`,
    downloaded: "下载完成。安装前会再次检查活动任务",
    "not-available": "当前客户端已经是最新稳定版",
    blocked: active ? `以下 Bot 仍在运行任务：${active}` : "请等待活动任务结束后重试",
    installing: "正在关闭空闲 Bot 并启动安装程序",
    error: text(update.error, "无法连接更新服务"),
  })[status] || "";
  const installable = status === "downloaded" || status === "blocked";
  elements.installUpdate.classList.toggle("hidden", !installable);
  elements.installUpdate.textContent = status === "blocked" ? "任务结束后重试" : "重启并安装";
  elements.installUpdate.disabled = false;
  elements.checkUpdate.disabled = !update.supported || ["checking", "downloading", "installing"].includes(status);
  elements.checkUpdate.classList.toggle("hidden", installable || status === "installing");
}

function renderSystemPaths(currentState) {
  const permissionPolicy = currentState.setup.permissionPolicy || {};
  elements.systemPaths.innerHTML = detailRows([
    ["Bridge 数据", currentState.bridge.root],
    ["Codex 安装包", currentState.codex.installLocation],
    ["Codex 运行时", currentState.codex.runtimePath],
    ["客户端数据", currentState.setup.dataRoot],
    ["客户端 Bot 运行数据", currentState.setup.runtimeLocalAppData],
    ["数据 Schema", `${currentState.setup.dataSchema.currentVersion ?? "未初始化"} / ${currentState.setup.dataSchema.supportedVersion}`],
    ["飞书权限策略", `${permissionPolicy.policyId || "-"} · ${permissionPolicy.totalScopeCount || 0} 项 · ${(permissionPolicy.eventKeys || []).join(", ") || "-"}`],
    ["新建工作空间", currentState.setup.workspaceRoot],
  ]);
}

function renderEngine(engine) {
  elements.engineStatus.textContent = engine.available ? "完整" : "不可用";
  elements.engineStatus.className = badgeClass(engine.available ? "good" : "bad");
  elements.engineDetails.innerHTML = detailRows([
    ["Bridge 引擎", engine.available ? "已打包" : "未完成"],
    ["协议版本", text(engine.protocolVersion)],
    ["源码提交", text(engine.sourceCommit)],
    ["lark-cli", text(engine.larkCliVersion, "不可用")],
    ["Node.js", text(engine.nodeVersion, "不可用")],
    ["引擎目录", text(engine.engineRoot)],
  ]);
}

function renderCompatibility(compatibility) {
  const labels = { good: "兼容", warn: "需注意", bad: "不兼容" };
  elements.compatibilityStatus.textContent = labels[compatibility.status] || "未知";
  elements.compatibilityStatus.className = badgeClass(compatibility.status || "neutral");
  elements.compatibilityList.innerHTML = (compatibility.items || []).map((entry) => `
    <div class="compatibility-row">
      <strong>${escapeHtml(entry.label)}</strong>
      <span><span class="${badgeClass(entry.status)}">${escapeHtml(labels[entry.status] || "未知")}</span></span>
      <span>${escapeHtml(entry.detail)}</span>
    </div>`).join("");
}

function renderCapabilities(capabilities, setup) {
  const mcpServers = capabilities.mcpServers || [];
  const skills = capabilities.skills || [];
  elements.capabilitySourceHome.textContent = capabilities.codexHome || "-";
  elements.capabilitySourceConfig.textContent = capabilities.configPath || "-";
  elements.capabilitySourceSkills.textContent = capabilities.skillsRoot || "-";
  elements.mcpCount.textContent = `${mcpServers.length} 个`;
  elements.skillCount.textContent = `${skills.length} 个`;
  elements.mcpList.innerHTML = mcpServers.length
    ? mcpServers.map((item) => {
      const missing = item.commandAvailable === false || item.entryAvailable === false;
      return `<div class="capability-row capability-detail-row">
        <label class="capability-selector"><input class="migration-mcp" type="checkbox" value="${escapeHtml(item.name)}"><strong>${escapeHtml(item.name)}</strong><span class="${badgeClass(missing ? "bad" : "good")}">${missing ? "路径缺失" : "已定位"}</span></label>
        ${pathLine("配置", item.configPath)}
        <div class="capability-path"><span>配置段</span><code>${escapeHtml(item.configSection)}</code></div>
        ${pathLine("命令", item.commandPath || item.command)}
        ${item.entryPath ? pathLine("入口", item.entryPath) : ""}
        <div class="capability-path"><span>环境变量</span><code>${escapeHtml((item.envKeys || []).join(", ") || "无")}</code></div>
      </div>`;
    }).join("")
    : '<div class="empty-row">未发现 MCP</div>';
  elements.skillList.innerHTML = skills.length
    ? skills.map((item) => `<div class="capability-row capability-detail-row">
      <label class="capability-selector"><input class="migration-skill" type="checkbox" value="${escapeHtml(item.name)}"><strong>${escapeHtml(item.name)}</strong><span class="${badgeClass("good")}">已定位</span></label>
      ${pathLine("目录", item.path)}
      ${pathLine("入口", item.skillFile)}
    </div>`).join("")
    : '<div class="empty-row">未发现 Skills</div>';
  const groups = isolatedSpaceGroups(setup);
  elements.migrationTarget.innerHTML = '<option value="">选择目标空间 / Codex Home</option>' + groups
    .map((group) => {
      const first = group.bots[0];
      return `<option value="${escapeHtml(first.name)}" data-codex-home="${escapeHtml(group.codexHome)}" data-bot-names="${escapeHtml(group.bots.map((bot) => bot.name).join("、"))}">${escapeHtml(group.spaceName)} · ${group.bots.length} 个 Bot · ${escapeHtml(group.codexHome)}</option>`;
    }).join("");
  elements.migrationTargetDetail.classList.add("hidden");
  elements.migrationPreview.classList.add("hidden");
}

function renderProviderCatalog(catalog = {}, setup = {}) {
  const providers = catalog.providers || [];
  elements.providerCatalogCount.textContent = `${providers.length} 个 · ${text(catalog.configPath)}`;
  elements.providerCatalogError.textContent = catalog.error || "";
  elements.providerCatalogError.classList.toggle("hidden", !catalog.error);
  elements.providerCatalogBody.innerHTML = providers.length
    ? providers.map((provider) => `
      <tr>
        <td title="${escapeHtml(provider.id)}"><strong>${escapeHtml(provider.name)}</strong>${provider.selected ? '<span class="selected-mark">当前</span>' : ""}<small>${escapeHtml(provider.id)}</small></td>
        <td title="${escapeHtml(provider.localBaseUrl || provider.baseUrl)}">${escapeHtml(provider.baseUrl)}${provider.managedProxy ? `<small>本地转换：${escapeHtml(provider.localBaseUrl)}</small>` : ""}</td>
        <td>${escapeHtml(provider.wireApi || "未设置")}</td>
        <td>${escapeHtml(provider.envKey || "未设置")}</td>
        <td><span class="${badgeClass(provider.credentialAvailable ? "good" : "warn")}">${provider.credentialAvailable ? "可用" : "未找到"}</span></td>
      </tr>`).join("")
    : '<tr><td colspan="5" class="empty-row">全局 config.toml 中没有 Provider</td></tr>';
  const select = elements.providerReplaceForm.elements.id;
  const selected = select.value;
  select.innerHTML = '<option value="">请选择</option>' + providers
    .map((provider) => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.name)} · ${escapeHtml(provider.id)}</option>`).join("");
  if (providers.some((provider) => provider.id === selected)) select.value = selected;
  const botSelected = elements.botGlobalProvider.value;
  elements.botGlobalProvider.innerHTML = '<option value="">请选择</option>' + providers
    .filter((provider) => provider.credentialAvailable)
    .map((provider) => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.name)} · ${escapeHtml(provider.id)}</option>`).join("");
  if (providers.some((provider) => provider.id === botSelected && provider.credentialAvailable)) {
    elements.botGlobalProvider.value = botSelected;
  } else if (providers.some((provider) => provider.id === catalog.selectedId && provider.credentialAvailable)) {
    elements.botGlobalProvider.value = catalog.selectedId;
    if (!elements.botGlobalModel.value) elements.botGlobalModel.value = catalog.selectedModel || "";
  }
  elements.providerSyncTargetCount.textContent = `${(setup.managedBots || []).filter((bot) => bot.codexHomeMode === "isolated").length} 个可同步目标`;
}

function renderProtocolProxy(proxy = {}) {
  const labels = { online: "运行中", starting: "启动中", failed: "异常", unused: "尚未使用", stopped: "已停止", unavailable: "不可用" };
  const kind = proxy.status === "online" ? "good" : proxy.status === "failed" || proxy.status === "unavailable" ? "bad" : "neutral";
  elements.protocolProxyStatus.innerHTML = `<span class="${badgeClass(kind)}">${escapeHtml(labels[proxy.status] || proxy.status || "未知")}</span>`;
  elements.protocolProxyDetail.textContent = proxy.providerCount
    ? `mimo2codex ${text(proxy.version)} · ${proxy.providerCount} 个 Chat Provider · ${text(proxy.baseUrl)}${proxy.error ? ` · ${proxy.error}` : ""}`
    : `mimo2codex ${text(proxy.version)} 已随客户端提供；添加 Chat Completions Provider 后自动启动。`;
}

function renderWorkspaceFactory(factoryState = {}, catalog = {}) {
  const providerSelect = elements.workspaceFactoryForm.elements.providerId;
  const selectedProvider = providerSelect.value;
  providerSelect.innerHTML = '<option value="">请选择</option>' + (catalog.providers || [])
    .filter((provider) => provider.credentialAvailable)
    .map((provider) => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.name)} · ${escapeHtml(provider.id)}</option>`).join("");
  if ((catalog.providers || []).some((provider) => provider.id === selectedProvider && provider.credentialAvailable)) {
    providerSelect.value = selectedProvider;
  } else if (catalog.selectedId && (catalog.providers || []).some((provider) => provider.id === catalog.selectedId && provider.credentialAvailable)) {
    providerSelect.value = catalog.selectedId;
    if (!elements.workspaceFactoryForm.elements.model.value) elements.workspaceFactoryForm.elements.model.value = catalog.selectedModel || "";
  }

  const bots = factoryState.bots || [];
  elements.workspaceFactoryQueueSection.classList.toggle("hidden", bots.length === 0);
  if (!bots.length) return;
  const created = bots.filter((bot) => bot.status === "created").length;
  const failed = bots.filter((bot) => bot.status === "failed").length;
  elements.workspaceFactoryQueueSummary.textContent = `${created}/${bots.length} 已创建${failed ? ` · ${failed} 个失败` : ""}`;
  elements.workspaceFactoryQueue.innerHTML = bots.map((bot) => {
    const status = ({ pending: "待创建", registering: "注册中", created: "已创建", failed: "失败" })[bot.status] || bot.status;
    const kind = bot.status === "created" ? "good" : bot.status === "failed" ? "bad" : bot.status === "registering" ? "warn" : "neutral";
    return `<div class="factory-queue-row">
      <div><strong>${escapeHtml(bot.label)}</strong><small>${escapeHtml(bot.name)}</small></div>
      <span class="path-text">${escapeHtml(bot.workspace)}</span>
      <span class="${badgeClass(kind)}" title="${escapeHtml(bot.error || "")}">${escapeHtml(status)}</span>
      <button class="${bot.status === "pending" ? "primary-button" : "secondary-button"} factory-register-bot" data-name="${escapeHtml(bot.name)}" type="button" ${bot.status === "pending" ? "" : "disabled"}>扫码创建</button>
    </div>`;
  }).join("");
}

function renderBotCreationTargets(setup = {}) {
  const selected = elements.botSpaceTarget.value;
  const groups = isolatedSpaceGroups(setup, { spacesOnly: true });
  elements.botSpaceTarget.innerHTML = '<option value="">请选择已有空间</option>' + groups
    .map((group) => `<option value="${escapeHtml(group.sourceName)}">${escapeHtml(group.spaceName)} · ${group.bots.length} 个 Bot · ${escapeHtml(group.codexHome)}</option>`)
    .join("");
  if (groups.some((group) => group.sourceName === selected)) elements.botSpaceTarget.value = selected;
  updateBotConfigurationTarget(false);
}

function renderWorkspaceAgentsPaths() {
  const slug = text(elements.workspaceFactoryForm.elements.slug.value, "space");
  const homeName = text(elements.workspaceFactoryForm.elements.codexHomeName.value, `codex-space-${slug}`);
  const sourceHome = state?.capabilities?.codexHome || "C:\\Users\\用户名\\.codex";
  const targetRoot = state?.setup?.codexHomeRoot || "C:\\Users\\用户名\\Documents\\Codex\\codex-homes";
  const trim = (value) => String(value || "").replace(/[\\/]+$/, "");
  const source = state?.capabilities?.agentsPath || `${trim(sourceHome)}\\AGENTS.md`;
  const available = state?.capabilities?.agentsAvailable !== false;
  elements.workspaceAgentsPaths.innerHTML = `<span>来源${available ? "" : "（当前不存在，请取消勾选或先创建）"}</span><code>${escapeHtml(source)}</code><span>目标</span><code>${escapeHtml(`${trim(targetRoot)}\\${homeName}\\AGENTS.md`)}</code>`;
}

function render(currentState) {
  state = currentState;
  elements.appVersion.textContent = `v${currentState.app.version}`;
  elements.generatedAt.textContent = `更新于 ${new Date(currentState.generatedAt).toLocaleString()}`;
  renderCodex(currentState.codex, currentState.provider);
  const sandbox = currentState.setup.mode === "development-sandbox";
  elements.setupMode.textContent = sandbox ? "开发沙箱" : "已安装客户端";
  elements.botFormMode.textContent = sandbox ? "仅写入开发沙箱" : "写入客户端独立数据";
  renderBots(currentState.bridge, currentState.setup);
  renderEngine(currentState.engine);
  renderCompatibility(currentState.compatibility);
  renderCapabilities(currentState.capabilities, currentState.setup);
  renderProviderCatalog(currentState.providerCatalog, currentState.setup);
  renderProtocolProxy(currentState.setup.protocolProxy);
  renderWorkspaceFactory(currentState.setup.workspaceFactory, currentState.providerCatalog);
  renderBotCreationTargets(currentState.setup);
  renderWorkspaceAgentsPaths();
  renderSystemPaths(currentState);
  renderDesktopSettings(currentState.settings, currentState.setup);
  renderUpdater(currentState.update);
}

function workspaceFactoryInput() {
  const data = new FormData(elements.workspaceFactoryForm);
  return Object.fromEntries([...data.entries()].map(([key, value]) => [key, typeof value === "string" ? value.trim() : value]));
}

function addProviderInput() {
  const data = new FormData(elements.providerAddForm);
  return {
    id: text(data.get("id"), ""),
    name: text(data.get("name"), ""),
    baseUrl: text(data.get("baseUrl"), ""),
    envKey: text(data.get("envKey"), ""),
    apiKey: text(data.get("apiKey"), ""),
    model: text(data.get("model"), ""),
    wireApi: text(data.get("wireApi"), "responses"),
  };
}

function replacementProviderInput() {
  const data = new FormData(elements.providerReplaceForm);
  const id = text(data.get("id"), "");
  const provider = state?.providerCatalog?.providers?.find((item) => item.id === id);
  if (!provider) throw new Error("请先选择已有 Provider");
  return {
    ...provider,
    wireApi: provider.managedProxy ? "chat" : provider.wireApi,
    apiKey: text(data.get("apiKey"), ""),
    model: text(data.get("model"), ""),
  };
}

function showProviderResult(title, detail, kind = "good") {
  elements.providerOperationResult.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span>`;
  elements.providerOperationResult.className = `operation-result ${kind}`;
}

function providerModelsText(result) {
  const ids = (result.models || []).map((item) => item.id);
  return ids.length ? `${ids.length} 个：${ids.slice(0, 12).join("、")}${ids.length > 12 ? "…" : ""}` : "接口成功，但没有返回模型";
}

async function runProviderAction(button, task) {
  button.disabled = true;
  elements.error.classList.add("hidden");
  try { return await task(); }
  catch (error) {
    showProviderResult("操作失败", error.message || String(error), "bad");
    throw error;
  } finally { button.disabled = false; }
}

function capabilitySelection() {
  return {
    mcpServers: [...document.querySelectorAll(".migration-mcp:checked")].map((item) => item.value),
    skills: [...document.querySelectorAll(".migration-skill:checked")].map((item) => item.value),
  };
}

function migrationStatusText(items) {
  const blocked = items.filter((item) => item.status === "blocked-sensitive").map((item) => item.name);
  const existing = items.filter((item) => item.status === "exists").map((item) => item.name);
  const missing = items.filter((item) => item.status === "missing").map((item) => item.name);
  return [
    blocked.length ? `含敏感字段，未自动复制：${blocked.join("、")}` : "",
    existing.length ? `目标已存在：${existing.join("、")}` : "",
    missing.length ? `源项目不存在：${missing.join("、")}` : "",
  ].filter(Boolean).join("；");
}

function suggestedSpaceBot(group) {
  const names = new Set([
    ...(state?.bridge?.instances || []).map((item) => item.name),
    ...(state?.setup?.managedBots || []).map((item) => item.name),
  ]);
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = `codex-assistant-${index}-${group.slug}`;
    if (candidate.length <= 64 && !names.has(candidate)) {
      return { name: candidate, label: `Codex助手${index}-${group.spaceName}` };
    }
  }
  const name = suggestedBotName();
  return { name, label: `Codex助手-${group.spaceName}` };
}

function updateBotConfigurationTarget(resetNames = true) {
  const mode = elements.botConfigurationTarget.value;
  const isSpace = mode === "space";
  const groups = isolatedSpaceGroups(state?.setup || {}, { spacesOnly: true });
  const group = groups.find((item) => item.sourceName === elements.botSpaceTarget.value);
  elements.botSpaceTargetField.classList.toggle("hidden", !isSpace);
  elements.botSpaceTarget.required = isSpace;
  elements.botProviderSection.classList.add("hidden");
  elements.providerMode.value = "current";
  updateBotProviderMode();
  if (isSpace) {
    elements.botConfigurationSummary.textContent = group
      ? `将补充到“${group.spaceName}”，共享 Codex Home：${group.codexHome}`
      : groups.length
        ? "请选择要补充 Bot 的已有空间"
        : "当前没有可用的隔离空间，请先创建空间";
    if (resetNames && group) {
      const suggestion = suggestedSpaceBot(group);
      document.querySelector("#bot-name").value = suggestion.name;
      document.querySelector("#bot-label").value = suggestion.label;
      document.querySelector("#bot-profile").value = "";
    }
  } else {
    elements.botConfigurationSummary.textContent = `使用全局 Codex 配置：${state?.capabilities?.codexHome || "C:\\Users\\用户名\\.codex"}`;
    if (resetNames) {
      const suggested = suggestedBotName();
      document.querySelector("#bot-name").value = suggested;
      document.querySelector("#bot-label").value = `Codex助手${suggested.match(/\d+$/)?.[0] || ""}`.trim();
      document.querySelector("#bot-profile").value = "";
    }
  }
  elements.botPathPreview.classList.add("hidden");
}

function botInput() {
  const data = new FormData(elements.botForm);
  return {
    name: text(data.get("name"), ""),
    label: text(data.get("label"), ""),
    workspace: text(data.get("workspace"), ""),
    brand: text(data.get("brand"), "feishu"),
    profile: text(data.get("profile"), ""),
    configurationTarget: text(data.get("configurationTarget"), "global"),
    spaceSourceName: text(data.get("spaceSourceName"), ""),
    provider: providerInput(),
  };
}

function providerInput() {
  const mode = elements.providerMode.value;
  if (mode === "current") return { mode };
  if (mode === "global") return {
    mode,
    id: elements.botGlobalProvider.value,
    model: elements.botGlobalModel.value,
    reasoning: elements.botGlobalReasoning.value,
  };
  return {
    mode,
    id: document.querySelector("#provider-id").value,
    baseUrl: document.querySelector("#provider-base-url").value,
    model: document.querySelector("#provider-model").value,
    apiKey: document.querySelector("#provider-api-key").value,
    reasoning: document.querySelector("#provider-reasoning").value,
  };
}

async function testProviderDraft() {
  if (elements.providerMode.value === "current" || elements.providerMode.value === "global") return { ok: true, current: true };
  elements.testProvider.disabled = true;
  elements.providerTestStatus.textContent = "正在发送最小模型请求";
  try {
    const result = await window.bridgeDesktop.testProvider({
      ...providerInput(),
      botName: document.querySelector("#bot-name").value,
    });
    elements.providerTestStatus.textContent = `连接成功 · ${result.model}`;
    return result;
  } catch (error) {
    elements.providerTestStatus.textContent = "连接失败";
    throw error;
  } finally {
    elements.testProvider.disabled = false;
  }
}

function setBotFormBusy(busy) {
  elements.createWithCredentials.disabled = busy;
  elements.createWithQr.disabled = busy;
  elements.closeBotDialog.disabled = busy;
}

function showBotFormError(error) {
  const message = error?.message || String(error);
  elements.botFormError.textContent = message.replace(/^Error invoking remote method '[^']+': Error:\s*/, "");
  elements.botFormError.classList.remove("hidden");
}

function updateBotProviderMode() {
  const mode = elements.providerMode.value;
  elements.globalProviderFields.classList.toggle("hidden", mode !== "global");
  elements.customProviderFields.classList.toggle("hidden", mode !== "custom");
  elements.botGlobalProvider.required = mode === "global";
  elements.botGlobalModel.required = mode === "global";
  ["#provider-id", "#provider-model", "#provider-base-url", "#provider-api-key"].forEach((selector) => {
    document.querySelector(selector).required = mode === "custom";
  });
  elements.providerTestStatus.textContent = "";
}

function resetBotDialog() {
  elements.botForm.reset();
  elements.botFormError.classList.add("hidden");
  elements.qrPanel.classList.add("hidden");
  elements.cancelRegistration.classList.add("hidden");
  elements.registrationQr.removeAttribute("src");
  elements.registrationQr.classList.add("hidden");
  elements.botConfigurationTarget.value = "global";
  elements.botSpaceTarget.value = "";
  elements.providerMode.value = "current";
  const catalog = state?.providerCatalog || {};
  if ((catalog.providers || []).some((provider) => provider.id === catalog.selectedId && provider.credentialAvailable)) {
    elements.botGlobalProvider.value = catalog.selectedId;
    elements.botGlobalModel.value = catalog.selectedModel || "";
  }
  elements.globalProviderFields.classList.add("hidden");
  elements.customProviderFields.classList.add("hidden");
  updateBotConfigurationTarget(true);
  elements.botPathPreview.classList.add("hidden");
  elements.providerTestStatus.textContent = "";
  setBotFormBusy(false);
}

function suggestedBotName() {
  const names = new Set([
    ...(state?.bridge?.instances || []).map((item) => item.name),
    ...(state?.setup?.managedBots || []).map((item) => item.name),
  ]);
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = `codex-assistant-${index}`;
    if (!names.has(candidate)) return candidate;
  }
  return `codex-assistant-${Date.now()}`;
}

async function validateBotDraft() {
  if (!elements.botForm.reportValidity()) throw new Error("请先填写有效的 Bot 配置");
  const preview = await window.bridgeDesktop.previewBot(botInput());
  if (!preview.available) throw new Error(preview.conflict);
  await testProviderDraft();
  return preview;
}

async function finishBotCreation(task) {
  elements.botFormError.classList.add("hidden");
  setBotFormBusy(true);
  try {
    await task();
    elements.botDialog.close();
    resetBotDialog();
    await refresh();
  } catch (error) {
    elements.qrPanel.classList.add("hidden");
    elements.cancelRegistration.classList.add("hidden");
    elements.registrationQr.removeAttribute("src");
    elements.registrationQr.classList.add("hidden");
    showBotFormError(error);
  } finally {
    setBotFormBusy(false);
  }
}

async function refresh() {
  elements.refresh.disabled = true;
  elements.loading.classList.remove("hidden");
  elements.error.classList.add("hidden");
  try {
    render(await window.bridgeDesktop.getState());
  } catch (error) {
    elements.error.textContent = error.message || String(error);
    elements.error.classList.remove("hidden");
  } finally {
    elements.loading.classList.add("hidden");
    elements.refresh.disabled = false;
  }
}

async function openRemovalDialog(kind, id) {
  removalPreview = null;
  elements.removalError.classList.add("hidden");
  elements.removalImpact.innerHTML = "正在读取影响范围…";
  elements.removalConfirm.checked = false;
  elements.removalDeleteWorkspaces.checked = false;
  elements.removalDeleteHome.checked = kind === "space";
  elements.applyRemoval.disabled = false;
  elements.removalDeleteHomeField.classList.toggle("hidden", kind !== "space");
  elements.removalDialog.showModal();
  try {
    removalPreview = await window.bridgeDesktop.previewManagedRemoval({ kind, id });
    elements.removalTitle.textContent = removalPreview.title;
    const active = removalPreview.bots.filter((bot) => bot.activeRunCount > 0);
    const pathRows = removalPreview.kind === "space"
      ? `<span>隔离 Codex Home</span><code>${escapeHtml(removalPreview.paths.codexHome)}</code><span>工作空间</span><code>${escapeHtml(removalPreview.paths.workspaces.join("；"))}</code>`
      : `<span>工作空间</span><code>${escapeHtml(removalPreview.paths.workspace)}</code><span>Codex Home</span><code>${escapeHtml(removalPreview.paths.codexHome)}（保留）</code>`;
    elements.removalImpact.innerHTML = `<strong>影响 ${removalPreview.bots.length} 个客户端 Bot</strong><span>${escapeHtml(removalPreview.bots.map((bot) => `${bot.label}（${bot.name}）`).join("、"))}</span>${pathRows}<span class="${active.length ? "bad" : ""}">${active.length ? `有活动任务：${escapeHtml(active.map((bot) => bot.name).join("、"))}，当前不能删除` : "没有活动任务，可以执行删除"}</span><span>飞书开放平台中的应用不会删除。</span>`;
    elements.applyRemoval.disabled = active.length > 0;
  } catch (error) {
    elements.removalError.textContent = error.message || String(error);
    elements.removalError.classList.remove("hidden");
    elements.applyRemoval.disabled = true;
  }
}

elements.refresh.addEventListener("click", refresh);
elements.checkUpdate.addEventListener("click", async () => {
  elements.checkUpdate.disabled = true;
  try {
    renderUpdater(await window.bridgeDesktop.checkUpdate());
  } catch (error) {
    elements.error.textContent = error.message || String(error);
    elements.error.classList.remove("hidden");
  }
});
elements.installUpdate.addEventListener("click", async () => {
  elements.installUpdate.disabled = true;
  try {
    renderUpdater(await window.bridgeDesktop.installUpdate());
  } catch (error) {
    elements.error.textContent = error.message || String(error);
    elements.error.classList.remove("hidden");
    elements.installUpdate.disabled = false;
  }
});
document.addEventListener("click", async (event) => {
  const openButton = event.target.closest(".open-known-path");
  const copyButton = event.target.closest(".copy-known-path");
  const button = openButton || copyButton;
  if (!button?.dataset.path) return;
  event.preventDefault();
  event.stopPropagation();
  try {
    if (openButton) await window.bridgeDesktop.openPath(button.dataset.path);
    else await window.bridgeDesktop.copyPath(button.dataset.path);
  } catch (error) {
    elements.error.textContent = error.message || String(error);
    elements.error.classList.remove("hidden");
  }
});
elements.botList.addEventListener("click", async (event) => {
  const removeButton = event.target.closest(".managed-bot-remove");
  if (removeButton && state) {
    const bot = state.setup.managedBots[Number(removeButton.dataset.managedIndex)];
    if (bot) await openRemovalDialog("bot", bot.name);
    return;
  }
  const readinessButton = event.target.closest(".managed-bot-readiness");
  if (readinessButton && state) {
    const bot = state.setup.managedBots[Number(readinessButton.dataset.managedIndex)];
    if (!bot) return;
    readinessButton.disabled = true;
    elements.error.classList.add("hidden");
    try {
      renderBotReadiness(await window.bridgeDesktop.checkBotReadiness(bot.name));
      elements.botReadinessPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (error) {
      elements.error.textContent = error.message || String(error);
      elements.error.classList.remove("hidden");
    } finally {
      readinessButton.disabled = false;
    }
    return;
  }
  const button = event.target.closest(".managed-bot-action");
  if (!button || !state) return;
  const bot = state.setup.managedBots[Number(button.dataset.managedIndex)];
  if (!bot) return;
  button.disabled = true;
  elements.error.classList.add("hidden");
  try {
    if (bot.online) await window.bridgeDesktop.stopBot(bot.name);
    else await window.bridgeDesktop.startBot(bot.name);
    await refresh();
  } catch (error) {
    elements.error.textContent = error.message || String(error);
    elements.error.classList.remove("hidden");
  } finally {
    button.disabled = false;
  }
});
elements.workspaceTableBody.addEventListener("click", async (event) => {
  const button = event.target.closest(".managed-space-remove");
  if (!button || !state) return;
  const space = state.setup.managedSpaces[Number(button.dataset.spaceIndex)];
  if (space) await openRemovalDialog("space", space.codexHome);
});
elements.closeRemovalDialog.addEventListener("click", () => elements.removalDialog.close());
elements.cancelRemoval.addEventListener("click", () => elements.removalDialog.close());
elements.removalForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!removalPreview || !elements.removalConfirm.checked) return;
  elements.applyRemoval.disabled = true;
  elements.removalError.classList.add("hidden");
  try {
    await window.bridgeDesktop.applyManagedRemoval({
      kind: removalPreview.kind,
      id: removalPreview.id,
      deleteRuntime: true,
      deleteWorkspaces: elements.removalDeleteWorkspaces.checked,
      deleteCodexHome: removalPreview.kind === "space" && elements.removalDeleteHome.checked,
    });
    elements.removalDialog.close();
    await refresh();
  } catch (error) {
    elements.removalError.textContent = error.message || String(error);
    elements.removalError.classList.remove("hidden");
    elements.applyRemoval.disabled = false;
  }
});
elements.botList.addEventListener("change", async (event) => {
  const toggle = event.target.closest(".managed-bot-autostart");
  if (!toggle || !state) return;
  const bot = state.setup.managedBots[Number(toggle.dataset.managedIndex)];
  if (!bot) return;
  toggle.disabled = true;
  elements.error.classList.add("hidden");
  try {
    await window.bridgeDesktop.setBotAutoStart({ name: bot.name, enabled: toggle.checked });
    await refresh();
  } catch (error) {
    toggle.checked = !toggle.checked;
    elements.error.textContent = error.message || String(error);
    elements.error.classList.remove("hidden");
  } finally {
    toggle.disabled = false;
  }
});
elements.botReadinessActions.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-readiness-action]");
  const name = elements.botReadinessActions.dataset.botName;
  if (!button || !name) return;
  const action = button.dataset.readinessAction;
  button.disabled = true;
  elements.error.classList.add("hidden");
  try {
    if (action === "copy-permissions") {
      const result = await window.bridgeDesktop.copyPermissionPolicy(name);
      elements.botReadinessActionStatus.textContent = `已复制 ${result.permissionPolicy.totalScopeCount} 项推荐权限 JSON，请在飞书权限管理中使用批量开通。`;
    } else if (action === "open-permissions") {
      await window.bridgeDesktop.openFeishuConsole({ name, section: "permission" });
      elements.botReadinessActionStatus.textContent = "已打开该 Bot 的飞书权限管理。导入刚复制的 JSON，并完成管理员审批与发布。";
    } else if (action === "open-events") {
      await window.bridgeDesktop.openFeishuConsole({ name, section: "event" });
      elements.botReadinessActionStatus.textContent = "已打开该 Bot 的事件配置。Bridge 只需要 im.message.receive_v1。";
    } else if (action === "authorize-user") {
      elements.botReadinessActionStatus.textContent = "正在打开浏览器等待飞书用户授权，请在浏览器中确认。";
      await window.bridgeDesktop.authorizeLarkUser(name);
      renderBotReadiness(await window.bridgeDesktop.checkBotReadiness(name));
    }
  } catch (error) {
    elements.error.textContent = error.message || String(error);
    elements.error.classList.remove("hidden");
  } finally {
    button.disabled = false;
  }
});

elements.createBot.addEventListener("click", () => {
  resetBotDialog();
  const suggested = suggestedBotName();
  document.querySelector("#bot-name").value = suggested;
  document.querySelector("#bot-label").value = `Codex助手${suggested.match(/\d+$/)?.[0] || ""}`.trim();
  elements.botDialog.showModal();
  document.querySelector("#bot-name").focus();
});
elements.createWorkspaceFactory.addEventListener("click", () => {
  elements.workspaceFactoryEditor.classList.toggle("hidden");
  if (!elements.workspaceFactoryEditor.classList.contains("hidden")) {
    elements.workspaceFactoryEditor.scrollIntoView({ behavior: "smooth", block: "start" });
  }
});
elements.workspaceFactoryForm.addEventListener("input", () => {
  elements.workspaceFactoryQueueButton.disabled = true;
  elements.workspaceFactoryPreview.classList.add("hidden");
  renderWorkspaceAgentsPaths();
});
elements.workspaceFactoryPreviewButton.addEventListener("click", async () => {
  if (!elements.workspaceFactoryForm.reportValidity()) return;
  elements.workspaceFactoryPreviewButton.disabled = true;
  elements.error.classList.add("hidden");
  try {
    const result = await window.bridgeDesktop.previewWorkspaceFactory(workspaceFactoryInput());
    const conflicts = result.bots.filter((bot) => bot.conflicts.length);
    const agents = result.factory.initializeAgents
      ? `<div class="path-summary"><span>AGENTS.md 来源</span><code>${escapeHtml(result.factory.agentsSource)}</code><span>目标</span><code>${escapeHtml(result.factory.agentsTarget)}</code></div>`
      : '<span>不初始化空间 AGENTS.md</span>';
    elements.workspaceFactoryPreview.innerHTML = `<strong>${result.bots.length} 个 Bot · 共享 Codex Home</strong><span>${escapeHtml(result.factory.codexHome)}</span>${agents}<div class="factory-preview-list">${result.bots.map((bot) => `<div><span>${escapeHtml(bot.label)}</span><code>${escapeHtml(bot.name)}</code><small>${escapeHtml(bot.conflicts.join("；") || "可创建")}</small></div>`).join("")}</div>`;
    elements.workspaceFactoryPreview.className = `operation-result ${conflicts.length ? "bad" : "good"}`;
    elements.workspaceFactoryQueueButton.disabled = conflicts.length > 0;
  } catch (error) {
    elements.workspaceFactoryPreview.innerHTML = `<strong>预览失败</strong><span>${escapeHtml(error.message || String(error))}</span>`;
    elements.workspaceFactoryPreview.className = "operation-result bad";
    elements.workspaceFactoryQueueButton.disabled = true;
  } finally {
    elements.workspaceFactoryPreviewButton.disabled = false;
  }
});
elements.workspaceFactoryForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (elements.workspaceFactoryQueueButton.disabled || !elements.workspaceFactoryForm.reportValidity()) return;
  elements.workspaceFactoryQueueButton.disabled = true;
  try {
    await window.bridgeDesktop.createWorkspaceFactoryQueue(workspaceFactoryInput());
    elements.workspaceFactoryEditor.classList.add("hidden");
    await refresh();
    elements.workspaceFactoryQueueSection.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    elements.workspaceFactoryPreview.innerHTML = `<strong>队列创建失败</strong><span>${escapeHtml(error.message || String(error))}</span>`;
    elements.workspaceFactoryPreview.className = "operation-result bad";
  }
});
elements.workspaceFactoryQueue.addEventListener("click", async (event) => {
  const button = event.target.closest(".factory-register-bot");
  if (!button) return;
  button.disabled = true;
  elements.workspaceFactoryQr.classList.remove("hidden");
  elements.workspaceFactoryQrImage.classList.add("hidden");
  elements.workspaceFactoryQrMessage.textContent = "正在请求飞书注册二维码";
  try {
    await window.bridgeDesktop.registerWorkspaceFactoryBot({ name: button.dataset.name });
    elements.workspaceFactoryQr.classList.add("hidden");
    await refresh();
  } catch (error) {
    elements.workspaceFactoryQrMessage.textContent = error.message || String(error);
    await refresh();
  }
});
elements.workspaceFactoryCancel.addEventListener("click", () => window.bridgeDesktop.cancelRegistration());
elements.botForm.addEventListener("submit", (event) => event.preventDefault());
elements.botDialog.addEventListener("cancel", (event) => {
  if (!elements.cancelRegistration.classList.contains("hidden")) event.preventDefault();
});
elements.closeBotDialog.addEventListener("click", () => elements.botDialog.close());
elements.createWithCredentials.addEventListener("click", () => finishBotCreation(async () => {
  await validateBotDraft();
  const appId = text(document.querySelector("#bot-app-id").value, "");
  const appSecret = text(document.querySelector("#bot-app-secret").value, "");
  await window.bridgeDesktop.createBot({ bot: botInput(), credentials: { appId, appSecret } });
}));
elements.createWithQr.addEventListener("click", () => finishBotCreation(async () => {
  await validateBotDraft();
  elements.qrPanel.classList.remove("hidden");
  elements.cancelRegistration.classList.remove("hidden");
  elements.registrationMessage.textContent = "正在请求二维码";
  await window.bridgeDesktop.registerBotWithQr(botInput());
}));
elements.cancelRegistration.addEventListener("click", () => window.bridgeDesktop.cancelRegistration());
elements.testProvider.addEventListener("click", () => {
  elements.botFormError.classList.add("hidden");
  testProviderDraft().catch(showBotFormError);
});
elements.providerMode.addEventListener("change", () => {
  updateBotProviderMode();
});
elements.botConfigurationTarget.addEventListener("change", () => updateBotConfigurationTarget(true));
elements.botSpaceTarget.addEventListener("change", () => updateBotConfigurationTarget(true));
elements.customProviderFields.addEventListener("input", () => { elements.providerTestStatus.textContent = ""; });
elements.previewBotPaths.addEventListener("click", async () => {
  elements.previewBotPaths.disabled = true;
  try {
    const preview = await window.bridgeDesktop.previewBot(botInput());
    elements.botPathPreview.innerHTML = detailRows([
      ["工作空间", preview.paths.workspace],
      ["Codex Home", preview.paths.codexHome],
      ["Bot 配置", preview.paths.botConfig],
      ["Profile 数据", preview.paths.profileHome],
      ["运行目录", preview.paths.runtimeRoot],
      ["日志目录", preview.paths.logDir],
    ]);
    elements.botPathPreview.classList.remove("hidden");
  } catch (error) {
    showBotFormError(error);
  } finally {
    elements.previewBotPaths.disabled = false;
  }
});
elements.providerAddModels.addEventListener("click", () => {
  runProviderAction(elements.providerAddModels, async () => {
    const result = await window.bridgeDesktop.listProviderModels(addProviderInput());
    showProviderResult("模型拉取成功", providerModelsText(result));
  }).catch(() => {});
});
elements.providerAddProbe.addEventListener("click", () => {
  runProviderAction(elements.providerAddProbe, async () => {
    const result = await window.bridgeDesktop.probeProvider(addProviderInput());
    showProviderResult("模型请求成功", `${result.model} · HTTP ${result.status} · ${result.elapsedMs} ms`);
  }).catch(() => {});
});
elements.providerAddForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const button = event.submitter;
  if (!elements.providerAddForm.reportValidity()) return;
  runProviderAction(button, async () => {
    const result = await window.bridgeDesktop.addGlobalProvider(addProviderInput());
    elements.providerAddForm.reset();
    showProviderResult("Provider 已保存", `${result.provider.id} 的定义已写入全局配置，Key 已写入 Windows 用户环境变量`);
    await refresh();
  }).catch(() => {});
});
elements.providerReplaceModels.addEventListener("click", () => {
  runProviderAction(elements.providerReplaceModels, async () => {
    const result = await window.bridgeDesktop.listProviderModels(replacementProviderInput());
    showProviderResult("模型拉取成功", providerModelsText(result));
  }).catch(() => {});
});
elements.providerReplaceForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const button = event.submitter;
  if (!elements.providerReplaceForm.reportValidity()) return;
  runProviderAction(button, async () => {
    const result = await window.bridgeDesktop.replaceGlobalProviderKey(replacementProviderInput());
    elements.providerReplaceForm.elements.apiKey.value = "";
    showProviderResult("API Key 已替换", `已验证 ${result.modelCount} 个模型，${result.probe.model} 响应耗时 ${result.probe.elapsedMs} ms；新启动的 Bot 将使用新 Key`);
    await refresh();
  }).catch(() => {});
});
elements.providerSyncPreview.addEventListener("click", () => {
  runProviderAction(elements.providerSyncPreview, async () => {
    const result = await window.bridgeDesktop.previewProviderSync();
    const detail = `${result.targetCount} 个目标；待新增 ${result.addCount} 项，待更新 ${result.updateCount} 项${result.skippedProviderCount ? `，跳过 ${result.skippedProviderCount} 个含内联敏感字段的 Provider` : ""}`;
    showProviderResult("同步预览", detail, result.skippedProviderCount ? "warn" : "good");
    elements.providerSyncApply.classList.toggle("hidden", result.addCount + result.updateCount === 0);
  }).catch(() => {});
});
elements.providerSyncApply.addEventListener("click", () => {
  runProviderAction(elements.providerSyncApply, async () => {
    const result = await window.bridgeDesktop.applyProviderSync();
    showProviderResult("同步完成", `已写入 ${result.writtenCount} 个客户端隔离 Codex Home；现有 Bridge 和旧 Bot 未修改`);
    elements.providerSyncApply.classList.add("hidden");
    await refresh();
  }).catch(() => {});
});
elements.launchAtLoginSetting.addEventListener("change", async () => {
  elements.launchAtLoginSetting.disabled = true;
  try {
    await window.bridgeDesktop.setSettings({ launchAtLogin: elements.launchAtLoginSetting.checked });
    await refresh();
  } catch (error) {
    elements.error.textContent = error.message || String(error);
    elements.error.classList.remove("hidden");
    await refresh();
  }
});
elements.closeToTraySetting.addEventListener("change", async () => {
  elements.closeToTraySetting.disabled = true;
  try {
    await window.bridgeDesktop.setSettings({ closeToTray: elements.closeToTraySetting.checked });
    await refresh();
  } catch (error) {
    elements.error.textContent = error.message || String(error);
    elements.error.classList.remove("hidden");
    await refresh();
  }
});
window.bridgeDesktop.onRegistrationProgress((progress) => {
  elements.qrPanel.classList.remove("hidden");
  elements.registrationMessage.textContent = text(progress.message, "正在处理");
  if (progress.qrDataUrl) {
    elements.registrationQr.src = progress.qrDataUrl;
    elements.registrationQr.classList.remove("hidden");
  }
});
window.bridgeDesktop.onFactoryRegistrationProgress((progress) => {
  elements.workspaceFactoryQr.classList.remove("hidden");
  elements.workspaceFactoryQrMessage.textContent = `${text(progress.botLabel, progress.botName)} · ${text(progress.message, "正在处理")}`;
  if (progress.qrDataUrl) {
    elements.workspaceFactoryQrImage.src = progress.qrDataUrl;
    elements.workspaceFactoryQrImage.classList.remove("hidden");
  }
});
window.bridgeDesktop.onUpdateState((update) => {
  if (state) state.update = update;
  renderUpdater(update);
});
elements.migrationTarget.addEventListener("change", () => {
  const option = elements.migrationTarget.selectedOptions[0];
  if (!option?.value) {
    elements.migrationTargetDetail.classList.add("hidden");
    return;
  }
  elements.migrationTargetDetail.innerHTML = `<strong>目标 Codex Home</strong><code>${escapeHtml(option.dataset.codexHome)}</code><span>影响 Bot：${escapeHtml(option.dataset.botNames)}</span>`;
  elements.migrationTargetDetail.classList.remove("hidden");
  elements.migrationPreview.classList.add("hidden");
});
elements.previewMigration.addEventListener("click", async () => {
  const name = elements.migrationTarget.value;
  if (!name) {
    elements.error.textContent = "请先选择一个使用隔离 Codex Home 的 Bot";
    elements.error.classList.remove("hidden");
    return;
  }
  elements.previewMigration.disabled = true;
  elements.error.classList.add("hidden");
  try {
    const result = await window.bridgeDesktop.previewCapabilityMigration({ name, selection: capabilitySelection() });
    const details = migrationStatusText([...result.mcpServers, ...result.skills]);
    const items = [...result.mcpServers, ...result.skills];
    elements.migrationPreview.innerHTML = `<div class="migration-preview-content"><strong>${result.summary.ready} 项可以迁移 · 影响 ${result.affectedBots.length} 个 Bot</strong><span>${escapeHtml(details || "没有冲突或敏感字段")}</span>${pathLine("MCP 源配置", result.source.configPath)}${pathLine("Skills 源目录", result.source.skillsRoot)}${pathLine("目标配置", result.target.configPath)}${pathLine("目标 Skills", result.target.skillsRoot)}<div class="migration-item-paths">${items.map((item) => `<div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.status)}</span><code>${escapeHtml(item.sourcePath || "-")} → ${escapeHtml(item.targetPath || "-")}</code></div>`).join("")}</div></div><button id="apply-migration-button" class="primary-button" type="button" ${result.summary.ready ? "" : "disabled"}>应用迁移</button>`;
    elements.migrationPreview.classList.remove("hidden");
  } catch (error) {
    elements.error.textContent = error.message || String(error);
    elements.error.classList.remove("hidden");
  } finally {
    elements.previewMigration.disabled = false;
  }
});
elements.migrationPreview.addEventListener("click", async (event) => {
  const button = event.target.closest("#apply-migration-button");
  if (!button) return;
  button.disabled = true;
  try {
    const result = await window.bridgeDesktop.applyCapabilityMigration({
      name: elements.migrationTarget.value,
      selection: capabilitySelection(),
    });
    elements.migrationPreview.innerHTML = `<div><strong>已迁移 ${result.applied} 项</strong><span>目标 Codex Home：${escapeHtml(result.bot.codexHome)}</span></div>`;
  } catch (error) {
    elements.error.textContent = error.message || String(error);
    elements.error.classList.remove("hidden");
    button.disabled = false;
  }
});

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item === button));
    document.querySelectorAll(".view").forEach((view) => view.classList.add("hidden"));
    document.querySelector(`#${button.dataset.view}-view`).classList.remove("hidden");
    document.querySelector("#view-title").textContent = ({ overview: "运行总览", bots: "Bot", workspaces: "工作空间", providers: "Provider 中心", capabilities: "MCP / Skills", system: "系统" })[button.dataset.view];
  });
});

refresh();
