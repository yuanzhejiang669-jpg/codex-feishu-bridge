const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { applyManagedRemoval, assertOwnedChild, isolatedSpaces, previewManagedBotRemoval } = require("../src/main/services/managed-removal.cjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-remove-"));
  const dataRoot = path.join(root, "data");
  const localAppData = path.join(root, "local");
  const workspaceRoot = path.join(root, "workspaces");
  const codexHomeRoot = path.join(root, "homes");
  const codexHome = path.join(codexHomeRoot, "drawing");
  for (const [index, name] of ["one", "two"].entries()) {
    const botRoot = path.join(dataRoot, "managed-bots", name);
    const workspace = path.join(workspaceRoot, name);
    fs.mkdirSync(botRoot, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(workspace, "user.txt"), "keep");
    fs.writeFileSync(path.join(botRoot, "bot.json"), JSON.stringify({
      name, label: name, profile: name, workspace, codexHome, codexHomeMode: "isolated",
      workspaceFactory: { spaceName: "画图", slug: "drawing" }, autoStart: index === 0,
    }));
  }
  return { root, dataRoot, localAppData, workspaceRoot, codexHomeRoot, codexHome };
}

test("groups managed Bots by isolated space and previews workspace preservation", () => {
  const value = fixture();
  try {
    assert.equal(isolatedSpaces(value.dataRoot)[0].bots.length, 2);
    const preview = previewManagedBotRemoval("one", value);
    assert.equal(preview.sharedCodexHomeBotCount, 1);
    assert.equal(preview.defaults.deleteWorkspaces, false);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("removes one Bot while preserving its workspace and shared Codex Home", async () => {
  const value = fixture();
  try {
    const result = await applyManagedRemoval({ kind: "bot", id: "one", deleteWorkspaces: false }, {
      ...value,
      stopBot: async () => {}, startBot: async () => {}, removeProfile: async () => {},
    });
    assert.deepEqual(result.removed, ["one"]);
    assert.equal(fs.existsSync(path.join(value.workspaceRoot, "one", "user.txt")), true);
    assert.equal(fs.existsSync(value.codexHome), true);
    assert.equal(fs.existsSync(path.join(value.dataRoot, "managed-bots", "one")), false);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("rejects deletion outside an owned root", () => {
  const root = path.join(os.tmpdir(), "owned");
  assert.throws(() => assertOwnedChild(root, path.dirname(root), "test"), /不在客户端允许删除/);
  assert.throws(() => assertOwnedChild(root, root, "test"), /不在客户端允许删除/);
});

test("rechecks active tasks when removal is applied", async () => {
  const value = fixture();
  const stateDir = path.join(value.localAppData, "CodexFeishuBridge", "instances", "one", "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "active-runs.json"), JSON.stringify({ runs: { current: {} } }), "utf8");
  try {
    await assert.rejects(() => applyManagedRemoval({ kind: "bot", id: "one" }, {
      ...value,
      stopBot: async () => { throw new Error("must not stop"); },
      startBot: async () => {},
      removeProfile: async () => { throw new Error("must not remove"); },
    }), /仍有活动任务/);
    assert.equal(fs.existsSync(path.join(value.dataRoot, "managed-bots", "one", "bot.json")), true);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});
