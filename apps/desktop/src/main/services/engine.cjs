const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

function readManifest(engineRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(engineRoot, "desktop-engine-manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

async function inspectEngine({ packaged, resourcesPath, desktopRoot }) {
  const engineRoot = packaged
    ? path.join(resourcesPath, "engine")
    : path.join(desktopRoot, "generated", "engine");
  const larkCliPath = packaged
    ? path.join(resourcesPath, "tools", "lark-cli.exe")
    : path.join(desktopRoot, "node_modules", "@larksuite", "cli", "bin", "lark-cli.exe");
  const nodePath = packaged
    ? path.join(resourcesPath, "tools", "node.exe")
    : path.join(desktopRoot, "node_modules", "node", "bin", "node.exe");
  const manifest = readManifest(engineRoot);
  let larkCliVersion = "";
  let nodeVersion = "";
  if (fs.existsSync(larkCliPath)) {
    try {
      const result = await execFileAsync(larkCliPath, ["--version"], {
        windowsHide: true,
        timeout: 8_000,
        encoding: "utf8",
      });
      larkCliVersion = `${result.stdout || ""} ${result.stderr || ""}`.match(/\d+\.\d+\.\d+/)?.[0] || "";
    } catch {
      larkCliVersion = "";
    }
  }
  if (fs.existsSync(nodePath)) {
    try {
      const result = await execFileAsync(nodePath, ["--version"], {
        windowsHide: true,
        timeout: 8_000,
        encoding: "utf8",
      });
      nodeVersion = String(result.stdout || "").trim().replace(/^v/, "");
    } catch {
      nodeVersion = "";
    }
  }

  const entrypoints = manifest?.entrypoints || {};
  const bridgeEntry = path.join(engineRoot, entrypoints.bridge || "codex-feishu-bridge.mjs");
  return {
    available: Boolean(manifest && fs.existsSync(bridgeEntry) && larkCliVersion && nodeVersion),
    engineRoot,
    bridgeEntry,
    larkCliPath,
    larkCliVersion,
    nodePath,
    nodeVersion,
    sourceCommit: manifest?.sourceCommit || "",
    protocolVersion: manifest?.protocolVersion || null,
  };
}

module.exports = { inspectEngine, readManifest };
