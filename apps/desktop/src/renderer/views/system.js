import { api, escapeHtml, formatIpcError } from "../ipc.js";
import { store } from "../state.js";
import { openConfirmModal } from "../components/confirm-modal.js";
import { showToast } from "../components/toast.js";

function renderPathRow(label, filePath) {
  if (!filePath) return "";
  return `
    <div class="path-row">
      <div class="path-row-main">
        <span class="path-label">${escapeHtml(label)}</span>
        <span class="path-value" title="${escapeHtml(filePath)}">${escapeHtml(filePath)}</span>
      </div>
      <div class="inline-actions">
        <button class="btn btn-sm" type="button" data-open-path="${escapeHtml(filePath)}">打开</button>
        <button class="btn btn-sm" type="button" data-copy-path="${escapeHtml(filePath)}">复制</button>
      </div>
    </div>
  `;
}

export function renderSystemView(container, actions = {}) {
  if (!container) return;
  const state = store.desktopState;
  if (!state) {
    container.innerHTML = "";
    return;
  }

  const appInfo = state.app || {};
  const engineInfo = state.engine || {};
  const update = state.update || {};
  const settings = state.settings || {};
  const setup = state.setup || {};
  const spaces = setup.managedSpaces || [];
  const activeRuns = (setup.managedBots || []).reduce((sum, bot) => sum + Number(bot.activeRunCount || 0), 0);
  const canInstallUpdate = update.status === "downloaded";
  const updateBusy = ["checking", "downloading"].includes(update.status);
  const updateStatusText = update.status === "downloading" && Number.isFinite(Number(update.percent))
    ? `${update.message || "正在下载更新"} (${Math.round(Number(update.percent))}%)`
    : (update.message || update.status || "未检查");
  const ownerHintText = !settings.ownerOpenId && settings.autoBoundOwnerOpenId
    ? `已通过首次私聊自动绑定：${settings.autoBoundOwnerOpenId}（留空将继续沿用自动绑定；如需覆盖或显式指定请在上方填写并保存）。`
    : "留空则按最小权限拒绝跨 Bot 私聊共享访问；保存后同步写入共享库 owner.json 并入队重载空闲 Bot。";

  container.innerHTML = `
    <div class="two-col">
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">客户端版本与更新</h2>
            <div class="card-sub">打包运行时、引擎版本及系统安全存储状态</div>
          </div>
          <span class="pill ${appInfo.credentialStorageAvailable ? "pill-ok" : "pill-danger"}">
            ${appInfo.credentialStorageAvailable ? "安全存储就绪" : "存储异常"}
          </span>
        </div>
        <div class="card-body">
          <dl class="kv-grid">
            <dt>客户端版本</dt><dd class="mono">v${escapeHtml(appInfo.version || "")} (${escapeHtml(appInfo.platform || "")}/${escapeHtml(appInfo.arch || "")})</dd>
            <dt>引擎提交</dt><dd class="mono">${escapeHtml(engineInfo.manifest?.sourceCommit || "开发态源码")}</dd>
            <dt>内置 Node / Lark</dt><dd class="mono">${escapeHtml(engineInfo.nodeVersion || "-")} · lark-cli ${escapeHtml(engineInfo.larkCliVersion || "-")}</dd>
            <dt>安全凭据后端</dt><dd>${escapeHtml(appInfo.credentialStorage || "未知")}</dd>
            <dt>更新状态</dt><dd>${escapeHtml(updateStatusText)}${update.latestVersion ? `（最新 v${escapeHtml(update.latestVersion)}）` : ""}</dd>
          </dl>
          ${activeRuns > 0 ? `<div class="field-hint text-warn">当前有 ${activeRuns} 个活跃任务；安装更新会自动保护在途任务并在空闲时滚动恢复。</div>` : ""}
          <div class="inline-actions">
            <button class="btn btn-sm" type="button" id="btn-sys-check-update" ${update.supported === false || updateBusy ? "disabled" : ""}>${update.status === "downloading" ? "下载中..." : update.status === "checking" ? "检查中..." : "检查更新"}</button>
            <button class="btn btn-primary btn-sm" type="button" id="btn-sys-install-update" ${!canInstallUpdate ? "disabled" : ""}>安装并重启</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">客户端偏好与主用户身份归属</h2>
            <div class="card-sub">控制后台驻留策略及跨 Bot 私聊共享会话归属边界</div>
          </div>
        </div>
        <div class="card-body">
          <label class="checkbox-row">
            <input type="checkbox" id="sys-launch-at-login" ${settings.launchAtLogin ? "checked" : ""} />
            <span>
              <strong>系统登录时后台启动</strong>
              <div class="field-hint">开机后静默拉起桌面端并自动恢复已开启自启的受管 Bot。</div>
            </span>
          </label>
          <label class="checkbox-row">
            <input type="checkbox" id="sys-close-to-tray" ${settings.closeToTray ? "checked" : ""} />
            <span>
              <strong>关闭主窗口时最小化到托盘</strong>
              <div class="field-hint">保持受管 Bot 持续在线，可通过系统托盘随时恢复窗口。</div>
            </span>
          </label>

          <form id="sys-owner-form" class="field">
            <label for="input-owner-open-id">主用户飞书 Open ID（跨 Bot 私聊共享归属）</label>
            <div class="inline-actions">
              <input
                class="input mono"
                id="input-owner-open-id"
                name="ownerOpenId"
                value="${escapeHtml(settings.ownerOpenId || "")}"
                pattern="^$|^ou_[A-Za-z0-9]+$"
                placeholder="ou_xxxxxxxxxxxxxxxx"
              />
              <button class="btn btn-primary btn-sm" type="submit" id="btn-save-owner-open-id">保存归属 ID</button>
            </div>
            <span class="field-hint">${escapeHtml(ownerHintText)}</span>
          </form>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">数据 Schema 与本机目录</h2>
          <div class="card-sub">Schema v${escapeHtml(setup.dataSchema?.version ?? 1)} · 模式：${escapeHtml(setup.mode === "production" ? "生产模式" : "开发沙箱")}</div>
        </div>
      </div>
      <div class="card-body">
        ${renderPathRow("持久数据目录 (dataRoot)", setup.dataRoot)}
        ${renderPathRow("工作空间根目录 (workspaceRoot)", setup.workspaceRoot)}
        ${renderPathRow("隔离 Codex Home 根目录", setup.codexHomeRoot)}
        ${renderPathRow("运行态数据目录 (runtimeLocalAppData)", setup.runtimeLocalAppData)}
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">受管隔离空间（${spaces.length}）</h2>
          <div class="card-sub">管理由批量空间工厂创建的独立 Codex Home 隔离空间</div>
        </div>
      </div>
      <div class="item-list">
        ${spaces.length ? spaces.map((sp) => `
          <div class="item-row">
            <div class="item-main">
              <div class="item-title">
                <span>${escapeHtml(sp.spaceName)}</span>
                <span class="pill pill-neutral">${(sp.bots || []).length} 个 Bot</span>
              </div>
              <div class="item-sub mono">${escapeHtml(sp.codexHome)}</div>
            </div>
            <button class="btn btn-danger btn-sm" type="button" data-remove-space="${escapeHtml(sp.id)}">删除空间</button>
          </div>
        `).join("") : `<div class="empty-state"><div class="empty-state-sub">当前没有由空间工厂创建的隔离 Codex 空间。</div></div>`}
      </div>
    </div>
  `;

  container.querySelector("#btn-sys-check-update")?.addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    btn.textContent = "检查中...";
    try {
      await api.checkUpdate();
      showToast("已完成更新检查", "info");
      await actions.onRefresh?.({ force: false });
    } catch (error) {
      showToast(formatIpcError(error), "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "检查更新";
    }
  });

  container.querySelector("#btn-sys-install-update")?.addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    btn.textContent = "准备安装...";
    try {
      await api.installUpdate();
    } catch (error) {
      showToast(formatIpcError(error), "error");
      btn.disabled = false;
      btn.textContent = "安装并重启";
    }
  });

  container.querySelector("#sys-launch-at-login")?.addEventListener("change", async (event) => {
    const input = event.currentTarget;
    input.disabled = true;
    try {
      await api.setSettings({ launchAtLogin: input.checked });
      showToast(input.checked ? "已启用系统登录启动" : "已关闭系统登录启动", "ok");
      await actions.onRefresh?.({ force: false });
    } catch (error) {
      input.checked = !input.checked;
      showToast(formatIpcError(error), "error");
    } finally {
      input.disabled = false;
    }
  });

  container.querySelector("#sys-close-to-tray")?.addEventListener("change", async (event) => {
    const input = event.currentTarget;
    input.disabled = true;
    try {
      await api.setSettings({ closeToTray: input.checked });
      showToast(input.checked ? "关闭窗口将最小化到托盘" : "关闭窗口将直接退出客户端", "ok");
      await actions.onRefresh?.({ force: false });
    } catch (error) {
      input.checked = !input.checked;
      showToast(formatIpcError(error), "error");
    } finally {
      input.disabled = false;
    }
  });

  container.querySelector("#sys-owner-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const ownerOpenId = String(form.elements.ownerOpenId.value || "").trim();
    const btn = container.querySelector("#btn-save-owner-open-id");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "处理中...";
    }
    try {
      await api.setOwnerOpenId({ ownerOpenId });
      showToast(ownerOpenId ? "主用户 Open ID 已保存并同步至共享会话库" : "已清空主用户 Open ID", "ok");
      await actions.onRefresh?.({ force: true });
    } catch (error) {
      showToast(formatIpcError(error), "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "保存归属 ID";
      }
    }
  });

  container.querySelectorAll("[data-open-path]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        const res = await api.openPath(btn.dataset.openPath);
        if (res && res.ok === false) showToast(res.error || "无法打开路径", "error");
      } catch (error) {
        showToast(formatIpcError(error), "error");
      }
    });
  });

  container.querySelectorAll("[data-copy-path]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await api.copyPath(btn.dataset.copyPath);
        showToast("路径已复制", "ok");
      } catch (error) {
        showToast(formatIpcError(error), "error");
      }
    });
  });

  container.querySelectorAll("[data-remove-space]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const spaceId = btn.dataset.removeSpace;
      try {
        const preview = await api.previewManagedRemoval({ kind: "space", id: spaceId });
        const activeCount = (preview.bots || []).reduce((sum, b) => sum + Number(b.activeRunCount || 0), 0);
        openConfirmModal({
          title: preview.title || "删除隔离空间",
          description: `将移除该空间内的 ${(preview.bots || []).length} 个受管 Bot 配置（不删除飞书云端应用）。`,
          warning: activeCount > 0 ? `空间内仍有 ${activeCount} 个活动任务，已阻断删除。` : "",
          disabledReason: activeCount > 0 ? "存在活动任务，请等待完成后再删除空间。" : "",
          details: [
            ["空间名称", preview.spaceName || ""],
            ["Codex Home", preview.paths?.codexHome || ""],
          ],
          checkboxes: [
            { name: "deleteCodexHome", label: "同时删除隔离 Codex Home 目录", hint: preview.paths?.codexHome || "", checked: true },
            { name: "deleteWorkspaces", label: "同时删除关联工作空间目录", checked: false },
            { name: "deleteRuntime", label: "清理运行态日志与会话状态", checked: true },
          ],
          danger: true,
          confirmLabel: "确认删除空间",
          onConfirm: async (values) => {
            await api.applyManagedRemoval({
              kind: "space",
              id: spaceId,
              deleteCodexHome: values.deleteCodexHome === true,
              deleteWorkspaces: values.deleteWorkspaces === true,
              deleteRuntime: values.deleteRuntime !== false,
            });
            showToast("隔离空间已删除", "ok");
            await actions.onRefresh?.({ force: true });
          },
        });
      } catch (error) {
        showToast(formatIpcError(error), "error");
      }
    });
  });
}
