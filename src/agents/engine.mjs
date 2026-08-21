export const AGENT_ENGINE_CODEX = "codex";
export const AGENT_ENGINE_PI = "pi";
export const AGENT_ENGINES = Object.freeze([AGENT_ENGINE_CODEX, AGENT_ENGINE_PI]);

export function normalizeAgentEngine(value, fallback = AGENT_ENGINE_CODEX) {
  const normalized = String(value || "").trim().toLowerCase();
  if (AGENT_ENGINES.includes(normalized)) return normalized;
  const normalizedFallback = String(fallback || "").trim().toLowerCase();
  return AGENT_ENGINES.includes(normalizedFallback) ? normalizedFallback : AGENT_ENGINE_CODEX;
}

export function agentEngineLabel(value) {
  return normalizeAgentEngine(value) === AGENT_ENGINE_PI ? "Pi" : "Codex";
}

export function assertAgentEngine(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!AGENT_ENGINES.includes(normalized)) {
    throw new Error(`Unsupported agent engine: ${value}`);
  }
  return normalized;
}
