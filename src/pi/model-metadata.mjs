const MODEL_LIMITS = new Map([
  ["deepseek-direct/deepseek-chat", Object.freeze({ contextWindow: 128_000, maxTokens: 8_192, input: Object.freeze(["text"]) })],
  ["backup-api/gpt-5.6-sol", Object.freeze({ contextWindow: 258_400, maxTokens: 32_000, input: Object.freeze(["text", "image"]) })],
]);

const GPT_56_THINKING_LEVEL_MAP = Object.freeze({
  off: "none",
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
});

const DEEPSEEK_V4_THINKING_LEVEL_MAP = Object.freeze({
  off: "none",
  minimal: null,
  low: null,
  medium: null,
  high: "high",
  xhigh: null,
  max: "max",
});

const PI_THINKING_LEVEL_ORDER = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function resolvePiModelLimits(providerId, modelId) {
  const key = `${String(providerId || "").trim()}/${String(modelId || "").trim()}`;
  const limits = MODEL_LIMITS.get(key);
  if (!limits) throw new Error(`Pi model metadata is unavailable: ${key}`);
  return limits;
}

export function resolvePiModelThinkingMetadata(providerId, modelId) {
  const provider = String(providerId || "").trim().toLowerCase();
  const model = String(modelId || "").trim().toLowerCase();
  if (provider === "backup-api" && /^gpt-5\.6(?:-(?:sol|terra|luna))?$/.test(model)) {
    return { reasoning: true, thinkingLevelMap: { ...GPT_56_THINKING_LEVEL_MAP } };
  }
  if (provider === "deepseek-direct" && /^deepseek-v4-(?:flash|pro)$/.test(model)) {
    return { reasoning: true, thinkingLevelMap: { ...DEEPSEEK_V4_THINKING_LEVEL_MAP } };
  }
  if (provider === "deepseek-direct" && model === "deepseek-reasoner") {
    return { reasoning: true, thinkingLevelMap: { ...DEEPSEEK_V4_THINKING_LEVEL_MAP } };
  }
  if (provider === "deepseek-direct" && model === "deepseek-chat") {
    return { reasoning: false };
  }
  return null;
}

export function piThinkingLevelsFromMetadata(metadata) {
  if (!metadata?.reasoning) return ["off"];
  return PI_THINKING_LEVEL_ORDER.filter((level) => metadata.thinkingLevelMap?.[level] !== null
    && (level !== "xhigh" && level !== "max" || metadata.thinkingLevelMap?.[level] !== undefined));
}

export function reconcilePiSessionModelLimits(session, limits) {
  if (!session || session.engine !== "pi") return false;
  let changed = false;
  for (const key of ["piContextUsage", "piContextPeakUsage"]) {
    const usage = session[key];
    if (!usage || !Number.isFinite(Number(usage.usedTokens))) continue;
    if (usage.contextWindow === limits.contextWindow) continue;
    const usedTokens = Number(usage.usedTokens);
    session[key] = {
      ...usage,
      contextWindow: limits.contextWindow,
      percent: (usedTokens / limits.contextWindow) * 100,
    };
    changed = true;
  }
  return changed;
}
