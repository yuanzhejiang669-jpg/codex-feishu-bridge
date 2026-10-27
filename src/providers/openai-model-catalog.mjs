const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";

// A model/list RPC can return the binary's bundled catalog, especially when the
// app-server's global provider differs from the conversation's selected one.
// Read the selected ChatGPT account's catalog directly; never silently fall back.
export async function fetchOpenaiModelCatalog({
  tokens,
  clientVersion,
  timeoutMs = 30_000,
  fetchImpl = fetch,
} = {}) {
  if (!tokens?.accessToken || !tokens?.chatgptAccountId) {
    throw new Error("当前 OpenAI 账号没有有效登录；请重新登录该账号。");
  }
  const version = String(clientVersion || "").match(/^\d+\.\d+\.\d+/)?.[0];
  if (!version) throw new Error("无法确认 Codex CLI 版本，未查询模型目录。");
  const url = new URL(CODEX_MODELS_URL);
  url.searchParams.set("client_version", version);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${tokens.accessToken}`,
        "ChatGPT-Account-ID": tokens.chatgptAccountId,
        "Cache-Control": "no-cache",
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`OpenAI 当前账号模型目录查询失败：HTTP ${response.status}；未使用缓存或其他账号。`);
    }
    const body = await response.json();
    if (!Array.isArray(body?.models)) throw new Error("OpenAI 模型目录格式无效，未使用缓存。");
    return {
      source: "openai-account",
      url: url.toString(),
      checkedAt: new Date().toISOString(),
      models: normalizeOpenaiModelCatalog(body.models),
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`OpenAI 当前账号模型目录查询超时（${Math.round(timeoutMs / 1000)} 秒）；未使用缓存。`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeOpenaiModelCatalog(data) {
  const models = [];
  const seen = new Set();
  for (const item of data) {
    const id = String(item?.slug || "").trim();
    if (!id || seen.has(id) || item.visibility !== "list") continue;
    seen.add(id);
    models.push({
      id,
      displayName: String(item.display_name || id),
      defaultReasoningEffort: item.default_reasoning_level || "",
      supportedReasoningEfforts: (item.supported_reasoning_levels || []).map((level) => ({
        reasoningEffort: level.effort,
        description: level.description || "",
      })),
      serviceTiers: Array.isArray(item.service_tiers) ? item.service_tiers : [],
    });
  }
  return models;
}
