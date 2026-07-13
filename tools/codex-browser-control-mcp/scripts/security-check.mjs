import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
const server = path.join(root, "src", "server.mjs");
const missingToken = spawnSync(process.execPath, [server], {
  cwd: root,
  encoding: "utf8",
  timeout: 5000,
  env: {
    ...process.env,
    BROWSER_CONTROL_EXTENSION_BRIDGE: "1",
    BROWSER_CONTROL_EXTENSION_REQUIRE_TOKEN: "1",
    BROWSER_CONTROL_EXTENSION_TOKEN: "<local-extension-token>",
  },
});
if (missingToken.status === 0 || !`${missingToken.stderr}${missingToken.stdout}`.includes("no private token is configured")) {
  throw new Error(`Server did not fail fast with the public default bridge token: status=${missingToken.status}`);
}
console.log(`OK: extension default permissions are scoped: ${[...permissions].join(", ")}`);
console.log("OK: extension bridge fails fast when token authentication uses the public default token.");
