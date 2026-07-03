const state = {
  timer: null,
  data: null,
  selectedRestartBots: new Set(),
  openBotDetails: new Set(),
  activePanel: "overview",
  doctor: null,
  doctorLoading: false,
  doctorLoaded: false,
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
          ? statusBadge("good", `${provider.envKey} 可见`)
          : statusBadge("warn", `${provider.envKey} 不可见`)
        : statusBadge("info", "无 env_key");
      return `
        <tr>
          <td>${mono(provider.id)}</td>
          <td>${escapeHtml(provider.name || "-")}</td>
          <td>${mono(provider.baseUrl || "-")}</td>
          <td>${mono(provider.wireApi || "-")}</td>
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
  showPanel(state.activePanel, { updateHash: false, scrollToTop: false });
}

function providerFormData() {
  const form = $("providerForm");
  return {
    id: form.elements.id.value.trim(),
    name: form.elements.name.value.trim(),
    baseUrl: form.elements.baseUrl.value.trim(),
    envKey: form.elements.envKey.value.trim(),
    model: form.elements.model.value.trim(),
    confirm: form.elements.confirm.value.trim(),
    wireApi: "responses",
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
        <div>环境变量：${data.envVisible ? statusBadge("good", "当前控制面板进程可见") : statusBadge("warn", "不可见")}</div>
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
  setActionResult("providerActionResult", "info", "正在用测试模型请求 /responses。");
  try {
    const data = await postJson("/api/provider/test", providerFormData());
    const result = data.result || {};
    setActionResult(
      "providerActionResult",
      "good",
      `
        <strong>模型测活成功。</strong>
        <div>provider：${mono(data.provider?.id)}</div>
        <div>model：${mono(data.model)}</div>
        <div>耗时：${escapeHtml(result.elapsedMs || "-")} ms</div>
        <div>response id：${mono(result.responseId || "-")}</div>
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
$("previewProviderButton").addEventListener("click", previewProvider);
$("testProviderButton").addEventListener("click", testProviderModel);
$("addProviderButton").addEventListener("click", addProvider);
$("providerForm").addEventListener("submit", (event) => event.preventDefault());
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

setAutoRefresh($("autoRefresh").checked);
initPanelNavigation();
refresh();
