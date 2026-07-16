const policyJson = require("./permission-policy.json");
const recommendedPolicyJson = require("./recommended-permission-policy.json");

function uniqueSorted(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))].sort();
}

function loadPermissionPolicy(raw = policyJson) {
  const schemaVersion = Number(raw?.schemaVersion || 0);
  const policyId = String(raw?.policyId || "").trim();
  const tenantScopes = uniqueSorted(raw?.tenantScopes);
  const userScopes = uniqueSorted(raw?.userScopes);
  const eventKeys = uniqueSorted(raw?.eventKeys);
  if (schemaVersion !== 1 || !policyId) throw new Error("内置飞书权限策略格式无效");
  if (!tenantScopes.length || !userScopes.length || !eventKeys.length) {
    throw new Error("内置飞书权限策略不能为空");
  }
  return Object.freeze({
    schemaVersion,
    policyId,
    sourceProfile: String(raw?.sourceProfile || "").trim(),
    capturedAt: String(raw?.capturedAt || "").trim(),
    tenantScopes: Object.freeze(tenantScopes),
    userScopes: Object.freeze(userScopes),
    eventKeys: Object.freeze(eventKeys),
    totalScopes: tenantScopes.length + userScopes.length,
  });
}

const FULL_PERMISSION_POLICY = loadPermissionPolicy();
const RECOMMENDED_PERMISSION_POLICY = loadPermissionPolicy(recommendedPolicyJson);
const DEFAULT_PERMISSION_POLICY = RECOMMENDED_PERMISSION_POLICY;

function scopeEntries(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.scopes)) return value.scopes;
  if (Array.isArray(value?.data?.scopes)) return value.data.scopes;
  return [];
}

function comparePermissionPolicy(value, policy = DEFAULT_PERMISSION_POLICY) {
  const tenantGranted = new Set();
  const userGranted = new Set();
  for (const entry of scopeEntries(value)) {
    if (Number(entry?.grant_status) !== 1) continue;
    const name = String(entry?.scope_name || "").trim();
    if (!name) continue;
    if (entry?.scope_type === "tenant") tenantGranted.add(name);
    if (entry?.scope_type === "user") userGranted.add(name);
  }
  const missingTenant = policy.tenantScopes.filter((name) => !tenantGranted.has(name));
  const missingUser = policy.userScopes.filter((name) => !userGranted.has(name));
  return {
    policyId: policy.policyId,
    expectedTenant: policy.tenantScopes.length,
    expectedUser: policy.userScopes.length,
    expectedTotal: policy.totalScopes,
    grantedTenant: policy.tenantScopes.length - missingTenant.length,
    grantedUser: policy.userScopes.length - missingUser.length,
    grantedTotal: policy.totalScopes - missingTenant.length - missingUser.length,
    missingTenant,
    missingUser,
    complete: missingTenant.length === 0 && missingUser.length === 0,
  };
}

function publicPermissionPolicy(policy = DEFAULT_PERMISSION_POLICY) {
  return {
    schemaVersion: policy.schemaVersion,
    policyId: policy.policyId,
    capturedAt: policy.capturedAt,
    tenantScopeCount: policy.tenantScopes.length,
    userScopeCount: policy.userScopes.length,
    totalScopeCount: policy.totalScopes,
    eventKeys: [...policy.eventKeys],
  };
}

function permissionImportPayload(policy = DEFAULT_PERMISSION_POLICY) {
  return {
    scopes: {
      tenant: [...policy.tenantScopes],
      user: [...policy.userScopes],
    },
  };
}

function permissionImportJson(policy = DEFAULT_PERMISSION_POLICY) {
  return `${JSON.stringify(permissionImportPayload(policy), null, 2)}\n`;
}

module.exports = {
  DEFAULT_PERMISSION_POLICY,
  FULL_PERMISSION_POLICY,
  RECOMMENDED_PERMISSION_POLICY,
  comparePermissionPolicy,
  loadPermissionPolicy,
  permissionImportJson,
  permissionImportPayload,
  publicPermissionPolicy,
};
