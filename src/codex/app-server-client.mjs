import { spawn } from "node:child_process";

export const DEFAULT_MAX_STDERR_BYTES = 1024 * 1024;
export const DEFAULT_MAX_LINE_BYTES = 128 * 1024 * 1024;
export const MAX_ALLOWED_LINE_BYTES = 450 * 1024 * 1024;

function resolveMaxLineBytes(value) {
  const envRaw = process.env.CODEX_FEISHU_APP_SERVER_MAX_LINE_BYTES;
  const parsed = Number(value ?? (envRaw ? Number(envRaw) : DEFAULT_MAX_LINE_BYTES));
  const candidate = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_LINE_BYTES;
  return Math.min(MAX_ALLOWED_LINE_BYTES, Math.max(64 * 1024, Math.floor(candidate)));
}

export class AppServerRpcError extends Error {
  constructor(error, method, formatError = defaultErrorText) {
    super(formatError(error, "codex app-server request failed"), { cause: error });
    this.name = "AppServerRpcError";
    this.code = error?.code;
    this.data = error?.data;
    this.method = method;
  }
}

export class AppServerClient {
  constructor({
    tool,
    codexHome,
    workspace,
    cwd = workspace,
    label = "codex-app-server",
    activeChildren = new Map(),
    log = () => {},
    formatError = defaultErrorText,
    terminateProcessTree = () => {},
    spawnProcess = spawn,
    maxStderrBytes = DEFAULT_MAX_STDERR_BYTES,
    maxLineBytes = undefined,
    stopGraceMs = 5000,
    environment = {},
    accountAlias = "",
    refreshAccountTokens = null,
  } = {}) {
    if (!tool?.command) throw new Error("Codex app-server command is required");
    this.tool = tool;
    this.codexHome = codexHome;
    this.workspace = workspace;
    this.cwd = cwd;
    this.label = label;
    this.activeChildren = activeChildren;
    this.log = log;
    this.formatError = formatError;
    this.terminateProcessTree = terminateProcessTree;
    this.spawnProcess = spawnProcess;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.lineChunks = [];
    this.lineByteLength = 0;
    this.maxLineBytes = resolveMaxLineBytes(maxLineBytes);
    this.exitPromise = null;
    this.notifications = [];
    this.notificationWaiters = [];
    this.maxStderrBytes = Math.max(1024, Number(maxStderrBytes) || DEFAULT_MAX_STDERR_BYTES);
    this.stderrBuffer = Buffer.alloc(0);
    this.stopGraceMs = Math.max(0, Number(stopGraceMs) || 0);
    this.stopEscalationTimer = null;
    this.closed = false;
    this.environment = environment;
    this.accountAlias = accountAlias;
    this.refreshAccountTokens = refreshAccountTokens;
  }

  start() {
    const args = [...(this.tool.argsPrefix || []), "app-server", "--listen", "stdio://"];
    this.child = this.spawnProcess(this.tool.command, args, {
      cwd: this.cwd,
      env: {
        ...process.env,
        CODEX_HOME: this.codexHome,
        CODEX_FEISHU_BRIDGE: "1",
        ...this.environment,
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.activeChildren.set(this.child.pid, {
      child: this.child,
      label: `${this.tool.command} ${args.join(" ")}`,
    });
    this.child.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk) => this.appendStderr(chunk));
    this.child.stdin.on("error", (error) => this.rejectAll(error));
    this.child.on("error", (error) => this.rejectAll(error));
    this.exitPromise = new Promise((resolve) => {
      this.child.once("close", (code, signal) => resolve({ code, signal }));
    });
    this.child.on("close", (code, signal) => {
      this.closed = true;
      if (this.lineByteLength > 0 && this.lineByteLength <= this.maxLineBytes) {
        const tail = Buffer.concat(this.lineChunks, this.lineByteLength).toString("utf8").trim();
        if (tail) {
          try {
            this.handleMessage(JSON.parse(tail));
          } catch {}
        }
      }
      this.lineChunks = [];
      this.lineByteLength = 0;
      clearTimeout(this.stopEscalationTimer);
      this.stopEscalationTimer = null;
      this.activeChildren.delete(this.child?.pid);
      const error = new Error(`codex app-server exited (${code ?? signal ?? "unknown"})`);
      this.rejectAll(error);
      for (const waiter of this.notificationWaiters.splice(0)) waiter(null);
    });
    return this;
  }

  onStdout(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ""), "utf8");
    let offset = 0;
    while (offset < buf.length) {
      const nl = buf.indexOf(0x0a, offset);
      if (nl < 0) {
        const tail = offset === 0 ? buf : buf.subarray(offset);
        this.lineChunks.push(tail);
        this.lineByteLength += tail.length;
        if (this.lineByteLength > this.maxLineBytes) {
          this.handleLineLimitExceeded(this.lineByteLength);
        }
        return;
      }
      const segment = buf.subarray(offset, nl);
      offset = nl + 1;
      const totalBytes = this.lineByteLength + segment.length;
      if (totalBytes > this.maxLineBytes) {
        this.handleLineLimitExceeded(totalBytes);
        return;
      }
      if (totalBytes === 0) {
        this.lineChunks = [];
        this.lineByteLength = 0;
        continue;
      }
      const rawLine = this.lineChunks.length
        ? Buffer.concat([...this.lineChunks, segment], totalBytes)
        : segment;
      this.lineChunks = [];
      this.lineByteLength = 0;
      const line = rawLine.toString("utf8").trim();
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.log("WARN", "app-server emitted non-json line", {
          line: line.slice(0, 1000),
          error: String(error),
        });
        continue;
      }
      this.handleMessage(message);
    }
  }

  handleLineLimitExceeded(bufferedBytes) {
    const error = new Error(`codex app-server stdout line exceeded ${this.maxLineBytes} bytes limit`);
    this.log("ERROR", "app-server stdout line limit exceeded", {
      maxLineBytes: this.maxLineBytes,
      bufferedBytes,
    });
    this.lineChunks = [];
    this.lineByteLength = 0;
    this.rejectAll(error);
    void this.stop();
  }

  handleMessage(message) {
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (Object.prototype.hasOwnProperty.call(message, "error")) {
        pending.reject(new AppServerRpcError(message.error, pending.method, this.formatError));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      this.respondToServerRequest(message);
      return;
    }

    if (message.method) {
      if (this.notificationWaiters.length) {
        const waiter = this.notificationWaiters.shift();
        waiter(message);
      } else {
        this.notifications.push(message);
      }
    }
  }

  respondToServerRequest(message) {
    if (this.denyServerRequests) {
      this.write({ id: message.id, error: { code: -32000, message: "Tool and approval requests are disabled during model verification" } });
      return;
    }
    if (message.method === "account/chatgptAuthTokens/refresh") {
      void Promise.resolve().then(async () => {
        if (!this.refreshAccountTokens) throw new Error("该进程没有可刷新的独立账号");
        const result = await this.refreshAccountTokens({ ...(message.params || {}), previousToken: this.currentAccountToken || "" });
        this.currentAccountToken = result.accessToken;
        this.write({ id: message.id, result });
      }).catch(() => {
        try { this.write({ id: message.id, error: { code: -32000, message: "账号刷新失败，请在 Bridge 客户端重新登录所选账号" } }); } catch {}
      });
      return;
    }
    this.write({
      id: message.id,
      result: appServerRequestResult(message.method, this.workspace),
    });
  }

  write(message) {
    if (!this.child || this.closed || this.child.stdin.destroyed) {
      throw new Error("codex app-server is not running");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }

  request(method, params = undefined, timeoutMs = 60_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`codex app-server request timed out: ${method}`);
        error.code = "APP_SERVER_REQUEST_TIMEOUT";
        error.method = method;
        reject(error);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.write(params === undefined ? { id, method } : { id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = undefined) {
    this.write(params === undefined ? { method } : { method, params });
  }

  nextNotification(timeoutMs = 1000) {
    if (this.notifications.length) return Promise.resolve(this.notifications.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = this.notificationWaiters.indexOf(waiter);
        if (index >= 0) this.notificationWaiters.splice(index, 1);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      const waiter = (message) => {
        clearTimeout(timer);
        resolve(message);
      };
      this.notificationWaiters.push(waiter);
    });
  }

  drainNotifications() {
    const drained = this.notifications.length;
    this.notifications.length = 0;
    return drained;
  }

  async stop() {
    if (!this.child || this.closed) return;
    try {
      this.child.stdin.end();
    } catch {}
    try {
      this.child.kill("SIGTERM");
    } catch {}
    if (this.closed) return;
    clearTimeout(this.stopEscalationTimer);
    this.stopEscalationTimer = setTimeout(() => {
      this.stopEscalationTimer = null;
      if (!this.closed) this.terminateProcessTree(this.child?.pid, true);
    }, this.stopGraceMs);
    this.stopEscalationTimer.unref?.();
    if (this.exitPromise) {
      let waitTimer = null;
      try {
        await Promise.race([
          this.exitPromise,
          new Promise((resolve) => {
            waitTimer = setTimeout(resolve, this.stopGraceMs + 1000);
            waitTimer.unref?.();
          }),
        ]);
      } finally {
        clearTimeout(waitTimer);
      }
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  appendStderr(chunk) {
    const next = Buffer.concat([this.stderrBuffer, Buffer.from(chunk)]);
    this.stderrBuffer = next.length > this.maxStderrBytes
      ? next.subarray(next.length - this.maxStderrBytes)
      : next;
  }

  stderrText() {
    return this.stderrBuffer.toString("utf8");
  }
}

export function appServerRequestResult(method, workspace) {
  if (method === "item/commandExecution/requestApproval") return { decision: "accept" };
  if (method === "item/fileChange/requestApproval") return { decision: "accept" };
  if (method === "item/permissions/requestApproval") {
    return {
      permissions: {
        network: { enabled: true },
        fileSystem: { read: null, write: [workspace] },
      },
      scope: "turn",
    };
  }
  if (method === "applyPatchApproval" || method === "execCommandApproval") {
    return { decision: "approved" };
  }
  if (method === "item/tool/requestUserInput") return { answers: {} };
  if (method === "mcpServer/elicitation/request") return { action: "cancel", content: null, _meta: null };
  if (method === "item/tool/call") {
    return {
      contentItems: [{ type: "inputText", text: "Dynamic tool calls are not handled by the Feishu bridge client." }],
      success: false,
    };
  }
  return {};
}

function defaultErrorText(value, fallback) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value?.message) return String(value.message);
  return fallback;
}
