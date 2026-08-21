import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpStdioClient } from "../src/pi/capabilities/mcp-client.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const python = process.env.CODEX_FEISHU_PYTHON || "C:/Program Files/Python311/python.exe";
const mcpData = "C:/Users/yzjiang/Documents/Codex/mcp-data";
const definitions = [
  { id: "browser", command: process.execPath, args: [path.join(root, "tools/codex-browser-control-mcp/src/server.mjs")], env: { BROWSER_CONTROL_EXTENSION_BRIDGE: "0" }, tool: "browser_status", input: { port: 65530 }, verify: (value) => value.connected === false },
  { id: "desktop", command: python, args: [path.join(root, "tools/codex-desktop-control-mcp/server.py")], tool: "codex_desktop_control_status", input: {}, verify: (value) => value.ok !== false },
  { id: "tavily", command: python, args: [path.join(root, "tools/tavily-router/server.py")], env: { TAVILY_KEY_POOL_PATH: path.join(mcpData, "key-pools/tavily-key-pool.json"), TAVILY_ROUTER_STATE_PATH: path.join(mcpData, "state/tavily-router-state.json") }, tool: "tavily_search", input: { query: "OpenAI Codex", search_depth: "basic", max_results: 1, include_answer: false }, verify: (value) => Array.isArray(value.results) && value.results.length > 0 },
  { id: "firecrawl", command: python, args: [path.join(root, "tools/firecrawl-router/server.py")], env: { FIRECRAWL_KEY_POOL_PATH: path.join(mcpData, "key-pools/firecrawl-key-pool.json"), FIRECRAWL_ROUTER_STATE_PATH: path.join(mcpData, "state/firecrawl-router-state.json") }, tool: "firecrawl_pool_status", input: {}, verify: (value) => Number(value.enabled_key_count) > 0 && Array.isArray(value.keys) },
];

for (const definition of definitions) {
  const client = new McpStdioClient({ ...definition, cwd: root, env: { ...process.env, ...definition.env }, name: definition.id, timeoutMs: 90_000 });
  try {
    await client.start();
    const names = (await client.listTools()).map((tool) => tool.name);
    if (!names.includes(definition.tool)) throw new Error(`${definition.id} did not expose ${definition.tool}`);
    const result = await client.callTool(definition.tool, definition.input, 90_000);
    if (result?.isError) throw new Error(result.content?.[0]?.text || `${definition.tool} failed`);
    const payload = parseTextPayload(result);
    if (!definition.verify(payload)) {
      const diagnostic = definition.id === "firecrawl"
        ? ` keys=${Object.keys(payload).join(",")} ok=${String(payload.ok)} stderr=${String(payload.stderr || payload.error || "").slice(0, 300)}`
        : "";
      throw new Error(`${definition.tool} returned an unexpected result shape.${diagnostic}`);
    }
    process.stdout.write(`Pi capability smoke passed: ${definition.id}/${definition.tool}\n`);
  } finally {
    await client.stop().catch(() => {});
  }
}

const mineruRoot = "C:/Users/yzjiang/Documents/Codex/tools/mineru";
const mineruOutput = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-pi-mineru-smoke-"));
try {
  const output = await run(process.env.CODEX_FEISHU_PWSH || "pwsh.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-File",
    path.join(mineruRoot, "convert-with-mineru.ps1"),
    path.join(mineruRoot, "test-inputs/mineru-smoke-test.pdf"),
    mineruOutput,
    "-Backend", "pipeline",
    "-Method", "auto",
    "-Lang", "en",
  ], mineruRoot, 15 * 60_000);
  if (!output.includes("MinerU completed.")) throw new Error("MinerU did not report completion");
  const markdown = findFiles(mineruOutput, ".md");
  if (!markdown.length) throw new Error("MinerU produced no Markdown file");
  process.stdout.write("Pi capability smoke passed: mineru/mineru_convert\n");
} finally {
  fs.rmSync(mineruOutput, { recursive: true, force: true });
}

function parseTextPayload(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text || "{}";
  return JSON.parse(text);
}

function findFiles(directory, extension) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...findFiles(full, extension));
    else if (entry.name.toLowerCase().endsWith(extension)) result.push(full);
  }
  return result;
}

function run(command, args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${command} exited with ${code}`));
    });
  });
}
