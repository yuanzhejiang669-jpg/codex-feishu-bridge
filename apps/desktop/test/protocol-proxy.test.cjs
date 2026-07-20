const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const test = require("node:test");
const { createProtocolProxyService, providersFileValue, readRegistry } = require("../src/main/services/protocol-proxy.cjs");

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

test("renders a secret-free generic provider registry", () => {
  const value = providersFileValue({ providers: [{
    id: "qwen", name: "Qwen", upstreamBaseUrl: "https://example.test/v1",
    envKey: "QWEN_API_KEY", defaultModel: "qwen-test",
  }] });
  assert.deepEqual(value.providers[0].models, [{ id: "qwen-test", supportsReasoning: true, supportsImages: false }]);
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
      defaultPort: 28788,
    });
    const transaction = await service.prepareProvider({
      id: "qwen", name: "Qwen", baseUrl: "https://example.test/v1", envKey: "QWEN_API_KEY",
    }, "qwen-test");
    assert.equal(transaction.codexProvider.baseUrl, "http://127.0.0.1:28788/v1");
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
    assert.equal(catalog.providers[0].wireApi, "chat -> responses");
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

test("selects another managed port when the configured default is occupied", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-proxy-"));
  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(28788, "127.0.0.1", resolve);
  });
  try {
    const service = createProtocolProxyService({ dataRoot: root, nodePath: "", proxyCliPath: "", defaultPort: 28788 });
    const transaction = await service.prepareProvider({
      id: "qwen", name: "Qwen", baseUrl: "https://example.test/v1", envKey: "QWEN_API_KEY",
    }, "qwen-test");
    assert.equal(transaction.codexProvider.baseUrl, "http://127.0.0.1:28789/v1");
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("isolates duplicate model ids behind different managed Provider ports", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-proxy-"));
  try {
    fs.mkdirSync(path.join(root, "protocol-proxy"), { recursive: true });
    fs.writeFileSync(path.join(root, "protocol-proxy", "registry.json"), JSON.stringify({
      providers: [{ id: "first", port: 28788, defaultModel: "shared-model" }],
    }));
    const service = createProtocolProxyService({ dataRoot: root, nodePath: "", proxyCliPath: "", defaultPort: 28788 });
    const transaction = await service.prepareProvider({
      id: "second", name: "Second", baseUrl: "https://example.test/v1", envKey: "SECOND_API_KEY",
    }, "shared-model", [{ id: "shared-model" }]);
    assert.equal(transaction.codexProvider.baseUrl, "http://127.0.0.1:28789/v1");
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
      providers: [{ id: "qwen", port: 28790, upstreamBaseUrl: "https://example.test/v1", envKey: "QWEN_API_KEY", defaultModel: "qwen-test" }],
    }));
    const service = createProtocolProxyService({
      dataRoot: root,
      nodePath: process.execPath,
      proxyCliPath: cliPath,
      readUserEnvironmentVariable: async () => credential,
      defaultPort: 28790,
      defaultInnerPort: 29790,
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

test("refreshes a managed Provider model catalog live and preserves the requested model", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-proxy-live-"));
  let models = ["model-a"];
  const requestedModels = [];
  const upstreamRequests = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      const body = JSON.stringify({ object: "list", data: models.map((id) => ({ id, owned_by: "test" })) });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requestedModels.push(request.model);
      upstreamRequests.push(request);
      const body = JSON.stringify({
        id: "chat_test",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    res.writeHead(404).end();
  });
  const upstreamPort = await listen(upstream);
  const gatewayProbe = net.createServer();
  const gatewayPort = await listen(gatewayProbe);
  await close(gatewayProbe);
  const innerProbe = net.createServer();
  const innerPort = await listen(innerProbe);
  await close(innerProbe);
  fs.mkdirSync(path.join(root, "protocol-proxy"), { recursive: true });
  fs.writeFileSync(path.join(root, "protocol-proxy", "registry.json"), JSON.stringify({
    schemaVersion: 2,
    providers: [{
      id: "dynamic",
      name: "Dynamic",
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      envKey: "DYNAMIC_API_KEY",
      defaultModel: "model-a",
      port: gatewayPort,
      models: [{ id: "model-a" }],
    }],
  }));
  const service = createProtocolProxyService({
    dataRoot: root,
    nodePath: process.execPath,
    proxyCliPath: path.resolve(__dirname, "..", "proxy-runtime", "node_modules", "mimo2codex", "dist", "cli.js"),
    readUserEnvironmentVariable: async () => "secret",
    defaultInnerPort: innerPort,
    resolveModelCapabilities: ({ model }) => ({ supportsReasoning: true, supportsVision: model === "model-b" }),
  });
  try {
    await service.start();
    let response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`);
    assert.deepEqual((await response.json()).data.map((item) => item.id), ["model-a"]);
    models = ["model-a", "model-b"];
    response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`);
    assert.deepEqual((await response.json()).data.map((item) => item.id), ["model-a", "model-b"]);
    assert.deepEqual(readRegistry(root).providers[0].models.map((item) => item.id), ["model-a", "model-b"]);
    const runtimeCatalog = JSON.parse(fs.readFileSync(path.join(
      root, "protocol-proxy", "providers", "dynamic", "providers.json",
    ), "utf8"));
    assert.equal(runtimeCatalog.providers[0].models.find((item) => item.id === "model-b").supportsImages, true);
    response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer ignored" },
      body: JSON.stringify({
        model: "model-b",
        input: "Reply OK",
        reasoning: { effort: "minimal" },
        max_output_tokens: 8,
        stream: false,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).model, "model-b");
    response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer ignored" },
      body: JSON.stringify({
        model: "model-b",
        input: [{
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Describe the image" },
            { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" },
          ],
        }],
        max_output_tokens: 8,
        stream: false,
      }),
    });
    assert.equal(response.status, 200);
    await response.json();
    assert.deepEqual(requestedModels, ["model-b", "model-b"]);
    assert.equal(upstreamRequests[0].reasoning_effort, "minimal");
    assert.match(JSON.stringify(upstreamRequests[1]), /data:image\/png;base64,/);
  } finally {
    await service.stop();
    await close(upstream);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
