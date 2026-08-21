import { normalizeAgentEngine } from "../agents/engine.mjs";

export function normalizeEngineSessionIdentity(session) {
  const engine = normalizeAgentEngine(session?.engine);
  return {
    engine,
    codexThreadId: engine === "codex" ? String(session?.codexThreadId || "") : "",
    piSessionId: engine === "pi" ? String(session?.piSessionId || "") : "",
    piSessionFile: engine === "pi" ? String(session?.piSessionFile || "") : "",
  };
}

export function sessionMatchesEngine(session, engine) {
  return normalizeEngineSessionIdentity(session).engine === normalizeAgentEngine(engine);
}
