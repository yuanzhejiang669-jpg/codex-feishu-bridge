import { api, formatIpcError, subscribeEvents } from "./ipc.js";
import { computeOverviewMetrics, setState, store, subscribe } from "./state.js";
import { renderOverview } from "./views/overview.js";
import { renderBotsView } from "./views/bots.js";
import { renderProvidersView } from "./views/providers.js";
import { renderCapabilitiesView } from "./views/capabilities.js";
import { renderSystemView } from "./views/system.js";
import {
  closeBotDrawer,
  configureBotDrawer,
  isBotDrawerOpen,
  openBotDrawer,
  renderBotDrawer,
} from "./components/bot-drawer.js";
import {
  closeCreateWizard,
  configureCreateWizard,
  handleWizardRegistrationProgress,
  isCreateWizardOpen,
  openCreateWizard,
  renderCreateWizard,
} from "./components/create-wizard.js";
import { closeConfirmModal, isConfirmModalOpen } from "./components/confirm-modal.js";
import { showToast } from "./components/toast.js";

const VIEW_META = {
  overview: { title: "总览", desc: "三引擎实时健康状态与待处理提醒" },
  bots: { title: "Bot 中心", desc: "管理全部受管 Bot 运行状态、授权策略与滚动重启" },
  providers: { title: "渠道与账号", desc: "按引擎管理官方登录账号、第三方 Provider 与协议代理" },
  capabilities: { title: "工具与技能", desc: "跨引擎 MCP 健康矩阵、共享工具库编辑与能力迁移" },
  system: { title: "系统与诊断", desc: "客户端版本更新、主用户归属边界、目录与隔离空间管理" },
};

let refreshInFlight = null;
let pollTimer = null;
let lastRenderedView = "";

function navigateTo(view) {
  if (!VIEW_META[view]) return;
  setState({ activeView: view });
}

async function runMcpProbe() {
  if (store.busyActions.has("probe-mcp-health")) return;
  setState((s) => { s.busyActions.add("probe-mcp-health"); });
  try {
    const result = await api.probeMcpHealth();
    setState({ mcpHealth: result });
    showToast("已完成工具链与 MCP 最小无副作用探针", "ok");
  } catch (error) {
    showToast(formatIpcError(error), "error");
  } finally {
    setState((s) => { s.busyActions.delete("probe-mcp-health"); });
  }
}

export async function refreshState({ force = false, silent = false } = {}) {
  if (refreshInFlight) return refreshInFlight;
  const refreshBtn = document.getElementById("btn-refresh");
  if (!silent && refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "刷新中...";
  }
  refreshInFlight = (async () => {
    try {
      const nextState = await api.getState({ force });
      setState({
        desktopState: nextState,
        appVersion: nextState?.app?.version || store.appVersion,
        loading: false,
        lastError: "",
      });
      return nextState;
    } catch (error) {
      const msg = formatIpcError(error);
      setState({ loading: false, lastError: msg });
      if (!silent) showToast(msg, "error");
      return null;
    } finally {
      refreshInFlight = null;
      if (!silent && refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.textContent = "刷新状态";
      }
    }
  })();
  return refreshInFlight;
}

const sharedActions = {
  onRefresh: refreshState,
  onNavigate: navigateTo,
  onOpenBotDrawer: openBotDrawer,
  onOpenWizard: openCreateWizard,
  onRunMcpProbe: runMcpProbe,
};

function renderShell(current) {
  const state = current.desktopState;
  const versionText = current.appVersion ? `v${current.appVersion}` : "v...";
  const versionEl = document.getElementById("app-version");
  if (versionEl) versionEl.textContent = versionText;

  // Loading band
  const loadingBand = document.getElementById("loading-band");
  if (loadingBand) loadingBand.classList.toggle("hidden", !current.loading);

  // Global error recovery band
  const errorMessage = current.lastError || state?.setup?.startupError || "";
  const errorBand = document.getElementById("error-band");
  const errorMsgEl = document.getElementById("error-band-message");
  if (errorBand && errorMsgEl) {
    errorMsgEl.textContent = errorMessage;
    errorBand.classList.toggle("hidden", !errorMessage);
  }

  // Sidebar navigation active state & badges
  const metrics = state ? computeOverviewMetrics(state, current.mcpHealth) : null;
  document.querySelectorAll(".nav-item[data-view]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === current.activeView);
  });

  const overviewBadge = document.getElementById("nav-badge-overview");
  if (overviewBadge) {
    const count = metrics?.alerts?.length || 0;
    overviewBadge.textContent = `${count} 提醒`;
    overviewBadge.classList.toggle("hidden", count === 0);
    overviewBadge.classList.toggle("warn", count > 0);
  }

  const botsBadge = document.getElementById("nav-badge-bots");
  if (botsBadge) {
    botsBadge.textContent = String(metrics?.totalCount ?? 0);
  }

  const capBadge = document.getElementById("nav-badge-capabilities");
  if (capBadge) {
    const badCount = metrics?.mcpSummary?.unhealthyCount || 0;
    capBadge.textContent = `${badCount} 异常`;
    capBadge.classList.toggle("hidden", badCount === 0);
    capBadge.classList.toggle("warn", badCount > 0);
  }

  // Sidebar footer
  const onlineEl = document.getElementById("footer-online");
  const runsEl = document.getElementById("footer-runs");
  const modeEl = document.getElementById("footer-mode");
  if (onlineEl) onlineEl.textContent = `${metrics?.onlineCount ?? 0} / ${metrics?.totalCount ?? 0}`;
  if (runsEl) runsEl.textContent = `${metrics?.activeRunsTotal ?? 0} 活动`;
  if (modeEl && state?.setup?.mode) {
    const isProd = state.setup.mode === "production";
    modeEl.textContent = isProd ? "生产模式" : "开发沙箱";
    modeEl.className = `pill ${isProd ? "pill-ok" : "pill-neutral"}`;
  }

  // Topbar title & description
  const meta = VIEW_META[current.activeView] || VIEW_META.overview;
  const titleEl = document.getElementById("page-title");
  const descEl = document.getElementById("page-desc");
  if (titleEl) titleEl.textContent = meta.title;
  if (descEl) descEl.textContent = meta.desc;

  // Toggle active view section & render only active view
  for (const key of Object.keys(VIEW_META)) {
    const section = document.getElementById(`view-${key}`);
    if (section) section.classList.toggle("active", key === current.activeView);
  }

  const mainContent = document.querySelector(".main-content");
  const sameView = lastRenderedView === current.activeView;
  const prevScrollTop = mainContent && sameView ? mainContent.scrollTop : 0;
  lastRenderedView = current.activeView;

  if (current.activeView === "overview") {
    renderOverview(document.getElementById("view-overview"), sharedActions);
  } else if (current.activeView === "bots") {
    renderBotsView(document.getElementById("view-bots"), sharedActions);
  } else if (current.activeView === "providers") {
    renderProvidersView(document.getElementById("view-providers"), sharedActions);
  } else if (current.activeView === "capabilities") {
    renderCapabilitiesView(document.getElementById("view-capabilities"), sharedActions);
  } else if (current.activeView === "system") {
    renderSystemView(document.getElementById("view-system"), sharedActions);
  }

  if (mainContent) mainContent.scrollTop = prevScrollTop;

  if (isBotDrawerOpen()) renderBotDrawer();
  if (isCreateWizardOpen()) renderCreateWizard();
}

function isUserEditingForm() {
  if (document.querySelector(".view-section.active details[open]")) return true;
  const el = document.activeElement;
  if (!el) return false;
  const tag = String(el.tagName || "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT" && el.id !== "bot-search") return true;
  return false;
}

function scheduleBackgroundPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (document.hidden) return;
    if (isConfirmModalOpen() || isCreateWizardOpen() || isBotDrawerOpen()) return;
    if (isUserEditingForm()) return;
    const loginStatus = store.desktopState?.modelSources?.accountLoginJob?.status;
    const force = ["running", "finishing"].includes(loginStatus);
    void refreshState({ force, silent: true });
  }, 10_000);
}

export async function initApp() {
  configureBotDrawer({ onRefresh: refreshState });
  configureCreateWizard({ onRefresh: refreshState });

  subscribe(renderShell);

  document.querySelectorAll(".nav-item[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => navigateTo(btn.dataset.view));
  });

  document.getElementById("btn-refresh")?.addEventListener("click", () => {
    void refreshState({ force: true });
  });

  document.getElementById("btn-retry-state")?.addEventListener("click", () => {
    void refreshState({ force: true });
  });

  document.getElementById("btn-open-data-root")?.addEventListener("click", async () => {
    const dataRoot = store.desktopState?.setup?.dataRoot;
    if (!dataRoot) {
      showToast("尚未读取到数据目录路径", "warn");
      return;
    }
    try {
      await api.openPath(dataRoot);
    } catch (error) {
      showToast(formatIpcError(error), "error");
    }
  });

  document.getElementById("btn-open-wizard")?.addEventListener("click", () => {
    openCreateWizard("single");
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (isConfirmModalOpen()) {
      closeConfirmModal();
    } else if (isCreateWizardOpen()) {
      closeCreateWizard();
    } else if (isBotDrawerOpen()) {
      closeBotDrawer();
    }
  });

  subscribeEvents({
    onRegistrationProgress: (progress) => handleWizardRegistrationProgress(progress),
    onFactoryRegistrationProgress: (progress) => handleWizardRegistrationProgress(progress),
    onBotRestartProgress: (progress) => {
      const total = Number(progress?.total || 0);
      const completed = Number(progress?.completed || 0);
      const done = !progress || total <= 0 || completed >= total;
      setState({ restartProgress: done ? null : progress });
    },
    onUpdateState: (updateState) => {
      if (!store.desktopState) return;
      if (isBotDrawerOpen() || isCreateWizardOpen() || isUserEditingForm()) {
        store.desktopState = { ...store.desktopState, update: updateState };
        return;
      }
      setState((s) => {
        if (s.desktopState) s.desktopState = { ...s.desktopState, update: updateState };
      });
    },
  });

  renderShell(store);

  try {
    const version = await api.getVersion();
    if (version) setState({ appVersion: String(version) });
  } catch {
    // will be populated by getState
  }

  await refreshState({ force: true, silent: true });
  scheduleBackgroundPoll();
}

void initApp();
