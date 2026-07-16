const assert = require("node:assert/strict");
const test = require("node:test");
const { assessCompatibility, majorVersion } = require("../src/main/services/compatibility.cjs");

function healthyState() {
  return {
    app: { version: "0.1.2" },
    engine: {
      protocolVersion: 1,
      nodeVersion: "24.18.0",
      larkCliVersion: "1.0.69",
      sourceCommit: "abc123",
    },
    codex: {
      runtimeFound: true,
      cliVersion: "0.144.2",
      packageVersion: "26.707.8479.0",
      loginState: "signed-out",
    },
    provider: {
      configured: true,
      thirdParty: true,
      id: "example",
      model: "gpt-test",
      credentialAvailable: true,
      requiresOpenaiAuth: false,
    },
    setup: {
      dataRoot: "C:\\Users\\Test\\AppData\\Local\\CodexFeishuBridgeDesktop",
      runtimeLocalAppData: "C:\\Users\\Test\\AppData\\Local\\CodexFeishuBridgeDesktop\\runtime-localappdata",
      dataSchema: { status: "ready", currentVersion: 1, supportedVersion: 1 },
    },
  };
}

test("parses major versions with or without a v prefix", () => {
  assert.equal(majorVersion("v24.18.0"), 24);
  assert.equal(majorVersion("1.0.69"), 1);
  assert.equal(majorVersion(""), null);
});

test("reports a healthy third-party Provider stack as compatible", () => {
  const result = assessCompatibility(healthyState());
  assert.equal(result.status, "good");
  assert.equal(result.items.every((item) => item.status === "good"), true);
  assert.equal(result.versions.app, "0.1.2");
});

test("reports unsupported protocol and unisolated runtime as incompatible", () => {
  const state = healthyState();
  state.engine.protocolVersion = 99;
  state.setup.runtimeLocalAppData = "C:\\Users\\Test\\AppData\\Local";
  const result = assessCompatibility(state);
  assert.equal(result.status, "bad");
  assert.equal(result.items.find((item) => item.id === "engine-protocol").status, "bad");
  assert.equal(result.items.find((item) => item.id === "runtime-isolation").status, "bad");
});

test("treats missing Provider credentials as a warning", () => {
  const state = healthyState();
  state.provider.credentialAvailable = false;
  const result = assessCompatibility(state);
  assert.equal(result.status, "warn");
  assert.equal(result.items.find((item) => item.id === "provider").status, "warn");
});
