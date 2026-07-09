import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = path.join(root, "extension", "codex_browser_bridge");
const manifest = JSON.parse(readFileSync(path.join(extensionRoot, "manifest.json"), "utf8"));
const permissions = new Set(manifest.permissions || []);
const forbiddenByDefault = ["declarativeNetRequest", "management", "contentSettings"];
const found = forbiddenByDefault.filter((permission) => permissions.has(permission));
if (found.length) {
  throw new Error(`Forbidden default extension permissions: ${found.join(", ")}`);
}
const background = readFileSync(path.join(extensionRoot, "background.js"), "utf8");
if (/BRIDGE_TOKEN\s*=\s*['"][0-9a-f]{48,}['"]/i.test(background)) {
  throw new Error("background.js must not contain a real bundled bridge token");
}
console.log(`OK: extension default permissions are scoped: ${[...permissions].join(", ")}`);
