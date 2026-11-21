import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { prepareThreadContinuation, commitThreadBinding, normalizeThreadContinuity, collapseContinuationEntries } from '../src/codex/thread-continuity.mjs';
import { AppServerClient, AppServerRpcError } from '../src/codex/app-server-client.mjs';
import { createProviderSwitchController } from '../src/providers/session-switch.mjs';
import { createVerifiedModelStore } from '../src/providers/verified-models.mjs';
import { probeAppServerModel } from '../src/codex/model-probe.mjs';
import { normalizeProviderTarget } from '../src/commands/provider-target.mjs';
import { createCodexProviderConfig } from '../src/providers/codex-config.mjs';
import { createAppServerPool } from '../src/codex/app-server-pool.mjs';
import { classifyCodexFailure } from '../src/logging/errors.mjs';
import { createServiceTierPolicy } from '../src/config/service-tier.mjs';
import { receiveNativeInput, nativeInputContext, acknowledgeNativeInput, markNativeInputSubmitting } from '../src/sessions/native-inputs.mjs';
import { createEventDispatcher } from '../src/runtime/event-dispatcher.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-provider-continuity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const backend = new Map([['A0', { id: 'A0', modelProvider: 'openai', forkedFromId: null, history: ['A-fact', 'tool-result'], revision: 'a-turn' }]]);
  const session = { id: 'logical', title: 'task', codexThreadId: 'A0', codexThreadProvider: 'openai', providerOverride: 'openai', messages: ['bridge-cache'] };
  const calls = []; let serial = 0;
  const client = { async request(method, params) {
    calls.push({ method, params }); const row = backend.get(params.threadId);
    if (method === 'thread/read') { if (!row) throw new Error('missing'); return { thread: row }; }
    if (method === 'thread/turns/list') return { data: [{ id: row.revision }] };
    if (method === 'thread/list') return { data: [...backend.values()].filter(x => params.modelProviders.includes(x.modelProvider)).map(x => ({ ...x, forkedFromId: null, createdAt: Date.now() })) };
    if (method === 'thread/resume') {
      if (params.modelProvider !== row.modelProvider) throw new AppServerRpcError({ code: -32600, message: 'Cannot change provider' }, method);
      return { thread: row, modelProvider: row.modelProvider, model: params.model };
    }
    if (method === 'thread/fork') {
      if (params.modelProvider === 'missing') throw new AppServerRpcError({ code: -32600, message: 'Model provider missing not found' }, method);
      const next = { ...structuredClone(row), id: 'fork-' + ++serial, modelProvider: params.modelProvider, forkedFromId: row.id };
      backend.set(next.id, next); return { thread: next, modelProvider: next.modelProvider };
    }
    throw new Error('Unexpected method ' + method);
  } };
  const disk = path.join(directory, 'sessions.json');
  const save = () => fs.writeFileSync(disk, JSON.stringify(session));
  save();
  const prepare = (provider, extra = {}) => prepareThreadContinuation({ client, session, save, params: { cwd: directory, modelProvider: provider, model: 'model-1' }, ...extra });
  return { directory, session, backend, calls, client, disk, save, prepare };
}

test('same provider resume/model changes preserve native ID and do not fork', async t => {
  const f = fixture(t);
  for (const model of ['model-1', 'model-2']) {
    const b = await f.prepare('openai', { params: { cwd: f.directory, modelProvider: 'openai', model } });
    commitThreadBinding(f.session, b, f.save); assert.equal(f.session.codexThreadId, 'A0');
  }
  assert.equal(f.calls.filter(x => x.method === 'thread/fork').length, 0);
});
test('A to B to A forks the latest history and keeps the logical session, files and originals', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.directory, 'work.txt'), 'kept');
  const b = await f.prepare('channel-b'); assert.equal(f.session.codexThreadId, 'A0');
  commitThreadBinding(f.session, b, f.save); f.backend.get(b.threadId).history.push('B-fact');
  f.backend.get(b.threadId).revision = 'b-turn';
  const a = await f.prepare('openai'); commitThreadBinding(f.session, a, f.save);
  assert.deepEqual(f.backend.get(a.threadId).history, ['A-fact', 'tool-result', 'B-fact']);
  assert.equal(f.session.id, 'logical'); assert.equal(f.backend.get('A0').history.includes('B-fact'), false);
  assert.equal(fs.readFileSync(path.join(f.directory, 'work.txt'), 'utf8'), 'kept');
  const restored = JSON.parse(fs.readFileSync(f.disk, 'utf8'));
  assert.equal(restored.codexThreadId, a.threadId); assert.equal(normalizeThreadContinuity(restored).codexThreadLineage.length, 3);
  assert.deepEqual(collapseContinuationEntries([...f.backend.values()].map(x => ({ codexThreadId: x.id })), [restored]), [{ codexThreadId: a.threadId }]);
});
test('legacy bindings discover their actual Provider before cross-provider preparation', async t => {
  const f = fixture(t); delete f.session.codexThreadProvider; await f.prepare('channel-b');
  assert.equal(f.calls[0].method, 'thread/read'); assert.equal(f.session.codexThreadId, 'A0');
});
test('failed target preparation keeps settings/history and rejects without an empty thread', async t => {
  const f = fixture(t); await assert.rejects(f.prepare('missing'), /not found/);
  assert.equal(f.session.codexThreadId, 'A0'); assert.equal(f.session.providerOverride, 'openai');
  assert.deepEqual(f.session.messages, ['bridge-cache']); assert.equal(f.backend.size, 1);
  assert.equal(f.session.codexThreadTransition, null); assert.equal(f.calls.some(x => x.method === 'thread/start'), false);
});
test('repeated command reuses the prepared candidate, including after reloading persisted state', async t => {
  const f = fixture(t); const first = await f.prepare('channel-b');
  Object.assign(f.session, JSON.parse(fs.readFileSync(f.disk, 'utf8')));
  const again = await f.prepare('channel-b'); assert.equal(again.threadId, first.threadId);
  assert.equal(f.calls.filter(x => x.method === 'thread/fork').length, 1);
});
test('new source turns after a failed switch invalidate a stale prepared branch', async t => {
  const f = fixture(t); const old = await f.prepare('channel-b');
  f.backend.get('A0').history.push('new-A-fact'); f.backend.get('A0').revision = 'new-a-turn';
  const fresh = await f.prepare('channel-b'); assert.notEqual(fresh.threadId, old.threadId);
  assert.equal(f.backend.get(fresh.threadId).history.includes('new-A-fact'), true);
});
test('fork is not sent if its journal cannot be saved', async t => {
  const f = fixture(t); await assert.rejects(f.prepare('channel-b', { save: () => { throw new Error('disk-full'); } }), /disk-full/);
  assert.equal(f.calls.some(x => x.method === 'thread/fork'), false); assert.equal(f.session.codexThreadId, 'A0');
});
test('unknown fork result is reconciled from native metadata instead of blindly retried', async t => {
  const f = fixture(t); const request = f.client.request.bind(f.client); let failOnce = true;
  f.client.request = async (method, params) => {
    const result = await request(method, params);
    if (method === 'thread/fork' && failOnce) { failOnce = false; throw Object.assign(new Error('timeout'), { code: 'APP_SERVER_REQUEST_TIMEOUT' }); }
    return result;
  };
  await assert.rejects(f.prepare('channel-b'), /timeout/); assert.equal(f.session.codexThreadId, 'A0');
  const recovered = await f.prepare('channel-b'); assert.equal(recovered.threadId, 'fork-1');
  assert.equal(f.calls.filter(x => x.method === 'thread/fork').length, 1);
});
test('ambiguous fork results keep the old binding without network or tool retry', async t => {
  const f = fixture(t); f.session.codexThreadTransition = { sourceThreadId: 'A0', targetProvider: 'channel-b', targetKey: 'channel-b', phase: 'uncertain', at: Date.now() };
  await assert.rejects(f.prepare('channel-b'), e => e.code === 'PROVIDER_HANDOFF_UNCERTAIN');
  assert.equal(f.backend.size, 1); assert.equal(f.session.codexThreadId, 'A0');
});
test('busy native source is not forked or terminated', async t => {
  const f = fixture(t); await assert.rejects(f.prepare('channel-b', { isBusy: () => true }), /活动任务/);
  assert.equal(f.calls.some(x => x.method === 'thread/fork'), false);
});
test('concurrent status normalization cannot detach the persisted native handoff', async t => {
  const f = fixture(t), request = f.client.request.bind(f.client);
  f.client.request = async (method, params) => {
    const result = await request(method, params);
    if (method === 'thread/fork') Object.assign(f.session, normalizeThreadContinuity(f.session));
    return result;
  };
  const binding = await f.prepare('channel-b');
  assert.equal(JSON.parse(fs.readFileSync(f.disk, 'utf8')).codexThreadTransition.candidateThreadId, binding.threadId);
});
test('internal candidates are hidden but distinct explicit Bridge bindings remain accessible', () => {
  const session = { id: 'logical', codexThreadId: 'current', codexThreadLineage: [{ threadId: 'old' }], codexThreadTransition: { candidateThreadId: 'candidate' } };
  const entries = [{ codexThreadId: 'old', _codexOnly: true }, { codexThreadId: 'candidate', _codexOnly: true }, { codexThreadId: 'current' }, { codexThreadId: 'old', _codexOnly: false, id: 'other-logical' }];
  assert.deepEqual(collapseContinuationEntries(entries, [session]), [entries[2], entries[3]]);
});
test('a user selecting another logical session during preparation prevents a false success', async t => {
  const f = fixture(t); let current = true;
  const controller = createProviderSwitchController({ save: f.save,
    validate: () => { if (!current) throw new Error('session changed'); },
    prepare: async () => { const result = await f.prepare('channel-b'); current = false; return result; } });
  await assert.rejects(controller.switch(f.session, { providerOverride: 'channel-b' }), /session changed/);
  assert.equal(f.session.codexThreadId, 'A0'); assert.equal(f.session.providerOverride, 'openai');
});
test('binding persistence failure restores the previous binding and retains the candidate', async t => {
  const f = fixture(t), prepared = await f.prepare('channel-b');
  assert.throws(() => commitThreadBinding(f.session, prepared, () => { throw new Error('disk'); }), /disk/);
  assert.equal(f.session.codexThreadId, 'A0'); assert.equal(f.session.codexThreadTransition.candidateThreadId, prepared.threadId);
});
test('selection/defaults commit only after native preparation and roll back when session save fails', async t => {
  const f = fixture(t); let defaults = { provider: 'openai' }, shouldFail = false;
  const controller = createProviderSwitchController({
    save: () => { if (shouldFail && f.session.providerOverride === 'channel-b') throw new Error('session write failed'); f.save(); },
    prepare: () => f.prepare('channel-b'), snapshotDefaults: () => ({ ...defaults }),
    applyDefaults: () => { defaults.provider = 'channel-b'; }, restoreDefaults: before => { defaults = before; },
  });
  shouldFail = true;
  await assert.rejects(controller.switch(f.session, { providerOverride: 'channel-b' }, { values: { model_provider: 'channel-b' }, account: '' }), /session write failed/);
  assert.equal(f.session.providerOverride, 'openai'); assert.equal(f.session.codexThreadId, 'A0'); assert.equal(defaults.provider, 'openai');
  shouldFail = false;
  await controller.switch(f.session, { providerOverride: 'channel-b' });
  assert.equal(f.session.codexThreadId, 'fork-1'); assert.equal(f.session.providerOverride, 'channel-b');
});
test('committing transaction recovers selection/binding after process restart', async t => {
  const f = fixture(t); await f.prepare('channel-b');
  f.session.providerSwitchTransaction = { id: 'crash', stage: 'committing', target: { providerOverride: 'channel-b' }, defaults: { values: { model_provider: 'channel-b' }, account: '' }, beforeDefaults: { values: { model_provider: 'openai' }, account: '' } };
  const controller = createProviderSwitchController({ save: f.save, prepare: () => f.prepare('channel-b'), snapshotDefaults: () => { throw Error('must use snapshot'); }, applyDefaults: () => {}, restoreDefaults: () => {} });
  await controller.recover(f.session); assert.equal(f.session.codexThreadId, 'fork-1'); assert.equal(f.session.providerOverride, 'channel-b'); assert.equal(f.session.providerSwitchTransaction, null);
});

test('RPC errors retain numeric code, data and method for precise classification', async () => {
  const client = new AppServerClient({ tool: { command: 'unused' } }); let result;
  client.pending.set(1, { reject: error => { result = error; }, timer: null, method: 'thread/resume' });
  client.handleMessage({ id: 1, error: { code: -32600, message: 'mismatch', data: { codexErrorInfo: 'modelProviderMismatch' } } });
  assert.equal(result.code, -32600); assert.equal(result.method, 'thread/resume'); assert.equal(result.data.codexErrorInfo, 'modelProviderMismatch');
  assert.equal(classifyCodexFailure(result).kind, 'model_provider_mismatch');
});
test('configuration errors are distinct from real cloud timeout and do not retry without tier', () => {
  const policy = createServiceTierPolicy({ findProvider: () => ({}) }), plan = policy.serviceTierPlanForTurnSettings({ serviceTier: 'fast' });
  for (const [message, expected] of [
    ["failed to load configuration: Cannot change this thread's model provider from openai to other on resume.", 'model_provider_mismatch'],
    ['failed to load configuration: Model provider `other` not found', 'provider_not_configured'],
    ['failed to load configuration: model provider x not allowed by policy', 'provider_policy'],
    ['failed to load configuration: TOML parse error', 'configuration'],
    ['timed out waiting for cloud config bundle', 'cloud_config'],
    ['HTTP 401 Unauthorized', 'auth'], ['usage limit exceeded', 'quota'],
  ]) { const f = classifyCodexFailure(new Error(message)); assert.equal(f.kind, expected); assert.equal(policy.shouldRetryWithoutServiceTier(f, plan), false); }
  assert.equal(policy.shouldRetryWithoutServiceTier('unsupported parameter service_tier', plan), true);
  assert.equal(policy.shouldRetryWithoutServiceTier('unsupported parameter service_tier', plan, { hasExecutedTools: true }), false);
  assert.equal(classifyCodexFailure({ message: 'configuration unavailable', data: { codexErrorInfo: 'cloudConfigTimeout' } }).kind, 'cloud_config');
  assert.equal(classifyCodexFailure(Object.assign(new Error('configuration unavailable'), { data: { codexErrorInfo: 'modelProviderNotConfigured' } })).kind, 'provider_not_configured');
});
test('pool isolates Provider, home, workspace, configuration and credentials without stopping busy clients', async () => {
  let serial = 0; const stopped = [];
  const pool = createAppServerPool({ maxSize: 1, createClient: options => ({ id: ++serial, options, stop: async () => stopped.push(serial) }) });
  const base = { accountAlias: 'account', codexHome: 'home', cwd: 'workspace', provider: 'A', configIdentity: 'config', credentialIdentity: 'old' };
  let lease = await pool.acquire(base); const first = lease.client; await lease.release();
  lease = await pool.acquire(base); assert.equal(lease.client, first);
  let acquired = false; const next = pool.acquire({ ...base, credentialIdentity: 'new' }).then(l => { acquired = true; return l; });
  await Promise.resolve(); assert.equal(acquired, false); assert.equal(stopped.length, 0);
  await lease.release(); lease = await next; assert.notEqual(lease.client, first); await lease.release();
  for (const changed of [{ provider: 'B' }, { codexHome: 'other' }, { cwd: 'other' }, { configIdentity: 'other' }]) {
    const old = lease.client; lease = await pool.acquire({ ...base, ...changed }); assert.notEqual(lease.client, old); await lease.release();
  }
  await pool.closeAll();
});
test('Provider target normalization is command-scoped and never executes links', () => {
  for (const target of ['codexes-api', 'openai-user@example.test']) assert.equal(normalizeProviderTarget(target), target);
  assert.equal(normalizeProviderTarget('[openai-user@example.test](mailto:openai-user@example.test)'), 'openai-user@example.test');
  assert.equal(normalizeProviderTarget('[openai-user%40example.test](mailto:user@example.test)'), 'openai-user@example.test');
  for (const bad of ['[user@example.test](https://example.test)', '[hello](mailto:user@example.test)', 'Discuss [user@example.test](mailto:user@example.test)']) assert.equal(normalizeProviderTarget(bad), bad);
});
test('Provider TOML honors quoted IDs, dots and comments without treating nested tables as IDs', t => {
  const f = fixture(t), file = path.join(f.directory, 'config.toml');
  fs.writeFileSync(file, 'model_provider = "company.api"\n[model_providers."company.api"] # comment\nname = "Test"\nbase_url = "http://localhost/v1"\n[model_providers.company.api]\nname = "Nested"\n');
  const config = createCodexProviderConfig({ codexHome: f.directory });
  assert.equal(config.findCodexProvider('company.api').name, 'Test'); assert.equal(config.findCodexProvider('company'), null);
  config.writeTopLevelCodexConfigValues({ model_provider: 'openai', model: 'explicit' });
  assert.equal(config.resolveCodexConfigValue('model_provider'), 'openai'); assert.equal(config.resolveCodexConfigValue('model'), 'explicit');
  assert.match(fs.readFileSync(file, 'utf8'), /# comment/);
  config.writeTopLevelCodexConfigValues({ model: null }); assert.equal(config.resolveCodexConfigValue('model'), '');
});

test('verified unlisted models survive restart, expire, and are scoped to current credentials/configuration', t => {
  const f = fixture(t), file = path.join(f.directory, 'verified.json'); let now = 1000;
  let store = createVerifiedModelStore(file, { now: () => now, ttlMs: 100 });
  store.record('provider-A/key-A-secret', { model: 'unlisted-model', provider: 'A', status: 'completed' });
  assert.equal(store.has('provider-A/key-A-secret', 'unlisted-model'), true);
  for (const identity of ['provider-B/key-A-secret', 'provider-A/key-B-secret']) assert.equal(store.has(identity, 'unlisted-model'), false);
  assert.equal(fs.readFileSync(file, 'utf8').includes('key-A-secret'), false);
  store = createVerifiedModelStore(file, { now: () => now, ttlMs: 100 }); assert.equal(store.has('provider-A/key-A-secret', 'unlisted-model'), true);
  now = 1101; assert.equal(store.has('provider-A/key-A-secret', 'unlisted-model'), false);
  assert.throws(() => store.record('A', { model: 'x', provider: 'A', status: 'failed' }), /正常完成/);
});
function probeClient({ model = 'requested', provider = 'target', status = 'completed', text = 'OK', tool = false } = {}) {
  const calls = []; const events = [
    { method: 'item/completed', params: { threadId: 'ephemeral', item: { type: tool ? 'commandExecution' : 'agentMessage', text } } },
    { method: 'turn/completed', params: { threadId: 'ephemeral', turn: { id: 'turn', status, error: status === 'failed' ? { message: 'bad key' } : null } } },
  ];
  return { calls, request: async (method, params) => { calls.push({ method, params }); return method === 'thread/start' ? { thread: { id: 'ephemeral' }, model, modelProvider: provider } : { turn: { id: 'turn' } }; }, nextNotification: async () => events.shift(), stop: async () => {} };
}
test('native model verification uses a separate ephemeral thread and rejects fallback/empty/failed/tool responses', async () => {
  const options = { model: 'requested', provider: 'target', cwd: 'probe-only', timeoutMs: 1000 };
  const good = probeClient(); assert.equal((await probeAppServerModel(good, options)).status, 'completed');
  assert.equal(good.calls[0].params.ephemeral, true); assert.equal(good.calls[0].params.allowProviderModelFallback, false); assert.equal(good.denyServerRequests, true);
  for (const input of [{ model: 'fallback' }, { provider: 'other' }, { text: '' }, { status: 'failed' }, { tool: true }]) await assert.rejects(probeAppServerModel(probeClient(input), options));
});
test('unsubmitted full input is retained as context without replaying uncertain submitted requests', () => {
  const session = {};
  receiveNativeInput(session, 'failed-before-start', 'X'.repeat(9000));
  receiveNativeInput(session, 'uncertain', 'not automatically replayed'); markNativeInputSubmitting(session, 'uncertain');
  receiveNativeInput(session, 'new', 'continue');
  const context = nativeInputContext(session, 'new'); assert.equal(context.text.includes('X'.repeat(9000)), true); assert.equal(context.text.includes('not automatically replayed'), false);
  acknowledgeNativeInput(session, 'new', context.messageIds); assert.deepEqual(session.pendingNativeInputs.map(x => x.messageId), ['uncertain']);
});
test('preparation and messages in one chat serialize while other chats can run concurrently', async () => {
  let release; const first = new Promise(resolve => { release = resolve; }); const started = [];
  const dispatcher = createEventDispatcher({ maxConcurrent: 3, chatIdOf: e => e.chat, messageIdOf: e => e.id,
    handleEvent: async e => { started.push(e.id); if (e.id === 'A1') await first; } });
  dispatcher.enqueue({ id: 'A1', chat: 'A' }); dispatcher.enqueue({ id: 'A2', chat: 'A' }); dispatcher.enqueue({ id: 'B1', chat: 'B' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['A1', 'B1']); assert.equal(dispatcher.isChatActive('A'), true);
  release(); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(started, ['A1', 'B1', 'A2']);
});
