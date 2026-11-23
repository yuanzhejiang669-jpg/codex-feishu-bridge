const assert = require("node:assert/strict");
const test = require("node:test");
const {
  DEFAULT_PERMISSION_POLICY,
  FULL_PERMISSION_POLICY,
  RECOMMENDED_PERMISSION_POLICY,
  comparePermissionPolicy,
  loadPermissionPolicy,
  permissionImportJson,
  permissionImportPayload,
  publicPermissionPolicy,
} = require("../src/main/services/permission-policy.cjs");

function completeEntries() {
  return [
    ...FULL_PERMISSION_POLICY.tenantScopes.map((scope_name) => ({ scope_name, scope_type: "tenant", grant_status: 1 })),
    ...FULL_PERMISSION_POLICY.userScopes.map((scope_name) => ({ scope_name, scope_type: "user", grant_status: 1 })),
  ];
}

function recommendedEntries() {
  return [
    ...DEFAULT_PERMISSION_POLICY.tenantScopes.map((scope_name) => ({ scope_name, scope_type: "tenant", grant_status: 1 })),
    ...DEFAULT_PERMISSION_POLICY.userScopes.map((scope_name) => ({ scope_name, scope_type: "user", grant_status: 1 })),
  ];
}

test("ships a recommended default policy and retains the full advanced policy", () => {
  const summary = publicPermissionPolicy();
  assert.equal(summary.policyId, "bridge-lark-common-v1");
  assert.equal(summary.tenantScopeCount, 9);
  assert.equal(summary.userScopeCount, 32);
  assert.equal(summary.totalScopeCount, 41);
  assert.deepEqual(summary.eventKeys, ["im.message.receive_v1"]);
  const fullSummary = publicPermissionPolicy(FULL_PERMISSION_POLICY);
  assert.equal(fullSummary.totalScopeCount, 1658);
  assert.equal(RECOMMENDED_PERMISSION_POLICY, DEFAULT_PERMISSION_POLICY);
  for (const name of [...FULL_PERMISSION_POLICY.tenantScopes, ...FULL_PERMISSION_POLICY.userScopes]) {
    assert.ok(name.length < 180, `scope name is unexpectedly long: ${name.slice(0, 80)}`);
    assert.doesNotMatch(name, /truncated|…/i);
  }
});

test("accepts every permission in the recommended policy and ignores duplicates", () => {
  const entries = recommendedEntries();
  entries.push(entries[0]);
  const result = comparePermissionPolicy({ data: { scopes: entries } });
  assert.equal(result.complete, true);
  assert.equal(result.grantedTotal, 41);
  assert.deepEqual(result.missingTenant, []);
  assert.deepEqual(result.missingUser, []);
});

test("reports tenant and user permission gaps separately", () => {
  const entries = recommendedEntries();
  const missingTenant = DEFAULT_PERMISSION_POLICY.tenantScopes[0];
  const missingUser = DEFAULT_PERMISSION_POLICY.userScopes[0];
  const result = comparePermissionPolicy(entries.filter((entry) => (
    !(entry.scope_type === "tenant" && entry.scope_name === missingTenant)
    && !(entry.scope_type === "user" && entry.scope_name === missingUser)
  )));
  assert.equal(result.complete, false);
  assert.deepEqual(result.missingTenant, [missingTenant]);
  assert.deepEqual(result.missingUser, [missingUser]);
});

test("rejects an empty or malformed embedded policy", () => {
  assert.throws(() => loadPermissionPolicy({ schemaVersion: 1, policyId: "test" }), /不能为空/);
  assert.throws(() => loadPermissionPolicy({ schemaVersion: 2, policyId: "test", tenantScopes: ["a"], userScopes: ["b"], eventKeys: ["c"] }), /格式无效/);
});

test("builds the exact recommended Feishu batch-import payload without events or secrets", () => {
  const payload = permissionImportPayload();
  assert.equal(payload.scopes.tenant.length, 9);
  assert.equal(payload.scopes.user.length, 32);
  assert.deepEqual(payload.scopes.tenant, [...DEFAULT_PERMISSION_POLICY.tenantScopes]);
  assert.deepEqual(payload.scopes.user, [...DEFAULT_PERMISSION_POLICY.userScopes]);
  assert.deepEqual(Object.keys(JSON.parse(permissionImportJson())), ["scopes"]);
});

test("recommended permissions stay inside the verified snapshot and exclude sensitive business domains", () => {
  const fullTenant = new Set(FULL_PERMISSION_POLICY.tenantScopes);
  const fullUser = new Set(FULL_PERMISSION_POLICY.userScopes);
  for (const scope of DEFAULT_PERMISSION_POLICY.tenantScopes) assert.equal(fullTenant.has(scope), true, scope);
  for (const scope of DEFAULT_PERMISSION_POLICY.userScopes) assert.equal(fullUser.has(scope), true, scope);
  const sensitivePrefix = /^(?:acs|admin|approval|attendance|contact|corehr|hire|mail|minutes|payroll|vc):/;
  for (const scope of [...DEFAULT_PERMISSION_POLICY.tenantScopes, ...DEFAULT_PERMISSION_POLICY.userScopes]) {
    assert.doesNotMatch(scope, sensitivePrefix);
  }
});
