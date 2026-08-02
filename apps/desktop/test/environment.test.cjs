const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { cleanVersion, findMacBundleRuntime, firstExecutable, inspectCodex, inspectMacCodex, inspectRuntimeDirectory, loginState, macCodexCandidates, parseJsonOutput } = require("../src/main/services/environment.cjs");

test("parseJsonOutput tolerates a BOM and diagnostic prefix", () => {
  assert.deepEqual(parseJsonOutput("\uFEFFdiagnostic\n{\"packageFound\":true}\n"), { packageFound: true });
});

test("cleanVersion reads standard Codex version output", () => {
  assert.equal(cleanVersion("codex-cli 0.144.2"), "0.144.2");
  assert.equal(cleanVersion("codex 1.2.3-beta.1"), "1.2.3-beta.1");
});

test("loginState distinguishes signed in and signed out", () => {
  assert.equal(loginState("Logged in using ChatGPT", true), "signed-in");
  assert.equal(loginState("Not logged in", false), "signed-out");
  assert.equal(loginState("unexpected", false), "unknown");
});

test("inspectRuntimeDirectory reports the runtime folder and EXE component count", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-runtime-"));
  try {
    fs.writeFileSync(path.join(root, "codex.exe"), "");
    fs.writeFileSync(path.join(root, "rg.exe"), "");
    fs.writeFileSync(path.join(root, "notes.txt"), "");
    assert.deepEqual(inspectRuntimeDirectory(path.join(root, "codex.exe"), "win32"), {
      runtimeDirectory: root,
      runtimeExecutableCount: 2,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("macOS Codex candidates include current ChatGPT and legacy Codex bundles", () => {
  assert.deepEqual(macCodexCandidates("/Users/tester"), [
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/ChatGPT.app/Contents/Resources/bin/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli",
    "/Users/tester/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Users/tester/Applications/ChatGPT.app/Contents/Resources/bin/codex",
    "/Users/tester/Applications/ChatGPT.app/Contents/Resources/codex-cli",
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/bin/codex",
    "/Applications/Codex.app/Contents/Resources/codex-cli",
    "/Users/tester/Applications/Codex.app/Contents/Resources/codex",
    "/Users/tester/Applications/Codex.app/Contents/Resources/bin/codex",
    "/Users/tester/Applications/Codex.app/Contents/Resources/codex-cli",
  ]);
});

test("firstExecutable ignores missing candidates", () => {
  assert.equal(firstExecutable([path.join(os.tmpdir(), "missing-codex"), process.execPath]), process.execPath);
});

test("Windows inspection never executes the protected source runtime without a cache", { skip: process.platform !== "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-detect-source-only-"));
  const detector = path.join(root, "detect.ps1");
  try {
    const payload = JSON.stringify({
      packageFound: true,
      packageFullName: "OpenAI.Codex_26.727.4816.0_x64__test",
      sourceRuntimePath: process.execPath,
      cachedRuntimePath: "",
      runtimeFound: false,
    }).replaceAll("'", "''");
    fs.writeFileSync(detector, `[Console]::Out.Write('${payload}')\n`, "utf8");
    const result = await inspectCodex(detector);
    assert.equal(result.packageFound, true);
    assert.equal(result.runtimeFound, false);
    assert.equal(result.runtimePath, "");
    assert.match(result.error, /cache/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows inspection rejects a corrupt cached runtime", { skip: process.platform !== "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-detect-corrupt-cache-"));
  const detector = path.join(root, "detect.ps1");
  const corruptRuntime = path.join(root, "codex.exe");
  try {
    fs.writeFileSync(corruptRuntime, "not an executable", "utf8");
    const payload = JSON.stringify({
      packageFound: true,
      packageFullName: "OpenAI.Codex_26.727.4816.0_x64__test",
      sourceRuntimePath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_test\\codex.exe",
      cachedRuntimePath: corruptRuntime,
      runtimeFound: true,
    }).replaceAll("'", "''");
    fs.writeFileSync(detector, `[Console]::Out.Write('${payload}')\n`, "utf8");
    const result = await inspectCodex(detector);
    assert.equal(result.runtimeFound, false);
    assert.equal(result.runtimePath, "");
    assert.equal(result.runtimeCandidatePath, corruptRuntime);
    assert.match(result.error, /could not be executed/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("inspectMacCodex accepts only the official bundle identifier", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-chatgpt-app-"));
  const officialBundle = path.join(root, "ChatGPT.app");
  const unrelatedBundle = path.join(root, "Codex.app");
  const officialRuntime = path.join(officialBundle, "Contents", "Resources", "codex");
  const unrelatedRuntime = path.join(unrelatedBundle, "Contents", "Resources", "codex");
  try {
    for (const runtime of [officialRuntime, unrelatedRuntime]) {
      fs.mkdirSync(path.dirname(runtime), { recursive: true });
      fs.copyFileSync(process.execPath, runtime);
      fs.chmodSync(runtime, 0o755);
    }
    const result = await inspectMacCodex({
      candidates: [unrelatedRuntime, officialRuntime].map((item) => item.replaceAll("\\", "/")),
      readBundleValue: async (bundle, key) => {
        if (key === "CFBundleShortVersionString") return "26.715.31251";
        return bundle.endsWith("ChatGPT.app") ? "com.openai.codex" : "example.invalid";
      },
    });
    assert.equal(result.packageFound, true);
    assert.equal(result.bundleIdentifier, "com.openai.codex");
    assert.equal(result.packageVersion, "26.715.31251");
    assert.equal(result.runtimePath, officialRuntime.replaceAll("\\", "/"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findMacBundleRuntime discovers a nested executable fallback", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-codex-app-"));
  const bundle = path.join(root, "Codex.app");
  const nested = path.join(bundle, "Contents", "Resources", "app", "resources");
  try {
    fs.mkdirSync(nested, { recursive: true });
    const runtime = path.join(nested, "codex");
    fs.copyFileSync(process.execPath, runtime);
    fs.chmodSync(runtime, 0o755);
    assert.equal(findMacBundleRuntime(bundle.replaceAll("\\", "/")), runtime.replaceAll("\\", "/"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
