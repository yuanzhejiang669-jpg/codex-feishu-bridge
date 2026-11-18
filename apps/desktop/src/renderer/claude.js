(() => {
  const api = window.bridgeDesktop;
  let state;
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const $ = (id) => document.getElementById(id);
  const efforts = ['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => `<option ${effort === 'high' ? 'selected' : ''}>${effort}</option>`).join('');
  function section(view, id, title, body) {
    const node = document.createElement('section');
    node.className = 'content-section'; node.id = id;
    node.innerHTML = `<div class="section-heading"><h2>${title}</h2><span class="badge neutral">Claude Code CLI</span></div>${body}`;
    $(view).prepend(node);
    return node;
  }
  section('providers-view', 'claude-provider-section', 'Claude Provider', `
    <p class="readiness-summary">配置支持 Anthropic Messages API 的渠道。密钥保存在系统安全凭据存储中；更换渠道或 Key 后，空闲 Bot 会应用新配置，忙碌 Bot 等任务结束后应用。</p>
    <div id="claude-provider-list" class="capability-list"></div>
    <details id="claude-provider-editor"><summary>添加或编辑 Claude 渠道</summary>
      <form id="claude-provider-form" class="form-grid">
        <label><span>渠道标识</span><input name="id" required pattern="[a-z0-9_-]+" placeholder="my-claude-provider"></label>
        <label><span>显示名称</span><input name="name" placeholder="我的 Claude 渠道"></label>
        <label class="form-wide"><span>Base URL</span><input name="baseUrl" type="url" required placeholder="https://api.example.com"></label>
        <label><span>鉴权方式</span><select name="auth"><option value="bearer">Bearer Token</option><option value="x-api-key">x-api-key</option></select></label>
        <label><span>API Key（编辑时留空保留原 Key）</span><input name="apiKey" type="password" autocomplete="new-password"></label>
        <label><span>默认模型</span><input name="model" required list="claude-provider-models" placeholder="渠道提供的模型 ID"><datalist id="claude-provider-models"></datalist></label>
        <label><span>默认思考强度</span><select name="effort">${efforts}</select></label>
        <div class="form-wide inline-actions"><button id="claude-list-models" class="secondary-button" type="button">读取模型列表</button><button id="claude-probe" class="secondary-button" type="button">测试连接</button><button class="primary-button" type="submit">验证并保存</button><button id="claude-clear-provider" class="link-button" type="button">清空表单</button></div>
      </form>
    </details><p id="claude-provider-status" class="form-note" role="status"></p>
    <details><summary>为 Claude Bot 分配渠道</summary><form id="claude-assignment-form" class="form-grid">
      <label><span>Claude 渠道</span><select name="providerId" id="claude-assignment-provider" required></select></label>
      <label><span>模型</span><input name="model" id="claude-assignment-model" required list="claude-provider-models"></label>
      <label><span>思考强度</span><select name="reasoning">${efforts}</select></label>
      <div id="claude-assignment-bots" class="form-wide capability-list"></div>
      <div class="form-wide inline-actions"><button id="claude-select-bots" class="link-button" type="button">全选 Claude Bot</button><button class="primary-button" type="submit">应用到所选 Bot</button></div>
    </form><p id="claude-assignment-status" class="form-note" role="status"></p></details>`);
  section('bots-view', 'claude-factory-section', '创建 Claude 1～10', `
    <details><summary>展开 Claude Bot 创建设置</summary>
    <p class="readiness-summary">每个 Bot 固定使用 Claude Code CLI，拥有独立会话和 Claude Home。批量准备后逐个扫码创建飞书应用。</p>
    <form id="claude-factory-form" class="form-grid">
      <label><span>Claude 渠道</span><select name="providerId" id="claude-factory-provider" required></select></label>
      <label><span>模型</span><input name="model" id="claude-factory-model" required list="claude-provider-models"></label>
      <label><span>思考强度</span><select name="reasoning">${efforts}</select></label>
      <label><span>Bot 数量</span><input name="count" type="number" min="1" max="16" required value="10"></label>
      <label><span>起始序号</span><input name="baseIndex" type="number" min="1" max="999" required value="1"></label>
      <label><span>平台</span><select name="brand"><option value="feishu">飞书</option><option value="lark">Lark</option></select></label>
      <div class="form-wide inline-actions"><button id="claude-preview-factory" class="secondary-button" type="button">预览 Claude Bot</button><button id="claude-create-factory" class="primary-button" type="submit" disabled>生成创建队列</button></div>
    </form><div id="claude-factory-preview" class="path-summary hidden"></div><p id="claude-factory-status" class="form-note" role="status"></p>
    </details><p id="claude-pending-configuration" class="form-note"></p>`);
  section('capabilities-view', 'claude-tools-section', 'Claude MCP / Skills', `
    <p class="readiness-summary">Claude Bot 共用此工具库，也会读取各自 Claude Home 和工作空间的原生配置。更换 Provider 不影响工具库；保存的工具配置在下一轮对话加载。</p>
    <dl id="claude-tools-paths" class="detail-grid"></dl><div id="claude-tools-inventory" class="path-summary"></div>
    <details><summary>编辑共享 MCP 配置</summary><form id="claude-mcp-form" class="stack-form"><label><span>Claude 原生 .mcp.json</span><textarea id="claude-mcp-json" rows="10" spellcheck="false" aria-label="Claude MCP JSON"></textarea></label><p class="form-note">凭据使用环境变量引用，例如 Bearer \$\{TOKEN\}。已配置不代表已连接，实际连接状态由 Claude CLI 在运行时返回。</p><button class="primary-button" type="submit">校验并保存 MCP</button></form></details>
    <details><summary>从现有工具库导入</summary><form id="claude-migration-form"><div class="two-column"><div><h3>标准 MCP</h3><div id="claude-source-mcp" class="capability-list"></div></div><div><h3>Skills</h3><div id="claude-source-skills" class="capability-list"></div></div></div><p class="form-note">Skills 使用目录链接共享原文件。依赖 Codex 专用工具的 Skill 需要适配；已有同名配置会保留。</p><button class="primary-button" type="submit">导入所选工具</button></form></details>
    <p id="claude-tools-status" class="form-note" role="status"></p>`);
  section('system-view', 'claude-runtime-section', 'Claude Code CLI', `
    <dl id="claude-runtime-details" class="detail-grid"></dl><p class="form-note">Claude 原生管理上下文压缩。未取得实际容量资料时，Bridge 显示“未提供”，不套用 Codex 的窗口数字。</p>`);

  const values = (form) => Object.fromEntries(new FormData(form));
  const providerInput = () => values($('claude-provider-form'));
  const factoryInput = () => ({ ...values($('claude-factory-form')), engine: 'claude', spaceName: 'Claude', slug: 'claude', namePattern: 'claude-{index}', labelPattern: 'Claude {index}' });
  async function action(button, target, callback) {
    if (button) button.disabled = true;
    target.textContent = '正在处理…';
    try { await callback(); }
    catch (error) { target.textContent = error.message || String(error); }
    finally { if (button) button.disabled = false; }
  }
  async function refresh() { window.claudeDesktop.onRefresh?.(await api.getState()); }
  function providerOptions(select) {
    const selected = select.value;
    const providers = (state?.claudeProviders?.providers || []).filter((provider) => provider.credentialAvailable);
    select.innerHTML = '<option value="">请选择 Claude 渠道</option>' + providers.map((provider) => `<option value="${escape(provider.id)}">${escape(provider.name || provider.id)}</option>`).join('');
    select.value = providers.some((provider) => provider.id === selected) ? selected : providers[0]?.id || '';
  }
  function chooseProvider(select, model, effort) {
    const provider = state?.claudeProviders?.providers.find((item) => item.id === select.value);
    if (provider) { model.value = provider.model; if (effort) effort.value = provider.effort; }
  }
  function render(currentState) {
    state = currentState;
    const providers = state.claudeProviders?.providers || [];
    $('claude-provider-list').innerHTML = providers.map((provider) => `<div class="capability-item"><strong>${escape(provider.name || provider.id)}</strong><span>${escape(provider.baseUrl)} · ${escape(provider.model)} · ${escape(provider.effort)}</span><span class="badge ${provider.credentialAvailable ? 'good' : 'warn'}">${provider.credentialAvailable ? '密钥已保存' : '缺少密钥'}</span><button class="link-button claude-edit-provider" data-provider="${escape(provider.id)}" type="button">编辑／换 Key</button></div>`).join('') || '<p class="form-note">尚未配置 Claude 渠道。</p>';
    if (state.claudeProviders?.error) $('claude-provider-status').textContent = state.claudeProviders.error;
    for (const type of ['assignment', 'factory']) {
      const select = $(`claude-${type}-provider`); const old = select.value;
      providerOptions(select);
      if (select.value !== old || !$(`claude-${type}-model`).value) chooseProvider(select, $(`claude-${type}-model`), $(`claude-${type}-form`).elements.reasoning);
    }
    const selected = new Set([...$('claude-assignment-bots').querySelectorAll('input:checked')].map((input) => input.value));
    const bots = (state.setup?.managedBots || []).filter((bot) => bot.engine === 'claude');
    $('claude-assignment-bots').innerHTML = bots.map((bot) => `<label class="checkbox-field"><input type="checkbox" name="botNames" value="${escape(bot.name)}" ${selected.has(bot.name) ? 'checked' : ''}><span>${escape(bot.label || bot.name)} · ${escape(bot.provider?.id || '未配置')} · ${bot.activeRunCount || 0} 个任务</span></label>`).join('') || '<p class="form-note">创建 Claude Bot 后可在这里单独或批量分配。</p>';
    const pending = Object.keys(state.claudePendingConfiguration?.bots || {});
    $('claude-pending-configuration').textContent = pending.length ? `等待空闲后应用配置：${pending.join('、')}` : '';
    const tools = state.claudeCapabilities || {};
    $('claude-tools-paths').innerHTML = [['共享工具目录', tools.root], ['共享 MCP', tools.configPath], ['共享 Skills', tools.skillsRoot]].map(([name, value]) => `<dt>${name}</dt><dd>${escape(value)}</dd>`).join('');
    if (document.activeElement !== $('claude-mcp-json') && !$('claude-mcp-json').dataset.dirty) $('claude-mcp-json').value = tools.mcpJson || '{"mcpServers":{}}';
    $('claude-tools-inventory').innerHTML = `<span>已配置 MCP：${escape((tools.mcpServers || []).map((item) => item.name).join('、') || '无')}</span><span>已安装 Skills：${escape((tools.skills || []).map((item) => item.name).join('、') || '无')}</span>${tools.error ? `<span>${escape(tools.error)}</span>` : ''}`;
    for (const [id, list] of [['claude-source-mcp', tools.sourceMcpServers], ['claude-source-skills', tools.sourceSkills]]) {
      const checked = new Set([...$(id).querySelectorAll('input:checked')].map((input) => input.value));
      $(id).innerHTML = (list || []).map((item) => `<label class="checkbox-field"><input type="checkbox" value="${escape(item.name)}" ${checked.has(item.name) ? 'checked' : ''}><span>${escape(item.name)}${item.needsReview ? '（需适配 Codex 专用调用）' : ''}</span></label>`).join('');
    }
    const runtime = state.claude || {};
    $('claude-runtime-details').innerHTML = [['状态', runtime.available ? '可用' : runtime.error || '未检测到'], ['版本', runtime.version], ['CLI 路径', runtime.runtimePath], ['Claude Bot', bots.length],
      ...bots.filter((bot) => bot.claudeRuntime).map((bot) => [`${bot.label || bot.name} 上次运行`, `${bot.claudeRuntime.version || ''} · ${bot.claudeRuntime.model || ''} · ${bot.claudeRuntime.observedAt || ''} · MCP ${(bot.claudeRuntime.mcpServers || []).map((server) => server.name+': '+server.status).join('、') || '无'}`])].map(([name, value]) => `<dt>${escape(name)}</dt><dd>${escape(value)}</dd>`).join('');
  }
  $('claude-provider-section').addEventListener('click', (event) => {
    const button = event.target.closest('.claude-edit-provider');
    if (!button) return;
    const provider = state.claudeProviders.providers.find((item) => item.id === button.dataset.provider);
    for (const name of ['id', 'name', 'baseUrl', 'auth', 'model', 'effort']) $('claude-provider-form').elements[name].value = provider[name];
    $('claude-provider-form').elements.apiKey.value = '';
    $('claude-provider-editor').open = true;
  });
  $('claude-clear-provider').addEventListener('click', () => $('claude-provider-form').reset());
  $('claude-list-models').addEventListener('click', (event) => action(event.target, $('claude-provider-status'), async () => {
    const result = await api.claudeListModels(providerInput());
    $('claude-provider-models').innerHTML = result.models.map((model) => `<option value="${escape(model)}"></option>`).join('');
    $('claude-provider-status').textContent = `可用模型（${result.models.length}）：${result.models.join('、')}`;
  }));
  $('claude-probe').addEventListener('click', (event) => action(event.target, $('claude-provider-status'), async () => {
    const result = await api.claudeProbeProvider(providerInput());
    $('claude-provider-status').textContent = `连接成功：${result.model}，${result.elapsedMs || 0} ms。此处验证文本连接，工具能力由 CLI 实际运行验证。`;
  }));
  $('claude-provider-form').addEventListener('submit', (event) => {
    event.preventDefault(); action(event.submitter, $('claude-provider-status'), async () => {
      await api.claudeSaveProvider(providerInput());
      $('claude-provider-form').elements.apiKey.value = '';
      await refresh(); $('claude-provider-status').textContent = '已验证模型列表并保存；相关 Bot 将在空闲时应用配置。';
    });
  });
  for (const type of ['assignment', 'factory']) $(`claude-${type}-provider`).addEventListener('change', () => chooseProvider($(`claude-${type}-provider`), $(`claude-${type}-model`), $(`claude-${type}-form`).elements.reasoning));
  $('claude-select-bots').addEventListener('click', () => $('claude-assignment-bots').querySelectorAll('input').forEach((input) => { input.checked = true; }));
  $('claude-assignment-form').addEventListener('submit', (event) => {
    event.preventDefault(); action(event.submitter, $('claude-assignment-status'), async () => {
      const input = values(event.target); input.botNames = [...new FormData(event.target).getAll('botNames')];
      const result = await api.claudeAssignProvider(input); await refresh();
      $('claude-assignment-status').textContent = `已更新 ${result.botNames.length} 个 Claude Bot；正在执行的任务结束后应用。`;
    });
  });
  $('claude-factory-form').addEventListener('input', () => { $('claude-create-factory').disabled = true; });
  $('claude-preview-factory').addEventListener('click', (event) => action(event.target, $('claude-factory-status'), async () => {
    const result = await api.previewWorkspaceFactory(factoryInput());
    $('claude-factory-preview').innerHTML = result.bots.map((bot) => `<span><strong>${escape(bot.label)}</strong> · ${escape(bot.name)}${bot.conflicts.length ? ' · '+escape(bot.conflicts.join('；')) : ''}</span><code>${escape(bot.claudeHome)}</code>`).join('');
    $('claude-factory-preview').classList.remove('hidden'); $('claude-create-factory').disabled = !result.available;
    $('claude-factory-status').textContent = result.available ? '预览通过，每个 Bot 使用独立 Claude Home。' : '存在冲突，请调整起始序号或检查已有 Bot。';
  }));
  $('claude-factory-form').addEventListener('submit', (event) => {
    event.preventDefault(); action(event.submitter, $('claude-factory-status'), async () => {
      await api.createWorkspaceFactoryQueue(factoryInput()); await refresh();
      $('claude-factory-status').textContent = '队列已生成。请到“工作空间”的创建队列，逐个点击“扫码创建”完成飞书授权。';
    });
  });
  $('claude-mcp-json').addEventListener('input', () => { $('claude-mcp-json').dataset.dirty = '1'; });
  $('claude-mcp-form').addEventListener('submit', (event) => {
    event.preventDefault(); action(event.submitter, $('claude-tools-status'), async () => {
      await api.claudeSaveMcp($('claude-mcp-json').value); delete $('claude-mcp-json').dataset.dirty;
      await refresh(); $('claude-tools-status').textContent = '共享 MCP 已保存，下一轮对话由 Claude CLI 加载。';
    });
  });
  $('claude-migration-form').addEventListener('submit', (event) => {
    event.preventDefault(); action(event.submitter, $('claude-tools-status'), async () => {
      const selected = (id) => [...$(id).querySelectorAll('input:checked')].map((input) => input.value);
      const result = await api.claudeMigrateCapabilities({ mcp: selected('claude-source-mcp'), skills: selected('claude-source-skills') });
      await refresh();
      $('claude-tools-status').textContent = `已导入 MCP ${result.added.length} 个，链接 Skills ${result.linked.length} 个。${result.skipped.map((item) => `${item.name}：${item.reason}`).join('；')}${result.linked.some((item) => item.needsReview) ? ' 部分 Skill 含 Codex 专用调用，需适配后使用。' : ''}`;
    });
  });
  window.claudeDesktop = { render, onRefresh: null };
})();
