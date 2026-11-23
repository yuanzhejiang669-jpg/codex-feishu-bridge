const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const TOML = require('smol-toml');
const { inspectCapabilities, listSkills, resolveCommandPath } = require('./capabilities.cjs');

function toolRoot(dataRoot, engine = 'claude') { return path.join(dataRoot, engine === 'antigravity' ? 'antigravity-tools' : 'claude-tools'); }
function mcpPath(dataRoot, engine) { return path.join(toolRoot(dataRoot, engine), '.mcp.json'); }
function skillsRoot(dataRoot, engine) { return path.join(toolRoot(dataRoot, engine), engine === 'antigravity' ? '.agents' : '.claude', 'skills'); }

function assertNoInlineSecret(value, key = '') {
  if (typeof value === 'string') {
    const reference = /\$\{[A-Za-z_][A-Za-z0-9_]*(?::-.*?)?\}/.test(value);
    if (!reference && (/secret|password|token|api[_-]?key|authorization/i.test(key)
        || /\bsk-[A-Za-z0-9_-]{16,}|\bBearer\s+\S{12}/i.test(value))) {
      throw new Error(`MCP ${key || '配置'} 包含内联凭据；请改为环境变量引用`);
    }
  } else if (value && typeof value === 'object') {
    for (const [name, nested] of Object.entries(value)) assertNoInlineSecret(nested, name);
  }
}

function validateMcp(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.mcpServers
      || typeof value.mcpServers !== 'object' || Array.isArray(value.mcpServers)) throw new Error('MCP JSON 需要 mcpServers 对象');
  for (const [name, raw] of Object.entries(value.mcpServers)) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(name)) throw new Error('MCP 名称格式无效');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`MCP ${name} 配置无效`);
    if (raw.url) {
      const url = new URL(raw.url);
      if (!['https:', 'http:', 'wss:', 'ws:'].includes(url.protocol) || url.username || url.password) throw new Error(`MCP ${name} 地址无效`);
      if (!['http', 'sse', 'websocket'].includes(raw.type || 'http')) throw new Error(`MCP ${name} 传输类型无效`);
    } else if (!raw.command || typeof raw.command !== 'string' || (raw.args && !Array.isArray(raw.args))) {
      throw new Error(`MCP ${name} 缺少有效的 command/args`);
    }
    assertNoInlineSecret(raw);
  }
  return value;
}

function readMcp(dataRoot, engine) {
  try { return validateMcp(JSON.parse(fs.readFileSync(mcpPath(dataRoot, engine), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return { mcpServers: {} }; throw error; }
}

function saveClaudeMcp(raw, options) {
  const value = validateMcp(typeof raw === 'string' ? JSON.parse(raw) : raw);
  if (options.toolEngine === 'antigravity') {
    for (const [name, server] of Object.entries(value.mcpServers)) {
      if (server.type && !['stdio', 'http', 'sse'].includes(server.type)) throw new Error(`MCP ${name} 的传输类型不受 Antigravity ACP 支持`);
    }
  }
  const target = mcpPath(options.dataRoot, options.toolEngine);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, target);
  return { configPath: target, servers: Object.keys(value.mcpServers), applies: 'next-turn' };
}

function inspectClaudeCapabilities(options) {
  let config = { mcpServers: {} }; let error = '';
  try { config = readMcp(options.dataRoot, options.toolEngine); } catch (failure) { error = failure.message; }
  const source = inspectCapabilities(options.sourceCodexHome);
  const extraSkills = options.userHome ? listSkills(path.join(options.userHome, '.agents', 'skills')) : [];
  const sourceSkills = [...source.skills, ...extraSkills].filter((item, index, all) => all.findIndex((other) => other.name === item.name) === index)
    .map((item) => { let content = ''; try { content = fs.readFileSync(item.skillFile, 'utf8'); } catch {}
      return { ...item, needsReview: /functions\.(exec|wait)|mcp__cua_repl|CODEX_HOME|codex app-server/.test(content) }; });
  const mcpServers = Object.entries(config.mcpServers).map(([name, raw]) => ({ name, type: raw.type || 'stdio',
    command: raw.command || '', url: raw.url || '', disabled: raw.disabled === true, configured: raw.disabled !== true,
    commandAvailable: raw.command ? Boolean(resolveCommandPath(raw.command)) : null }));
  return { engine: options.toolEngine || 'claude', root: toolRoot(options.dataRoot, options.toolEngine), configPath: mcpPath(options.dataRoot, options.toolEngine),
    skillsRoot: skillsRoot(options.dataRoot, options.toolEngine), skills: listSkills(skillsRoot(options.dataRoot, options.toolEngine)),
    mcpServers, activeMcpCount: mcpServers.filter((item) => !item.disabled).length,
    mcpJson: JSON.stringify(config, null, 2), sourceSkills, sourceMcpServers: source.mcpServers, error };
}

function migrateClaudeCapabilities(selection, options) {
  const inventory = inspectClaudeCapabilities(options);
  const linked = []; const added = []; const skipped = [];
  const sources = [...new Set(selection.skills || [])].map((name) => {
    const source = inventory.sourceSkills.find((item) => item.name === name);
    if (!source) throw new Error(`源技能不存在：${name}`);
    if (path.basename(name) !== name || ['.', '..'].includes(name)) throw new Error('技能名称无效');
    return source;
  });
  const sourceFile = path.join(options.sourceCodexHome, 'config.toml');
  const sourceConfig = (selection.mcp || []).length ? TOML.parse(fs.readFileSync(sourceFile, 'utf8')) : {};
  for (const name of new Set(selection.mcp || [])) if (!sourceConfig.mcp_servers?.[name]) throw new Error(`源 MCP 不存在：${name}`);
  const config = readMcp(options.dataRoot, options.toolEngine);
  fs.mkdirSync(skillsRoot(options.dataRoot, options.toolEngine), { recursive: true });
  for (const source of sources) {
    const name = source.name;
    const target = path.join(skillsRoot(options.dataRoot, options.toolEngine), name);
    if (fs.existsSync(target)) { skipped.push({ name, reason: '目标技能已存在，保留现有内容' }); continue; }
    fs.symlinkSync(source.realPath || source.path, target, process.platform === 'win32' ? 'junction' : 'dir');
    const content = fs.readFileSync(source.skillFile, 'utf8');
    linked.push({ name, path: target, source: source.realPath || source.path,
      needsReview: /functions\.(exec|wait)|mcp__cua_repl|CODEX_HOME|codex app-server/.test(content) });
  }
  for (const name of new Set(selection.mcp || [])) {
    const raw = sourceConfig.mcp_servers?.[name];
    if (!raw) throw new Error(`源 MCP 不存在：${name}`);
    if (config.mcpServers[name]) { skipped.push({ name, reason: '目标 MCP 已存在，保留现有配置' }); continue; }
    const value = raw.url ? { type: 'http', url: raw.url, headers: { ...(raw.http_headers || {}) } }
      : { command: raw.command, args: raw.args || [], env: { ...(raw.env || {}) } };
    for (const key of raw.env_vars || []) value.env = { ...value.env,
      [key]: '${' + key + (options.toolEngine === 'antigravity' ? ':-}' : '}') };
    if (raw.bearer_token_env_var) value.headers = { ...value.headers, Authorization: 'Bearer ${' + raw.bearer_token_env_var + '}' };
    for (const [header, env] of Object.entries(raw.env_http_headers || {})) value.headers = { ...value.headers, [header]: '${' + env + '}' };
    try { validateMcp({ mcpServers: { [name]: value } }); }
    catch (error) { skipped.push({ name, reason: error.message }); continue; }
    config.mcpServers[name] = value; added.push(name);
  }
  if (added.length) saveClaudeMcp(config, options);
  return { linked, added, skipped, applies: 'next-turn', root: inventory.root };
}

module.exports = { assertNoInlineSecret, inspectClaudeCapabilities, mcpPath, migrateClaudeCapabilities,
  readMcp, saveClaudeMcp, skillsRoot, toolRoot, validateMcp };
