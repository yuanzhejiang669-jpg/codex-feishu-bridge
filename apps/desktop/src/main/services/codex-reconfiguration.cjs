const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const TOML = require('smol-toml');
const fileFor = root => path.join(root, 'codex-pending-reloads.json');
function read(root) {
  try { return JSON.parse(fs.readFileSync(fileFor(root), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; return { version: 1, bots: {} }; }
}
function write(root, state) {
  fs.mkdirSync(root, { recursive: true }); const file = fileFor(root), temp = file + '.' + crypto.randomUUID() + '.tmp';
  try { fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n'); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
function queueCodexCredentialReload(dataRoot, bots, envKey) {
  const state = read(dataRoot), names = [];
  for (const bot of bots) {
    if (['claude', 'antigravity'].includes(bot.engine) || bot.provider?.mode === 'custom' && bot.provider.envKey === envKey) continue;
    let config;
    try { config = TOML.parse(fs.readFileSync(path.join(bot.codexHome, 'config.toml'), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (!Object.values(config.model_providers || {}).some(p => p.env_key === envKey)) continue;
    state.bots[bot.name] = { revision: crypto.randomUUID(), requestedAt: Date.now(), stoppedByUpdate: false };
    names.push(bot.name);
  }
  write(dataRoot, state); return names;
}
async function processCodexCredentialReload(options) {
  const result = { pending: [], restarted: [], failed: [] };
  for (const [name, entry] of Object.entries(read(options.dataRoot).bots)) {
    const bot = options.inspectBots().find(b => b.name === name);
    if (['claude', 'antigravity'].includes(bot?.engine)) throw new Error('Codex 重载队列不能操作 Claude Bot');
    if (bot?.online && bot.activeRunCount > 0 || entry.lastAttemptAt && Date.now() - entry.lastAttemptAt < 60000) { result.pending.push(name); continue; }
    const update = fn => { const state = read(options.dataRoot); if (state.bots[name]?.revision === entry.revision) { fn(state); write(options.dataRoot, state); } };
    try {
      const shouldRestart = Boolean(bot?.online || entry.stoppedByUpdate);
      if (bot?.online) {
        // Persist restart intent before stop so a desktop crash between stop
        // and start cannot forget a previously online Bot.
        update(state => { state.bots[name].stoppedByUpdate = true; });
        const stopped = await options.stopBot(name);
        if (stopped?.online || options.inspectBots().find(b => b.name === name)?.online) { result.pending.push(name); continue; }
      }
      if (bot && shouldRestart) {
        const started = await options.startBot(name);
        if (started?.online === false) throw new Error('Bot 重载后尚未恢复在线');
        result.restarted.push(name);
      }
      update(state => { delete state.bots[name]; });
    } catch (e) {
      if (e.code === 'BOT_ACTIVE') { result.pending.push(name); continue; }
      update(state => { state.bots[name].lastAttemptAt = Date.now(); state.bots[name].error = 'Bot 重载失败，请查看运行日志'; });
      result.failed.push(name);
    }
  }
  return result;
}
module.exports = { queueCodexCredentialReload, processCodexCredentialReload, readPendingCodexReload: read };
