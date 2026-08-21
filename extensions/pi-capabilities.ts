import fs from "node:fs";
import { spawn } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { McpStdioClient, normalizeMcpToolResult } from "../src/pi/capabilities/mcp-client.mjs";

export default function piCapabilities(pi: ExtensionAPI) {
  const clients: McpStdioClient[] = [];
  pi.on("session_start", async () => {
    const configPath = String(process.env.CODEX_FEISHU_PI_CAPABILITIES_CONFIG || "");
    if (!configPath) return;
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    for (const capability of config.capabilities || []) {
      if (capability.type === "mcp") {
        const client = new McpStdioClient({ ...capability, env: { ...process.env, ...(capability.env || {}) } });
        await client.start();
        clients.push(client);
        const allow = new Set(capability.tools || []);
        for (const tool of await client.listTools()) {
          if (allow.size && !allow.has(tool.name)) continue;
          pi.registerTool({
            name: tool.name,
            label: tool.title || tool.name,
            description: tool.description || `${capability.name || capability.id} tool`,
            parameters: Type.Unsafe(tool.inputSchema || { type: "object", properties: {} }),
            async execute(_id, params) {
              const result = await client.callTool(tool.name, params, capability.timeoutMs);
              if (result?.isError) throw new Error(result.content?.[0]?.text || `${tool.name} failed`);
              return normalizeMcpToolResult(result);
            },
          });
        }
      } else if (capability.type === "mineru") {
        pi.registerTool({
          name: "mineru_convert",
          label: "MinerU Convert",
          description: "Convert a local PDF or document to Markdown with the shared MinerU installation.",
          parameters: Type.Object({
            inputPath: Type.String(),
            outputDir: Type.Optional(Type.String()),
            backend: Type.Optional(Type.String()),
            method: Type.Optional(Type.String()),
            lang: Type.Optional(Type.String()),
          }),
          async execute(_id, params, signal) {
            const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", capability.script, params.inputPath];
            if (params.outputDir) args.push(params.outputDir);
            if (params.backend) args.push("-Backend", params.backend);
            if (params.method) args.push("-Method", params.method);
            if (params.lang) args.push("-Lang", params.lang);
            const output = await runProcess(capability.command, args, capability.cwd, signal);
            return { content: [{ type: "text", text: output }], details: { source: capability.script } };
          },
        });
      }
    }
  });
  pi.on("session_shutdown", async () => Promise.all(clients.map((client) => client.stop())));
}

function runProcess(command: string, args: string[], cwd: string | undefined, signal: AbortSignal | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", reject);
    child.on("exit", (code) => {
      signal?.removeEventListener("abort", abort);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `Process exited with ${code}`));
    });
  });
}
