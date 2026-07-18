const assert = require("node:assert/strict");
const test = require("node:test");
const { assessUpdateSupport, macApplicationPath } = require("../src/main/services/update-support.cjs");

test("enables packaged Windows updates and explains development mode", () => {
  assert.equal(assessUpdateSupport({ packaged: true, platform: "win32" }).supported, true);
  assert.deepEqual(assessUpdateSupport({ packaged: false, platform: "darwin" }), {
    supported: false,
    reason: "开发模式不连接更新服务",
  });
});

test("locates a macOS application bundle from its executable", () => {
  assert.equal(
    macApplicationPath("/Applications/Codex Feishu Bridge.app/Contents/MacOS/Codex Feishu Bridge"),
    "/Applications/Codex Feishu Bridge.app",
  );
});

test("blocks unsigned macOS packages with a precise reason", () => {
  const result = assessUpdateSupport({
    packaged: true,
    platform: "darwin",
    executablePath: "/Applications/Codex Feishu Bridge.app/Contents/MacOS/Codex Feishu Bridge",
    spawn: () => ({ status: 0, stdout: "", stderr: "Signature=adhoc\n" }),
  });
  assert.equal(result.supported, false);
  assert.match(result.reason, /Developer ID/);
});

test("enables notarized Developer ID macOS packages", () => {
  const calls = [];
  const result = assessUpdateSupport({
    packaged: true,
    platform: "darwin",
    executablePath: "/Applications/Codex Feishu Bridge.app/Contents/MacOS/Codex Feishu Bridge",
    spawn: (command, args) => {
      calls.push({ command, args });
      if (command.endsWith("codesign")) return { status: 0, stdout: "", stderr: "Authority=Developer ID Application: Example (TEAMID)\n" };
      return { status: 0, stdout: "accepted\n", stderr: "" };
    },
  });
  assert.equal(result.supported, true);
  assert.equal(calls.length, 2);
});
