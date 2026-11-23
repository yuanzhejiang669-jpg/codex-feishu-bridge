#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findPython() {
  const candidates = process.platform === "win32"
    ? [["python", []], ["py", ["-3"]]]
    : [["python3", []], ["python", []]];
  for (const [cmd, prefix] of candidates) {
    const probe = spawnSync(cmd, [...prefix, "--version"], { encoding: "utf8", windowsHide: true });
    if (!probe.error && probe.status === 0) return { cmd, prefix };
  }
  throw new Error("Python 3 interpreter not found in PATH");
}

const py = findPython();
const pyFiles = [
  "tools/router_file_lock.py",
  "tools/tavily-router/tavily_router_core.py",
  "tools/tavily-router/server.py",
  "tools/tavily-router/test_tavily_router.py",
  "tools/firecrawl-router/server.py",
  "tools/firecrawl-router/test_server.py",
].map((rel) => path.join(ROOT, rel)).filter((file) => fs.existsSync(file));

for (const file of pyFiles) {
  const res = spawnSync(py.cmd, [...py.prefix, "-m", "py_compile", file], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  if (res.status !== 0) {
    process.stderr.write(res.stderr || res.stdout || `py_compile failed for ${file}\n`);
    process.exit(res.status || 1);
  }
  process.stdout.write(`ok py_compile ${path.relative(ROOT, file)}\n`);
}

const testDirs = [
  path.join(ROOT, "tools", "tavily-router"),
  path.join(ROOT, "tools", "firecrawl-router"),
];
for (const dir of testDirs) {
  const res = spawnSync(py.cmd, [...py.prefix, "-m", "unittest", "discover", "-s", dir, "-p", "test_*.py", "-v"], {
    cwd: dir,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      TAVILY_API_KEY: "",
      FIRECRAWL_API_KEY: "",
    },
  });
  if (res.status !== 0) {
    process.stderr.write(res.stdout || "");
    process.stderr.write(res.stderr || "");
    process.exit(res.status || 1);
  }
  process.stdout.write(`ok python unittest ${path.relative(ROOT, dir)}\n`);
}
