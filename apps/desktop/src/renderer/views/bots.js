import { api, escapeHtml, formatIpcError } from "../ipc.js";
import {
  engineLabel,
  getFilteredBots,
  getManagedBots,
  isBotFullAutoAuth,
  normalizeEngine,
  setState,
  store,
} from "../state.js";
import { openConfirmModal } from "../components/confirm-modal.js";
import { showToast } from "../components/toast.js";

function selectedManagedBotNames() {
  const valid = new Set(getManagedBots(store.desktopState).map((bot) => bot.name));
  return [...store.selectedBotNames].filter((name) => valid.has(name));
}

function shortWorkspaceLabel(fullPath) {
  const raw = String(fullPath || "").trim();
  if (!raw) return "—";
  if (raw.length <= 28) return raw;
  const sep = raw.includes("\\") ? "\\" : "/";
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 1) return raw;
  const last = parts[parts.length - 1];
  const prev = parts[parts.length - 2];
  if (last.length >= 22) return `…${sep}${last}`;
  return `…${sep}${prev}${sep}${last}`;
}

function unadoptedLegacyInstances(state) {
  const managed = new Set(getManagedBots(state).map((bot) => bot.name));
  return (state?.bridge?.instances || []).filter((item) => item?.name && !managed.has(item.name));
}

async function restartSelected(names, force, actions) {
  if (!names.length) return;
  try {
    const result = await api.restartBots({ names, force });
    const restarted = Array.isArray(result?.restarted) ? result.restarted.length : 0;
    const skippedActive = Array.isArray(result?.skippedActive) ? result.skippedActive.length : 0;
    const skippedOffline = Array.isArray(result?.skippedOffline) ? result.skippedOffline.length : 0;
    const failed = Array.isArray(result?.failed) ? result.failed.length : 0;
    const parts = [`已重启 ${restarted} 个`];
    if (skippedActive) parts.push(`跳过 ${skippedActive} 个有在途任务`);
    if (skippedOffline) parts.push(`跳过 ${skippedOffline} 个未运行`);
    if (failed) parts.push(`失败 ${failed} 个`);
    showToast(
      parts.length > 1
        ? parts.join("，")
        : `已完成 ${restarted} 个 Bot 的${force ? "强制" : "安全"}重启`,
      failed ? "error" : (skippedActive || skippedOffline ? "warn" : "ok"),
    );
    store.selectedBotNames.clear();
    await actions.onRefresh?.({ force: false });
  } catch (error) {
    showToast(formatIpcError(error), "error");
  } finally {
    setState({ restartProgress: null });
  }
}

export function renderBotsView(container, actions = {}) {
  if (!container) return;
  const state = store.desktopState;
  if (!state) {
    container.innerHTML = "";
    return;
  }

  const allBots = getManagedBots(state);
  const filteredBots = getFilteredBots(state, store.botFilters);
  const counts = {
    all: allBots.length,
    codex: allBots.filter((b) => normalizeEngine(b.engine) === "codex").length,
    claude: allBots.filter((b) => normalizeEngine(b.engine) === "claude").length,
    antigravity: allBots.filter((b) => normalizeEngine(b.engine) === "antigravity").length,
  };
  const idleOnlineBots = allBots.filter((b) => b.online && Number(b.activeRunCount || 0) === 0);
  const selectedNames = selectedManagedBotNames();
  const legacyInstances = unadoptedLegacyInstances(state);
  const queueBots = state.setup?.workspaceFactory?.bots || [];
  const pendingQueueCount = queueBots.filter((b) => b.status === "pending" || b.status === "failed").length;
  const allFilteredSelected = filteredBots.length > 0 && filteredBots.every((b) => store.selectedBotNames.has(b.name));

  const searchHadFocus = document.activeElement?.id === "bot-search";
  const searchCursor = searchHadFocus ? document.activeElement.selectionStart : null;

  container.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <div class="toolbar-left">
          <div class="segmented" role="tablist" aria-label="按引擎筛选">
            ${[
              ["all", `全部 (${counts.all})`],
              ["codex", `Codex (${counts.codex})`],
              ["claude", `Claude (${counts.claude})`],
              ["antigravity", `Antigravity (${counts.antigravity})`],
            ].map(([val, label]) => `
              <button class="seg-btn ${store.botFilters.engine === val ? "active" : ""}" type="button" data-filter-engine="${val}">${label}</button>
            `).join("")}
          </div>
          <select class="select select-sm" id="bot-status-filter" aria-label="按状态筛选">
            <option value="all" ${store.botFilters.status === "all" ? "selected" : ""}>全部状态</option>
            <option value="idle" ${store.botFilters.status === "idle" ? "selected" : ""}>在线空闲</option>
            <option value="busy" ${store.botFilters.status === "busy" ? "selected" : ""}>运行中</option>
            <option value="offline" ${store.botFilters.status === "offline" ? "selected" : ""}>离线</option>
            <option value="non-full-auth" ${store.botFilters.status === "non-full-auth" ? "selected" : ""}>非完全授权</option>
          </select>
          <input class="input input-sm input-search" id="bot-search" type="search" value="${escapeHtml(store.botFilters.search)}" placeholder="搜索名称 / ID / 渠道 / 目录" aria-label="搜索 Bot" />
        </div>
        <div class="toolbar-right">
          ${pendingQueueCount > 0 ? `<button class="btn btn-sm" type="button" id="btn-bots-open-queue">批量队列 (${pendingQueueCount})</button>` : ""}
          ${legacyInstances.length > 0 ? `<button class="btn btn-primary btn-sm" type="button" id="btn-adopt-legacy">接管现有 Bot (${legacyInstances.length})</button>` : `<button class="btn btn-sm" type="button" id="btn-adopt-legacy">接管现有 Bot</button>`}
          <button class="btn btn-sm" type="button" id="btn-restart-idle" ${idleOnlineBots.length === 0 ? "disabled" : ""}>重启全部空闲 (${idleOnlineBots.length})</button>
        </div>
      </div>

      ${selectedNames.length > 0 ? `
        <div class="selection-bar" id="bot-selection-bar">
          <span>已选择 <strong>${selectedNames.length}</strong> 个受管 Bot</span>
          <div class="inline-actions">
            <button class="btn btn-sm" type="button" id="select-all-bots-button">全选当前筛选</button>
            <button class="btn btn-sm" type="button" id="clear-all-bots-button">取消选择</button>
            <button class="btn btn-primary btn-sm" type="button" id="safe-restart-bots-button">安全重启所选 (${selectedNames.length})</button>
            <button class="btn btn-danger btn-sm" type="button" id="force-restart-bots-button">强制重启所选 (${selectedNames.length})</button>
          </div>
        </div>
      ` : ""}

      ${store.restartProgress ? `
        <div class="loading-band">正在执行 Bot 重启：${escapeHtml(store.restartProgress.message || `${store.restartProgress.completed || 0}/${store.restartProgress.total || 0}`)}</div>
      ` : ""}

      ${allBots.length === 0 ? `
        <div class="empty-state" id="bots-table">
          <div class="empty-state-title">尚未创建受管 Bot</div>
          <div class="empty-state-sub">可点击“+ 新建 Bot”向导创建 Codex、Claude Code 或 Antigravity 受管 Bot，或接管本机已存在的历史脚本 Bot。</div>
          <div class="inline-actions">
            <button class="btn btn-primary" type="button" id="btn-empty-create">+ 新建 Bot</button>
            <button class="btn" type="button" id="btn-empty-adopt">接管现有 Bot</button>
          </div>
        </div>
      ` : filteredBots.length === 0 ? `
        <div class="empty-state" id="bots-table">
          <div class="empty-state-title">没有匹配的 Bot</div>
          <div class="empty-state-sub">当前筛选条件下无结果，可清空筛选查看全部 ${allBots.length} 个受管 Bot。</div>
          <button class="btn btn-sm" type="button" id="btn-clear-bot-filters">清空筛选</button>
        </div>
      ` : `
        <table class="bot-table" id="bots-table">
          <thead>
            <tr>
              <th class="col-check">
                <input type="checkbox" id="bot-select-all" aria-label="全选当前筛选 Bot" ${allFilteredSelected ? "checked" : ""} />
              </th>
              <th class="col-bot">Bot / 引擎</th>
              <th class="col-status">运行状态</th>
              <th class="col-provider">渠道 / 模型 / 授权</th>
              <th class="col-workspace">工作空间</th>
              <th class="col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            ${filteredBots.map((bot) => {
              const engine = normalizeEngine(bot.engine);
              const enginePillClass = engine === "claude" ? "pill-claude" : engine === "antigravity" ? "pill-agy" : "pill-codex";
              const runs = Number(bot.activeRunCount || 0);
              const fullAuth = isBotFullAutoAuth(bot);
              const checked = store.selectedBotNames.has(bot.name);
              const statusHtml = bot.online
                ? (runs > 0
                  ? `<span class="pill pill-busy"><span class="dot"></span>运行中 (${runs})</span>`
                  : `<span class="pill pill-ok"><span class="dot"></span>在线 · 空闲</span>`)
                : `<span class="pill pill-neutral">离线</span>`;
              const providerId = bot.provider?.id || (engine === "codex" ? (bot.openaiAccount || "全局配置") : "official");
              const modelName = bot.provider?.model || (engine === "antigravity" ? "原生默认" : "");
              return `
                <tr data-bot-row="${escapeHtml(bot.name)}">
                  <td class="col-check" data-stop-row-click="1">
                    <input type="checkbox" class="managed-bot-selection" value="${escapeHtml(bot.name)}" aria-label="选择 ${escapeHtml(bot.label || bot.name)}" ${checked ? "checked" : ""} />
                  </td>
                  <td class="col-bot">
                    <div class="bot-name-cell">
                      <div class="bot-name-top">
                        <span class="bot-title" title="${escapeHtml(bot.label || bot.name)}">${escapeHtml(bot.label || bot.name)}</span>
                        <span class="pill ${enginePillClass}">${escapeHtml(engineLabel(engine))}</span>
                      </div>
                      <span class="bot-id mono" title="${escapeHtml(bot.name)}">${escapeHtml(bot.name)}</span>
                    </div>
                  </td>
                  <td class="col-status">
                    <div class="cell-stack">
                      <div>${statusHtml}</div>
                      <span class="bot-id mono">${bot.processId ? `PID ${escapeHtml(bot.processId)}` : "未运行"}${bot.autoStart ? " · 自启" : ""}</span>
                    </div>
                  </td>
                  <td class="col-provider">
                    <div class="cell-stack">
                      <span class="truncate" title="${escapeHtml(`${providerId}${modelName ? ` / ${modelName}` : ""}`)}">${escapeHtml(providerId)}${modelName ? ` · <span class="mono">${escapeHtml(modelName)}</span>` : ""}</span>
                      <div>${fullAuth ? `<span class="pill pill-ok">完全授权</span>` : `<span class="pill pill-warn">需审批</span>`}</div>
                    </div>
                  </td>
                  <td class="col-workspace">
                    <span class="mono truncate" title="${escapeHtml(bot.workspace || "")}">${escapeHtml(shortWorkspaceLabel(bot.workspace))}</span>
                  </td>
                  <td class="col-actions" data-stop-row-click="1">
                    <div class="cell-actions">
                      <button class="btn btn-sm" type="button" data-bot-toggle="${escapeHtml(bot.name)}" data-bot-online="${bot.online ? "1" : "0"}">${bot.online ? "停止" : "启动"}</button>
                      <button class="btn btn-sm" type="button" data-bot-detail="${escapeHtml(bot.name)}">详情</button>
                    </div>
                  </td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      `}
    </div>
  `;

  if (searchHadFocus) {
    const searchEl = container.querySelector("#bot-search");
    if (searchEl) {
      searchEl.focus();
      if (typeof searchCursor === "number") searchEl.setSelectionRange(searchCursor, searchCursor);
    }
  }

  container.querySelectorAll("[data-filter-engine]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setState((s) => { s.botFilters.engine = btn.dataset.filterEngine; });
    });
  });

  container.querySelector("#bot-status-filter")?.addEventListener("change", (event) => {
    setState((s) => { s.botFilters.status = event.target.value; });
  });

  container.querySelector("#bot-search")?.addEventListener("input", (event) => {
    setState((s) => { s.botFilters.search = event.target.value; });
  });

  container.querySelector("#btn-clear-bot-filters")?.addEventListener("click", () => {
    setState((s) => {
      s.botFilters = { engine: "all", status: "all", search: "" };
    });
  });

  container.querySelector("#btn-empty-create")?.addEventListener("click", () => actions.onOpenWizard?.("single"));
  container.querySelector("#btn-bots-open-queue")?.addEventListener("click", () => actions.onOpenWizard?.("queue"));

  const handleAdoptLegacy = async () => {
    try {
      const preview = await api.previewLegacyAdoption({ names: legacyInstances.map((item) => item.name) });
      const items = preview?.bots || preview?.adoptable || [];
      if (!items.length) {
        showToast("当前未检测到需要接管的遗留脚本 Bot", "info");
        return;
      }
      openConfirmModal({
        title: `接管 ${items.length} 个现有脚本 Bot`,
        description: "将本机已发现的旧脚本实例纳入桌面端统一管理，并保留其工作空间和飞书凭据。",
        details: items.slice(0, 8).map((item) => [item.name, item.workspace || item.status || "可接管"]),
        confirmLabel: "确认接管",
        onConfirm: async () => {
          await api.applyLegacyAdoption({ names: items.map((item) => item.name) });
          showToast(`已接管 ${items.length} 个 Bot`, "ok");
          await actions.onRefresh?.({ force: true });
        },
      });
    } catch (error) {
      showToast(formatIpcError(error), "error");
    }
  };
  container.querySelector("#btn-adopt-legacy")?.addEventListener("click", handleAdoptLegacy);
  container.querySelector("#btn-empty-adopt")?.addEventListener("click", handleAdoptLegacy);

  // Select all / checkboxes
  container.querySelector("#bot-select-all")?.addEventListener("change", (event) => {
    setState((s) => {
      if (event.target.checked) {
        for (const bot of filteredBots) s.selectedBotNames.add(bot.name);
      } else {
        for (const bot of filteredBots) s.selectedBotNames.delete(bot.name);
      }
    });
  });

  container.querySelector("#select-all-bots-button")?.addEventListener("click", () => {
    setState((s) => {
      for (const bot of filteredBots) s.selectedBotNames.add(bot.name);
    });
  });

  container.querySelector("#clear-all-bots-button")?.addEventListener("click", () => {
    setState((s) => { s.selectedBotNames.clear(); });
  });

  container.querySelectorAll(".managed-bot-selection").forEach((box) => {
    box.addEventListener("change", (event) => {
      setState((s) => {
        if (event.target.checked) s.selectedBotNames.add(event.target.value);
        else s.selectedBotNames.delete(event.target.value);
      });
    });
  });

  // Restart idle online bots
  container.querySelector("#btn-restart-idle")?.addEventListener("click", async (event) => {
    const names = idleOnlineBots.map((bot) => bot.name);
    if (!names.length) return;
    const btn = event.currentTarget;
    btn.disabled = true;
    btn.textContent = "处理中...";
    await restartSelected(names, false, actions);
  });

  // Safe restart selected
  container.querySelector("#safe-restart-bots-button")?.addEventListener("click", async (event) => {
    const names = selectedManagedBotNames();
    const btn = event.currentTarget;
    btn.disabled = true;
    btn.textContent = "处理中...";
    await restartSelected(names, false, actions);
  });

  // Force restart selected (confirmation modal required)
  container.querySelector("#force-restart-bots-button")?.addEventListener("click", () => {
    const names = selectedManagedBotNames();
    const busyCount = allBots.filter((b) => names.includes(b.name) && Number(b.activeRunCount || 0) > 0).length;
    openConfirmModal({
      dialogId: "force-restart-dialog",
      confirmButtonId: "force-restart-confirm",
      title: `强制重启所选 ${names.length} 个 Bot`,
      description: "强制重启会立即终止所选 Bot 进程（包括在途任务），然后重新拉起。",
      warning: busyCount > 0 ? `注意：所选列表中包含 ${busyCount} 个有活动任务的 Bot，强制重启会中断其当前对话任务！` : "",
      details: [["目标 Bot", names.join("、")]],
      danger: true,
      confirmLabel: "确认强制重启",
      onConfirm: async () => {
        await restartSelected(names, true, actions);
      },
    });
  });

  // Row clicks & Start/Stop/Detail buttons
  container.querySelectorAll("[data-stop-row-click]").forEach((cell) => {
    cell.addEventListener("click", (event) => event.stopPropagation());
  });

  container.querySelectorAll("[data-bot-row]").forEach((row) => {
    row.addEventListener("click", () => {
      actions.onOpenBotDrawer?.(row.dataset.botRow, "config");
    });
  });

  container.querySelectorAll("[data-bot-detail]").forEach((btn) => {
    btn.addEventListener("click", () => {
      actions.onOpenBotDrawer?.(btn.dataset.botDetail, "config");
    });
  });

  container.querySelectorAll("[data-bot-toggle]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.botToggle;
      const online = btn.dataset.botOnline === "1";
      btn.disabled = true;
      btn.textContent = "处理中...";
      try {
        if (online) {
          await api.stopBot(name);
          showToast(`已停止 ${name}`, "ok");
        } else {
          await api.startBot(name);
          showToast(`已启动 ${name}`, "ok");
        }
        await actions.onRefresh?.({ force: false });
      } catch (error) {
        showToast(formatIpcError(error), "error");
        btn.disabled = false;
        btn.textContent = online ? "停止" : "启动";
      }
    });
  });
}
