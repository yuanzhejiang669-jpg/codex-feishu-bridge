import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadRegistry, mapReasoningEffort, resolveCapability, reviewStatus } = require("../src/config/model-reasoning.cjs");
const registry = loadRegistry();

test("reasoning registry resolves current non-GPT model families", () => {
  assert.equal(resolveCapability({ provider: "mimo2codex", model: "deepseek-v4-pro" }, registry).id, "deepseek-v4");
  assert.equal(resolveCapability({ provider: "moonshot", model: "kimi-k2.6" }, registry).id, "kimi-k2.6");
  assert.equal(resolveCapability({ provider: "zai", model: "glm-5.2" }, registry).id, "glm-5.2");
  assert.equal(resolveCapability({ provider: "xai", model: "grok-4.5" }, registry).id, "grok-4.5");
});

test("reasoning registry exposes requested and effective effort", () => {
  const deepseek = mapReasoningEffort({ provider: "deepseek", model: "deepseek-v4-pro", effort: "medium" }, registry);
  assert.equal(deepseek.supported, true);
  assert.equal(deepseek.requestedEffort, "medium");
  assert.equal(deepseek.effectiveEffort, "high");
  assert.equal(deepseek.upstreamValue, "high");
  const kimi = mapReasoningEffort({ provider: "moonshot", model: "kimi-k2.6", effort: "max" }, registry);
  assert.equal(kimi.effectiveEffort, "high");
  assert.equal(kimi.upstreamValue, "thinking.enabled");
});

test("reasoning registry rejects impossible settings and keeps unknown models generic", () => {
  assert.equal(mapReasoningEffort({ provider: "xai", model: "grok-4.5", effort: "none" }, registry).supported, false);
  const unknown = mapReasoningEffort({ provider: "custom", model: "future-model", effort: "xhigh" }, registry);
  assert.equal(unknown.supported, true);
  assert.equal(unknown.effectiveEffort, "xhigh");
  assert.equal(unknown.capability.known, false);
});

test("reasoning registry reports when a model rule is due for review", () => {
  const capability = resolveCapability({ provider: "deepseek", model: "deepseek-v4-preview" }, registry);
  assert.equal(reviewStatus(capability, registry, Date.parse("2026-08-01T00:00:00Z")).stale, false);
  const overdue = reviewStatus(capability, registry, Date.parse("2026-11-01T00:00:00Z"));
  assert.equal(overdue.stale, true);
  assert.equal(overdue.reviewDueAt, "2026-10-14");
});
