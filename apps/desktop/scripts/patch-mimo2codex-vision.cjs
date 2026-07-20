const fs = require("node:fs");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..");
const packageRoot = path.join(desktopRoot, "proxy-runtime", "node_modules", "mimo2codex");
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));

if (manifest.version !== "0.5.28") {
  throw new Error(`Review the managed vision patch before using mimo2codex ${manifest.version}`);
}

function patch(relativePath, original, replacement) {
  const destination = path.join(packageRoot, relativePath);
  const text = fs.readFileSync(destination, "utf8");
  if (text.includes(replacement)) return false;
  if (!text.includes(original)) throw new Error(`mimo2codex patch target changed: ${destination}`);
  fs.writeFileSync(destination, text.replace(original, replacement), "utf8");
  return true;
}

const changed = [
  patch(
    path.join("dist", "translate", "reqToChat.js"),
    "supportsImages: modelSupportsImages(effectiveModel),",
    "supportsImages: typeof opts.supportsImages === \"boolean\" ? opts.supportsImages : modelSupportsImages(effectiveModel),",
  ),
  patch(
    path.join("dist", "providers", "generic.js"),
    "upstreamModel: ctx.upstreamModel,",
    "upstreamModel: ctx.upstreamModel,\n                supportsImages: ctx.supportsImages,",
  ),
  patch(
    path.join("dist", "server.js"),
    "webSearchEnabled: resolveWebSearchEnabled(cfg),\n        upstreamModel,",
    "webSearchEnabled: resolveWebSearchEnabled(cfg),\n        supportsImages: modelInfo?.supportsImages === true,\n        upstreamModel,",
  ),
  patch(
    path.join("dist", "translate", "reqToChat.js"),
    'chat.reasoning_effort =\n            eff === "minimal" ? "low" : eff;',
    "chat.reasoning_effort = eff;",
  ),
].filter(Boolean).length;

process.stdout.write(`mimo2codex compatibility patch ready (${changed} file${changed === 1 ? "" : "s"} changed)\n`);
