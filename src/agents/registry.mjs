import { assertAgentEngineAdapter } from "./contract.mjs";
import { assertAgentEngine, normalizeAgentEngine } from "./engine.mjs";

export function createAgentEngineRegistry(adapters = []) {
  const entries = new Map();

  function register(adapter) {
    const valid = assertAgentEngineAdapter(adapter);
    const id = assertAgentEngine(valid.id);
    if (entries.has(id)) throw new Error(`Agent engine adapter is already registered: ${id}`);
    entries.set(id, valid);
    return valid;
  }

  function get(engine) {
    const id = normalizeAgentEngine(engine);
    const adapter = entries.get(id);
    if (!adapter) throw new Error(`Agent engine adapter is not registered: ${id}`);
    return adapter;
  }

  async function dispose(reason = "shutdown") {
    await Promise.all([...entries.values()].map((adapter) => adapter.dispose(reason)));
  }

  for (const adapter of adapters) register(adapter);

  return {
    dispose,
    get,
    has: (engine) => entries.has(normalizeAgentEngine(engine)),
    ids: () => [...entries.keys()],
    register,
  };
}
