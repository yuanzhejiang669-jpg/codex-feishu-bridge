import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { createPiCapabilitiesConfig } from "../src/pi/capabilities/config.mjs";
import { McpStdioClient, normalizeMcpToolResult } from "../src/pi/capabilities/mcp-client.mjs";

function fakeServer() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit("exit", 0, null);
  let buffer = "";
  child.stdin.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const request = JSON.parse(line);
      if (request.id === undefined) continue;
      let result = {};
      if (request.method === "initialize") result = { serverInfo: { name: "fake" } };
      if (request.method === "tools/list") result = { tools: [{ name: "status", inputSchema: { type: "object" } }] };
      if (request.method === "tools/call") result = { content: [{ type: "text", text: "ok" }] };
      child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    }
  });
  queueMicrotask(() => child.emit("spawn"));
  return child;
}

test("MCP adapter initializes, lists and calls tools over strict JSONL", async () => {
  const child = fakeServer();
  const client = new McpStdioClient({ command: "fake", spawnProcess: () => child });
  await client.start();
  assert.deepEqual((await client.listTools()).map((tool) => tool.name), ["status"]);
  assert.equal((await client.callTool("status")).content[0].text, "ok");
  await client.stop();
});

test("capability config references five authority sources without credential fields", () => {
  const config = createPiCapabilitiesConfig({ bridgeRoot: "C:/bridge", mineruRoot: "C:/mineru" });
  assert.deepEqual(config.capabilities.map((item) => item.id), ["browser-control", "desktop-control", "tavily", "firecrawl", "mineru"]);
  assert.equal(config.capabilities.filter((item) => item.type === "mcp").length, 4);
  assert.equal(/api[_-]?key|secret/i.test(JSON.stringify(config)), false);
});

test("MCP result normalization preserves text and image content", () => {
  assert.deepEqual(normalizeMcpToolResult({ content: [
    { type: "text", text: "ok" },
    { type: "image", data: "abc", mimeType: "image/png" },
  ] }).content, [
    { type: "text", text: "ok" },
    { type: "image", data: "abc", mimeType: "image/png" },
  ]);
});
