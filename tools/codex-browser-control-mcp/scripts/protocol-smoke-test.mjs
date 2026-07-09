import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = path.join(root, "src", "server.mjs");
const extensionPort = 18796;
const smokeTraceDir = path.join(os.tmpdir(), `codex-browser-control-smoke-trace-${process.pid}`);
const child = spawn(process.execPath, [server], {
  cwd: root,
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    BROWSER_CONTROL_EXTENSION_PORT: String(extensionPort),
    BROWSER_CONTROL_EXTENSION_TOKEN: "smoke-test-token",
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
  const payload = { jsonrpc: "2.0", id, method, params };
  child.stdin.write(`${JSON.stringify(payload)}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, 10000);
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

try {
  const initialized = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "protocol-smoke-test", version: "0.1.0" },
  });
  if (initialized.serverInfo?.name !== "codex-browser-control") {
    throw new Error("Unexpected serverInfo");
  }

  const listed = await request("tools/list", {});
  const names = listed.tools.map((tool) => tool.name);
  for (const required of [
    "browser_trace_start",
    "browser_trace_status",
    "browser_trace_stop",
    "browser_trace_export",
    "browser_start",
    "browser_status",
    "browser_stop",
    "browser_open",
    "browser_wait_for_new_tab",
    "browser_dialog",
    "browser_set_download_behavior",
    "browser_wait_for_download",
    "browser_grant_permissions",
    "browser_reset_permissions",
    "browser_playwright_status",
    "browser_playwright_start",
    "browser_playwright_open",
    "browser_playwright_click",
    "browser_playwright_type",
    "browser_playwright_screenshot",
    "browser_playwright_stop",
    "browser_click",
    "browser_type",
    "browser_screenshot",
    "browser_element_screenshot",
    "browser_region_screenshot",
    "browser_visual_analyze",
    "browser_visual_compare",
    "browser_scan",
    "browser_accessibility_snapshot",
    "browser_page_diagnostics",
    "browser_locator_find",
    "browser_actionability_check",
    "browser_locator_click",
    "browser_locator_type",
    "browser_execute_js_rich",
    "browser_cookies",
    "browser_cdp_batch",
    "browser_set_file_input_files",
    "browser_iframe_eval",
    "browser_dom_pierce",
    "browser_generic_command",
    "browser_extension_status",
    "browser_extension_list_tabs",
    "browser_extension_scan",
    "browser_extension_execute_js",
    "browser_extension_command",
  ]) {
    if (!names.includes(required)) throw new Error(`Missing tool ${required}`);
  }

  const status = await request("tools/call", { name: "browser_status", arguments: { port: 65530 } });
  if (!status.content?.[0]?.text?.includes('"connected": false')) {
    throw new Error("browser_status did not return the expected disconnected result");
  }

  const playwrightStatus = await request("tools/call", { name: "browser_playwright_status", arguments: {} });
  const playwrightStatusJson = JSON.parse(playwrightStatus.content?.[0]?.text || "{}");
  if (!playwrightStatusJson.ok || !Array.isArray(playwrightStatusJson.sessions)) {
    throw new Error("browser_playwright_status did not return a stable status payload");
  }

  const traceStarted = await request("tools/call", {
    name: "browser_trace_start",
    arguments: { name: "smoke", dir: smokeTraceDir, includeConsole: true, includeNetwork: true },
  });
  const traceStartedJson = JSON.parse(traceStarted.content?.[0]?.text || "{}");
  if (!traceStartedJson.ok || !traceStartedJson.active?.id) {
    throw new Error("browser_trace_start did not create a trace");
  }

  await request("tools/call", { name: "browser_status", arguments: { port: 65529 } });

  const traceStatus = await request("tools/call", { name: "browser_trace_status", arguments: {} });
  const traceStatusJson = JSON.parse(traceStatus.content?.[0]?.text || "{}");
  if (!traceStatusJson.active || traceStatusJson.active.steps < 1) {
    throw new Error("browser_trace_status did not report traced tool calls");
  }

  const traceStopped = await request("tools/call", { name: "browser_trace_stop", arguments: {} });
  const traceStoppedJson = JSON.parse(traceStopped.content?.[0]?.text || "{}");
  if (!traceStoppedJson.ok || !traceStoppedJson.exported) {
    throw new Error("browser_trace_stop did not export the trace");
  }

  const traceExported = await request("tools/call", { name: "browser_trace_export", arguments: {} });
  const traceExportedJson = JSON.parse(traceExported.content?.[0]?.text || "{}");
  if (!traceExportedJson.ok || !traceExportedJson.exported) {
    throw new Error("browser_trace_export did not export the last trace");
  }

  await new Promise((resolve) => setTimeout(resolve, 250));
  const unauthorized = await fetch(`http://127.0.0.1:${extensionPort}/link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cmd: "get_all_sessions" }),
  });
  if (unauthorized.status !== 401) {
    throw new Error(`Extension bridge accepted an unauthenticated request: HTTP ${unauthorized.status}`);
  }

  const authorized = await fetch(`http://127.0.0.1:${extensionPort}/link`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-browser-token": "smoke-test-token",
    },
    body: JSON.stringify({ cmd: "get_all_sessions" }),
  });
  const authorizedJson = await authorized.json();
  if (!authorized.ok || !Array.isArray(authorizedJson.r)) {
    throw new Error(`Extension bridge rejected an authenticated request: HTTP ${authorized.status}`);
  }

  const unsafe = await request("tools/call", {
    name: "browser_extension_command",
    arguments: { command: { cmd: "management", method: "list" } },
  });
  const unsafeText = unsafe.content?.[0]?.text || "";
  if (!unsafe.isError || !unsafeText.includes("management commands are disabled")) {
    throw new Error(`Unsafe extension management command was not rejected: ${unsafeText}`);
  }

  console.log(`OK: ${names.length} tools listed, protocol calls succeeded, bridge auth is enforced, and unsafe extension commands are gated.`);
} finally {
  child.kill();
  rmSync(smokeTraceDir, { recursive: true, force: true });
}
