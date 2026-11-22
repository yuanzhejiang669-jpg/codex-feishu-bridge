import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AntigravityAcpClient, antigravityEnvironment, safeMessage } from '../src/antigravity/acp-client.mjs';
import { parseCommand } from '../src/commands/parser.mjs';

function fixture(handler, extra = {}) {
  const child = new EventEmitter(); child.pid = 12345;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin.on('finish', () => queueMicrotask(() => child.emit('close', 0)));
  child.kill = () => child.emit('close', 0);
  const requests = []; let buffer = '';
  const send = (value) => child.stdout.write(JSON.stringify(value) + '\n');
  child.stdin.on('data', (data) => {
    buffer += data;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'); const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      requests.push(request);
      queueMicrotask(() => {
        if (handler?.(request, send, child) === true) return;
        if (request.id == null) return;
        const result = request.method === 'initialize' ? { agentCapabilities: { loadSession: true } }
          : ['session/new', 'session/load'].includes(request.method) ? { sessionId: request.params.sessionId || 'native-session' } : {};
        send({ jsonrpc: '2.0', id: request.id, result });
      });
    }
  });
  const events = [];
  const client = new AntigravityAcpClient({ command: 'fixture', cwd: '.', spawnProcess: () => child,
    requestTimeoutMs: 2000, idleTimeoutMs: 1000, onEvent: (event) => events.push(event), ...extra });
  return { client, child, requests, send, events };
}

test('native ACP load suppresses history replay, streams split UTF-8, and reports context', async () => {
  const f = fixture((request, send, child) => {
    if (request.method === 'session/load') {
      send({ method: 'session/update', params: { sessionId: 'existing', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old history' } } } });
    }
    if (request.method !== 'session/prompt') return false;
    const line = Buffer.from(JSON.stringify({ method: 'session/update', params: { sessionId: 'existing', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '原生续聊' } } } }) + '\n');
    for (let i = 0; i < line.length; i += 1) child.stdout.write(line.subarray(i, i + 1));
    send({ method: 'session/update', params: { sessionId: 'existing', update: { sessionUpdate: 'usage_update', used: 9000, size: 1048576 } } });
    send({ id: request.id, result: { stopReason: 'end_turn' } }); return true;
  });
  await f.client.openSession({ sessionId: 'existing', model: 'native-model', effort: 'high', mode: 'plan' });
  const result = await f.client.prompt([{ type: 'text', text: 'hello' }]);
  assert.equal(result.text, '原生续聊'); assert.equal(result.runtime.context.usedTokens, 9000);
  assert.ok(!f.events.some((event) => event.update?.content?.text === 'old history'));
  assert.deepEqual(f.requests.map((item) => item.method), ['initialize', 'session/load', 'session/set_model', 'session/set_config_option', 'session/set_mode', 'session/prompt']);
  await f.client.close(); assert.equal(f.client.closed, true);
});

test('permissions use the offered option ID and are cancelled when stopped', async () => {
  let allow; const decision = new Promise((resolve) => { allow = resolve; });
  const f = fixture(null, { onPermission: () => decision });
  await f.client.openSession();
  f.send({ id: 'permission-1', method: 'session/request_permission', params: { sessionId: 'native-session', options: [{ optionId: 'native-allow', kind: 'allow_once' }] } });
  await new Promise((resolve) => setImmediate(resolve)); allow(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.requests.find((item) => item.id === 'permission-1').result.outcome, { outcome: 'selected', optionId: 'native-allow' });
  f.client.onPermission = () => new Promise(() => {});
  f.send({ id: 'permission-2', method: 'session/request_permission', params: { options: [] } });
  await new Promise((resolve) => setImmediate(resolve)); f.client.interrupt();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.requests.find((item) => item.id === 'permission-2').result.outcome, { outcome: 'cancelled' });
  assert.ok(f.requests.some((item) => item.method === 'session/cancel'));
  await f.client.close();
});

test('stop interrupts startup and shutdown rejects outstanding requests', async () => {
  const f = fixture((request) => request.method === 'initialize');
  const opening = f.client.openSession(); f.client.interrupt();
  await assert.rejects(opening, { code: 'USER_STOP' }); await f.client.close();
  assert.equal(f.client.pending.size, 0);
  const before = fixture(); before.client.interrupt();
  await assert.rejects(before.client.openSession(), { code: 'USER_STOP' });
  assert.equal(before.requests.length, 0);
});

test('provider secrets are isolated and redacted; native slash commands remain native', () => {
  assert.deepEqual(antigravityEnvironment({ PATH: 'p', GEMINI_API_KEY: 'old', GOOGLE_API_KEY: 'old', GOOGLE_GEMINI_BASE_URL: 'old' }, { mode: 'official' }), { PATH: 'p' });
  const api = antigravityEnvironment({}, { mode: 'gemini-api', apiKey: 'test-secret', baseUrl: 'https://example.invalid' });
  assert.equal(api.GEMINI_API_KEY, 'test-secret');
  assert.throws(() => antigravityEnvironment({}, { mode: 'gemini-api' }), /Key/);
  assert.ok(!safeMessage('echo test-secret Bearer abc sk-example', ['test-secret']).includes('test-secret'));
  assert.equal(parseCommand('/compact', { engine: 'antigravity' }), null);
  assert.equal(parseCommand('/eli5 hello', { engine: 'antigravity' }), null);
  assert.equal(parseCommand('/context', { engine: 'antigravity' }).name, '/context');
});
