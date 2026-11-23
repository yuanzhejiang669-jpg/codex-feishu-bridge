const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile, execFileSync, spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const sourceEngineRoot = process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'engine', 'src', 'antigravity', 'configuration.cjs'))
  ? path.join(process.resourcesPath, 'engine') : path.resolve(__dirname, '../../../../..');
const configuration = require(path.join(sourceEngineRoot, 'src', 'antigravity', 'configuration.cjs'));
const accountLock = require(path.join(sourceEngineRoot, 'src', 'antigravity', 'account-lock.cjs'));
const { readCatalog, normalizeProvider, atomicJson, selectProvider, readJson, catalogPath, ID, NATIVE_MODES, readAccounts, accountCatalogPath } = configuration;

async function inspectAntigravityRuntime(options = {}) {
  const home = options.userHome || os.homedir();
  const candidates = [options.antigravityPath, process.env.ANTIGRAVITY_CLI_BIN,
    path.join(home, 'AppData', 'Local', 'agy', 'bin', 'agy.exe'), path.join(home, '.local', 'bin', 'agy'), '/usr/local/bin/agy'].filter(Boolean);
  const runtimePath = candidates.find((item) => fs.existsSync(item)) || '';
  if (!runtimePath) return { engine: 'antigravity', available: false, runtimePath, version: '', error: '未安装官方 Antigravity CLI (agy)' };
  return new Promise((resolve) => execFile(runtimePath, ['--version'], { windowsHide: true, timeout: 15_000, encoding: 'utf8' }, (error, stdout) => {
    const version = String(stdout || '').match(/\d+\.\d+\.\d+/)?.[0] || '';
    const parts = version.split('.').map(Number);
    const supported = parts[0] > 1 || (parts[0] === 1 && parts[1] >= 5);
    resolve({ engine: 'antigravity', available: !error && supported, runtimePath, version,
      error: error ? error.message : supported ? '' : '需要 Antigravity CLI 1.5 或更高版本（ACP）' });
  }));
}

function inspectAntigravity(options) {
  return { providers: readCatalog(options.dataRoot).providers.map((item) => ({ ...item,
    credentialAvailable: item.mode === 'official' || Boolean((options.environment || process.env)[item.envKey]) })),
    accounts: readAccounts(options.dataRoot), sharedSystemLogin: true,
    home: path.join(options.dataRoot, 'antigravity-home'), toolsRoot: path.join(options.dataRoot, 'antigravity-tools') };
}

async function nativeSession(raw, options, probe = false) {
  const runtime = await (options.inspectRuntime || inspectAntigravityRuntime)(options);
  if (!runtime.available) throw new Error(runtime.error);
  const provider = raw.baseUrl || (raw.mode && raw.id !== 'official')
    ? normalizeProvider(raw) : selectProvider(options.dataRoot, raw.id || 'official');
  const apiKey = provider.mode === 'gemini-api'
    ? String(raw.apiKey || await options.readCredential?.(provider.envKey) || (options.environment || process.env)[provider.envKey] || '') : '';
  const { AntigravityAcpClient } = await import(pathToFileURL(path.join(options.engineRoot, 'src', 'antigravity', 'acp-client.mjs')).href);
  const geminiDir = path.join(options.dataRoot, 'antigravity-home');
  fs.mkdirSync(geminiDir, { recursive: true });
  const logs = path.join(options.dataRoot, 'antigravity-tools'); fs.mkdirSync(logs, { recursive: true });
  const releaseAccount = accountLock.acquireOfficialLease(options.dataRoot, provider);
  let client;
  try {
    client = (options.createClient || ((value) => new AntigravityAcpClient(value)))({ command: runtime.runtimePath, cwd: options.userHome || os.homedir(), geminiDir,
      logFile: path.join(logs, probe ? 'provider-test.log' : 'model-discovery.log'),
      provider: { ...provider, apiKey }, environment: options.environment || process.env, requestTimeoutMs: 30_000, idleTimeoutMs: 45_000 });
    const startedAt = Date.now();
    const result = await client.openSession(probe ? { model: raw.model || provider.model, effort: raw.effort || provider.effort } : {});
    if (provider.mode === 'gemini-api' && result.models?.availableModels?.some((item) => /^claude-/.test(item.modelId))) {
      throw new Error('原生 CLI 返回了官方订阅模型目录，Gemini API 模式未生效，已拒绝保存');
    }
    const metadata = { models: result.models?.availableModels || [], defaultModel: result.models?.currentModelId || '',
      configOptions: result.configOptions || [], modes: result.modes, tier: result._meta?.antigravity?.tier,
      version: runtime.version, observedAt: new Date().toISOString() };
    if (!probe) return metadata;
    const answer = await client.prompt([{ type: 'text', text: 'This is a connection test. Do not use any tools or read files. Reply with exactly ANTIGRAVITY_PROVIDER_OK.' }]);
    if (answer.text?.trim() !== 'ANTIGRAVITY_PROVIDER_OK') throw new Error('渠道未通过原生 CLI 文本生成测试；请检查模型兼容性与接口响应');
    return { ...metadata, model: raw.model || provider.model || metadata.defaultModel, elapsedMs: Date.now() - startedAt, verified: true };
  } finally { await client?.close(); releaseAccount(); }
}
const listAntigravityModels = (raw, options) => nativeSession(raw || {}, options);
const probeAntigravityProvider = (raw, options) => nativeSession(raw || {}, options, true);

async function saveAntigravityProvider(raw, options) {
  const provider = normalizeProvider(raw);
  if (provider.mode === 'gemini-api') {
    const apiKey = String(raw.apiKey || await options.readCredential(provider.envKey) || '');
    if (!apiKey) throw new Error('请填写渠道 API Key');
    const discovered = await listAntigravityModels({ ...provider, apiKey }, options);
    if (provider.model && !discovered.models.some((item) => item.modelId === provider.model)) throw new Error('当前原生 ACP 不支持这个模型 ID，请选择实时列表中的 Gemini 模型');
    await probeAntigravityProvider({ ...provider, apiKey }, options);
    await options.setCredential(provider.envKey, apiKey);
    provider.models = discovered.models; provider.observedAt = discovered.observedAt;
  }
  const catalog = readCatalog(options.dataRoot);
  catalog.providers = catalog.providers.filter((item) => item.id !== provider.id && item.id !== 'official').concat(provider);
  atomicJson(catalogPath(options.dataRoot), catalog);
  return { provider: { ...provider, credentialAvailable: true }, restartIdleBotsRequired: true };
}

function previewAntigravityBot(raw, options, existing = []) {
  const name = String(raw.name || '').trim(); const profile = String(raw.profile || name).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(profile)) throw new Error('Bot 或飞书 Profile 标识无效');
  const brand = raw.brand || 'feishu'; if (!['feishu', 'lark'].includes(brand)) throw new Error('平台无效');
  const workspace = path.resolve(raw.workspace || path.join(options.workspaceRoot, `feishu-bridge-${name}`));
  if (workspace === path.parse(workspace).root) throw new Error('工作空间不能是磁盘根目录');
  const antigravityHome = path.join(options.dataRoot, 'antigravity-home');
  const bot = { name, label: String(raw.label || name).slice(0, 100), profile, brand, engine: 'antigravity',
    workspace, antigravityHome, codexHome: '', codexHomeMode: 'isolated' };
  const exists = existing.includes(name);
  return { bot, paths: { workspace, antigravityHome, botConfig: path.join(options.dataRoot, 'managed-bots', name, 'bot.json') },
    available: !exists, conflict: exists ? `Bot 标识已存在：${name}` : '', target: { mode: 'antigravity' } };
}

function antigravityProviderReference(raw, options) {
  const id = raw.providerId || raw.provider?.id || 'official'; const provider = selectProvider(options.dataRoot, id);
  return { mode: 'antigravity', id: provider.id, name: provider.name, model: raw.model || raw.provider?.model || provider.model || '',
    reasoning: raw.reasoning || raw.provider?.reasoning || provider.effort || '', accountId: provider.accountId || '' };
}

function ensureAntigravitySkills(options) {
  const source = path.join(options.dataRoot, 'antigravity-tools', '.agents', 'skills');
  const target = path.join(options.dataRoot, 'antigravity-home', 'config', 'skills');
  fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(path.dirname(target), { recursive: true });
  try { fs.lstatSync(target); return { source, target, created: false }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
  return { source, target, created: true };
}

async function createAntigravityBot(raw, credentials, options, helpers) {
  const preview = previewAntigravityBot(raw, options, helpers.readManagedBots(options.dataRoot).map((item) => item.name));
  if (!preview.available) throw new Error(preview.conflict);
  const provider = antigravityProviderReference(raw, options);
  if (!/^cli_[A-Za-z0-9]+$/.test(credentials?.appId || '') || !credentials?.appSecret) throw new Error('飞书应用凭据无效');
  await helpers.assertLarkProfileAvailable(preview.bot.profile, options);
  const permissionMode = raw.permissionMode || 'always-proceed'; if (!NATIVE_MODES.has(permissionMode)) throw new Error('权限模式无效');
  const destination = path.join(options.dataRoot, 'managed-bots', preview.bot.name);
  const transaction = path.join(options.dataRoot, '.transactions', crypto.randomUUID());
  fs.mkdirSync(transaction, { recursive: true });
  let profileAdded = false;
  try {
    fs.mkdirSync(preview.bot.workspace, { recursive: true }); fs.mkdirSync(preview.bot.antigravityHome, { recursive: true });
    ensureAntigravitySkills(options);
    await (options.runLarkCli || helpers.runLarkCli)(options.larkCliPath,
      ['profile', 'add', '--name', preview.bot.profile, '--app-id', credentials.appId, '--brand', preview.bot.brand, '--app-secret-stdin'],
      { input: credentials.appSecret, profileHome: path.join(options.dataRoot, 'profile-home') });
    profileAdded = true;
    const config = { schemaVersion: 2, ...preview.bot, provider, antigravity: { permissionMode },
      appId: credentials.appId, state: 'configured', createdAt: new Date().toISOString(), autoStart: false,
      permissionPolicy: require('./permission-policy.cjs').publicPermissionPolicy() };
    atomicJson(path.join(transaction, 'bot.json'), config); fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(transaction, destination);
    return { ...config, configPath: path.join(destination, 'bot.json') };
  } catch (error) {
    if (profileAdded) await (options.runLarkCli || helpers.runLarkCli)(options.larkCliPath, ['profile', 'remove', preview.bot.profile], { profileHome: path.join(options.dataRoot, 'profile-home') }).catch(() => {});
    fs.rmSync(transaction, { recursive: true, force: true }); throw error;
  }
}

function previewAntigravityFactory(raw, options, existing) {
  const count = Number(raw.count ?? 5); const baseIndex = Number(raw.baseIndex ?? 1);
  if (!Number.isInteger(count) || count < 1 || count > 16 || !Number.isInteger(baseIndex) || baseIndex < 1) throw new Error('Bot 数量或起始序号无效');
  const provider = antigravityProviderReference(raw, options);
  const bots = Array.from({ length: count }, (_, offset) => {
    const index = baseIndex + offset;
    const name = String(raw.namePattern || 'antigravity-{index}').replaceAll('{index}', String(index));
    const preview = previewAntigravityBot({ ...raw, name, profile: name, label: String(raw.labelPattern || 'Antigravity-{index}').replaceAll('{index}', String(index)), workspace: '' }, options, existing);
    return { ...preview.bot, index, conflicts: preview.available ? [] : [preview.conflict] };
  });
  if (new Set(bots.map((item) => item.name)).size !== count) throw new Error('名称模板生成重复标识');
  return { factory: { engine: 'antigravity', count, baseIndex, spaceName: raw.spaceName || 'Antigravity', slug: 'antigravity',
    providerId: provider.id, providerReference: provider, model: provider.model, reasoning: provider.reasoning,
    permissionMode: raw.permissionMode || 'always-proceed', namePattern: raw.namePattern || 'antigravity-{index}', labelPattern: raw.labelPattern || 'Antigravity-{index}',
    codexHome: path.join(options.dataRoot, 'antigravity-home') }, bots, available: bots.every((item) => !item.conflicts.length) };
}

function nativeCredential(action, value, options) {
  if ((options.platform || process.platform) !== 'win32') throw new Error('此版本的多账号快照管理仅支持 Windows；其他平台可使用系统当前官方登录');
  const helper = path.join(options.engineRoot, 'src', 'antigravity', 'windows-keyring.ps1');
  try {
    const output = (options.execFileSync || execFileSync)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', helper, '-Action', action],
      { input: value ? JSON.stringify(value) : undefined, encoding: 'utf8', windowsHide: true, timeout: 20_000, maxBuffer: 128 * 1024 });
    return JSON.parse(output.replace(/^\uFEFF/, ''));
  } catch { throw new Error('无法访问 Antigravity 系统凭据。请核对 Windows 登录用户、PowerShell 执行策略和官方登录状态。'); }
}
function captureAntigravityAccount(raw, options) {
  const id = String(raw.id || '').toLowerCase().trim(); if (!ID.test(id) || id === 'current') throw new Error('请填写账号别名（小写字母、数字、短横线）');
  return accountLock.withAccountMutex(options.dataRoot, () => {
  accountLock.assertLoginClosed(options.dataRoot);
  if (accountLock.liveLeases(options.dataRoot).length) throw new Error('Antigravity 官方账号仍被使用，请结束任务后再保存账号');
  const credential = (options.readNativeCredential || (() => nativeCredential('read', null, options)))();
  if (!credential.found || !credential.blob) throw new Error('尚无官方登录，请先在原生 CLI 中登录');
  const accounts = readAccounts(options.dataRoot);
  if (accounts.accounts.some((item) => item.id === id)) throw new Error('账号别名已存在，请使用新别名');
  const encrypted = options.encrypt(JSON.stringify(credential));
  if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw new Error('系统凭据加密失败');
  const accountRoot = path.join(options.dataRoot, 'antigravity-account-credentials'); fs.mkdirSync(accountRoot, { recursive: true });
  fs.writeFileSync(path.join(accountRoot, `${id}.bin`), encrypted, { flag: 'wx', mode: 0o600 });
  const record = { id, name: String(raw.name || id).slice(0, 100), createdAt: new Date().toISOString() };
  accounts.accounts.push(record); accounts.activeId = id; atomicJson(accountCatalogPath(options.dataRoot), accounts);
  return record;
  });
}
async function switchAntigravityAccount(raw, options) {
  const accounts = readAccounts(options.dataRoot); const account = accounts.accounts.find((item) => item.id === raw.id);
  if (!account) throw new Error('官方账号不存在');
  const busy = (await options.inspectBots()).filter((item) => item.engine === 'antigravity' && item.activeRunCount > 0);
  if (busy.length) throw new Error(`Antigravity 任务仍在运行：${busy.map((item) => item.name).join('、')}；请结束后再切换`);
  const external = options.inspectExternalClients ? await options.inspectExternalClients() : [];
  if (external.length) throw new Error('请先退出原生 Antigravity App 和 CLI，再切换系统共享登录账号');
  accountLock.withAccountMutex(options.dataRoot, () => {
    accountLock.assertLoginClosed(options.dataRoot);
    if (accountLock.liveLeases(options.dataRoot).length) throw new Error('Antigravity 官方账号仍被使用，请稍后重试');
    const file = path.join(options.dataRoot, 'antigravity-account-credentials', `${account.id}.bin`);
    const credential = JSON.parse(options.decrypt(fs.readFileSync(file)));
    (options.writeNativeCredential || ((value) => nativeCredential('write', value, options)))(credential);
    const latest = readAccounts(options.dataRoot); latest.activeId = account.id; atomicJson(accountCatalogPath(options.dataRoot), latest);
  });
  return { accountId: account.id, sharedSystemLogin: true, appliesToNextTurn: true };
}

async function inspectAntigravityClients() {
  if (process.platform !== 'win32') return [];
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-Process -Name Antigravity,agy -ErrorAction SilentlyContinue | Select-Object Id,ProcessName | ConvertTo-Json -Compress"],
  { windowsHide: true, timeout: 15_000, encoding: 'utf8' }, (error, stdout) => {
    if (error && !stdout.trim()) { reject(new Error('无法检查 Antigravity 原生进程，请稍后重试')); return; }
    try { const data = stdout.trim() ? JSON.parse(stdout) : []; resolve(Array.isArray(data) ? data : [data]); }
    catch { reject(new Error('Antigravity 进程检查未返回有效结果')); }
  }));
}

async function openAntigravityLogin(options) {
  if ((options.platform || process.platform) !== 'win32') throw new Error('请在系统终端中运行 agy 完成官方登录，再回到客户端');
  const runtime = await inspectAntigravityRuntime(options);
  if (!runtime.available) throw new Error(runtime.error);
  const external = await (options.inspectExternalClients || inspectAntigravityClients)();
  if (external.length) throw new Error('请先退出已有 Antigravity App 和 CLI，再打开官方账号登录窗口');
  const home = path.join(options.dataRoot, 'antigravity-home'); fs.mkdirSync(home, { recursive: true });
  const literal = (value) => "'" + value.replace(/'/g, "''") + "'";
  const script = `$Host.UI.RawUI.WindowTitle='Antigravity official login'; & ${literal(runtime.runtimePath)} --gemini-dir ${literal(home)}`;
  return accountLock.withAccountMutex(options.dataRoot, () => {
    accountLock.assertLoginClosed(options.dataRoot);
    if (accountLock.liveLeases(options.dataRoot).length) throw new Error('Antigravity 任务仍在使用官方账号，请结束任务后登录');
    const child = (options.spawn || spawn)('powershell.exe', ['-NoProfile', '-NoExit', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { detached: true, windowsHide: false, stdio: 'ignore', env: { ...process.env, GEMINI_API_KEY: '', GOOGLE_API_KEY: '', GOOGLE_GEMINI_BASE_URL: '' } });
    if (!child.pid) throw new Error('无法打开官方 CLI 登录窗口');
    child.on('error', () => {}); child.unref();
    atomicJson(path.join(options.dataRoot, 'antigravity-login-session.json'), { pid: child.pid, openedAt: Date.now() });
    return { opened: true, pid: child.pid, instruction: '在原生 CLI 中按提示登录；更换账号使用 /logout。完成后关闭此窗口，再保存账号别名。' };
  });
}

function assignAntigravityProvider(raw, options, bots) {
  const names = [...new Set(raw.botNames || [])];
  if (!names.length) throw new Error('请至少选择一个 Antigravity Bot');
  const selected = names.map((name) => bots.find((item) => item.name === name && item.engine === 'antigravity'));
  if (selected.some((item) => !item)) throw new Error('选择中包含不存在或其他内核的 Bot');
  const provider = antigravityProviderReference(raw, options);
  for (const bot of selected) { const config = readJson(bot.configPath, {}); config.provider = provider; atomicJson(bot.configPath, config); }
  return { botNames: names, appliesToNextTurn: true, sessionOverridesPreserved: true };
}

module.exports = { inspectAntigravityRuntime, inspectAntigravity, listAntigravityModels, probeAntigravityProvider, saveAntigravityProvider,
  previewAntigravityBot, createAntigravityBot, previewAntigravityFactory, antigravityProviderReference,
  captureAntigravityAccount, switchAntigravityAccount, inspectAntigravityClients, openAntigravityLogin, assignAntigravityProvider, ensureAntigravitySkills };
