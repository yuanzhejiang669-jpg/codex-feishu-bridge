const fs = require("node:fs");
const path = require("node:path");

let sharedModule = null;

function sharedReasoningModule() {
  if (sharedModule) return sharedModule;
  const candidates = [
    process.resourcesPath
      ? path.join(process.resourcesPath, "engine", "src", "config", "model-reasoning.cjs")
      : "",
    path.resolve(__dirname, "..", "..", "..", "..", "..", "src", "config", "model-reasoning.cjs"),
  ].filter(Boolean);
  const modulePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!modulePath) throw new Error(`找不到模型推理能力池：${candidates.join("；")}`);
  sharedModule = require(modulePath);
  return sharedModule;
}

function reasoningRegistry() {
  return sharedReasoningModule().publicRegistry();
}

function resolveModelCapabilities({ provider = "", model = "" } = {}) {
  const capability = sharedReasoningModule().resolveCapability({ provider, model });
  return {
    supportsReasoning: capability.supportsReasoning !== false,
    supportsVision: capability.supportsVision === true,
  };
}

const REASONING_EFFORTS = Object.freeze(reasoningRegistry().canonicalEfforts);

function normalizeReasoningEffort(value, fallback = "medium") {
  const normalized = String(value || fallback).trim().toLowerCase() || fallback;
  if (!REASONING_EFFORTS.includes(normalized)) {
    throw new Error(`推理强度只支持：${REASONING_EFFORTS.join("、")}`);
  }
  return normalized;
}

function resolveReasoningSelection({ provider = "", model = "", effort = "" } = {}) {
  const requestedEffort = normalizeReasoningEffort(effort);
  const result = sharedReasoningModule().mapReasoningEffort({ provider, model, effort: requestedEffort });
  if (!result.supported) {
    const available = sharedReasoningModule().acceptedEfforts(result.capability).join("、") || "无";
    throw new Error(`${result.capability.name} 不支持推理强度 ${requestedEffort}；可接受请求值：${available}`);
  }
  return {
    requestedEffort: result.requestedEffort,
    effectiveEffort: result.effectiveEffort,
    upstreamValue: result.upstreamValue,
    mapped: result.mapped,
    capabilityId: result.capability.id,
    capabilityName: result.capability.name,
    capabilityKnown: result.capability.known,
    registryVersion: result.capability.registryVersion,
  };
}

module.exports = {
  REASONING_EFFORTS,
  normalizeReasoningEffort,
  reasoningRegistry,
  resolveModelCapabilities,
  resolveReasoningSelection,
};
