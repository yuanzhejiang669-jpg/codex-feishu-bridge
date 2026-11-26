import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAntigravityBridge } from '../src/antigravity/bridge-runner.mjs';
import { createClaudeBridge } from '../src/claude/bridge-runner.mjs';
import { createLarkClient } from '../src/feishu/lark-cli.mjs';
import { idempotencyKey, splitText } from '../src/feishu/cards/primitives.mjs';

function createDeduplicatingLarkHarness() {
  const seenKeys = new Set();
  const attempts = [];
  const delivered = [];
  const lark = createLarkClient({
    larkCli: 'lark-cli',
    splitText,
    idempotencyKey,
    maxReplyChars: 6000,
    delay: async () => {},
    runTool: async (_cmd, args, options) => {
      const keyIndex = args.indexOf('--idempotency-key');
      const mdIndex = args.indexOf('--markdown');
      const contentIndex = args.indexOf('--content');
      const key = keyIndex >= 0 ? args[keyIndex + 1] : '';
      let markdown = '';
      if (mdIndex >= 0) {
        const mdArg = args[mdIndex + 1];
        markdown = mdArg === '-' ? String(options?.stdin || '') : mdArg;
      } else if (contentIndex >= 0) {
        const raw = args[contentIndex + 1] === '-' ? String(options?.stdin || '') : args[contentIndex + 1];
        try {
          const card = JSON.parse(raw);
          markdown = (card?.body?.elements || []).map((e) => e.content || '').join('\n\n');
        } catch {
          markdown = raw;
        }
      }
      const deduplicated = Boolean(key && seenKeys.has(key));
      attempts.push({ key, markdown, deduplicated });
      if (!deduplicated) {
        if (key) seenKeys.add(key);
        delivered.push({ key, markdown });
      }
      return { code: 0, stdout: '{}', stderr: '' };
    },
  });
  return { lark, seenKeys, attempts, delivered };
}

test('Antigravity background wakeups use monotonic idempotency keys so multi-flush and multi-chunk reports are never dropped', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-v01021-bg-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const harness = createDeduplicatingLarkHarness();
  const session = { id: 'sess-bg', engine: 'antigravity', title: 'homework', messages: [], antigravitySessionId: '' };
  const chat = { currentSessionId: session.id, sessions: [session] };
  let activeClient = null;
  let pendingTools = true;

  const bridge = createAntigravityBridge({
    config: {
      engine: 'antigravity',
      larkProfile: 'antigravity-5',
      antigravityDataRoot: root,
      antigravityHome: path.join(root, 'home'),
      antigravityCli: { command: 'agy' },
      workspace: root,
      stateDir: root,
      logDir: root,
      disableMcp: true,
    },
    getSession: () => session,
    getChatState: () => chat,
    resetSession: () => session,
    saveSessions: () => {},
    userText: (v) => v,
    sendMarkdown: harness.lark.sendMarkdown,
    activeJobs: new Map(),
    activeChildren: new Map(),
    createClient: () => {
      activeClient = {
        runtime: {},
        child: { pid: process.pid },
        closed: false,
        stopped: false,
        turnActive: false,
        hasPendingTools: () => pendingTools,
        interrupt: () => {},
        openSession: async () => ({ sessionId: 'native-bg-1' }),
        prompt: async () => ({ text: '主回合先返回，后台任务继续运行。' }),
        close: async () => { activeClient.closed = true; },
      };
      return activeClient;
    },
  });
  t.after(() => bridge.close());

  const event = { chat_id: 'oc_bg_chat', sender_id: 'ou_owner', message_id: 'om_turn_bg_001', content: '按推荐的来' };
  const result = await bridge.run(event, session);
  assert.match(result.text, /主回合先返回/);
  assert.equal(bridge.hasBackground(event.chat_id), true);

  // Wakeup #1: short progress update (single chunk -md-0)
  activeClient.onEvent({ type: 'agent_message_chunk', update: { content: { type: 'text', text: '进度 1：已完成细节微调，正在做最后一次导出核验。' } } });
  activeClient.onEvent({ type: 'usage_update', update: { used: 112246, size: 1048576 } });
  await new Promise((resolve) => setTimeout(resolve, 850));

  // Wakeup #2: >6000-char final delivery report (splits into chunk 0 + chunk 1)
  const longFinalReport = `FINAL_REPORT_HEAD\n${'作业核验明细与交付清单。\n'.repeat(520)}FINAL_REPORT_TAIL`;
  assert.ok(longFinalReport.length > 6000);
  activeClient.onEvent({ type: 'agent_message_chunk', update: { content: { type: 'text', text: longFinalReport } } });
  activeClient.onEvent({ type: 'usage_update', update: { used: 120000, size: 1048576 } });
  await new Promise((resolve) => setTimeout(resolve, 850));

  // Wakeup #3: another short follow-up note flushed via usage_update before retiring
  pendingTools = false;
  activeClient.onEvent({ type: 'agent_message_chunk', update: { content: { type: 'text', text: '进度 3：全部后台核验已收尾。' } } });
  activeClient.onEvent({ type: 'usage_update', update: { used: 121000, size: 1048576 } });
  await new Promise((resolve) => setTimeout(resolve, 850));
  await bridge.stopBackground(event.chat_id);

  assert.equal(harness.attempts.filter((item) => item.deduplicated).length, 0, 'no Feishu chunk may collide on idempotency key');
  assert.equal(harness.delivered.length, 4, 'expected 1 chunk for wakeup #1 + 2 chunks for wakeup #2 + 1 chunk for wakeup #3');
  assert.equal(new Set(harness.delivered.map((item) => item.key)).size, 4);
  assert.match(harness.delivered[0].markdown, /进度 1/);
  assert.match(harness.delivered[1].markdown, /\*\*Antigravity 后台任务进展\*\*/);
  assert.match(harness.delivered[1].markdown, /FINAL_REPORT_HEAD/);
  assert.match(harness.delivered[2].markdown, /FINAL_REPORT_TAIL/);
  assert.match(harness.delivered[3].markdown, /进度 3/);
});

test('Antigravity and Claude multiple permission prompts in one turn use distinct per-token idempotency keys', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-v01021-perm-'));
  const envKey = `CFB_V01021_${crypto.randomBytes(8).toString('hex')}`;
  process.env[envKey] = 'fixture-secret';
  t.after(() => {
    delete process.env[envKey];
    fs.rmSync(root, { recursive: true, force: true });
  });

  // 1) Antigravity: two sequential permission requests within one turn
  {
    const harness = createDeduplicatingLarkHarness();
    const botConfig = path.join(root, 'agy-bot.json');
    fs.writeFileSync(botConfig, JSON.stringify({ antigravity: { permissionMode: 'default' } }));
    const session = { id: 'agy-perm', engine: 'antigravity', title: 'perm', messages: [], antigravitySessionId: '' };
    const chat = { currentSessionId: session.id, sessions: [session] };
    const event = { chat_id: 'oc_agy_perm', sender_id: 'ou_owner', message_id: 'om_agy_perm_turn', content: 'run two tools' };
    let bridge;
    bridge = createAntigravityBridge({
      config: {
        engine: 'antigravity',
        larkProfile: 'antigravity-1',
        antigravityDataRoot: root,
        antigravityHome: path.join(root, 'agy-home'),
        antigravityBotConfig: botConfig,
        antigravityCli: { command: 'agy' },
        workspace: root,
        stateDir: root,
        logDir: root,
        disableMcp: true,
      },
      getSession: () => session,
      getChatState: () => chat,
      resetSession: () => session,
      saveSessions: () => {},
      userText: (v) => v,
      activeJobs: new Map(),
      activeChildren: new Map(),
      sendMarkdown: async (chatId, markdown, suffix, baseId) => {
        await harness.lark.sendMarkdown(chatId, markdown, suffix, baseId);
        const token = markdown.match(/\/approve ([a-f0-9]+)/)?.[1];
        if (token) {
          queueMicrotask(() => { void bridge.handleCommand({ ...event, message_id: `approve-${token}` }, { name: '/approve', rest: token }); });
        }
      },
      createClient: (options) => ({
        runtime: {},
        child: { pid: process.pid },
        interrupt: () => {},
        openSession: async () => ({ sessionId: 'native-perm-1' }),
        prompt: async () => {
          const first = await options.onPermission({ toolCall: { title: 'ToolOne', rawInput: { step: 1 } } });
          const second = await options.onPermission({ toolCall: { title: 'ToolTwo', rawInput: { step: 2 } } });
          assert.equal(first, true);
          assert.equal(second, true);
          return { text: 'both approved' };
        },
        close: async () => {},
      }),
    });
    t.after(() => bridge.close());

    const res = await bridge.run(event, session);
    assert.equal(res.text, 'both approved');
    const permMsgs = harness.delivered.filter((item) => item.markdown.includes('Antigravity 申请执行'));
    assert.equal(permMsgs.length, 2);
    assert.notEqual(permMsgs[0].key, permMsgs[1].key);
    assert.equal(harness.attempts.filter((item) => item.deduplicated).length, 0);
  }

  // 2) Claude: two sequential permission requests within one turn
  {
    const harness = createDeduplicatingLarkHarness();
    const catalog = path.join(root, 'claude-providers.json');
    const botConfig = path.join(root, 'claude-bot.json');
    fs.writeFileSync(catalog, JSON.stringify({ providers: [{ id: 'p1', envKey, model: 'claude-test', effort: 'high', models: ['claude-test'] }] }));
    fs.writeFileSync(botConfig, JSON.stringify({ claude: { permissionMode: 'manual' } }));
    const session = { id: 'claude-perm', engine: 'claude', title: 'perm' };
    const chat = { currentSessionId: session.id, sessions: [session] };
    const event = { chat_id: 'oc_claude_perm', sender_id: 'ou_owner', message_id: 'om_claude_perm_turn', content: 'run two tools' };
    let bridge;
    bridge = createClaudeBridge({
      config: {
        claudeProviderCatalog: catalog,
        claudeProviderId: 'p1',
        claudeBotConfig: botConfig,
        claudeCli: { command: 'claude' },
        claudeHome: root,
        workspace: root,
        stateDir: root,
        larkProfile: 'claude-1',
      },
      getSession: () => session,
      getChatState: () => chat,
      resetSession: () => session,
      saveSessions: () => {},
      userText: (v) => v,
      activeJobs: new Map(),
      activeChildren: new Map(),
      sendMarkdown: async (chatId, markdown, suffix, baseId) => {
        await harness.lark.sendMarkdown(chatId, markdown, suffix, baseId);
        const token = markdown.match(/\/approve ([a-f0-9]+)/)?.[1];
        if (token) {
          queueMicrotask(() => { void bridge.handleCommand({ ...event, message_id: `approve-${token}` }, { name: '/approve', rest: token }); });
        }
      },
      createClient: (options) => ({
        child: { pid: 999 },
        async run() {
          options.onStarted({ pid: 999 });
          try {
            const first = await options.onPermission({ id: 'p-1', toolName: 'Write', sessionId: 's-1', input: { step: 1 } });
            const second = await options.onPermission({ id: 'p-2', toolName: 'Bash', sessionId: 's-1', input: { step: 2 } });
            assert.equal(first, true);
            assert.equal(second, true);
            return { result: 'claude both approved' };
          } finally {
            options.onClosed({ pid: 999 });
          }
        },
      }),
    });
    t.after(() => bridge.close());

    const res = await bridge.run(event, session);
    assert.equal(res.text, 'claude both approved');
    const permMsgs = harness.delivered.filter((item) => item.markdown.includes('Claude Code 申请调用'));
    assert.equal(permMsgs.length, 2);
    assert.notEqual(permMsgs[0].key, permMsgs[1].key);
    assert.equal(harness.attempts.filter((item) => item.deduplicated).length, 0);
  }
});
