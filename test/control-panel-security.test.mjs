import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PANEL_SCRIPT = path.join(ROOT, "control-panel.mjs");

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function httpRequest({ port, method = "GET", path: reqPath = "/", headers = {}, body = "" }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method,
      path: reqPath,
      headers: {
        host: `127.0.0.1:${port}`,
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function startPanel(t, extraArgs = []) {
  const port = await reservePort();
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-panel-sec-"));
  const child = spawn(process.execPath, [PANEL_SCRIPT, "--host", "127.0.0.1", "--port", String(port), ...extraArgs], {
    cwd: ROOT,
    env: { ...process.env, LOCALAPPDATA: localAppData },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    fs.rmSync(localAppData, { recursive: true, force: true });
  });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const res = await httpRequest({ port, path: "/api/health" });
      if (res.status === 200) return { port, localAppData, child };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("control panel failed to become healthy");
}

test("refuses to bind non-loopback host", () => {
  const result = spawnSync(process.execPath, [PANEL_SCRIPT, "--host", "0.0.0.0", "--port", "0"], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /回环|127\.0\.0\.1/);
});

test("defaults to read-only mode and injects security headers and panel token on GET /", async (t) => {
  const { port, localAppData } = await startPanel(t);
  const home = await httpRequest({ port, path: "/" });
  assert.equal(home.status, 200);
  assert.match(home.headers["content-security-policy"] || "", /default-src 'self'/);
  assert.equal(home.headers["x-frame-options"], "DENY");
  const tokenMatch = home.body.match(/<meta name="cfb-panel-token" content="([a-f0-9]{64})"/);
  assert.ok(tokenMatch, "missing panel token meta tag");
  const tokenFile = path.join(localAppData, "CodexFeishuBridge", "control-panel", "state", "panel-token.txt");
  assert.equal(fs.readFileSync(tokenFile, "utf8").trim(), tokenMatch[1]);

  // Default read-only rejects POST with 403 even with valid token & JSON
  const postRes = await httpRequest({
    port,
    method: "POST",
    path: "/api/factory/preview",
    headers: {
      "content-type": "application/json",
      "x-cfb-panel-token": tokenMatch[1],
    },
    body: JSON.stringify({ slug: "writing" }),
  });
  assert.equal(postRes.status, 403);
  assert.match(postRes.body, /默认只读/);

  // Rejects mismatched Host header
  const badHost = await httpRequest({
    port,
    path: "/api/health",
    headers: { host: "evil.example:8320" },
  });
  assert.equal(badHost.status, 403);
});

test("--allow-writes enforces Origin, Content-Type, and X-CFB-Panel-Token", async (t) => {
  const { port } = await startPanel(t, ["--allow-writes"]);
  const home = await httpRequest({ port, path: "/" });
  const token = home.body.match(/<meta name="cfb-panel-token" content="([a-f0-9]{64})"/)?.[1];
  assert.ok(token);

  // Missing token -> 401
  const noToken = await httpRequest({
    port,
    method: "POST",
    path: "/api/factory/preview",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug: "writing" }),
  });
  assert.equal(noToken.status, 401);

  // Cross-site Origin -> 403
  const crossOrigin = await httpRequest({
    port,
    method: "POST",
    path: "/api/factory/preview",
    headers: {
      "content-type": "application/json",
      origin: "https://evil.example",
      "x-cfb-panel-token": token,
    },
    body: JSON.stringify({ slug: "writing" }),
  });
  assert.equal(crossOrigin.status, 403);

  // Non-JSON Content-Type -> 415
  const nonJson = await httpRequest({
    port,
    method: "POST",
    path: "/api/factory/preview",
    headers: {
      "content-type": "text/plain",
      "x-cfb-panel-token": token,
    },
    body: "slug=writing",
  });
  assert.equal(nonJson.status, 415);

  // Valid token + same-origin + JSON -> 200
  const okRes = await httpRequest({
    port,
    method: "POST",
    path: "/api/factory/preview",
    headers: {
      "content-type": "application/json",
      origin: `http://127.0.0.1:${port}`,
      "x-cfb-panel-token": token,
    },
    body: JSON.stringify({ slug: "writing", count: 1 }),
  });
  assert.equal(okRes.status, 200);
  const parsed = JSON.parse(okRes.body);
  assert.equal(parsed.ok, true);
});
