import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export class McpStdioClient {
  constructor({ command, args = [], cwd, env = process.env, name = "mcp", timeoutMs = 30_000, spawnProcess = spawn } = {}) {
    if (!command) throw new Error(`MCP ${name} command is required`);
    this.command = command;
    this.args = [...args];
    this.cwd = cwd;
    this.env = env;
    this.name = name;
    this.timeoutMs = timeoutMs;
    this.spawnProcess = spawnProcess;
    this.child = null;
    this.decoder = new StringDecoder("utf8");
    this.buffer = "";
    this.stderr = "";
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  async start() {
    if (this.child && !this.closed) return this;
    this.child = this.spawnProcess(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk) => this.#stdout(chunk));
    this.child.stderr.on("data", (chunk) => { this.stderr = (this.stderr + chunk.toString("utf8")).slice(-64 * 1024); });
    this.child.on("error", (error) => this.#close(error));
    this.child.on("exit", (code, signal) => this.#close(new Error(`MCP ${this.name} exited with ${code ?? signal ?? "unknown"}`)));
    await new Promise((resolve, reject) => {
      this.child.once("spawn", resolve);
      this.child.once("error", reject);
    });
    const initialized = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "codex-feishu-pi-capabilities", version: "0.9.0" },
    });
    this.notify("notifications/initialized", {});
    return initialized;
  }

  request(method, params = {}, timeoutMs = this.timeoutMs) {
    if (!this.child || this.closed || !this.child.stdin.writable) return Promise.reject(new Error(`MCP ${this.name} is not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(this.#error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, "utf8");
    });
  }

  notify(method, params = {}) {
    if (!this.child || this.closed || !this.child.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`, "utf8");
  }

  async listTools() {
    return (await this.request("tools/list", {}))?.tools || [];
  }

  callTool(name, args = {}, timeoutMs = this.timeoutMs) {
    return this.request("tools/call", { name, arguments: args }, timeoutMs);
  }

  async stop() {
    if (!this.child || this.closed) return;
    const child = this.child;
    const exited = new Promise((resolve) => {
      child.once("exit", resolve);
      setTimeout(resolve, 1_000).unref?.();
    });
    try { child.stdin.end(); } catch {}
    try { child.kill("SIGTERM"); } catch {}
    await exited;
    this.#close(new Error(`MCP ${this.name} stopped`));
  }

  #stdout(chunk) {
    this.buffer += this.decoder.write(chunk);
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const raw = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (raw.trim()) this.#record(raw);
      newline = this.buffer.indexOf("\n");
    }
  }

  #record(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(this.#error(message.error.message || "MCP request failed"));
    else pending.resolve(message.result);
  }

  #error(message) {
    const tail = this.stderr.trim().slice(-2000);
    return new Error(`MCP ${this.name} ${message}${tail ? `. Stderr: ${tail}` : ""}`);
  }

  #close(error) {
    if (this.closed) return;
    this.closed = true;
    const failure = this.#error(error?.message || error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    this.pending.clear();
  }
}

export function normalizeMcpToolResult(result) {
  const content = [];
  for (const item of Array.isArray(result?.content) ? result.content : []) {
    if (item?.type === "text") content.push({ type: "text", text: String(item.text || "") });
    else if (item?.type === "image" && item.data) content.push({ type: "image", data: item.data, mimeType: item.mimeType || "image/png" });
    else if (item?.type === "resource") content.push({ type: "text", text: JSON.stringify(item.resource || item) });
  }
  if (!content.length) content.push({ type: "text", text: JSON.stringify(result ?? null) });
  return { content, details: { isError: result?.isError === true }, isError: result?.isError === true };
}
