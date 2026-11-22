import { spawn, execFile } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import configuration from './configuration.cjs';

export function antigravityArguments({ geminiDir, appDataDir = 'antigravity-cli', logFile, additionalDirectories = [], permissionMode = 'default' } = {}) {
  const args = ['acp', '--process-per-session'];
  if (geminiDir) args.push('--gemini-dir', path.resolve(geminiDir));
  if (appDataDir) args.push('--app-data-dir', appDataDir);
  if (logFile) args.push('--log-file', path.resolve(logFile));
  for (const directory of additionalDirectories) if (directory) args.push('--add-dir', path.resolve(directory));
  if (permissionMode === 'always-proceed') args.push('--dangerously-skip-permissions');
  return args;
}

export function antigravityEnvironment(environment, provider = {}) {
  const env = { ...environment };
  for (const name of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'AGY_ADC_AUTH']) delete env[name];
  if (provider.mode === 'gemini-api') {
    if (!provider.apiKey) throw new Error('Antigravity Provider API Key 不可用');
    env.GEMINI_API_KEY = provider.apiKey;
    if (provider.baseUrl) env.GOOGLE_GEMINI_BASE_URL = provider.baseUrl;
  }
  return env;
}

export function antigravityContent(text, attachments = []) {
  const content = text ? [{ type: 'text', text }] : [];
  for (const attachment of attachments) {
    if (!attachment.path) continue;
    const filename = attachment.name || path.basename(attachment.path);
    if (attachment.type === 'image') {
      const mimeType = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' })[path.extname(attachment.path).toLowerCase()];
      if (mimeType && fs.existsSync(attachment.path)) {
        if (fs.statSync(attachment.path).size > 20 * 1024 * 1024) throw new Error('图片超过 20 MiB，请缩小后重试');
        content.push({ type: 'image', mimeType, data: fs.readFileSync(attachment.path).toString('base64') });
        continue;
      }
    }
    content.push({ type: 'resource_link', uri: pathToFileURL(path.resolve(attachment.path)).href, name: filename });
  }
  return content.length ? content : [{ type: 'text', text: '(attachment only)' }];
}

export function safeMessage(value, secrets = []) {
  let text = String(value || '');
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
  return text.replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]').replace(/Bearer\s+[^\s"\\]+/gi, 'Bearer [redacted]').slice(-3000);
}

export class AntigravityAcpClient {
  constructor({ command, cwd, geminiDir, appDataDir, logFile, provider, environment = process.env,
    additionalDirectories = [], permissionMode = 'default', spawnProcess = spawn,
    requestTimeoutMs = 60_000, idleTimeoutMs = 60 * 60_000,
    onEvent = () => {}, onPermission = async () => false, onStarted = () => {}, onClosed = () => {} } = {}) {
    Object.assign(this, { command, cwd, geminiDir, appDataDir, logFile, provider, environment, additionalDirectories,
      permissionMode, spawnProcess, requestTimeoutMs, idleTimeoutMs, onEvent, onPermission, onStarted, onClosed });
    this.pending = new Map(); this.permissions = new Map(); this.nextId = 1;
    this.buffer = ''; this.stderr = ''; this.closed = false; this.stopped = false;
    this.replaying = false; this.sessionId = ''; this.text = ''; this.runtime = {};
    this.decoder = new StringDecoder('utf8');
    this.closedPromise = new Promise((resolve) => { this.resolveClosed = resolve; });
  }

  write(message) {
    if (!this.child?.stdin?.writable || this.closed) throw new Error('Antigravity 控制通道已关闭');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    if (this.closed) return Promise.reject(new Error('Antigravity 已退出'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`Antigravity ${method} 等待响应超时`), { code: 'ANTIGRAVITY_TIMEOUT' }));
      }, timeoutMs) : null;
      timer?.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.write({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  activity() {
    clearTimeout(this.idleTimer);
    if (this.idleTimeoutMs > 0 && !this.permissions.size && this.turnActive) {
      this.idleTimer = setTimeout(() => {
        this.timeoutError = Object.assign(new Error('Antigravity 长时间没有返回进展'), { code: 'ANTIGRAVITY_TIMEOUT' });
        this.close();
      }, this.idleTimeoutMs);
      this.idleTimer.unref?.();
    }
  }

  async initialize() {
    if (this.initialized) return this.runtime;
    if (this.stopped) throw Object.assign(new Error('Antigravity 已停止'), { code: 'USER_STOP' });
    this.appDataDir = configuration.prepareNativeProfile(this.geminiDir, this.provider);
    this.child = this.spawnProcess(this.command, antigravityArguments(this), {
      cwd: this.cwd, env: antigravityEnvironment(this.environment, this.provider),
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.onStarted(this.child);
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.stdout.on('data', (chunk) => this.read(chunk));
    this.child.stderr.on('data', (chunk) => { this.stderr = safeMessage(this.stderr + chunk, [this.provider?.apiKey]); });
    this.child.once('error', (error) => this.fail(error));
    this.child.once('close', (code, signal) => {
      this.closed = true;
      this.fail(this.timeoutError || Object.assign(new Error(this.stopped ? 'Antigravity 已停止' : safeMessage(this.stderr) || `Antigravity 退出 (${code ?? signal})`), { code: this.stopped ? 'USER_STOP' : 'ANTIGRAVITY_EXIT' }));
      this.onClosed(this.child);
      clearTimeout(this.closeTimer); this.resolveClosed();
    });
    const result = await this.request('initialize', {
      protocolVersion: 1, clientInfo: { name: 'Codex Feishu Bridge', version: '1.0.0' },
      // Antigravity executes its own filesystem and terminal tools. No host-side imitation.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    this.initialized = true;
    this.runtime = { ...result };
    return result;
  }

  read(chunk) {
    this.buffer += this.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (this.buffer.length > 32 * 1024 * 1024) { this.fail(new Error('Antigravity 单条事件超过上限')); this.close(); return; }
    let offset;
    while ((offset = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, offset); this.buffer = this.buffer.slice(offset + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { this.onEvent({ type: 'protocol_warning', message: '忽略了一条非 JSON 的 CLI 输出' }); continue; }
      this.activity();
      if (message.method) {
        if (message.id != null) void this.handleRequest(message);
        else {
          try { this.handleNotification(message); }
          catch (error) { this.fail(error); void this.close(); }
        }
      } else if (this.pending.has(message.id)) {
        const pending = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(Object.assign(new Error(safeMessage(message.error.message, [this.provider?.apiKey])), { rpcCode: message.error.code, code: 'ANTIGRAVITY_RPC_ERROR' }));
        else pending.resolve(message.result);
      }
    }
  }

  async handleRequest(message) {
    if (message.method !== 'session/request_permission') {
      try { this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unsupported host method: ${message.method}` } }); } catch {}
      return;
    }
    const params = message.params || {};
    let cancel;
    const cancelled = new Promise((resolve) => { cancel = () => resolve(false); });
    this.permissions.set(message.id, cancel); clearTimeout(this.idleTimer);
    let outcome = { outcome: 'cancelled' };
    try {
      const approved = await Promise.race([Promise.resolve().then(() => this.onPermission(params)), cancelled]);
      const kind = approved ? 'allow_once' : 'reject_once';
      const option = (params.options || []).find((item) => item.kind === kind);
      if (option && !this.stopped) outcome = { outcome: 'selected', optionId: option.optionId };
    } catch {}
    finally {
      this.permissions.delete(message.id); this.activity();
      try { this.write({ jsonrpc: '2.0', id: message.id, result: { outcome } }); } catch {}
    }
  }

  handleNotification(message) {
    if (message.method !== 'session/update') return;
    const { sessionId, update = {} } = message.params || {};
    if (this.sessionId && sessionId !== this.sessionId) return;
    const type = update.sessionUpdate;
    if (type === 'usage_update') this.runtime.context = { usedTokens: update.used, contextWindow: update.size };
    if (type === 'config_option_update') this.runtime.configOptions = update.configOptions;
    if (type === 'available_commands_update') this.runtime.availableCommands = update.availableCommands;
    if (this.replaying) return;
    if (type === 'agent_message_chunk' && update.content?.type === 'text') this.text += update.content.text;
    this.onEvent({ type, update, sessionId });
  }

  async openSession({ sessionId, mcpServers = [], model, effort, mode } = {}) {
    await this.initialize();
    if (this.stopped) throw Object.assign(new Error('Antigravity 已停止'), { code: 'USER_STOP' });
    this.sessionId = sessionId || '';
    this.replaying = Boolean(sessionId);
    let result;
    try {
      result = await this.request(sessionId ? 'session/load' : 'session/new', { ...(sessionId ? { sessionId } : {}), cwd: this.cwd, mcpServers });
    } finally { this.replaying = false; }
    this.sessionId = result.sessionId || sessionId;
    if (this.stopped) throw Object.assign(new Error('Antigravity 已停止'), { code: 'USER_STOP' });
    this.runtime = { ...this.runtime, ...result };
    if (model) await this.request('session/set_model', { sessionId: this.sessionId, modelId: model });
    if (effort) await this.request('session/set_config_option', { sessionId: this.sessionId, configId: 'thought_level', value: effort });
    if (mode && mode !== 'always-proceed') await this.request('session/set_mode', { sessionId: this.sessionId, modeId: mode });
    return { ...result, sessionId: this.sessionId };
  }

  async prompt(content) {
    if (!this.sessionId) throw new Error('Antigravity 原生会话尚未创建');
    if (this.stopped) throw Object.assign(new Error('Antigravity 已停止'), { code: 'USER_STOP' });
    this.text = ''; this.turnActive = true; this.activity();
    try {
      const result = await this.request('session/prompt', { sessionId: this.sessionId, prompt: content }, 0);
      if (this.stopped || result.stopReason === 'cancelled') throw Object.assign(new Error('Antigravity 已停止'), { code: 'USER_STOP' });
      return { ...result, text: this.text, sessionId: this.sessionId, runtime: this.runtime };
    } finally { this.turnActive = false; clearTimeout(this.idleTimer); }
  }

  interrupt() {
    this.stopped = true;
    for (const cancel of this.permissions.values()) cancel();
    if (this.sessionId) {
      try { this.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.sessionId } }); } catch {}
    } else { this.fail(Object.assign(new Error('Antigravity 已停止'), { code: 'USER_STOP' })); void this.close(); }
  }

  fail(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const cancel of this.permissions.values()) cancel();
    clearTimeout(this.idleTimer);
  }

  close() {
    clearTimeout(this.idleTimer);
    for (const cancel of this.permissions.values()) cancel();
    if (!this.child) { this.closed = true; this.resolveClosed(); return this.closedPromise; }
    this.child?.stdin?.end();
    if (!this.closed && !this.closeTimer) {
      const child = this.child;
      this.closeTimer = setTimeout(() => {
        if (this.closed) return;
        if (process.platform === 'win32' && child.pid) execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
        else child.kill('SIGKILL');
      }, 2000);
      this.closeTimer.unref?.();
    }
    return this.closedPromise;
  }
}
