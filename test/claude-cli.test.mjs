import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { ClaudeCliClient, claudeArguments, claudeEnvironment } from '../src/claude/cli-client.mjs';
import { claudeContent } from '../src/claude/bridge-runner.mjs';
import { parseCommand } from '../src/commands/parser.mjs';

const sessionId = '7507f65c-a17f-4c14-b2d8-5badb5a0aa80';
const provider = { apiKey: 'private-test-credential', baseUrl: 'https://provider.example/v1', model: 'custom-claude-model', auth: 'bearer' };
function fakeProcess(handle) {
  const child = new EventEmitter();
  child.pid = 45; child.exitCode = null; child.killed = false;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.send = (event) => child.stdout.write(JSON.stringify(event)+'\n');
  child.finish = (code = 0) => {
    if (child.exitCode !== null) return;
    child.exitCode = code; child.stdout.end(); child.stderr.end();
    setImmediate(() => child.emit('close', code, null));
  };
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    for (const line of chunk.toString().trim().split('\n')) setImmediate(() => handle(JSON.parse(line), child));
    done();
  }, final(done) { child.finish(); done(); } });
  child.kill = () => { child.killed = true; child.finish(1); };
  return child;
}
function client(handle, overrides = {}) {
  return new ClaudeCliClient({ command: 'claude', cwd: process.cwd(), home: 'isolated-home',
    provider, sessionId, idleTimeoutMs: 2_000, ...overrides, spawnProcess: (_command, _args, options) => {
      assert.equal(options.windowsHide, true); return fakeProcess(handle);
    } });
}

test('Claude launch isolates authentication, leaves tool credentials intact and never places keys in argv', () => {
  const source = { ANTHROPIC_API_KEY: 'other', CLAUDE_CODE_OAUTH_TOKEN: 'old-login',
    CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_PROVIDER_OTHER_API_KEY: 'other-provider', TOOL_ACCESS_TOKEN: 'tool', PATH: 'path' };
  const env = claudeEnvironment(source, { home: 'per-bot-home', toolHome: 'current-bot-tools', provider });
  assert.equal(env.CLAUDE_CONFIG_DIR, 'per-bot-home');
  assert.equal(env.CFB_CLAUDE_BOT_HOME, 'current-bot-tools');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, provider.apiKey);
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://provider.example');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(env.CLAUDE_PROVIDER_OTHER_API_KEY, undefined);
  assert.equal(env.TOOL_ACCESS_TOKEN, 'tool');
  assert.equal(env.CLAUDE_CODE_MAX_RETRIES, '2');
  assert.equal(env.PYTHONUTF8, '1');
  assert.equal(env.PYTHONIOENCODING, 'utf-8');
  assert.equal(source.ANTHROPIC_API_KEY, 'other');
  const args = claudeArguments({ sessionId, model: provider.model, effort: 'high' });
  assert.equal(args.includes(provider.apiKey), false);
  assert.equal(args.includes('--append-system-prompt'), false);
  assert.equal(args.includes('--dangerously-skip-permissions'), false);
  assert.equal(args[args.indexOf('--effort') + 1], 'high');
  assert.throws(() => claudeArguments({ sessionId: '-'.repeat(36), model: 'model' }), /session ID/);
});

test('Claude retry events expose upstream status without forwarding raw secrets', async () => {
  const events = [];
  const instance = client((message, child) => {
    if (message.type !== 'user') return;
    child.send({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 2,
      retry_delay_ms: 60_000, error_status: 502, error: `server_error ${provider.apiKey}` });
    child.send({ type: 'system', subtype: 'api_error', retryAttempt: 2, maxRetries: 2,
      retryInMs: 10_000, error: { message: `API Error: 524 ${provider.apiKey}` } });
    child.send({ type: 'result', is_error: false, result: 'recovered' });
  }, { onEvent: (event) => events.push(event) });
  await instance.run('message');
  const retries = events.filter((e) => e.type === 'api_retry');
  assert.deepEqual(retries.map((e) => [e.statusCode, e.attempt, e.maxRetries, e.delayMs]),
    [[502, 1, 2, 60_000], [524, 2, 2, 10_000]]);
  assert.equal(JSON.stringify(retries).includes(provider.apiKey), false);
});

test('native slash dispatch is explicit while normal messages retain verbatim delivery', async () => {
  for (const dispatchCommand of [false, true]) {
    const instance = client((message, child) => {
      if (message.type !== 'user') return;
      assert.equal(message.client_composed, !dispatchCommand);
      assert.equal(message.message.content, '/compact keep facts');
      child.send({ type: 'result', is_error: false, result: 'done' });
    }, { dispatchCommand });
    assert.equal((await instance.run('/compact keep facts')).result, 'done');
  }
});

test('steering waits for every submitted input UUID before closing the native session', async () => {
  let initial; let instance;
  instance = client((message, child) => {
    if (message.type !== 'user') return;
    if (!initial) {
      initial = message.uuid;
      child.send({ type: 'system', subtype: 'init', session_id: sessionId });
      setTimeout(() => instance.steer('change course'), 5);
    } else {
      assert.equal(message.priority, 'next');
      assert.equal(message.client_composed, true);
      child.send({ type: 'result', is_error: false, result: 'first', user_message_uuids: [initial] });
      setTimeout(() => child.send({ type: 'result', is_error: false, result: 'steered', user_message_uuids: [message.uuid] }), 10);
    }
  });
  assert.equal((await instance.run('initial')).result, 'steered');
  assert.equal(instance.pendingInputs.size, 0);
  assert.throws(() => instance.steer('too late'), /已结束/);
});

test('retry notifications and stderr heartbeats cannot extend the upstream no-progress deadline', async () => {
  let interval;
  const instance = client((message, child) => {
    if (message.type !== 'user') return;
    interval = setInterval(() => {
      child.stderr.write('waiting\n');
      child.send({ type: 'system', subtype: 'api_retry', attempt: 1, error: { status: 502 } });
    }, 4);
    child.once('close', () => clearInterval(interval));
  }, { upstreamTimeoutMs: 30 });
  try {
    await assert.rejects(instance.run('message'), { code: 'CLAUDE_UPSTREAM_TIMEOUT' });
  } finally { clearInterval(interval); }
});

test('parallel tools may run longer than the upstream wait limit', async () => {
  const instance = client((message, child) => {
    if (message.type !== 'user') return;
    child.send({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'one', name: 'Bash', input: {} },
      { type: 'tool_use', id: 'two', name: 'Bash', input: {} },
    ] } });
    setTimeout(() => child.send({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'one', content: 'one done' },
    ] } }), 10);
    setTimeout(() => {
      child.send({ type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 'two', content: 'two done' },
      ] } });
      child.send({ type: 'result', is_error: false, result: 'done' });
    }, 70);
  }, { upstreamTimeoutMs: 30 });
  assert.equal((await instance.run('message')).result, 'done');
});

test('auto-compaction gets its own longer deadline and resumes normal response waiting', async () => {
  const events = [];
  const instance = client((message, child) => {
    if (message.type !== 'user') return;
    child.send({ type: 'system', subtype: 'status', status: 'compacting' });
    setTimeout(() => {
      child.send({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto' } });
      child.send({ type: 'result', is_error: false, result: 'compacted' });
    }, 70);
  }, { upstreamTimeoutMs: 30, compactionTimeoutMs: 150, onEvent: (e) => events.push(e) });
  assert.equal((await instance.run('message')).result, 'compacted');
  assert.ok(events.some((e) => e.type === 'compacting_started'));
  assert.ok(events.some((e) => e.type === 'compacted'));
});

test('thinking deltas count as progress without exposing reasoning as answer text', async () => {
  const events = []; let interval;
  const instance = client((message, child) => {
    if (message.type !== 'user') return;
    interval = setInterval(() => child.send({ type: 'stream_event', event: {
      type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'private reasoning' },
    } }), 8);
    setTimeout(() => {
      clearInterval(interval);
      child.send({ type: 'result', is_error: false, result: 'done' });
    }, 70);
  }, { upstreamTimeoutMs: 30, onEvent: (e) => events.push(e) });
  try {
    assert.equal((await instance.run('message')).result, 'done');
    assert.ok(events.some((e) => e.type === 'model_progress'));
    assert.equal(JSON.stringify(events).includes('private reasoning'), false);
  } finally { clearInterval(interval); }
});

test('native Claude skills stay queued while compact and Bridge approval are managed commands', () => {
  assert.equal(parseCommand('/my-skill exact original words', { engine: 'claude' }), null);
  assert.equal(parseCommand('/compact', { engine: 'claude' }).name, '/compact');
  assert.equal(parseCommand('/approve abc', { engine: 'claude' }).name, '/approve');
  assert.equal(parseCommand('/unknown', { engine: 'codex' }), null);
  assert.equal(parseCommand('/effort high', { engine: 'codex' }).name, '/effort');
});

test('explicit full authorization uses the native bypass mode while manual approval remains available', () => {
  const full = claudeArguments({ sessionId, model: provider.model, permissionMode: 'bypassPermissions' });
  assert.equal(full[full.indexOf('--permission-mode') + 1], 'bypassPermissions');
  assert.equal(full.includes('--dangerously-skip-permissions'), true);
  const manual = claudeArguments({ sessionId, model: provider.model, permissionMode: 'manual' });
  assert.equal(manual[manual.indexOf('--permission-mode') + 1], 'manual');
  assert.equal(manual.includes('--dangerously-skip-permissions'), false);
  assert.throws(() => claudeArguments({ sessionId, model: provider.model, permissionMode: 'unknown' }), /权限模式/);
});

test('Claude content preserves user text and sends attachment metadata separately', () => {
  const text = '  原话\n不要增加要求。\u200b';
  const content = claudeContent(text, [{ name: 'report.pdf', type: 'file', path: '/data/report.pdf' }]);
  assert.deepEqual(content[0], { type: 'text', text });
  assert.match(content[1].text, /report\.pdf/);
  assert.equal(content.length, 2);
});

test('stream text appears once, tools receive final input, and resume uses the exact native session', async () => {
  const events = []; const original = [{ type: 'text', text: '  unchanged\nmessage  ' }];
  let sent;
  const instance = client((message, child) => {
    if (message.type !== 'user') return;
    sent = message;
    child.send({ type: 'system', subtype: 'init', session_id: sessionId, model: provider.model });
    child.send({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-1', usage: { input_tokens: 5, cache_read_input_tokens: 10 } } } });
    child.send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello\u200b' } } });
    child.send({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} } } });
    child.send({ type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text: 'Hello\u200b' }, { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/file' } }] } });
    child.send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'contents' }] } });
    child.send({ type: 'result', is_error: false, result: 'Hello\u200b' });
  }, { resume: true, onEvent: (event) => events.push(event) });
  const result = await instance.run(original);
  assert.deepEqual(sent.message.content, original);
  assert.equal(sent.client_composed, true);
  assert.equal(events.filter((event) => event.type === 'text_delta').map((event) => event.text).join(''), result.result);
  assert.equal(events.filter((event) => event.type === 'tool_start').length, 1);
  assert.equal(events.find((event) => event.type === 'tool_update').input.file_path, '/file');
  assert.equal(events.find((event) => event.type === 'tool_end').output, 'contents');
  assert.equal(events.find((event) => event.type === 'context').usedTokens, 15);
  assert.equal(claudeArguments(instance).includes('--resume'), true);
});

for (const allowed of [true, false]) test(`tool permission waits for a host answer (${allowed ? 'allow' : 'deny'})`, async () => {
  let response;
  const instance = client((message, child) => {
    if (message.type === 'user') child.send({ type: 'control_request', request_id: 'permission-1',
      request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '/file', content: 'value' } } });
    if (message.type === 'control_response') {
      response = message.response; child.send({ type: 'result', result: 'done', is_error: false });
    }
  }, { onPermission: async (request) => { assert.equal(request.toolName, 'Write'); return allowed; } });
  await instance.run('message');
  assert.equal(response.response.behavior, allowed ? 'allow' : 'deny');
  if (allowed) assert.equal(response.response.updatedInput.content, 'value');
});

test('interruption uses native control and reports USER_STOP', async () => {
  let instance;
  instance = client((message, child) => {
    if (message.type === 'user') instance.interrupt();
    if (message.type === 'control_request' && message.request.subtype === 'interrupt') child.finish();
  });
  await assert.rejects(instance.run('message'), { code: 'USER_STOP' });
});

test('provider errors redact credentials and child startup failures settle cleanly', async () => {
  const failure = client((message, child) => { if (message.type === 'user') {
    child.stderr.write(`upstream rejected ${provider.apiKey}`); child.finish(1);
  } });
  await assert.rejects(failure.run('message'), (error) => error.message.includes('[redacted]') && !error.message.includes(provider.apiKey));
  const missing = client(() => {}, { command: 'missing' });
  missing.spawnProcess = () => {
    const child = fakeProcess(() => {});
    setImmediate(() => { child.emit('error', new Error('ENOENT')); child.finish(1); });
    return child;
  };
  await assert.rejects(missing.run('message'), /ENOENT/);
});
