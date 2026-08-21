import path from "node:path";

import { writeJsonFileAtomicSync } from "../../utils/json.mjs";

export function createPiCapabilitiesConfig({
  bridgeRoot,
  mineruRoot,
  nodePath = process.execPath,
  pythonPath = "C:/Program Files/Python311/python.exe",
  powershellPath = "pwsh.exe",
  mcpDataRoot = "C:/Users/yzjiang/Documents/Codex/mcp-data",
} = {}) {
  const root = path.resolve(bridgeRoot);
  const mineru = path.resolve(mineruRoot);
  return {
    schemaVersion: 1,
    capabilities: [
      mcp("browser-control", nodePath, [path.join(root, "tools", "codex-browser-control-mcp", "src", "server.mjs")], root),
      mcp("desktop-control", pythonPath, [path.join(root, "tools", "codex-desktop-control-mcp", "server.py")], root),
      mcp("tavily", pythonPath, [path.join(root, "tools", "tavily-router", "server.py")], root, {
        TAVILY_KEY_POOL_PATH: path.join(mcpDataRoot, "key-pools", "tavily-key-pool.json"),
        TAVILY_ROUTER_STATE_PATH: path.join(mcpDataRoot, "state", "tavily-router-state.json"),
      }),
      mcp("firecrawl", pythonPath, [path.join(root, "tools", "firecrawl-router", "server.py")], root, {
        FIRECRAWL_KEY_POOL_PATH: path.join(mcpDataRoot, "key-pools", "firecrawl-key-pool.json"),
        FIRECRAWL_ROUTER_STATE_PATH: path.join(mcpDataRoot, "state", "firecrawl-router-state.json"),
      }),
      {
        id: "mineru",
        name: "MinerU",
        type: "mineru",
        command: powershellPath,
        script: path.join(mineru, "convert-with-mineru.ps1"),
        cwd: mineru,
        timeoutMs: 30 * 60_000,
      },
    ],
  };
}

export function writePiCapabilitiesConfig(filePath, config) {
  const serialized = JSON.stringify(config);
  if (/(api[_-]?key|secret|token)"\s*:/i.test(serialized)) {
    throw new Error("Pi capabilities config must not contain credential fields");
  }
  writeJsonFileAtomicSync(filePath, config);
  return config;
}

function mcp(id, command, args, cwd, env = {}) {
  return { id, name: id, type: "mcp", command, args, cwd, env, timeoutMs: 60_000 };
}
