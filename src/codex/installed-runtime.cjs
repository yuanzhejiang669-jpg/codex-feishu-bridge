const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');

const targets = {
  'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl',
};

// Resolve npm shims without invoking a shell or copying/flattening the package.
function nativeEntry(candidate, options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const target = targets[`${platform}-${arch}`];
  let real;
  try { real = fs.realpathSync(candidate); } catch { return ''; }
  if (!/\.(?:cmd|ps1|js)$/i.test(real)) return real;
  const root = real.endsWith('codex.js') ? path.resolve(path.dirname(real), '..')
    : path.join(path.dirname(real), 'node_modules', '@openai', 'codex');
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (metadata.name !== '@openai/codex' || !target) return '';
    const requireFromPackage = createRequire(path.join(root, 'package.json'));
    let vendor;
    try {
      vendor = path.join(path.dirname(requireFromPackage.resolve(`@openai/codex-${platform}-${arch}/package.json`)), 'vendor');
    } catch { vendor = path.join(root, 'vendor'); }
    const directory = path.join(vendor, target);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'codex-package.json'), 'utf8'));
    if (manifest.layoutVersion !== 1 || manifest.target !== target) return '';
    for (const field of ['entrypoint', 'resourcesDir', 'pathDir']) {
      if (typeof manifest[field] !== 'string') return '';
      const file = path.resolve(directory, manifest[field]);
      const relative = path.relative(directory, file);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(file)) return '';
    }
    return path.resolve(directory, manifest.entrypoint);
  } catch { return ''; }
}

function candidates(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const home = options.home || os.homedir();
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  if (platform === 'win32') {
    dirs.push(path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm'));
    dirs.push(path.join(home, 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin'));
  } else {
    dirs.push(path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin');
  }
  return [...new Set(dirs.flatMap((dir) => (platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex'])
    .map((name) => path.join(dir, name))))];
}

function resolveInstalledRuntime(options = {}) {
  const env = options.env || process.env;
  const explicit = options.explicitPath ?? env.CODEX_CLI_BIN;
  const probe = options.probe || ((file) => spawnSync(file, ['--version'], {
    encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024,
  }));
  const failures = [];
  for (const candidate of explicit ? [explicit] : (options.candidates || candidates(options))) {
    if (!fs.existsSync(candidate)) {
      if (explicit) failures.push('Explicit CODEX_CLI_BIN does not exist');
      continue;
    }
    const runtimePath = nativeEntry(candidate, options);
    if (!runtimePath) { failures.push(`Invalid CLI package: ${candidate}`); continue; }
    const result = probe(runtimePath);
    const match = String(result.stdout || '').match(/^codex(?:-cli)?\s+(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/m);
    if (result.status !== 0 || !match) { failures.push(`CLI version probe failed: ${candidate}`); continue; }
    return { runtimePath, cliVersion: match[1], runtimeSource: explicit ? 'explicit' : 'installed-cli',
      launcherPath: candidate, failures, runtimeFound: true };
  }
  // Never silently replace a deliberately pinned runtime.
  return { runtimePath: '', cliVersion: '', runtimeFound: false, runtimeSource: explicit ? 'explicit' : '',
    failures, error: failures.join('; '), explicit: Boolean(explicit) };
}

module.exports = { nativeEntry, candidates, resolveInstalledRuntime };
