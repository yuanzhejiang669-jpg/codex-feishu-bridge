const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rendererRoot = path.resolve(__dirname, "..", "src", "renderer");

function collectJsFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      results.push(full);
    }
  }
  return results.sort();
}

const files = collectJsFiles(rendererRoot);
if (!files.length) {
  console.error("No renderer ES module files found under", rendererRoot);
  process.exit(1);
}

for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  const result = spawnSync(process.execPath, ["--input-type=module", "--check"], {
    input: source,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    console.error(`Renderer ESM syntax check failed: ${path.relative(rendererRoot, file)}`);
    if (result.stderr) console.error(result.stderr.trim());
    process.exit(result.status || 1);
  }
}

console.log(`Renderer ESM syntax check passed (${files.length} files).`);
