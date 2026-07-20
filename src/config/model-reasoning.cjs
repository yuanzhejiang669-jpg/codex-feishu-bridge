const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_REGISTRY_PATH = path.resolve(__dirname, "..", "..", "config", "model-reasoning-capabilities.json");
let cachedRegistry = null;

function validateRegistry(registry) {
  if (!registry || registry.schemaVersion !== 1) throw new Error("Unsupported model reasoning registry schema");
  if (!Number.isInteger(registry.reviewAfterDays) || registry.reviewAfterDays < 1) throw new Error("Model reasoning registry review interval is invalid");
  if (!Array.isArray(registry.canonicalEfforts) || !registry.canonicalEfforts.length) throw new Error("Model reasoning registry has no canonical efforts");
  const efforts = new Set(registry.canonicalEfforts);
  if (!efforts.has(registry.defaultRequestedEffort)) throw new Error("Model reasoning registry default is invalid");
  const ids = new Set();
  for (const entry of registry.entries || []) {
    if (!entry.id || ids.has(entry.id)) throw new Error(`Duplicate or empty model reasoning capability id: ${entry.id || ""}`);
    ids.add(entry.id);
    if (!Array.isArray(entry.modelPatterns) || !entry.modelPatterns.length) throw new Error(`Capability ${entry.id} has no model pattern`);
    if (!efforts.has(entry.defaultRequestedEffort) || !efforts.has(entry.maximumEffort)) throw new Error(`Capability ${entry.id} has an invalid default or maximum`);
    for (const effort of efforts) {
      if (!Object.prototype.hasOwnProperty.call(entry.mapping || {}, effort)) throw new Error(`Capability ${entry.id} does not map ${effort}`);
      const mapped = entry.mapping[effort];
      if (mapped !== null && !efforts.has(mapped)) throw new Error(`Capability ${entry.id} maps ${effort} to an invalid effort`);
    }
    for (const effort of entry.selectableEfforts || []) {
      if (!efforts.has(effort) || entry.mapping[effort] === null) throw new Error(`Capability ${entry.id} has an invalid selectable effort`);
    }
    if (!/^https:\/\//.test(entry.sourceUrl || "")) throw new Error(`Capability ${entry.id} has an invalid source URL`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.verifiedAt || "")) throw new Error(`Capability ${entry.id} has an invalid verification date`);
    if (entry.verificationNote !== undefined && typeof entry.verificationNote !== "string") throw new Error(`Capability ${entry.id} has an invalid verification note`);
  }
  return registry;
}

function loadRegistry(registryPath = DEFAULT_REGISTRY_PATH) {
  if (registryPath === DEFAULT_REGISTRY_PATH && cachedRegistry) return cachedRegistry;
  const registry = validateRegistry(JSON.parse(fs.readFileSync(registryPath, "utf8").replace(/^\uFEFF/, "")));
  if (registryPath === DEFAULT_REGISTRY_PATH) cachedRegistry = registry;
  return registry;
}

function globMatches(value, pattern) {
  const escaped = String(pattern || "").replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(String(value || ""));
}

function resolveCapability({ provider = "", model = "" } = {}, registry = loadRegistry()) {
  const modelValue = String(model || "").trim();
  const providerValue = String(provider || "").trim();
  const entries = registry.entries || [];
  const entry = entries.find((item) => item.modelPatterns.some((pattern) => globMatches(modelValue, pattern))
    && (!item.providerPatterns.length || item.providerPatterns.some((pattern) => globMatches(providerValue, pattern)) || !providerValue))
    || entries.find((item) => item.modelPatterns.some((pattern) => globMatches(modelValue, pattern)));
  if (entry) return { ...entry, known: true, registryVersion: registry.registryVersion };
  const identity = Object.fromEntries(registry.canonicalEfforts.map((effort) => [effort, effort]));
  return { id: "generic", name: "Generic / unverified", known: false, registryVersion: registry.registryVersion,
    providerPatterns: [], modelPatterns: [], selectableEfforts: [...registry.canonicalEfforts],
    defaultRequestedEffort: registry.defaultRequestedEffort, maximumEffort: "max", controlKind: "generic",
    mapping: identity, upstreamValues: identity, sourceUrl: "", verifiedAt: "" };
}

function mapReasoningEffort({ provider = "", model = "", effort = "" } = {}, registry = loadRegistry()) {
  const capability = resolveCapability({ provider, model }, registry);
  const requestedEffort = String(effort || capability.defaultRequestedEffort || registry.defaultRequestedEffort).trim().toLowerCase();
  if (!registry.canonicalEfforts.includes(requestedEffort)) return { supported: false, requestedEffort, effectiveEffort: "", upstreamValue: "", capability, reason: "unknown_effort" };
  const effectiveEffort = capability.mapping[requestedEffort];
  if (effectiveEffort === null || effectiveEffort === undefined) return { supported: false, requestedEffort, effectiveEffort: "", upstreamValue: "", capability, reason: "unsupported_for_model" };
  return { supported: true, requestedEffort, effectiveEffort,
    upstreamValue: capability.upstreamValues[effectiveEffort] || effectiveEffort,
    mapped: effectiveEffort !== requestedEffort, capability, reason: effectiveEffort !== requestedEffort ? "model_mapping" : "direct" };
}

function acceptedEfforts(capability, registry = loadRegistry()) {
  return registry.canonicalEfforts.filter((effort) => capability?.mapping?.[effort] !== null && capability?.mapping?.[effort] !== undefined);
}

function capabilityMappings({ provider = "", model = "" } = {}, registry = loadRegistry()) {
  return registry.canonicalEfforts.map((effort) => mapReasoningEffort({ provider, model, effort }, registry));
}

function capabilityMappingLines({ provider = "", model = "", currentEffort = "" } = {}, registry = loadRegistry()) {
  return capabilityMappings({ provider, model }, registry).map((item) => {
    const result = item.supported
      ? `\`${item.effectiveEffort}\` → \`${item.upstreamValue}\``
      : "不支持";
    const current = item.requestedEffort === currentEffort ? " ← 当前" : "";
    return `- \`${item.requestedEffort}\` → ${result}${current}`;
  });
}

function capabilityOutcomeLines({ provider = "", model = "", currentEffort = "" } = {}, registry = loadRegistry()) {
  return capabilityMappings({ provider, model }, registry).map((item) => {
    const outcome = item.supported ? `\`${item.upstreamValue}\`` : "不支持";
    const current = item.requestedEffort === currentEffort ? " ← 当前" : "";
    return `- \`${item.requestedEffort}\` → ${outcome}${current}`;
  });
}

function reviewStatus(capability, registry = loadRegistry(), now = Date.now()) {
  if (!capability?.known || !capability.verifiedAt) return { stale: false, reviewDueAt: "" };
  const verifiedAt = Date.parse(`${capability.verifiedAt}T00:00:00Z`);
  const reviewDue = verifiedAt + registry.reviewAfterDays * 24 * 60 * 60 * 1000;
  return { stale: Number.isFinite(reviewDue) && now >= reviewDue, reviewDueAt: new Date(reviewDue).toISOString().slice(0, 10) };
}

function publicRegistry(registry = loadRegistry()) { return JSON.parse(JSON.stringify(registry)); }

module.exports = { DEFAULT_REGISTRY_PATH, acceptedEfforts, capabilityMappingLines, capabilityMappings, capabilityOutcomeLines, globMatches, loadRegistry, mapReasoningEffort, publicRegistry, resolveCapability, reviewStatus, validateRegistry };
