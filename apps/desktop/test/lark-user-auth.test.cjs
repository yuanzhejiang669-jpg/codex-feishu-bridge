const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { authorizeLarkUser, parseJsonOutput } = require("../src/main/services/lark-user-auth.cjs");
const { DEFAULT_PERMISSION_POLICY } = require("../src/main/services/permission-policy.cjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-user-auth-test-"));
  const botRoot = path.join(root, "managed-bots", "assistant-1");
  fs.mkdirSync(botRoot, { recursive: true });
  fs.writeFileSync(path.join(botRoot, "bot.json"), JSON.stringify({
    name: "assistant-1",
    profile: "assistant-1-profile",
  }), "utf8");
  return root;
}

test("authorizes and verifies the selected managed Bot profile", async () => {
  const root = fixture();
  const calls = [];
  try {
    const result = await authorizeLarkUser("assistant-1", {
      dataRoot: root,
      larkCliPath: "lark-cli.exe",
      runLarkCli: async (_tool, args, options) => {
        calls.push({ args, options });
        if (args.includes("--no-wait")) return { stdout: JSON.stringify({
          verification_url: "https://accounts.example.test/verify",
          device_code: "device-code",
        }) };
        if (args.includes("--device-code")) return { stdout: "{\"ok\":true}" };
        return { stdout: JSON.stringify({ identities: { user: {
          status: "ready", available: true, verified: true, name: "Test User",
        } } }) };
      },
      openExternal: async (url) => { calls.push({ openedUrl: url }); },
    });
    assert.equal(result.identity.verified, true);
    assert.deepEqual(calls[0].args, [
      "auth", "login", "--scope", DEFAULT_PERMISSION_POLICY.userScopes.join(","),
      "--no-wait", "--json", "--profile", "assistant-1-profile",
    ]);
    assert.equal(calls[0].options.profileHome, path.join(root, "profile-home"));
    assert.deepEqual(calls[1], { openedUrl: "https://accounts.example.test/verify" });
    assert.deepEqual(calls[2].args, [
      "auth", "login", "--device-code", "device-code", "--json", "--profile", "assistant-1-profile",
    ]);
    assert.deepEqual(calls[3].args, [
      "auth", "status", "--json", "--verify", "--profile", "assistant-1-profile",
    ]);
    assert.equal(result.requestedScopeCount, 32);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unmanaged Bot names and incomplete user authorization", async () => {
  const root = fixture();
  try {
    await assert.rejects(() => authorizeLarkUser("legacy-bot", {
      dataRoot: root,
      larkCliPath: "lark-cli.exe",
      runLarkCli: async () => ({ stdout: "{}" }),
      openExternal: async () => {},
    }), /找不到客户端创建的 Bot/);
    await assert.rejects(() => authorizeLarkUser("assistant-1", {
      dataRoot: root,
      larkCliPath: "lark-cli.exe",
      runLarkCli: async (_tool, args) => args.includes("--no-wait")
        ? { stdout: JSON.stringify({ verification_url: "https://example.test", device_code: "code" }) }
        : args.includes("--device-code")
          ? { stdout: "{}" }
        : { stdout: JSON.stringify({ identities: { user: { available: false, message: "not authorized" } } }) },
      openExternal: async () => {},
    }), /not authorized/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("parses JSON surrounded by lark-cli notices", () => {
  assert.deepEqual(parseJsonOutput("notice\n{\"ok\":true}\n"), { ok: true });
});
