const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readCatalog, EFFORTS } = require('./claude-providers.cjs');
const { publicPermissionPolicy } = require('./permission-policy.cjs');

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,62}[A-Za-z0-9])?$/;

function providerReference(raw, options) {
  const id = String(raw.providerId || raw.provider?.id || '').trim();
  const provider = readCatalog(options.dataRoot).providers.find((item) => item.id === id);
  if (!provider) throw new Error('请选择已保存的 Claude Provider');
  if (!(options.env || process.env)[provider.envKey]) throw new Error(`Claude Provider ${id} 的密钥不可用`);
  const model = String(raw.model || raw.provider?.model || provider.model);
  if (!provider.models.includes(model)) throw new Error('Claude 模型不在该渠道已发现的列表中');
  const reasoning = String(raw.reasoning || raw.provider?.reasoning || provider.effort || 'high');
  if (!EFFORTS.has(reasoning)) throw new Error('Claude 思考强度无效');
  return { mode: 'claude', id, name: provider.name, model, reasoning, envKey: provider.envKey,
    baseUrl: provider.baseUrl, wireApi: 'anthropic-messages' };
}

function previewClaudeBot(raw, options, existing = []) {
  const name = String(raw.name || '').trim();
  if (!NAME.test(name)) throw new Error('Claude Bot 标识格式无效');
  const profile = String(raw.profile || name).trim();
  if (!NAME.test(profile)) throw new Error('飞书 Profile 格式无效');
  const workspace = path.resolve(raw.workspace || path.join(options.workspaceRoot, `feishu-bridge-${name}`));
  if (workspace === path.parse(workspace).root) throw new Error('工作空间不能是磁盘根目录');
  const claudeHome = path.resolve(options.dataRoot, 'claude-homes', name);
  if (raw.claudeHome && path.resolve(raw.claudeHome).toLowerCase() !== claudeHome.toLowerCase()) throw new Error('每个 Claude Bot 必须使用自己的隔离 Claude Home');
  if (claudeHome === path.parse(claudeHome).root) throw new Error('Claude Home 不能是磁盘根目录');
  const brand = String(raw.brand || 'feishu');
  if (!['feishu', 'lark'].includes(brand)) throw new Error('平台无效');
  const names = new Set([...existing, ...(options.existingNames || [])]);
  const bot = { name, profile, label: String(raw.label || name).slice(0, 100), brand, workspace,
    engine: 'claude', claudeHome, codexHome: '', codexHomeMode: 'isolated' };
  return { bot, paths: { workspace, claudeHome, codexHome: claudeHome,
    botConfig: path.join(options.dataRoot, 'managed-bots', name, 'bot.json'),
    runtimeRoot: options.runtimeLocalAppData ? path.join(options.runtimeLocalAppData, 'CodexFeishuBridge', 'instances', name) : '' },
    available: !names.has(name), conflict: names.has(name) ? `Bot 标识已存在：${name}` : '', target: { mode: 'claude' } };
}

async function createClaudeBot(raw, credentials, options, helpers) {
  const preview = previewClaudeBot(raw, options, helpers.readManagedBots(options.dataRoot).map((bot) => bot.name));
  if (!preview.available) throw new Error(preview.conflict);
  const provider = providerReference(raw, options);
  const appId = String(credentials?.appId || '').trim();
  const appSecret = String(credentials?.appSecret || '').trim();
  if (!/^cli_[A-Za-z0-9]+$/.test(appId) || !appSecret) throw new Error('飞书应用凭据无效');
  await helpers.assertLarkProfileAvailable(preview.bot.profile, options);
  const profileHome = path.join(options.dataRoot, 'profile-home');
  const transaction = path.join(options.dataRoot, '.transactions', crypto.randomUUID());
  const destination = path.join(options.dataRoot, 'managed-bots', preview.bot.name);
  const settingsFile = path.join(preview.bot.claudeHome, 'settings.json');
  if (fs.existsSync(settingsFile)) throw new Error('Claude Home 已有设置，已保留原配置；请使用新的 Bot Home');
  let profileAdded = false; let settingsCreated = false;
  fs.mkdirSync(transaction, { recursive: true });
  try {
    fs.mkdirSync(preview.bot.workspace, { recursive: true });
    fs.mkdirSync(preview.bot.claudeHome, { recursive: true });
    fs.mkdirSync(profileHome, { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify({ model: provider.model,
      modelSettings: { [provider.model]: { effortLevel: provider.reasoning || 'high' } } }, null, 2)+'\n', { encoding: 'utf8', flag: 'wx' });
    settingsCreated = true;
    await (options.runLarkCli || helpers.runLarkCli)(options.larkCliPath,
      ['profile', 'add', '--name', preview.bot.profile, '--app-id', appId, '--brand', preview.bot.brand, '--app-secret-stdin'],
      { input: appSecret, profileHome });
    profileAdded = true;
    const config = { schemaVersion: 2, ...preview.bot, provider, appId,
      claude: { permissionMode: 'bypassPermissions' }, permissionPolicy: publicPermissionPolicy(),
      state: 'configured', createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(transaction, 'bot.json'), JSON.stringify(config, null, 2)+'\n', 'utf8');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(transaction, destination);
    return { ...config, configPath: path.join(destination, 'bot.json') };
  } catch (error) {
    if (profileAdded) await (options.runLarkCli || helpers.runLarkCli)(options.larkCliPath,
      ['profile', 'remove', preview.bot.profile], { profileHome }).catch(() => {});
    if (settingsCreated) fs.rmSync(settingsFile, { force: true });
    fs.rmSync(transaction, { recursive: true, force: true });
    throw error;
  }
}

function previewClaudeFactory(raw, options, existing) {
  const count = Number(raw.count ?? 10); const baseIndex = Number(raw.baseIndex ?? 1);
  if (!Number.isInteger(count) || count < 1 || count > 16 || !Number.isInteger(baseIndex) || baseIndex < 1 || baseIndex > 999) throw new Error('Bot 数量或起始序号无效');
  const provider = providerReference(raw, options);
  const spaceName = String(raw.spaceName || 'Claude').slice(0,80);
  const slug = String(raw.slug || 'claude');
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(slug)) throw new Error('空间 slug 无效');
  const bots = [];
  for (let offset=0; offset<count; offset+=1) {
    const index = baseIndex + offset;
    const name = String(raw.namePattern || 'claude-{index}').replaceAll('{index}', String(index)).replaceAll('{slug}', slug);
    const label = String(raw.labelPattern || 'Claude {index}').replaceAll('{index}', String(index)).replaceAll('{space}', spaceName);
    const preview = previewClaudeBot({ ...raw, name, profile: name, label, workspace: '', claudeHome: '' }, options, existing);
    bots.push({ ...preview.bot, index, conflicts: preview.available ? [] : [preview.conflict] });
  }
  if (new Set(bots.map((bot) => bot.name)).size !== bots.length) throw new Error('Claude Bot 名称模板生成重复标识');
  return { factory: { engine: 'claude', count, baseIndex, spaceName, slug, providerId: provider.id,
    model: provider.model, reasoning: provider.reasoning, providerReference: provider,
    namePattern: raw.namePattern || 'claude-{index}', labelPattern: raw.labelPattern || 'Claude {index}',
    codexHome: path.join(options.dataRoot, 'claude-homes') }, bots,
    available: bots.every((bot) => !bot.conflicts.length) };
}

function assignClaudeProvider(raw, options, bots) {
  const selected = new Set(raw.botNames || []);
  if (!selected.size) throw new Error('请选择 Claude Bot');
  const provider = providerReference(raw, options);
  const targets = [...selected].map((name) => {
    const bot = bots.find((item) => item.name === name);
    if (!bot || bot.engine !== 'claude') throw new Error(`目标不是 Claude Bot：${name}`);
    return bot;
  });
  const writes = targets.map((bot) => {
    const original = fs.readFileSync(bot.configPath, 'utf8');
    const value = JSON.parse(original);
    if (value.engine !== 'claude') throw new Error(`目标内核已改变：${bot.name}`);
    value.provider = provider; value.configurationChangedAt = new Date().toISOString();
    const temporary = `${bot.configPath}.${crypto.randomUUID()}.tmp`;
    return { bot, original, temporary, contents: JSON.stringify(value, null, 2)+'\n', applied: false };
  });
  try {
    for (const write of writes) fs.writeFileSync(write.temporary, write.contents, { encoding: 'utf8', flag: 'wx' });
    for (const write of writes) {
      if (fs.readFileSync(write.bot.configPath, 'utf8') !== write.original) throw new Error('Bot 配置已改变，请刷新后重试');
      fs.renameSync(write.temporary, write.bot.configPath); write.applied = true;
    }
  } catch (error) {
    for (const write of writes.filter((item) => item.applied)) {
      if (fs.readFileSync(write.bot.configPath, 'utf8') === write.contents) fs.writeFileSync(write.bot.configPath, write.original, 'utf8');
    }
    throw error;
  } finally {
    for (const write of writes) fs.rmSync(write.temporary, { force: true });
  }
  return { botNames: targets.map((bot) => bot.name), provider: provider.id, requiresRestart: true };
}

module.exports = { assignClaudeProvider, createClaudeBot, previewClaudeBot, previewClaudeFactory, providerReference };
