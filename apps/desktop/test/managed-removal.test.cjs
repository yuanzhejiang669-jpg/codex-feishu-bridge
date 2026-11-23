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

test("T-015: protects shared antigravityHome and deletes it only when explicitly requested and unshared", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-remove-agy-"));
  const dataRoot = path.join(root, "data");
  const localAppData = path.join(root, "local");
  const workspaceRoot = path.join(root, "workspaces");
  const codexHomeRoot = path.join(root, "homes");
  const sharedAgyHome = path.join(dataRoot, "antigravity-homes", "shared");
  fs.mkdirSync(sharedAgyHome, { recursive: true });
  fs.writeFileSync(path.join(sharedAgyHome, "auth.json"), "{}");
  for (const name of ["ag-1", "ag-2"]) {
    const botRoot = path.join(dataRoot, "managed-bots", name);
    const workspace = path.join(workspaceRoot, name);
    fs.mkdirSync(botRoot, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(botRoot, "bot.json"), JSON.stringify({
      name, label: name, profile: name, engine: "antigravity", workspace, antigravityHome: sharedAgyHome,
    }));
  }
  const opts = {
    dataRoot, localAppData, workspaceRoot, codexHomeRoot,
    stopBot: async () => {}, startBot: async () => {}, removeProfile: async () => {},
  };
  try {
    const p1 = previewManagedBotRemoval("ag-1", opts);
    assert.equal(p1.sharedAntigravityHomeBotCount, 1);
    assert.equal(p1.paths.antigravityHome, sharedAgyHome);

    // Must refuse deleting shared antigravityHome while ag-2 still uses it
    await assert.rejects(
      applyManagedRemoval({ kind: "bot", id: "ag-1", deleteAntigravityHome: true }, opts),
      /共用/,
    );
    assert.equal(fs.existsSync(sharedAgyHome), true);

    // Removing ag-1 without deleteAntigravityHome succeeds and preserves shared home
    await applyManagedRemoval({ kind: "bot", id: "ag-1", deleteAntigravityHome: false }, opts);
    assert.equal(fs.existsSync(sharedAgyHome), true);

    // Now ag-2 is sole owner -> sharedAntigravityHomeBotCount === 0, deleteAntigravityHome succeeds
    const p2 = previewManagedBotRemoval("ag-2", opts);
    assert.equal(p2.sharedAntigravityHomeBotCount, 0);
    const r2 = await applyManagedRemoval({ kind: "bot", id: "ag-2", deleteAntigravityHome: true }, opts);
    assert.equal(r2.antigravityHomeDeleted, true);
    assert.equal(fs.existsSync(sharedAgyHome), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
