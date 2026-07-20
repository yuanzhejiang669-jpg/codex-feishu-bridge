const assert = require("node:assert/strict");
const test = require("node:test");
const {
  REASONING_EFFORTS,
  reasoningRegistry,
  resolveModelCapabilities,
  resolveReasoningSelection,
} = require("../src/main/services/reasoning-effort.cjs");

test("loads the shared reasoning registry in the desktop backend", () => {
  const registry = reasoningRegistry();
  assert.equal(registry.registryVersion, "2026-07-20");
  assert.equal(registry.defaultRequestedEffort, "medium");
  assert.deepEqual(REASONING_EFFORTS, registry.canonicalEfforts);
});

test("marks verified Jiuuij Gemini models as reasoning and vision capable", () => {
  assert.deepEqual(resolveModelCapabilities({
    provider: "jiuuij-api",
    model: "gemini-3.5-flash",
  }), { supportsReasoning: true, supportsVision: true });
});

test("maps Jiuuij Gemini requests to each model's verified ceiling and floor", () => {
  assert.equal(resolveReasoningSelection({ provider: "jiuuij-api", model: "gemini-3.5-flash", effort: "max" }).effectiveEffort, "high");
  assert.equal(resolveReasoningSelection({ provider: "jiuuij-api", model: "gemini-3.1-flash-lite", effort: "none" }).effectiveEffort, "minimal");
  assert.equal(resolveReasoningSelection({ provider: "jiuuij-api", model: "gemini-3.1-pro", effort: "minimal" }).effectiveEffort, "low");
});

test("maps a model-specific request without losing the requested effort", () => {
  const result = resolveReasoningSelection({
    provider: "deepseek",
    model: "deepseek-v4-preview",
    effort: "medium",
  });
  assert.equal(result.requestedEffort, "medium");
  assert.equal(result.effectiveEffort, "high");
  assert.equal(result.upstreamValue, "high");
  assert.equal(result.capabilityId, "deepseek-v4");
});

test("rejects an impossible model-specific effort and keeps unknown models generic", () => {
  assert.throws(() => resolveReasoningSelection({
    provider: "xai",
    model: "grok-4.5",
    effort: "none",
  }), /Grok 4\.5.*不支持/);
  const generic = resolveReasoningSelection({ provider: "custom", model: "future-model", effort: "xhigh" });
  assert.equal(generic.effectiveEffort, "xhigh");
  assert.equal(generic.capabilityKnown, false);
});
