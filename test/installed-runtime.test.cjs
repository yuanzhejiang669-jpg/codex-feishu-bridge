const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { nativeEntry, resolveInstalledRuntime } = require('../src/codex/installed-runtime.cjs');

test('runtime selection validates versions and never silently replaces an explicit path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-cli-'));
  try {
    const file = path.join(root, 'codex'); fs.writeFileSync(file, 'fixture');
    const options = { env: {}, candidates: [file], probe: () => ({ status: 0, stdout: 'codex-cli 0.153.4' }) };
    assert.equal(resolveInstalledRuntime(options).runtimeSource, 'installed-cli');
    assert.equal(resolveInstalledRuntime({ ...options, explicitPath: file }).runtimeSource, 'explicit');
    assert.equal(resolveInstalledRuntime({ ...options, explicitPath: path.join(root, 'missing') }).runtimeFound, false);
    assert.equal(resolveInstalledRuntime({ ...options, probe: () => ({ status: 0, stdout: 'node 24.0.0' }) }).runtimeFound, false);
    assert.equal(resolveInstalledRuntime({ ...options, probe: () => ({ status: 1, stdout: 'codex-cli 0.153.4' }) }).runtimeFound, false);
    let version = '0.153.4';
    const dynamic = { ...options, probe: () => ({ status: 0, stdout: `codex-cli ${version}` }) };
    assert.equal(resolveInstalledRuntime(dynamic).cliVersion, version);
    version = '0.154.0';
    assert.equal(resolveInstalledRuntime(dynamic).cliVersion, version);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('npm layout resolution preserves nested resources and rejects incomplete or escaping manifests', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-cli-package-'));
  try {
    const pkg = path.join(root, 'node_modules/@openai/codex');
    const vendor = path.join(pkg, 'vendor/x86_64-pc-windows-msvc');
    fs.mkdirSync(path.join(vendor, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(vendor, 'codex-resources'));
    fs.mkdirSync(path.join(vendor, 'codex-path'));
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex' }));
    fs.writeFileSync(path.join(root, 'codex.cmd'), 'fixture');
    const binary = path.join(vendor, 'bin/codex.exe'); fs.writeFileSync(binary, 'fixture');
    const manifest = { layoutVersion: 1, target: 'x86_64-pc-windows-msvc', entrypoint: 'bin/codex.exe', resourcesDir: 'codex-resources', pathDir: 'codex-path' };
    const write = () => fs.writeFileSync(path.join(vendor, 'codex-package.json'), JSON.stringify(manifest));
    const resolve = () => nativeEntry(path.join(root, 'codex.cmd'), { platform: 'win32', arch: 'x64' });
    write(); assert.equal(resolve(), binary);
    manifest.resourcesDir = 'missing'; write(); assert.equal(resolve(), '');
    manifest.resourcesDir = '../../..'; write(); assert.equal(resolve(), '');
    manifest.resourcesDir = 'codex-resources'; manifest.layoutVersion = 2; write(); assert.equal(resolve(), '');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
