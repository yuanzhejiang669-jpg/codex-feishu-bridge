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
  const env = claudeEnvironment(source, { home: 'per-bot-home', provider });
  assert.equal(env.CLAUDE_CONFIG_DIR, 'per-bot-home');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, provider.apiKey);
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://provider.example');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(env.CLAUDE_PROVIDER_OTHER_API_KEY, undefined);
  assert.equal(env.TOOL_ACCESS_TOKEN, 'tool');
  assert.equal(source.ANTHROPIC_API_KEY, 'other');
  const args = claudeArguments({ sessionId, model: provider.model, effort: 'high' });
  assert.equal(args.includes(provider.apiKey), false);
  assert.equal(args.includes('--append-system-prompt'), false);
  assert.equal(args.includes('--dangerously-skip-permissions'), false);
  assert.equal(args[args.indexOf('--effort') + 1], 'high');
  assert.throws(() => claudeArguments({ sessionId: '-'.repeat(36), model: 'model' }), /session ID/);
});

test('native Claude skills and compact go through the queued turn while Bridge approval remains out of band', () => {
  assert.equal(parseCommand('/my-skill exact original words', { engine: 'claude' }), null);
  assert.equal(parseCommand('/compact', { engine: 'claude' }), null);
  assert.equal(parseCommand('/approve abc', { engine: 'claude' }).name, '/approve');
  assert.equal(parseCommand('/unknown', { engine: 'codex' }).name, '/unknown');
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
