const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const resolverPath = path.join(__dirname, "..", "resources", "scripts", "resolve-codex-runtime.ps1");
const currentPackage = "OpenAI.Codex_26.727.4816.0_x64__test";

function addRuntime(root, packageFullName, contents = "runtime") {
  const directory = path.join(root, packageFullName);
  fs.mkdirSync(directory, { recursive: true });
  const runtimePath = path.join(directory, "codex.exe");
  fs.writeFileSync(runtimePath, contents);
  return runtimePath;
}

function canonicalPath(filePath) {
  return fs.realpathSync.native(filePath);
}

function resolveRuntime(packageFullName, roots) {
  const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = [
    ". $env:CFB_RESOLVER_PATH",
    "$roots = $env:CFB_CACHE_ROOTS | ConvertFrom-Json",
    "$result = Resolve-CodexCachedRuntime -PackageFullName $env:CFB_PACKAGE_FULL_NAME -CacheRoots $roots",
    "$result | ConvertTo-Json -Compress",
  ].join("; ");
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      CFB_RESOLVER_PATH: resolverPath,
      CFB_PACKAGE_FULL_NAME: packageFullName,
      CFB_CACHE_ROOTS: JSON.stringify(roots),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
}

test("runtime resolver prefers an exact package match across every cache root", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-runtime-roots-"));
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  try {
    addRuntime(first, "OpenAI.Codex_26.721.4979.0_x64__test");
    const exact = addRuntime(second, currentPackage);
    const result = resolveRuntime(currentPackage, [first, second]);
    assert.equal(canonicalPath(result.cachedRuntimePath), canonicalPath(exact));
    assert.equal(result.cachedPackageFullName, currentPackage);
    assert.equal(result.cacheMatch, "exact");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime resolver chooses the highest fallback version globally", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-runtime-fallback-"));
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  try {
    addRuntime(first, "OpenAI.Codex_26.721.9999.0_x64__test");
    const newest = addRuntime(second, "OpenAI.Codex_26.727.4000.0_x64__test");
    const result = resolveRuntime(currentPackage, [first, second]);
    assert.equal(canonicalPath(result.cachedRuntimePath), canonicalPath(newest));
    assert.equal(result.cacheMatch, "fallback");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime resolver ignores empty or malformed cache entries", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-runtime-invalid-"));
  try {
    addRuntime(root, currentPackage, "");
    addRuntime(root, "unrelated-folder");
    const result = resolveRuntime(currentPackage, [root]);
    assert.equal(result.cachedRuntimePath, "");
    assert.equal(result.cacheMatch, "none");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
