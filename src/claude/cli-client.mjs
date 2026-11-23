import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { terminateProcessTree } from '../runtime/process-runner.mjs';

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
export const DEFAULT_MAX_LINE_BYTES = 128 * 1024 * 1024;
export const MAX_ALLOWED_LINE_BYTES = 450 * 1024 * 1024;

function resolveMaxLineBytes(value) {
  const envRaw = process.env.CODEX_FEISHU_CLAUDE_MAX_LINE_BYTES;
  const parsed = Number(value ?? (envRaw ? Number(envRaw) : DEFAULT_MAX_LINE_BYTES));
  const candidate = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_LINE_BYTES;
  return Math.min(MAX_ALLOWED_LINE_BYTES, Math.max(64 * 1024, Math.floor(candidate)));
}

export function claudeEnvironment(environment, { home, provider, toolHome = home }) {
  const env = { ...environment };
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_PROVIDER_)/.test(key)
        || ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
          'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_EFFORT_LEVEL'].includes(key)) delete env[key];
  }
  if (!provider?.apiKey) throw new Error('Claude Provider API Key 不可用');
  env.CLAUDE_CONFIG_DIR = home;
  env.CFB_CLAUDE_BOT_HOME = toolHome;
  env.ANTHROPIC_BASE_URL = String(provider.baseUrl).replace(/\/+$/, '').replace(/\/v1$/, '');
  env[provider.auth === 'x-api-key' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'] = provider.apiKey;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = provider.model;
  env.CLAUDE_CODE_MAX_RETRIES ??= '2';
  env.PYTHONUTF8 ??= '1';
  env.PYTHONIOENCODING ??= 'utf-8';
  return env;
}

export function claudeArguments({ sessionId, resume, model, effort = 'high', permissionMode = 'manual',
  mcpConfigs = [], disableMcp = false, allowedTools = [], tools, additionalDirectories = [], persistSession = true }) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sessionId || '')) throw new Error('Claude session ID 无效');
  if (!model || /[\r\n\0]/.test(model)) throw new Error('Claude 模型无效');
  if (!EFFORTS.has(effort)) throw new Error('Claude 思考强度无效');
  if (!['manual', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'].includes(permissionMode)) throw new Error('Claude 权限模式无效');
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--permission-mode', permissionMode,
    '--model', model, '--effort', effort, resume ? '--resume' : '--session-id', sessionId];
  if (permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
  if (!persistSession) args.push('--no-session-persistence');
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

function apiRetryEvent(message) {
  const error = message.error || {};
  const text = typeof error === 'string' ? error : String(error.message || JSON.stringify(error));
  const status = Number(message.error_status || message.status_code || message.statusCode || error.status || error.status_code
    || text.match(/(?:API Error:|HTTP|"status"\s*:)\s*(\d{3})/i)?.[1]) || null;
  return { type: 'api_retry', statusCode: status,
    attempt: Math.max(0, Number(message.attempt ?? message.retryAttempt) || 0),
    maxRetries: Math.max(0, Number(message.max_retries ?? message.maxRetries) || 0),
    delayMs: Math.max(0, Number(message.retry_delay_ms ?? message.retryInMs) || 0),
    message: status ? `上游 API 返回 HTTP ${status}` : '上游 API 请求失败' };
}

export class ClaudeCliClient {
  constructor({ command, cwd, home, toolHome = home, provider, sessionId = crypto.randomUUID(), resume = false,
    model = provider?.model, effort = 'high', permissionMode = 'manual', mcpConfigs = [],
    disableMcp = false, allowedTools = [], tools, additionalDirectories = [], environment = process.env, spawnProcess = spawn,
    persistSession = true, dispatchCommand = false, maxLineBytes = undefined,
    onEvent = () => {}, onPermission = async () => false, onSession = () => {},
    onStarted = () => {}, onClosed = () => {}, totalTimeoutMs = 0, idleTimeoutMs = 60 * 60_000,
    upstreamTimeoutMs = 4 * 60_000, compactionTimeoutMs = 10 * 60_000 }) {
    Object.assign(this, { command, cwd, home, toolHome, provider, sessionId, resume, model, effort, permissionMode,
      mcpConfigs, disableMcp, allowedTools, tools, additionalDirectories, environment, spawnProcess, persistSession, dispatchCommand, onEvent, onPermission,
      onSession, onStarted, onClosed, totalTimeoutMs, idleTimeoutMs, upstreamTimeoutMs, compactionTimeoutMs });
    this.maxLineBytes = resolveMaxLineBytes(maxLineBytes);
    this.pendingControls = new Set();
    this.seenTools = new Map();
    this.pendingTools = new Set();
    this.streamedMessages = new Set();
    this.pendingInputs = new Set();
    this.messageId = '';
    this.stopped = false;
    this.closed = false;
  }

  killChildTree(force = true) {
    if (!this.child) return;
    if (this.child.pid && this.spawnProcess === spawn) terminateProcessTree(this.child.pid, force);
    try { this.child.kill?.(); } catch {}
  }

  waitForUpstream() {
    clearTimeout(this.upstreamTimer);
    if (!(this.upstreamTimeoutMs > 0) || this.pendingTools.size) return;
    const waitMs = this.compacting ? Math.max(this.compactionTimeoutMs, this.upstreamTimeoutMs) : this.upstreamTimeoutMs;
    this.upstreamTimer = setTimeout(() => {
      this.upstreamTimedOut = true;
      this.upstreamTimedOutMs = waitMs;
      this.interrupt();
      this.killChildTree(true);
    }, waitMs);
    this.upstreamTimer.unref?.();
  }

  pauseUpstreamWait() { clearTimeout(this.upstreamTimer); }

  write(message) {
    if (!this.child?.stdin?.writable || this.child.stdin.writableEnded || this.closed) throw new Error('Claude Code 控制通道已关闭');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  sendInput(content, { nativeCommand = false, priority } = {}) {
    const uuid = crypto.randomUUID();
    this.write({ type: 'user', session_id: this.sessionId, parent_tool_use_id: null,
      uuid, client_composed: !nativeCommand, ...(priority ? { priority } : {}), message: { role: 'user', content } });
    this.pendingInputs.add(uuid);
    return uuid;
  }

  steer(content) {
    if (!this.initialized || this.result || this.stopped || this.closed) throw new Error('当前 Claude 任务尚未就绪或已结束，请稍后重试');
    this.hasSteered = true;
    return this.sendInput(content, { priority: 'next' });
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
    if (this.permissionMode === 'bypassPermissions') {
      this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId,
        response: { behavior: 'allow', updatedInput: request.input || {} } } });
      return;
    }
    this.pauseUpstreamWait();
    if (request.tool_use_id) this.pendingTools.add(request.tool_use_id);
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
    if (message.type === 'system' && ['api_retry', 'api_error'].includes(message.subtype)) {
      this.lastUpstreamError = apiRetryEvent(message);
      this.onEvent(this.lastUpstreamError);
      return;
    }
    if (message.type === 'system' && message.subtype === 'status') {
      if (message.status === 'compacting' && !this.compacting) {
        this.compacting = true;
        this.waitForUpstream();
        this.onEvent({ type: 'compacting_started' });
      } else if (message.status == null && this.compacting) {
        this.compacting = false;
        this.waitForUpstream();
      }
      return;
    }
    if (message.type === 'system' && message.subtype === 'init') {
      this.initialized = true;
      if (message.session_id) this.sessionId = message.session_id;
      await this.onSession(this.sessionId);
      this.onEvent({ type: 'initialized', sessionId: this.sessionId, model: message.model,
        version: message.claude_code_version || '', permissionMode: message.permissionMode || '',
        tools: message.tools || [], mcpServers: message.mcp_servers || [], skills: message.skills || [] });
    } else if (message.type === 'system' && message.subtype === 'compact_boundary') {
      this.compacting = false;
      this.waitForUpstream();
      this.onEvent({ type: 'compacted', at: Date.now(), metadata: message.compact_metadata });
    } else if (message.type === 'stream_event') {
      const event = message.event || {};
      if (event.type === 'message_start') {
        this.waitForUpstream();
        this.onEvent({ type: 'model_progress' });
        this.messageId = event.message?.id || crypto.randomUUID();
        const usage = event.message?.usage;
        if (usage) this.onEvent({ type: 'context', usedTokens: Number(usage.input_tokens || 0)
          + Number(usage.cache_creation_input_tokens || 0) + Number(usage.cache_read_input_tokens || 0) });
      } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        this.waitForUpstream();
        this.streamedMessages.add(this.messageId);
        this.onEvent({ type: 'text_delta', text: event.delta.text || '' });
      } else if (event.type === 'content_block_delta'
          && ['thinking_delta', 'input_json_delta'].includes(event.delta?.type)) {
        this.waitForUpstream();
        this.onEvent({ type: 'model_progress' });
      } else if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        const tool = event.content_block;
        if (!this.seenTools.has(tool.id)) {
          this.seenTools.set(tool.id, tool.name);
          this.onEvent({ type: 'tool_start', id: tool.id, name: tool.name, input: tool.input || {} });
        }
      }
    } else if (message.type === 'assistant') {
      if (message.isApiErrorMessage || (message.error && message.message?.model === '<synthetic>')) {
        this.lastUpstreamError = apiRetryEvent({ error: { message: toolResultText(message.message?.content) } });
        this.onEvent(this.lastUpstreamError);
        return;
      }
      this.waitForUpstream();
      for (const block of message.message?.content || []) {
        if (block.type === 'text' && !this.streamedMessages.has(message.message?.id)) {
          this.onEvent({ type: 'text_delta', text: block.text || '' });
        } else if (block.type === 'tool_use') {
          this.pendingTools.add(block.id);
          this.pauseUpstreamWait();
          const exists = this.seenTools.has(block.id);
          this.seenTools.set(block.id, block.name);
          this.onEvent({ type: exists ? 'tool_update' : 'tool_start', id: block.id, name: block.name, input: block.input || {} });
        }
      }
    } else if (message.type === 'user') {
      for (const block of Array.isArray(message.message?.content) ? message.message.content : []) {
        if (block.type === 'tool_result') {
          this.pendingTools.delete(block.tool_use_id);
          this.waitForUpstream();
          this.onEvent({ type: 'tool_end', id: block.tool_use_id,
            name: this.seenTools.get(block.tool_use_id) || 'tool',
            output: toolResultText(block.content), error: Boolean(block.is_error) });
        }
      }
    } else if (message.type === 'result') {
      const answered = message.user_message_uuids || (message.user_message_uuid ? [message.user_message_uuid] : []);
      if (this.hasSteered && !answered.length && !message.is_error) {
        throw new Error('Claude CLI 未返回补充消息的处理标识，无法确认补充指令已处理；请更新 CLI 后重试');
      }
      for (const uuid of answered) this.pendingInputs.delete(uuid);
      if (this.hasSteered && this.pendingInputs.size && !message.is_error) {
        this.waitForUpstream();
        return;
      }
      this.pauseUpstreamWait();
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
      ...(process.platform !== 'win32' ? { detached: true } : {}),
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
        this.killChildTree(true);
      }, this.idleTimeoutMs);
      timer?.unref?.();
    };
    const total = this.totalTimeoutMs > 0 ? setTimeout(() => {
      timedOut = 'Claude Code total timeout'; this.interrupt(); this.killChildTree(true);
    }, this.totalTimeoutMs) : null;
    total?.unref?.();
    touch();
    this.waitForUpstream();
    this.child.stderr.on('data', (chunk) => { touch(); stderr = (stderr + chunk).slice(-1_048_576); });
    this.child.stdin.on('error', () => {});
    const lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    const stream = (async () => {
      for await (const line of lines) {
        touch();
        if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
          throw new Error(`Claude Code 返回的单条事件超过上限 (${this.maxLineBytes} bytes)`);
        }
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        await this.handleEvent(message);
      }
    })().catch((error) => { streamError = error; this.killChildTree(true); });
    const closed = new Promise((resolve) => {
      this.child.once('error', (error) => resolve({ error }));
      this.child.once('close', (code, signal) => resolve({ code, signal }));
    });
    try {
      // This is the native CLI's SDK control protocol, not a replacement agent loop.
      if (this.dispatchCommand && /^\/compact(?:\s|$)/.test(typeof content === 'string' ? content : content[0]?.text || '')) {
        this.compacting = true;
        this.waitForUpstream();
      }
      this.sendInput(content, { nativeCommand: this.dispatchCommand });
      const status = await closed;
      await stream;
      if (status.error) throw new Error(redact(status.error.message));
      if (streamError) throw streamError;
      if (timedOut) throw new Error(timedOut);
      if (this.upstreamTimedOut) throw Object.assign(
        new Error(`上游连续 ${Math.round(this.upstreamTimedOutMs / 1000)} 秒没有产生新响应，本轮等待已结束。`),
        { code: 'CLAUDE_UPSTREAM_TIMEOUT', engine: 'claude', statusCode: this.lastUpstreamError?.statusCode });
      if (this.stopped) throw Object.assign(new Error('Claude Code 已停止'), { code: 'USER_STOP' });
      if (!this.result || this.result.is_error || status.code !== 0) {
        throw new Error(redact(this.result?.errors?.join('; ') || this.result?.result
          || stderr || `Claude Code 未正常完成（${status.code ?? status.signal}）`));
      }
      return this.result;
    } finally {
      this.closed = true;
      if (!this.child.killed && this.child.exitCode === null) this.killChildTree(true);
      clearTimeout(timer); clearTimeout(total);
      this.pauseUpstreamWait();
      lines.close();
      this.pendingControls.clear();
      this.pendingTools.clear();
      this.onClosed(this.child);
    }
  }
}
