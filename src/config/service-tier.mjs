import { classifyCodexFailure, errorText, normalizeFailure } from "../logging/errors.mjs";

export const FAST_SERVICE_TIER = "fast";
export const STANDARD_SERVICE_TIER = "standard";

function cleanOverride(value) {
  const text = String(value || "").trim();
  return text || "";
}

export function createServiceTierPolicy({ findProvider = () => null } = {}) {
  function displayServiceTier(value) {
    const tier = cleanOverride(value);
    if (!tier) return "";
    if (tier === FAST_SERVICE_TIER || tier === "priority") return "fast";
    if (tier === STANDARD_SERVICE_TIER) return "standard";
    return tier;
  }

  function serviceTierPlanForSettings(settings, options = {}) {
    const serviceTier = cleanOverride(settings?.serviceTier);
    const provider = findProvider(settings?.provider || "");
    const requestedServiceTier = serviceTier;
    const requiresOpenaiAuth = Boolean(provider?.requiresOpenaiAuth);
    const directPassthrough = Boolean(provider?.serviceTierPassthrough);
    const phase = String(options.phase || "turn");
    if (!serviceTier || options.disableServiceTier) {
      return {
        requestedServiceTier,
        serviceTier: "",
        phase,
        policy: options.disableServiceTier ? "disabled" : "none",
        autoFallback: false,
        requiresOpenaiAuth,
        directPassthrough,
      };
    }

    if (requiresOpenaiAuth || directPassthrough) {
      return {
        requestedServiceTier,
        serviceTier,
        phase,
        policy: requiresOpenaiAuth ? "openai-auth" : "direct-passthrough",
        autoFallback: !requiresOpenaiAuth,
        requiresOpenaiAuth,
        directPassthrough,
      };
    }

    if (phase === "thread") {
      return {
        requestedServiceTier,
        serviceTier: "",
        phase,
        policy: "auto-third-party-thread-deferred",
        autoFallback: false,
        requiresOpenaiAuth,
        directPassthrough,
      };
    }

    return {
      requestedServiceTier,
      serviceTier,
      phase,
      policy: "auto-third-party",
      autoFallback: true,
      requiresOpenaiAuth,
      directPassthrough,
    };
  }

  function serviceTierForSettings(settings, options = {}) {
    return serviceTierPlanForSettings(settings, options).serviceTier;
  }

  function shouldRetryWithoutServiceTier(failure, tierPlan, options = {}) {
    if (options.disableServiceTier || options.serviceTierFallbackAttempt) return false;
    if (!tierPlan?.serviceTier || !tierPlan.autoFallback) return false;
    const item = normalizeFailure(failure) || classifyCodexFailure(failure);
    if (["user_stop", "feishu_card", "missing_rollout", "empty_completion", "stream_disconnect"].includes(item.kind)) {
      return false;
    }
    const lower = errorText(item.detail || item.message || failure, "").toLowerCase();
    return item.kind !== "timeout"
      || lower.includes("service_tier")
      || lower.includes("service tier")
      || lower.includes("service-tier")
      || lower.includes("fast")
      || lower.includes("priority");
  }

  function serviceTierFallbackFailure(failure, tierPlan) {
    const item = normalizeFailure(failure) || classifyCodexFailure(failure);
    return {
      ...item,
      kind: "service_tier_fallback",
      label: "service_tier 自动降级",
      recoverable: true,
      message: `Provider 未确认支持 ${displayServiceTier(tierPlan?.serviceTier) || tierPlan?.serviceTier || "service_tier"}，Bridge 正在不带 service_tier 自动重试。`,
      suggestion: "如果重试成功，本轮会直接返回结果；如果仍失败，会显示真实错误。",
    };
  }

  function serviceTierForProviderDetail(provider) {
    if (provider?.requiresOpenaiAuth) return "service_tier 官方鉴权";
    if (provider?.serviceTierPassthrough) return "service_tier 直接透传";
    return "service_tier 自动尝试";
  }

  function serviceTierForThreadSettings(settings, options = {}) {
    return serviceTierForSettings(settings, { ...options, phase: "thread" });
  }

  function serviceTierForTurnSettings(settings, options = {}) {
    return serviceTierForSettings(settings, { ...options, phase: "turn" });
  }

  function serviceTierForExecSettings(settings, options = {}) {
    return serviceTierForSettings(settings, { ...options, phase: "exec" });
  }

  function serviceTierPlanForTurnSettings(settings, options = {}) {
    return serviceTierPlanForSettings(settings, { ...options, phase: "turn" });
  }

  function serviceTierPlanForExecSettings(settings, options = {}) {
    return serviceTierPlanForSettings(settings, { ...options, phase: "exec" });
  }

  return {
    displayServiceTier,
    serviceTierFallbackFailure,
    serviceTierForExecSettings,
    serviceTierForProviderDetail,
    serviceTierForSettings,
    serviceTierForThreadSettings,
    serviceTierForTurnSettings,
    serviceTierPlanForExecSettings,
    serviceTierPlanForSettings,
    serviceTierPlanForTurnSettings,
    shouldRetryWithoutServiceTier,
  };
}
