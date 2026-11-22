(() => {
  const api = window.bridgeDesktop;
  let state;
  const $ = (id) => document.getElementById(`agy-${id}`);
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const values = (form) => Object.fromEntries(new FormData(form));
  const effortOptions = '<option value="">原生默认</option>' + ['low', 'medium', 'high', 'xhigh', 'max'].map((value) => `<option>${value}</option>`).join('');
  function section(view, id, title, body) {
    const element = document.createElement('section'); element.className = 'content-section'; element.id = `agy-${id}`;
    element.innerHTML = `<div class="section-heading"><h2>${title}</h2><span class="badge neutral">Antigravity CLI / ACP</span></div>${body}`;
    document.getElementById(view).prepend(element);
  }
  section('providers-view', 'providers', 'Antigravity 账号与渠道', `
    <p class="readiness-summary">使用官方 agy CLI。Windows 官方登录为系统共用；账号可加密保存并手动切换。切换前需结束 Antigravity 任务并退出原生 App / CLI。</p>
    <div id="agy-accounts" class="capability-list"></div>
    <details><summary>添加官方账号</summary><p class="form-note">打开原生 CLI 登录；更换账号时使用 /logout，按官方提示重新登录。完成后关闭登录窗口，再保存账号别名。不会自动轮换账号。</p>
      <button id="agy-login" class="secondary-button" type="button">打开官方登录窗口</button>
      <form id="agy-account-form" class="form-grid"><label><span>账号别名</span><input name="id" required pattern="[a-z0-9][a-z0-9_.-]{0,63}" placeholder="google-main"></label><label><span>显示名称</span><input name="name" placeholder="我的官方账号"></label><button type="submit" class="primary-button">保存当前官方登录</button></form>
    </details><p id="agy-account-status" class="form-note" role="status"></p>
    <div id="agy-provider-list" class="capability-list"></div>
    <details id="agy-provider-editor"><summary>添加或编辑渠道</summary><form id="agy-provider-form" class="form-grid">
      <label><span>渠道 ID</span><input name="id" required pattern="[a-z0-9][a-z0-9_.-]{0,63}" placeholder="my-gemini"></label><label><span>名称</span><input name="name"></label>
      <label><span>来源</span><select name="mode"><option value="gemini-api">Gemini API 兼容渠道</option><option value="official">已保存的官方账号</option></select></label>
      <label><span>官方账号</span><select name="accountId" id="agy-provider-account"></select></label>
      <label class="form-wide"><span>Gemini Base URL</span><input type="url" name="baseUrl" placeholder="https://generativelanguage.googleapis.com"></label>
      <label><span>API Key（留空保留已保存密钥）</span><input type="password" name="apiKey" autocomplete="new-password"></label>
      <label><span>模型</span><input name="model" list="agy-models" placeholder="留空使用 CLI 默认"><datalist id="agy-models"></datalist></label>
      <label><span>思考强度</span><select name="effort">${effortOptions}</select></label>
      <p class="form-wide form-note">第三方端点需支持 Gemini GenerateContent 与流式响应；模型必须在当前 CLI 原生目录中。OpenAI / Anthropic 协议不能直接填入。</p>
      <div class="form-wide inline-actions"><button id="agy-list-models" type="button" class="secondary-button">读取原生模型目录</button><button id="agy-probe" type="button" class="secondary-button">测试生成</button><button type="submit" class="primary-button">验证并保存</button><button id="agy-clear-provider" type="button" class="link-button">清空</button></div>
    </form></details><p id="agy-provider-status" class="form-note" role="status"></p>
    <details><summary>为 Bot 设置默认渠道</summary><form id="agy-assignment-form" class="form-grid">
      <label><span>渠道</span><select name="providerId" id="agy-assignment-provider"></select></label><label><span>默认模型</span><input name="model" list="agy-models"></label><label><span>思考强度</span><select name="reasoning">${effortOptions}</select></label>
      <div id="agy-assignment-bots" class="form-wide capability-list"></div><button type="submit" class="primary-button">应用到所选 Bot</button>
    </form><p class="form-note">已有会话保留各自的渠道覆盖；/new 后使用新默认值。原生会话跨渠道时需新建会话。</p></details>`);
  section('bots-view', 'factory', '创建 Antigravity-1～5', `
    <p class="readiness-summary">5 个 Bot 共用原生 Home、工具库与会话目录；同一会话只允许一个任务运行。每个 Bot 有自己的工作空间。生成队列后逐个扫码创建飞书应用。</p>
    <form id="agy-factory-form" class="form-grid">
      <label><span>渠道</span><select name="providerId" id="agy-factory-provider"></select></label><label><span>模型</span><input name="model" list="agy-models" placeholder="原生默认"></label><label><span>思考强度</span><select name="reasoning">${effortOptions}</select></label>
      <label><span>数量</span><input name="count" type="number" value="5" min="1" max="16" required></label><label><span>起始序号</span><input name="baseIndex" type="number" value="1" min="1" required></label>
      <label><span>权限模式</span><select name="permissionMode"><option value="default">默认（敏感工具在飞书确认）</option><option value="accept-edits">自动接受编辑</option><option value="plan">只规划</option><option value="always-proceed">始终允许工具（主动选择）</option></select></label>
      <div class="form-wide inline-actions"><button id="agy-preview-factory" type="button" class="secondary-button">预览</button><button id="agy-create-factory" type="submit" class="primary-button" disabled>生成 5 个 Bot 创建队列</button></div>
    </form><div id="agy-factory-preview" class="path-summary"></div><p id="agy-factory-status" class="form-note" role="status"></p>`);
  section('capabilities-view', 'tools', 'Antigravity MCP / Skills', `
    <dl id="agy-tools-paths" class="detail-grid"></dl><div id="agy-tools-inventory" class="path-summary"></div>
    <details><summary>编辑共享 MCP</summary><form id="agy-mcp-form" class="stack-form"><textarea id="agy-mcp-json" rows="10" spellcheck="false" aria-label="Antigravity MCP JSON"></textarea><p class="form-note">支持 stdio、HTTP、SSE。密钥使用环境变量引用，例如 $\{API_KEY\}。配置保存后下一轮加载。</p><button class="primary-button" type="submit">校验并保存</button></form></details>
    <details><summary>从当前 Codex 工具库导入</summary><form id="agy-migration-form"><div class="two-column"><div><h3>MCP</h3><div id="agy-source-mcp" class="capability-list"></div></div><div><h3>Skills</h3><div id="agy-source-skills" class="capability-list"></div></div></div><p class="form-note">Skills 链接到原目录；涉及 Codex 专用工具的技能需要适配。配置存在不代表每项业务已验证。</p><button type="submit" class="primary-button">导入所选</button></form></details><p id="agy-tools-status" class="form-note" role="status"></p>`);
  section('system-view', 'runtime', 'Antigravity 原生运行时', '<dl id="agy-runtime-details" class="detail-grid"></dl><p class="form-note">上下文容量与压缩由 Antigravity 原生管理；/context 显示 CLI 返回的使用量。</p>');

  const providerInput = () => { const input = values($('provider-form')); if (input.mode === 'official') { delete input.baseUrl; delete input.apiKey; } return input; };
  const factoryInput = () => ({ ...values($('factory-form')), engine: 'antigravity', brand: 'feishu', namePattern: 'antigravity-{index}', labelPattern: 'Antigravity-{index}' });
  async function refresh() { window.antigravityDesktop.onRefresh?.(await api.getState()); }
  async function action(button, target, callback) {
    if (button) button.disabled = true; target.textContent = '正在处理…';
    try { await callback(); } catch (error) { target.textContent = error.message || String(error); }
    finally { if (button) button.disabled = false; }
  }
  const modelOptions = (result) => { $('models').innerHTML = result.models.map((item) => `<option value="${escape(item.modelId)}">${escape(item.name)}</option>`).join(''); };
  function render(next) {
    state = next; const configuration = state.antigravityConfiguration || {}; const providers = configuration.providers || [];
    const accounts = configuration.accounts || { accounts: [] };
    $('accounts').innerHTML = accounts.accounts.map((item) => `<div class="capability-item"><strong>${escape(item.name)}</strong><span>${escape(item.id)}</span><button class="link-button" data-account="${escape(item.id)}" type="button" ${accounts.activeId === item.id ? 'disabled' : ''}>${accounts.activeId === item.id ? '当前保存账号' : '切换到此账号'}</button></div>`).join('') || '<p class="form-note">未保存账号快照；可直接使用系统当前官方登录。</p>';
    const previousAccount = $('provider-account').value;
    $('provider-account').innerHTML = '<option value="current">系统当前登录</option>' + accounts.accounts.map((item) => `<option value="${escape(item.id)}">${escape(item.name)}</option>`).join('');
    if (accounts.accounts.some((item) => item.id === previousAccount)) $('provider-account').value = previousAccount;
    $('provider-list').innerHTML = providers.map((item) => `<div class="capability-item"><strong>${escape(item.name)}</strong><span>${escape(item.mode)} · ${escape(item.model || '原生默认')}</span><span>${item.mode === 'official' ? '使用官方系统登录' : item.credentialAvailable ? '密钥已保存' : '缺少密钥'}</span>${item.id === 'official' ? '' : `<button class="link-button" data-provider="${escape(item.id)}" type="button">编辑</button>`}</div>`).join('');
    for (const kind of ['factory', 'assignment']) {
      const select = $(`${kind}-provider`); const previous = select.value;
      select.innerHTML = providers.map((item) => `<option value="${escape(item.id)}">${escape(item.name)}</option>`).join('');
      select.value = providers.some((item) => item.id === previous) ? previous : 'official';
    }
    const bots = (state.setup?.managedBots || []).filter((item) => item.engine === 'antigravity');
    const checked = new Set([...$('assignment-bots').querySelectorAll('input:checked')].map((input) => input.value));
    $('assignment-bots').innerHTML = bots.map((bot) => `<label class="checkbox-field"><input name="botNames" type="checkbox" value="${escape(bot.name)}" ${checked.has(bot.name) ? 'checked' : ''}><span>${escape(bot.label || bot.name)} · ${escape(bot.provider?.id || 'official')}</span></label>`).join('') || '<p class="form-note">尚未创建 Antigravity Bot。</p>';
    const tools = state.antigravityCapabilities || {};
    $('tools-paths').innerHTML = [['共享 Home', configuration.home], ['共享 MCP', tools.configPath], ['共享 Skills', tools.skillsRoot]].map(([key, value]) => `<dt>${key}</dt><dd>${escape(value)}</dd>`).join('');
    $('tools-inventory').textContent = `MCP：${(tools.mcpServers || []).map((item) => item.name).join('、') || '无'}；Skills：${(tools.skills || []).length} 个。${tools.error || ''}`;
    if (!$('mcp-json').dataset.dirty) $('mcp-json').value = tools.mcpJson || '{"mcpServers":{}}';
    for (const [id, list] of [['source-mcp', tools.sourceMcpServers], ['source-skills', tools.sourceSkills]]) {
      const selected = new Set([...$(id).querySelectorAll('input:checked')].map((input) => input.value));
      $(id).innerHTML = (list || []).map((item) => `<label class="checkbox-field"><input type="checkbox" value="${escape(item.name)}" ${selected.has(item.name) ? 'checked' : ''}><span>${escape(item.name)}${item.needsReview ? '（需适配）' : ''}</span></label>`).join('');
    }
    const runtime = state.antigravity || {};
    $('runtime-details').innerHTML = [['状态', runtime.available ? 'CLI 可用' : runtime.error || '未检测到'], ['CLI 版本', runtime.version], ['路径', runtime.runtimePath], ['已配置 Bot', bots.length]].map(([key, value]) => `<dt>${key}</dt><dd>${escape(value)}</dd>`).join('');
  }
  $('login').addEventListener('click', (event) => action(event.target, $('account-status'), async () => { const result = await api.antigravityOpenLogin(); $('account-status').textContent = result.instruction; }));
  $('account-form').addEventListener('submit', (event) => { event.preventDefault(); action(event.submitter, $('account-status'), async () => { await api.antigravityCaptureAccount(values(event.target)); await refresh(); $('account-status').textContent = '当前官方登录已加密保存。'; }); });
  $('accounts').addEventListener('click', (event) => { const button = event.target.closest('[data-account]'); if (button) action(button, $('account-status'), async () => { await api.antigravitySwitchAccount({ id: button.dataset.account }); await refresh(); $('account-status').textContent = '系统官方账号已切换，下一轮使用新账号。'; }); });
  $('provider-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-provider]'); if (!button) return;
    const item = state.antigravityConfiguration.providers.find((value) => value.id === button.dataset.provider);
    for (const name of ['id', 'name', 'mode', 'accountId', 'baseUrl', 'model', 'effort']) $('provider-form').elements[name].value = item[name] || '';
    $('provider-form').elements.apiKey.value = ''; $('provider-editor').open = true;
  });
  $('clear-provider').addEventListener('click', () => $('provider-form').reset());
  $('list-models').addEventListener('click', (event) => action(event.target, $('provider-status'), async () => { const result = await api.antigravityListModels(providerInput()); modelOptions(result); $('provider-status').textContent = `原生目录：${result.models.length} 个模型。`; }));
  $('probe').addEventListener('click', (event) => action(event.target, $('provider-status'), async () => { const result = await api.antigravityProbeProvider(providerInput()); $('provider-status').textContent = `原生生成验证通过：${result.model} · ${result.elapsedMs} ms`; }));
  $('provider-form').addEventListener('submit', (event) => { event.preventDefault(); action(event.submitter, $('provider-status'), async () => { await api.antigravitySaveProvider(providerInput()); $('provider-form').elements.apiKey.value = ''; await refresh(); $('provider-status').textContent = '渠道已保存；密钥更新将在 Bot 空闲时加载。'; }); });
  for (const kind of ['factory', 'assignment']) $(`${kind}-provider`).addEventListener('change', () => {
    const item = state.antigravityConfiguration.providers.find((value) => value.id === $(`${kind}-provider`).value);
    $(`${kind}-form`).elements.model.value = item?.model || ''; $(`${kind}-form`).elements.reasoning.value = item?.effort || '';
  });
  $('assignment-form').addEventListener('submit', (event) => { event.preventDefault(); action(event.submitter, $('provider-status'), async () => {
    await api.antigravityAssignProvider({ ...values(event.target), botNames: [...new FormData(event.target).getAll('botNames')] }); await refresh(); $('provider-status').textContent = 'Bot 默认渠道已更新，已有会话覆盖保留。';
  }); });
  $('factory-form').addEventListener('input', () => { $('create-factory').disabled = true; });
  $('preview-factory').addEventListener('click', (event) => action(event.target, $('factory-status'), async () => {
    const result = await api.previewWorkspaceFactory(factoryInput()); $('factory-preview').innerHTML = result.bots.map((bot) => `<span>${escape(bot.label)} · ${escape(bot.workspace)} ${escape(bot.conflicts.join('；'))}</span>`).join('');
    $('create-factory').disabled = !result.available; $('factory-status').textContent = result.available ? '预览通过。' : '有名称冲突，请调整序号。';
  }));
  $('factory-form').addEventListener('submit', (event) => { event.preventDefault(); action(event.submitter, $('factory-status'), async () => {
    await api.createWorkspaceFactoryQueue(factoryInput()); await refresh(); $('factory-status').textContent = '队列已生成。在“工作空间”的创建队列中逐个扫码注册。';
  }); });
  $('mcp-json').addEventListener('input', () => { $('mcp-json').dataset.dirty = '1'; });
  $('mcp-form').addEventListener('submit', (event) => { event.preventDefault(); action(event.submitter, $('tools-status'), async () => { await api.antigravitySaveMcp($('mcp-json').value); delete $('mcp-json').dataset.dirty; await refresh(); $('tools-status').textContent = '共享 MCP 已保存，下一轮加载。'; }); });
  $('migration-form').addEventListener('submit', (event) => { event.preventDefault(); action(event.submitter, $('tools-status'), async () => {
    const selected = (id) => [...$(id).querySelectorAll('input:checked')].map((item) => item.value);
    const result = await api.antigravityMigrateCapabilities({ mcp: selected('source-mcp'), skills: selected('source-skills') }); await refresh();
    $('tools-status').textContent = `导入 MCP ${result.added.length} 个，链接 Skills ${result.linked.length} 个。${result.skipped.map((item) => item.name + '：' + item.reason).join('；')}`;
  }); });
  window.antigravityDesktop = { render, onRefresh: null };
})();
