import assert from "node:assert/strict";
import test from "node:test";

import { createAgentEngineRegistry } from "../src/agents/registry.mjs";
import { CodexEngineAdapter } from "../src/codex/engine-adapter.mjs";

function delegates(calls) {
  return {
    run: (...args) => { calls.push(["run", ...args]); return "run-result"; },
    steer: (...args) => { calls.push(["steer", ...args]); return "steer-result"; },
    abort: (...args) => { calls.push(["abort", ...args]); return "abort-result"; },
    compact: (...args) => { calls.push(["compact", ...args]); return "compact-result"; },
    status: (...args) => { calls.push(["status", ...args]); return "status-result"; },
    dispose: (...args) => { calls.push(["dispose", ...args]); return "dispose-result"; },
  };
}

test("legacy engine resolution selects the registered Codex adapter", () => {
  const adapter = new CodexEngineAdapter(delegates([]));
  const registry = createAgentEngineRegistry([adapter]);
  assert.equal(registry.get(), adapter);
  assert.equal(registry.get("codex"), adapter);
  assert.deepEqual(registry.ids(), ["codex"]);
});

test("Codex adapter preserves argument identity and delegate results", async () => {
  const calls = [];
  const adapter = new CodexEngineAdapter(delegates(calls));
  const event = { id: "m1" };
  const session = { id: "s1" };
  const state = { phase: "running" };
  const onState = () => {};
  assert.equal(adapter.run(event, session, state, onState), "run-result");
  assert.deepEqual(calls[0], ["run", event, session, state, onState]);
  assert.equal(adapter.status(session), "status-result");
  assert.equal(await adapter.dispose("test"), "dispose-result");
});

test("registry rejects incomplete and duplicate adapters", () => {
  assert.throws(() => createAgentEngineRegistry([{ id: "codex" }]), /must implement run/);
  const one = new CodexEngineAdapter(delegates([]));
  const two = new CodexEngineAdapter(delegates([]));
  assert.throws(() => createAgentEngineRegistry([one, two]), /already registered/);
});
