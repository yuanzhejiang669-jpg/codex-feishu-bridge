import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { loadRegistry } = require("../src/config/model-reasoning.cjs");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = path.join(root, "config", "model-reasoning-capabilities.json");
const schema = JSON.parse(fs.readFileSync(path.join(root, "config", "model-reasoning-capabilities.schema.json"), "utf8"));
if (schema?.properties?.schemaVersion?.const !== 1) throw new Error("Reasoning capability schema version is invalid");
const registry = loadRegistry(registryPath);
process.stdout.write(`ok model reasoning capabilities ${registry.registryVersion} (${registry.entries.length} entries)\n`);
