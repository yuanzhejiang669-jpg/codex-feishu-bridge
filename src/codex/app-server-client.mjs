import { spawn } from "node:child_process";

export const DEFAULT_MAX_STDERR_BYTES = 1024 * 1024;

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
    stopGraceMs = 5000,
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
    this.buffer = "";
    this.notifications = [];
    this.notificationWaiters = [];
    this.maxStderrBytes = Math.max(1024, Number(maxStderrBytes) || DEFAULT_MAX_STDERR_BYTES);
    this.stderrBuffer = Buffer.alloc(0);
    this.stopGraceMs = Math.max(0, Number(stopGraceMs) || 0);
    this.stopEscalationTimer = null;
    this.closed = false;
  }

  start() {
    const args = [...(this.tool.argsPrefix || []), "app-server", "--listen", "stdio://"];
    this.child = this.spawnProcess(this.tool.command, args, {
      cwd: this.cwd,
      env: {
        ...process.env,
        CODEX_HOME: this.codexHome,
        CODEX_FEISHU_BRIDGE: "1",
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
    this.child.on("close", (code, signal) => {
      this.closed = true;
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
    this.buffer += chunk.toString("utf8");
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) break;
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
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

  handleMessage(message) {
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (Object.prototype.hasOwnProperty.call(message, "error")) {
        pending.reject(new Error(this.formatError(message.error, "codex app-server request failed")));
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
        reject(new Error(`codex app-server request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
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

  async stop() {
    if (!this.child || this.closed) return;
    try {
      this.child.stdin.end();
    } catch {}
    try {
      this.child.kill("SIGTERM");
    } catch {}
    if (this.closed) return;
    this.stopEscalationTimer = setTimeout(() => {
      this.stopEscalationTimer = null;
      if (!this.closed) this.terminateProcessTree(this.child?.pid, true);
    }, this.stopGraceMs);
    this.stopEscalationTimer.unref?.();
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
