const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { checkBotReadiness, parseJsonOutput } = require("../src/main/services/bot-readiness.cjs");
const { DEFAULT_PERMISSION_POLICY } = require("../src/main/services/permission-policy.cjs");

const completePermissionEntries = [
  ...DEFAULT_PERMISSION_POLICY.tenantScopes.map((scope_name) => ({ scope_name, scope_type: "tenant", grant_status: 1 })),
  ...DEFAULT_PERMISSION_POLICY.userScopes.map((scope_name) => ({ scope_name, scope_type: "user", grant_status: 1 })),
];

function fixture(provider = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-readiness-test-"));
  const botRoot = path.join(root, "managed-bots", "assistant-1");
  fs.mkdirSync(botRoot, { recursive: true });
  fs.writeFileSync(path.join(botRoot, "bot.json"), JSON.stringify({
    schemaVersion: 1,
    name: "assistant-1",
    label: "Assistant 1",
    profile: "assistant-1",
    workspace: path.join(root, "workspace"),
    ...(provider ? { provider } : {}),
  }), "utf8");
  return { root, botRoot };
}

function successfulCli(_tool, args) {
  if (args[0] === "whoami") {
    return Promise.resolve({ stdout: JSON.stringify({ identity: "bot", available: true, tokenStatus: "ready" }) });
  }
  if (args[0] === "auth" && args[1] === "status") {
    return Promise.resolve({ stdout: JSON.stringify({ identities: {
      bot: { available: true, verified: true, appName: "Assistant 1" },
      user: { available: true, verified: true, name: "Test User" },
    } }) });
  }
  if (args[0] === "api") {
    return Promise.resolve({ stdout: JSON.stringify({ ok: true, data: { scopes: completePermissionEntries } }) });
  }
  throw new Error(`unexpected lark-cli call: ${args.join(" ")}`);
}

test("reports a verified offline Bot as ready for real message testing", async () => {
  const value = fixture();
  try {
    const result = await checkBotReadiness("assistant-1", {
      dataRoot: value.root,
      larkCliPath: "lark-cli.exe",
      codexAvailable: true,
      engineAvailable: true,
      currentProvider: { configured: true, id: "openai", requiresOpenaiAuth: true },
      codexLoginState: "signed-in",
      runtimeBots: [{ name: "assistant-1", online: false }],
      runLarkCli: successfulCli,
    });
    assert.equal(result.readyToStart, true);
    assert.equal(result.status, "warn");
    assert.match(result.summary, /可以启动/);
    assert.equal(result.checks.find((item) => item.id === "botIdentity").status, "good");
    assert.equal(result.checks.find((item) => item.id === "userIdentity").status, "good");
    assert.match(result.checks.find((item) => item.id === "appScopes").detail, /41\/41/);
    assert.equal(result.permissionComparison.complete, true);
    assert.equal(result.checks.find((item) => item.id === "messageEvent").status, "warn");
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("marks the required message event verified from managed runtime evidence", async () => {
  const value = fixture();
  try {
    const result = await checkBotReadiness("assistant-1", {
      dataRoot: value.root,
      larkCliPath: "lark-cli.exe",
      codexAvailable: true,
      engineAvailable: true,
      currentProvider: { configured: true, id: "openai", requiresOpenaiAuth: true },
      codexLoginState: "signed-in",
      runtimeBots: [{
        name: "assistant-1",
        online: true,
        messageEventVerified: true,
        messageEventVerifiedAt: "2026-07-15T05:21:56.000Z",
      }],
      runLarkCli: successfulCli,
    });
    assert.equal(result.status, "good");
    assert.equal(result.checks.find((item) => item.id === "messageEvent").status, "good");
    assert.match(result.checks.find((item) => item.id === "messageEvent").detail, /最近验证/);
    assert.match(result.summary, /全部通过/);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("blocks readiness when the Bot identity cannot be verified", async () => {
  const value = fixture();
  try {
    const result = await checkBotReadiness("assistant-1", {
      dataRoot: value.root,
      larkCliPath: "lark-cli.exe",
      codexAvailable: true,
      engineAvailable: true,
      currentProvider: { configured: true, id: "openai", requiresOpenaiAuth: true },
      codexLoginState: "signed-in",
      runtimeBots: [],
      runLarkCli: async () => { throw new Error("invalid app credentials"); },
    });
    assert.equal(result.readyToStart, false);
    assert.equal(result.status, "bad");
    assert.match(result.checks.find((item) => item.id === "botIdentity").detail, /invalid app credentials/);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("blocks a custom Provider Bot when its encrypted secret file is missing", async () => {
  const value = fixture({ mode: "custom", id: "example", model: "gpt-test" });
  try {
    const result = await checkBotReadiness("assistant-1", {
      dataRoot: value.root,
      larkCliPath: "lark-cli.exe",
      codexAvailable: true,
      engineAvailable: true,
      runtimeBots: [],
      runLarkCli: successfulCli,
    });
    assert.equal(result.readyToStart, false);
    assert.equal(result.checks.find((item) => item.id === "provider").status, "bad");
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("parses JSON surrounded by harmless command output", () => {
  assert.deepEqual(parseJsonOutput("notice\n{\"ok\":true}\n"), { ok: true });
});

test("reduces a lark-cli configuration envelope to a readable readiness error", async () => {
  const value = fixture();
  try {
    const result = await checkBotReadiness("assistant-1", {
      dataRoot: value.root,
      larkCliPath: "lark-cli.exe",
      codexAvailable: true,
      engineAvailable: true,
      currentProvider: { configured: true, id: "openai", requiresOpenaiAuth: true },
      codexLoginState: "signed-in",
      runtimeBots: [],
      runLarkCli: async () => {
        throw new Error(JSON.stringify({ ok: false, error: { subtype: "not_configured", message: "not configured" } }));
      },
    });
    assert.match(result.checks.find((item) => item.id === "botIdentity").detail, /Profile 尚未配置/);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("blocks a shared Bot when the current Provider credential is unavailable", async () => {
  const value = fixture();
  try {
    const result = await checkBotReadiness("assistant-1", {
      dataRoot: value.root,
      larkCliPath: "lark-cli.exe",
      codexAvailable: true,
      engineAvailable: true,
      currentProvider: {
        configured: true,
        id: "example",
        thirdParty: true,
        envKey: "EXAMPLE_API_KEY",
        credentialAvailable: false,
      },
      runtimeBots: [],
      runLarkCli: successfulCli,
    });
    assert.equal(result.readyToStart, false);
    assert.match(result.checks.find((item) => item.id === "provider").detail, /EXAMPLE_API_KEY/);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("reports incomplete extended permissions without blocking a working Bot", async () => {
  const value = fixture();
  try {
    const result = await checkBotReadiness("assistant-1", {
      dataRoot: value.root,
      larkCliPath: "lark-cli.exe",
      codexAvailable: true,
      engineAvailable: true,
      currentProvider: { configured: true, id: "openai", requiresOpenaiAuth: true },
      codexLoginState: "signed-in",
      runtimeBots: [],
      runLarkCli: async (tool, args) => {
        if (args[0] === "api") {
          return { stdout: JSON.stringify({ ok: true, data: { scopes: completePermissionEntries.slice(1) } }) };
        }
        return successfulCli(tool, args);
      },
    });
    assert.equal(result.readyToStart, true);
    assert.equal(result.checks.find((item) => item.id === "appScopes").status, "warn");
    assert.equal(result.permissionComparison.missingTenant.length, 1);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("reports a missing user identity as a capability warning", async () => {
  const value = fixture();
  try {
    const result = await checkBotReadiness("assistant-1", {
      dataRoot: value.root,
      larkCliPath: "lark-cli.exe",
      codexAvailable: true,
      engineAvailable: true,
      currentProvider: { configured: true, id: "openai", requiresOpenaiAuth: true },
      codexLoginState: "signed-in",
      runtimeBots: [{ name: "assistant-1", online: true }],
      runLarkCli: async (tool, args) => {
        if (args[0] === "auth") {
          return { stdout: JSON.stringify({ identities: {
            bot: { available: true, verified: true },
            user: { available: false, status: "missing" },
          } }) };
        }
        return successfulCli(tool, args);
      },
    });
    assert.equal(result.readyToStart, true);
    assert.equal(result.checks.find((item) => item.id === "userIdentity").status, "warn");
    assert.equal(result.actions.userIdentityReady, false);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});
