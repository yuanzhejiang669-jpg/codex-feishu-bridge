const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function statePath(dataRoot) { return path.join(dataRoot, 'claude-pending-restarts.json'); }
function readPending(dataRoot) {
  try { return JSON.parse(fs.readFileSync(statePath(dataRoot), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 1, bots: {} }; throw error; }
}
function writePending(dataRoot, state) {
  const file = statePath(dataRoot); const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2)+'\n', 'utf8'); fs.renameSync(temporary, file);
}
function queueClaudeReconfiguration(dataRoot, names) {
  const state = readPending(dataRoot);
  for (const name of names) state.bots[name] = { revision: crypto.randomUUID(), requestedAt: Date.now(), error: '' };
  writePending(dataRoot, state);
  return Object.keys(state.bots);
}
async function processClaudeReconfiguration(options) {
  const state = readPending(options.dataRoot);
  const result = { restarted: [], pending: [], deferred: [], failed: [] };
  for (const [name, entry] of Object.entries(state.bots)) {
    const bot = options.inspectBots().find((item) => item.name === name);
    if (bot && bot.engine !== 'claude') throw new Error('Claude 更新队列包含其他内核 Bot');
    if (bot?.activeRunCount > 0) { result.pending.push(name); continue; }
    if (entry.lastAttemptAt && Date.now()-entry.lastAttemptAt < 60_000) { result.deferred.push(name); continue; }
    let done = !bot || !bot.online;
    try {
      if (bot?.online) {
        const stopped = await options.stopBot(name);
        if (stopped?.online || options.inspectBots().find((item) => item.name === name)?.online) {
          result.pending.push(name); continue;
        }
        const started = await options.startBot(name);
        if (started && started.online === false) throw new Error('Claude Bot 未能恢复运行');
        result.restarted.push(name); done = true;
      }
    } catch (error) {
      if (error.code === 'BOT_ACTIVE') { result.pending.push(name); continue; }
      result.failed.push({ name, error: String(error.message || error) });
      const current = readPending(options.dataRoot);
      if (current.bots[name]?.revision === entry.revision) {
        current.bots[name].error = String(error.message || error);
        current.bots[name].lastAttemptAt = Date.now(); writePending(options.dataRoot, current);
      }
    }
    if (done) {
      const current = readPending(options.dataRoot);
      if (current.bots[name]?.revision === entry.revision) { delete current.bots[name]; writePending(options.dataRoot, current); }
    }
  }
  return result;
}
module.exports = { processClaudeReconfiguration, queueClaudeReconfiguration, readPending, statePath };
