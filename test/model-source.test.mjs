import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  applyModelSourceSwitch,
  clearSessionOverrides,
  createLoginManager,
  discoverCodexHomes,
  inspectCodexHome,
  inspectSessionOverrides,
  parseLoginState,
  previewModelSourceSwitch,
  restoreModelSourceSwitch,
  restoreSessionOverrides,
} = require("../src/codex/model-source.cjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-model-source-"));
  const globalHome = path.join(root, ".codex");
  const homesRoot = path.join(root, "codex-homes");
  const writing = path.join(homesRoot, "writing");
  const drawing = path.join(homesRoot, "drawing");
  fs.mkdirSync(globalHome, { recursive: true });
  fs.mkdirSync(writing, { recursive: true });
  fs.mkdirSync(drawing, { recursive: true });
  fs.writeFileSync(path.join(writing, "config.toml"), [
    'model = "gpt-test"',
    'model_provider = "deepseek" # keep comment',
    "",
    "[model_providers.deepseek]",
    'name = "DeepSeek"',
    'base_url = "https://example.test/v1"',
    'wire_api = "responses"',
    'env_key = "DEEPSEEK_API_KEY"',
    "",
    "[mcp_servers.example]",
    'name = "Must not replace provider name"',
    'command = "node"',
    "",
  ].join("\n"), "utf8");
  return { root, globalHome, homesRoot, writing, drawing };
}

test("discovers future Codex Homes and deduplicates Bot bindings", () => {
  const value = fixture();
  try {
    const homes = discoverCodexHomes({
      globalHome: value.globalHome,
      roots: [value.homesRoot],
      bindings: [
        { codexHome: value.writing, source: "script", bot: { name: "writer-1", owner: "script" } },
        { codexHome: value.writing, source: "script", bot: { name: "writer-1", owner: "script" } },
      ],
    });
    assert.equal(homes.length, 3);
    assert.equal(homes.find((item) => item.codexHome === value.writing).bots.length, 1);
    assert.ok(homes.some((item) => item.codexHome === value.drawing));
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("switches between any discovered third-party Provider and built-in OpenAI without rewriting other sections", () => {
  const value = fixture();
  try {
    const options = { envValue: (name) => name === "DEEPSEEK_API_KEY" ? "available" : "" };
    const before = fs.readFileSync(path.join(value.writing, "config.toml"), "utf8");
    const preview = previewModelSourceSwitch(value.writing, "openai", options);
    assert.equal(preview.currentProvider, "deepseek");
    assert.equal(preview.providers[0].name, "DeepSeek");
    assert.equal(preview.targetKind, "openai");
    const applied = applyModelSourceSwitch(value.writing, "openai", options);
    const switched = fs.readFileSync(applied.configPath, "utf8");
    assert.match(switched, /^model_provider = "openai"$/m);
    assert.match(switched, /\[model_providers\.deepseek\]/);
    assert.match(switched, /\[mcp_servers\.example\]/);
    assert.equal(inspectCodexHome(value.writing, options).sourceKind, "openai");
    assert.equal(restoreModelSourceSwitch(applied), true);
    assert.equal(fs.readFileSync(applied.configPath, "utf8"), before);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects missing Providers or unavailable third-party credentials", () => {
  const value = fixture();
  try {
    assert.throws(() => previewModelSourceSwitch(value.writing, "missing"), /不存在/);
    assert.throws(() => previewModelSourceSwitch(value.writing, "deepseek", { envValue: () => "" }), /DEEPSEEK_API_KEY/);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("parses official Codex login status without exposing credentials", () => {
  assert.equal(parseLoginState("Logged in using ChatGPT", true), "signed-in");
  assert.equal(parseLoginState("Not logged in", false), "signed-out");
  assert.equal(parseLoginState("unexpected", false), "unknown");
});

test("clears and restores persisted Provider session overrides transactionally", () => {
  const value = fixture();
  const sessionPath = path.join(value.root, "sessions.json");
  const original = `${JSON.stringify({ chats: { chat: { sessions: [
    { id: "one", providerOverride: "deepseek", providerBundleOverride: "m2c-deepseek" },
    { id: "two", providerOverride: "", providerBundleOverride: "" },
  ] } } }, null, 2)}\n`;
  fs.writeFileSync(sessionPath, original, "utf8");
  try {
    assert.equal(inspectSessionOverrides([sessionPath]).overrideCount, 1);
    const result = clearSessionOverrides([sessionPath]);
    assert.equal(result.changed, 1);
    assert.equal(inspectSessionOverrides([sessionPath]).overrideCount, 0);
    restoreSessionOverrides(result);
    assert.equal(fs.readFileSync(sessionPath, "utf8"), original);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("starts official login with the exact Codex Home and never handles token data", () => {
  const value = fixture();
  const codexPath = path.join(value.root, "codex.exe");
  fs.writeFileSync(codexPath, "", "utf8");
  let invocation = null;
  const child = new EventEmitter();
  child.pid = 321;
  child.unref = () => {};
  const manager = createLoginManager({
    spawn: (command, args, options) => {
      invocation = { command, args, options };
      return child;
    },
  });
  try {
    const job = manager.start(codexPath, value.writing);
    assert.equal(job.status, "running");
    assert.equal(invocation.command, codexPath);
    assert.deepEqual(invocation.args, ["login"]);
    assert.equal(invocation.options.env.CODEX_HOME, value.writing);
    assert.equal(JSON.stringify(job).includes("token"), false);
    child.emit("exit", 0);
    assert.equal(manager.get(value.writing).status, "completed");
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});
