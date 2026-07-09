import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(root, "src", "server.mjs");
const tempRoot = path.join(os.tmpdir(), `codex-browser-control-benchmark-${process.pid}-${Date.now()}`);
const profileDir = path.join(tempRoot, "profile");
const downloadDir = path.join(tempRoot, "downloads");
const screenshotDir = path.join(tempRoot, "screenshots");
const traceDir = path.join(tempRoot, "trace");

mkdirSync(tempRoot, { recursive: true });

async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function startHttpServer() {
  const srv = createHttpServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/download") {
      const body = "codex browser benchmark download\n";
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": "attachment; filename=\"benchmark-download.txt\"",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    if (url.pathname === "/new-tab") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>Benchmark New Tab</title><h1>New tab ready</h1>");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
<html>
  <head>
    <title>Codex Browser Benchmark</title>
    <style>
      body { margin: 0; font-family: Arial, sans-serif; background: #f4f7f9; color: #16202a; }
      main { min-height: 100vh; padding: 48px; background: linear-gradient(135deg, #ffffff, #d9edf7); }
      body.changed main { background: #17324d; color: #ffffff; }
      label, input, button, a { display: block; margin: 12px 0; font-size: 18px; }
      input { padding: 8px 10px; border: 1px solid #789; border-radius: 4px; }
      button, a { width: max-content; padding: 9px 12px; border-radius: 4px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Browser Benchmark Ready</h1>
      <label for="name">Name</label>
      <input id="name" aria-label="Name" autocomplete="off">
      <button id="go" onclick="document.body.dataset.clicked='yes'; document.getElementById('status').textContent='Clicked ' + document.getElementById('name').value;">Run</button>
      <button id="change" onclick="document.body.classList.toggle('changed')">Change Theme</button>
      <a id="download" href="/download" download="benchmark-download.txt">Download File</a>
      <p id="status" role="status">Idle</p>
    </main>
    <script>console.log("benchmark page loaded");</script>
  </body>
</html>`);
  });
  await new Promise((resolve, reject) => {
    srv.listen(0, "127.0.0.1", resolve);
    srv.on("error", reject);
  });
  return srv;
}

function startRpc(extensionPort) {
  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      BROWSER_CONTROL_EXTENSION_PORT: String(extensionPort),
      BROWSER_CONTROL_EXTENSION_TOKEN: "benchmark-token",
      BROWSER_CONTROL_EXTENSION_BRIDGE: "0",
    },
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  let nextId = 1;

  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      process.stderr.write(`Non-JSON MCP output: ${line}\n`);
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  function request(method, params, timeoutMs = 45000) {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
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

  async function rawTool(name, args = {}, timeoutMs = 45000) {
    return request("tools/call", { name, arguments: args }, timeoutMs);
  }

  async function tool(name, args = {}, timeoutMs = 45000) {
    const result = await rawTool(name, args, timeoutMs);
    if (result.isError) throw new Error(result.content?.[0]?.text || `${name} failed`);
    return JSON.parse(result.content?.[0]?.text || "{}");
  }

  return { child, request, rawTool, tool };
}

const browserPort = await freePort();
const extensionPort = await freePort();
const httpServer = await startHttpServer();
const httpPort = httpServer.address().port;
const baseUrl = `http://127.0.0.1:${httpPort}`;
const rpc = startRpc(extensionPort);
const tests = [];
let tabId = null;
let stoppedBrowser = false;
let tempRootCleaned = false;
let cleanupError = null;

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeTempRoot() {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
      return true;
    } catch (error) {
      cleanupError = error.message;
      await delay(500);
    }
  }
  return false;
}

async function run(name, capability, fn) {
  const started = Date.now();
  try {
    const details = await fn();
    tests.push({ name, capability, ok: true, durationMs: Date.now() - started, details });
  } catch (error) {
    tests.push({ name, capability, ok: false, durationMs: Date.now() - started, error: error.message });
  }
}

try {
  await run("initialize and list tools", "protocol", async () => {
    const initialized = await rpc.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "browser-control-benchmark", version: "0.1.0" },
    });
    if (initialized.serverInfo?.name !== "codex-browser-control") throw new Error("Unexpected serverInfo");
    const listed = await rpc.request("tools/list", {});
    const names = listed.tools.map((tool) => tool.name);
    for (const required of ["browser_page_diagnostics", "browser_visual_compare", "browser_wait_for_download", "browser_playwright_status"]) {
      if (!names.includes(required)) throw new Error(`Missing ${required}`);
    }
    return { toolCount: names.length };
  });

  await run("start browser and open test page", "lifecycle", async () => {
    await rpc.tool("browser_start", {
      port: browserPort,
      headless: true,
      userDataDir: profileDir,
      url: "about:blank",
      timeoutMs: 25000,
    });
    const status = await rpc.tool("browser_status", { port: browserPort });
    if (!status.connected) throw new Error("browser_status did not connect");
    const opened = await rpc.tool("browser_open", {
      port: browserPort,
      url: `${baseUrl}/`,
      timeoutMs: 15000,
    });
    tabId = opened.tabId;
    if (!tabId) throw new Error("browser_open did not return tabId");
    await rpc.tool("browser_wait_for", { port: browserPort, tabId, selector: "#go", timeoutMs: 10000 });
    return { tabId, browserPort };
  });

  await run("locator find/type/click/actionability", "locator", async () => {
    const found = await rpc.tool("browser_locator_find", { port: browserPort, tabId, role: "button", name: "Run" });
    if (!found.locator?.ok) throw new Error("Run button was not found");
    await rpc.tool("browser_locator_type", { port: browserPort, tabId, label: "Name", value: "Codex", clear: true });
    const actionability = await rpc.tool("browser_actionability_check", { port: browserPort, tabId, role: "button", name: "Run" });
    if (!actionability.locator?.ok) throw new Error("Run button is not actionable");
    await rpc.tool("browser_locator_click", { port: browserPort, tabId, role: "button", name: "Run" });
    const state = await rpc.tool("browser_eval", {
      port: browserPort,
      tabId,
      script: "({ clicked: document.body.dataset.clicked, status: document.getElementById('status').textContent, value: document.getElementById('name').value })",
    });
    if (state.result?.value?.clicked !== "yes" || state.result?.value?.value !== "Codex") {
      throw new Error(`Unexpected page state: ${JSON.stringify(state.result?.value)}`);
    }
    return { candidateCount: found.locator.candidates?.length || 0, status: state.result.value.status };
  });

  await run("accessibility snapshot", "accessibility", async () => {
    const ax = await rpc.tool("browser_accessibility_snapshot", { port: browserPort, tabId, maxNodes: 80 });
    if (!ax.ok || ax.returnedNodeCount < 1) throw new Error("Accessibility snapshot was empty");
    return { returnedNodeCount: ax.returnedNodeCount, nodeCount: ax.nodeCount };
  });

  await run("page diagnostics", "diagnostics", async () => {
    const diagnostics = await rpc.tool("browser_page_diagnostics", {
      port: browserPort,
      tabId,
      role: "button",
      name: "Run",
      sampleMax: 40000,
      maxAccessibilitySample: 8,
    });
    if (!diagnostics.ok || diagnostics.score < 70) throw new Error(`Low diagnostics score: ${diagnostics.score}`);
    return { score: diagnostics.score, issues: diagnostics.issues.length, nonBlankScore: diagnostics.visual?.nonBlankScore };
  });

  await run("visual analyze and element screenshot", "visual", async () => {
    const visual = await rpc.tool("browser_visual_analyze", {
      port: browserPort,
      tabId,
      sampleMax: 40000,
      path: path.join(screenshotDir, "visual.png"),
    });
    if (!visual.analysis || visual.analysis.nonBlankScore < 0.08) throw new Error("Visual analysis reported a blank page");
    const element = await rpc.tool("browser_element_screenshot", {
      port: browserPort,
      tabId,
      role: "button",
      name: "Run",
      analyze: true,
      path: path.join(screenshotDir, "run-button.png"),
    });
    if (!element.analysis || element.analysis.nonBlankScore < 0.02) throw new Error("Element screenshot analysis was empty");
    return { nonBlankScore: visual.analysis.nonBlankScore, elementPath: element.path };
  });

  await run("visual compare", "visual", async () => {
    const compared = await rpc.tool("browser_visual_compare", {
      port: browserPort,
      tabId,
      actionScript: "document.body.classList.toggle('changed');",
      beforePath: path.join(screenshotDir, "before.png"),
      afterPath: path.join(screenshotDir, "after.png"),
      settleMs: 100,
      sampleMax: 40000,
    });
    if (!compared.comparison || compared.comparison.changedRatio <= 0) throw new Error("Visual compare did not detect a change");
    return { changedRatio: compared.comparison.changedRatio, meanDelta: compared.comparison.meanDelta };
  });

  await run("trace start/status/stop/export", "trace", async () => {
    const started = await rpc.tool("browser_trace_start", {
      name: "benchmark",
      dir: traceDir,
      includeConsole: true,
      includeNetwork: true,
    });
    if (!started.ok) throw new Error("Trace did not start");
    await rpc.tool("browser_eval", { port: browserPort, tabId, script: "console.log('trace benchmark event'); location.href" });
    const status = await rpc.tool("browser_trace_status");
    if (!status.active || status.active.steps < 1) throw new Error("Trace did not record tool calls");
    const stopped = await rpc.tool("browser_trace_stop");
    if (!stopped.ok || !stopped.exported) throw new Error("Trace did not export on stop");
    return { steps: status.active.steps, exported: stopped.exported };
  });

  await run("dialog handling with actionScript", "dialogs", async () => {
    const dialog = await rpc.tool("browser_dialog", {
      port: browserPort,
      tabId,
      action: "accept",
      actionScript: "alert('benchmark-dialog');",
      timeoutMs: 10000,
    });
    if (!dialog.ok || dialog.action !== "accept") throw new Error("Dialog was not accepted");
    return { mode: dialog.mode, message: dialog.dialog?.message || "" };
  });

  await run("new tab wait", "tabs", async () => {
    const opened = await rpc.tool("browser_wait_for_new_tab", {
      port: browserPort,
      tabId,
      actionScript: `window.open('${baseUrl}/new-tab', '_blank');`,
      timeoutMs: 10000,
    });
    if (!opened.ok || !opened.tab?.id) throw new Error("New tab was not detected");
    await rpc.tool("browser_close", { port: browserPort, tabId: opened.tab.id }).catch(() => null);
    return { newTabId: opened.tab.id, waitedMs: opened.waitedMs };
  });

  await run("download wait", "downloads", async () => {
    await rpc.tool("browser_set_download_behavior", { port: browserPort, downloadPath: downloadDir });
    const waiting = rpc.tool("browser_wait_for_download", {
      port: browserPort,
      downloadPath: downloadDir,
      suggestedFilename: "benchmark-download",
      timeoutMs: 15000,
    }, 20000);
    await delay(250);
    await rpc.tool("browser_click", { port: browserPort, tabId, selector: "#download" });
    const downloaded = await waiting;
    if (!downloaded.ok || downloaded.state !== "completed") throw new Error(`Download did not complete: ${JSON.stringify(downloaded)}`);
    return { filePath: downloaded.filePath, receivedBytes: downloaded.receivedBytes };
  });

  await run("permission grant/reset", "permissions", async () => {
    await rpc.tool("browser_grant_permissions", { port: browserPort, tabId, origin: baseUrl, permissions: ["geolocation"] });
    await rpc.tool("browser_reset_permissions", { port: browserPort, tabId, origin: baseUrl });
    return { origin: baseUrl, permission: "geolocation" };
  });

  await run("playwright status", "playwright", async () => {
    const status = await rpc.tool("browser_playwright_status");
    if (!status.ok || !Array.isArray(status.sessions)) throw new Error("Playwright status payload was unstable");
    return { available: status.available, sessions: status.sessions.length, error: status.error || null };
  });
} finally {
  await rpc.tool("browser_stop", { port: browserPort, timeoutMs: 5000 }).then(() => {
    stoppedBrowser = true;
  }).catch(() => {});
  rpc.child.kill();
  httpServer.close();
  await delay(1000);
  tempRootCleaned = await removeTempRoot();
}

const passed = tests.filter((test) => test.ok).length;
const failed = tests.length - passed;
const durationMs = tests.reduce((sum, test) => sum + test.durationMs, 0);
const averageLatencyMs = tests.length ? Math.round(durationMs / tests.length) : 0;
const capabilities = [...new Set(tests.filter((test) => test.ok).map((test) => test.capability))].sort();
const expectedCapabilities = ["accessibility", "diagnostics", "dialogs", "downloads", "lifecycle", "locator", "permissions", "playwright", "protocol", "tabs", "trace", "visual"];
const coverageRatio = capabilities.length / expectedCapabilities.length;
const passRatio = tests.length ? passed / tests.length : 0;
const score = Math.round(((passRatio * 0.82 + coverageRatio * 0.18) * 10) * 10) / 10;
const summary = {
  ok: failed === 0,
  score,
  total: tests.length,
  passed,
  failed,
  averageLatencyMs,
  capabilities,
  stoppedBrowser,
  tempRootCleaned,
  cleanupError,
  tests,
};

console.log(JSON.stringify(summary, null, 2));
if (failed) process.exitCode = 1;
