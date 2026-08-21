import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { StringDecoder } from "node:string_decoder";

export class PiRpcClient {
  constructor({
    command = process.execPath,
    args = [],
    cwd = process.cwd(),
    env = process.env,
    label = "pi-rpc",
    requestTimeoutMs = 60_000,
    spawnProcess = spawn,
    log = () => {},
  } = {}) {
    this.command = command;
    this.args = [...args];
    this.cwd = cwd;
    this.env = env;
    this.label = label;
    this.requestTimeoutMs = requestTimeoutMs;
    this.spawnProcess = spawnProcess;
    this.log = log;
    this.child = null;
    this.closed = false;
    this.started = false;
    this.ready = false;
    this.closeError = null;
    this.stdoutDecoder = new StringDecoder("utf8");
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.pending = new Map();
    this.eventListeners = new Set();
    this.eventWaiters = new Set();
  }

  async start() {
    if (this.started && !this.closed) return this;
    if (this.child) throw new Error(`${this.label} cannot be restarted`);
    const child = this.spawnProcess(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout?.on("data", (chunk) => this.#onStdout(chunk));
    child.stderr?.on("data", (chunk) => {
      this.stderrBuffer = (this.stderrBuffer + chunk.toString("utf8")).slice(-64 * 1024);
    });
    child.stdin?.on("error", (error) => this.#close(this.#withStderr(error)));
    child.once("exit", (code, signal) => this.#close(
      new Error(`${this.label} exited with ${code ?? signal ?? "unknown"}: ${this.stderrText().slice(-2000)}`),
    ));
    child.once("error", (error) => this.#close(error));
    await new Promise((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      const onError = (error) => {
        child.off("spawn", onSpawn);
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
    if (this.closed) throw this.closeError || new Error(`${this.label} exited during startup`);
    this.started = true;
    return this;
  }

  async waitUntilReady({
    timeoutMs = this.requestTimeoutMs,
    probeTimeoutMs = 5_000,
    retryDelayMs = 250,
  } = {}) {
    if (!this.started || this.closed) {
      throw this.closeError || new Error(`${this.label} is not running`);
    }
    if (this.ready) return this;
    const startedAt = Date.now();
    const deadline = startedAt + Math.max(1, timeoutMs);
    let attempts = 0;
    let lastError = null;
    while (!this.closed && Date.now() < deadline) {
      attempts += 1;
      const remainingMs = deadline - Date.now();
      try {
        const response = await this.request(
          { type: "get_state" },
          Math.max(1, Math.min(probeTimeoutMs, remainingMs)),
        );
        if (!response?.data?.sessionId) throw new Error("get_state returned no sessionId");
        this.ready = true;
        return this;
      } catch (error) {
        if (this.closed) throw this.closeError || this.#withStderr(error);
        lastError = error;
      }
      const retryRemainingMs = deadline - Date.now();
      if (retryRemainingMs <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(retryDelayMs, retryRemainingMs)));
    }
    const elapsedMs = Date.now() - startedAt;
    const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
    throw this.#withStderr(new Error(
      `${this.label} did not become ready after ${attempts} probe(s) in ${elapsedMs}ms.${detail}`,
    ));
  }

  request(command, timeoutMs = this.requestTimeoutMs) {
    if (!this.started || this.closed || !this.child?.stdin?.writable) {
      return Promise.reject(new Error(`${this.label} is not running`));
    }
    const id = String(command?.id || crypto.randomUUID());
    const payload = { ...command, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(this.#withStderr(new Error(
          `${this.label} request ${payload.type || "unknown"} timed out after ${timeoutMs}ms`,
        )));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, command: payload.type || "unknown" });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  onEvent(listener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  waitForEvent(predicate, timeoutMs = this.requestTimeoutMs) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.eventWaiters.delete(waiter);
        reject(this.#withStderr(new Error(`${this.label} event wait timed out after ${timeoutMs}ms`)));
      }, timeoutMs);
      waiter.timer.unref?.();
      this.eventWaiters.add(waiter);
    });
  }

  stderrText() {
    return this.stderrBuffer;
  }

  async stop({ forceAfterMs = 5_000 } = {}) {
    if (!this.child || this.closed) return;
    try {
      if (this.child.stdin?.writable) {
        this.child.stdin.write(`${JSON.stringify({ id: crypto.randomUUID(), type: "abort" })}\n`);
        this.child.stdin.end();
      }
    } catch {}
    const child = this.child;
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
    }, forceAfterMs);
    timer.unref?.();
    await new Promise((resolve) => {
      if (this.closed) return resolve();
      child.once("exit", resolve);
      setTimeout(resolve, forceAfterMs + 1_000).unref?.();
    });
    clearTimeout(timer);
    this.#close(new Error(`${this.label} stopped`));
  }

  #withStderr(error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = this.stderrText().trim().slice(-2000);
    return new Error(stderr && !message.includes(stderr) ? `${message}. Stderr: ${stderr}` : message);
  }

  #onStdout(chunk) {
    this.stdoutBuffer += this.stdoutDecoder.write(chunk);
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const raw = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (raw.trim()) this.#onRecord(raw);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  #onRecord(raw) {
    let record;
    try {
      record = JSON.parse(raw);
    } catch (error) {
      this.log("WARN", "invalid Pi RPC JSON record", { error: error.message, raw: raw.slice(0, 1000) });
      this.#emit({ type: "protocol_error", error: error.message, raw: raw.slice(0, 1000) });
      return;
    }
    if (record?.type === "response" && record.id && this.pending.has(record.id)) {
      const pending = this.pending.get(record.id);
      this.pending.delete(record.id);
      clearTimeout(pending.timer);
      if (record.success === false) pending.reject(new Error(record.error || `${pending.command} failed`));
      else pending.resolve(record);
      return;
    }
    this.#emit(record);
  }

  #emit(record) {
    for (const listener of this.eventListeners) {
      try { listener(record); } catch (error) {
        this.log("WARN", "Pi RPC event listener failed", { error: error.message });
      }
    }
    for (const waiter of [...this.eventWaiters]) {
      let matches = false;
      try { matches = Boolean(waiter.predicate(record)); } catch (error) {
        clearTimeout(waiter.timer);
        this.eventWaiters.delete(waiter);
        waiter.reject(error);
        continue;
      }
      if (!matches) continue;
      clearTimeout(waiter.timer);
      this.eventWaiters.delete(waiter);
      waiter.resolve(record);
    }
  }

  #close(error) {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.closeError = this.#withStderr(error);
    const tail = this.stdoutDecoder.end();
    if (tail) this.stdoutBuffer += tail;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.closeError);
    }
    this.pending.clear();
    for (const waiter of this.eventWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(this.closeError);
    }
    this.eventWaiters.clear();
  }
}
