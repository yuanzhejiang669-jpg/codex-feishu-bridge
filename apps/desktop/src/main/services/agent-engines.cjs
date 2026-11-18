const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const MIN_CLAUDE_VERSION = '2.1.327';

function supportedClaudeVersion(version) {
  const parts = String(version).split('.').map(Number);
  const minimum = MIN_CLAUDE_VERSION.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (!Number.isInteger(parts[index])) return false;
    if (parts[index] !== minimum[index]) return parts[index] > minimum[index];
  }
  return true;
}

function normalizeEngine(value) {
  const engine = String(value || 'codex').trim().toLowerCase();
  if (!['codex', 'claude'].includes(engine)) throw new Error(`执行内核无效：${engine}`);
  return engine;
}

async function inspectClaudeRuntime(options = {}) {
  const home = options.userHome || os.homedir();
  const candidates = [options.claudePath, process.env.CLAUDE_CLI_BIN,
    path.join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')].filter(Boolean);
  const runtimePath = candidates.find((candidate) => fs.existsSync(candidate)) || '';
  if (!runtimePath) return { engine: 'claude', available: false, runtimePath: '', version: '', error: '未找到 Claude Code CLI' };
  return new Promise((resolve) => execFile(runtimePath, ['--version'], { windowsHide: true, timeout: 15_000, encoding: 'utf8' }, (error, stdout) => {
    const version = String(stdout || '').match(/\d+\.\d+\.\d+/)?.[0] || '';
    const supported = supportedClaudeVersion(version);
    resolve({ engine: 'claude', available: !error && supported, runtimePath, version,
      error: error ? error.message : supported ? '' : `需要 Claude Code CLI ${MIN_CLAUDE_VERSION} 或更高版本，请运行 claude update` });
  }));
}

module.exports = { inspectClaudeRuntime, normalizeEngine, MIN_CLAUDE_VERSION, supportedClaudeVersion };
