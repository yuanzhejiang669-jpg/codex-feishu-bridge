import assert from "node:assert/strict";
import test from "node:test";

import {
  agentEngineLabel,
  assertAgentEngine,
  normalizeAgentEngine,
} from "../src/agents/engine.mjs";

test("legacy and unknown engines normalize to codex", () => {
  assert.equal(normalizeAgentEngine(), "codex");
  assert.equal(normalizeAgentEngine("unknown"), "codex");
});

test("Pi engine normalization and labels are explicit", () => {
  assert.equal(normalizeAgentEngine(" PI "), "pi");
  assert.equal(agentEngineLabel("pi"), "Pi");
  assert.equal(agentEngineLabel("codex"), "Codex");
  assert.throws(() => assertAgentEngine("other"), /Unsupported agent engine/);
});
