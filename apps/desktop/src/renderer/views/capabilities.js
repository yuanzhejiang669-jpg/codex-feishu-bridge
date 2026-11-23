import { api, escapeHtml, formatIpcError } from "../ipc.js";
import { setState, store } from "../state.js";
import { showToast } from "../components/toast.js";

function renderPathShortcuts(items) {
  return items.filter(([, p]) => Boolean(p)).map(([label, filePath]) => `
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
  `).join("");
}

function buildFallbackMatrix(state) {
  const byName = new Map();
  const add = (name, engine, { disabled = false, commandAvailable = null, detail = "" } = {}) => {
    if (!byName.has(name)) {
      byName.set(name, {
        name,
        engines: [],
        disabled: true,
        active: false,
        commandAvailable,
        status: "ok",
        detail,
      });
    }
    const item = byName.get(name);
    if (!item.engines.includes(engine)) item.engines.push(engine);
    if (!disabled) {
      item.disabled = false;
      item.active = true;
    }
    if (commandAvailable === false) {
      item.commandAvailable = false;
      item.status = "error";
      item.detail = detail || "可执行命令未找到";
    }
  };
  for (const s of state?.capabilities?.mcpServers || []) {
    add(s.name, "codex", {
      disabled: false,
      commandAvailable: s.commandAvailable,
      detail: s.commandAvailable === false ? `命令不可达：${s.command}` : (s.command || "已配置"),
    });
  }
  for (const s of state?.claudeCapabilities?.mcpServers || []) {
    add(s.name, "claude", { disabled: s.disabled === true, detail: s.disabled ? "已禁用" : (s.command || s.url || "已配置") });
  }
  for (const s of state?.antigravityCapabilities?.mcpServers || []) {
    add(s.name, "antigravity", { disabled: s.disabled === true, detail: s.disabled ? "已禁用" : (s.command || s.url || "已配置") });
  }
  return [...byName.values()].map((item) => ({
    ...item,
    status: item.disabled ? "disabled" : item.status,
    detail: item.disabled ? "已在配置中标记 disabled: true（不计入活跃）" : (item.detail || "已配置（点击上方运行实时探针）"),
  }));
}

function sortMatrixServers(servers) {
  return [...servers].sort((a, b) => {
    if (Boolean(a.disabled) !== Boolean(b.disabled)) return a.disabled ? 1 : -1;
    return String(a.name).localeCompare(String(b.name));
  });
}

function renderMatrixTab(state, mcpHealth, probing) {
  const rawServers = mcpHealth?.servers || buildFallbackMatrix(state);
  const servers = sortMatrixServers(rawServers);
  const mineru = mcpHealth?.documentToolchain?.mineru || null;

  return `
    <div class="alert-row info">
      <div class="alert-text">
        <strong>浏览器 MCP 分工说明</strong>
        <div class="alert-sub">已登录浏览器操作使用 <span class="mono">codex_browser_control</span>（Edge 扩展桥 <span class="mono">:18795</span>）；反检测浏览器 <span class="mono">cloakbrowser</span> 已按 Bot 实例自动隔离 <span class="mono">PLAYWRIGHT_MCP_USER_DATA_DIR</span>，无需手动改全局配置。</div>
      </div>
      <button class="btn btn-primary btn-sm" type="button" id="btn-run-mcp-probe" ${probing ? "disabled" : ""}>
        ${probing ? "探测中..." : "运行最小无副作用探针"}
      </button>
    </div>

    <div class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">跨引擎 MCP 统一健康矩阵</h2>
          <div class="card-sub">${mcpHealth?.checkedAt ? `最近探针时间：${escapeHtml(mcpHealth.checkedAt)}（只读零外网消费）` : "当前显示本地配置扫描结果；点击“运行最小无副作用探针”检测本地端口与脚本语法"}</div>
        </div>
      </div>
      ${servers.length ? `
        <table class="bot-table">
          <thead>
            <tr>
              <th class="col-bot">MCP 名称</th>
              <th class="col-status">覆盖引擎</th>
              <th class="col-status">状态</th>
              <th>诊断详情</th>
            </tr>
          </thead>
          <tbody>
            ${servers.map((server) => {
              const isDisabled = server.disabled === true || server.status === "disabled";
              const pillClass = isDisabled ? "pill-neutral" : server.status === "ok" ? "pill-ok" : server.status === "warn" ? "pill-warn" : "pill-danger";
              const pillText = isDisabled ? "已禁用（不计入活跃）" : server.status === "ok" ? "正常" : server.status === "warn" ? "警告" : "异常";
              return `
                <tr class="${isDisabled ? "row-disabled" : ""}">
                  <td class="mono">${escapeHtml(server.name)}</td>
                  <td>${(server.engines || []).map((eng) => `<span class="pill ${eng === "claude" ? "pill-claude" : eng === "antigravity" ? "pill-agy" : "pill-codex"}">${escapeHtml(eng)}</span>`).join(" ")}</td>
                  <td><span class="pill ${pillClass}">${pillText}</span></td>
                  <td title="${escapeHtml(server.detail || "")}">${escapeHtml(server.detail || "")}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      ` : `<div class="empty-state"><div class="empty-state-sub">当前三引擎配置中均未发现 MCP 服务定义。</div></div>`}
    </div>

    ${mineru ? `
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">文档解析工具链诊断（MinerU）</h2>
            <div class="card-sub">只读跨平台环境检查，绝不修改外部共享技能目录</div>
          </div>
          <span class="pill ${mineru.status === "ok" ? "pill-ok" : mineru.status === "not_configured" ? "pill-neutral" : "pill-warn"}">${escapeHtml(mineru.status)}</span>
        </div>
        <div class="card-body">
          <dl class="kv-grid">
            <dt>MINERU_ROOT</dt><dd class="mono">${escapeHtml(mineru.mineruRoot || "")}</dd>
            <dt>检测结果</dt><dd>${escapeHtml(mineru.detail || "")}</dd>
          </dl>
        </div>
      </div>
    ` : ""}
  `;
}

function renderCodexCapabilitiesTab(state) {
  const cap = state.capabilities || {};
  const mcpServers = cap.mcpServers || [];
  const skills = cap.skills || [];
  const spaces = state.setup?.managedSpaces || [];

  return `
    <div class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">Codex 全局能力目录（~/.codex）</h2>
          <div class="card-sub">共 ${mcpServers.length} 个 MCP 服务 · ${skills.length} 个全局 Skills</div>
        </div>
      </div>
      <div class="card-body">
        ${renderPathShortcuts([
          ["Codex Home", cap.codexHome],
          ["配置文件 config.toml", cap.configPath],
          ["Skills 目录", cap.skillsRoot],
          ["全局 AGENTS.md", cap.agentsAvailable ? cap.agentsPath : ""],
        ])}
        ${cap.error ? `<div class="alert-row danger"><div class="alert-text">${escapeHtml(cap.error)}</div></div>` : ""}
      </div>
    </div>

    <div class="two-col">
      <div class="card">
        <div class="card-header"><h3 class="card-title">已配置 MCP (${mcpServers.length})</h3></div>
        <div class="item-list">
          ${mcpServers.map((s) => `
            <div class="item-row">
              <div class="item-main">
                <div class="item-title">
                  <span class="mono">${escapeHtml(s.name)}</span>
                  <span class="pill ${s.commandAvailable === false ? "pill-danger" : "pill-ok"}">${s.commandAvailable === false ? "命令缺失" : "配置可用"}</span>
                </div>
                <div class="item-sub mono">${escapeHtml(s.command || s.configSection || "")}</div>
              </div>
            </div>
          `).join("") || `<div class="empty-state"><div class="empty-state-sub">无 Codex MCP 配置。</div></div>`}
        </div>
      </div>

      <div class="card">
        <div class="card-header"><h3 class="card-title">已安装 Skills (${skills.length})</h3></div>
        <div class="item-list">
          ${skills.map((skill) => `
            <div class="item-row">
              <div class="item-main">
                <div class="item-title">${escapeHtml(skill.name)} <span class="pill pill-neutral">${escapeHtml(skill.sourceType || "directory")}</span></div>
                <div class="item-sub mono">${escapeHtml(skill.path || "")}</div>
              </div>
            </div>
          `).join("") || `<div class="empty-state"><div class="empty-state-sub">无全局 Skills。</div></div>`}
        </div>
      </div>
    </div>

    ${spaces.length ? `
      <div class="card">
        <div class="card-header">
          <div>
            <h3 class="card-title">迁移全局能力到隔离 Codex 空间</h3>
            <div class="card-sub">将全局 ~/.codex 中的 MCP 与 Skills 一键同步到指定隔离空间的代表 Bot</div>
          </div>
        </div>
        <div class="item-list">
          ${spaces.map((sp) => `
            <div class="item-row">
              <div class="item-main">
                <div class="item-title">${escapeHtml(sp.spaceName)}</div>
                <div class="item-sub mono">${escapeHtml(sp.codexHome)}</div>
              </div>
              <button class="btn btn-sm" type="button" data-codex-migrate-bot="${escapeHtml(sp.bots?.[0]?.name || "")}">预览并迁移</button>
            </div>
          `).join("")}
        </div>
      </div>
    ` : ""}
  `;
}

function renderSharedEngineCapabilitiesTab(engine, tools, homePath = "") {
  const title = engine === "claude" ? "Claude Code 共享工具库 (claude-tools)" : "Antigravity 共享工具库 (antigravity-tools)";
  const servers = tools?.mcpServers || [];
  const activeServers = servers.filter((s) => s.disabled !== true);
  const disabledServers = servers.filter((s) => s.disabled === true);
  const skills = tools?.skills || [];
  const srcMcp = tools?.sourceMcpServers || [];
  const srcSkills = tools?.sourceSkills || [];

  return `
    <div class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">${escapeHtml(title)}</h2>
          <div class="card-sub">活跃 MCP ${activeServers.length} 个${disabledServers.length ? `（另 ${disabledServers.length} 个已禁用）` : ""} · 共享 Skills ${skills.length} 个</div>
        </div>
      </div>
      <div class="card-body">
        ${renderPathShortcuts([
          ...(homePath ? [["共享 Home", homePath]] : []),
          ["共享工具根目录", tools?.root],
          ["共享 MCP 配置 (.mcp.json)", tools?.configPath],
          ["共享 Skills 目录", tools?.skillsRoot],
        ])}
        ${tools?.error ? `<div class="alert-row danger"><div class="alert-text">${escapeHtml(tools.error)}</div></div>` : ""}
        <div class="item-sub-wrap">
          <strong>活跃 MCP：</strong>${escapeHtml(activeServers.map((s) => s.name).join("、") || "无")}
          ${disabledServers.length ? ` · <span class="text-muted">已禁用：${escapeHtml(disabledServers.map((s) => s.name).join("、"))}</span>` : ""}
        </div>
        <div class="item-sub-wrap">
          <strong>已安装 Skills：</strong>${escapeHtml(skills.map((s) => s.name).join("、") || "无")}
        </div>
      </div>
    </div>

    <div class="two-col">
      <div class="card">
        <div class="card-header">
          <div>
            <h3 class="card-title">编辑共享 .mcp.json</h3>
            <div class="card-sub">保存后在下一轮对话加载；密钥请使用环境变量引用</div>
          </div>
        </div>
        <div class="card-body">
          <form id="${engine}-mcp-editor-form" class="item-list">
            <textarea class="textarea code-editor" id="${engine}-mcp-textarea" rows="10" spellcheck="false" aria-label="${engine} MCP JSON">${escapeHtml(tools?.mcpJson || '{\n  "mcpServers": {}\n}')}</textarea>
            <div class="inline-actions">
              <button class="btn btn-primary btn-sm" type="submit">校验并保存 MCP</button>
            </div>
          </form>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div>
            <h3 class="card-title">从全局 ~/.codex 导入 MCP / Skills</h3>
            <div class="card-sub">Skills 通过目录链接共享，已有同名项保持不变</div>
          </div>
        </div>
        <div class="card-body">
          <form id="${engine}-migrate-form" class="item-list">
            <div class="field">
              <label>可导入 MCP</label>
              <div class="checkbox-list">
                ${srcMcp.map((item) => `
                  <label class="checkbox-row">
                    <input type="checkbox" name="mcp" value="${escapeHtml(item.name)}" />
                    <span>${escapeHtml(item.name)}${item.needsReview ? "（需核对适配）" : ""}</span>
                  </label>
                `).join("") || `<span class="field-hint">无新增可导入 MCP。</span>`}
              </div>
            </div>
            <div class="field">
              <label>可链接 Skills</label>
              <div class="checkbox-list">
                ${srcSkills.map((item) => `
                  <label class="checkbox-row">
                    <input type="checkbox" name="skills" value="${escapeHtml(item.name)}" />
                    <span>${escapeHtml(item.name)}${item.needsReview ? "（含 Codex 专用工具）" : ""}</span>
                  </label>
                `).join("") || `<span class="field-hint">无新增可导入 Skills。</span>`}
              </div>
            </div>
            <div class="inline-actions">
              <button class="btn btn-primary btn-sm" type="submit">导入所选能力</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  `;
}

export function renderCapabilitiesView(container, actions = {}) {
  if (!container) return;
  const state = store.desktopState;
  if (!state) {
    container.innerHTML = "";
    return;
  }

  const activeTab = store.capabilityTab || "matrix";
  const probing = store.busyActions.has("probe-mcp-health");

  container.innerHTML = `
    <div class="toolbar card">
      <div class="segmented" role="tablist" aria-label="工具与技能视角切换">
        <button class="seg-btn ${activeTab === "matrix" ? "active" : ""}" type="button" data-cap-tab="matrix">统一健康矩阵</button>
        <button class="seg-btn ${activeTab === "codex" ? "active" : ""}" type="button" data-cap-tab="codex">Codex (.codex)</button>
        <button class="seg-btn ${activeTab === "claude" ? "active" : ""}" type="button" data-cap-tab="claude">Claude (claude-tools)</button>
        <button class="seg-btn ${activeTab === "antigravity" ? "active" : ""}" type="button" data-cap-tab="antigravity">Antigravity (antigravity-tools)</button>
      </div>
    </div>

    ${activeTab === "matrix" ? renderMatrixTab(state, store.mcpHealth, probing) : ""}
    ${activeTab === "codex" ? renderCodexCapabilitiesTab(state) : ""}
    ${activeTab === "claude" ? renderSharedEngineCapabilitiesTab("claude", state.claudeCapabilities) : ""}
    ${activeTab === "antigravity" ? renderSharedEngineCapabilitiesTab("antigravity", state.antigravityCapabilities, state.antigravityConfiguration?.home) : ""}
  `;

  container.querySelectorAll("[data-cap-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setState({ capabilityTab: btn.dataset.capTab });
    });
  });

  container.querySelector("#btn-run-mcp-probe")?.addEventListener("click", () => {
    actions.onRunMcpProbe?.();
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

  container.querySelectorAll("[data-codex-migrate-bot]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const botName = btn.dataset.codexMigrateBot;
      if (!botName) return;
      btn.disabled = true;
      try {
        const preview = await api.previewCapabilityMigration({ name: botName });
        const mcpNames = (preview?.mcpServers || []).map((m) => m.name);
        const skillNames = (preview?.skills || []).map((s) => s.name);
        if (!mcpNames.length && !skillNames.length) {
          showToast("该隔离空间已具备全部全局能力，无需迁移", "ok");
          return;
        }
        await api.applyCapabilityMigration({ name: botName, selection: { mcpServers: mcpNames, skills: skillNames } });
        showToast(`已迁移 MCP ${mcpNames.length} 个、Skills ${skillNames.length} 个`, "ok");
        await actions.onRefresh?.({ force: true });
      } catch (error) {
        showToast(formatIpcError(error), "error");
      } finally {
        btn.disabled = false;
      }
    });
  });

  for (const engine of ["claude", "antigravity"]) {
    container.querySelector(`#${engine}-mcp-editor-form`)?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const textarea = container.querySelector(`#${engine}-mcp-textarea`);
      const btn = event.submitter;
      if (btn) btn.disabled = true;
      try {
        if (engine === "claude") await api.claudeSaveMcp(textarea.value);
        else await api.antigravitySaveMcp(textarea.value);
        showToast("共享 .mcp.json 已校验并保存", "ok");
        await actions.onRefresh?.({ force: true });
      } catch (error) {
        showToast(formatIpcError(error), "error");
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    container.querySelector(`#${engine}-migrate-form`)?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(event.target);
      const mcp = formData.getAll("mcp").map(String);
      const skills = formData.getAll("skills").map(String);
      if (!mcp.length && !skills.length) {
        showToast("请先勾选要导入的 MCP 或 Skills", "warn");
        return;
      }
      const btn = event.submitter;
      if (btn) btn.disabled = true;
      try {
        const res = engine === "claude"
          ? await api.claudeMigrateCapabilities({ mcp, skills })
          : await api.antigravityMigrateCapabilities({ mcp, skills });
        showToast(`导入完成：MCP +${res.added?.length || 0}，Skills 链接 +${res.linked?.length || 0}`, "ok");
        await actions.onRefresh?.({ force: true });
      } catch (error) {
        showToast(formatIpcError(error), "error");
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }
}
