const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { registerBotWithQr } = require("../src/main/services/feishu-registration.cjs");

function baseOptions(overrides = {}) {
  return {
    dataRoot: path.join("C:\\", "desktop-test-data"),
    workspaceRoot: path.join("C:\\", "desktop-test-workspaces"),
    codexHomeRoot: path.join("C:\\", "desktop-test-codex-homes"),
    defaultCodexHome: path.join("C:\\", "desktop-test-shared-codex"),
    existingNames: [],
    assertProfileAvailable: async () => {},
    ...overrides,
  };
}

test("completes QR registration and reports every lifecycle stage", async () => {
  const progress = [];
  let created = null;
  const options = baseOptions({
    registrationDependencies: {
      registerApp: async ({ onQRCodeReady, onStatusChange }) => {
        await onQRCodeReady({ url: "https://example.test/qr", expireIn: 120 });
        onStatusChange({ status: "authorized" });
        return { client_id: "cli_test123", client_secret: "feishu-secret" };
      },
      QRCode: { toDataURL: async () => "data:image/png;base64,test" },
    },
    createManagedBot: async (bot, credentials) => {
      created = { bot, credentials };
      return { name: bot.name, state: "configured" };
    },
  });
  const result = await registerBotWithQr({ name: "assistant-1", label: "Assistant 1" }, options, (item) => progress.push(item));
  assert.equal(result.name, "assistant-1");
  assert.equal(created.credentials.appSecret, "feishu-secret");
  assert.deepEqual(progress.map((item) => item.stage), ["requesting", "qr-ready", "authorizing", "saving", "complete"]);
  assert.equal(progress[1].qrDataUrl, "data:image/png;base64,test");
});

test("cancels an in-flight QR registration", async () => {
  let cancel = null;
  const options = baseOptions({
    setAbort: (value) => { cancel = value; },
    registrationDependencies: {
      registerApp: ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
      QRCode: { toDataURL: async () => "" },
    },
  });
  const pending = registerBotWithQr({ name: "assistant-1" }, options);
  await new Promise((resolve) => setImmediate(resolve));
  cancel();
  await assert.rejects(() => pending, /已取消或超时/);
  assert.equal(cancel, null);
});

test("times out a QR registration that never completes", async () => {
  const options = baseOptions({
    timeoutMs: 5,
    registrationDependencies: {
      registerApp: ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
      }),
      QRCode: { toDataURL: async () => "" },
    },
  });
  await assert.rejects(() => registerBotWithQr({ name: "assistant-1" }, options), /已取消或超时/);
});

test("rejects an empty QR URL before creating local Bot state", async () => {
  let created = false;
  const options = baseOptions({
    registrationDependencies: {
      registerApp: async ({ onQRCodeReady }) => {
        await onQRCodeReady({ url: "" });
        return { client_id: "cli_test123", client_secret: "secret" };
      },
      QRCode: { toDataURL: async () => "" },
    },
    createManagedBot: async () => { created = true; },
  });
  await assert.rejects(() => registerBotWithQr({ name: "assistant-1" }, options), /空的二维码地址/);
  assert.equal(created, false);
});

test("reports remote success separately from a local save failure", async () => {
  const options = baseOptions({
    registrationDependencies: {
      registerApp: async ({ onQRCodeReady }) => {
        await onQRCodeReady({ url: "https://example.test/qr" });
        return { client_id: "cli_test123", client_secret: "secret" };
      },
      QRCode: { toDataURL: async () => "data:image/png;base64,test" },
    },
    createManagedBot: async () => { throw new Error("disk full"); },
  });
  await assert.rejects(() => registerBotWithQr({ name: "assistant-1" }, options), /飞书应用已创建.*disk full/);
});
