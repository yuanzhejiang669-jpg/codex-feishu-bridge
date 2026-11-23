import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const directory of ['tools', 'tools/tavily-router', 'tools/firecrawl-router']) {
  test('Python router regression suite: ' + directory, { timeout: 60_000 }, () => {
    const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', FIRECRAWL_CLI_SCRIPT: '', FIRECRAWL_NODE_PATH: '',
      FIRECRAWL_API_KEY: '', TAVILY_API_KEY: '' };
    for (const name of ['TAVILY_KEY_POOL_PATH', 'TAVILY_ROUTER_STATE_PATH', 'FIRECRAWL_KEY_POOL_PATH', 'FIRECRAWL_ROUTER_STATE_PATH']) delete env[name];
    const result = spawnSync(process.env.CFB_TEST_PYTHON || 'python', ['-B', '-m', 'unittest', 'discover', '-s', directory, '-p', 'test_*.py', '-v'], {
      cwd: root, windowsHide: true, encoding: 'utf8', timeout: 55_000,
      env,
    });
    assert.equal(result.status, 0, String(result.error || '') + result.stdout + result.stderr);
  });
}
