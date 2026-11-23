import { api, escapeHtml, formatIpcError } from "../ipc.js";
import { engineLabel, store } from "../state.js";
import { openConfirmModal } from "./confirm-modal.js";
import { showToast } from "./toast.js";

let wizardOpen = false;
let wizardMode = "single"; // single | batch | queue
let selectedEngine = "codex"; // codex | claude | antigravity
let credentialMode = "qr"; // qr | manual
let batchPreview = null;
let singlePreview = null;
let qrProgress = null;
let registering = false;
let previousFocus = null;
let refreshCallback = null;

export function configureCreateWizard({ onRefresh } = {}) {
  refreshCallback = onRefresh || null;
}

export function isCreateWizardOpen() {
  return wizardOpen;
}

export function handleWizardRegistrationProgress(progress) {
  qrProgress = progress || null;
  if (wizardOpen) renderCreateWizard();
}

export function openCreateWizard(mode = "single") {
  previousFocus = document.activeElement;
  wizardOpen = true;
  wizardMode = ["single", "batch", "queue"].includes(mode) ? mode : "single";
  batchPreview = null;
  singlePreview = null;
  qrProgress = null;
  renderCreateWizard();
  document.getElementById("btn-wizard-close")?.focus();
}

export function closeCreateWizard() {
  if (registering) {
    void api.cancelRegistration().catch(() => {});
    registering = false;
  }
  wizardOpen = false;
  qrProgress = null;
  const backdrop = document.getElementById("wizard-modal");
  if (backdrop) {
    backdrop.classList.remove("open");
    backdrop.innerHTML = "";
  }
  if (previousFocus && typeof previousFocus.focus === "function") {
    try {
      previousFocus.focus();
    } catch {
      // ignore
    }
  }
  previousFocus = null;
}

function defaultBatchValues(engine, state) {
  if (engine === "claude") {
    const provider = (state?.claudeProviders?.providers || []).find((item) => item.credentialAvailable) || state?.claudeProviders?.providers?.[0];
    return {
      spaceName: "Claude",
      slug: "claude",
      namePattern: "claude-{index}",
      labelPattern: "Claude {index}",
      count: 10,
      baseIndex: 1,
      providerId: provider?.id || "",
      model: provider?.model || "",
      reasoning: provider?.effort || "high",
      permissionMode: "bypassPermissions",
    };
  }
  if (engine === "antigravity") {
    const provider = state?.antigravityConfiguration?.providers?.[0];
    return {
      spaceName: "Antigravity",
      slug: "antigravity",
      namePattern: "antigravity-{index}",
      labelPattern: "Antigravity-{index}",
      count: 5,
      baseIndex: 1,
      providerId: provider?.id || "official",
      model: provider?.model || "",
      reasoning: provider?.effort || "",
      permissionMode: "always-proceed",
    };
  }
  const provider = state?.providerCatalog?.providers?.[0];
  return {
    spaceName: "新工作空间",
    slug: "team-a",
    namePattern: "codex-assistant-{index}-{slug}",
    labelPattern: "Codex助手{index}-{space}",
    count: 4,
    baseIndex: 1,
    providerId: provider?.id || "",
    model: state?.providerCatalog?.selectedModel || "gpt-5.6-sol",
    reasoning: "high",
    permissionMode: "danger-full-access",
  };
}

function renderEnginePicker() {
  const engines = [
    ["codex", "Codex CLI", "app-server · 全局/隔离空间"],
    ["claude", "Claude Code", "独立 Home · 共享工具库"],
    ["antigravity", "Antigravity", "原生 ACP · 共享官方登录"],
  ];
  return `
    <div class="field">
      <label>选择执行引擎 <span class="req-mark">*</span></label>
      <div class="engine-picker" id="wizard-engine-picker">
        ${engines.map(([id, title, sub]) => `
          <button class="engine-opt ${selectedEngine === id ? "selected" : ""}" type="button" data-wizard-engine="${id}">
            <span class="engine-opt-title">${escapeHtml(title)}</span>
            <span class="engine-opt-sub">${escapeHtml(sub)}</span>
          </button>
        `).join("")}
      </div>
    </div>
  `;
}

function renderProviderFieldsForEngine(engine, state, defaults = {}) {
  const efforts = ["low", "medium", "high", "xhigh", "max"];
  if (engine === "claude") {
    const providers = (state?.claudeProviders?.providers || []).filter((item) => item.credentialAvailable);
    const selectedId = defaults.providerId || providers[0]?.id || "";
    const selectedProv = providers.find((item) => item.id === selectedId) || providers[0];
    const model = defaults.model ?? selectedProv?.model ?? "";
    const reasoning = defaults.reasoning || selectedProv?.effort || "high";
    return `
      <div class="field">
        <label for="wiz-provider">Claude 渠道 <span class="req-mark">*</span></label>
        <select class="select" id="wiz-provider" name="providerId" required>
          ${providers.map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === selectedId ? "selected" : ""}>${escapeHtml(p.name || p.id)}</option>`).join("") || `<option value="">请先在“渠道与账号”配置 Claude 渠道</option>`}
        </select>
      </div>
      <div class="field">
        <label for="wiz-model">默认模型 <span class="req-mark">*</span></label>
        <input class="input" id="wiz-model" name="model" value="${escapeHtml(model)}" required placeholder="例如 claude-opus-5-5" />
      </div>
      <div class="field">
        <label for="wiz-reasoning">默认思考强度</label>
        <select class="select" id="wiz-reasoning" name="reasoning">
          ${efforts.map((effort) => `<option value="${effort}" ${effort === reasoning ? "selected" : ""}>${effort}</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label for="wiz-perm">权限模式（默认完全授权）</label>
        <select class="select" id="wiz-perm" name="permissionMode">
          <option value="bypassPermissions" selected>完全授权（bypassPermissions）</option>
          <option value="manual">交互审批（manual）</option>
        </select>
      </div>
    `;
  }

  if (engine === "antigravity") {
    const providers = state?.antigravityConfiguration?.providers || [];
    const selectedId = defaults.providerId || "official";
    const reasoning = defaults.reasoning || "";
    return `
      <div class="field">
        <label for="wiz-provider">Antigravity 渠道</label>
        <select class="select" id="wiz-provider" name="providerId">
          ${providers.map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === selectedId ? "selected" : ""}>${escapeHtml(p.name || p.id)}</option>`).join("") || `<option value="official">官方登录</option>`}
        </select>
      </div>
      <div class="field">
        <label for="wiz-model">默认模型（可选，留空走原生默认）</label>
        <input class="input" id="wiz-model" name="model" value="${escapeHtml(defaults.model || "")}" placeholder="留空使用原生默认" />
      </div>
      <div class="field">
        <label for="wiz-reasoning">默认思考强度（可选）</label>
        <select class="select" id="wiz-reasoning" name="reasoning">
          <option value="" ${!reasoning ? "selected" : ""}>原生默认</option>
          ${efforts.map((effort) => `<option value="${effort}" ${effort === reasoning ? "selected" : ""}>${effort}</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label for="wiz-perm">权限模式（默认完全授权）</label>
        <select class="select" id="wiz-perm" name="permissionMode">
          <option value="always-proceed" selected>完全授权（always-proceed）</option>
          <option value="default">交互审批（default）</option>
          <option value="accept-edits">自动接受编辑（accept-edits）</option>
          <option value="plan">只规划（plan）</option>
        </select>
      </div>
    `;
  }

  if (wizardMode === "batch") {
    const providers = state?.providerCatalog?.providers || [];
    const selectedId = defaults.providerId || providers[0]?.id || "";
    return `
      <div class="field">
        <label for="wiz-provider">全局 Codex Provider <span class="req-mark">*</span></label>
        <select class="select" id="wiz-provider" name="providerId" required>
          ${providers.map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === selectedId ? "selected" : ""}>${escapeHtml(p.name || p.id)}${p.credentialAvailable === false ? "（缺环境变量）" : ""}</option>`).join("") || `<option value="">请先添加全局 Provider</option>`}
        </select>
      </div>
      <div class="field">
        <label for="wiz-model">默认模型 <span class="req-mark">*</span></label>
        <input class="input" id="wiz-model" name="model" value="${escapeHtml(defaults.model || "")}" required placeholder="例如 gpt-5.6-sol" />
      </div>
      <div class="field">
        <label for="wiz-reasoning">默认思考强度</label>
        <select class="select" id="wiz-reasoning" name="reasoning">
          ${efforts.map((effort) => `<option value="${effort}" ${effort === (defaults.reasoning || "high") ? "selected" : ""}>${effort}</option>`).join("")}
        </select>
      </div>
    `;
  }

  const spaces = state?.setup?.managedSpaces || [];
  return `
    <div class="field form-span-2">
      <label for="wiz-codex-target">配置归属</label>
      <select class="select" id="wiz-codex-target" name="configurationTarget">
        <option value="global">继承全局 Codex 配置（~/.codex）</option>
        ${spaces.map((sp) => `<option value="space:${escapeHtml(sp.bots?.[0]?.name || "")}">加入已有隔离空间：${escapeHtml(sp.spaceName)}</option>`).join("")}
      </select>
      <span class="field-hint">Codex 默认采用完全授权沙箱策略，可选继承全局配置或已有隔离空间。</span>
    </div>
  `;
}

function renderSingleBody(state) {
  return `
    ${renderEnginePicker()}
    <form id="wizard-single-form" class="form-grid-2">
      <div class="field">
        <label for="wiz-name">Bot 标识 <span class="req-mark">*</span></label>
        <input class="input" id="wiz-name" name="name" required placeholder="例如 my-assistant-1" pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,63}" />
      </div>
      <div class="field">
        <label for="wiz-label">显示名称 <span class="req-mark">*</span></label>
        <input class="input" id="wiz-label" name="label" required placeholder="例如 助手 1 号" maxlength="100" />
      </div>
      <div class="field">
        <label for="wiz-brand">飞书平台 <span class="req-mark">*</span></label>
        <select class="select" id="wiz-brand" name="brand">
          <option value="feishu" selected>飞书（中国大陆 feishu.cn）</option>
          <option value="lark">Lark（国际版 larksuite.com）</option>
        </select>
      </div>
      <div class="field">
        <label for="wiz-profile">飞书 Profile 名（可选，默认同 Bot 标识）</label>
        <input class="input" id="wiz-profile" name="profile" placeholder="留空自动与 Bot 标识一致" />
      </div>
      <div class="field form-span-2">
        <label for="wiz-workspace">工作空间路径（可选，留空自动创建）</label>
        <input class="input" id="wiz-workspace" name="workspace" placeholder="留空则在默认工作空间根目录下自动创建" />
      </div>
      ${renderProviderFieldsForEngine(selectedEngine, state)}

      <div class="field form-span-2">
        <label>飞书应用凭据方式</label>
        <div class="segmented">
          <button class="seg-btn ${credentialMode === "qr" ? "active" : ""}" type="button" data-cred-mode="qr">飞书扫码自动创建应用</button>
          <button class="seg-btn ${credentialMode === "manual" ? "active" : ""}" type="button" data-cred-mode="manual">已有 App ID / App Secret 手动创建</button>
        </div>
      </div>

      ${credentialMode === "manual" ? `
        <div class="field">
          <label for="wiz-app-id">飞书 App ID <span class="req-mark">*</span></label>
          <input class="input" id="wiz-app-id" name="appId" required placeholder="cli_xxxxxxxx" />
        </div>
        <div class="field">
          <label for="wiz-app-secret">飞书 App Secret <span class="req-mark">*</span></label>
          <input class="input" id="wiz-app-secret" name="appSecret" type="password" autocomplete="new-password" required placeholder="应用密钥" />
        </div>
      ` : ""}
    </form>

    ${singlePreview ? `
      <div class="alert-row ${singlePreview.available ? "ok" : "danger"}">
        <div class="alert-text">
          <strong>${singlePreview.available ? "预检通过" : "存在冲突"}</strong>
          <div class="alert-sub mono">${escapeHtml(singlePreview.available ? `工作空间：${singlePreview.paths?.workspace || singlePreview.bot?.workspace || ""}` : singlePreview.conflict)}</div>
        </div>
      </div>
    ` : ""}

    ${qrProgress ? `
      <div class="qr-panel">
        <strong>${escapeHtml(qrProgress.message || "飞书扫码注册中")}</strong>
        ${qrProgress.qrDataUrl ? `<img class="qr-image" src="${escapeHtml(qrProgress.qrDataUrl)}" alt="飞书应用注册二维码" />` : ""}
        ${qrProgress.expiresIn ? `<span class="field-hint">二维码有效期约 ${escapeHtml(qrProgress.expiresIn)} 秒，扫码完成后自动保存。</span>` : ""}
        <button class="btn btn-danger btn-sm" type="button" id="btn-wizard-cancel-qr">取消扫码</button>
      </div>
    ` : ""}
  `;
}

function renderBatchBody(state) {
  const defaults = defaultBatchValues(selectedEngine, state);
  return `
    ${renderEnginePicker()}
    <form id="wizard-batch-form" class="form-grid-2">
      ${selectedEngine === "codex" ? `
        <div class="field">
          <label for="wiz-space-name">隔离空间名称 <span class="req-mark">*</span></label>
          <input class="input" id="wiz-space-name" name="spaceName" value="${escapeHtml(defaults.spaceName)}" required />
        </div>
        <div class="field">
          <label for="wiz-slug">空间 Slug <span class="req-mark">*</span></label>
          <input class="input" id="wiz-slug" name="slug" value="${escapeHtml(defaults.slug)}" required pattern="[a-z0-9][a-z0-9-]{0,59}" />
        </div>
      ` : ""}
      <div class="field">
        <label for="wiz-count">Bot 数量 (1-16) <span class="req-mark">*</span></label>
        <input class="input" id="wiz-count" name="count" type="number" min="1" max="16" value="${escapeHtml(defaults.count)}" required />
      </div>
      <div class="field">
        <label for="wiz-base-index">起始序号 <span class="req-mark">*</span></label>
        <input class="input" id="wiz-base-index" name="baseIndex" type="number" min="1" max="999" value="${escapeHtml(defaults.baseIndex)}" required />
      </div>
      <div class="field">
        <label for="wiz-name-pattern">标识模板（含 {index}）<span class="req-mark">*</span></label>
        <input class="input" id="wiz-name-pattern" name="namePattern" value="${escapeHtml(defaults.namePattern)}" required />
      </div>
      <div class="field">
        <label for="wiz-label-pattern">名称模板（含 {index}）<span class="req-mark">*</span></label>
        <input class="input" id="wiz-label-pattern" name="labelPattern" value="${escapeHtml(defaults.labelPattern)}" required />
      </div>
      <div class="field">
        <label for="wiz-batch-brand">飞书平台 <span class="req-mark">*</span></label>
        <select class="select" id="wiz-batch-brand" name="brand">
          <option value="feishu" selected>飞书（feishu.cn）</option>
          <option value="lark">Lark（larksuite.com）</option>
        </select>
      </div>
      ${renderProviderFieldsForEngine(selectedEngine, state, defaults)}
    </form>

    ${batchPreview ? `
      <div class="card">
        <div class="card-header">
          <div>
            <h3 class="card-title">批量创建预览（共 ${(batchPreview.bots || []).length} 个）</h3>
            <div class="card-sub">${batchPreview.available ? "无命名冲突，可直接生成批量队列" : "检测到命名或配置冲突，请调整序号或模板"}</div>
          </div>
          <span class="pill ${batchPreview.available ? "pill-ok" : "pill-danger"}">${batchPreview.available ? "可创建" : "有冲突"}</span>
        </div>
        <div class="item-list">
          ${(batchPreview.bots || []).map((bot) => `
            <div class="item-row">
              <div class="item-main">
                <div class="item-title">${escapeHtml(bot.label)} <span class="mono text-muted">${escapeHtml(bot.name)}</span></div>
                <div class="item-sub mono">${escapeHtml(bot.workspace || bot.claudeHome || "")}</div>
                ${bot.conflicts?.length ? `<div class="alert-sub text-danger">${escapeHtml(bot.conflicts.join("；"))}</div>` : ""}
              </div>
            </div>
          `).join("")}
        </div>
      </div>
    ` : ""}
  `;
}

function renderQueueBody(state) {
  const queue = state?.setup?.workspaceFactory || { bots: [] };
  const bots = Array.isArray(queue.bots) ? queue.bots : [];
  if (!bots.length) {
    return `
      <div class="empty-state">
        <div class="empty-state-title">当前没有待处理的批量工厂队列</div>
        <div class="empty-state-sub">在“批量空间工厂”标签中生成队列后，可在此逐个扫码注册飞书应用、重试失败项或废弃队列。</div>
        <button class="btn btn-primary btn-sm" type="button" data-wizard-mode="batch">前往批量空间工厂</button>
      </div>
    `;
  }
  return `
    <div class="inline-actions">
      <span class="field-hint">共 ${bots.length} 项（已创建 ${bots.filter((b) => b.status === "created").length} · 待注册 ${bots.filter((b) => b.status === "pending").length} · 失败 ${bots.filter((b) => b.status === "failed").length}）</span>
      <button class="btn btn-danger btn-sm" type="button" id="btn-discard-queue">清空/废弃队列</button>
    </div>

    ${qrProgress ? `
      <div class="qr-panel">
        <strong>${escapeHtml(qrProgress.message || "正在扫码注册队列条目")}</strong>
        ${qrProgress.qrDataUrl ? `<img class="qr-image" src="${escapeHtml(qrProgress.qrDataUrl)}" alt="飞书批量注册二维码" />` : ""}
        <button class="btn btn-danger btn-sm" type="button" id="btn-wizard-cancel-qr">取消扫码</button>
      </div>
    ` : ""}

    <div class="card">
      <div class="item-list">
        ${bots.map((bot) => {
          const pillClass = bot.status === "created" ? "pill-ok" : bot.status === "failed" ? "pill-danger" : bot.status === "registering" ? "pill-busy" : "pill-neutral";
          const statusLabel = bot.status === "created" ? "已创建" : bot.status === "failed" ? "失败" : bot.status === "registering" ? "注册中" : "待注册";
          return `
            <div class="item-row">
              <div class="item-main">
                <div class="item-title">
                  <span>${escapeHtml(bot.label || bot.name)}</span>
                  <span class="pill ${pillClass}">${statusLabel}</span>
                  <span class="mono text-muted">${escapeHtml(bot.name)}</span>
                </div>
                <div class="item-sub">${escapeHtml(engineLabel(bot.engine || queue.engine || "codex"))} · ${escapeHtml(bot.workspace || "")}</div>
                ${bot.error ? `<div class="alert-sub text-danger">${escapeHtml(bot.error)}</div>` : ""}
              </div>
              <div class="inline-actions">
                ${bot.status === "pending" ? `<button class="btn btn-primary btn-sm" type="button" data-queue-register="${escapeHtml(bot.name)}" ${registering ? "disabled" : ""}>扫码注册</button>` : ""}
                ${bot.status === "failed" ? `<button class="btn btn-sm" type="button" data-queue-retry="${escapeHtml(bot.name)}" ${registering ? "disabled" : ""}>重试注册</button>` : ""}
              </div>
            </div>
          `;
        }).join("")}
      </div>
    </div>
  `;
}

function collectSinglePayload(form) {
  const raw = Object.fromEntries(new FormData(form));
  const payload = {
    engine: selectedEngine,
    name: String(raw.name || "").trim(),
    label: String(raw.label || "").trim(),
    brand: String(raw.brand || "feishu").trim(),
    profile: String(raw.profile || "").trim(),
    workspace: String(raw.workspace || "").trim(),
  };
  if (selectedEngine === "codex") {
    const target = String(raw.configurationTarget || "global");
    if (target.startsWith("space:")) {
      payload.configurationTarget = "space";
      payload.spaceSourceName = target.slice("space:".length);
    } else {
      payload.configurationTarget = "global";
    }
  } else if (selectedEngine === "claude") {
    payload.providerId = String(raw.providerId || "").trim();
    payload.model = String(raw.model || "").trim();
    payload.reasoning = String(raw.reasoning || "high").trim();
    payload.permissionMode = String(raw.permissionMode || "bypassPermissions").trim();
  } else {
    payload.providerId = String(raw.providerId || "official").trim();
    payload.model = String(raw.model || "").trim();
    payload.reasoning = String(raw.reasoning || "").trim();
    payload.permissionMode = String(raw.permissionMode || "always-proceed").trim();
  }
  return { payload, credentials: { appId: String(raw.appId || "").trim(), appSecret: String(raw.appSecret || "").trim() } };
}

function collectBatchPayload(form) {
  const raw = Object.fromEntries(new FormData(form));
  return {
    ...raw,
    engine: selectedEngine,
    spaceName: raw.spaceName || (selectedEngine === "claude" ? "Claude" : "Antigravity"),
    slug: raw.slug || selectedEngine,
    count: Number(raw.count || 1),
    baseIndex: Number(raw.baseIndex || 1),
  };
}

export function renderCreateWizard() {
  const backdrop = document.getElementById("wizard-modal");
  if (!backdrop) return;
  if (!wizardOpen) {
    backdrop.classList.remove("open");
    backdrop.innerHTML = "";
    return;
  }

  const state = store.desktopState;
  const queueBots = state?.setup?.workspaceFactory?.bots || [];
  const pendingQueueCount = queueBots.filter((b) => b.status === "pending" || b.status === "failed").length;

  backdrop.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <div>
          <h2 class="card-title" id="wizard-title">创建受管 Bot</h2>
          <div class="card-sub">统一支持 Codex、Claude Code 与 Antigravity 三引擎单个创建及批量空间工厂</div>
        </div>
        <button class="btn btn-ghost btn-sm" type="button" id="btn-wizard-close" aria-label="关闭弹窗">✕</button>
      </div>

      <div class="modal-body">
        <div class="segmented" role="tablist">
          <button class="seg-btn ${wizardMode === "single" ? "active" : ""}" type="button" data-wizard-mode="single">单个创建</button>
          <button class="seg-btn ${wizardMode === "batch" ? "active" : ""}" type="button" data-wizard-mode="batch">批量空间工厂 (1-16)</button>
          <button class="seg-btn ${wizardMode === "queue" ? "active" : ""}" type="button" data-wizard-mode="queue">当前队列${pendingQueueCount ? ` (${pendingQueueCount})` : ""}</button>
        </div>

        ${wizardMode === "single" ? renderSingleBody(state) : ""}
        ${wizardMode === "batch" ? renderBatchBody(state) : ""}
        ${wizardMode === "queue" ? renderQueueBody(state) : ""}
      </div>

      <div class="modal-foot">
        <button class="btn" type="button" id="btn-wizard-cancel">关闭</button>
        ${wizardMode === "single" ? `
          <button class="btn" type="button" id="btn-wizard-preview-single" ${registering ? "disabled" : ""}>预检路径</button>
          <button class="btn btn-primary" type="button" id="btn-wizard-submit-single" ${registering ? "disabled" : ""}>
            ${credentialMode === "qr" ? "生成二维码并创建" : "立即创建 Bot"}
          </button>
        ` : ""}
        ${wizardMode === "batch" ? `
          <button class="btn" type="button" id="btn-wizard-preview-batch">预览批量队列</button>
          <button class="btn btn-primary" type="button" id="btn-wizard-create-batch" ${batchPreview?.available ? "" : "disabled"}>生成批量创建队列</button>
        ` : ""}
      </div>
    </div>
  `;

  backdrop.classList.add("open");
  backdrop.onclick = (event) => {
    if (event.target === backdrop && !registering) closeCreateWizard();
  };

  backdrop.querySelector("#btn-wizard-close")?.addEventListener("click", closeCreateWizard);
  backdrop.querySelector("#btn-wizard-cancel")?.addEventListener("click", closeCreateWizard);

  backdrop.querySelectorAll("[data-wizard-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      wizardMode = btn.dataset.wizardMode;
      batchPreview = null;
      singlePreview = null;
      renderCreateWizard();
    });
  });

  backdrop.querySelectorAll("[data-wizard-engine]").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedEngine = btn.dataset.wizardEngine;
      batchPreview = null;
      singlePreview = null;
      renderCreateWizard();
    });
  });

  backdrop.querySelectorAll("[data-cred-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      credentialMode = btn.dataset.credMode;
      renderCreateWizard();
    });
  });

  backdrop.querySelector("#btn-wizard-cancel-qr")?.addEventListener("click", async () => {
    try {
      await api.cancelRegistration();
    } catch (error) {
      showToast(formatIpcError(error), "error");
    }
  });

  // Single mode preview & submit
  backdrop.querySelector("#btn-wizard-preview-single")?.addEventListener("click", async (event) => {
    const form = backdrop.querySelector("#wizard-single-form");
    if (!form?.reportValidity()) return;
    const btn = event.currentTarget;
    btn.disabled = true;
    try {
      const { payload } = collectSinglePayload(form);
      singlePreview = await api.previewBot(payload);
      renderCreateWizard();
    } catch (error) {
      showToast(formatIpcError(error), "error");
    } finally {
      btn.disabled = false;
    }
  });

  backdrop.querySelector("#btn-wizard-submit-single")?.addEventListener("click", async (event) => {
    const form = backdrop.querySelector("#wizard-single-form");
    if (!form?.reportValidity()) return;
    const btn = event.currentTarget;
    const { payload, credentials } = collectSinglePayload(form);
    btn.disabled = true;
    btn.textContent = "处理中...";
    registering = credentialMode === "qr";
    try {
      if (credentialMode === "qr") {
        await api.registerBotWithQr(payload);
        showToast(`已完成扫码并创建 ${payload.label || payload.name}`, "ok");
      } else {
        await api.createBot({ bot: payload, credentials });
        showToast(`已创建 Bot：${payload.label || payload.name}`, "ok");
      }
      registering = false;
      qrProgress = null;
      await refreshCallback?.({ force: true });
      closeCreateWizard();
    } catch (error) {
      registering = false;
      qrProgress = null;
      showToast(formatIpcError(error), "error");
      renderCreateWizard();
    }
  });

  // Batch mode preview & create
  const batchForm = backdrop.querySelector("#wizard-batch-form");
  batchForm?.addEventListener("input", () => {
    const createBtn = backdrop.querySelector("#btn-wizard-create-batch");
    if (createBtn) createBtn.disabled = true;
  });

  backdrop.querySelector("#btn-wizard-preview-batch")?.addEventListener("click", async (event) => {
    if (!batchForm?.reportValidity()) return;
    const btn = event.currentTarget;
    btn.disabled = true;
    btn.textContent = "处理中...";
    try {
      batchPreview = await api.previewWorkspaceFactory(collectBatchPayload(batchForm));
      renderCreateWizard();
    } catch (error) {
      showToast(formatIpcError(error), "error");
      btn.disabled = false;
      btn.textContent = "预览批量队列";
    }
  });

  backdrop.querySelector("#btn-wizard-create-batch")?.addEventListener("click", async (event) => {
    if (!batchForm?.reportValidity()) return;
    const btn = event.currentTarget;
    btn.disabled = true;
    btn.textContent = "处理中...";
    try {
      await api.createWorkspaceFactoryQueue(collectBatchPayload(batchForm));
      showToast("批量创建队列已生成，可逐个扫码注册", "ok");
      wizardMode = "queue";
      batchPreview = null;
      await refreshCallback?.({ force: false });
      renderCreateWizard();
    } catch (error) {
      showToast(formatIpcError(error), "error");
      btn.disabled = false;
      btn.textContent = "生成批量创建队列";
    }
  });

  // Queue actions: register, retry, discard
  backdrop.querySelectorAll("[data-queue-register]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.queueRegister;
      registering = true;
      renderCreateWizard();
      try {
        await api.registerWorkspaceFactoryBot({ name });
        showToast(`已完成注册：${name}`, "ok");
      } catch (error) {
        showToast(formatIpcError(error), "error");
      } finally {
        registering = false;
        qrProgress = null;
        await refreshCallback?.({ force: true });
        renderCreateWizard();
      }
    });
  });

  backdrop.querySelectorAll("[data-queue-retry]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.queueRetry;
      btn.disabled = true;
      btn.textContent = "处理中...";
      try {
        await api.retryWorkspaceFactoryBot({ name });
        showToast(`已重置 ${name} 为待注册状态，可重新扫码`, "ok");
        await refreshCallback?.({ force: false });
        renderCreateWizard();
      } catch (error) {
        showToast(formatIpcError(error), "error");
        btn.disabled = false;
        btn.textContent = "重试注册";
      }
    });
  });

  backdrop.querySelector("#btn-discard-queue")?.addEventListener("click", () => {
    openConfirmModal({
      title: "清空并废弃当前批量队列",
      description: "将删除尚未完成的批量创建队列记录，不会影响已经创建成功的受管 Bot。",
      danger: true,
      confirmLabel: "确认清空队列",
      onConfirm: async () => {
        const res = await api.discardWorkspaceFactoryQueue();
        showToast(`已清空队列（移除 ${res.discardedCount || 0} 条记录）`, "ok");
        await refreshCallback?.({ force: false });
        renderCreateWizard();
      },
    });
  });
}
