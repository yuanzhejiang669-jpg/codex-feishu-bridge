#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_FILES = [
  "codex-feishu-bridge.mjs",
  "register-codex-feishu-bot.mjs",
  "control-panel.mjs",
  "scripts/smoke-app-server.mjs",
  "scripts/smoke-formula-renderer.mjs",
];
const WALK_DIRS = [
  "control-panel",
  "src",
];
const CHECK_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);

const targets = new Set(ROOT_FILES.map((file) => path.join(ROOT, file)));
for (const dir of WALK_DIRS) {
  collectCheckTargets(path.join(ROOT, dir), targets);
}

for (const file of [...targets].sort()) {
  const relative = path.relative(ROOT, file) || file;
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.stderr.write(`Syntax check failed: ${relative}\n`);
    process.exit(result.status || 1);
  }
  process.stdout.write(`ok ${relative}\n`);
}

function collectCheckTargets(dir, targets) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectCheckTargets(file, targets);
      continue;
    }
    if (entry.isFile() && CHECK_EXTENSIONS.has(path.extname(entry.name))) {
      targets.add(file);
    }
  }
}
