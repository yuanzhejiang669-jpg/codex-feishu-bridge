#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "127.0.0.1";
const PORT = await reservePort();
const tempLocalAppData = await mkdtemp(path.join(os.tmpdir(), "codex-feishu-panel-check-"));

let child;
try {
  child = spawn(process.execPath, [
    path.join(ROOT, "control-panel.mjs"),
    "--host",
    HOST,
    "--port",
    String(PORT),
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      LOCALAPPDATA: tempLocalAppData,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8")));

  await waitForHttp(`http://${HOST}:${PORT}/api/health`, 8000);
  const home = await getText(`http://${HOST}:${PORT}/`);
  if (home.statusCode !== 200) {
    throw new Error(`control panel / returned HTTP ${home.statusCode}`);
  }
  if (!home.body.includes("<html") && !home.body.includes("<!doctype html")) {
    throw new Error("control panel / did not return an HTML document");
  }

  process.stdout.write(`ok control-panel static smoke http://${HOST}:${PORT}/\n`);
} catch (error) {
  if (child && !child.killed) child.kill();
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Control panel static smoke failed: ${message}\n`);
  process.exitCode = 1;
} finally {
  if (child && !child.killed) {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }
  await rm(tempLocalAppData, { recursive: true, force: true });
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === "string") {
    throw new Error("failed to reserve a local TCP port");
  }
  return address.port;
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await getText(url);
      if (response.statusCode >= 200 && response.statusCode < 500) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw lastError || new Error(`timed out waiting for ${url}`);
}

function getText(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode || 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.setTimeout(5000, () => {
      req.destroy(new Error(`request timed out: ${url}`));
    });
    req.on("error", reject);
  });
}
