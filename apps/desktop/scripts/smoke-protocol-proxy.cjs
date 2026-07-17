const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createProtocolProxyService, readRegistry } = require("../src/main/services/protocol-proxy.cjs");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-proxy-smoke-"));
  let received = null;
  const upstream = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "cfb-smoke-model" }] }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "chatcmpl_smoke",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "cfb-smoke-model",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "PROXY_OK" } }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      }));
    });
  });
  const upstreamPort = await listen(upstream);
  const proxyPort = 18991;
  const registryRoot = path.join(root, "protocol-proxy");
  fs.mkdirSync(registryRoot, { recursive: true });
  fs.writeFileSync(path.join(registryRoot, "registry.json"), JSON.stringify({
    schemaVersion: 1,
    port: proxyPort,
    providers: [{
      id: "smoke", name: "Smoke", upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      envKey: "CFB_SMOKE_API_KEY", defaultModel: "cfb-smoke-model", wireApi: "chat",
    }],
  }));
  const service = createProtocolProxyService({
    dataRoot: root,
    nodePath: process.env.CFB_PROXY_SMOKE_NODE
      || path.join(__dirname, "..", "node_modules", "node", "bin", process.platform === "win32" ? "node.exe" : "node"),
    proxyCliPath: process.env.CFB_PROXY_SMOKE_CLI
      || path.join(__dirname, "..", "proxy-runtime", "node_modules", "mimo2codex", "dist", "cli.js"),
    readUserEnvironmentVariable: async () => "smoke-secret",
  });
  try {
    await service.start();
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer local", "content-type": "application/json" },
      body: JSON.stringify({ model: "cfb-smoke-model", input: "Reply with PROXY_OK only.", stream: false, store: false }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(received.model, "cfb-smoke-model");
    assert.equal(received.messages.at(-1).content.includes("PROXY_OK"), true);
    assert.equal(JSON.stringify(body).includes("PROXY_OK"), true);
    const firstProcessId = service.snapshot().processId;
    process.kill(firstProcessId);
    const recoveryDeadline = Date.now() + 12_000;
    let recovered = false;
    while (Date.now() < recoveryDeadline) {
      const current = service.snapshot();
      if (current.status === "online" && current.processId && current.processId !== firstProcessId) {
        recovered = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(recovered, true, "managed proxy did not recover after an unexpected exit");
    const removal = service.prepareProviderRemoval("smoke");
    assert.ok(removal, "managed proxy removal transaction is missing");
    await removal.commit();
    assert.deepEqual(readRegistry(root).providers, []);
    assert.equal(service.snapshot().status, "unused");
    process.stdout.write(`protocol proxy smoke passed on 127.0.0.1:${proxyPort}\n`);
  } finally {
    await service.stop().catch(() => {});
    await close(upstream);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
