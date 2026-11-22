const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = ['src/renderer/claude.js', 'src/renderer/antigravity.js', 'src/main/services/antigravity.cjs', ...['agent-engines', 'claude-bots', 'claude-capabilities',
  'claude-providers', 'claude-reconfiguration'].map((name) => `src/main/services/${name}.cjs`)];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { windowsHide: true, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
