import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import configuration from './configuration.cjs';
import { terminateProcessTree } from '../runtime/process-runner.mjs';

export const DEFAULT_MAX_LINE_BYTES = 128 * 1024 * 1024;
export const MAX_ALLOWED_LINE_BYTES = 450 * 1024 * 1024;

function resolveMaxLineBytes(value) {
  const envRaw = process.env.CODEX_FEISHU_ANTIGRAVITY_MAX_LINE_BYTES;
  const parsed = Number(value ?? (envRaw ? Number(envRaw) : DEFAULT_MAX_LINE_BYTES));
  const candidate = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_LINE_BYTES;
  return Math.min(MAX_ALLOWED_LINE_BYTES, Math.max(64 * 1024, Math.floor(candidate)));
}

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
    requestTimeoutMs = 60_000, idleTimeoutMs = 60 * 60_000, maxLineBytes = undefined,
    onEvent = () => {}, onPermission = async () => false, onStarted = () => {}, onClosed = () => {} } = {}) {
    Object.assign(this, { command, cwd, geminiDir, appDataDir, logFile, provider, environment, additionalDirectories,
      permissionMode, spawnProcess, requestTimeoutMs, idleTimeoutMs, onEvent, onPermission, onStarted, onClosed });
    this.pending = new Map(); this.permissions = new Map(); this.nextId = 1;
    this.lineChunks = []; this.lineByteLength = 0;
    this.maxLineBytes = resolveMaxLineBytes(maxLineBytes);
    this.stderr = ''; this.closed = false; this.stopped = false;
    this.replaying = false; this.sessionId = ''; this.text = ''; this.runtime = {};
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
      const armTimer = () => (timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`Antigravity ${method} 等待响应超时`), { code: 'ANTIGRAVITY_TIMEOUT' }));
      }, timeoutMs) : null);
      const timer = armTimer();
      timer?.unref?.();
      this.pending.set(id, { resolve, reject, timer, method, timeoutMs, armTimer });
      try { this.write({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  touchPendingRequests(methodFilter = null) {
    for (const pending of this.pending.values()) {
      if (methodFilter && !methodFilter.includes(pending.method)) continue;
      if (!(pending.timeoutMs > 0) || !pending.armTimer) continue;
      clearTimeout(pending.timer);
      pending.timer = pending.armTimer();
      pending.timer?.unref?.();
    }
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
    this.appDataDir = configuration.prepareNativeProfile(this.geminiDir, this.provider, {
      officialAppDataDir: this.appDataDir,
    });
    this.child = this.spawnProcess(this.command, antigravityArguments(this), {
      cwd: this.cwd, env: antigravityEnvironment(this.environment, this.provider),
      ...(process.platform !== 'win32' ? { detached: true } : {}),
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.onStarted(this.child);
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.stdout.on('data', (chunk) => this.read(chunk));
    this.child.stderr.on('data', (chunk) => { this.stderr = safeMessage(this.stderr + chunk, [this.provider?.apiKey]); });
    this.child.once('error', (error) => this.fail(error));
    this.child.once('close', (code, signal) => {
      this.closed = true;
      if (this.lineByteLength > 0 && this.lineByteLength <= this.maxLineBytes) {
        const tail = Buffer.concat(this.lineChunks, this.lineByteLength).toString('utf8').trim();
        if (tail) this.processLine(tail);
      }
      this.lineChunks = []; this.lineByteLength = 0;
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
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ''), 'utf8');
    let offset = 0;
    while (offset < buf.length) {
      const nl = buf.indexOf(0x0a, offset);
      if (nl < 0) {
        const tail = offset === 0 ? buf : buf.subarray(offset);
        this.lineChunks.push(tail);
        this.lineByteLength += tail.length;
        if (this.lineByteLength > this.maxLineBytes) {
          this.lineChunks = []; this.lineByteLength = 0;
          this.fail(new Error(`Antigravity 单条事件超过上限 (${this.maxLineBytes} bytes)`));
          void this.close();
          return;
        }
        return;
      }
      const segment = buf.subarray(offset, nl);
      offset = nl + 1;
      const totalBytes = this.lineByteLength + segment.length;
      if (totalBytes > this.maxLineBytes) {
        this.lineChunks = []; this.lineByteLength = 0;
        this.fail(new Error(`Antigravity 单条事件超过上限 (${this.maxLineBytes} bytes)`));
        void this.close();
        return;
      }
      if (totalBytes === 0) {
        this.lineChunks = []; this.lineByteLength = 0;
        continue;
      }
      const rawLine = this.lineChunks.length
        ? Buffer.concat([...this.lineChunks, segment], totalBytes)
        : segment;
      this.lineChunks = []; this.lineByteLength = 0;
      const line = rawLine.toString('utf8').trim();
      if (!line) continue;
      this.processLine(line);
    }
  }

  processLine(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { this.onEvent({ type: 'protocol_warning', message: '忽略了一条非 JSON 的 CLI 输出' }); return; }
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

  async handleRequest(message) {
    if (message.method !== 'session/request_permission') {
      try { this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unsupported host method: ${message.method}` } }); } catch {}
      return;
    }
    const params = message.params || {};
    if (this.permissionMode === 'always-proceed') {
      const option = (params.options || []).find((item) => item.kind === 'allow_always')
        || (params.options || []).find((item) => item.kind === 'allow_once');
      const outcome = option && !this.stopped ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' };
      try { this.write({ jsonrpc: '2.0', id: message.id, result: { outcome } }); } catch {}
      return;
    }
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
    if (this.replaying) this.touchPendingRequests(['session/load', 'session/resume']);
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

  supportsResume() {
    const caps = this.runtime?.agentCapabilities || this.runtime?.agent_capabilities || {};
    const sessionCaps = caps.sessionCapabilities || caps.session_capabilities || {};
    return Boolean(sessionCaps && Object.prototype.hasOwnProperty.call(sessionCaps, 'resume'));
  }

  async openSession({ sessionId, mcpServers = [], model, effort, mode } = {}) {
    await this.initialize();
    if (this.stopped) throw Object.assign(new Error('Antigravity 已停止'), { code: 'USER_STOP' });
    this.sessionId = sessionId || '';
    this.replaying = Boolean(sessionId);
    const openTimeoutMs = Math.max(this.requestTimeoutMs || 60_000, 180_000);
    let result;
    try {
      if (sessionId) {
        if (this.supportsResume()) {
          try {
            result = await this.request('session/resume', { sessionId, cwd: this.cwd, mcpServers }, openTimeoutMs);
          } catch (error) {
            if (error?.rpcCode === -32601) {
              result = await this.request('session/load', { sessionId, cwd: this.cwd, mcpServers }, openTimeoutMs);
            } else {
              throw error;
            }
          }
        } else {
          result = await this.request('session/load', { sessionId, cwd: this.cwd, mcpServers }, openTimeoutMs);
        }
      } else {
        result = await this.request('session/new', { cwd: this.cwd, mcpServers }, openTimeoutMs);
      }
    } finally { this.replaying = false; }
    this.sessionId = result.sessionId || sessionId;
    if (this.stopped) throw Object.assign(new Error('Antigravity 已停止'), { code: 'USER_STOP' });
    this.runtime = { ...this.runtime, ...result };
    if (model) {
      const modelConfigOpt = (this.runtime.configOptions || []).find((item) => item?.id === 'model');
      const baseOptions = Array.isArray(modelConfigOpt?.options)
        ? modelConfigOpt.options.map((opt) => (typeof opt === 'string' ? opt : String(opt?.value || '').trim())).filter(Boolean)
        : [];
      if (baseOptions.includes(model)) {
        const updated = await this.request('session/set_config_option', { sessionId: this.sessionId, configId: 'model', value: model });
        if (updated?.configOptions) this.runtime.configOptions = updated.configOptions;
      } else {
        await this.request('session/set_model', { sessionId: this.sessionId, modelId: model });
      }
    }
    if (effort) {
      const updated = await this.request('session/set_config_option', { sessionId: this.sessionId, configId: 'thought_level', value: effort });
      if (updated?.configOptions) this.runtime.configOptions = updated.configOptions;
    }
    if (mode && mode !== 'always-proceed') await this.request('session/set_mode', { sessionId: this.sessionId, modeId: mode });
    return {
      ...result,
      sessionId: this.sessionId,
      configOptions: this.runtime.configOptions || result.configOptions,
      models: this.runtime.models || result.models,
    };
  }

  async prompt(content) {
    if (!this.sessionId) throw new Error('Antigravity 原生会话尚未创建');
    if (this.stopped) throw Object.assign(new Error('Antigravity 已停止'), { code: 'USER_STOP' });
    this.text = ''; this.turnActive = true; this.activity();
    this.turnPromise = this.request('session/prompt', { sessionId: this.sessionId, prompt: content }, 0);
    try {
      // Native steering: a session/prompt sent while a turn runs joins that turn. agy answers the
      // earlier request right away and the newest request carries the rest of the turn, so follow
      // the hand-over until the request that is current when it settles has finished.
      let result;
      for (;;) {
        const awaited = this.turnPromise;
        try { result = await awaited; } catch (error) {
          if (awaited !== this.turnPromise && !this.stopped) continue;
          throw error;
        }
        if (awaited === this.turnPromise || this.stopped) break;
      }
      if (this.stopped || result.stopReason === 'cancelled') throw Object.assign(new Error('Antigravity 已停止'), { code: 'USER_STOP' });
      return { ...result, text: this.text, sessionId: this.sessionId, runtime: this.runtime };
    } finally { this.turnActive = false; this.turnPromise = null; clearTimeout(this.idleTimer); }
  }

  canSteer() {
    return Boolean(this.turnActive && this.turnPromise && this.sessionId && !this.stopped && !this.closed);
  }

  steer(content) {
    if (!this.canSteer()) {
      throw Object.assign(new Error('Antigravity 当前没有可追加指令的运行中回合'), { code: 'ANTIGRAVITY_NO_ACTIVE_TURN' });
    }
    const previous = this.turnPromise;
    const tracked = this.request('session/prompt', { sessionId: this.sessionId, prompt: content }, 0)
      .catch((error) => {
        // A rejected steer must not take the running turn down with it.
        if (this.turnPromise === tracked) this.turnPromise = previous;
        throw error;
      });
    tracked.catch(() => {});
    this.turnPromise = tracked;
    this.activity();
    return tracked;
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
        if (child.pid && this.spawnProcess === spawn) terminateProcessTree(child.pid, true);
        else child.kill('SIGKILL');
      }, 2000);
      this.closeTimer.unref?.();
    }
    return this.closedPromise;
  }
}
