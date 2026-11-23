import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  buildLarkCliEnv,
  resolveLarkConfigAppId,
  resolveLarkEventLockScope,
  resolveLarkProfileHome,
} from '../src/config/env.mjs';
import { createLarkClient } from '../src/feishu/lark-cli.mjs';
import { callFeishuTool, feishuMcpConfiguration } from '../src/claude/feishu-tools.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-lark-profile-isolation-'));
  t.diagnostic(`temporary fixture (cleaned after test): ${root}`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeProfile(home, appId) {
  const dir = path.join(home, '.lark-cli');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ apps: [{ name: 'shared-profile', appId }] }));
}

test('Lark config and event locks use the isolated identity while preserving legacy home fallback', (t) => {
  const root = fixture(t);
  const realHome = path.join(root, 'real-home');
  const profileHome = path.join(root, 'profile-home');
  writeProfile(realHome, 'cli_legacy');
  writeProfile(profileHome, 'cli_isolated');

  for (const options of [
    { larkProfileHome: profileHome, homeDir: realHome },
    { env: { CODEX_FEISHU_LARK_PROFILE_HOME: profileHome }, homeDir: realHome },
  ]) {
    assert.equal(resolveLarkConfigAppId('shared-profile', options), 'cli_isolated');
    assert.equal(resolveLarkEventLockScope('shared-profile', options), 'app-cli_isolated');
  }
  const legacy = { larkProfileHome: '', env: {}, homeDir: realHome };
  assert.equal(resolveLarkConfigAppId('shared-profile', legacy), 'cli_legacy');
  assert.equal(resolveLarkEventLockScope('shared-profile', legacy), 'app-cli_legacy');
  assert.equal(resolveLarkConfigAppId('missing', legacy), '');
  assert.equal(resolveLarkEventLockScope('missing', legacy), 'profile-missing');
  assert.equal(resolveLarkProfileHome({ CODEX_FEISHU_LARK_PROFILE_HOME: ` ${profileHome} ` }), profileHome);
  assert.equal(resolveLarkProfileHome({}), '');
});

test('Lark child environment overrides only the child home and never mutates its caller', () => {
  const base = Object.freeze({ USERPROFILE: 'real-user-home', HOME: 'real-home', FIXTURE: 'retained' });
  const isolated = buildLarkCliEnv(' profile-home ', base);
  assert.deepEqual(isolated, { USERPROFILE: 'profile-home', HOME: 'profile-home', FIXTURE: 'retained' });
  assert.notEqual(isolated, base);
  assert.equal(base.USERPROFILE, 'real-user-home');
  assert.equal(base.HOME, 'real-home');
  assert.equal(buildLarkCliEnv('', base), base);
  assert.equal(buildLarkCliEnv('   ', base), base);
});

test('Lark requests isolate their profile home, preserve option overrides, and retry with the same identity', async () => {
  const parentHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const profileHome = path.join(os.tmpdir(), 'isolated-lark-profile');
  const calls = [];
  const larkCli = { command: 'fixture-lark', argsPrefix: [] };
  const client = createLarkClient({
    larkCli,
    larkProfileHome: profileHome,
    runTool: async (...args) => {
      calls.push(args);
      return calls.length === 1 ? { code: 1, stderr: 'ETIMEDOUT' } : { code: 0, stdout: '{}' };
    },
    delay: async () => {},
  });
  const customEnv = { HOME: 'must-not-override-profile', USERPROFILE: 'must-not-override-profile', CFB_FIXTURE: 'retained' };
  await client.runLark(['fixture-status'], { env: customEnv, attempts: 2, cwd: 'fixture-cwd', timeoutMs: 1234 });
  assert.equal(calls.length, 2);
  for (const [tool, args, options] of calls) {
    assert.equal(tool, larkCli);
    assert.deepEqual(args, ['fixture-status']);
    assert.equal(options.env.USERPROFILE, profileHome);
    assert.equal(options.env.HOME, profileHome);
    assert.equal(options.env.CFB_FIXTURE, 'retained');
    assert.equal(options.cwd, 'fixture-cwd');
    assert.equal(options.timeoutMs, 1234);
  }
  assert.equal(customEnv.HOME, 'must-not-override-profile');
  assert.deepEqual({ HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }, parentHome);

  const inheritedCalls = [];
  const legacy = createLarkClient({ larkCli, runTool: async (...args) => {
    inheritedCalls.push(args);
    return { code: 0 };
  } });
  await legacy.runLark(['fixture-status']);
  assert.equal(inheritedCalls[0][2].env, undefined);
  const overrideEnv = { CFB_FIXTURE: 'legacy-option' };
  await legacy.runLark(['fixture-status'], { env: overrideEnv });
  assert.equal(inheritedCalls[1][2].env, overrideEnv);
});

test('native Feishu MCP delivery passes the isolated home to its real spawn boundary', async (t) => {
  const workspace = fixture(t);
  const file = path.join(workspace, 'report.md');
  fs.writeFileSync(file, 'fixture-report');
  const profileHome = path.join(workspace, 'profile-home');
  const calls = [];
  const parentHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.end(JSON.stringify({ ok: true, data: { message_id: 'om_fixture' } }));
      child.emit('close', 0);
    });
    return child;
  };
  const config = { workspace, larkProfileHome: profileHome, larkProfile: 'shared-profile',
    larkCli: { command: 'fixture-lark', argsPrefix: ['--profile', 'shared-profile'] } };
  const mcp = JSON.parse(feishuMcpConfiguration(config, { chat_id: 'oc_fixture', message_id: 'om_request' }));
  const context = JSON.parse(mcp.mcpServers.feishu_bridge.env.CFB_FEISHU_TOOL_CONTEXT);
  assert.equal(context.larkProfileHome, profileHome);
  const result = await callFeishuTool('send_file', { file_path: file }, context, { spawnProcess });
  assert.equal(result.delivered, true);
  assert.equal(calls[0].options.env.USERPROFILE, profileHome);
  assert.equal(calls[0].options.env.HOME, profileHome);
  assert.equal(calls[0].options.cwd, workspace);
  assert.deepEqual(calls[0].args.slice(0, 2), ['--profile', 'shared-profile']);
  assert.deepEqual({ HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }, parentHome);

  await callFeishuTool('send_file', { file_path: file }, { ...context, larkProfileHome: '' }, { spawnProcess });
  assert.equal(calls[1].options.env, process.env);
});
