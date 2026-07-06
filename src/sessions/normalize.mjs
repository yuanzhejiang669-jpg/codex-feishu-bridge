export function normalizeGoal(value) {
  if (!value || typeof value !== "object") return null;
  const objective = String(value.objective || "").trim();
  if (!objective) return null;
  const status = String(value.status || "active");
  return {
    threadId: String(value.threadId || ""),
    objective,
    status,
    tokenBudget: Number.isFinite(Number(value.tokenBudget)) ? Number(value.tokenBudget) : null,
    tokensUsed: Number(value.tokensUsed) || 0,
    timeUsedSeconds: Number(value.timeUsedSeconds) || 0,
    createdAt: normalizeTimestamp(value.createdAt),
    updatedAt: normalizeTimestamp(value.updatedAt) || Date.now(),
  };
}

export function normalizeTimestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number < 10_000_000_000 ? number * 1000 : number;
}

export function normalizeTokenUsage(value) {
  if (!value || typeof value !== "object") return null;
  const total = normalizeTokenUsageBreakdown(value.total);
  const last = normalizeTokenUsageBreakdown(value.last);
  const modelContextWindow = Number(value.modelContextWindow);
  return {
    total,
    last,
    modelContextWindow: Number.isFinite(modelContextWindow) && modelContextWindow > 0 ? modelContextWindow : null,
  };
}

export function normalizeTokenUsageBreakdown(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    totalTokens: Number(source.totalTokens) || 0,
    inputTokens: Number(source.inputTokens) || 0,
    cachedInputTokens: Number(source.cachedInputTokens) || 0,
    outputTokens: Number(source.outputTokens) || 0,
    reasoningOutputTokens: Number(source.reasoningOutputTokens) || 0,
  };
}

export function normalizeContextUsage(value) {
  if (!value || typeof value !== "object") return null;
  const usedTokens = Number(value.usedTokens);
  const contextWindow = Number(value.contextWindow);
  const percent = Number(value.percent);
  if (!Number.isFinite(usedTokens) && !Number.isFinite(contextWindow) && !Number.isFinite(percent)) return null;
  return {
    usedTokens: Number.isFinite(usedTokens) ? usedTokens : null,
    contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null,
    percent: Number.isFinite(percent) ? percent : null,
    updatedAt: Number(value.updatedAt) || Date.now(),
  };
}

export function contextUsageFromTokenUsage(value) {
  const usage = normalizeTokenUsage(value);
  if (!usage) return null;
  const last = usage.last || {};
  const contextWindow = Number(usage.modelContextWindow) || 0;
  const rawUsedTokens = Number(last.totalTokens) || Number(last.inputTokens) + Number(last.outputTokens) || 0;
  const usedTokens = contextWindow > 0 ? Math.min(rawUsedTokens, contextWindow) : rawUsedTokens;
  const percent = contextWindow > 0 ? Math.round((usedTokens / contextWindow) * 1000) / 10 : null;
  return normalizeContextUsage({
    usedTokens,
    contextWindow: contextWindow || null,
    percent,
    updatedAt: Date.now(),
  });
}

export function maxContextUsage(current, candidate) {
  const currentUsage = normalizeContextUsage(current);
  const candidateUsage = normalizeContextUsage(candidate);
  if (!candidateUsage) return currentUsage;
  if (!currentUsage) return candidateUsage;

  const currentScore = Number.isFinite(Number(currentUsage.percent))
    ? Number(currentUsage.percent)
    : Number(currentUsage.usedTokens) || 0;
  const candidateScore = Number.isFinite(Number(candidateUsage.percent))
    ? Number(candidateUsage.percent)
    : Number(candidateUsage.usedTokens) || 0;
  return candidateScore >= currentScore ? candidateUsage : currentUsage;
}
