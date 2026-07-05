const state = {
  timer: null,
  data: null,
  selectedRestartBots: new Set(),
  openBotDetails: new Set(),
  activePanel: "overview",
  sidebarCollapsed: localStorage.getItem("codexBridgeSidebarCollapsed") === "1",
  doctor: null,
  doctorLoading: false,
  doctorLoaded: false,
  factorySources: null,
  selectedFactoryJobName: "",
  factoryPollingTimer: null,
  factoryNextAction: null,
  cleanupPlan: null,
  cleanupLoading: false,
};

const $ = (id) => document.getElementById(id);

function cssEscape(value) {
  if (window.CSS?.escape) return CSS.escape(value);
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function statusBadge(kind, text) {
  return `<span class="status ${kind}">${escapeHtml(text)}</span>`;
}

function mono(value) {
  return `<span class="mono">${escapeHtml(value || "-")}</span>`;
}

function providerCell(value, extraClass = "") {
  const text = String(value || "-");
  return `<span class="provider-cell ${extraClass}" title="${escapeHtml(text)}">${escapeHtml(text)}</span>`;
}

function providerMonoCell(value, extraClass = "") {
  const text = String(value || "-");
  return `<span class="provider-cell mono ${extraClass}" title="${escapeHtml(text)}">${escapeHtml(text)}</span>`;
}

function pathRow(label, value) {
  return `
    <div class="path-label">${escapeHtml(label)}</div>
    <div class="path-value mono">${escapeHtml(value || "-")}</div>
  `;
}

function eventCard(title, event) {
  if (!event) {
    return `
      <div class="event-card">
        <strong>${escapeHtml(title)}</strong>
        <div class="muted">无记录</div>
      </div>
    `;
  }
  const payload = event.payload || {};
  const extras = [];
  if (payload.reason) extras.push(`reason: ${payload.reason}`);
  if (payload.checked !== undefined) extras.push(`checked: ${payload.checked}`);
  if (payload.changed !== undefined) extras.push(`changed: ${payload.changed}`);
  if (payload.sessionIndexChanged !== undefined) extras.push(`sessionIndexChanged: ${payload.sessionIndexChanged}`);
  if (payload.globalStateChanged !== undefined) extras.push(`globalStateChanged: ${payload.globalStateChanged}`);
  if (payload.threadId) extras.push(`threadId: ${payload.threadId}`);
  return `
    <div class="event-card">
      <strong>${escapeHtml(title)}</strong>
      <div>${escapeHtml(formatDate(event.at))}</div>
      <div class="mono">${escapeHtml(extras.join("；") || event.line || "-")}</div>
    </div>
  `;
}

function fileBadge(file) {
  if (!file) return statusBadge("warn", "无数据");
  return file.exists ? statusBadge("good", "存在") : statusBadge("warn", "缺失");
}

function renderSummary(data) {
  const summary = data.summary || {};
  $("onlineBots").textContent = `${summary.onlineBots ?? "-"} / ${summary.totalBots ?? "-"}`;
  $("botTotal").textContent = `离线 ${summary.offlineBots ?? "-"} 个`;
  $("activeRuns").textContent = String(summary.activeRuns ?? "-");
  $("watchdogIssues").textContent = String(summary.unhealthyWatchdogs ?? "-");
  $("proxyCount").textContent = `${summary.proxiesOnline ?? "-"} / ${summary.totalProxies ?? "-"}`;
  $("lastUpdated").textContent = `刷新时间：${formatDate(data.generatedAt)}`;
  const botCount = summary.totalBots ?? (data.instances || []).length;
  for (const item of document.querySelectorAll("[data-bot-count]")) {
    item.textContent = String(botCount || "-");
  }
}

function renderBotCards(data) {
  const rows = data.instances || [];
  $("botCards").innerHTML = rows.map(renderBotCard).join("");
  restoreBotDetailState();
}

function renderBotCard(item) {
  const online = item.online ? statusBadge("good", "在线") : statusBadge("bad", "离线");
  const task =
    item.activeRunCount > 0
      ? statusBadge("warn", `${item.activeRunCount} 个任务`)
      : statusBadge("good", "空闲");
  const watchdog = item.watchdog?.healthy ? statusBadge("good", "watchdog healthy") : statusBadge("warn", "watchdog 需检查");
  const sidebar = statusBadge(item.sidebar?.level || "info", `侧边栏索引：${item.sidebar?.status || "-"}`);
  const taskState = statusBadge(item.task?.state === "Ready" ? "good" : "info", `计划任务：${item.task?.state || "-"}`);
  const paths = item.paths || {};
  const sidebarFiles = item.sidebar?.files || {};

  return `
    <article class="bot-card">
      <div class="bot-head">
        <div class="bot-title">
          <h3>${escapeHtml(item.label)}</h3>
          ${mono(item.name)}
          <div class="badge-row">${online}${task}${watchdog}${sidebar}</div>
        </div>
        <div class="mono">PID ${escapeHtml(item.pid || "-")}</div>
      </div>

      <div class="bot-facts">
        <div class="fact">
          <div class="fact-label">Bridge 启动时间</div>
          <div class="fact-value">${escapeHtml(formatDate(item.processStartTime))}</div>
        </div>
        <div class="fact">
          <div class="fact-label">最近运行 Provider / Model</div>
          <div class="fact-value">${escapeHtml(item.lastRun?.provider || "-")} / ${escapeHtml(item.lastRun?.model || "-")}</div>
          <div class="muted">${escapeHtml([item.lastRun?.reasoning, item.lastRun?.serviceTier].filter(Boolean).join(" / ") || "-")}</div>
          <div class="muted">时间：${escapeHtml(formatDate(item.lastRun?.at))}</div>
        </div>
        <div class="fact">
          <div class="fact-label">当前任务</div>
          <div class="fact-value">${escapeHtml(item.activeRunCount > 0 ? "当前不建议重启" : "可安全观察")}</div>
          <div class="muted">active run：${escapeHtml(item.activeRunCount)}</div>
        </div>
      </div>

      <div class="sidebar-box">
        <div class="badge-row">${taskState}${fileBadge(sidebarFiles.stateDb)}${fileBadge(sidebarFiles.sessionIndex)}${fileBadge(sidebarFiles.sessionsDir)}</div>
        <p>Codex Desktop 侧边栏可见 Home：${mono(item.sidebar?.visibleCodexHome || paths.visibleCodexHome || "-")}</p>
        <p>${escapeHtml(item.sidebar?.note || "")}</p>
        <div class="sidebar-events">
          ${eventCard("注册 thread", item.sidebar?.registered)}
          ${eventCard("同步索引", item.sidebar?.synced)}
          ${eventCard("索引校验", item.sidebar?.reconciled)}
        </div>
      </div>

      <details data-bot-details="${escapeHtml(item.name)}" ${state.openBotDetails.has(item.name) ? "open" : ""}>
        <summary>路径与索引详情</summary>
        <div class="path-grid">
          ${pathRow("Runtime Root", paths.runtimeRoot)}
          ${pathRow("State Dir", paths.stateDir)}
          ${pathRow("Log Dir", paths.logDir)}
          ${pathRow("bridge.pid", paths.bridgePidFile)}
          ${pathRow("bridge.lock.json", paths.bridgeLockFile)}
          ${pathRow("launch-config.json", paths.launchConfigFile)}
          ${pathRow("active-runs.json", paths.activeRunsFile)}
          ${pathRow("sessions.json", paths.sessionsFile)}
          ${pathRow("watchdog.log", paths.watchdogLogFile)}
          ${pathRow("Bridge 日志", paths.bridgeLogFile)}
          ${pathRow("stdout 日志", paths.stdoutLogFile)}
          ${pathRow("stderr 日志", paths.stderrLogFile)}
          ${pathRow("Workspace", paths.workspace || item.workspace)}
          ${pathRow("Codex Home", paths.codexHome || item.codexHome)}
          ${pathRow("Desktop Codex Home", paths.desktopCodexHome || "未配置，使用 Codex Home")}
          ${pathRow("config.toml", paths.codexConfigFile)}
          ${pathRow("state_5.sqlite", paths.codexStateDbFile)}
          ${pathRow("session_index.jsonl", paths.codexSessionIndexFile)}
          ${pathRow(".codex-global-state.json", paths.codexGlobalStateFile)}
          ${pathRow("sessions 目录", paths.codexSessionsDir)}
          ${pathRow("启动脚本", paths.startScript)}
          ${pathRow("停止脚本", paths.stopScript)}
          ${pathRow("watchdog 脚本", paths.watchdogScript)}
          ${pathRow("watchdog 安装脚本", paths.watchdogInstallScript)}
          ${pathRow("watchdog 计划任务", paths.watchdogTaskName)}
        </div>
      </details>
    </article>
  `;
}

function renderProxies(data) {
  const proxies = data.proxies || [];
  $("proxyList").innerHTML = proxies
    .map((proxy) => {
      const badge = proxy.online ? statusBadge("good", "监听中") : statusBadge("bad", "未监听");
      return `
        <div class="proxy-card">
          <div class="line">
            <strong>${escapeHtml(proxy.label)}</strong>
            ${badge}
          </div>
          <div>${mono(proxy.url)}</div>
          <p>${escapeHtml(proxy.note || "")}</p>
          <p>进程 PID：${mono(proxy.owningProcess || "-")}</p>
        </div>
      `;
    })
    .join("");
}

function renderCodexConfig(data) {
  const config = data.codexConfig || {};
  $("codexConfig").innerHTML = `
    <dt>配置文件</dt><dd class="mono">${escapeHtml(config.path || "-")}</dd>
    <dt>全局 provider</dt><dd>${mono(config.provider || "-")}</dd>
    <dt>全局 model</dt><dd>${mono(config.model || "-")}</dd>
    <dt>推理强度</dt><dd>${mono(config.reasoning || "-")}</dd>
    <dt>速度档位</dt><dd>${mono(config.serviceTier || "-")}</dd>
  `;
}

function renderProviders(data) {
  const providers = data.codexConfig?.providers || [];
  $("providerRows").innerHTML = providers
    .map((provider) => {
      const env = provider.envKey
        ? provider.envVisible
          ? statusBadge("good", `${provider.envKey} ${provider.envSource === "user" ? "用户环境可见" : "进程可见"}`)
          : statusBadge("warn", `${provider.envKey} 不可见`)
        : statusBadge("info", "无 env_key");
      return `
        <tr>
          <td>${providerMonoCell(provider.id, "provider-id")}</td>
          <td>${providerCell(provider.name || "-", "provider-name")}</td>
          <td>${providerMonoCell(provider.baseUrl || "-", "provider-url")}</td>
          <td>${providerMonoCell(provider.wireApi || "-", "provider-wire")}</td>
          <td>${env}</td>
        </tr>
      `;
    })
    .join("");
}

function renderManagementPaths(data) {
  const configPath = data.codexConfig?.path || "-";
  const firstInstance = (data.instances || [])[0] || {};
  const paths = firstInstance.paths || {};
  if ($("providerConfigPath")) $("providerConfigPath").textContent = configPath;
  if ($("providerSyncSourcePath")) $("providerSyncSourcePath").textContent = configPath;
  if ($("providerSyncTargetCount")) {
    const globalHome = (data.codexConfig?.path || "").replace(/\\config\.toml$/i, "");
    const targets = new Set(
      (data.instances || [])
        .map((item) => item.codexHome || item.paths?.codexHome || "")
        .filter((item) => item && item.toLowerCase() !== globalHome.toLowerCase()),
    );
    $("providerSyncTargetCount").textContent = `${targets.size} 个独立空间`;
  }
  if ($("restartStartScript")) $("restartStartScript").textContent = paths.startScript || "-";
  if ($("restartStopScript")) $("restartStopScript").textContent = paths.stopScript || "-";
}

function renderRestartList(data) {
  const rows = data.instances || [];
  const knownNames = new Set(rows.map((item) => item.name));
  for (const selected of Array.from(state.selectedRestartBots)) {
    if (!knownNames.has(selected)) state.selectedRestartBots.delete(selected);
  }

  $("restartBotList").innerHTML = rows
    .map((item) => {
      const disabled = item.activeRunCount > 0;
      if (disabled) state.selectedRestartBots.delete(item.name);
      const checked = state.selectedRestartBots.has(item.name) && !disabled ? "checked" : "";
      const disabledAttr = disabled ? "disabled" : "";
      const online = item.online ? "在线" : "离线";
      const active = item.activeRunCount > 0 ? `${item.activeRunCount} 个任务，跳过` : "空闲";
      return `
        <label class="restart-row ${disabled ? "is-disabled" : ""}">
          <input type="checkbox" value="${escapeHtml(item.name)}" ${checked} ${disabledAttr} />
          <span class="restart-main">
            <strong>${escapeHtml(item.label)}</strong>
            <span>${mono(item.name)}</span>
          </span>
          <span class="restart-meta">
            ${statusBadge(item.online ? "good" : "warn", online)}
            ${statusBadge(disabled ? "warn" : "good", active)}
            <span class="mono">PID ${escapeHtml(item.pid || "-")}</span>
          </span>
        </label>
      `;
    })
    .join("");
}

function renderProblems(data) {
  const problems = [];
  for (const instance of data.instances || []) {
    for (const line of instance.recentProblems || []) {
      problems.push({
        title: `${instance.label} / ${instance.name}`,
        line,
      });
    }
  }

  if (!data.diagnostics?.systemSnapshotOk) {
    problems.unshift({
      title: "系统状态快照失败",
      line: data.diagnostics?.systemSnapshotError || "PowerShell snapshot failed",
    });
  }

  if (problems.length === 0) {
    $("problemList").innerHTML = `<div class="empty">最近日志没有发现 WARN / ERROR / 失败 / 502 等问题关键词。</div>`;
    return;
  }

  $("problemList").innerHTML = problems
    .slice(-20)
    .reverse()
    .map(
      (item) => `
        <article class="problem">
          <div class="problem-title">${escapeHtml(item.title)}</div>
          <pre class="mono">${escapeHtml(item.line)}</pre>
        </article>
      `,
    )
    .join("");
}

function renderConfigSource(data) {
  const source = data.configSource || {};
  const config = data.instancesConfig || {};
  if (source.fallback) {
    const message = source.exists
      ? `集中配置读取失败，当前使用内置兼容配置：${source.error || "-"}`
      : "未找到 bridge.instances.json，当前使用内置兼容配置。";
    if ($("doctorNotice")) {
      setActionResult("doctorNotice", "warn", `<strong>集中配置未生效</strong><div>${escapeHtml(message)}</div>`);
    }
    return;
  }
  if ($("doctorNotice") && !state.doctor) {
    setActionResult(
      "doctorNotice",
      "good",
      `<strong>集中配置已生效</strong><div>面板正在读取 ${mono(source.path || "-")}。</div><div>当前实例 ${escapeHtml(config.instanceCount || "-")} 个，代理 ${escapeHtml(config.proxyCount || "-")} 个。</div>`,
    );
  }
}

function doctorBadge(status) {
  const kind = status === "ok" ? "good" : status === "bad" ? "bad" : "warn";
  return statusBadge(kind, status.toUpperCase());
}

function renderDoctor(report) {
  state.doctor = report;
  state.doctorLoaded = true;
  const summary = report?.summary || {};
  $("doctorTotalChecks").textContent = String(summary.totalChecks ?? "-");
  $("doctorOk").textContent = String(summary.ok ?? "-");
  $("doctorWarn").textContent = String(summary.warn ?? "-");
  $("doctorBad").textContent = String(summary.bad ?? "-");
  $("doctorConfigPath").textContent = report?.configPath || "-";
  $("doctorScriptPath").textContent = report?.script || "-";
  $("doctorSourceRoot").textContent = report?.sourceRoot || "-";
  $("doctorRuntimeRoot").textContent = report?.runtimeRoot || "-";

  const noticeKind = summary.bad > 0 ? "bad" : summary.warn > 0 ? "warn" : "good";
  const noticeTitle = summary.bad > 0 ? "自检发现需要处理的问题" : summary.warn > 0 ? "自检发现需要关注的提示" : "自检通过";
  setActionResult(
    "doctorNotice",
    noticeKind,
    `
      <strong>${escapeHtml(noticeTitle)}</strong>
      <div>生成时间：${escapeHtml(formatDate(report?.generatedAt))}</div>
      <div>Bot：${escapeHtml(summary.onlineBots ?? "-")} / ${escapeHtml(summary.totalBots ?? "-")} 在线；active run：${escapeHtml(summary.activeRuns ?? "-")}；本地代理：${escapeHtml(summary.proxiesOnline ?? "-")} / ${escapeHtml(summary.totalProxies ?? "-")} 在线。</div>
    `,
  );

  const groups = new Map();
  for (const check of report?.checks || []) {
    const group = check.group || "其他";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(check);
  }

  $("doctorGroups").innerHTML = Array.from(groups.entries())
    .map(([group, checks]) => {
      const bad = checks.filter((item) => item.status === "bad").length;
      const warn = checks.filter((item) => item.status === "warn").length;
      const ok = checks.filter((item) => item.status === "ok").length;
      return `
        <article class="doctor-group">
          <div class="doctor-group-head">
            <h3>${escapeHtml(group)}</h3>
            <div class="badge-row">
              ${statusBadge("good", `OK ${ok}`)}
              ${warn ? statusBadge("warn", `WARN ${warn}`) : ""}
              ${bad ? statusBadge("bad", `BAD ${bad}`) : ""}
            </div>
          </div>
          <div class="doctor-checks">
            ${checks.map(renderDoctorCheck).join("")}
          </div>
        </article>
      `;
    })
    .join("");
}

function renderDoctorCheck(check) {
  return `
    <div class="doctor-check ${escapeHtml(check.status || "info")}">
      <div class="doctor-check-main">
        ${doctorBadge(check.status || "warn")}
        <strong>${escapeHtml(check.name || "-")}</strong>
        <span>${escapeHtml(check.message || "")}</span>
      </div>
      ${check.path ? `<div class="doctor-path mono">${escapeHtml(check.path)}</div>` : ""}
      ${check.impact ? `<div class="doctor-help"><strong>影响：</strong>${escapeHtml(check.impact)}</div>` : ""}
      ${check.nextStep ? `<div class="doctor-help"><strong>建议：</strong>${escapeHtml(check.nextStep)}</div>` : ""}
    </div>
  `;
}

async function refreshDoctor(force = false) {
  if (state.doctorLoading) return;
  if (!force && state.doctorLoaded) return;
  state.doctorLoading = true;
  $("doctorRefreshButton").disabled = true;
  $("doctorRefreshButton").textContent = "自检中";
  setActionResult("doctorNotice", "info", "正在运行只读自检，请稍等。");
  try {
    const response = await fetch("/api/doctor", { cache: "no-store" });
    const report = await response.json().catch(() => ({}));
    if (!response.ok || report.ok === false) {
      throw new Error(report.error || `HTTP ${response.status}`);
    }
    renderDoctor(report);
  } catch (error) {
    setActionResult("doctorNotice", "bad", `<strong>自检失败</strong><pre class="mono">${escapeHtml(error.message || String(error))}</pre>`);
  } finally {
    state.doctorLoading = false;
    $("doctorRefreshButton").disabled = false;
    $("doctorRefreshButton").textContent = "运行自检";
  }
}

function render(data) {
  state.data = data;
  renderSummary(data);
  renderBotCards(data);
  renderProxies(data);
  renderCodexConfig(data);
  renderProviders(data);
  renderManagementPaths(data);
  renderRestartList(data);
  renderProblems(data);
  renderConfigSource(data);
  if (state.cleanupPlan) renderCleanupPlan(state.cleanupPlan);
  showPanel(state.activePanel, { updateHash: false, scrollToTop: false });
}

function providerFormData() {
  const form = $("providerForm");
  return {
    id: form.elements.id.value.trim(),
    name: form.elements.name.value.trim(),
    baseUrl: form.elements.baseUrl.value.trim(),
    envKey: form.elements.envKey.value.trim(),
    apiKey: form.elements.apiKey.value.trim(),
    model: form.elements.model.value.trim(),
    confirm: form.elements.confirm.value.trim(),
    wireApi: "responses",
  };
}

function factoryFormData() {
  const form = $("factoryForm");
  return {
    spaceName: form.elements.spaceName.value.trim(),
    slug: form.elements.slug.value.trim(),
    count: form.elements.count.value.trim(),
    baseIndex: form.elements.baseIndex.value.trim(),
    displayNamePattern: form.elements.displayNamePattern.value.trim(),
    instanceNamePattern: form.elements.instanceNamePattern.value.trim(),
    baselineProfile: form.elements.baselineProfile.value.trim(),
    brand: form.elements.brand.value.trim(),
    workspaceRoot: form.elements.workspaceRoot.value.trim(),
    codexHomeRoot: form.elements.codexHomeRoot.value.trim(),
    codexHomeName: form.elements.codexHomeName.value.trim(),
    description: form.elements.description.value.trim(),
    avatarUrls: form.elements.avatarUrls.value.trim(),
  };
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

async function postJsonAllowFalse(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

async function getJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

function setActionResult(id, kind, html) {
  const target = $(id);
  target.className = `action-result ${kind || ""}`.trim();
  target.innerHTML = html;
}

function renderProviderModels(models) {
  if (!models?.length) return `<div class="muted">没有返回模型。</div>`;
  return `
    <div class="result-list">
      ${models
        .slice(0, 80)
        .map(
          (model) => `
            <div class="result-row">
              ${mono(model.id)}
              <span>${escapeHtml(model.ownedBy ? `owned_by ${model.ownedBy}` : model.object || "")}</span>
            </div>
          `,
        )
        .join("")}
    </div>
    ${models.length > 80 ? `<div class="muted">仅显示前 80 个模型，实际共 ${escapeHtml(models.length)} 个。</div>` : ""}
  `;
}

function setButtonsDisabled(ids, disabled) {
  for (const id of ids) {
    const button = $(id);
    if (button) button.disabled = disabled;
  }
}

function conflictBadges(conflicts) {
  const entries = Object.entries(conflicts || {});
  if (!entries.length) return statusBadge("good", "无冲突");
  return entries
    .map(([key, value]) => statusBadge(value ? "warn" : "good", `${key}: ${value ? "已存在" : "可用"}`))
    .join("");
}

function renderFactoryPreview(data) {
  const instances = data.instances || [];
  const paths = data.paths || {};
  const appendPreview = data.bridgeInstancesAppendPreview || [];
  $("factoryPreviewResult").innerHTML = `
    <section class="section nested-section">
      <div class="section-head">
        <div>
          <h2>创建预览</h2>
          <p>${escapeHtml(data.warning || "")}</p>
        </div>
        ${statusBadge("info", data.mode || "preview-only")}
      </div>
      <div class="path-hint full-paths">
        <span>源码目录</span><code>${escapeHtml(paths.sourceRoot || "-")}</code>
        <span>工作区根目录</span><code>${escapeHtml(paths.workspaceRoot || "-")}</code>
        <span>垂类 Codex Home</span><code>${escapeHtml(paths.spaceCodexHome || "-")}</code>
        <span>桌面端镜像 Codex Home</span><code>${escapeHtml(paths.desktopCodexHome || "-")}</code>
        <span>集中实例配置</span><code>${escapeHtml(paths.bridgeInstancesJson || "-")}</code>
        <span>注册脚本</span><code>${escapeHtml(paths.registerScript || "-")}</code>
        <span>启动脚本</span><code>${escapeHtml(paths.startScript || "-")}</code>
        <span>Watchdog 安装脚本</span><code>${escapeHtml(paths.installWatchdogScript || "-")}</code>
      </div>
      <div class="factory-bot-list">
        ${instances
          .map(
            (item) => `
              <article class="factory-bot-card">
                <div class="factory-bot-head">
                  <div>
                    <h3>${escapeHtml(item.label)}</h3>
                    ${mono(item.name)}
                  </div>
                  <div class="badge-row">${conflictBadges(item.conflicts)}</div>
                </div>
                <div class="path-grid">
                  ${pathRow("workspace", item.workspace)}
                  ${pathRow("codexHome", item.codexHome)}
                  ${pathRow("desktopCodexHome", item.desktopCodexHome)}
                  ${pathRow("runtimeRoot", item.runtimeRoot)}
                  ${pathRow("larkProfile", item.larkProfile)}
                  ${pathRow("watchdog task", item.taskName)}
                </div>
                <details>
                  <summary>查看后续将执行的命令草稿</summary>
                  <div class="command-list">
                    <div><strong>注册飞书 APP + profile + watchdog</strong><pre class="mono">${escapeHtml(item.commands?.registerAndInstall || "-")}</pre></div>
                    <div><strong>启动 Bridge</strong><pre class="mono">${escapeHtml(item.commands?.startBridge || "-")}</pre></div>
                    <div><strong>安装 Watchdog</strong><pre class="mono">${escapeHtml(item.commands?.installWatchdog || "-")}</pre></div>
                  </div>
                </details>
              </article>
            `,
          )
          .join("")}
      </div>
      <details class="append-preview">
        <summary>查看将来需要追加到 bridge.instances.json 的片段</summary>
        <pre class="mono">${escapeHtml(JSON.stringify(appendPreview, null, 2))}</pre>
      </details>
    </section>
  `;
}

async function previewFactory() {
  setButtonsDisabled(["previewFactoryButton", "readScopesButton"], true);
  setActionResult("factoryActionResult", "info", "正在生成垂类 Bot 创建预览，不会写入任何文件。");
  try {
    const data = await postJson("/api/factory/preview", factoryFormData());
    setActionResult(
      "factoryActionResult",
      "good",
      `<strong>预览已生成。</strong><div>共规划 ${escapeHtml(data.instances?.length || 0)} 个 Bot。当前没有创建飞书 APP、没有授权、没有写配置、没有重启。</div>`,
    );
    renderFactoryPreview(data);
  } catch (error) {
    setActionResult("factoryActionResult", "bad", `<strong>预览失败</strong><pre class="mono">${escapeHtml(error.message)}</pre>`);
  } finally {
    setButtonsDisabled(["previewFactoryButton", "readScopesButton"], false);
  }
}

function renderScopesBaseline(data) {
  if (!data.ok) {
    setActionResult(
      "factoryScopesResult",
      "warn",
      `<strong>权限基准读取失败</strong><div>profile：${mono(data.profile || "-")}</div><pre class="mono">${escapeHtml(data.error || data.stderr || "-")}</pre>`,
    );
    return;
  }
  const scopes = data.scopes || [];
  setActionResult(
    "factoryScopesResult",
    "good",
    `
      <strong>权限基准读取成功。</strong>
      <div>profile：${mono(data.profile)}</div>
      <div>appId：${mono(data.appId || "-")}</div>
      <div>brand：${mono(data.brand || "-")}；tokenType：${mono(data.tokenType || "-")}；scope 数量：${escapeHtml(data.count ?? scopes.length)}</div>
      <div class="result-subtitle">Scopes</div>
      <div class="scope-list">
        ${scopes.map((scope) => `<span class="scope-pill">${escapeHtml(scope)}</span>`).join("")}
      </div>
    `,
  );
}

async function readFactoryScopesBaseline() {
  setButtonsDisabled(["previewFactoryButton", "readScopesButton"], true);
  setActionResult("factoryScopesResult", "info", "正在只读读取 lark-cli profile 的 scopes。");
  try {
    const data = await postJson("/api/factory/scopes-baseline", {
      profile: factoryFormData().baselineProfile,
    });
    renderScopesBaseline(data);
  } catch (error) {
    setActionResult("factoryScopesResult", "bad", `<strong>读取失败</strong><pre class="mono">${escapeHtml(error.message)}</pre>`);
  } finally {
    setButtonsDisabled(["previewFactoryButton", "readScopesButton"], false);
  }
}

function renderFactorySources(data) {
  state.factorySources = data;
  const skills = data.skills || [];
  const mcpServers = data.mcpServers || [];
  $("factorySkillList").innerHTML = skills.length
    ? skills
      .map((skill) => `
        <label class="check-row">
          <input type="checkbox" name="factorySkill" value="${escapeHtml(skill.id)}" />
          <span>${mono(skill.id)}<small>${escapeHtml(skill.sourcePath || "")}</small></span>
        </label>
      `)
      .join("")
    : `<div class="empty small-empty">没有读取到 skills。</div>`;
  $("factoryMcpList").innerHTML = mcpServers.length
    ? mcpServers
      .map((id) => `
        <label class="check-row">
          <input type="checkbox" name="factoryMcp" value="${escapeHtml(id)}" />
          <span>${mono(id)}</span>
        </label>
      `)
      .join("")
    : `<div class="empty small-empty">没有读取到 MCP 配置。</div>`;
}

function selectedFactoryValues(name) {
  return Array.from(document.querySelectorAll(`input[name="${cssEscape(name)}"]:checked`)).map((item) => item.value);
}

async function loadFactorySources() {
  setButtonsDisabled(["loadFactorySourcesButton", "prepareFactoryLocalButton"], true);
  setActionResult("factoryPrepareResult", "info", "正在读取全局 Codex Home 中可迁移的 skills 和 MCP 配置。");
  try {
    const data = await getJson("/api/factory/sources");
    renderFactorySources(data);
    setActionResult(
      "factoryPrepareResult",
      "good",
      `<strong>可迁移项已刷新。</strong><div>skills：${escapeHtml(data.skills?.length || 0)} 个；MCP：${escapeHtml(data.mcpServers?.length || 0)} 个。</div><div>来源：${mono(data.codexHome || "-")}</div>`,
    );
  } catch (error) {
    setActionResult("factoryPrepareResult", "bad", `<strong>读取失败</strong><pre class="mono">${escapeHtml(error.message)}</pre>`);
  } finally {
    setButtonsDisabled(["loadFactorySourcesButton", "prepareFactoryLocalButton"], false);
  }
}

function renderPrepareOperations(operations) {
  if (!operations?.length) return `<div class="muted">没有操作记录。</div>`;
  return `
    <div class="result-list">
      ${operations
        .map((item) => `
          <div class="result-row">
            ${statusBadge(item.action === "skip" ? "warn" : "good", item.action)}
            ${item.source ? `<span class="mono">${escapeHtml(item.source)}</span><span>-></span>` : ""}
            <span class="mono">${escapeHtml(item.path || "-")}</span>
            ${item.reason ? `<span>${escapeHtml(item.reason)}</span>` : ""}
            ${item.note ? `<span>${escapeHtml(item.note)}</span>` : ""}
          </div>
        `)
        .join("")}
    </div>
  `;
}

async function prepareFactoryLocalSpace() {
  const payload = {
    ...factoryFormData(),
    selectedSkills: selectedFactoryValues("factorySkill"),
    selectedMcpServers: selectedFactoryValues("factoryMcp"),
    confirm: $("factoryPrepareConfirm").value.trim(),
  };
  if (payload.confirm !== "初始化本地空间") {
    setActionResult("factoryPrepareResult", "warn", "请输入确认文本：初始化本地空间");
    return;
  }

  setButtonsDisabled(["previewFactoryButton", "readScopesButton", "loadFactorySourcesButton", "prepareFactoryLocalButton"], true);
  setActionResult("factoryPrepareResult", "info", "正在初始化本地垂类空间。不会创建飞书 APP，不会启动 Bot。");
  try {
    const data = await postJson("/api/factory/prepare-local", payload);
    setActionResult(
      "factoryPrepareResult",
      "good",
      `
        <strong>本地空间初始化完成。</strong>
        <div>${escapeHtml(data.message || "")}</div>
        <div>Codex Home：${mono(data.codexHome)}</div>
        <div>manifest：${mono(data.manifestPath)}</div>
        <div>config：${mono(data.configPath)}</div>
        ${renderPrepareOperations(data.operations)}
      `,
    );
  } catch (error) {
    setActionResult("factoryPrepareResult", "bad", `<strong>初始化失败</strong><pre class="mono">${escapeHtml(error.message)}</pre>`);
  } finally {
    setButtonsDisabled(["previewFactoryButton", "readScopesButton", "loadFactorySourcesButton", "prepareFactoryLocalButton"], false);
  }
}

function jobStatusBadge(status) {
  const value = status || "pending";
  if (["started", "profile_created", "scopes_checked", "instance_config_written", "watchdog_installed"].includes(value)) {
    return statusBadge("good", value);
  }
  if (["registering", "pending"].includes(value)) return statusBadge("info", value);
  if (value === "failed") return statusBadge("bad", value);
  return statusBadge("warn", value);
}

const factoryStatusLabels = {
  pending: "待创建",
  registering: "创建中",
  profile_created: "已创建 profile",
  scopes_checked: "已复查权限",
  instance_config_written: "已写入实例",
  watchdog_installed: "已安装 watchdog",
  started: "已启动",
  failed: "失败",
};

function factoryJobCounts(jobs) {
  const counts = {};
  for (const job of jobs || []) {
    const status = job.status || "pending";
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

function factoryJobMissingCount(job) {
  return Array.isArray(job?.scopes?.missing) ? job.scopes.missing.length : 0;
}

function factoryJobTitle(job) {
  return job ? `${job.label || job.name} / ${job.name}` : "-";
}

function factoryAuthExpired(job) {
  const expiresAt = Date.parse(job?.auth?.expiresAt || "");
  return Number.isFinite(expiresAt) && Date.now() > expiresAt;
}

function factoryAuthRemainingSeconds(job) {
  const expiresAt = Date.parse(job?.auth?.expiresAt || "");
  if (!Number.isFinite(expiresAt)) return null;
  return Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
}

function getFactoryCurrentTarget(jobs) {
  const list = jobs || [];
  const pendingAuth = list.find((job) => job.auth?.status === "pending");
  if (pendingAuth) {
    if (factoryAuthExpired(pendingAuth)) {
      return {
        kind: "bad",
        label: "补授权二维码已过期",
        job: pendingAuth,
        note: "不要再点“完成补授权”；请重新发起这个 Bot 的补授权，扫码后再完成。",
      };
    }
    return {
      kind: "warn",
      label: "当前正在完成补授权",
      job: pendingAuth,
      note: "这个 Bot 已经发起补授权，当前按钮“完成补授权”和扫码都对应它。",
    };
  }

  const registering = list.find((job) => job.status === "registering");
  if (registering) {
    return {
      kind: "info",
      label: "当前正在创建飞书 APP / profile",
      job: registering,
      note: "请等创建过程结束后再刷新队列。",
    };
  }

  const failed = list.find((job) => job.status === "failed");
  if (failed) {
    return {
      kind: "bad",
      label: "当前需要先处理失败项",
      job: failed,
      note: failed.lastError || "这个 Bot 上一步失败，继续前要先处理失败原因。",
    };
  }

  const needsScopeCheck = list.find((job) => job.status === "profile_created");
  if (needsScopeCheck) {
    return {
      kind: "info",
      label: "下一步应复查权限",
      job: needsScopeCheck,
      note: "这个 Bot 已创建 profile，但还没有和基准 profile 对比 scopes。",
    };
  }

  const missingScopes = list.find((job) => factoryJobMissingCount(job) > 0);
  if (missingScopes) {
    return {
      kind: "warn",
      label: "下一步应发起补授权",
      job: missingScopes,
      note: `当前缺少 ${factoryJobMissingCount(missingScopes)} 个 scopes，先补授权，再完成补授权，再复查权限。`,
    };
  }

  const readyToAppend = list.filter((job) => job.status === "scopes_checked" && factoryJobMissingCount(job) === 0);
  if (readyToAppend.length) {
    return {
      kind: "good",
      label: "已可写入实例配置",
      job: readyToAppend[0],
      note: `已有 ${readyToAppend.length} 个 Bot 权限完整。只想启用这些 Bot 时，不要继续创建 pending 队列项。`,
    };
  }

  const readyWatchdog = list.find((job) => job.status === "instance_config_written");
  if (readyWatchdog) {
    return {
      kind: "info",
      label: "下一步应安装 Watchdog",
      job: readyWatchdog,
      note: "实例配置已写入，接下来安装 watchdog。",
    };
  }

  const readyStart = list.find((job) => job.status === "watchdog_installed");
  if (readyStart) {
    return {
      kind: "info",
      label: "下一步应启动新 Bot",
      job: readyStart,
      note: "watchdog 已安装，接下来启动 Bridge。",
    };
  }

  const started = list.filter((job) => job.status === "started");
  if (started.length) {
    return {
      kind: "good",
      label: "已启动",
      job: started[0],
      note: `已有 ${started.length} 个新 Bot 启动。`,
    };
  }

  const pending = list.find((job) => job.status === "pending");
  if (pending) {
    return {
      kind: "info",
      label: "队列已生成，尚未创建",
      job: pending,
      note: "只有你点击“创建下一个飞书 APP / profile”时，才会继续创建这个 Bot。",
    };
  }

  return null;
}

function getSelectedFactoryJob(jobs) {
  const list = jobs || [];
  if (state.selectedFactoryJobName) {
    const selected = list.find((job) => job.name === state.selectedFactoryJobName);
    if (selected) return selected;
  }
  state.selectedFactoryJobName = "";
  return null;
}

function factoryNextStep(job) {
  if (!job) return { kind: "info", label: "未选择 Bot", note: "请先点击下面某个 Bot 卡片。", action: null };
  if (job.status === "failed") {
    return {
      kind: "bad",
      label: job.appId ? "本地创建中断" : "创建失败，可重试",
      note: job.recoveryHint || "如果飞书侧残留 Bot 已删除，可输入“创建下一个飞书APP”，重新创建当前选中的 Bot。",
      action: job.appId ? null : "register",
    };
  }
  if (factoryCanRegister(job)) return { kind: "info", label: "尚未创建", note: "下一步会创建当前 Bot 的飞书 APP/profile。", action: "register" };
  if (job.auth?.status === "pending" && factoryAuthExpired(job)) return { kind: "bad", label: "补授权二维码已过期", note: "下一步会强制生成新的补授权二维码。", action: "startAuth" };
  if (factoryCanCompleteAuth(job)) return { kind: "warn", label: "等待完成补授权", note: "扫码后点击下一步，写回本地 lark-cli profile。", action: "completeAuth" };
  if (factoryCanStartAuth(job)) return { kind: "warn", label: "缺权限", note: `下一步会生成补授权二维码，补齐 ${factoryJobMissingCount(job)} 个 scopes。`, action: "startAuth" };
  if (factoryCanCheckScopes(job) && !job.scopes?.checkedAt) return { kind: "info", label: "待复查权限", note: "下一步会和权限基准 profile 对比 scopes。", action: "checkScopes" };
  if (factoryCanAppendInstance(job) && job.status === "scopes_checked") return { kind: "good", label: "权限完整，待写入实例", note: "下一步会把当前 Bot 写入 bridge.instances.json。", action: "appendInstances" };
  if (factoryCanInstallWatchdog(job)) return { kind: "info", label: "待安装 watchdog", note: "下一步会安装当前 Bot 的 watchdog。", action: "installWatchdog" };
  if (factoryCanStartBot(job)) return { kind: "info", label: "待启动", note: "下一步会启动当前 Bot 的 Bridge。", action: "startBot" };
  if (job.status === "started") return { kind: "good", label: "已启动", note: "当前 Bot 已启动，可以到飞书里发送 /status 验证。", action: null };
  return { kind: "info", label: job.status || "未知状态", note: job.lastError || "请查看当前 Bot 卡片详情。", action: null };
}

function factoryNextActionMeta(action) {
  const map = {
    register: {
      button: "下一步：创建当前 Bot / profile",
      confirmId: "factoryRegisterConfirm",
      confirmText: "创建下一个飞书APP",
      run: registerNextFactoryJob,
    },
    checkScopes: {
      button: "下一步：复查权限",
      confirmId: "factoryCheckScopesConfirm",
      confirmText: "复查权限",
      run: checkFactoryJobScopesAction,
    },
    startAuth: {
      button: "下一步：生成补授权二维码",
      confirmId: "factoryStartAuthConfirm",
      confirmText: "发起补授权",
      run: startFactoryAuthAction,
    },
    completeAuth: {
      button: "下一步：完成补授权",
      confirmId: "factoryCompleteAuthConfirm",
      confirmText: "完成补授权",
      run: completeFactoryAuthAction,
    },
    appendInstances: {
      button: "下一步：写入实例配置",
      confirmId: "factoryAppendInstancesConfirm",
      confirmText: "写入实例配置",
      run: appendFactoryInstancesAction,
    },
    installWatchdog: {
      button: "下一步：安装 watchdog",
      confirmId: "factoryInstallWatchdogsConfirm",
      confirmText: "安装新watchdog",
      run: installFactoryWatchdogsAction,
    },
    startBot: {
      button: "下一步：启动 Bot",
      confirmId: "factoryStartBotsConfirm",
      confirmText: "启动新Bot",
      run: startFactoryBotsAction,
    },
  };
  return map[action] || null;
}

function updateFactoryNextStepButton(step, selected) {
  const button = $("factoryNextStepButton");
  if (!button) return;
  const meta = factoryNextActionMeta(step?.action);
  state.factoryNextAction = meta && selected ? { ...meta, jobName: selected.name } : null;
  button.disabled = !state.factoryNextAction;
  button.textContent = meta ? meta.button : (selected ? "当前 Bot 暂无可执行下一步" : "请选择 Bot 后执行下一步");
  button.classList.toggle("secondary-button", !state.factoryNextAction);
  button.classList.toggle("danger-button", Boolean(state.factoryNextAction));
}

function renderFactoryCurrentTarget(jobs) {
  const target = $("factoryCurrentTarget");
  if (!target) return;
  const selected = getSelectedFactoryJob(jobs);
  if (!selected) {
    updateFactoryNextStepButton(null, null);
    target.innerHTML = `
      <div class="factory-current-target-head">
        ${statusBadge("info", "未选择 Bot")}
        <strong>请先点击下面某个 Bot 卡片</strong>
      </div>
      <div class="muted">选中后，这里的 1-6 步按钮只会操作当前选中的 Bot。</div>
    `;
    return;
  }
  const step = factoryNextStep(selected);
  updateFactoryNextStepButton(step, selected);
  target.innerHTML = `
    <div class="factory-current-target-head">
      ${statusBadge(step.kind, "当前选中")}
      <strong>${escapeHtml(factoryJobTitle(selected))}</strong>
    </div>
    <div class="factory-current-target-head">
      ${statusBadge(step.kind, step.label)}
      <span class="muted">${escapeHtml(step.note)}</span>
    </div>
    <div class="path-hint full-paths">
      ${pathRow("profile", selected.larkProfile)}
      ${pathRow("workspace", selected.workspace)}
      ${pathRow("codexHome", selected.codexHome)}
    </div>
  `;
}

function renderFactoryProgress(data) {
  const jobs = data.jobs || [];
  const target = $("factoryJobsProgress");
  renderFactoryCurrentTarget(jobs);
  if (!target) return;
  if (!jobs.length) {
    target.innerHTML = `<span class="status info">尚未生成队列</span>`;
    return;
  }
  const counts = factoryJobCounts(jobs);
  const ordered = [
    "pending",
    "profile_created",
    "scopes_checked",
    "instance_config_written",
    "watchdog_installed",
    "started",
    "failed",
  ];
  target.innerHTML = ordered
    .filter((status) => counts[status])
    .map((status) => {
      const kind = status === "failed" ? "bad" : status === "pending" ? "info" : "good";
      return statusBadge(kind, `${factoryStatusLabels[status] || status} ${counts[status]}`);
    })
    .join("");
}

function renderFactoryJobQr(job) {
  if (!job.qrImage) return "";
  const qrVersion = encodeURIComponent(job.updatedAt || job.qrImage || "");
  const src = `/api/factory/jobs/qr?name=${encodeURIComponent(job.name)}&v=${qrVersion}`;
  return `
    <div class="factory-qr-box">
      <div>
        <strong>注册二维码：${escapeHtml(job.label || job.name)}</strong>
        <div class="muted">这是创建飞书 APP/profile 时的二维码；创建完成后保留图片仅作记录。</div>
        <div class="muted">生成/更新时间：${escapeHtml(formatDate(job.updatedAt))}</div>
        <div class="muted">只对应：${escapeHtml(job.name)}</div>
      </div>
      <img class="factory-qr-image" src="${src}" alt="${escapeHtml(job.label || job.name)} 注册二维码" loading="lazy" />
    </div>
  `;
}

function renderFactoryAuthBox(job) {
  const auth = job.auth;
  if (!auth?.status) return "";
  const qrVersion = encodeURIComponent(auth.requestedAt || auth.expiresAt || job.updatedAt || "");
  const remainingSeconds = factoryAuthRemainingSeconds(job);
  const timeHint = auth.status === "pending"
    ? factoryAuthExpired(job)
      ? statusBadge("bad", "二维码已过期，请重新生成")
      : statusBadge("warn", remainingSeconds == null ? "二维码有效中" : `二维码有效中，剩余 ${remainingSeconds} 秒`)
    : statusBadge(auth.status === "completed" ? "good" : "info", auth.status);
  const qr = auth.qrImage
    ? `<img class="factory-qr-image" src="/api/factory/jobs/auth-qr?name=${encodeURIComponent(job.name)}&v=${qrVersion}" alt="${escapeHtml(job.label || job.name)} 补授权二维码" loading="lazy" />`
    : "";
  const kind = auth.status === "completed" ? "good" : auth.status === "failed" ? "bad" : "warn";
  return `
    <div class="factory-qr-box factory-auth-box">
      <div>
        <strong>补授权二维码：${escapeHtml(job.label || job.name)} ${statusBadge(kind, auth.status)}</strong>
        <div class="badge-row">${timeHint}</div>
        <div class="muted">profile：${escapeHtml(auth.profile || job.larkProfile || job.name)}</div>
        <div class="muted">只对应：${escapeHtml(job.name)}</div>
        ${auth.requestedAt ? `<div class="muted">生成时间：${escapeHtml(formatDate(auth.requestedAt))}</div>` : ""}
        ${auth.verificationUrl ? `<div class="mono">${escapeHtml(auth.verificationUrl)}</div>` : ""}
        ${auth.expiresAt ? `<div class="muted">过期时间：${escapeHtml(formatDate(auth.expiresAt))}</div>` : ""}
        ${auth.lastError ? `<pre class="mono">${escapeHtml(auth.lastError)}</pre>` : ""}
      </div>
      ${qr}
    </div>
  `;
}

const factoryJobButtonIds = [
  "refreshFactoryJobsButton",
  "createFactoryJobsButton",
  "registerNextFactoryJobButton",
  "checkFactoryScopesButton",
  "startFactoryAuthButton",
  "completeFactoryAuthButton",
  "appendFactoryInstancesButton",
  "installFactoryWatchdogsButton",
  "startFactoryBotsButton",
];

function setFactoryJobControlsDisabled(disabled) {
  setButtonsDisabled(factoryJobButtonIds, disabled);
  document.querySelectorAll(".factory-job-action").forEach((button) => {
    button.disabled = disabled;
  });
}

function renderScopeSummary(scopes) {
  if (!scopes?.checkedAt) return `<div class="muted">权限尚未复查。</div>`;
  const missing = scopes.missing || [];
  const extra = scopes.extra || [];
  return `
    <div class="scope-summary">
      <div class="badge-row">
        ${statusBadge(missing.length ? "bad" : "good", `missing ${missing.length}`)}
        ${statusBadge("info", `current ${scopes.count ?? "-"}`)}
        ${statusBadge("info", `baseline ${scopes.baselineCount ?? "-"}`)}
      </div>
      <div class="muted">基准 profile：${escapeHtml(scopes.baselineProfile || "-")}；检查时间：${escapeHtml(formatDate(scopes.checkedAt))}</div>
      ${
        missing.length
          ? `<details><summary>缺少 scopes（${escapeHtml(missing.length)}）</summary><pre class="mono">${escapeHtml(missing.join("\n"))}</pre></details>`
          : ""
      }
      ${
        extra.length
          ? `<details><summary>额外 scopes（${escapeHtml(extra.length)}）</summary><pre class="mono">${escapeHtml(extra.join("\n"))}</pre></details>`
          : ""
      }
    </div>
  `;
}

function factoryCanRegister(job) {
  return ["pending", "failed"].includes(job?.status) && !job?.appId;
}

function factoryCanRemoveQueuedJob(job) {
  return ["pending", "failed"].includes(job?.status) && !job?.appId;
}

function factoryCanCheckScopes(job) {
  return ["profile_created", "scopes_checked", "instance_config_written", "watchdog_installed", "started"].includes(job?.status);
}

function factoryCanStartAuth(job) {
  return factoryCanCheckScopes(job) && (!job.scopes?.checkedAt || factoryJobMissingCount(job) > 0);
}

function factoryCanCompleteAuth(job) {
  return job?.auth?.status === "pending" && !factoryAuthExpired(job);
}

function factoryCanAppendInstance(job) {
  return ["scopes_checked", "instance_config_written", "watchdog_installed", "started"].includes(job?.status)
    && job.scopes?.checkedAt
    && factoryJobMissingCount(job) === 0;
}

function factoryCanInstallWatchdog(job) {
  return job?.status === "instance_config_written";
}

function factoryCanStartBot(job) {
  return job?.status === "watchdog_installed";
}

function factoryJobButton(job, action, label, enabled) {
  return `<button type="button" class="secondary-button factory-job-action" data-factory-action="${escapeHtml(action)}" data-job-name="${escapeHtml(job.name)}" ${enabled ? "" : "disabled"}>${escapeHtml(label)}</button>`;
}

function factoryJobStageText(job) {
  if (!job) return "-";
  if (job.status === "failed") {
    return job.recoveryHint || "创建失败：本地没有完成 profile 写入。删除飞书侧残留后可重试。";
  }
  if (factoryCanRegister(job)) return "仅在队列中，尚未创建飞书 APP/profile";
  if (job.auth?.status === "pending" && factoryAuthExpired(job)) return "补授权二维码已过期，需要重新发起补授权";
  if (factoryCanCompleteAuth(job)) return "已发起补授权，等待扫码后完成";
  if (factoryCanStartAuth(job)) return `缺 ${factoryJobMissingCount(job)} 个 scopes，需要补授权`;
  if (factoryCanAppendInstance(job) && job.status === "scopes_checked") return "权限完整，待写入实例配置";
  if (factoryCanInstallWatchdog(job)) return "实例已写入，待安装 watchdog";
  if (factoryCanStartBot(job)) return "watchdog 已安装，待启动 Bot";
  if (job.status === "started") return "已启动";
  return job.status || "未知状态";
}

function renderFactoryJobActions(job) {
  const selected = state.selectedFactoryJobName === job.name;
  return `
    <div class="factory-job-actions">
      <button type="button" class="${selected ? "primary-button" : "secondary-button"} factory-select-job" data-job-name="${escapeHtml(job.name)}">${selected ? "已选中" : "选中这个 Bot"}</button>
      ${factoryCanRemoveQueuedJob(job) ? `<button type="button" class="secondary-button factory-remove-job" data-job-name="${escapeHtml(job.name)}">移除未创建队列项</button>` : ""}
    </div>
    <div class="muted">${escapeHtml(factoryJobStageText(job))}</div>
  `;
}

function factoryJobGroup(job) {
  if (job.status === "started") return "done";
  if (job.status === "failed") return factoryCanRemoveQueuedJob(job) ? "cleanup" : "blocked";
  if (factoryCanRegister(job)) return "pending";
  if (job.auth?.status === "pending" || factoryCanStartAuth(job) || factoryCanCompleteAuth(job) || (factoryCanCheckScopes(job) && !job.scopes?.checkedAt)) {
    return "auth";
  }
  if (factoryCanAppendInstance(job) || factoryCanInstallWatchdog(job) || factoryCanStartBot(job)) return "setup";
  return "setup";
}

const factoryJobGroupMeta = {
  pending: { title: "待创建", note: "只在队列里，还没有创建飞书 APP/profile。" },
  auth: { title: "授权 / 权限", note: "需要复查 scopes、补授权或完成扫码确认。" },
  setup: { title: "待写入 / 安装 / 启动", note: "权限已经处理，继续写入实例配置、安装 watchdog 或启动 Bot。" },
  done: { title: "已完成", note: "已经启动的新 Bot。" },
  cleanup: { title: "未继续 / 可清理", note: "还没有 appId 的失败或放弃项，可以从队列移除。" },
  blocked: { title: "失败 / 需人工处理", note: "飞书侧或本地可能已有残留，先看错误再继续。" },
};

function renderFactoryJobCard(job) {
  return `
    <div class="factory-job-row ${state.selectedFactoryJobName === job.name ? "selected" : ""}" data-job-name="${escapeHtml(job.name)}">
      <div>
        <strong>${escapeHtml(job.label || job.name)}</strong>
        <div>${mono(job.name)}</div>
      </div>
      <div class="badge-row">${jobStatusBadge(job.status)}${state.selectedFactoryJobName === job.name ? statusBadge("info", "当前选中") : ""}</div>
      ${renderFactoryJobActions(job)}
      ${renderFactoryJobQr(job)}
      ${renderFactoryAuthBox(job)}
      ${renderScopeSummary(job.scopes)}
      <div class="path-grid">
        ${pathRow("profile", job.larkProfile)}
        ${pathRow("workspace", job.workspace)}
        ${pathRow("codexHome", job.codexHome)}
        ${pathRow("desktopCodexHome", job.desktopCodexHome)}
        ${pathRow("taskName", job.taskName)}
        ${pathRow("appId", job.appId || "-")}
        ${pathRow("PID", job.pid || "-")}
        ${pathRow("QR page", job.qrPage || "-")}
        ${pathRow("QR image", job.qrImage || "-")}
        ${pathRow("register log", job.registerLogPath || "-")}
      </div>
      ${job.lastError ? `<pre class="mono">${escapeHtml(job.lastError)}</pre>` : ""}
    </div>
  `;
}

async function resetFactoryJobsView() {
  const confirm = $("factoryResetViewConfirm").value.trim();
  if (confirm !== "重置创建队列显示") {
    setActionResult("factoryJobsResult", "warn", "请输入确认文本：重置创建队列显示");
    return;
  }
  setFactoryJobControlsDisabled(true);
  setActionResult("factoryJobsResult", "info", "正在重置创建队列显示。不会删除已创建 Bot、飞书 APP、workspace、watchdog 或运行进程。");
  try {
    const data = await postJson("/api/factory/jobs/reset-view", { confirm });
    state.selectedFactoryJobName = "";
    renderFactoryJobs(data);
    $("factoryResetViewConfirm").value = "";
    setActionResult(
      "factoryJobsResult",
      "good",
      `<strong>创建队列显示已重置。</strong><div>清空 ${escapeHtml(data.removedCount || 0)} 条队列记录；已创建并运行的 Bot 不受影响。</div>`,
    );
    await refresh();
  } catch (error) {
    setActionResult("factoryJobsResult", "bad", `<strong>重置失败</strong><pre class="mono">${escapeHtml(error.message)}</pre>`);
  } finally {
    setFactoryJobControlsDisabled(false);
  }
}

function renderFactoryJobs(data) {
  const jobs = data.jobs || [];
  const target = $("factoryJobsList");
  renderFactoryProgress(data);
  if (!jobs.length) {
    target.innerHTML = `<div class="empty small-empty">还没有真实创建队列。请先完成本地空间初始化，再生成队列。</div>`;
    return;
  }
  target.innerHTML = `
    <div class="path-hint full-paths">
      <span>队列文件</span><code>${escapeHtml(data.jobsFile || "-")}</code>
      <span>更新时间</span><code>${escapeHtml(formatDate(data.updatedAt))}</code>
    </div>
    <div class="factory-group-list">
      ${["auth", "setup", "pending", "cleanup", "blocked", "done"]
        .map((group) => {
          const groupedJobs = jobs.filter((job) => factoryJobGroup(job) === group);
          if (!groupedJobs.length) return "";
          const meta = factoryJobGroupMeta[group] || { title: group, note: "" };
          return `
            <section class="factory-job-group">
              <div class="factory-job-group-head">
                <strong>${escapeHtml(meta.title)}</strong>
                ${statusBadge("info", `${groupedJobs.length} 个`)}
                <span class="muted">${escapeHtml(meta.note)}</span>
              </div>
              <div class="result-list">${groupedJobs.map(renderFactoryJobCard).join("")}</div>
            </section>
          `;
        })
        .join("")}
    </div>
  `;
}

async function refreshFactoryJobs(showMessage = true) {
  if (showMessage) setActionResult("factoryJobsResult", "info", "正在读取真实创建队列。");
  try {
    const data = await getJson("/api/factory/jobs");
    renderFactoryJobs(data);
    if (showMessage) {
      setActionResult("factoryJobsResult", "good", `<strong>队列已刷新。</strong><div>当前 ${escapeHtml(data.jobs?.length || 0)} 个 Bot。</div>`);
    }
  } catch (error) {
    setActionResult("factoryJobsResult", "bad", `<strong>队列读取失败</strong><pre class="mono">${escapeHtml(error.message)}</pre>`);
  }
}

function startFactoryJobsPolling() {
  stopFactoryJobsPolling();
  state.factoryPollingTimer = setInterval(() => {
    if (state.activePanel === "workspace-factory") {
      refreshFactoryJobs(false);
    }
  }, 2_000);
}

function stopFactoryJobsPolling() {
  if (state.factoryPollingTimer) {
    clearInterval(state.factoryPollingTimer);
    state.factoryPollingTimer = null;
  }
}

async function createFactoryJobs() {
  const payload = {
    ...factoryFormData(),
    confirm: $("factoryJobsConfirm").value.trim(),
  };
  if (payload.confirm !== "生成真实创建队列") {
    setActionResult("factoryJobsResult", "warn", "请输入确认文本：生成真实创建队列");
    return;
  }

  setFactoryJobControlsDisabled(true);
  setActionResult("factoryJobsResult", "info", "正在生成真实创建队列。不会创建飞书 APP，不会启动 Bot。");
  try {
    const data = await postJson("/api/factory/jobs/create", payload);
    renderFactoryJobs(data);
    setActionResult(
      "factoryJobsResult",
      "good",
      `<strong>真实创建队列已生成。</strong><div>队列文件：${mono(data.jobsFile)}</div><div>当前 ${escapeHtml(data.jobs?.length || 0)} 个 Bot。下一步才是逐个创建飞书 APP/profile。</div>`,
    );
  } catch (error) {
    setActionResult("factoryJobsResult", "bad", `<strong>生成队列失败</strong><pre class="mono">${escapeHtml(error.message)}</pre>`);
  } finally {
    setFactoryJobControlsDisabled(false);
  }
}

async function registerNextFactoryJob(jobName = "") {
  if (typeof jobName !== "string") jobName = "";
  jobName = jobName || selectedFactoryJobNameOrWarn();
  if (!jobName) return;
  const confirm = $("factoryRegisterConfirm").value.trim();
  if (confirm !== "创建下一个飞书APP") {
    setActionResult("factoryJobsResult", "warn", "请输入确认文本：创建下一个飞书APP");
    return;
  }

  setFactoryJobControlsDisabled(true);
  setActionResult(
    "factoryJobsResult",
    "info",
    "正在创建下一个飞书 APP / profile。此步骤会打开二维码页面并等待扫码完成；期间请不要重复点击。",
  );
  startFactoryJobsPolling();
  try {
    const data = await postJson("/api/factory/jobs/register-next", { confirm, name: jobName });
    renderFactoryJobs(data);
    const job = (data.jobs || []).find((item) => item.name === data.jobName) || {};
    setActionResult(
      "factoryJobsResult",
      data.ok ? "good" : "warn",
      `
        <strong>${data.ok ? "飞书 APP / profile 创建完成。" : "飞书 APP / profile 创建失败。"}</strong>
        <div>Bot：${mono(data.jobName)}</div>
        <div>appId：${mono(job.appId || data.parsed?.appId || "-")}</div>
        <div>注册日志：${mono(data.logPath || "-")}</div>
        ${job.qrPage ? `<div>二维码页面：${mono(job.qrPage)}</div>` : ""}
      `,
    );
  } catch (error) {
    setActionResult("factoryJobsResult", "bad", `<strong>创建失败</strong><pre class="mono">${escapeHtml(error.message)}</pre>`);
  } finally {
    stopFactoryJobsPolling();
    setFactoryJobControlsDisabled(false);
    await refreshFactoryJobs(false);
  }
}

function renderFactoryActionResults(data, successText) {
  const resultRows = (data.results || [])
    .map(
      (item) => `
        <div class="result-row">
          ${statusBadge(item.ok ? "good" : "bad", item.ok ? "成功" : "失败")}
          ${mono(item.name || "-")}
          ${item.pid ? `<span>PID：${escapeHtml(item.pid)}</span>` : ""}
          ${item.error || item.stderr ? `<pre class="mono">${escapeHtml(item.error || item.stderr)}</pre>` : ""}
        </div>
      `,
    )
    .join("");
  const appendedRows = (data.appended || [])
    .map((item) => `<div class="result-row">${mono(item.name || item.id || "-")}<span>${escapeHtml(item.group || "")}</span></div>`)
    .join("");
  return `
    <strong>${escapeHtml(successText)}</strong>
    ${data.configPath ? `<div>实例配置：${mono(data.configPath)}</div>` : ""}
    ${data.baselineProfile ? `<div>权限基准：${mono(data.baselineProfile)}</div>` : ""}
    ${data.jobsFile ? `<div>队列文件：${mono(data.jobsFile)}</div>` : ""}
    ${resultRows ? `<div class="result-list">${resultRows}</div>` : ""}
    ${appendedRows ? `<div class="result-subtitle">追加实例</div><div class="result-list">${appendedRows}</div>` : ""}
  `;
}

async function runFactoryJobAction({ confirmId, confirmText, endpoint, runningText, successText, jobName = "" }) {
  if (typeof jobName !== "string") jobName = "";
  jobName = jobName || selectedFactoryJobNameOrWarn();
  if (!jobName) return;
  const confirm = $(confirmId).value.trim();
  if (confirm !== confirmText) {
    setActionResult("factoryJobsResult", "warn", `请输入确认文本：${escapeHtml(confirmText)}`);
    return;
  }

  setFactoryJobControlsDisabled(true);
  setActionResult("factoryJobsResult", "info", runningText);
  startFactoryJobsPolling();
  try {
    const payload = { confirm, baselineProfile: factoryFormData().baselineProfile, name: jobName };
    const data = await postJsonAllowFalse(endpoint, payload);
    renderFactoryJobs(data);
    setActionResult("factoryJobsResult", data.ok ? "good" : "warn", renderFactoryActionResults(data, successText));
  } catch (error) {
    setActionResult("factoryJobsResult", "bad", `<strong>操作失败</strong><pre class="mono">${escapeHtml(error.message)}</pre>`);
  } finally {
    stopFactoryJobsPolling();
    setFactoryJobControlsDisabled(false);
    await refreshFactoryJobs(false);
    await refresh();
  }
}

function checkFactoryJobScopesAction(jobName = "") {
  return runFactoryJobAction({
    confirmId: "factoryCheckScopesConfirm",
    confirmText: "复查权限",
    endpoint: "/api/factory/jobs/check-scopes",
    runningText: "正在复查新 profile 的 scopes，并与权限基准 profile 对比。",
    successText: "权限复查完成。",
    jobName,
  });
}

function startFactoryAuthAction(jobName = "") {
  return runFactoryJobAction({
    confirmId: "factoryStartAuthConfirm",
    confirmText: "发起补授权",
    endpoint: "/api/factory/jobs/start-auth",
    runningText: "正在为第一个缺权限的 Bot 发起 domain all 用户补授权，并生成二维码。",
    successText: "补授权二维码已生成。请用飞书扫码完成授权，然后点击“完成补授权”。",
    jobName,
  });
}

function completeFactoryAuthAction(jobName = "") {
  return runFactoryJobAction({
    confirmId: "factoryCompleteAuthConfirm",
    confirmText: "完成补授权",
    endpoint: "/api/factory/jobs/complete-auth",
    runningText: "正在确认飞书扫码授权结果，并写回本地 lark-cli profile。",
    successText: "补授权完成。请再点击“复查权限”，确认 missing 变为 0。",
    jobName,
  });
}

function appendFactoryInstancesAction(jobName = "") {
  return runFactoryJobAction({
    confirmId: "factoryAppendInstancesConfirm",
    confirmText: "写入实例配置",
    endpoint: "/api/factory/jobs/append-instances",
    runningText: "正在把已通过权限复查的 Bot 追加写入 bridge.instances.json。",
    successText: "实例配置写入完成。",
    jobName,
  });
}

function installFactoryWatchdogsAction(jobName = "") {
  return runFactoryJobAction({
    confirmId: "factoryInstallWatchdogsConfirm",
    confirmText: "安装新watchdog",
    endpoint: "/api/factory/jobs/install-watchdogs",
    runningText: "正在为新 Bot 安装 watchdog 计划任务。此步骤不会重启已有 Bot。",
    successText: "watchdog 安装流程完成。",
    jobName,
  });
}

function startFactoryBotsAction(jobName = "") {
  return runFactoryJobAction({
    confirmId: "factoryStartBotsConfirm",
    confirmText: "启动新Bot",
    endpoint: "/api/factory/jobs/start-bots",
    runningText: "正在启动已安装 watchdog 的新 Bot Bridge 进程。此步骤不会重启已有 Bot。",
    successText: "新 Bot 启动流程完成。",
    jobName,
  });
}

async function runFactoryNextStep() {
  const action = state.factoryNextAction;
  if (!action?.run || !action.jobName) {
    setActionResult("factoryJobsResult", "warn", "请先点击下面某个 Bot 卡片，并确认它有可执行的下一步。");
    return;
  }
  const input = $(action.confirmId);
  if (input) input.value = action.confirmText;
  await action.run(action.jobName);
}

function handleFactoryJobAction(event) {
  const selectButton = event.target.closest(".factory-select-job");
  if (selectButton) {
    state.selectedFactoryJobName = selectButton.dataset.jobName || "";
    refreshFactoryJobs(false);
    return;
  }
  const row = event.target.closest(".factory-job-row");
  if (row && !event.target.closest("button, a, input, textarea, details, summary")) {
    state.selectedFactoryJobName = row.dataset.jobName || "";
    refreshFactoryJobs(false);
    return;
  }
  const removeButton = event.target.closest(".factory-remove-job");
  if (removeButton) {
    removeFactoryPendingJob(removeButton.dataset.jobName || "");
  }
}

function selectedFactoryJobNameOrWarn() {
  if (state.selectedFactoryJobName) return state.selectedFactoryJobName;
  setActionResult("factoryJobsResult", "warn", "请先点击下面某个 Bot 卡片，确认当前选中 Bot。");
  return "";
}

async function removeFactoryPendingJob(jobName) {
  if (!jobName) return;
  const confirmText = "移除未创建队列项";
  setFactoryJobControlsDisabled(true);
  setActionResult("factoryJobsResult", "info", `正在移除 ${escapeHtml(jobName)} 的未创建队列项。`);
  try {
    const data = await postJsonAllowFalse("/api/factory/jobs/remove-pending", { confirm: confirmText, name: jobName });
    if (state.selectedFactoryJobName === jobName) state.selectedFactoryJobName = "";
    renderFactoryJobs(data);
    setActionResult("factoryJobsResult", "good", `<strong>已移除未创建队列项。</strong><div>Bot：${mono(jobName)}</div>`);
  } catch (error) {
    setActionResult("factoryJobsResult", "bad", `<strong>移除失败</strong><pre class="mono">${escapeHtml(error.message)}</pre>`);
  } finally {
    setFactoryJobControlsDisabled(false);
    await refreshFactoryJobs(false);
  }
}

function cleanupRecordList(records) {
  if (!records?.length) return `<div class="muted">无本机目录记录。</div>`;
  return `
    <div class="path-grid cleanup-paths">
      ${records
        .map((record) => `
          ${pathRow(`${record.type}${record.removable ? "" : "（受保护）"}`, record.path)}
        `)
        .join("")}
    </div>
  `;
}

function renderResidualCleanupItem(item) {
  return `
    <div class="cleanup-item">
      <div class="cleanup-head">
        <div>
          <strong>${escapeHtml(item.displayName || item.botName)}</strong>
          <div>${mono(item.botName)}</div>
        </div>
        ${statusBadge(item.removable ? "warn" : "bad", item.removable ? "可清理" : "受保护")}
      </div>
      <p>${escapeHtml(item.reason || "")}</p>
      ${cleanupRecordList(item.records)}
      <button type="button" class="danger-button cleanup-residual-button" data-bot-name="${escapeHtml(item.botName)}" ${item.removable ? "" : "disabled"}>清理这个残留</button>
    </div>
  `;
}

function renderFormalCleanupItem(item) {
  return `
    <div class="cleanup-item">
      <div class="cleanup-head">
        <div>
          <strong>${escapeHtml(item.label || item.name)}</strong>
          <div>${mono(item.name)}</div>
        </div>
        <div class="badge-row">
          ${statusBadge(item.allowed ? "warn" : "info", item.allowed ? "可卸载" : "受保护")}
          ${item.activeRunCount > 0 ? statusBadge("bad", `active ${item.activeRunCount}`) : statusBadge("good", "空闲")}
          ${item.online ? statusBadge("good", "在线") : statusBadge("info", "离线")}
        </div>
      </div>
      ${item.protectedReason ? `<p>${escapeHtml(item.protectedReason)}</p>` : "<p>卸载本机 Bridge 侧配置；飞书开发后台 APP 需要最后手动删除。</p>"}
      <div class="path-grid cleanup-paths">
        ${pathRow("profile", item.profile)}
        ${pathRow("taskName", item.taskName)}
        ${pathRow("codexHome（保留）", item.codexHome)}
        ${pathRow("desktopCodexHome（保留）", item.desktopCodexHome)}
        ${pathRow("activeRunsFile", item.activeRunsFile)}
      </div>
      ${cleanupRecordList(item.records)}
      <button type="button" class="danger-button cleanup-formal-button" data-bot-name="${escapeHtml(item.name)}" ${item.allowed && item.activeRunCount === 0 ? "" : "disabled"}>卸载这个 Bot</button>
    </div>
  `;
}

function renderSpaceCleanupItem(item) {
  return `
    <div class="cleanup-item">
      <div class="cleanup-head">
        <div>
          <strong>${escapeHtml(item.label || item.group)}</strong>
          <div>${mono(item.group)}</div>
        </div>
        <div class="badge-row">
          ${statusBadge(item.allowed ? "bad" : "info", item.allowed ? "可卸载空间" : "不可卸载")}
          ${item.activeRunCount > 0 ? statusBadge("bad", `active ${item.activeRunCount}`) : statusBadge("good", "全部空闲")}
        </div>
      </div>
      <div class="path-grid cleanup-paths">
        ${pathRow("正式 Bot", (item.botNames || []).join(", ") || "-")}
        ${pathRow("未创建残留", (item.residualBotNames || []).join(", ") || "-")}
        ${pathRow("Codex Home", (item.codexHomes || []).join(" | ") || "-")}
        ${pathRow("Desktop Codex Home（保留）", (item.desktopCodexHomes || []).join(" | ") || "-")}
      </div>
      ${cleanupRecordList(item.records)}
      <button type="button" class="danger-button cleanup-space-button" data-space-group="${escapeHtml(item.group)}" ${item.allowed ? "" : "disabled"}>卸载这个空间</button>
    </div>
  `;
}

function renderCleanupPlan(plan) {
  state.cleanupPlan = plan;
  const residual = plan.residual || [];
  const formal = plan.formal || [];
  const spaces = plan.spaces || [];
  $("cleanupResidualList").innerHTML = residual.length
    ? residual.map(renderResidualCleanupItem).join("")
    : `<div class="empty small-empty">没有发现未创建残留。</div>`;
  $("cleanupFormalList").innerHTML = formal.length
    ? formal.map(renderFormalCleanupItem).join("")
    : `<div class="empty small-empty">没有正式 Bot 可展示。</div>`;
  $("cleanupSpaceList").innerHTML = spaces.length
    ? spaces.map(renderSpaceCleanupItem).join("")
    : `<div class="empty small-empty">没有可卸载的垂类空间。</div>`;
}

async function refreshCleanupPlan(showMessage = true) {
  if (state.cleanupLoading) return;
  state.cleanupLoading = true;
  $("cleanupRefreshButton").disabled = true;
  if (showMessage) setActionResult("cleanupResult", "info", "正在读取清理计划。不会修改任何文件。");
  try {
    const plan = await getJson("/api/cleanup/plan");
    renderCleanupPlan(plan);
    if (showMessage) {
      setActionResult(
        "cleanupResult",
        "good",
        `<strong>清理计划已刷新。</strong><div>正式 Bot：${escapeHtml((plan.formal || []).length)}；未创建残留：${escapeHtml((plan.residual || []).length)}。</div>`,
      );
    }
  } catch (error) {
    setActionResult("cleanupResult", "bad", `<strong>清理计划读取失败</strong><pre class="mono">${escapeHtml(error.message)}</pre>`);
  } finally {
    state.cleanupLoading = false;
    $("cleanupRefreshButton").disabled = false;
  }
}

async function cleanupResidualBot(botName) {
  const confirm = $("cleanupResidualConfirm").value.trim();
  if (confirm !== botName) {
    setActionResult("cleanupResult", "warn", `请输入确认文本：${escapeHtml(botName)}`);
    return;
  }
  setActionResult("cleanupResult", "info", `正在清理未创建残留：${escapeHtml(botName)}`);
  try {
    const data = await postJson("/api/cleanup/residual", { name: botName, confirm });
    renderCleanupPlan(data.plan);
    $("cleanupResidualConfirm").value = "";
    setActionResult("cleanupResult", "good", `<strong>残留已清理。</strong><div>Bot：${mono(botName)}</div>`);
    await refresh();
  } catch (error) {
    setActionResult("cleanupResult", "bad", `<strong>残留清理失败</strong><pre class="mono">${escapeHtml(error.message)}</pre>`);
  }
}

async function uninstallFormalBot(botName) {
  const confirm = $("cleanupFormalConfirm").value.trim();
  if (confirm !== botName) {
    setActionResult("cleanupResult", "warn", `请输入确认文本：${escapeHtml(botName)}`);
    return;
  }
  const payload = {
    name: botName,
    confirm,
    removeRuntime: $("cleanupRemoveRuntime").checked,
    removeRegistration: $("cleanupRemoveRegistration").checked,
    removeWorkspace: $("cleanupRemoveWorkspace").checked,
  };
  setActionResult("cleanupResult", "info", `正在卸载本机 Bot：${escapeHtml(botName)}。不会删除共享 Codex Home 或飞书开发后台 APP。`);
  try {
    const data = await postJson("/api/cleanup/uninstall", payload);
    renderCleanupPlan(data.plan);
    $("cleanupFormalConfirm").value = "";
    setActionResult(
      "cleanupResult",
      "good",
      `<strong>本机 Bot 已卸载。</strong><div>Bot：${mono(botName)}</div><div>飞书开发后台 APP 仍需你按需手动删除。</div>`,
    );
    await refresh();
  } catch (error) {
    setActionResult("cleanupResult", "bad", `<strong>卸载失败</strong><pre class="mono">${escapeHtml(error.message)}</pre>`);
  }
}

async function uninstallSpace(group) {
  const confirm = $("cleanupSpaceConfirm").value.trim();
  if (confirm !== group) {
    setActionResult("cleanupResult", "warn", `请输入确认文本：${escapeHtml(group)}`);
    return;
  }
  const payload = {
    group,
    confirm,
    removeWorkspaces: $("cleanupSpaceRemoveWorkspaces").checked,
    removeResidual: $("cleanupSpaceRemoveResidual").checked,
    removeCodexHome: $("cleanupSpaceRemoveCodexHome").checked,
  };
  setActionResult("cleanupResult", "info", `正在卸载空间：${escapeHtml(group)}。不会删除飞书开发后台 APP 或 lark-cli profile。`);
  try {
    const data = await postJson("/api/cleanup/space-uninstall", payload);
    renderCleanupPlan(data.plan);
    $("cleanupSpaceConfirm").value = "";
    setActionResult(
      "cleanupResult",
      "good",
      `<strong>空间已卸载。</strong><div>空间：${mono(group)}</div><div>飞书开发后台 APP 和 lark-cli profile 仍需按需手动删除。</div>`,
    );
    await refresh();
  } catch (error) {
    setActionResult("cleanupResult", "bad", `<strong>空间卸载失败</strong><pre class="mono">${escapeHtml(error.message)}</pre>`);
  }
}

function handleCleanupClick(event) {
  const residual = event.target.closest(".cleanup-residual-button");
  if (residual) {
    cleanupResidualBot(residual.dataset.botName || "");
    return;
  }
  const formal = event.target.closest(".cleanup-formal-button");
  if (formal) {
    uninstallFormalBot(formal.dataset.botName || "");
    return;
  }
  const space = event.target.closest(".cleanup-space-button");
  if (space) {
    uninstallSpace(space.dataset.spaceGroup || "");
  }
}

async function previewProvider() {
  setButtonsDisabled(["previewProviderButton", "testProviderButton", "addProviderButton"], true);
  setActionResult("providerActionResult", "info", "正在请求当前 provider 的 /models。");
  try {
    const data = await postJson("/api/provider/preview", providerFormData());
    setActionResult(
      "providerActionResult",
      "good",
      `
        <strong>模型列表拉取成功，共 ${escapeHtml(data.models.length)} 个。</strong>
        <div>密钥来源：${data.apiKeyProvided ? statusBadge("good", "使用本次填写的 API Key") : data.envVisible ? statusBadge("good", "当前控制面板进程可见") : statusBadge("warn", "不可见")}</div>
        ${renderProviderModels(data.models)}
        <div class="result-subtitle">将写入的 TOML 片段</div>
        <pre class="mono">${escapeHtml(data.toml)}</pre>
      `,
    );
  } catch (error) {
    setActionResult("providerActionResult", "bad", `<strong>拉取失败</strong><pre class="mono">${escapeHtml(error.message)}</pre>`);
  } finally {
    setButtonsDisabled(["previewProviderButton", "testProviderButton", "addProviderButton"], false);
  }
}

async function testProviderModel() {
  setButtonsDisabled(["previewProviderButton", "testProviderButton", "addProviderButton"], true);
  setActionResult("providerActionResult", "info", "正在用测试模型请求 /responses 轻量探针。");
  try {
    const data = await postJson("/api/provider/test", providerFormData());
    const result = data.result || {};
    const ok = Boolean(result.ok);
    setActionResult(
      "providerActionResult",
      ok ? "good" : (result.level || "warn"),
      `
        <strong>${ok ? "模型轻量探针成功。" : "模型轻量探针未通过，但不等于 Bot 实际不可用。"}</strong>
        <div>provider：${mono(data.provider?.id)}</div>
        <div>model：${mono(data.model)}</div>
        <div>密钥来源：${data.apiKeyProvided ? "本次填写的 API Key" : "环境变量"}</div>
        <div>HTTP：${escapeHtml(result.httpStatus || "-")}</div>
        <div>耗时：${escapeHtml(result.elapsedMs || "-")} ms</div>
        <div>response id：${mono(result.responseId || "-")}</div>
        ${result.note ? `<div class="muted">${escapeHtml(result.note)}</div>` : ""}
        ${result.error ? `<pre class="mono">${escapeHtml(result.error)}</pre>` : ""}
      `,
    );
  } catch (error) {
    setActionResult("providerActionResult", "bad", `<strong>模型测活失败</strong><pre class="mono">${escapeHtml(error.message)}</pre>`);
  } finally {
    setButtonsDisabled(["previewProviderButton", "testProviderButton", "addProviderButton"], false);
  }
}

async function addProvider() {
  const payload = providerFormData();
  if (payload.confirm !== payload.id) {
    setActionResult("providerActionResult", "warn", "写入前，请在“确认写入”里输入完整 provider id。");
    return;
  }

  setButtonsDisabled(["previewProviderButton", "testProviderButton", "addProviderButton"], true);
  setActionResult("providerActionResult", "info", "正在写入用户级 config.toml。");
  try {
    const data = await postJson("/api/provider/add", payload);
    setActionResult(
      "providerActionResult",
      "good",
      `
        <strong>Provider 已写入。</strong>
        <div>provider：${mono(data.provider?.id)}</div>
        <div>环境变量：${data.envWritten ? `已写入用户环境变量 ${mono(data.envKey)}` : `沿用已有环境变量 ${mono(data.envKey)}`}</div>
        <div>配置文件：${mono(data.configPath)}</div>
        <div class="muted">之后可在飞书里用 /provider ${escapeHtml(data.provider?.id || "")} 切换。新增 env_key 需要对应 Bot 的 Bridge 进程重启后才会被看见。</div>
      `,
    );
    await refresh();
  } catch (error) {
    setActionResult("providerActionResult", "bad", `<strong>写入失败</strong><pre class="mono">${escapeHtml(error.message)}</pre>`);
  } finally {
    setButtonsDisabled(["previewProviderButton", "testProviderButton", "addProviderButton"], false);
  }
}

function renderProviderSyncPlan(data) {
  const summary = data.summary || {};
  const source = data.source || {};
  const targets = data.targets || [];
  const providerNames = (source.providers || []).map((provider) => provider.id).join(", ");
  const changedTargets = targets.filter((target) => target.written || target.added?.length || target.updated?.length);
  const affectedInstanceNames = new Set();
  for (const target of changedTargets) {
    for (const instance of target.instances || []) {
      if (instance.name) affectedInstanceNames.add(instance.name);
    }
  }
  const affectedInstances = (state.data?.instances || []).filter((instance) => affectedInstanceNames.has(instance.name));
  const restartable = affectedInstances.filter((instance) => instance.online && instance.activeRunCount === 0);
  const busy = affectedInstances.filter((instance) => instance.online && instance.activeRunCount > 0);
  const targetRows = targets.length
    ? targets.map((target) => {
        const skipped = (target.skipped || []).map((item) => `${item.id}: ${item.reason}`).join("; ");
        const instances = (target.instances || []).map((item) => item.name).join(", ");
        return `
          <div class="result-row">
            ${statusBadge(target.ok ? (target.written ? "good" : target.action === "unchanged" ? "info" : "warn") : "bad", target.action || "-")}
            <span>${mono(target.codexHome || "-")}</span>
            <span>新增 ${escapeHtml((target.added || []).length)}</span>
            <span>更新 ${escapeHtml((target.updated || []).length)}</span>
            <span>已一致 ${escapeHtml((target.unchanged || []).length)}</span>
            ${target.reason ? `<span>${escapeHtml(target.reason)}</span>` : ""}
            ${instances ? `<span>Bot: ${escapeHtml(instances)}</span>` : ""}
            ${target.added?.length ? `<span>新增: ${escapeHtml(target.added.join(", "))}</span>` : ""}
            ${target.updated?.length ? `<span>更新: ${escapeHtml(target.updated.join(", "))}</span>` : ""}
            ${skipped ? `<span>跳过: ${escapeHtml(skipped)}</span>` : ""}
          </div>
        `;
      }).join("")
    : `<div class="muted">没有发现独立空间 Codex Home。</div>`;
  const skippedSource = (source.skipped || []).length
    ? `<div class="result-subtitle">源配置跳过项</div><div class="result-list">${source.skipped.map((item) => `<div class="result-row">${mono(item.id)}<span>${escapeHtml(item.reason || "")}</span></div>`).join("")}</div>`
    : "";
  const restartHint = affectedInstanceNames.size
    ? `
      <div class="result-subtitle">同步后的重启提示</div>
      <div class="result-list">
        <div class="result-row">${statusBadge("warn", "需关注")}<span>受影响 Bot：${escapeHtml(Array.from(affectedInstanceNames).join(", "))}</span></div>
        <div class="result-row">${statusBadge("good", "可重启")}<span>在线且空闲：${escapeHtml(restartable.map((item) => item.name).join(", ") || "-")}</span></div>
        <div class="result-row">${statusBadge(busy.length ? "warn" : "info", "运行中")}<span>有 active run，暂不建议重启：${escapeHtml(busy.map((item) => item.name).join(", ") || "-")}</span></div>
      </div>
      <div class="muted">Provider block 已写入 config.toml 后，正在运行的空间 Bot 通常要重启 Bridge 进程才会读取新配置和环境变量。</div>
    `
    : `<div class="muted">没有发现需要新增或更新的空间 Provider；当前不需要因为本次同步重启空间 Bot。</div>`;
  return `
    <strong>${data.applied ? "Provider 同步已执行。" : "Provider 同步预览完成。"}</strong>
    <div>源配置：${mono(source.configPath || "-")}</div>
    <div>源 provider：${escapeHtml(providerNames || "-")}</div>
    <div>目标空间：${escapeHtml(summary.targetCount || 0)} 个；待新增 ${escapeHtml(summary.addCount || 0)}；待更新 ${escapeHtml(summary.updateCount || 0)}；已一致 ${escapeHtml(summary.unchangedCount || 0)}；跳过 ${escapeHtml(summary.skippedCount || 0)}；已写入 ${escapeHtml(summary.writtenCount || 0)} 个空间。</div>
    <div class="muted">${escapeHtml(data.note || "")}</div>
    ${restartHint}
    ${skippedSource}
    <div class="result-subtitle">空间明细</div>
    <div class="result-list">${targetRows}</div>
  `;
}

async function previewProviderSync() {
  setButtonsDisabled(["previewProviderSyncButton", "syncProvidersButton"], true);
  setActionResult("providerSyncResult", "info", "正在只读预览全局 Provider 与各空间的差异。");
  try {
    const data = await getJson("/api/provider/sync-preview");
    setActionResult("providerSyncResult", "good", renderProviderSyncPlan(data));
  } catch (error) {
    setActionResult("providerSyncResult", "bad", `<strong>预览失败</strong><pre class="mono">${escapeHtml(error.message)}</pre>`);
  } finally {
    setButtonsDisabled(["previewProviderSyncButton", "syncProvidersButton"], false);
  }
}

async function syncProvidersToSpaces() {
  const confirm = $("providerSyncConfirm").value.trim();
  if (confirm !== "同步Provider到空间") {
    setActionResult("providerSyncResult", "warn", "请输入确认文本：同步Provider到空间");
    return;
  }
  setButtonsDisabled(["previewProviderSyncButton", "syncProvidersButton"], true);
  setActionResult("providerSyncResult", "info", "正在把全局 Provider block 写入缺失或不一致的空间 config.toml。");
  try {
    const data = await postJson("/api/provider/sync-spaces", { confirm });
    setActionResult("providerSyncResult", "good", renderProviderSyncPlan(data));
    await refresh();
  } catch (error) {
    setActionResult("providerSyncResult", "bad", `<strong>同步失败</strong><pre class="mono">${escapeHtml(error.message)}</pre>`);
  } finally {
    setButtonsDisabled(["previewProviderSyncButton", "syncProvidersButton"], false);
  }
}

function selectedRestartNames() {
  return Array.from(state.selectedRestartBots);
}

function selectAllIdleBots() {
  state.selectedRestartBots.clear();
  for (const item of state.data?.instances || []) {
    if (item.activeRunCount === 0) state.selectedRestartBots.add(item.name);
  }
  renderRestartList(state.data || {});
}

function clearRestartSelection() {
  state.selectedRestartBots.clear();
  renderRestartList(state.data || {});
}

async function restartSelectedIdleBots() {
  const names = selectedRestartNames();
  const confirm = $("restartConfirm").value.trim();
  if (names.length === 0) {
    setActionResult("restartActionResult", "warn", "请先选择至少一个空闲 Bot。");
    return;
  }
  if (confirm !== "重启空闲Bot") {
    setActionResult("restartActionResult", "warn", "请输入确认文本：重启空闲Bot");
    return;
  }

  setButtonsDisabled(["restartIdleButton", "selectAllIdleButton", "clearRestartSelectionButton"], true);
  setActionResult("restartActionResult", "info", `正在重启 ${escapeHtml(names.length)} 个已选 Bot 的 Bridge 进程。`);
  try {
    const data = await postJson("/api/restart/idle", {
      names,
      confirm,
    });
    const rows = (data.results || [])
      .map((item) => {
        const kind = item.action === "restarted" ? "good" : item.action === "skipped" ? "warn" : "bad";
        return `
          <div class="result-row">
            ${statusBadge(kind, item.action)}
            <strong>${escapeHtml(item.name)}</strong>
            <span>${escapeHtml(item.reason || "")}</span>
            <span class="mono">PID ${escapeHtml(item.beforePid || "-")} -> ${escapeHtml(item.afterPid || "-")}</span>
          </div>
        `;
      })
      .join("");
    setActionResult(
      "restartActionResult",
      data.summary?.failed ? "warn" : "good",
      `
        <strong>重启请求完成：成功 ${escapeHtml(data.summary?.restarted || 0)}，跳过 ${escapeHtml(data.summary?.skipped || 0)}，失败 ${escapeHtml(data.summary?.failed || 0)}。</strong>
        <div class="result-list">${rows}</div>
      `,
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await refresh();
  } catch (error) {
    setActionResult("restartActionResult", "bad", `<strong>重启失败</strong><pre class="mono">${escapeHtml(error.message)}</pre>`);
  } finally {
    setButtonsDisabled(["restartIdleButton", "selectAllIdleButton", "clearRestartSelectionButton"], false);
  }
}

async function refresh() {
  $("refreshButton").disabled = true;
  $("refreshButton").textContent = "刷新中";
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
    if (state.activePanel === "workspace-factory") {
      await refreshFactoryJobs(false);
    }
  } catch (error) {
    $("problemList").innerHTML = `
      <article class="problem">
        <div class="problem-title">控制面板刷新失败</div>
        <pre class="mono">${escapeHtml(error.message || String(error))}</pre>
      </article>
    `;
  } finally {
    $("refreshButton").disabled = false;
    $("refreshButton").textContent = "刷新";
  }
}

function setAutoRefresh(enabled) {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  if (enabled) {
    state.timer = setInterval(refresh, 10_000);
  }
}

function setActiveNav(panelId) {
  for (const item of document.querySelectorAll(".nav-item")) {
    item.classList.toggle("is-active", item.dataset.panel === panelId);
  }
}

function showPanel(panelId, options = {}) {
  const target = document.querySelector(`[data-panel-page="${cssEscape(panelId)}"]`);
  if (!target) return;
  state.activePanel = panelId;
  for (const panel of document.querySelectorAll(".panel-page")) {
    panel.classList.toggle("is-active", panel === target);
  }
  setActiveNav(panelId);
  if (options.updateHash !== false) {
    history.replaceState(null, "", `#${panelId}`);
  }
  if (options.scrollToTop !== false) {
    window.scrollTo({ top: 0, behavior: "auto" });
  }
  if (panelId === "doctor") {
    refreshDoctor(false);
  }
  if (panelId === "workspace-factory" && !state.factorySources) {
    loadFactorySources();
  }
  if (panelId === "workspace-factory") {
    refreshFactoryJobs(false);
  }
  if (panelId === "bot-cleanup") {
    refreshCleanupPlan(false);
  }
}

function initPanelNavigation() {
  const navItems = Array.from(document.querySelectorAll(".nav-item"));

  for (const item of navItems) {
    item.addEventListener("click", (event) => {
      event.preventDefault();
      showPanel(item.dataset.panel);
    });
  }

  const hashPanel = decodeURIComponent(window.location.hash.replace(/^#/, ""));
  if (hashPanel && document.querySelector(`[data-panel-page="${cssEscape(hashPanel)}"]`)) {
    showPanel(hashPanel, { updateHash: false, scrollToTop: true });
  } else {
    showPanel(state.activePanel, { updateHash: false, scrollToTop: false });
  }
}

function applySidebarCollapsed() {
  document.body.classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
  const button = $("sidebarToggle");
  if (button) {
    button.textContent = state.sidebarCollapsed ? "›" : "‹";
    button.setAttribute("aria-expanded", state.sidebarCollapsed ? "false" : "true");
    button.title = state.sidebarCollapsed ? "展开侧边栏" : "收起侧边栏";
  }
}

function toggleSidebar() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  localStorage.setItem("codexBridgeSidebarCollapsed", state.sidebarCollapsed ? "1" : "0");
  applySidebarCollapsed();
}

function restoreBotDetailState() {
  for (const detail of document.querySelectorAll("[data-bot-details]")) {
    detail.open = state.openBotDetails.has(detail.dataset.botDetails);
  }
}

function updateBotDetailState(detail) {
  const name = detail.dataset.botDetails;
  if (!name) return;
  if (detail.open) {
    state.openBotDetails.add(name);
  } else {
    state.openBotDetails.delete(name);
  }
}

$("refreshButton").addEventListener("click", refresh);
$("autoRefresh").addEventListener("change", (event) => setAutoRefresh(event.target.checked));
$("sidebarToggle").addEventListener("click", toggleSidebar);
$("previewProviderButton").addEventListener("click", previewProvider);
$("testProviderButton").addEventListener("click", testProviderModel);
$("addProviderButton").addEventListener("click", addProvider);
$("previewProviderSyncButton").addEventListener("click", previewProviderSync);
$("syncProvidersButton").addEventListener("click", syncProvidersToSpaces);
$("providerForm").addEventListener("submit", (event) => event.preventDefault());
$("previewFactoryButton").addEventListener("click", previewFactory);
$("readScopesButton").addEventListener("click", readFactoryScopesBaseline);
$("factoryForm").addEventListener("submit", (event) => event.preventDefault());
$("loadFactorySourcesButton").addEventListener("click", loadFactorySources);
$("prepareFactoryLocalButton").addEventListener("click", prepareFactoryLocalSpace);
$("refreshFactoryJobsButton").addEventListener("click", () => refreshFactoryJobs(true));
$("createFactoryJobsButton").addEventListener("click", createFactoryJobs);
$("resetFactoryJobsViewButton").addEventListener("click", resetFactoryJobsView);
$("factoryNextStepButton").addEventListener("click", runFactoryNextStep);
$("registerNextFactoryJobButton").addEventListener("click", registerNextFactoryJob);
$("checkFactoryScopesButton").addEventListener("click", checkFactoryJobScopesAction);
$("startFactoryAuthButton").addEventListener("click", startFactoryAuthAction);
$("completeFactoryAuthButton").addEventListener("click", completeFactoryAuthAction);
$("appendFactoryInstancesButton").addEventListener("click", appendFactoryInstancesAction);
$("installFactoryWatchdogsButton").addEventListener("click", installFactoryWatchdogsAction);
$("startFactoryBotsButton").addEventListener("click", startFactoryBotsAction);
$("factoryJobsList").addEventListener("click", handleFactoryJobAction);
$("cleanupRefreshButton").addEventListener("click", () => refreshCleanupPlan(true));
$("cleanupResidualList").addEventListener("click", handleCleanupClick);
$("cleanupFormalList").addEventListener("click", handleCleanupClick);
$("restartIdleButton").addEventListener("click", restartSelectedIdleBots);
$("selectAllIdleButton").addEventListener("click", selectAllIdleBots);
$("clearRestartSelectionButton").addEventListener("click", clearRestartSelection);
$("doctorRefreshButton").addEventListener("click", () => refreshDoctor(true));
$("restartBotList").addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") return;
  if (target.checked) {
    state.selectedRestartBots.add(target.value);
  } else {
    state.selectedRestartBots.delete(target.value);
  }
});
$("botCards").addEventListener("toggle", (event) => {
  const detail = event.target;
  if (!(detail instanceof HTMLDetailsElement) || !detail.dataset.botDetails) return;
  updateBotDetailState(detail);
}, true);

applySidebarCollapsed();
setAutoRefresh($("autoRefresh").checked);
initPanelNavigation();
refresh();
