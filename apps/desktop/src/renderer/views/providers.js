import { api, escapeHtml, formatIpcError } from "../ipc.js";
import { getManagedBots, normalizeEngine, setState, store } from "../state.js";
import { openConfirmModal } from "../components/confirm-modal.js";
import { showToast } from "../components/toast.js";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
let codexModelSuggestions = [];
let claudeModelSuggestions = [];
let agyModelSuggestions = [];

function formValues(form) {
  return Object.fromEntries(new FormData(form));
}

function renderCodexProvidersTab(state) {
  const modelSources = state.modelSources || { homes: [], accounts: [] };
  const accounts = modelSources.accounts || [];
  const homes = modelSources.homes || [];
  const catalog = state.providerCatalog || { providers: [] };
  const providers = catalog.providers || [];
  const proxy = state.setup?.protocolProxy || {};
  const loginInProgress = ["running", "finishing"].includes(modelSources.accountLoginJob?.status);

  return `
    <div class="two-col">
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">OpenAI 官方账号池</h2>
            <div class="card-sub">多账号独立凭据快照，可在 Bot 抽屉按需绑定</div>
          </div>
          <button class="btn btn-primary btn-sm" type="button" id="btn-add-openai-account" ${loginInProgress ? "disabled" : ""}>
            ${loginInProgress ? "登录进行中..." : "+ 添加官方账号"}
          </button>
        </div>
        <div class="item-list">
          ${accounts.length ? accounts.map((acc) => `
            <div class="item-row">
              <div class="item-main">
                <div class="item-title">
                  <span>${escapeHtml(acc.email || acc.alias)}</span>
                  <span class="pill ${acc.valid !== false ? "pill-ok" : "pill-warn"}">${acc.valid !== false ? "已授权" : "需重新登录"}</span>
                </div>
                <div class="item-sub mono">${escapeHtml(acc.alias)}${acc.boundBots?.length ? ` · 绑定：${escapeHtml(acc.boundBots.join("、"))}` : ""}</div>
              </div>
              <div class="inline-actions">
                <button class="btn btn-sm" type="button" data-relogin-openai="${escapeHtml(acc.alias)}" ${loginInProgress ? "disabled" : ""}>重登</button>
                <button class="btn btn-danger btn-sm" type="button" data-forget-openai="${escapeHtml(acc.alias)}">解绑</button>
              </div>
            </div>
          `).join("") : `<div class="empty-state"><div class="empty-state-sub">尚未添加独立 OpenAI 账号快照；Codex 默认复用所属 Codex Home 的登录状态。</div></div>`}
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">本机协议转换代理</h2>
            <div class="card-sub">将 Chat Completions 渠道安全桥接至 Codex Responses 协议</div>
          </div>
          <span class="pill ${proxy.status === "online" ? "pill-ok" : "pill-neutral"}">${escapeHtml(proxy.status || "inactive")}</span>
        </div>
        <div class="card-body">
          <dl class="kv-grid">
            <dt>监听范围</dt><dd class="mono">127.0.0.1（仅本机回环 + Bearer 鉴权）</dd>
            <dt>在线代理端口数</dt><dd class="mono">${escapeHtml(proxy.providerCount ?? 0)}</dd>
            <dt>当前默认渠道</dt><dd class="mono">${escapeHtml(catalog.selectedId || "OpenAI 官方")} / ${escapeHtml(catalog.selectedModel || "默认")}</dd>
          </dl>
          <div class="inline-actions">
            <button class="btn btn-sm" type="button" id="btn-codex-sync-preview">预览并同步到隔离空间</button>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">Codex 配置空间与登录状态</h2>
          <div class="card-sub">支持一键触发 CLI 登录、纳入信任管理或切换空间当前渠道</div>
        </div>
      </div>
      <div class="item-list">
        ${homes.map((home) => `
          <div class="item-row">
            <div class="item-main">
              <div class="item-title">
                <span>${escapeHtml(home.label || home.codexHome)}</span>
                <span class="pill ${home.login?.status === "signed-in" ? "pill-ok" : "pill-neutral"}">${escapeHtml(home.login?.email || home.login?.status || "未登录")}</span>
              </div>
              <div class="item-sub mono">${escapeHtml(home.codexHome)} · 当前：${escapeHtml(home.currentProvider || "openai")} / ${escapeHtml(home.currentModel || "默认")}</div>
            </div>
            <div class="inline-actions">
              ${!home.manageable ? `<button class="btn btn-sm" type="button" data-trust-home="${escapeHtml(home.codexHome)}">信任空间</button>` : ""}
              <button class="btn btn-sm" type="button" data-login-home="${escapeHtml(home.codexHome)}" ${!home.manageable ? "disabled" : ""}>OpenAI 登录</button>
            </div>
          </div>
        `).join("") || `<div class="empty-state"><div class="empty-state-sub">未发现 Codex 配置空间。</div></div>`}
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">Codex 全局第三方 Provider</h2>
          <div class="card-sub">保存在 ~/.codex/config.toml，密钥通过系统安全凭据写入用户环境</div>
        </div>
      </div>
      <div class="item-list">
        ${providers.length ? providers.map((prov) => `
          <div class="item-row">
            <div class="item-main">
              <div class="item-title">
                <span>${escapeHtml(prov.name || prov.id)}</span>
                <span class="pill ${prov.credentialAvailable === false ? "pill-warn" : "pill-ok"}">${prov.credentialAvailable === false ? "缺少密钥" : "密钥可用"}</span>
                ${prov.selected ? `<span class="pill pill-busy">全局当前</span>` : ""}
              </div>
              <div class="item-sub mono">${escapeHtml(prov.id)} · ${escapeHtml(prov.wireApi || "responses")} · ${escapeHtml(prov.baseUrl || "")} · ENV ${escapeHtml(prov.envKey || "-")}</div>
            </div>
            <div class="inline-actions">
              <button class="btn btn-sm" type="button" data-codex-refresh-cap="${escapeHtml(prov.id)}">刷新容量</button>
              <button class="btn btn-sm" type="button" data-codex-replace-key="${escapeHtml(prov.id)}">替换 Key</button>
              <button class="btn btn-danger btn-sm provider-remove" type="button" data-codex-remove-prov="${escapeHtml(prov.id)}">删除</button>
            </div>
          </div>
        `).join("") : `<div class="empty-state"><div class="empty-state-sub">尚未添加全局第三方 Codex Provider。</div></div>`}
      </div>
      <div class="card-body">
        <details class="details-box" id="codex-provider-details">
          <summary>+ 添加全局 Codex Provider</summary>
          <div class="details-body">
            <form id="codex-provider-form" class="form-grid-2">
              <div class="field">
                <label>Provider 标识 <span class="req-mark">*</span></label>
                <input class="input" name="id" required placeholder="例如 my-provider" />
              </div>
              <div class="field">
                <label>显示名称</label>
                <input class="input" name="name" placeholder="我的渠道" />
              </div>
              <div class="field form-span-2">
                <label>Base URL <span class="req-mark">*</span></label>
                <input class="input" name="baseUrl" type="url" required placeholder="https://api.example.com/v1" />
              </div>
              <div class="field">
                <label>接口协议</label>
                <select class="select" name="wireApi">
                  <option value="responses">Responses API</option>
                  <option value="chat">Chat Completions（走本机协议代理）</option>
                </select>
              </div>
              <div class="field">
                <label>环境变量名 <span class="req-mark">*</span></label>
                <input class="input" name="envKey" required placeholder="MY_PROVIDER_API_KEY" />
              </div>
              <div class="field">
                <label>API Key <span class="req-mark">*</span></label>
                <input class="input" name="apiKey" type="password" autocomplete="new-password" required />
              </div>
              <div class="field">
                <label>默认测试模型</label>
                <input class="input" name="model" list="codex-model-list" placeholder="可点击拉取模型" />
                <datalist id="codex-model-list">${codexModelSuggestions.map((m) => `<option value="${escapeHtml(m)}"></option>`).join("")}</datalist>
              </div>
              <div class="inline-actions form-span-2">
                <button class="btn btn-sm" type="button" id="btn-codex-list-models">拉取模型</button>
                <button class="btn btn-sm" type="button" id="btn-codex-probe">测试连接</button>
                <button class="btn btn-primary btn-sm" type="submit">验证并保存 Provider</button>
              </div>
            </form>
          </div>
        </details>
      </div>
    </div>
  `;
}

function renderClaudeProvidersTab(state) {
  const providers = state.claudeProviders?.providers || [];
  const claudeBots = getManagedBots(state).filter((b) => normalizeEngine(b.engine) === "claude");
  const pending = Object.keys(state.claudePendingConfiguration?.bots || {});

  return `
    <div class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">Claude Code 渠道列表</h2>
          <div class="card-sub">支持 Anthropic Messages API；修改渠道或 Key 后，忙碌 Bot 自动等任务结束后应用</div>
        </div>
      </div>
      ${pending.length ? `<div class="loading-band">等待空闲重载配置的 Claude Bot：${escapeHtml(pending.join("、"))}</div>` : ""}
      <div class="item-list">
        ${providers.length ? providers.map((prov) => `
          <div class="item-row">
            <div class="item-main">
              <div class="item-title">
                <span>${escapeHtml(prov.name || prov.id)}</span>
                <span class="pill ${prov.credentialAvailable ? "pill-ok" : "pill-warn"}">${prov.credentialAvailable ? "密钥已保存" : "缺少密钥"}</span>
              </div>
              <div class="item-sub mono">${escapeHtml(prov.id)} · ${escapeHtml(prov.baseUrl)} · 模型 ${escapeHtml(prov.model)} · 强度 ${escapeHtml(prov.effort)}</div>
            </div>
            <div class="inline-actions">
              <button class="btn btn-sm" type="button" data-claude-edit="${escapeHtml(prov.id)}">编辑 / 换 Key</button>
            </div>
          </div>
        `).join("") : `<div class="empty-state"><div class="empty-state-sub">尚未配置 Claude Code 渠道。</div></div>`}
      </div>
      <div class="card-body">
        <details class="details-box" id="claude-provider-details">
          <summary>+ 添加或编辑 Claude 渠道</summary>
          <div class="details-body">
            <form id="claude-provider-form" class="form-grid-2">
              <div class="field">
                <label>渠道标识 <span class="req-mark">*</span></label>
                <input class="input" name="id" required pattern="[a-z0-9_-]+" placeholder="my-claude-provider" />
              </div>
              <div class="field">
                <label>显示名称</label>
                <input class="input" name="name" placeholder="我的 Claude 渠道" />
              </div>
              <div class="field form-span-2">
                <label>Base URL <span class="req-mark">*</span></label>
                <input class="input" name="baseUrl" type="url" required placeholder="https://api.example.com" />
              </div>
              <div class="field">
                <label>鉴权方式</label>
                <select class="select" name="auth">
                  <option value="bearer">Bearer Token</option>
                  <option value="x-api-key">x-api-key</option>
                </select>
              </div>
              <div class="field">
                <label>API Key（编辑时留空保留原 Key）</label>
                <input class="input" name="apiKey" type="password" autocomplete="new-password" />
              </div>
              <div class="field">
                <label>默认模型 <span class="req-mark">*</span></label>
                <input class="input" name="model" required list="claude-model-list" placeholder="例如 claude-opus-5-5" />
                <datalist id="claude-model-list">${claudeModelSuggestions.map((m) => `<option value="${escapeHtml(m)}"></option>`).join("")}</datalist>
              </div>
              <div class="field">
                <label>默认思考强度（保留 max 不降级）</label>
                <select class="select" name="effort">
                  ${EFFORTS.map((e) => `<option value="${e}" ${e === "high" ? "selected" : ""}>${e}</option>`).join("")}
                </select>
              </div>
              <div class="inline-actions form-span-2">
                <button class="btn btn-sm" type="button" id="btn-claude-list-models">拉取模型列表</button>
                <button class="btn btn-sm" type="button" id="btn-claude-probe">测试连接</button>
                <button class="btn btn-primary btn-sm" type="submit">验证并保存</button>
              </div>
            </form>
          </div>
        </details>

        <details class="details-box">
          <summary>批量分配渠道到 Claude Bot（共 ${claudeBots.length} 个）</summary>
          <div class="details-body">
            <form id="claude-assign-form" class="form-grid-2">
              <div class="field">
                <label>Claude 渠道 <span class="req-mark">*</span></label>
                <select class="select" name="providerId" id="claude-assign-provider" required>
                  ${providers.filter((p) => p.credentialAvailable).map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name || p.id)}</option>`).join("")}
                </select>
              </div>
              <div class="field">
                <label>模型 <span class="req-mark">*</span></label>
                <input class="input" name="model" id="claude-assign-model" required value="${escapeHtml(providers[0]?.model || "")}" />
              </div>
              <div class="field">
                <label>思考强度</label>
                <select class="select" name="reasoning">
                  ${EFFORTS.map((e) => `<option value="${e}" ${e === "high" ? "selected" : ""}>${e}</option>`).join("")}
                </select>
              </div>
              <div class="field form-span-2">
                <label>选择目标 Claude Bot</label>
                <div class="checkbox-list">
                  ${claudeBots.map((bot) => `
                    <label class="checkbox-row">
                      <input type="checkbox" name="botNames" value="${escapeHtml(bot.name)}" />
                      <span>${escapeHtml(bot.label || bot.name)} <span class="mono text-muted">(${escapeHtml(bot.provider?.id || "未配置")})</span></span>
                    </label>
                  `).join("") || `<span class="field-hint">尚未创建 Claude Bot。</span>`}
                </div>
              </div>
              <div class="inline-actions form-span-2">
                <button class="btn btn-sm" type="button" id="btn-claude-select-all">全选</button>
                <button class="btn btn-primary btn-sm" type="submit" ${!claudeBots.length ? "disabled" : ""}>应用到所选 Bot</button>
              </div>
            </form>
          </div>
        </details>
      </div>
    </div>
  `;
}

function renderAntigravityProvidersTab(state) {
  const config = state.antigravityConfiguration || {};
  const accounts = config.accounts?.accounts || [];
  const activeAccountId = config.accounts?.activeId || "";
  const providers = config.providers || [];
  const agyBots = getManagedBots(state).filter((b) => normalizeEngine(b.engine) === "antigravity");
  const busyAgy = agyBots.filter((b) => Number(b.activeRunCount || 0) > 0);

  return `
    <div class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">Antigravity 官方 Google 账号</h2>
          <div class="card-sub">全 Antigravity Bot 自动复用本机当前官方登录；仅需换号登录或切换快照时，先退出 Antigravity App 和 CLI 且确保无在途任务</div>
        </div>
        <button class="btn btn-sm" type="button" id="btn-agy-open-login">打开官方登录窗口</button>
      </div>
      ${busyAgy.length ? `<div class="alert-row"><div class="alert-text">当前有 ${busyAgy.length} 个 Antigravity Bot 正在执行任务（存在活动官方租约），建议任务结束后再切换官方账号。</div></div>` : ""}
      <div class="item-list">
        ${accounts.length ? accounts.map((acc) => `
          <div class="item-row">
            <div class="item-main">
              <div class="item-title">
                <span>${escapeHtml(acc.name || acc.id)}</span>
                ${activeAccountId === acc.id ? `<span class="pill pill-ok">当前保存账号</span>` : ""}
              </div>
              <div class="item-sub mono">${escapeHtml(acc.id)}</div>
            </div>
            <button class="btn btn-sm" type="button" data-agy-switch="${escapeHtml(acc.id)}" ${activeAccountId === acc.id ? "disabled" : ""}>
              ${activeAccountId === acc.id ? "使用中" : "切换到此账号"}
            </button>
          </div>
        `).join("") : `<div class="empty-state"><div class="empty-state-sub">尚未保存官方账号快照；可直接使用系统当前官方登录，或在下方捕获保存。</div></div>`}
      </div>
      <div class="card-body">
        <details class="details-box">
          <summary>+ 捕获并加密保存当前官方登录</summary>
          <div class="details-body">
            <form id="agy-account-form" class="form-grid-2">
              <div class="field">
                <label>账号别名 <span class="req-mark">*</span></label>
                <input class="input" name="id" required pattern="[a-z0-9][a-z0-9_.-]{0,63}" placeholder="google-main" />
              </div>
              <div class="field">
                <label>显示名称</label>
                <input class="input" name="name" placeholder="我的 Ultra 官方账号" />
              </div>
              <div class="inline-actions form-span-2">
                <button class="btn btn-primary btn-sm" type="submit">保存当前官方登录</button>
              </div>
            </form>
          </div>
        </details>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">Antigravity 渠道（官方 / Gemini API 兼容）</h2>
          <div class="card-sub">第三方端点须兼容 Gemini GenerateContent 流式协议</div>
        </div>
      </div>
      <div class="item-list">
        ${providers.map((prov) => `
          <div class="item-row">
            <div class="item-main">
              <div class="item-title">
                <span>${escapeHtml(prov.name || prov.id)}</span>
                <span class="pill ${prov.mode === "official" || prov.credentialAvailable ? "pill-ok" : "pill-warn"}">${prov.mode === "official" ? "官方登录" : (prov.credentialAvailable ? "密钥已保存" : "缺少密钥")}</span>
              </div>
              <div class="item-sub mono">${escapeHtml(prov.id)} · ${escapeHtml(prov.mode)} · 模型 ${escapeHtml(prov.model || "原生默认")}</div>
            </div>
            ${prov.id !== "official" ? `<button class="btn btn-sm" type="button" data-agy-edit="${escapeHtml(prov.id)}">编辑</button>` : ""}
          </div>
        `).join("")}
      </div>
      <div class="card-body">
        <details class="details-box" id="agy-provider-details">
          <summary>+ 添加或编辑 Antigravity 渠道</summary>
          <div class="details-body">
            <form id="agy-provider-form" class="form-grid-2">
              <div class="field">
                <label>渠道 ID <span class="req-mark">*</span></label>
                <input class="input" name="id" required pattern="[a-z0-9][a-z0-9_.-]{0,63}" placeholder="my-gemini" />
              </div>
              <div class="field">
                <label>显示名称</label>
                <input class="input" name="name" placeholder="Gemini API 渠道" />
              </div>
              <div class="field">
                <label>来源模式</label>
                <select class="select" name="mode">
                  <option value="gemini-api">Gemini API 兼容渠道</option>
                  <option value="official">已保存官方账号</option>
                </select>
              </div>
              <div class="field">
                <label>官方账号</label>
                <select class="select" name="accountId">
                  <option value="current">系统当前登录</option>
                  ${accounts.map((acc) => `<option value="${escapeHtml(acc.id)}">${escapeHtml(acc.name || acc.id)}</option>`).join("")}
                </select>
              </div>
              <div class="field form-span-2">
                <label>Gemini Base URL</label>
                <input class="input" name="baseUrl" type="url" placeholder="https://generativelanguage.googleapis.com" />
              </div>
              <div class="field">
                <label>API Key（留空保留原密钥）</label>
                <input class="input" name="apiKey" type="password" autocomplete="new-password" />
              </div>
              <div class="field">
                <label>默认模型（可选）</label>
                <input class="input" name="model" list="agy-model-list" placeholder="留空使用原生默认" />
                <datalist id="agy-model-list">${agyModelSuggestions.map((m) => `<option value="${escapeHtml(m.modelId || m)}">${escapeHtml(m.name || m)}</option>`).join("")}</datalist>
              </div>
              <div class="field">
                <label>思考强度</label>
                <select class="select" name="effort">
                  <option value="">原生默认</option>
                  ${EFFORTS.map((e) => `<option value="${e}">${e}</option>`).join("")}
                </select>
              </div>
              <div class="inline-actions form-span-2">
                <button class="btn btn-sm" type="button" id="btn-agy-list-models">读取原生模型目录</button>
                <button class="btn btn-sm" type="button" id="btn-agy-probe">测试生成</button>
                <button class="btn btn-primary btn-sm" type="submit">验证并保存</button>
              </div>
            </form>
          </div>
        </details>

        <details class="details-box">
          <summary>批量分配渠道到 Antigravity Bot（共 ${agyBots.length} 个）</summary>
          <div class="details-body">
            <form id="agy-assign-form" class="form-grid-2">
              <div class="field">
                <label>目标渠道</label>
                <select class="select" name="providerId">
                  ${providers.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name || p.id)}</option>`).join("")}
                </select>
              </div>
              <div class="field">
                <label>默认模型（可选）</label>
                <input class="input" name="model" list="agy-model-list" placeholder="原生默认" />
              </div>
              <div class="field">
                <label>思考强度</label>
                <select class="select" name="reasoning">
                  <option value="">原生默认</option>
                  ${EFFORTS.map((e) => `<option value="${e}">${e}</option>`).join("")}
                </select>
              </div>
              <div class="field form-span-2">
                <label>选择目标 Antigravity Bot</label>
                <div class="checkbox-list">
                  ${agyBots.map((bot) => `
                    <label class="checkbox-row">
                      <input type="checkbox" name="botNames" value="${escapeHtml(bot.name)}" />
                      <span>${escapeHtml(bot.label || bot.name)} <span class="mono text-muted">(${escapeHtml(bot.provider?.id || "official")})</span></span>
                    </label>
                  `).join("") || `<span class="field-hint">尚未创建 Antigravity Bot。</span>`}
                </div>
              </div>
              <div class="inline-actions form-span-2">
                <button class="btn btn-primary btn-sm" type="submit" ${!agyBots.length ? "disabled" : ""}>应用到所选 Bot</button>
              </div>
            </form>
          </div>
        </details>
      </div>
    </div>
  `;
}

export function renderProvidersView(container, actions = {}) {
  if (!container) return;
  const state = store.desktopState;
  if (!state) {
    container.innerHTML = "";
    return;
  }

  const activeTab = store.providerEngineTab || "codex";
  container.innerHTML = `
    <div class="toolbar card">
      <div class="segmented" role="tablist" aria-label="渠道与账号引擎切换">
        <button class="seg-btn ${activeTab === "codex" ? "active" : ""}" type="button" data-provider-tab="codex">Codex 渠道与 OpenAI 账号</button>
        <button class="seg-btn ${activeTab === "claude" ? "active" : ""}" type="button" data-provider-tab="claude">Claude Code 渠道</button>
        <button class="seg-btn ${activeTab === "antigravity" ? "active" : ""}" type="button" data-provider-tab="antigravity">Antigravity 账号与渠道</button>
      </div>
    </div>

    ${activeTab === "codex" ? renderCodexProvidersTab(state) : ""}
    ${activeTab === "claude" ? renderClaudeProvidersTab(state) : ""}
    ${activeTab === "antigravity" ? renderAntigravityProvidersTab(state) : ""}
  `;

  container.querySelectorAll("[data-provider-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setState({ providerEngineTab: btn.dataset.providerTab });
    });
  });

  // Codex bindings
  container.querySelector("#btn-add-openai-account")?.addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    try {
      await api.addOpenAiAccount({});
      showToast("已启动 OpenAI 浏览器登录，请在浏览器中完成授权", "info");
      await actions.onRefresh?.({ force: true });
    } catch (error) {
      showToast(formatIpcError(error), "error");
    } finally {
      btn.disabled = false;
    }
  });

  container.querySelectorAll("[data-relogin-openai]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await api.addOpenAiAccount({ alias: btn.dataset.reloginOpenai });
        showToast("已启动该账号重新登录流程", "info");
        await actions.onRefresh?.({ force: true });
      } catch (error) {
        showToast(formatIpcError(error), "error");
      }
    });
  });

  container.querySelectorAll("[data-forget-openai]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const alias = btn.dataset.forgetOpenai;
      openConfirmModal({
        title: `解绑并忘记账号 ${alias}`,
        description: "将删除本机保存的该 OpenAI 账号凭据快照；如仍有 Bot 绑定此账号，需先在 Bot 抽屉解绑。",
        danger: true,
        confirmLabel: "确认忘记账号",
        onConfirm: async () => {
          await api.forgetOpenAiAccount({ alias });
          showToast(`已移除账号：${alias}`, "ok");
          await actions.onRefresh?.({ force: true });
        },
      });
    });
  });

  container.querySelectorAll("[data-trust-home]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await api.trustCodexHome(btn.dataset.trustHome);
        showToast("已将该 Codex Home 纳入客户端管理", "ok");
        await actions.onRefresh?.({ force: true });
      } catch (error) {
        showToast(formatIpcError(error), "error");
      }
    });
  });

  container.querySelectorAll("[data-login-home]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await api.startOpenAiLogin(btn.dataset.loginHome);
        showToast("已启动该空间的 OpenAI 登录", "info");
        await actions.onRefresh?.({ force: true });
      } catch (error) {
        showToast(formatIpcError(error), "error");
      }
    });
  });

  container.querySelector("#btn-codex-sync-preview")?.addEventListener("click", async () => {
    try {
      const plan = await api.previewProviderSync();
      const targets = plan?.targets || [];
      if (!targets.length) {
        showToast("当前所有隔离空间的 Provider 定义已与全局同步", "ok");
        return;
      }
      openConfirmModal({
        title: "同步全局 Provider 定义至隔离空间",
        description: `将把全局 Provider 元数据同步至 ${targets.length} 个隔离 Codex Home（不覆盖各空间当前选用的模型）。`,
        details: targets.map((t) => [t.label || t.codexHome, `${(t.added || []).length} 新增 / ${(t.updated || []).length} 更新`]),
        confirmLabel: "确认同步",
        onConfirm: async () => {
          await api.applyProviderSync();
          showToast("隔离空间 Provider 已同步完成", "ok");
          await actions.onRefresh?.({ force: true });
        },
      });
    } catch (error) {
      showToast(formatIpcError(error), "error");
    }
  });

  container.querySelectorAll("[data-codex-refresh-cap]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await api.refreshProviderCapacity({ id: btn.dataset.codexRefreshCap });
        showToast("已刷新渠道模型容量信息", "ok");
        await actions.onRefresh?.({ force: true });
      } catch (error) {
        showToast(formatIpcError(error), "error");
      } finally {
        btn.disabled = false;
      }
    });
  });

  container.querySelectorAll("[data-codex-replace-key]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.codexReplaceKey;
      const key = window.prompt(`请输入 ${id} 的新 API Key（仅提交到本机主进程安全存储）：`);
      if (!key) return;
      void api.replaceGlobalProviderKey({ id, apiKey: key.trim() })
        .then(async () => {
          showToast("新密钥已安全保存，相关 Bot 将在空闲时重载", "ok");
          await actions.onRefresh?.({ force: true });
        })
        .catch((error) => showToast(formatIpcError(error), "error"));
    });
  });

  container.querySelectorAll("[data-codex-remove-prov]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.codexRemoveProv;
      try {
        const preview = await api.previewGlobalProviderRemoval({ id });
        openConfirmModal({
          title: `删除全局 Provider：${id}`,
          description: "将从 ~/.codex/config.toml 中移除该 Provider 定义。",
          warning: preview?.affectedBots?.length ? `受影响 Bot：${preview.affectedBots.join("、")}` : "",
          danger: true,
          confirmLabel: "确认删除 Provider",
          onConfirm: async () => {
            await api.applyGlobalProviderRemoval({ id });
            showToast(`已删除全局 Provider：${id}`, "ok");
            await actions.onRefresh?.({ force: true });
          },
        });
      } catch (error) {
        showToast(formatIpcError(error), "error");
      }
    });
  });

  const codexForm = container.querySelector("#codex-provider-form");
  container.querySelector("#btn-codex-list-models")?.addEventListener("click", async (event) => {
    if (!codexForm) return;
    const btn = event.currentTarget;
    btn.disabled = true;
    try {
      const res = await api.listProviderModels(formValues(codexForm));
      codexModelSuggestions = res.models || [];
      showToast(`读取到 ${codexModelSuggestions.length} 个模型`, "ok");
      renderProvidersView(container, actions);
    } catch (error) {
      showToast(formatIpcError(error), "error");
    } finally {
      btn.disabled = false;
    }
  });
  container.querySelector("#btn-codex-probe")?.addEventListener("click", async (event) => {
    if (!codexForm) return;
    const btn = event.currentTarget;
    btn.disabled = true;
    try {
      const res = await api.probeProvider(formValues(codexForm));
      showToast(`连接探测成功：${res.model || "OK"}`, "ok");
    } catch (error) {
      showToast(formatIpcError(error), "error");
    } finally {
      btn.disabled = false;
    }
  });
  codexForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitBtn = event.submitter;
    if (submitBtn) submitBtn.disabled = true;
    try {
      await api.addGlobalProvider(formValues(codexForm));
      showToast("全局 Provider 已验证并保存", "ok");
      codexForm.reset();
      await actions.onRefresh?.({ force: true });
    } catch (error) {
      showToast(formatIpcError(error), "error");
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  // Claude bindings
  const claudeForm = container.querySelector("#claude-provider-form");
  container.querySelectorAll("[data-claude-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const prov = (state.claudeProviders?.providers || []).find((item) => item.id === btn.dataset.claudeEdit);
      if (!prov || !claudeForm) return;
      for (const field of ["id", "name", "baseUrl", "auth", "model", "effort"]) {
        if (claudeForm.elements[field]) claudeForm.elements[field].value = prov[field] || "";
      }
      if (claudeForm.elements.apiKey) claudeForm.elements.apiKey.value = "";
      const details = container.querySelector("#claude-provider-details");
      if (details) details.open = true;
    });
  });
  container.querySelector("#btn-claude-list-models")?.addEventListener("click", async (event) => {
    if (!claudeForm) return;
    const btn = event.currentTarget;
    btn.disabled = true;
    try {
      const res = await api.claudeListModels(formValues(claudeForm));
      claudeModelSuggestions = res.models || [];
      showToast(`读取到 ${claudeModelSuggestions.length} 个 Claude 模型`, "ok");
    } catch (error) {
      showToast(formatIpcError(error), "error");
    } finally {
      btn.disabled = false;
    }
  });
  container.querySelector("#btn-claude-probe")?.addEventListener("click", async (event) => {
    if (!claudeForm) return;
    const btn = event.currentTarget;
    btn.disabled = true;
    try {
      const res = await api.claudeProbeProvider(formValues(claudeForm));
      showToast(`Claude 渠道连通：${res.model} (${res.elapsedMs || 0} ms)`, "ok");
    } catch (error) {
      showToast(formatIpcError(error), "error");
    } finally {
      btn.disabled = false;
    }
  });
  claudeForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitBtn = event.submitter;
    if (submitBtn) submitBtn.disabled = true;
    try {
      await api.claudeSaveProvider(formValues(claudeForm));
      claudeForm.elements.apiKey.value = "";
      showToast("Claude 渠道已保存，相关 Bot 将在空闲时重载", "ok");
      await actions.onRefresh?.({ force: true });
    } catch (error) {
      showToast(formatIpcError(error), "error");
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  const claudeAssignForm = container.querySelector("#claude-assign-form");
  container.querySelector("#btn-claude-select-all")?.addEventListener("click", () => {
    claudeAssignForm?.querySelectorAll('input[name="botNames"]').forEach((box) => { box.checked = true; });
  });
  container.querySelector("#claude-assign-provider")?.addEventListener("change", (event) => {
    const prov = (state.claudeProviders?.providers || []).find((p) => p.id === event.target.value);
    const modelInput = container.querySelector("#claude-assign-model");
    if (prov && modelInput) modelInput.value = prov.model || "";
  });
  claudeAssignForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = formValues(claudeAssignForm);
    input.botNames = [...new FormData(claudeAssignForm).getAll("botNames")];
    if (!input.botNames.length) {
      showToast("请至少选择一个 Claude Bot", "warn");
      return;
    }
    try {
      const res = await api.claudeAssignProvider(input);
      showToast(`已分配给 ${res.botNames?.length || input.botNames.length} 个 Claude Bot`, "ok");
      await actions.onRefresh?.({ force: true });
    } catch (error) {
      showToast(formatIpcError(error), "error");
    }
  });

  // Antigravity bindings
  container.querySelector("#btn-agy-open-login")?.addEventListener("click", async () => {
    try {
      const res = await api.antigravityOpenLogin();
      showToast(res?.instruction || "已打开 Antigravity 官方登录窗口", "info");
    } catch (error) {
      showToast(formatIpcError(error), "error");
    }
  });
  container.querySelector("#agy-account-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api.antigravityCaptureAccount(formValues(event.target));
      showToast("当前官方登录已加密保存为账号快照", "ok");
      await actions.onRefresh?.({ force: true });
    } catch (error) {
      showToast(formatIpcError(error), "error");
    }
  });
  container.querySelectorAll("[data-agy-switch]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await api.antigravitySwitchAccount({ id: btn.dataset.agySwitch });
        showToast("已切换系统官方账号，下一轮会话生效", "ok");
        await actions.onRefresh?.({ force: true });
      } catch (error) {
        showToast(formatIpcError(error), "error");
        btn.disabled = false;
      }
    });
  });

  const agyForm = container.querySelector("#agy-provider-form");
  const agyPayload = () => {
    const input = formValues(agyForm);
    if (input.mode === "official") {
      delete input.baseUrl;
      delete input.apiKey;
    }
    return input;
  };
  container.querySelectorAll("[data-agy-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const prov = (state.antigravityConfiguration?.providers || []).find((item) => item.id === btn.dataset.agyEdit);
      if (!prov || !agyForm) return;
      for (const field of ["id", "name", "mode", "accountId", "baseUrl", "model", "effort"]) {
        if (agyForm.elements[field]) agyForm.elements[field].value = prov[field] || "";
      }
      if (agyForm.elements.apiKey) agyForm.elements.apiKey.value = "";
      const details = container.querySelector("#agy-provider-details");
      if (details) details.open = true;
    });
  });
  container.querySelector("#btn-agy-list-models")?.addEventListener("click", async (event) => {
    if (!agyForm) return;
    const btn = event.currentTarget;
    btn.disabled = true;
    try {
      const res = await api.antigravityListModels(agyPayload());
      agyModelSuggestions = res.models || [];
      showToast(`读取到 ${agyModelSuggestions.length} 个原生模型`, "ok");
    } catch (error) {
      showToast(formatIpcError(error), "error");
    } finally {
      btn.disabled = false;
    }
  });
  container.querySelector("#btn-agy-probe")?.addEventListener("click", async (event) => {
    if (!agyForm) return;
    const btn = event.currentTarget;
    btn.disabled = true;
    try {
      const res = await api.antigravityProbeProvider(agyPayload());
      showToast(`原生生成验证通过：${res.model} (${res.elapsedMs || 0} ms)`, "ok");
    } catch (error) {
      showToast(formatIpcError(error), "error");
    } finally {
      btn.disabled = false;
    }
  });
  agyForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitBtn = event.submitter;
    if (submitBtn) submitBtn.disabled = true;
    try {
      await api.antigravitySaveProvider(agyPayload());
      agyForm.elements.apiKey.value = "";
      showToast("Antigravity 渠道已保存", "ok");
      await actions.onRefresh?.({ force: true });
    } catch (error) {
      showToast(formatIpcError(error), "error");
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
  container.querySelector("#agy-assign-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = formValues(event.target);
    input.botNames = [...new FormData(event.target).getAll("botNames")];
    if (!input.botNames.length) {
      showToast("请至少选择一个 Antigravity Bot", "warn");
      return;
    }
    try {
      await api.antigravityAssignProvider(input);
      showToast("已更新所选 Antigravity Bot 默认渠道", "ok");
      await actions.onRefresh?.({ force: true });
    } catch (error) {
      showToast(formatIpcError(error), "error");
    }
  });
}
