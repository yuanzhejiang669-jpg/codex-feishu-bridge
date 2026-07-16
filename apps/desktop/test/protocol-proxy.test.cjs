const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const test = require("node:test");
const { createProtocolProxyService, providersFileValue, readRegistry } = require("../src/main/services/protocol-proxy.cjs");

test("renders a secret-free generic provider registry", () => {
  const value = providersFileValue({ providers: [{
    id: "qwen", name: "Qwen", upstreamBaseUrl: "https://example.test/v1",
    envKey: "QWEN_API_KEY", defaultModel: "qwen-test",
  }] });
  assert.deepEqual(value.providers[0].models, [{ id: "qwen-test", supportsReasoning: true }]);
  assert.equal(JSON.stringify(value).includes("apiKey"), false);
});

test("prepares a managed Chat provider without exposing its upstream as the Codex endpoint", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-proxy-"));
  try {
    const service = createProtocolProxyService({
      dataRoot: root,
      nodePath: path.join(root, "missing-node.exe"),
      proxyCliPath: path.join(root, "missing-cli.js"),
      readUserEnvironmentVariable: async () => "secret",
    });
    const transaction = await service.prepareProvider({
      id: "qwen", name: "Qwen", baseUrl: "https://example.test/v1", envKey: "QWEN_API_KEY",
    }, "qwen-test");
    assert.equal(transaction.codexProvider.baseUrl, "http://127.0.0.1:18788/v1");
    assert.equal(transaction.codexProvider.wireApi, "responses");
    assert.deepEqual(readRegistry(root).providers, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("decorates only client-managed proxy Providers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-proxy-"));
  try {
    fs.mkdirSync(path.join(root, "protocol-proxy"), { recursive: true });
    fs.writeFileSync(path.join(root, "protocol-proxy", "registry.json"), JSON.stringify({
      port: 18788,
      providers: [{ id: "qwen", upstreamBaseUrl: "https://example.test/v1", defaultModel: "qwen-test" }],
    }));
    const service = createProtocolProxyService({ dataRoot: root, nodePath: "", proxyCliPath: "" });
    const catalog = service.decorateCatalog({ providers: [
      { id: "qwen", baseUrl: "http://127.0.0.1:18788/v1", wireApi: "responses" },
      { id: "native", baseUrl: "https://native.test/v1", wireApi: "responses" },
    ] });
    assert.equal(catalog.providers[0].wireApi, "chat → responses");
    assert.equal(catalog.providers[0].baseUrl, "https://example.test/v1");
    assert.equal(catalog.providers[1].baseUrl, "https://native.test/v1");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("prepares managed proxy removal without changing the registry before commit", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-proxy-"));
  try {
    fs.mkdirSync(path.join(root, "protocol-proxy"), { recursive: true });
    fs.writeFileSync(path.join(root, "protocol-proxy", "registry.json"), JSON.stringify({
      port: 18788,
      providers: [{ id: "qwen", envKey: "QWEN_API_KEY", defaultModel: "qwen-test" }],
    }));
    const service = createProtocolProxyService({ dataRoot: root, nodePath: "", proxyCliPath: "" });
    assert.ok(service.prepareProviderRemoval("qwen"));
    assert.equal(service.prepareProviderRemoval("missing"), null);
    assert.deepEqual(readRegistry(root).providers.map((provider) => provider.id), ["qwen"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("selects another managed port when the default is occupied", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-proxy-"));
  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(18788, "127.0.0.1", resolve);
  });
  try {
    const service = createProtocolProxyService({ dataRoot: root, nodePath: "", proxyCliPath: "" });
    const transaction = await service.prepareProvider({
      id: "qwen", name: "Qwen", baseUrl: "https://example.test/v1", envKey: "QWEN_API_KEY",
    }, "qwen-test");
    assert.equal(transaction.codexProvider.baseUrl, "http://127.0.0.1:18789/v1");
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects ambiguous duplicate model routing across managed providers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-proxy-"));
  try {
    fs.mkdirSync(path.join(root, "protocol-proxy"), { recursive: true });
    fs.writeFileSync(path.join(root, "protocol-proxy", "registry.json"), JSON.stringify({
      port: 18788,
      providers: [{ id: "first", defaultModel: "shared-model" }],
    }));
    const service = createProtocolProxyService({ dataRoot: root, nodePath: "", proxyCliPath: "" });
    await assert.rejects(() => service.prepareProvider({
      id: "second", name: "Second", baseUrl: "https://example.test/v1", envKey: "SECOND_API_KEY",
    }, "shared-model"), /路由到错误上游/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("does not launch after stop cancels a start waiting for credentials", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-proxy-"));
  const cliPath = path.join(root, "proxy-cli.js");
  let releaseCredential;
  const credential = new Promise((resolve) => { releaseCredential = resolve; });
  try {
    fs.writeFileSync(cliPath, "", "utf8");
    fs.mkdirSync(path.join(root, "protocol-proxy"), { recursive: true });
    fs.writeFileSync(path.join(root, "protocol-proxy", "registry.json"), JSON.stringify({
      port: 18788,
      providers: [{ id: "qwen", envKey: "QWEN_API_KEY", defaultModel: "qwen-test" }],
    }));
    const service = createProtocolProxyService({
      dataRoot: root,
      nodePath: process.execPath,
      proxyCliPath: cliPath,
      readUserEnvironmentVariable: async () => credential,
    });
    const starting = service.start();
    await new Promise((resolve) => setImmediate(resolve));
    await service.stop();
    releaseCredential("secret");
    await starting;
    assert.equal(service.snapshot().status, "stopped");
    assert.equal(service.snapshot().processId, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
