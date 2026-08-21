import fs from "node:fs/promises";
import path from "node:path";

import { AGENT_ENGINE_PI } from "../agents/engine.mjs";
import { normalizePiEvent } from "./events.mjs";

export class PiEngineError extends Error {
  constructor(message, { kind = "unknown", cause = null, recoverable = false } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "PiEngineError";
    this.kind = kind;
    this.recoverable = recoverable;
  }
}

export function classifyPiFailure(error) {
  if (error instanceof PiEngineError) return error;
  const message = String(error?.message || error || "Pi engine failed");
  const lower = message.toLowerCase();
  let kind = "unknown";
  let recoverable = false;
  if (lower.includes("timed out") || lower.includes("did not become ready")) {
    kind = "timeout";
    recoverable = true;
  } else if (lower.includes("exited") || lower.includes("not running") || lower.includes("stdin")) {
    kind = "process_exit";
    recoverable = true;
  } else if (lower.includes("rate limit") || lower.includes("429")) {
    kind = "rate_limit";
    recoverable = true;
  } else if (lower.includes("unauthorized") || lower.includes("api key") || lower.includes("401")) {
    kind = "auth";
  } else if (lower.includes("abort") || lower.includes("stopped")) {
    kind = "user_stop";
  } else if (lower.includes("session")) {
    kind = "session";
  }
  return new PiEngineError(message, { kind, cause: error, recoverable });
}

export class PiEngineAdapter {
  constructor({
    createClient,
    textFromEvent = defaultTextFromEvent,
    imagesFromEvent = defaultImagesFromEvent,
    persistSession = () => {},
    reduceEvent = () => false,
    log = () => {},
    readyTimeoutMs = 60_000,
    turnTimeoutMs = 0,
    statsTimeoutMs = 3_000,
    sessionDir = "",
  } = {}) {
    if (typeof createClient !== "function") throw new Error("PiEngineAdapter requires createClient");
    this.id = AGENT_ENGINE_PI;
    this.createClient = createClient;
    this.textFromEvent = textFromEvent;
    this.imagesFromEvent = imagesFromEvent;
    this.persistSession = persistSession;
    this.reduceEvent = reduceEvent;
    this.log = log;
    this.readyTimeoutMs = readyTimeoutMs;
    this.turnTimeoutMs = turnTimeoutMs;
    this.statsTimeoutMs = statsTimeoutMs;
    this.sessionDir = String(sessionDir || "").trim();
    this.clients = new Map();
    this.activeRuns = new Map();
    this.sessionMutations = new Set();
    this.disposed = false;
  }

  async run(event, session, state = null, onState = null) {
    const key = sessionKey(session);
    if (this.activeRuns.has(key) || this.sessionMutations.has(key)) {
      throw new PiEngineError("Pi session is busy", { kind: "busy" });
    }
    const run = {
      client: null,
      event,
      session,
      startedAt: Date.now(),
      text: "",
      finalText: "",
      usage: null,
      settled: false,
      abortRequested: false,
    };
    this.activeRuns.set(key, run);
    let unsubscribe = () => {};
    try {
      const client = await this.#clientFor(session);
      run.client = client;
      if (run.abortRequested) throw new PiEngineError("Pi turn stopped during startup", { kind: "user_stop" });
      const message = String(await this.textFromEvent(event, session) || "").trim() || "(attachment only)";
      const images = await this.imagesFromEvent(event, session);
      if (run.abortRequested) throw new PiEngineError("Pi turn stopped before prompt", { kind: "user_stop" });
      unsubscribe = client.onEvent((rawEvent) => {
        const normalized = normalizePiEvent(rawEvent);
        if (!normalized) return;
        if (normalized.kind === "text_delta") run.text += normalized.text || "";
        if (["assistant_message", "turn_completed"].includes(normalized.kind) && normalized.text) {
          run.finalText = normalized.text;
        }
        if (normalized.usage) run.usage = normalized.usage;
        if (normalized.kind === "agent_settled") run.settled = true;
        const changed = this.reduceEvent(state, normalized, run) === true;
        if (changed && onState) void Promise.resolve(onState(state)).catch((error) => {
          this.log("WARN", "Pi state update failed", { error: String(error?.message || error) });
        });
      });
      const settled = client.waitForEvent(
        (item) => item?.type === "agent_settled",
        this.turnTimeoutMs > 0 ? this.turnTimeoutMs : undefined,
      );
      await client.request({ type: "prompt", message, ...(images.length ? { images } : {}) });
      await settled;
      if (run.usage) session.piUsage = run.usage;
      const current = await client.request({ type: "get_state" });
      this.#applySessionState(session, current?.data);
      await this.#refreshSessionStats(session, client);
      const text = String(run.finalText || run.text || "").trim();
      return {
        text: text || "(Pi did not return content)",
        durationMs: Date.now() - run.startedAt,
        mode: "pi-rpc",
        sessionId: session.piSessionId,
        sessionFile: session.piSessionFile,
        usage: run.usage,
      };
    } catch (error) {
      const failure = classifyPiFailure(error);
      if (["process_exit", "session"].includes(failure.kind)) await this.#discardClient(key, failure.kind);
      throw failure;
    } finally {
      unsubscribe();
      if (this.activeRuns.get(key) === run) this.activeRuns.delete(key);
    }
  }

  async steer(activeRun, input = {}) {
    const run = this.#resolveActiveRun(activeRun);
    if (!run.client) throw new PiEngineError("Pi session is still starting", { kind: "busy", recoverable: true });
    const behavior = input.behavior === "follow_up" || input.behavior === "followUp" ? "follow_up" : "steer";
    const message = String(input.message || input.userContent || "").trim();
    const images = Array.isArray(input.images)
      ? input.images
      : input.event
        ? await this.imagesFromEvent(input.event, run.session)
        : [];
    if (!message && !images.length) throw new PiEngineError("Pi steer input is empty", { kind: "input" });
    return run.client.request({ type: behavior, message, ...(images.length ? { images } : {}) });
  }

  async abort(activeRun) {
    const run = this.#resolveActiveRun(activeRun);
    if (!run.client) {
      run.abortRequested = true;
      return { queued: true };
    }
    return run.client.request({ type: "abort" });
  }

  async compact(session, customInstructions = "") {
    const client = await this.#clientFor(session);
    const response = await client.request({
      type: "compact",
      ...(customInstructions ? { customInstructions } : {}),
    });
    const current = await client.request({ type: "get_state" });
    this.#applySessionState(session, current?.data);
    session.piCompactedAt = Date.now();
    await this.#refreshSessionStats(session, client);
    this.persistSession(session);
    return response?.data || null;
  }

  async resetSession(session) {
    const key = sessionKey(session);
    if (this.activeRuns.has(key)) throw new PiEngineError("Pi session has an active turn", { kind: "busy" });
    const client = await this.#clientFor(session);
    const response = await client.request({ type: "new_session" });
    if (response?.data?.cancelled) throw new PiEngineError("Pi new session was cancelled by an extension", { kind: "session" });
    const current = await client.request({ type: "get_state" });
    session.piUsage = null;
    session.piContextUsage = null;
    session.piContextPeakUsage = null;
    session.piCompactedAt = null;
    this.#applySessionState(session, current?.data);
    return current?.data || null;
  }

  async renameSession(session, name) {
    const title = String(name || "").trim();
    if (!title) throw new PiEngineError("Pi session name is required", { kind: "input" });
    if (!session?.piSessionId && !session?.piSessionFile) return { renamed: false };
    const client = await this.#clientFor(session);
    await client.request({ type: "set_session_name", name: title });
    session.updatedAt = Date.now();
    this.persistSession(session);
    return { renamed: true };
  }

  async deleteSession(session, { beforeDelete = null } = {}) {
    const key = sessionKey(session);
    if (this.activeRuns.has(key) || this.sessionMutations.has(key)) {
      throw new PiEngineError("Pi session is busy", { kind: "busy" });
    }
    this.sessionMutations.add(key);
    const sessionFile = String(session?.piSessionFile || "").trim();
    try {
      const resolvedFile = sessionFile ? this.#assertSessionFileAllowed(sessionFile) : "";
      await this.#discardClient(key, "session-delete");
      if (typeof beforeDelete === "function") await beforeDelete();
      if (!resolvedFile) return { deleted: false, missing: true, path: "" };
      try {
        await fs.unlink(resolvedFile);
        return { deleted: true, missing: false, path: resolvedFile };
      } catch (error) {
        if (error?.code === "ENOENT") return { deleted: false, missing: true, path: resolvedFile };
        throw new PiEngineError(`Unable to delete Pi session file: ${error?.message || error}`, {
          kind: "session",
          cause: error,
        });
      }
    } finally {
      this.sessionMutations.delete(key);
    }
  }

  async status(session) {
    const key = sessionKey(session);
    const client = this.clients.get(key);
    if (!client || client.closed) {
      return {
        engine: AGENT_ENGINE_PI,
        running: false,
        active: this.activeRuns.has(key),
        sessionId: String(session?.piSessionId || ""),
        sessionFile: String(session?.piSessionFile || ""),
      };
    }
    const response = await client.request({ type: "get_state" });
    this.#applySessionState(session, response?.data);
    return { engine: AGENT_ENGINE_PI, running: true, active: this.activeRuns.has(key), ...response.data };
  }

  async dispose(reason = "shutdown") {
    if (this.disposed) return;
    this.disposed = true;
    this.log("INFO", "disposing Pi engine adapter", { reason, clients: this.clients.size });
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.activeRuns.clear();
    this.sessionMutations.clear();
    await Promise.all(clients.map((client) => client.stop().catch(() => {})));
  }

  async #clientFor(session) {
    if (this.disposed) throw new PiEngineError("Pi engine adapter is disposed", { kind: "process_exit" });
    const key = sessionKey(session);
    const current = this.clients.get(key);
    if (current && !current.closed) return current;
    if (current) this.clients.delete(key);
    let client;
    try {
      client = await this.createClient(session);
      await client.start();
      await client.waitUntilReady({ timeoutMs: this.readyTimeoutMs });
      const state = await client.request({ type: "get_state" });
      this.#assertResumeIdentity(session, state?.data);
      this.#applySessionState(session, state?.data);
      this.clients.set(key, client);
      return client;
    } catch (error) {
      await client?.stop?.().catch(() => {});
      throw classifyPiFailure(error);
    }
  }

  #assertResumeIdentity(session, state) {
    const expectedFile = normalizedPath(session?.piSessionFile);
    const actualFile = normalizedPath(state?.sessionFile);
    if (expectedFile && (!actualFile || expectedFile !== actualFile)) {
      throw new PiEngineError(
        `Pi session resume mismatch: expected ${session.piSessionFile}, received ${state?.sessionFile || "none"}`,
        { kind: "session" },
      );
    }
    const expectedId = String(session?.piSessionId || "").trim();
    const actualId = String(state?.sessionId || "").trim();
    if (expectedId && actualId && expectedId !== actualId) {
      throw new PiEngineError(
        `Pi session resume mismatch: expected ${expectedId}, received ${actualId}`,
        { kind: "session" },
      );
    }
  }

  #applySessionState(session, state) {
    if (!state?.sessionId) throw new PiEngineError("Pi RPC state has no sessionId", { kind: "session" });
    session.piSessionId = String(state.sessionId);
    session.piSessionFile = String(state.sessionFile || session.piSessionFile || "");
    session.piUsage = state.usage || session.piUsage || null;
    session.updatedAt = Date.now();
    this.persistSession(session);
  }

  async #refreshSessionStats(session, client) {
    try {
      const response = await client.request({ type: "get_session_stats" }, this.statsTimeoutMs);
      this.#applySessionStats(session, response?.data);
    } catch (error) {
      this.log("WARN", "Pi session stats unavailable", {
        sessionId: String(session?.piSessionId || ""),
        error: String(error?.message || error).slice(0, 1000),
      });
    }
  }

  #applySessionStats(session, stats) {
    if (!stats || typeof stats !== "object") return;
    const usage = normalizePiStatsUsage(stats.tokens);
    if (usage) session.piUsage = usage;
    const contextUsage = normalizePiContextUsage(stats.contextUsage);
    if (contextUsage) {
      session.piContextUsage = contextUsage;
      session.piContextPeakUsage = maxPiContextUsage(session.piContextPeakUsage, contextUsage);
    }
    session.updatedAt = Date.now();
    this.persistSession(session);
  }

  #resolveActiveRun(activeRun) {
    if (activeRun?.client) return activeRun;
    const key = typeof activeRun === "string" ? activeRun : sessionKey(activeRun?.session || activeRun);
    const run = this.activeRuns.get(key);
    if (!run) throw new PiEngineError("Pi session has no active turn", { kind: "not_active" });
    return run;
  }

  #assertSessionFileAllowed(sessionFile) {
    if (!this.sessionDir) throw new PiEngineError("Pi session directory is not configured", { kind: "session" });
    const root = path.resolve(this.sessionDir);
    const candidate = path.resolve(sessionFile);
    const rootKey = process.platform === "win32" ? root.toLowerCase() : root;
    const candidateKey = process.platform === "win32" ? candidate.toLowerCase() : candidate;
    if (!candidateKey.startsWith(`${rootKey}${path.sep}`) || path.extname(candidate).toLowerCase() !== ".jsonl") {
      throw new PiEngineError(`Pi session file is outside the configured session directory: ${sessionFile}`, { kind: "session" });
    }
    return candidate;
  }

  async #discardClient(key, reason) {
    const client = this.clients.get(key);
    this.clients.delete(key);
    this.log("WARN", "discarding Pi RPC client", { sessionId: key, reason });
    await client?.stop?.().catch(() => {});
  }
}

function sessionKey(session) {
  const key = String(session?.id || "").trim();
  if (!key) throw new PiEngineError("Bridge session id is required", { kind: "session" });
  return key;
}

function defaultTextFromEvent(event) {
  if (typeof event?.content === "string") return event.content;
  return String(event?.text || "");
}

async function defaultImagesFromEvent(event) {
  const images = [];
  for (const attachment of Array.isArray(event?.attachments) ? event.attachments : []) {
    if (attachment?.type !== "image" || !attachment.path) continue;
    const data = await fs.readFile(attachment.path);
    images.push({ type: "image", data: data.toString("base64"), mimeType: imageMimeType(attachment.path) });
  }
  return images;
}

function imageMimeType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png": return "image/png";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    default: return "image/jpeg";
  }
}

function normalizedPath(value) {
  const text = String(value || "").trim();
  return text ? path.resolve(text).toLowerCase() : "";
}

function normalizePiStatsUsage(value) {
  if (!value || typeof value !== "object") return null;
  return {
    inputTokens: Number(value.input) || 0,
    outputTokens: Number(value.output) || 0,
    cachedInputTokens: Number(value.cacheRead) || 0,
    cacheWriteTokens: Number(value.cacheWrite) || 0,
    totalTokens: Number(value.total) || 0,
  };
}

function normalizePiContextUsage(value) {
  if (!value || typeof value !== "object") return null;
  const usedTokens = optionalFiniteNumber(value.tokens);
  const contextWindow = optionalFiniteNumber(value.contextWindow);
  const percent = optionalFiniteNumber(value.percent);
  if (usedTokens === null && contextWindow === null && percent === null) return null;
  return {
    usedTokens,
    contextWindow: contextWindow > 0 ? contextWindow : null,
    percent,
    updatedAt: Date.now(),
  };
}

function maxPiContextUsage(current, candidate) {
  const currentScore = piContextUsageScore(current);
  const candidateScore = piContextUsageScore(candidate);
  if (candidateScore === null) return current || null;
  if (currentScore === null || candidateScore >= currentScore) return candidate;
  return current;
}

function piContextUsageScore(value) {
  const percent = optionalFiniteNumber(value?.percent);
  if (percent !== null) return percent;
  return optionalFiniteNumber(value?.usedTokens);
}

function optionalFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
