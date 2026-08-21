import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { PiRpcClient } from "../src/pi/rpc-client.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = 123;
  child.kill = () => child.emit("exit", 0, null);
  queueMicrotask(() => child.emit("spawn"));
  return child;
}

function commandsFrom(stream, onCommand) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) onCommand(JSON.parse(line));
      newline = buffer.indexOf("\n");
    }
  });
}

test("Pi RPC client preserves UTF-8 and only splits on LF", async () => {
  const child = fakeChild();
  const client = new PiRpcClient({ spawnProcess: () => child });
  await client.start();
  const eventPromise = client.waitForEvent((event) => event.type === "message_update", 1_000);
  const payload = `${JSON.stringify({ type: "message_update", text: "中\u2028文" })}\n`;
  const bytes = Buffer.from(payload, "utf8");
  child.stdout.write(bytes.subarray(0, bytes.length - 2));
  child.stdout.write(bytes.subarray(bytes.length - 2));
  const event = await eventPromise;
  assert.equal(event.text, "中\u2028文");
  child.emit("exit", 0, null);
});

test("Pi RPC responses correlate by request id", async () => {
  const child = fakeChild();
  const client = new PiRpcClient({ spawnProcess: () => child });
  let written = "";
  child.stdin.on("data", (chunk) => { written += chunk.toString("utf8"); });
  await client.start();
  const responsePromise = client.request({ type: "get_state" }, 1_000);
  await new Promise((resolve) => setImmediate(resolve));
  const command = JSON.parse(written.trim());
  child.stdout.write(`${JSON.stringify({ id: command.id, type: "response", command: "get_state", success: true, data: { sessionId: "s1" } })}\n`);
  const response = await responsePromise;
  assert.equal(response.data.sessionId, "s1");
  child.emit("exit", 0, null);
});

test("invalid Pi RPC JSON becomes an observable protocol error", async () => {
  const child = fakeChild();
  const client = new PiRpcClient({ spawnProcess: () => child });
  await client.start();
  const eventPromise = client.waitForEvent((event) => event.type === "protocol_error", 1_000);
  child.stdout.write("not-json\n");
  const event = await eventPromise;
  assert.match(event.error, /JSON/);
  child.emit("exit", 0, null);
});

test("Pi RPC readiness retries until get_state succeeds", async () => {
  const child = fakeChild();
  const client = new PiRpcClient({ spawnProcess: () => child, label: "slow Pi" });
  let probes = 0;
  commandsFrom(child.stdin, (command) => {
    if (command.type !== "get_state") return;
    probes += 1;
    if (probes < 2) return;
    child.stdout.write(`${JSON.stringify({
      id: command.id,
      type: "response",
      command: "get_state",
      success: true,
      data: { sessionId: "ready-session" },
    })}\n`);
  });
  await client.start();
  await client.waitUntilReady({ timeoutMs: 200, probeTimeoutMs: 20, retryDelayMs: 1 });
  assert.equal(client.ready, true);
  assert.equal(probes, 2);
  child.emit("exit", 0, null);
});

test("Pi RPC readiness fails immediately on early exit with stderr", async () => {
  const child = fakeChild();
  const client = new PiRpcClient({ spawnProcess: () => child, label: "early Pi" });
  await client.start();
  child.stderr.write("provider configuration failed\n");
  child.emit("exit", 7, null);
  await assert.rejects(
    client.waitUntilReady({ timeoutMs: 200, probeTimeoutMs: 20 }),
    /exited with 7.*provider configuration failed/s,
  );
});

test("Pi RPC readiness timeout includes bounded stderr diagnostics", async () => {
  const child = fakeChild();
  const client = new PiRpcClient({ spawnProcess: () => child, label: "stuck Pi" });
  await client.start();
  child.stderr.write("loading model registry\n");
  await assert.rejects(
    client.waitUntilReady({ timeoutMs: 45, probeTimeoutMs: 10, retryDelayMs: 1 }),
    /did not become ready.*Stderr: loading model registry/s,
  );
  child.emit("exit", 0, null);
});

test("Pi RPC request timeout reports stderr and removes the pending request", async () => {
  const child = fakeChild();
  const client = new PiRpcClient({ spawnProcess: () => child, label: "silent Pi" });
  await client.start();
  child.stderr.write("still initializing\n");
  await assert.rejects(
    client.request({ type: "get_state" }, 10),
    /timed out after 10ms.*Stderr: still initializing/s,
  );
  assert.equal(client.pending.size, 0);
  child.emit("exit", 0, null);
});

test("Pi RPC stop sends abort and waits for graceful process exit", async () => {
  const child = fakeChild();
  const client = new PiRpcClient({ spawnProcess: () => child });
  let abortSeen = false;
  commandsFrom(child.stdin, (command) => {
    if (command.type === "abort") {
      abortSeen = true;
      queueMicrotask(() => child.emit("exit", 0, null));
    }
  });
  await client.start();
  await client.stop({ forceAfterMs: 50 });
  assert.equal(abortSeen, true);
  assert.equal(client.closed, true);
  assert.equal(client.ready, false);
});
