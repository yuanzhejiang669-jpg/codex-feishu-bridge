import { createServer } from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = path.join(root, "src", "server.mjs");

async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function startRpc(extensionPort) {
  const child = spawn(process.execPath, [server], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      BROWSER_CONTROL_EXTENSION_PORT: String(extensionPort),
      BROWSER_CONTROL_EXTENSION_TOKEN: "e2e-test-token",
      BROWSER_CONTROL_EXTENSION_BRIDGE: "0",
    },
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  let nextId = 1;

  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  function request(method, params) {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, 30000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  async function tool(name, args = {}) {
    const result = await request("tools/call", { name, arguments: args });
    if (result.isError) throw new Error(result.content?.[0]?.text || `${name} failed`);
    return JSON.parse(result.content[0].text);
  }

  return { child, request, tool };
}

const browserPort = await freePort();
const extensionPort = await freePort();
const rpc = startRpc(extensionPort);
let stopped = false;

try {
  await rpc.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "browser-e2e-test", version: "0.1.0" },
  });

  await rpc.tool("browser_start", {
    port: browserPort,
    headless: true,
    url: "about:blank",
    timeoutMs: 20000,
  });

  const html = [
    "<!doctype html>",
    "<title>Codex Browser E2E</title>",
    "<label>Name <input id='name'></label>",
    "<button id='go' onclick=\"document.body.dataset.clicked='yes'\">Go</button>",
  ].join("");
  const opened = await rpc.tool("browser_open", {
    port: browserPort,
    url: `data:text/html,${encodeURIComponent(html)}`,
    timeoutMs: 10000,
  });

  const baseline = await rpc.tool("browser_snapshot", {
    port: browserPort,
    tabId: opened.tabId,
    incremental: true,
    resetCache: true,
  });
  if (!baseline.baseline || !baseline.snapshot?.elements?.length) {
    throw new Error("incremental browser_snapshot did not return an initial baseline");
  }

  const workflow = await rpc.tool("browser_workflow", {
    defaults: { port: browserPort, tabId: opened.tabId },
    steps: [
      { tool: "browser_type", args: { selector: "#name", value: "Codex", clear: true } },
      { tool: "browser_click", args: { selector: "#go" } },
      { tool: "browser_eval", args: { script: "({ value: document.querySelector('#name').value, clicked: document.body.dataset.clicked })" } },
    ],
  });
  if (!workflow.ok || workflow.completedSteps !== 3 || workflow.results?.[2]?.data?.result?.value?.clicked !== "yes") {
    throw new Error(`browser_workflow returned unexpected results: ${JSON.stringify(workflow)}`);
  }

  const observed = await rpc.tool("browser_observe", {
    port: browserPort,
    tabId: opened.tabId,
    actionScript: "console.error('e2e-observed-error'); document.body.dataset.observed='yes'; return location.href;",
    durationMs: 100,
  });
  if (!observed.ok || observed.counts?.console < 1 || !observed.events?.some((event) => event.type === "console")) {
    throw new Error(`browser_observe did not capture the console event: ${JSON.stringify(observed)}`);
  }

  const delta = await rpc.tool("browser_snapshot", {
    port: browserPort,
    tabId: opened.tabId,
    incremental: true,
  });
  if (delta.baseline || !delta.changed || (!delta.text?.changed && !delta.counts?.added && !delta.counts?.removed && !delta.counts?.changed)) {
    throw new Error(`incremental browser_snapshot did not report page changes: ${JSON.stringify(delta)}`);
  }

  const evaluated = await rpc.tool("browser_eval", {
    port: browserPort,
    tabId: opened.tabId,
    script: "({ value: document.querySelector('#name').value, clicked: document.body.dataset.clicked })",
  });
  if (evaluated.result?.value?.value !== "Codex" || evaluated.result?.value?.clicked !== "yes") {
    throw new Error(`Unexpected page state: ${JSON.stringify(evaluated)}`);
  }

  const screenshot = await rpc.tool("browser_screenshot", {
    port: browserPort,
    tabId: opened.tabId,
    path: "screenshots/e2e-browser-test.png",
    timeoutMs: 10000,
  });
  if (!screenshot.path) throw new Error("screenshot did not return a path");

  await rpc.tool("browser_stop", { port: browserPort, timeoutMs: 10000 });
  stopped = true;
  console.log(`OK: browser e2e passed on port ${browserPort}; screenshot=${screenshot.path}`);
} finally {
  if (!stopped) {
    await rpc.tool("browser_stop", { port: browserPort, timeoutMs: 3000 }).catch(() => {});
  }
  rpc.child.kill();
}
