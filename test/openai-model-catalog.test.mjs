import assert from "node:assert/strict";
import test from "node:test";
import { fetchOpenaiModelCatalog } from "../src/providers/openai-model-catalog.mjs";

const credentials = { accessToken: "selected-account-token", chatgptAccountId: "selected-account-id" };
const model = (slug) => ({ slug, display_name: slug, visibility: "list" });

test("official catalog requests are fresh, account scoped and retain new models and their capabilities", async () => {
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    assert.equal(url, "https://chatgpt.com/backend-api/codex/models?client_version=0.164.0");
    assert.equal(options.headers.Authorization, "Bearer selected-account-token");
    assert.equal(options.headers["ChatGPT-Account-ID"], "selected-account-id");
    assert.equal(options.headers["Cache-Control"], "no-cache");
    assert.equal(options.redirect, "error");
    return Response.json({ models: [
      { ...model(`new-model-${calls}`), supported_reasoning_levels: [{ effort: "max" }], service_tiers: [{ id: "priority" }] },
      { ...model("internal-model"), visibility: "hide" },
    ] });
  };
  const args = { tokens: credentials, clientVersion: "0.164.0-preview", fetchImpl };
  const first = await fetchOpenaiModelCatalog(args);
  const second = await fetchOpenaiModelCatalog(args);
  assert.equal(calls, 2);
  assert.deepEqual(first.models.map((m) => m.id), ["new-model-1"]);
  assert.deepEqual(second.models.map((m) => m.id), ["new-model-2"]);
  assert.equal(second.models[0].supportedReasoningEfforts[0].reasoningEffort, "max");
  assert.equal(second.models[0].serviceTiers[0].id, "priority");
  assert.ok(Number.isFinite(Date.parse(second.checkedAt)));
});

test("official catalog does not truncate large account catalogs or reintroduce duplicates", async () => {
  const models = Array.from({ length: 135 }, (_, i) => model(`model-${i}`));
  const result = await fetchOpenaiModelCatalog({ tokens: credentials, clientVersion: "0.164.0", fetchImpl: async () => Response.json({ models: [...models, models[0]] }) });
  assert.equal(result.models.length, 135);
  assert.equal(result.models.at(-1).id, "model-134");
});

test("official catalog fails closed instead of displaying a cached or wrong account catalog", async () => {
  for (const status of [401, 403, 503]) {
    await assert.rejects(fetchOpenaiModelCatalog({ tokens: credentials, clientVersion: "0.164.0", fetchImpl: async () => new Response("unavailable", { status }) }), new RegExp(`HTTP ${status}`));
  }
  await assert.rejects(fetchOpenaiModelCatalog({ tokens: credentials, clientVersion: "0.164.0", fetchImpl: async () => Response.json({ unexpected: [] }) }), /格式无效/);
  await assert.rejects(fetchOpenaiModelCatalog({ tokens: null, clientVersion: "0.164.0" }), /有效登录/);
});

test("official catalog times out without falling back to an old result", async () => {
  const fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  await assert.rejects(fetchOpenaiModelCatalog({ tokens: credentials, clientVersion: "0.164.0", timeoutMs: 10, fetchImpl }), /查询超时/);
});
