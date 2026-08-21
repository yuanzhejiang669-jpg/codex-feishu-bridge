export const AGENT_ENGINE_METHODS = Object.freeze([
  "run",
  "steer",
  "abort",
  "compact",
  "status",
  "dispose",
]);

export function assertAgentEngineAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") throw new Error("Agent engine adapter is required");
  const id = String(adapter.id || "").trim();
  if (!id) throw new Error("Agent engine adapter id is required");
  for (const method of AGENT_ENGINE_METHODS) {
    if (typeof adapter[method] !== "function") {
      throw new Error(`Agent engine adapter ${id} must implement ${method}()`);
    }
  }
  return adapter;
}
