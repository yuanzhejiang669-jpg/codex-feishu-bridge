const path = require('node:path');

const ENGINES = Object.freeze({ codex: 'Codex', claude: 'Claude Code CLI', antigravity: 'Antigravity CLI' });

function normalizeEngine(value) {
  const engine = String(value || 'codex').trim().toLowerCase();
  if (!Object.hasOwn(ENGINES, engine)) throw new Error(`不支持的执行内核：${engine}`);
  return engine;
}

function agentHome(bot, fallback = '') {
  if (normalizeEngine(bot?.engine) === 'antigravity') return String(bot.antigravityHome || fallback);
  return normalizeEngine(bot?.engine) === 'claude'
    ? String(bot.claudeHome || fallback)
    : String(bot?.codexHome || fallback);
}

function defaultClaudeCli(home, platform = process.platform) {
  return path.join(home, '.local', 'bin', platform === 'win32' ? 'claude.exe' : 'claude');
}

function engineDisplayName(value) {
  const engine = normalizeEngine(value);
  if (engine === 'antigravity') return 'Antigravity';
  if (engine === 'claude') return 'Claude Code';
  return 'Codex';
}

module.exports = { ENGINES, agentHome, defaultClaudeCli, engineDisplayName, normalizeEngine };
