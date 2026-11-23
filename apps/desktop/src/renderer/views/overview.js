import { escapeHtml } from "../ipc.js";
import { computeOverviewMetrics, store } from "../state.js";

function engineOnlineBadge(bots) {
  const total = bots.length;
  const online = bots.filter((bot) => bot.online).length;
  if (total === 0) return `<span class="pill pill-neutral">0 个 Bot</span>`;
  if (online === total) return `<span class="pill pill-ok"><span class="dot"></span>${online}/${total} 在线</span>`;
  return `<span class="pill pill-warn">${online}/${total} 在线</span>`;
}

function activeMcpCount(list) {
  return (list || []).filter((item) => item && item.disabled !== true).length;
}

export function renderOverview(container, actions = {}) {
  if (!container) return;
  const state = store.desktopState;
  if (!state) {
    container.innerHTML = "";
    return;
  }

  const metrics = computeOverviewMetrics(state, store.mcpHealth);
  const codexBots = metrics.byEngine.codex;
  const claudeBots = metrics.byEngine.claude;
  const agyBots = metrics.byEngine.antigravity;

  const authRateClass = metrics.fullAuthCount < metrics.totalCount ? "text-warn" : "";
  const mcpClass = metrics.mcpSummary.unhealthyCount > 0 ? "text-danger" : "";

  const codexRuntime = state.codex || {};
  const claudeRuntime = state.claude || {};
  const agyRuntime = state.antigravity || {};
  const agyFullAuth = agyBots.every((b) => (b.antigravity?.permissionMode || "always-proceed") === "always-proceed");
  const claudeFullAuth = claudeBots.every((b) => (b.claude?.permissionMode || "bypassPermissions") === "bypassPermissions");

  const codexProviderText = state.providerCatalog?.selectedId
    ? `${state.providerCatalog.selectedId} (${state.providerCatalog.selectedModel || "默认"})`
    : (state.modelSources?.accounts?.length ? `OpenAI 官方多账号 (${state.modelSources.accounts.length})` : (state.provider?.id || "默认配置"));

  const claudeProviderCount = (state.claudeProviders?.providers || []).length;
  const agyProviderCount = (state.antigravityConfiguration?.providers || []).length;
  const agyActiveAccount = state.antigravityConfiguration?.accounts?.activeId || "系统当前登录";

  container.innerHTML = `
    <div class="kpi-grid">
      <div class="card kpi-card">
        <span class="kpi-label">受管 Bot 在线</span>
        <span class="kpi-value">${metrics.onlineCount} / ${metrics.totalCount}</span>
        <span class="kpi-meta">Codex ${codexBots.length} · Claude ${claudeBots.length} · Antigravity ${agyBots.length}</span>
      </div>
      <div class="card kpi-card">
        <span class="kpi-label">当前活动任务</span>
        <span class="kpi-value">${metrics.activeRunsTotal}</span>
        <span class="kpi-meta">空闲 ${metrics.idleOnlineCount} 个 · 支持安全滚动重启</span>
      </div>
      <div class="card kpi-card">
        <span class="kpi-label">默认完全授权一致率</span>
        <span class="kpi-value ${authRateClass}">${metrics.fullAuthCount} / ${metrics.totalCount}</span>
        <span class="kpi-meta">${metrics.nonFullAuthBots.length ? `${metrics.nonFullAuthBots.length} 个 Bot 仍需逐次审批` : "全部已对齐默认完全授权"}</span>
      </div>
      <div class="card kpi-card">
        <span class="kpi-label">工具链与 MCP 健康</span>
        <span class="kpi-value ${mcpClass}">${metrics.mcpSummary.healthyCount} / ${metrics.mcpSummary.totalActive}</span>
        <span class="kpi-meta">${metrics.mcpSummary.probed ? "已运行实时无副作用探针" : "基于本地配置可达性（已排除 disabled）"}</span>
      </div>
    </div>

    <div class="engine-grid">
      <div class="card engine-card">
        <div class="engine-head">
          <span class="pill pill-codex">Codex</span>
          ${engineOnlineBadge(codexBots)}
        </div>
        <div class="engine-meta-list">
          <span class="engine-meta-k">CLI 运行时</span>
          <span class="engine-meta-v mono" title="${escapeHtml(codexRuntime.cliVersion || codexRuntime.version || codexRuntime.error || "")}">${escapeHtml((codexRuntime.runtimeFound || codexRuntime.available) ? `${codexRuntime.cliVersion || codexRuntime.version || "可用"} (app-server)` : (codexRuntime.error || "未检测到"))}</span>
          <span class="engine-meta-k">当前渠道</span>
          <span class="engine-meta-v" title="${escapeHtml(codexProviderText)}">${escapeHtml(codexProviderText)}</span>
          <span class="engine-meta-k">授权策略</span>
          <span class="engine-meta-v text-ok">完全授权 (never / full)</span>
          <span class="engine-meta-k">MCP / Skills</span>
          <span class="engine-meta-v">${activeMcpCount(state.capabilities?.mcpServers)} 活跃 MCP · ${(state.capabilities?.skills || []).length} Skills</span>
        </div>
      </div>

      <div class="card engine-card">
        <div class="engine-head">
          <span class="pill pill-claude">Claude Code</span>
          ${engineOnlineBadge(claudeBots)}
        </div>
        <div class="engine-meta-list">
          <span class="engine-meta-k">CLI 运行时</span>
          <span class="engine-meta-v mono" title="${escapeHtml(claudeRuntime.version || claudeRuntime.error || "")}">${escapeHtml(claudeRuntime.available ? (claudeRuntime.version || "可用") : (claudeRuntime.error || "未检测到"))}</span>
          <span class="engine-meta-k">渠道配置</span>
          <span class="engine-meta-v">${claudeProviderCount} 个已保存渠道</span>
          <span class="engine-meta-k">授权策略</span>
          <span class="engine-meta-v ${claudeFullAuth ? "text-ok" : "text-warn"}">${claudeFullAuth ? "完全授权 (bypassPermissions)" : "存在手动审批 Bot"}</span>
          <span class="engine-meta-k">MCP / Skills</span>
          <span class="engine-meta-v">${activeMcpCount(state.claudeCapabilities?.mcpServers)} 活跃 MCP · ${(state.claudeCapabilities?.skills || []).length} Skills</span>
        </div>
      </div>

      <div class="card engine-card">
        <div class="engine-head">
          <span class="pill pill-agy">Antigravity</span>
          ${engineOnlineBadge(agyBots)}
        </div>
        <div class="engine-meta-list">
          <span class="engine-meta-k">CLI 运行时</span>
          <span class="engine-meta-v mono" title="${escapeHtml(agyRuntime.version || agyRuntime.error || "")}">${escapeHtml(agyRuntime.available ? `${agyRuntime.version || "可用"} (ACP)` : (agyRuntime.error || "未检测到"))}</span>
          <span class="engine-meta-k">账号 / 渠道</span>
          <span class="engine-meta-v" title="${escapeHtml(agyActiveAccount)}">${escapeHtml(agyActiveAccount)} · ${agyProviderCount} 渠道</span>
          <span class="engine-meta-k">授权策略</span>
          <span class="engine-meta-v ${agyFullAuth ? "text-ok" : "text-warn"}">${agyFullAuth ? "完全授权 (always-proceed)" : "存在需审批 Bot"}</span>
          <span class="engine-meta-k">MCP / Skills</span>
          <span class="engine-meta-v">${activeMcpCount(state.antigravityCapabilities?.mcpServers)} 活跃 MCP · ${(state.antigravityCapabilities?.skills || []).length} Skills</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">待处理事项与异常诊断</h2>
          <div class="card-sub">全部条目均由实时受管状态与工具链探针动态生成</div>
        </div>
        <button class="btn btn-sm" type="button" id="btn-overview-probe-mcp">运行工具链探针</button>
      </div>
      <div class="card-body">
        ${metrics.alerts.length ? `
          <div class="alert-list">
            ${metrics.alerts.map((alert) => `
              <div class="alert-row ${alert.severity === "danger" ? "danger" : alert.severity === "info" ? "info" : ""}">
                <div class="alert-text">
                  <strong>${escapeHtml(alert.title)}</strong>
                  <div class="alert-sub">${escapeHtml(alert.detail)}</div>
                </div>
                <button
                  class="btn btn-sm"
                  type="button"
                  data-alert-action="${escapeHtml(alert.actionType)}"
                  data-alert-view="${escapeHtml(alert.view || "")}"
                  data-alert-bot="${escapeHtml(alert.botName || "")}"
                >${escapeHtml(alert.actionLabel)}</button>
              </div>
            `).join("")}
          </div>
        ` : `
          <div class="alert-row ok">
            <div class="alert-text">
              <strong>全部受管 Bot、授权策略与工具链状态正常，当前无待处理事项</strong>
              <div class="alert-sub">所有活跃任务与配置同步状态正常，可随时在 Bot 中心执行安全滚动重启。</div>
            </div>
          </div>
        `}
      </div>
    </div>
  `;

  container.querySelector("#btn-overview-probe-mcp")?.addEventListener("click", () => {
    actions.onRunMcpProbe?.();
  });

  container.querySelectorAll("[data-alert-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const type = btn.dataset.alertAction;
      if (type === "open-bot-auth") {
        actions.onOpenBotDrawer?.(btn.dataset.alertBot, "config", "cfg-perm-mode");
      } else if (type === "open-bot-logs") {
        actions.onOpenBotDrawer?.(btn.dataset.alertBot, "logs");
      } else if (type === "goto-view") {
        actions.onNavigate?.(btn.dataset.alertView || "overview");
      } else if (type === "open-wizard-queue") {
        actions.onOpenWizard?.("queue");
      }
    });
  });
}
