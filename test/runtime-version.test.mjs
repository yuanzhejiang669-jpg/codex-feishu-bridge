import assert from "node:assert/strict";
import test from "node:test";

import {
  codexRuntimeVersionLines,
  parseCodexCliVersion,
  parseCodexRuntimeSource,
  parseDesktopPackage,
  readCodexRuntimeVersionStatus,
  runtimeAlignment,
} from "../src/codex/runtime-version.mjs";

const PACKAGE = "OpenAI.Codex_26.707.8479.0_x64__2p2nqsd0c76g0";
const CACHE_EXE = `C:\\Users\\test\\AppData\\Local\\CodexFeishuBridge\\official-codex-cli\\${PACKAGE}\\codex.exe`;

test("runtime version parsing identifies the actual cached desktop package", () => {
  assert.equal(parseCodexCliVersion("codex-cli 0.144.2\n"), "0.144.2");
  assert.deepEqual(parseCodexRuntimeSource(CACHE_EXE), {
    kind: "official-cache",
    executable: CACHE_EXE,
    packageFullName: PACKAGE,
    packageVersion: "26.707.8479.0",
  });
  assert.deepEqual(
    parseCodexRuntimeSource(`C:\\Program Files\\WindowsApps\\${PACKAGE}\\app\\resources\\codex.exe`),
    {
      kind: "windows-app",
      executable: `C:\\Program Files\\WindowsApps\\${PACKAGE}\\app\\resources\\codex.exe`,
      packageFullName: PACKAGE,
      packageVersion: "26.707.8479.0",
    },
  );
});

test("runtime alignment compares package identity instead of unrelated CLI versions", () => {
  const runtime = parseCodexRuntimeSource(CACHE_EXE);
  const desktop = parseDesktopPackage(JSON.stringify({
    found: true,
    version: "26.707.8479.0",
    packageFullName: PACKAGE,
    installLocation: `C:\\Program Files\\WindowsApps\\${PACKAGE}`,
    codexPath: `C:\\Program Files\\WindowsApps\\${PACKAGE}\\app\\resources\\codex.exe`,
    codexLength: 341284656,
  }));
  assert.equal(runtimeAlignment(runtime, desktop), "aligned");
  assert.equal(runtimeAlignment(runtime, { ...desktop, packageFullName: PACKAGE.replace("8479", "9999") }), "not-aligned");
  assert.equal(runtimeAlignment(parseCodexRuntimeSource("codex.exe"), desktop), "incomparable");
  assert.equal(runtimeAlignment(runtime, null), "unknown");
  assert.equal(runtimeAlignment(runtime, desktop, { size: 1 }), "runtime-file-mismatch");
});

test("runtime version status reads the selected executable and current AppX package", async () => {
  const calls = [];
  const status = await readCodexRuntimeVersionStatus({
    codexCli: { command: CACHE_EXE, argsPrefix: [] },
    runTool: async (tool, args) => {
      calls.push({ command: tool.command, args });
      if (tool.command === CACHE_EXE) return { code: 0, stdout: "codex-cli 0.144.2\n", stderr: "" };
      return {
        code: 0,
        stdout: `diagnostic line\n${JSON.stringify({ found: true, version: "26.707.8479.0", packageFullName: PACKAGE, installLocation: "C:\\app", codexPath: "C:\\app\\resources\\codex.exe", codexLength: 341284656 })}`,
        stderr: "",
      };
    },
    statFile: async () => ({ size: 341284656 }),
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ["--version"]);
  assert.equal(status.cliVersion, "0.144.2");
  assert.equal(status.runtime.packageVersion, "26.707.8479.0");
  assert.equal(status.desktop.version, "26.707.8479.0");
  assert.equal(status.alignment, "aligned");
  assert.deepEqual(codexRuntimeVersionLines(status), [
    "Codex CLI：`0.144.2`",
    "运行时来源包：OpenAI.Codex 26.707.8479.0",
    "桌面端最新包：OpenAI.Codex 26.707.8479.0",
    "版本状态：已对齐（Bridge 使用桌面端最新包的 Codex 运行时）",
  ]);
});

test("runtime version status accepts CLI version on stderr and detects a damaged cache", async () => {
  const status = await readCodexRuntimeVersionStatus({
    codexCli: { command: CACHE_EXE, argsPrefix: [] },
    runTool: async (tool) => {
      if (tool.command === CACHE_EXE) return { code: 0, stdout: "", stderr: "codex-cli 0.144.2\n" };
      return {
        code: 0,
        stdout: `\uFEFF${JSON.stringify({ found: true, version: "26.707.8479.0", packageFullName: PACKAGE, codexLength: 341284656 })}`,
        stderr: "",
      };
    },
    statFile: async () => ({ size: 123 }),
  });

  assert.equal(status.cliVersion, "0.144.2");
  assert.equal(status.alignment, "runtime-file-mismatch");
  assert.match(codexRuntimeVersionLines(status)[3], /运行时 codex\.exe 大小/);
});

test("runtime version status does not call a missing latest cache aligned", async () => {
  const status = await readCodexRuntimeVersionStatus({
    codexCli: { command: CACHE_EXE, argsPrefix: [] },
    runTool: async (tool) => {
      if (tool.command === CACHE_EXE) return { code: 1, stdout: "", stderr: "not found" };
      return {
        code: 0,
        stdout: JSON.stringify({ found: true, version: "26.707.8479.0", packageFullName: PACKAGE, codexLength: 341284656 }),
        stderr: "",
      };
    },
    statFile: async () => {
      throw new Error("ENOENT");
    },
  });

  assert.equal(status.alignment, "runtime-file-unavailable");
  assert.match(codexRuntimeVersionLines(status)[3], /不存在或不可访问/);
});

test("runtime version status degrades without breaking status output", async () => {
  const status = await readCodexRuntimeVersionStatus({
    codexCli: { command: "custom-codex.exe", argsPrefix: [] },
    runTool: async (tool) => {
      if (tool.command === "custom-codex.exe") throw new Error("spawn failed");
      return { code: 0, stdout: JSON.stringify({ found: false }), stderr: "" };
    },
  });

  assert.equal(status.alignment, "incomparable");
  assert.match(status.cliError, /spawn failed/);
  assert.match(status.desktopError, /未安装/);
  const lines = codexRuntimeVersionLines(status);
  assert.match(lines[0], /查询失败/);
  assert.match(lines[1], /自定义路径/);
  assert.match(lines[2], /未安装 OpenAI\.Codex/);
  assert.match(lines[3], /不可比较/);
});
