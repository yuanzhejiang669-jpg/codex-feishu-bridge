import { api, escapeHtml, formatIpcError } from "../ipc.js";
import { engineLabel, getManagedBots, normalizeEngine, setState, store } from "../state.js";
import { openConfirmModal } from "./confirm-modal.js";
import { showToast } from "./toast.js";

let previousFocus = null;
let refreshCallback = null;
let larkAuthBotName = "";
const readinessCache = new Map();
const logState = {
  stream: "stdout",
  lines: 200,
  loading: false,
  data: null,
  error: "",
};

export function configureBotDrawer({ onRefresh } = {}) {
  refreshCallback = onRefresh || null;
}

export function isBotDrawerOpen() {
  return Boolean(store.activeDrawerBotName);
}

export function openBotDrawer(botName, tab = "config", focusField = "") {
  if (!botName) return;
  previousFocus = document.activeElement;
  logState.data = null;
  logState.error = "";
  logState.stream = "stdout";
  setState({
    activeDrawerBotName: botName,
    drawerTab: ["config", "readiness", "logs"].includes(tab) ? tab : "config",
    drawerFocusField: focusField || "",
  });
  if (store.drawerTab === "readiness") {
    void loadReadiness(botName);
  } else if (store.drawerTab === "logs") {
    void loadLogs(botName);
  }
}

export function closeBotDrawer() {
  const backdrop = document.getElementById("bot-drawer");
  if (backdrop) {
    backdrop.classList.remove("open");
    backdrop.innerHTML = "";
  }
  setState({ activeDrawerBotName: "", drawerFocusField: "" });
  if (previousFocus && typeof previousFocus.focus === "function") {
    try {
      previousFocus.focus();
    } catch {
      // ignore
    }
  }
  previousFocus = null;
}

async function loadReadiness(botName) {
  readinessCache.set(botName, { loading: true, result: null, error: "" });
  renderBotDrawer();
  try {
    const result = await api.checkBotReadiness(botName);
    readinessCache.set(botName, { loading: false, result, error: "" });
  } catch (error) {
    readinessCache.set(botName, { loading: false, result: null, error: formatIpcError(error) });
  }
  renderBotDrawer();
}

async function loadLogs(botName) {
  logState.loading = true;
  logState.error = "";
  renderBotDrawer();
  try {
    const result = await api.readBotLogs({
      name: botName,
      stream: logState.stream,
      lines: logState.lines,
    });
    logState.data = result;
  } catch (error) {
    logState.error = formatIpcError(error);
  } finally {
    logState.loading = false;
  }
  renderBotDrawer();
}

function renderPathRow(label, filePath, extraHint = "") {
  if (!filePath) return "";
  return `
    <div class="path-row">
      <div class="path-row-main">
        <span class="path-label">${escapeHtml(label)}${extraHint ? ` <span class="text-muted">（${escapeHtml(extraHint)}）</span>` : ""}</span>
        <span class="path-value" title="${escapeHtml(filePath)}">${escapeHtml(filePath)}</span>
      </div>
      <div class="inline-actions">
        <button class="btn btn-sm" type="button" data-open-path="${escapeHtml(filePath)}">打开</button>
        <button class="btn btn-sm" type="button" data-copy-path="${escapeHtml(filePath)}">复制</button>
      </div>
    </div>
  `;
}

function renderConfigTab(bot, state) {
  const engine = normalizeEngine(bot.engine);
  const efforts = ["low", "medium", "high", "xhigh", "max"];
  let authSection = "";
  let providerSection = "";

  if (engine === "antigravity") {
    const currentMode = bot.antigravity?.permissionMode || "always-proceed";
    const providers = state?.antigravityConfiguration?.providers || [];
    const currentProviderId = bot.provider?.id || "official";
    const currentModel = bot.provider?.model || "";
    const currentReasoning = bot.provider?.reasoning || "";
    const modeOptions = [
      ["always-proceed", "完全授权（always-proceed · 无需逐次 /approve）"],
      ["default", "交互审批（default · 敏感工具需飞书内 /approve）"],
      ...(currentMode === "accept-edits" ? [["accept-edits", "自动接受编辑（accept-edits）"]] : []),
      ...(currentMode === "plan" ? [["plan", "只规划（plan）"]] : []),
    ];
    authSection = `
      <div class="field">
        <label for="cfg-perm-mode">工具授权模式</label>
        <select class="select" id="cfg-perm-mode" name="permissionMode">
          ${modeOptions.map(([val, text]) => `<option value="${escapeHtml(val)}" ${val === currentMode ? "selected" : ""}>${escapeHtml(text)}</option>`).join("")}
        </select>
        <span class="field-hint">修改后若 Bot 空闲会自动平滑重启生效；若有在途任务则加入空闲重载队列。</span>
      </div>
    `;
    providerSection = `
      <div class="form-grid-2">
        <div class="field">
          <label for="cfg-provider">默认渠道</label>
          <select class="select" id="cfg-provider" name="providerId">
            ${providers.map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === currentProviderId ? "selected" : ""}>${escapeHtml(p.name || p.id)}</option>`).join("") || `<option value="official">官方登录</option>`}
          </select>
        </div>
        <div class="field">
          <label for="cfg-reasoning">默认思考强度</label>
          <select class="select" id="cfg-reasoning" name="reasoning">
            <option value="" ${!currentReasoning ? "selected" : ""}>原生默认</option>
            ${efforts.map((effort) => `<option value="${effort}" ${effort === currentReasoning ? "selected" : ""}>${effort}</option>`).join("")}
          </select>
        </div>
        <div class="field form-span-2">
          <label for="cfg-model">默认模型（留空使用原生默认）</label>
          <input class="input" id="cfg-model" name="model" value="${escapeHtml(currentModel)}" placeholder="例如 gemini-4-neon 或留空" />
        </div>
      </div>
    `;
  } else if (engine === "claude") {
    const currentMode = bot.claude?.permissionMode || "bypassPermissions";
    const providers = state?.claudeProviders?.providers || [];
    const currentProviderId = bot.provider?.id || "";
    const currentModel = bot.provider?.model || "";
    const currentReasoning = bot.provider?.reasoning || "high";
    authSection = `
      <div class="field">
        <label for="cfg-perm-mode">工具授权模式</label>
        <select class="select" id="cfg-perm-mode" name="permissionMode">
          <option value="bypassPermissions" ${currentMode === "bypassPermissions" ? "selected" : ""}>完全授权（bypassPermissions · 无需逐次 /approve）</option>
          <option value="manual" ${currentMode === "manual" ? "selected" : ""}>交互审批（manual · 敏感工具需飞书内 /approve）</option>
        </select>
        <span class="field-hint">Claude 默认完全授权，也可按需切换为手动审批。</span>
      </div>
    `;
    providerSection = `
      <div class="form-grid-2">
        <div class="field">
          <label for="cfg-provider">Claude 渠道</label>
          <select class="select" id="cfg-provider" name="providerId">
            ${providers.map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === currentProviderId ? "selected" : ""}>${escapeHtml(p.name || p.id)}${p.credentialAvailable ? "" : "（缺 Key）"}</option>`).join("") || `<option value="">未配置 Claude 渠道</option>`}
          </select>
        </div>
        <div class="field">
          <label for="cfg-reasoning">默认思考强度</label>
          <select class="select" id="cfg-reasoning" name="reasoning">
            ${efforts.map((effort) => `<option value="${effort}" ${effort === currentReasoning ? "selected" : ""}>${effort}</option>`).join("")}
          </select>
        </div>
        <div class="field form-span-2">
          <label for="cfg-model">默认模型</label>
          <input class="input" id="cfg-model" name="model" value="${escapeHtml(currentModel)}" placeholder="填写所选渠道支持的模型 ID" />
        </div>
      </div>
    `;
  } else {
    const accounts = state?.modelSources?.accounts || [];
    const currentAlias = bot.openaiAccount || "";
    authSection = `
      <div class="field">
        <label>工具授权策略</label>
        <input class="input" id="cfg-perm-mode" value="完全授权（approvalPolicy=never · danger-full-access）" readonly />
        <span class="field-hint">Codex 受管 Bot 默认采用完全授权沙箱策略。</span>
      </div>
    `;
    providerSection = `
      <div class="form-grid-2">
        <div class="field">
          <label>配置归属</label>
          <input class="input" value="${escapeHtml(bot.codexHomeMode === "isolated" ? `隔离空间（${bot.workspaceFactory?.spaceName || "独立空间"}）` : "全局 Codex 配置")}" readonly />
        </div>
        <div class="field">
          <label for="cfg-openai-account">绑定 OpenAI 官方账号</label>
          <select class="select" id="cfg-openai-account">
            <option value="" ${!currentAlias ? "selected" : ""}>跟随所属 Codex Home 默认</option>
            ${accounts.map((acc) => `<option value="${escapeHtml(acc.alias)}" ${acc.alias === currentAlias ? "selected" : ""}>${escapeHtml(acc.email || acc.alias)}</option>`).join("")}
          </select>
        </div>
      </div>
    `;
  }

  return `
    <form id="drawer-config-form" class="item-list">
      <div class="field">
        <label for="cfg-label">Bot 显示名称</label>
        <input class="input" id="cfg-label" name="label" value="${escapeHtml(bot.label || bot.name)}" required maxlength="100" />
      </div>
      ${authSection}
      ${providerSection}
      <label class="checkbox-row">
        <input type="checkbox" id="cfg-autostart" ${bot.autoStart ? "checked" : ""} />
        <span>
          <strong>开机自动恢复运行</strong>
          <div class="field-hint">桌面端启动后自动拉起并在异常退出时按退避策略恢复此 Bot。</div>
        </span>
      </label>
    </form>

    <div class="card">
      <div class="card-header">
        <div>
          <h3 class="card-title">真实工作目录与数据路径</h3>
          <div class="card-sub">来自受管实例真实配置，支持一键打开或复制</div>
        </div>
      </div>
      <div class="card-body">
        ${renderPathRow("工作空间", bot.workspace)}
        ${engine === "codex" ? renderPathRow("Codex Home", bot.codexHome) : ""}
        ${engine === "claude" ? renderPathRow("Claude Home", bot.claudeHome) : ""}
        ${engine === "antigravity" ? renderPathRow("Antigravity Home", bot.antigravityHome || state?.antigravityConfiguration?.home, "全 Antigravity 共享登录目录") : ""}
        ${renderPathRow("运行态目录", bot.runtimeRoot)}
      </div>
    </div>
  `;
}

function renderReadinessTab(bot) {
  const entry = readinessCache.get(bot.name);
  const checks = entry?.result?.checks || [];
  const authInFlight = larkAuthBotName === bot.name;
  return `
    <div class="inline-actions">
      <button class="btn btn-sm btn-primary" type="button" id="btn-drawer-check-readiness" ${entry?.loading ? "disabled" : ""}>
        ${entry?.loading ? "检查中..." : "重新检查"}
      </button>
      <button class="btn btn-sm" type="button" id="btn-drawer-copy-policy">复制推荐权限 JSON</button>
      <button class="btn btn-sm" type="button" id="btn-drawer-console-perm">打开权限管理</button>
      <button class="btn btn-sm" type="button" id="btn-drawer-console-event">打开事件配置</button>
      <button class="btn btn-sm" type="button" id="btn-drawer-lark-auth" ${authInFlight ? "disabled" : ""}>
        ${authInFlight ? "等待浏览器授权..." : "登录 Lark CLI 用户身份"}
      </button>
      ${authInFlight ? `<button class="btn btn-sm btn-danger" type="button" id="btn-drawer-lark-auth-cancel">取消授权</button>` : ""}
    </div>
    ${entry?.error ? `<div class="alert-row danger"><div class="alert-text">${escapeHtml(entry.error)}</div></div>` : ""}
    ${entry?.loading ? `<div class="loading-band">正在检查飞书应用、事件订阅、Lark CLI 身份与模型渠道...</div>` : ""}
    ${checks.length ? `
      <div class="card">
        <div class="item-list">
          ${checks.map((item) => {
            const pillClass = item.status === "good" ? "pill-ok" : item.status === "warn" ? "pill-warn" : "pill-danger";
            const statusText = item.status === "good" ? "就绪" : item.status === "warn" ? "提示" : "未就绪";
            return `
              <div class="item-row">
                <div class="item-main">
                  <div class="item-title">
                    <span>${escapeHtml(item.label || item.id)}</span>
                    <span class="pill ${pillClass}">${statusText}</span>
                  </div>
                  <div class="item-sub-wrap">${escapeHtml(item.detail || "")}</div>
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    ` : (!entry?.loading && !entry?.error ? `<div class="empty-state"><div class="empty-state-sub">点击“重新检查”执行飞书与运行环境实时就绪核验。</div></div>` : "")}
  `;
}

function renderLogsTab(bot) {
  const engine = normalizeEngine(bot.engine);
  const streams = [
    ["stdout", "标准输出 (stdout)"],
    ["stderr", "错误输出 (stderr)"],
    ...(engine === "antigravity" ? [["acp", "Antigravity ACP 日志"]] : []),
  ];
  const data = logState.data;
  return `
    <div class="inline-actions">
      <select class="select select-sm" id="log-stream-select" aria-label="日志流">
        ${streams.map(([val, label]) => `<option value="${val}" ${val === logState.stream ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}
      </select>
      <select class="select select-sm" id="log-lines-select" aria-label="读取行数">
        ${[100, 200, 500].map((n) => `<option value="${n}" ${n === logState.lines ? "selected" : ""}>最近 ${n} 行</option>`).join("")}
      </select>
      <button class="btn btn-sm btn-primary" type="button" id="btn-log-refresh" ${logState.loading ? "disabled" : ""}>
        ${logState.loading ? "读取中..." : "刷新日志"}
      </button>
      <button class="btn btn-sm" type="button" id="btn-log-copy" ${!data?.text ? "disabled" : ""}>复制日志</button>
    </div>
    ${logState.error ? `<div class="alert-row danger"><div class="alert-text">${escapeHtml(logState.error)}</div></div>` : ""}
    ${data ? `
      <div class="field-hint mono">
        ${escapeHtml(data.filePath || "")} ${data.updatedAt ? `· 更新于 ${escapeHtml(data.updatedAt)}` : ""} ${data.truncated ? "· 已截断至末尾 256 KiB" : ""}
      </div>
      <pre class="log-box" id="log-viewer-box">${escapeHtml(data.exists ? (data.text || "（日志文件当前为空）") : "（日志文件尚未生成）")}</pre>
    ` : `<pre class="log-box" id="log-viewer-box">${logState.loading ? "正在加载并脱敏日志..." : "点击“刷新日志”读取最近运行日志（自动脱敏密钥）。"}</pre>`}
  `;
}

export function renderBotDrawer() {
  const backdrop = document.getElementById("bot-drawer");
  if (!backdrop) return;
  const botName = store.activeDrawerBotName;
  if (!botName) {
    backdrop.classList.remove("open");
    backdrop.innerHTML = "";
    return;
  }

  const state = store.desktopState;
  const bot = getManagedBots(state).find((item) => item.name === botName);
  if (!bot) {
    closeBotDrawer();
    return;
  }

  const engine = normalizeEngine(bot.engine);
  const enginePillClass = engine === "claude" ? "pill-claude" : engine === "antigravity" ? "pill-agy" : "pill-codex";
  const runs = Number(bot.activeRunCount || 0);
  const statusPill = bot.online
    ? (runs > 0 ? `<span class="pill pill-busy"><span class="dot"></span>运行中 (${runs})</span>` : `<span class="pill pill-ok"><span class="dot"></span>在线 · 空闲</span>`)
    : `<span class="pill pill-neutral">离线</span>`;
  const tab = store.drawerTab || "config";

  backdrop.innerHTML = `
    <div class="drawer">
      <div class="drawer-head">
        <div class="item-main">
          <div class="item-title">
            <h2 class="card-title" id="drawer-title">${escapeHtml(bot.label || bot.name)}</h2>
            <span class="pill ${enginePillClass}">${escapeHtml(engineLabel(engine))}</span>
            ${statusPill}
          </div>
          <div class="item-sub mono">${escapeHtml(bot.name)}${bot.processId ? ` · PID ${escapeHtml(bot.processId)}` : ""} · 活动任务 ${runs}</div>
        </div>
        <button class="btn btn-ghost btn-sm" type="button" id="btn-drawer-close" aria-label="关闭抽屉">✕</button>
      </div>

      <div class="drawer-tabs" role="tablist">
        <button class="dtab ${tab === "config" ? "active" : ""}" type="button" data-dtab="config" role="tab">配置与授权</button>
        <button class="dtab ${tab === "readiness" ? "active" : ""}" type="button" data-dtab="readiness" role="tab">飞书就绪检查</button>
        <button class="dtab ${tab === "logs" ? "active" : ""}" type="button" data-dtab="logs" role="tab">实时日志</button>
      </div>

      <div class="drawer-body">
        <div id="drawer-panel-config" class="${tab === "config" ? "" : "hidden"}">${tab === "config" ? renderConfigTab(bot, state) : ""}</div>
        <div id="drawer-panel-readiness" class="${tab === "readiness" ? "" : "hidden"}">${tab === "readiness" ? renderReadinessTab(bot) : ""}</div>
        <div id="drawer-panel-logs" class="${tab === "logs" ? "" : "hidden"}">${tab === "logs" ? renderLogsTab(bot) : ""}</div>
      </div>

      <div class="drawer-foot">
        <button class="btn btn-danger btn-sm" type="button" id="btn-drawer-delete">删除 Bot</button>
        <div class="inline-actions">
          <button class="btn btn-sm" type="button" id="btn-drawer-toggle-run">${bot.online ? "停止" : "启动"}</button>
          <button class="btn btn-sm" type="button" id="btn-drawer-safe-restart" ${!bot.online || runs > 0 ? "disabled" : ""} title="${runs > 0 ? "有在途任务，跳过安全重启" : "仅在空闲时平滑重启"}">安全重启</button>
          ${tab === "config" ? `<button class="btn btn-primary btn-sm" type="button" id="btn-drawer-save">保存配置</button>` : ""}
        </div>
      </div>
    </div>
  `;

  backdrop.classList.add("open");
  backdrop.onclick = (event) => {
    if (event.target === backdrop) closeBotDrawer();
  };

  backdrop.querySelector("#btn-drawer-close")?.addEventListener("click", closeBotDrawer);

  backdrop.querySelectorAll("[data-dtab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nextTab = btn.dataset.dtab;
      setState({ drawerTab: nextTab, drawerFocusField: "" });
      if (nextTab === "readiness") void loadReadiness(bot.name);
      if (nextTab === "logs") void loadLogs(bot.name);
    });
  });

  // Path open/copy buttons
  backdrop.querySelectorAll("[data-open-path]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        const res = await api.openPath(btn.dataset.openPath);
        if (res && res.ok === false) showToast(res.error || "无法打开路径", "error");
      } catch (error) {
        showToast(formatIpcError(error), "error");
      }
    });
  });
  backdrop.querySelectorAll("[data-copy-path]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await api.copyPath(btn.dataset.copyPath);
        showToast("路径已复制到剪贴板", "ok");
      } catch (error) {
        showToast(formatIpcError(error), "error");
      }
    });
  });

  // Config tab interactions
  const autostartInput = backdrop.querySelector("#cfg-autostart");
  autostartInput?.addEventListener("change", async () => {
    autostartInput.disabled = true;
    try {
      await api.setBotAutoStart({ name: bot.name, enabled: autostartInput.checked });
      showToast(autostartInput.checked ? "已开启开机自动恢复" : "已关闭开机自动恢复", "ok");
      await refreshCallback?.({ force: false });
    } catch (error) {
      autostartInput.checked = !autostartInput.checked;
      showToast(formatIpcError(error), "error");
    } finally {
      autostartInput.disabled = false;
    }
  });

  const openaiSelect = backdrop.querySelector("#cfg-openai-account");
  openaiSelect?.addEventListener("change", async () => {
    openaiSelect.disabled = true;
    try {
      await api.setBotOpenAiAccount({ name: bot.name, alias: openaiSelect.value });
      showToast("已更新 OpenAI 绑定账号", "ok");
      await refreshCallback?.({ force: true });
    } catch (error) {
      showToast(formatIpcError(error), "error");
      await refreshCallback?.({ force: false });
    } finally {
      openaiSelect.disabled = false;
    }
  });

  const saveBtn = backdrop.querySelector("#btn-drawer-save");
  saveBtn?.addEventListener("click", async () => {
    const form = backdrop.querySelector("#drawer-config-form");
    if (!form) return;
    const payload = { name: bot.name };
    const labelInput = form.querySelector("#cfg-label");
    if (labelInput) payload.label = labelInput.value.trim();
    if (engine === "antigravity" || engine === "claude") {
      const perm = form.querySelector("#cfg-perm-mode");
      const prov = form.querySelector("#cfg-provider");
      const model = form.querySelector("#cfg-model");
      const reasoning = form.querySelector("#cfg-reasoning");
      if (perm) payload.permissionMode = perm.value;
      if (prov && prov.value) payload.providerId = prov.value;
      if (model) payload.model = model.value.trim();
      if (reasoning) payload.reasoning = reasoning.value;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = "处理中...";
    try {
      const res = await api.updateBotConfig(payload);
      const statusMsg = res.applied === "restarted"
        ? "配置已保存并自动平滑重启 Bot。"
        : res.applied === "queued-idle-reload"
          ? "配置已保存；Bot 当前有在途任务，已加入空闲重载队列。"
          : "配置已保存（Bot 当前离线，下次启动时生效）。";
      showToast(statusMsg, "ok");
      await refreshCallback?.({ force: true });
    } catch (error) {
      showToast(formatIpcError(error), "error");
      saveBtn.disabled = false;
      saveBtn.textContent = "保存配置";
    }
  });

  // Footer Start/Stop, Safe Restart, Delete
  const toggleBtn = backdrop.querySelector("#btn-drawer-toggle-run");
  toggleBtn?.addEventListener("click", async () => {
    toggleBtn.disabled = true;
    toggleBtn.textContent = "处理中...";
    try {
      if (bot.online) {
        await api.stopBot(bot.name);
        showToast(`已停止 ${bot.label || bot.name}`, "ok");
      } else {
        await api.startBot(bot.name);
        showToast(`已启动 ${bot.label || bot.name}`, "ok");
      }
      await refreshCallback?.({ force: false });
    } catch (error) {
      showToast(formatIpcError(error), "error");
      toggleBtn.disabled = false;
      toggleBtn.textContent = bot.online ? "停止" : "启动";
    }
  });

  const safeRestartBtn = backdrop.querySelector("#btn-drawer-safe-restart");
  safeRestartBtn?.addEventListener("click", async () => {
    safeRestartBtn.disabled = true;
    safeRestartBtn.textContent = "处理中...";
    try {
      const result = await api.restartBots({ names: [bot.name], force: false });
      const label = bot.label || bot.name;
      if (result?.failed?.length) {
        showToast(`重启 ${label} 失败：${result.failed[0]?.error || "未知错误"}`, "error");
      } else if (result?.skippedActive?.length) {
        showToast(`${label} 当前有活跃任务，已跳过安全重启`, "warn");
      } else if (result?.skippedOffline?.length) {
        showToast(`${label} 当前未运行，无需重启`, "warn");
      } else {
        showToast(`已安全重启 ${label}`, "ok");
      }
      await refreshCallback?.({ force: false });
    } catch (error) {
      showToast(formatIpcError(error), "error");
      safeRestartBtn.disabled = false;
      safeRestartBtn.textContent = "安全重启";
    }
  });

  const deleteBtn = backdrop.querySelector("#btn-drawer-delete");
  deleteBtn?.addEventListener("click", async () => {
    deleteBtn.disabled = true;
    try {
      const preview = await api.previewManagedRemoval({ kind: "bot", id: bot.name });
      const activeRuns = (preview.bots || []).reduce((sum, item) => sum + Number(item.activeRunCount || 0), 0);
      const boxes = [
        {
          name: "deleteWorkspaces",
          label: "同时删除工作空间目录",
          hint: preview.paths?.workspace || "",
          checked: false,
        },
        {
          name: "deleteRuntime",
          label: "清理运行态日志与会话状态",
          hint: preview.paths?.runtimeRoot || "",
          checked: true,
        },
      ];
      if (engine === "antigravity" && preview.paths?.antigravityHome) {
        const sharedCount = Number(preview.sharedAntigravityHomeBotCount || 0);
        boxes.push({
          name: "deleteAntigravityHome",
          label: "删除 Antigravity 共享登录目录",
          hint: sharedCount > 0
            ? `仍有其他 ${sharedCount} 个 Antigravity Bot 共用此目录，已锁定禁止删除。`
            : preview.paths.antigravityHome,
          checked: false,
          disabled: sharedCount > 0,
        });
      }
      openConfirmModal({
        title: preview.title || `删除 ${bot.label || bot.name}`,
        description: "此操作仅移除本机受管 Bot 配置与运行状态，不会删除飞书云端应用。",
        warning: activeRuns > 0 ? `该 Bot 当前有 ${activeRuns} 个活动任务正在运行，请等待任务结束后再删除。` : "",
        disabledReason: activeRuns > 0 ? "存在活动任务，已阻断删除操作。" : "",
        details: [
          ["Bot 标识", bot.name],
          ["引擎", engineLabel(engine)],
          ["工作空间", preview.paths?.workspace || ""],
        ],
        checkboxes: boxes,
        danger: true,
        confirmLabel: "确认删除 Bot",
        onConfirm: async (values) => {
          await api.applyManagedRemoval({
            kind: "bot",
            id: bot.name,
            deleteWorkspaces: values.deleteWorkspaces === true,
            deleteRuntime: values.deleteRuntime !== false,
            deleteAntigravityHome: values.deleteAntigravityHome === true,
          });
          showToast(`已删除 ${bot.label || bot.name}`, "ok");
          closeBotDrawer();
          await refreshCallback?.({ force: true });
        },
      });
    } catch (error) {
      showToast(formatIpcError(error), "error");
    } finally {
      deleteBtn.disabled = false;
    }
  });

  // Readiness tab actions
  backdrop.querySelector("#btn-drawer-check-readiness")?.addEventListener("click", () => void loadReadiness(bot.name));
  backdrop.querySelector("#btn-drawer-copy-policy")?.addEventListener("click", async () => {
    try {
      await api.copyPermissionPolicy(bot.name);
      showToast("推荐权限与事件配置 JSON 已复制", "ok");
    } catch (error) {
      showToast(formatIpcError(error), "error");
    }
  });
  backdrop.querySelector("#btn-drawer-console-perm")?.addEventListener("click", async () => {
    try {
      await api.openFeishuConsole({ name: bot.name, section: "permission" });
    } catch (error) {
      showToast(formatIpcError(error), "error");
    }
  });
  backdrop.querySelector("#btn-drawer-console-event")?.addEventListener("click", async () => {
    try {
      await api.openFeishuConsole({ name: bot.name, section: "event" });
    } catch (error) {
      showToast(formatIpcError(error), "error");
    }
  });
  backdrop.querySelector("#btn-drawer-lark-auth")?.addEventListener("click", async () => {
    if (larkAuthBotName === bot.name) return;
    larkAuthBotName = bot.name;
    renderBotDrawer();
    try {
      await api.authorizeLarkUser(bot.name);
      if (larkAuthBotName === bot.name) larkAuthBotName = "";
      showToast("Lark CLI 用户身份授权完成", "ok");
      await loadReadiness(bot.name);
    } catch (error) {
      const msg = formatIpcError(error);
      if (msg.includes("已取消飞书用户授权")) {
        showToast("已取消飞书用户授权", "info");
      } else {
        showToast(msg, "error");
      }
    } finally {
      if (larkAuthBotName === bot.name) {
        larkAuthBotName = "";
        renderBotDrawer();
      }
    }
  });
  backdrop.querySelector("#btn-drawer-lark-auth-cancel")?.addEventListener("click", async () => {
    try {
      await api.cancelLarkUserAuth();
    } catch (error) {
      showToast(formatIpcError(error), "error");
    } finally {
      if (larkAuthBotName === bot.name) {
        larkAuthBotName = "";
        renderBotDrawer();
      }
    }
  });

  // Logs tab actions
  backdrop.querySelector("#log-stream-select")?.addEventListener("change", (event) => {
    logState.stream = event.target.value;
    void loadLogs(bot.name);
  });
  backdrop.querySelector("#log-lines-select")?.addEventListener("change", (event) => {
    logState.lines = Number(event.target.value) || 200;
    void loadLogs(bot.name);
  });
  backdrop.querySelector("#btn-log-refresh")?.addEventListener("click", () => void loadLogs(bot.name));
  backdrop.querySelector("#btn-log-copy")?.addEventListener("click", async () => {
    if (!logState.data?.text) return;
    try {
      await navigator.clipboard.writeText(logState.data.text);
      showToast("脱敏日志已复制到剪贴板", "ok");
    } catch {
      showToast("浏览器剪贴板写入失败", "error");
    }
  });

  if (store.drawerFocusField) {
    const target = backdrop.querySelector(`#${store.drawerFocusField}`);
    if (target && typeof target.focus === "function") {
      target.focus();
      store.drawerFocusField = "";
    }
  }
}
