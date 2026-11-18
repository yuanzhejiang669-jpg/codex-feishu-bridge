import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { callFeishuTool, feishuMcpConfiguration, feishuTools } from '../src/claude/feishu-tools.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-claude-file-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const file = path.join(workspace, 'report with spaces.pdf'); fs.writeFileSync(file, 'fixture-report');
  return { root, file, context: { workspace, chatId: 'oc_current', messageId: 'om_request', profile: 'claude-1',
    larkCli: { command: 'lark-cli', argsPrefix: ['--profile', 'claude-1'] }, maxBytes: 1024 } };
}

test('native Feishu file tool uses current chat/profile, cwd-relative files and stable idempotency', async (t) => {
  const value = fixture(t); const calls = [];
  const options = { runCli: async (...args) => { calls.push(args); return { code: 0, data: { message_id: 'om_delivered' } }; } };
  const reply = await callFeishuTool('send_file', { file_path: value.file }, value.context, options);
  await callFeishuTool('send_file', { file_path: path.basename(value.file) }, value.context, options);
  assert.equal(reply.delivered, true); assert.equal(reply.message_id, 'om_delivered');
  const [tool, args, cwd] = calls[0];
  assert.equal(tool.argsPrefix[1], 'claude-1');
  assert.equal(args[args.indexOf('--chat-id') + 1], 'oc_current');
  assert.equal(args[args.indexOf('--as') + 1], 'bot');
  assert.equal(args[args.indexOf('--file') + 1], 'report with spaces.pdf');
  assert.equal(cwd, value.context.workspace);
  assert.equal(args[args.indexOf('--idempotency-key') + 1], calls[1][1][calls[1][1].indexOf('--idempotency-key')+1]);
  assert.equal(feishuTools().find((tool) => tool.name === 'send_file').annotations.readOnlyHint, false);
});

test('delivery rejects other recipients, files outside workspace and responses without a real message ID', async (t) => {
  const value = fixture(t);
  await assert.rejects(callFeishuTool('send_file', { file_path: value.file, chat_id: 'oc_other' }, value.context), /接收位置固定/);
  const outside = path.join(value.root, 'outside.pdf'); fs.writeFileSync(outside, 'outside');
  await assert.rejects(callFeishuTool('send_file', { file_path: outside }, value.context), /当前工作空间/);
  await assert.rejects(callFeishuTool('send_file', { file_path: value.file }, value.context,
    { runCli: async () => ({ ok: true }) }), /未确认/);
  await assert.rejects(callFeishuTool('send_file', { file_path: value.file }, value.context,
    { runCli: async () => ({ ok: false, error: 'Bearer do-not-log' }) }), (error) => !error.message.includes('do-not-log'));
});

test('native MCP configuration carries transport metadata without provider credentials or writing instructions', async (t) => {
  const value = fixture(t);
  const config = JSON.parse(feishuMcpConfiguration({ workspace: value.context.workspace,
    larkProfile: value.context.profile, larkCli: value.context.larkCli }, { chat_id: 'oc_current', message_id: 'om_request' }));
  const context = JSON.parse(config.mcpServers.feishu_bridge.env.CFB_FEISHU_TOOL_CONTEXT);
  assert.equal(context.chatId, 'oc_current');
  assert.equal(context.profile, 'claude-1');
  assert.equal(context.apiKey, undefined);
  assert.equal((await callFeishuTool('current_conversation', {}, context)).sending_identity, 'bot');
});
