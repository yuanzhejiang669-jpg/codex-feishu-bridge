import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAntigravityBridge, detectAntigravityResultError } from '../src/antigravity/bridge-runner.mjs';
import { createLarkClient, isTransientLarkError } from '../src/feishu/lark-cli.mjs';
import { splitText } from '../src/feishu/cards/primitives.mjs';

function createStubBridge(t, clientHandlers, { errorStallMs = 60 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-v01024-agy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  const dataRoot = path.join(root, 'data');
  const stateDir = path.join(root, 'state');
  const logDir = path.join(root, 'logs');
  const geminiDir = path.join(root, 'gemini');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(geminiDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'antigravity-providers.json'), JSON.stringify({
    schemaVersion: 1,
    providers: [{ id: 'official', name: 'Official', mode: 'official', model: 'gemini-4-neon', effort: 'high' }],
  }));

  const session = {
    id: 's1',
    title: 'Test Session',
    engine: 'antigravity',
    antigravitySessionId: '',
    antigravitySourceId: '',
    messages: [],
  };
  const chat = { currentSessionId: 's1', sessions: [session] };
  const activeChildren = new Map();
  const activeJobs = new Map();
  let clientIndex = 0;
  const createdClients = [];
  const doneCalls = [];
  const errorCalls = [];
  const interruptedCalls = [];

  const bridge = createAntigravityBridge({
    config: {
      antigravityCli: { command: 'agy.exe', argsPrefix: [] },
      antigravityHome: geminiDir,
      antigravityDesktopGeminiDir: '',
      antigravityDataRoot: dataRoot,
      antigravityIdleTtlMs: 60_000,
      antigravityErrorStallMs: errorStallMs,
      workspace,
      stateDir,
      logDir,
      disableMcp: true,
    },
    getSession: () => session,
    getChatState: () => chat,
    getChats: () => ({ 'chat-1': chat }),
    resetSession: () => session,
    saveSessions: () => {},
    userText: (c) => String(c || ''),
    sendMarkdown: async () => {},
    activeChildren,
    activeJobs,
    appendText: (state, text) => {
      const last = state.blocks.at(-1);
      if (last?.kind === 'text') last.content += text;
      else state.blocks.push({ kind: 'text', content: text });
    },
    reduceEvent: (state, ev) => {
      if (ev.type === 'item.started') state.blocks.push({ kind: 'tool', tool: { ...ev.item, status: 'running' } });
    },
    markPhase: (state, phase, opts = {}) => {
      state.phases.push({ phase, ...opts });
    },
    ensureDone: (state, text) => {
      state.terminal = 'done';
      doneCalls.push(text);
    },
    markInterrupted: (state) => {
      state.terminal = 'interrupted';
      interruptedCalls.push(true);
    },
    markError: (state, err) => {
      state.terminal = 'error';
      errorCalls.push(err);
    },
    queueSummary: () => '无',
    sharedSessions: null,
    createClient: (opts) => {
      const idx = clientIndex++;
      const handler = clientHandlers[idx] || clientHandlers.at(-1);
      const client = {
        idx,
        child: { pid: 20000 + idx },
        runtime: { agentInfo: { version: '1.5.14' } },
        appDataDir: 'antigravity-cli',
        closed: false,
        stopped: false,
        onEvent: opts.onEvent,
        onPermission: opts.onPermission,
        prompts: [],
        openCalls: [],
        closeCount: 0,
        failErrors: [],
        pendingReject: null,
        async openSession(args) {
          this.openCalls.push(args);
          this.sessionId = args.sessionId || `native-conv-${idx}`;
          return {
            sessionId: this.sessionId,
            models: { availableModels: [{ modelId: 'gemini-4-neon', name: 'Gemini 4 Neon' }] },
            configOptions: [],
            modes: [],
          };
        },
        async prompt(content) {
          this.prompts.push(content);
          return handler(this, content);
        },
        fail(err) {
          this.failErrors.push(err);
          const reject = this.pendingReject;
          this.pendingReject = null;
          reject?.(err);
        },
        async close() {
          this.closed = true;
          this.closeCount += 1;
        },
        interrupt() {
          this.stopped = true;
        },
      };
      createdClients.push(client);
      return client;
    },
  });
  t.after(() => bridge.close());
  return { bridge, session, createdClients, doneCalls, errorCalls, interruptedCalls };
}

test('v0.10.24: detectAntigravityResultError supports both plain U+26A0 and emoji U+26A0 U+FE0F prefixes without false positives', () => {
  const plain = detectAntigravityResultError('\u26A0 UNAUTHENTICATED (code 401): Request had invalid authentication credentials.');
  assert.equal(Boolean(plain), true);
  assert.equal(plain.isAuth401, true);

  const emoji = detectAntigravityResultError('\u26A0\uFE0F UNAUTHENTICATED (code 401): Request had invalid authentication credentials.');
  assert.equal(Boolean(emoji), true);
  assert.equal(emoji.isAuth401, true);

  const emojiTrailing = detectAntigravityResultError('已读取文件。\n\u26A0\uFE0F RESOURCE_EXHAUSTED (code 429): quota exceeded');
  assert.equal(Boolean(emojiTrailing), true);
  assert.equal(emojiTrailing.isAuth401, false);

  const emojiExec = detectAntigravityResultError('\u26A0\uFE0F agent executor error: deadline exceeded');
  assert.equal(Boolean(emojiExec), true);
  assert.equal(emojiExec.isAuth401, false);

  assert.equal(detectAntigravityResultError('\u26A0\uFE0F 注意：不要修改系统分区。'), null);
});

test('v0.10.24: streaming 401 deadlock breaks after stall window, closes hung client without USER_STOP, strips error chunk, and auto-retries cleanly', async (t) => {
  const { bridge, session, createdClients, doneCalls, errorCalls } = createStubBridge(t, [
    async (client) => new Promise((_resolve, reject) => {
      client.pendingReject = reject;
      // Simulate agy.exe streaming 401 in two chunks and then deadlocking internally (prompt never resolves)
      client.onEvent({ type: 'agent_message_chunk', update: { content: { type: 'text', text: '\u26A0\uFE0F UNAUTHENTICATED (code 401): ' } } });
      setTimeout(() => {
        client.onEvent({ type: 'agent_message_chunk', update: { content: { type: 'text', text: 'Request had invalid authentication credentials.' } } });
      }, 15);
    }),
    async (client) => {
      client.onEvent({ type: 'agent_message_chunk', update: { content: { type: 'text', text: '自动重连后回复成功' } } });
      return { text: '自动重连后回复成功', usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } };
    },
  ], { errorStallMs: 60 });

  const event = { chat_id: 'chat-1', sender_id: 'ou_1', chat_type: 'p2p', message_id: 'm1', content: '搞好了吗' };
  const state = { blocks: [], meta: {}, phases: [], terminal: 'running' };
  const result = await bridge.run(event, session, state, async () => {});

  assert.equal(result.text, '自动重连后回复成功');
  assert.equal(createdClients.length, 2);
  assert.equal(createdClients[0].stopped, false, 'Error-stall recovery must NOT mark client.stopped (reserved for USER_STOP)');
  assert.equal(createdClients[0].closed, true, 'Deadlocked client must be closed');
  assert.equal(createdClients[0].failErrors.length, 1);
  assert.equal(createdClients[0].failErrors[0].code, 'ANTIGRAVITY_ERROR_STALL');
  assert.equal(createdClients[1].openCalls[0].sessionId, 'native-conv-0');
  assert.match(JSON.stringify(createdClients[1].prompts[0]), /搞好了吗/);
  assert.equal(state.blocks.some((b) => String(b.content || '').includes('UNAUTHENTICATED')), false, 'Stalled 401 chunk must be stripped');
  assert.equal(state.phases.some((p) => p.phase === 'reconnecting'), true);
  assert.equal(state.meta.upstreamRetry, undefined);
  assert.equal(errorCalls.length, 0);
  assert.equal(doneCalls.length, 1);
});

test('v0.10.24: streaming 401 deadlock after tool execution retries with continuation prompt instead of repeating tools', async (t) => {
  const { bridge, session, createdClients } = createStubBridge(t, [
    async (client) => new Promise(() => {
      // Even a client whose prompt() ignores fail() completely must still unblock via stall race!
      client.onEvent({ type: 'tool_call', update: { toolCallId: 'tool-1', name: 'run_command', args: { cmd: 'deploy' } } });
      client.onEvent({ type: 'agent_message_chunk', update: { content: { type: 'text', text: '\u26A0 UNAUTHENTICATED (code 401): token expired' } } });
    }),
    async (client) => {
      client.onEvent({ type: 'agent_message_chunk', update: { content: { type: 'text', text: '继续汇报部署结果' } } });
      return { text: '继续汇报部署结果', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    },
  ], { errorStallMs: 50 });

  const event = { chat_id: 'chat-1', sender_id: 'ou_1', chat_type: 'p2p', message_id: 'm2', content: '执行发布' };
  const state = { blocks: [], meta: {}, phases: [], terminal: 'running' };
  const result = await bridge.run(event, session, state, async () => {});

  assert.equal(result.text, '继续汇报部署结果');
  assert.equal(createdClients.length, 2);
  assert.equal(createdClients[0].closed, true);
  assert.match(JSON.stringify(createdClients[1].prompts[0]), /不要重复执行已完成的操作/);
  assert.doesNotMatch(JSON.stringify(createdClients[1].prompts[0]), /执行发布/);
});

test('v0.10.24: persistent 401 deadlock and non-401 deadlock fail fast with structured errors and close hung clients', async (t) => {
  const persistent = createStubBridge(t, [
    async (client) => new Promise((_resolve, reject) => {
      client.pendingReject = reject;
      client.onEvent({ type: 'agent_message_chunk', update: { content: { type: 'text', text: '\u26A0 UNAUTHENTICATED (code 401): expired' } } });
    }),
    async (client) => new Promise((_resolve, reject) => {
      client.pendingReject = reject;
      client.onEvent({ type: 'agent_message_chunk', update: { content: { type: 'text', text: '\u26A0 UNAUTHENTICATED (code 401): still expired' } } });
    }),
  ], { errorStallMs: 45 });

  const event = { chat_id: 'chat-1', sender_id: 'ou_1', chat_type: 'p2p', message_id: 'm3', content: 'hello' };
  const state1 = { blocks: [], meta: {}, phases: [], terminal: 'running' };
  await assert.rejects(
    persistent.bridge.run(event, persistent.session, state1, async () => {}),
    (err) => err.code === 'ANTIGRAVITY_AUTH_401' && err.engine === 'antigravity' && err.retried401 === true,
  );
  assert.equal(persistent.createdClients.length, 2);
  assert.equal(persistent.createdClients[0].closed, true);
  assert.equal(persistent.createdClients[1].closed, true);
  assert.equal(persistent.doneCalls.length, 0);
  assert.equal(persistent.errorCalls.length, 1);
  assert.equal(state1.terminal, 'error');

  const non401 = createStubBridge(t, [
    async (client) => new Promise((_resolve, reject) => {
      client.pendingReject = reject;
      client.onEvent({ type: 'agent_message_chunk', update: { content: { type: 'text', text: '\u26A0 RESOURCE_EXHAUSTED (code 429): quota reached' } } });
    }),
  ], { errorStallMs: 45 });

  const state2 = { blocks: [], meta: {}, phases: [], terminal: 'running' };
  await assert.rejects(
    non401.bridge.run(event, non401.session, state2, async () => {}),
    (err) => err.code === 'ANTIGRAVITY_EXECUTOR_ERROR' && err.engine === 'antigravity' && err.retried401 === false,
  );
  assert.equal(non401.createdClients.length, 1, 'Non-401 deadlock must not auto-retry');
  assert.equal(non401.createdClients[0].closed, true);
  assert.equal(state2.terminal, 'error');
});

test('v0.10.24: genuine subsequent progress before stall window cancels watchdog and lets turn finish normally', async (t) => {
  // Case A: thought/tool progress arrives after transient error chunk
  const viaTool = createStubBridge(t, [
    async (client) => {
      client.onEvent({ type: 'agent_message_chunk', update: { content: { type: 'text', text: '\u26A0 UNAUTHENTICATED (code 401): transient' } } });
      await new Promise((r) => setTimeout(r, 25));
      client.onEvent({ type: 'agent_thought_chunk', update: { content: { type: 'text', text: 'retrying internally...' } } });
      await new Promise((r) => setTimeout(r, 70));
      client.onEvent({ type: 'agent_message_chunk', update: { content: { type: 'text', text: '内部已恢复并完成回答' } } });
      return { text: '\u26A0 UNAUTHENTICATED (code 401): transient\n内部已恢复并完成回答', usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
    },
  ], { errorStallMs: 60 });

  const event = { chat_id: 'chat-1', sender_id: 'ou_1', chat_type: 'p2p', message_id: 'm4', content: 'test' };
  const stateA = { blocks: [], meta: {}, phases: [], terminal: 'running' };
  const resA = await viaTool.bridge.run(event, viaTool.session, stateA, async () => {});
  assert.match(resA.text, /内部已恢复并完成回答/);
  assert.equal(viaTool.createdClients.length, 1, 'Watchdog must cancel on genuine progress');
  assert.equal(viaTool.createdClients[0].failErrors.length, 0);

  // Case B: new non-error paragraph arrives after transient error chunk
  const viaParagraph = createStubBridge(t, [
    async (client) => {
      client.onEvent({ type: 'agent_message_chunk', update: { content: { type: 'text', text: '\u26A0 UNAUTHENTICATED (code 401): transient' } } });
      await new Promise((r) => setTimeout(r, 25));
      client.onEvent({ type: 'agent_message_chunk', update: { content: { type: 'text', text: '\n\n已恢复正常，这是最终回答。' } } });
      await new Promise((r) => setTimeout(r, 70));
      return { text: '\u26A0 UNAUTHENTICATED (code 401): transient\n\n已恢复正常，这是最终回答。', usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
    },
  ], { errorStallMs: 60 });

  const stateB = { blocks: [], meta: {}, phases: [], terminal: 'running' };
  const resB = await viaParagraph.bridge.run(event, viaParagraph.session, stateB, async () => {});
  assert.match(resB.text, /已恢复正常，这是最终回答/);
  assert.equal(viaParagraph.createdClients.length, 1);
  assert.equal(viaParagraph.createdClients[0].failErrors.length, 0);
});

test('v0.10.24: /stop during error stall respects USER_STOP and never triggers 401 auto-retry', async (t) => {
  const { bridge, session, createdClients, interruptedCalls } = createStubBridge(t, [
    async (client) => new Promise(() => {
      client.onEvent({ type: 'agent_message_chunk', update: { content: { type: 'text', text: '\u26A0 UNAUTHENTICATED (code 401): expired' } } });
      setTimeout(() => client.interrupt(), 20);
    }),
  ], { errorStallMs: 60 });

  const event = { chat_id: 'chat-1', sender_id: 'ou_1', chat_type: 'p2p', message_id: 'm5', content: 'stop me' };
  const state = { blocks: [], meta: {}, phases: [], terminal: 'running' };
  await assert.rejects(
    bridge.run(event, session, state, async () => {}),
    (err) => err.code === 'USER_STOP',
  );
  assert.equal(createdClients.length, 1, 'USER_STOP must never auto-retry');
  assert.equal(interruptedCalls.length, 1);
  assert.equal(state.terminal, 'interrupted');
});

test('v0.10.24: isTransientLarkError retries Feishu timeout errors and bridge recalls stuck card after fallback delivery', async () => {
  const feishuTimeoutJson = JSON.stringify({
    ok: false,
    error: { type: 'api', subtype: 'timeout', message: 'server time out error' },
  });
  assert.equal(isTransientLarkError({ stderr: feishuTimeoutJson, stdout: '' }), true);
  assert.equal(isTransientLarkError({ stderr: 'server timeout error', stdout: '' }), true);
  assert.equal(isTransientLarkError({ stderr: 'Post https://open.feishu.cn/...: context deadline exceeded', stdout: '' }), true);
  assert.equal(isTransientLarkError({ stderr: 'HTTP 400 bad request: server time out error', stdout: '' }), false);

  let attempts = 0;
  const lark = createLarkClient({
    larkCli: 'lark-cli',
    splitText,
    idempotencyKey: (b, s) => `${b}:${s}`,
    delay: async () => {},
    runTool: async () => {
      attempts += 1;
      if (attempts === 1) return { code: 1, stdout: feishuTimeoutJson, stderr: '' };
      return { code: 0, stdout: '{"ok":true}', stderr: '' };
    },
  });
  const res = await lark.runLark(['api', 'PUT', '/open-apis/cardkit/v1/cards/c1'], { attempts: 2 });
  assert.equal(res.code, 0);
  assert.equal(attempts, 2);

  const bridgeSrc = fs.readFileSync(new URL('../codex-feishu-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridgeSrc, /antigravityErrorStallMs:\s*parseDurationMs/);
  assert.match(bridgeSrc, /const recallStuckCard = async \(reason\)/);
  assert.match(bridgeSrc, /if \(card && !finalCardFlushOk\) await recallStuckCard\("answer-fallback"\);/);
  assert.match(bridgeSrc, /await recallStuckCard\("error-fallback"\);/);
});
