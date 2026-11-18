import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import readline from 'node:readline';

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function claudeEnvironment(environment, { home, provider }) {
  const env = { ...environment };
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_PROVIDER_)/.test(key)
        || ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
          'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_EFFORT_LEVEL'].includes(key)) delete env[key];
  }
  if (!provider?.apiKey) throw new Error('Claude Provider API Key 不可用');
  env.CLAUDE_CONFIG_DIR = home;
  env.ANTHROPIC_BASE_URL = String(provider.baseUrl).replace(/\/+$/, '').replace(/\/v1$/, '');
  env[provider.auth === 'x-api-key' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'] = provider.apiKey;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = provider.model;
  return env;
}

export function claudeArguments({ sessionId, resume, model, effort = 'high', permissionMode = 'manual',
  mcpConfigs = [], disableMcp = false, allowedTools = [], tools, additionalDirectories = [] }) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sessionId || '')) throw new Error('Claude session ID 无效');
  if (!model || /[\r\n\0]/.test(model)) throw new Error('Claude 模型无效');
  if (!EFFORTS.has(effort)) throw new Error('Claude 思考强度无效');
  if (!['manual', 'acceptEdits', 'auto', 'plan'].includes(permissionMode)) throw new Error('Claude 权限模式无效');
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--permission-mode', permissionMode,
    '--model', model, '--effort', effort, resume ? '--resume' : '--session-id', sessionId];
  if (allowedTools.length) args.push('--allowedTools', allowedTools.join(','));
  if (tools !== undefined) args.push('--tools', tools);
  if (additionalDirectories.length) args.push('--add-dir', ...additionalDirectories);
  if (disableMcp) args.push('--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}');
  else if (mcpConfigs.length) args.push('--mcp-config', ...mcpConfigs);
  return args;
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : []).map((item) => item.text || `[${item.type || 'content'}]`).join('\n');
}

export class ClaudeCliClient {
  constructor({ command, cwd, home, provider, sessionId = crypto.randomUUID(), resume = false,
    model = provider?.model, effort = 'high', permissionMode = 'manual', mcpConfigs = [],
    disableMcp = false, allowedTools = [], tools, additionalDirectories = [], environment = process.env, spawnProcess = spawn,
    onEvent = () => {}, onPermission = async () => false, onSession = () => {},
    onStarted = () => {}, onClosed = () => {}, totalTimeoutMs = 0, idleTimeoutMs = 60 * 60_000 }) {
    Object.assign(this, { command, cwd, home, provider, sessionId, resume, model, effort, permissionMode,
      mcpConfigs, disableMcp, allowedTools, tools, additionalDirectories, environment, spawnProcess, onEvent, onPermission,
      onSession, onStarted, onClosed, totalTimeoutMs, idleTimeoutMs });
    this.pendingControls = new Set();
    this.seenTools = new Map();
    this.streamedMessages = new Set();
    this.messageId = '';
    this.stopped = false;
    this.closed = false;
  }

  write(message) {
    if (!this.child?.stdin?.writable) throw new Error('Claude Code 控制通道已关闭');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  interrupt() {
    this.stopped = true;
    try { this.write({ type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'interrupt' } }); }
    catch {}
  }

  async handleControl(message) {
    const request = message.request || {};
    const requestId = message.request_id;
    if (request.subtype !== 'can_use_tool') {
      this.write({ type: 'control_response', response: { subtype: 'error', request_id: requestId,
        error: `Unsupported host request: ${request.subtype}` } });
      return;
    }
    this.pendingControls.add(requestId);
    try {
      let allowed = false;
      try {
        allowed = await this.onPermission({ id: requestId, toolName: request.tool_name,
          input: request.input || {}, toolUseId: request.tool_use_id, sessionId: this.sessionId });
      } catch {
        this.onEvent({ type: 'host_error', message: '工具许可未能送达，已拒绝本次调用。' });
      }
      if (this.closed || !this.pendingControls.has(requestId)) return;
      this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId,
        response: allowed === true
          ? { behavior: 'allow', updatedInput: request.input || {} }
          : { behavior: 'deny', message: 'The user did not approve this tool call.' } } });
    } finally { this.pendingControls.delete(requestId); }
  }

  async handleEvent(message) {
    this.onEvent({ type: 'activity', rawType: message.type });
    if (message.type === 'control_request') {
      // Do not block stdout while waiting for the user to answer in Feishu.
      this.handleControl(message).catch((error) => this.onEvent({ type: 'host_error', message: error.message }));
      return;
    }
    if (message.type === 'control_cancel_request') {
      this.pendingControls.delete(message.request_id);
      this.onEvent({ type: 'permission_cancelled', id: message.request_id });
      return;
    }
    if (message.type === 'system' && message.subtype === 'init') {
      if (message.session_id) this.sessionId = message.session_id;
      await this.onSession(this.sessionId);
      this.onEvent({ type: 'initialized', sessionId: this.sessionId, model: message.model,
        version: message.claude_code_version || '',
        tools: message.tools || [], mcpServers: message.mcp_servers || [], skills: message.skills || [] });
    } else if (message.type === 'system' && message.subtype === 'compact_boundary') {
      this.onEvent({ type: 'compacted', at: Date.now(), metadata: message.compact_metadata });
    } else if (message.type === 'stream_event') {
      const event = message.event || {};
      if (event.type === 'message_start') {
        this.messageId = event.message?.id || crypto.randomUUID();
        const usage = event.message?.usage;
        if (usage) this.onEvent({ type: 'context', usedTokens: Number(usage.input_tokens || 0)
          + Number(usage.cache_creation_input_tokens || 0) + Number(usage.cache_read_input_tokens || 0) });
      } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        this.streamedMessages.add(this.messageId);
        this.onEvent({ type: 'text_delta', text: event.delta.text || '' });
      } else if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        const tool = event.content_block;
        if (!this.seenTools.has(tool.id)) {
          this.seenTools.set(tool.id, tool.name);
          this.onEvent({ type: 'tool_start', id: tool.id, name: tool.name, input: tool.input || {} });
        }
      }
    } else if (message.type === 'assistant') {
      for (const block of message.message?.content || []) {
        if (block.type === 'text' && !this.streamedMessages.has(message.message?.id)) {
          this.onEvent({ type: 'text_delta', text: block.text || '' });
        } else if (block.type === 'tool_use') {
          const exists = this.seenTools.has(block.id);
          this.seenTools.set(block.id, block.name);
          this.onEvent({ type: exists ? 'tool_update' : 'tool_start', id: block.id, name: block.name, input: block.input || {} });
        }
      }
    } else if (message.type === 'user') {
      for (const block of Array.isArray(message.message?.content) ? message.message.content : []) {
        if (block.type === 'tool_result') this.onEvent({ type: 'tool_end', id: block.tool_use_id,
          name: this.seenTools.get(block.tool_use_id) || 'tool',
          output: toolResultText(block.content), error: Boolean(block.is_error) });
      }
    } else if (message.type === 'result') {
      this.result = message;
      this.onEvent({ type: 'result', result: message });
      this.child.stdin.end();
    }
  }

  async run(content) {
    const args = claudeArguments(this);
    const env = claudeEnvironment(this.environment, this);
    const secrets = [this.provider.apiKey].filter(Boolean);
    const redact = (text) => secrets.reduce((value, secret) => value.replaceAll(secret, '[redacted]'), String(text || ''));
    this.child = this.spawnProcess(this.command, args, { cwd: this.cwd, env,
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.onStarted(this.child);
    let stderr = '';
    let streamError;
    let timedOut = '';
    let timer;
    const touch = () => {
      clearTimeout(timer);
      if (this.idleTimeoutMs > 0) timer = setTimeout(() => {
        timedOut = 'Claude Code idle timeout'; this.interrupt();
        this.child.kill();
      }, this.idleTimeoutMs);
      timer?.unref?.();
    };
    const total = this.totalTimeoutMs > 0 ? setTimeout(() => {
      timedOut = 'Claude Code total timeout'; this.interrupt(); this.child.kill();
    }, this.totalTimeoutMs) : null;
    total?.unref?.();
    touch();
    this.child.stderr.on('data', (chunk) => { touch(); stderr = (stderr + chunk).slice(-1_048_576); });
    this.child.stdin.on('error', () => {});
    const lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    const stream = (async () => {
      for await (const line of lines) {
        touch();
        if (line.length > 16 * 1024 * 1024) throw new Error('Claude Code 返回的单条事件过大');
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        await this.handleEvent(message);
      }
    })().catch((error) => { streamError = error; this.child.kill(); });
    const closed = new Promise((resolve) => {
      this.child.once('error', (error) => resolve({ error }));
      this.child.once('close', (code, signal) => resolve({ code, signal }));
    });
    try {
      // This is the native CLI's SDK control protocol, not a replacement agent loop.
      this.write({ type: 'user', session_id: this.sessionId, parent_tool_use_id: null,
        uuid: crypto.randomUUID(), client_composed: true, message: { role: 'user', content } });
      const status = await closed;
      await stream;
      if (status.error) throw new Error(redact(status.error.message));
      if (streamError) throw streamError;
      if (timedOut) throw new Error(timedOut);
      if (this.stopped) throw Object.assign(new Error('Claude Code 已停止'), { code: 'USER_STOP' });
      if (!this.result || this.result.is_error || status.code !== 0) {
        throw new Error(redact(this.result?.errors?.join('; ') || this.result?.result
          || stderr || `Claude Code 未正常完成（${status.code ?? status.signal}）`));
      }
      return this.result;
    } finally {
      this.closed = true;
      if (!this.child.killed && this.child.exitCode === null) this.child.kill();
      clearTimeout(timer); clearTimeout(total);
      lines.close();
      this.pendingControls.clear();
      this.onClosed(this.child);
    }
  }
}
