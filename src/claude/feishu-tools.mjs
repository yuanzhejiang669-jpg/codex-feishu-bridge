import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function feishuMcpConfiguration(config, event) {
  return JSON.stringify({ mcpServers: { feishu_bridge: { command: process.execPath,
    args: [fileURLToPath(import.meta.url)], env: { CFB_FEISHU_TOOL_CONTEXT: JSON.stringify({
      chatId: event.chat_id, messageId: event.message_id || event.id || '', profile: config.larkProfile,
      larkProfileHome: config.larkProfileHome || '',
      workspace: config.workspace, larkCli: config.larkCli, maxBytes: config.maxFileAttachmentBytes || 50 * 1024 * 1024,
    }) } } } });
}

export function feishuTools() {
  return [
    { name: 'current_conversation', description: 'Read the Feishu chat, requesting message, Bot profile and workspace for this turn. Use these values for the current conversation; they are transport metadata, not writing instructions.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false } },
    { name: 'send_file', description: 'Send a generated local file to the current Feishu conversation as this Bot. Use only when the user has requested file delivery. The file must be within the current workspace. PDF, ZIP, audio and other attachments use the existing Lark CLI upload/send flow. Returns the real Feishu message ID; do not claim delivery before success.',
      inputSchema: { type: 'object', properties: { file_path: { type: 'string', description: 'Absolute file path, or a path relative to the current workspace.' } }, required: ['file_path'], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
  ];
}

function safeError(error) {
  return String(error?.message || error).replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 1800);
}

function runCli(tool, args, cwd, options = {}) {
  const spawnProcess = typeof options === 'function' ? options : (options.spawnProcess || spawn);
  const larkProfileHome = typeof options === 'object' ? String(options.larkProfileHome || '').trim() : '';
  const env = larkProfileHome
    ? { ...process.env, USERPROFILE: larkProfileHome, HOME: larkProfileHome }
    : process.env;
  return new Promise((resolve, reject) => {
    const child = spawnProcess(tool.command, [...(tool.argsPrefix || []), ...args], {
      cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = ''; let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('飞书文件投递超时')); }, 180_000);
    timer.unref?.();
    child.stdout.on('data', (value) => { stdout = (stdout + value).slice(-2 * 1024 * 1024); });
    child.stderr.on('data', (value) => { stderr = (stderr + value).slice(-100_000); });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (code !== 0) { finish(new Error(safeError(stderr || stdout || `lark-cli exit ${code}`))); return; }
      try { finish(null, JSON.parse(stdout.replace(/^\uFEFF/, '').trim())); }
      catch { finish(new Error('Lark CLI 未返回有效 JSON，无法确认文件已投递')); }
    });
  });
}

function findValue(value, key) {
  if (!value || typeof value !== 'object') return '';
  if (typeof value[key] === 'string') return value[key];
  for (const nested of Object.values(value)) { const found = findValue(nested, key); if (found) return found; }
  return '';
}

export async function callFeishuTool(name, input, context, options = {}) {
  if (name === 'current_conversation') return { chat_id: context.chatId, message_id: context.messageId,
    bot_profile: context.profile, workspace: context.workspace, sending_identity: 'bot' };
  if (name !== 'send_file') throw new Error('未知飞书工具');
  if (!input || typeof input.file_path !== 'string' || !input.file_path.trim()
      || Object.keys(input).some((key) => key !== 'file_path')) throw new Error('只接受 file_path 参数；接收位置固定为当前对话');
  if (!/^oc_[A-Za-z0-9]+$/.test(context.chatId || '') || !context.larkCli?.command) throw new Error('当前飞书对话或 CLI 配置无效');
  const workspace = fs.realpathSync(context.workspace);
  const file = fs.realpathSync(path.resolve(workspace, input.file_path));
  const relative = path.relative(workspace, file);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('投递文件必须位于当前工作空间内');
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('投递路径必须是文件');
  if (stat.size > context.maxBytes) throw new Error(`文件超过 ${Math.floor(context.maxBytes / 1024 / 1024)} MiB 投递上限`);
  const digest = crypto.createHash('sha256').update(context.chatId).update(context.messageId || '')
    .update(file).update(fs.readFileSync(file)).digest('hex').slice(0, 36);
  const args = ['im', '+messages-send', '--as', 'bot', '--chat-id', context.chatId,
    '--file', path.basename(file), '--idempotency-key', `cfb-file-${digest}`, '--format', 'json'];
  const reply = await (options.runCli || runCli)(
    context.larkCli,
    args,
    path.dirname(file),
    { spawnProcess: options.spawnProcess, larkProfileHome: context.larkProfileHome || '' },
  );
  const messageId = findValue(reply, 'message_id');
  if (reply.ok === false || (reply.code != null && Number(reply.code) !== 0) || !messageId) throw new Error(`飞书未确认文件投递：${safeError(JSON.stringify(reply))}`);
  return { delivered: true, chat_id: context.chatId, message_id: messageId, file_name: path.basename(file), bytes: stat.size };
}

async function serve() {
  const context = JSON.parse(process.env.CFB_FEISHU_TOOL_CONTEXT || '{}');
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    let request;
    try { request = JSON.parse(line); } catch { continue; }
    if (request.id == null) continue;
    let result;
    try {
      if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: 'feishu-bridge', version: '1.0.0' } };
      else if (request.method === 'tools/list') result = { tools: feishuTools() };
      else if (request.method === 'tools/call') result = { content: [{ type: 'text',
        text: JSON.stringify(await callFeishuTool(request.params.name, request.params.arguments || {}, context)) }] };
      else result = {};
    } catch (error) { result = { content: [{ type: 'text', text: safeError(error) }], isError: true }; }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result })+'\n');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  serve().catch((error) => { process.stderr.write(safeError(error)+'\n'); process.exitCode = 1; });
}
