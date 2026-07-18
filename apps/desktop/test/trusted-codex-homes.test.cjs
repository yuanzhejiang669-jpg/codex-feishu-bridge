const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  isTrustedCodexHome,
  readTrustedCodexHomes,
  registryPath,
  trustCodexHome,
} = require("../src/main/services/trusted-codex-homes.cjs");

function fixture(config = 'model_provider = "lthome"\n') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-trusted-home-"));
  const dataRoot = path.join(root, "data");
  const codexHome = path.join(root, "home");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), config, "utf8");
  return { root, dataRoot, codexHome, discoveredHomes: [{ codexHome }] };
}

test("trusts only an explicitly discovered, valid Codex Home and remains idempotent", () => {
  const value = fixture();
  try {
    const first = trustCodexHome(value.codexHome, value);
    const second = trustCodexHome(value.codexHome, value);
    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(isTrustedCodexHome(value.codexHome, value.dataRoot), true);
    assert.equal(readTrustedCodexHomes(value.dataRoot).length, 1);
    assert.equal(JSON.parse(fs.readFileSync(registryPath(value.dataRoot), "utf8")).schemaVersion, 1);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("adds a second trusted Home without losing the first registry entry", () => {
  const value = fixture();
  const secondHome = path.join(value.root, "second-home");
  fs.mkdirSync(secondHome);
  fs.writeFileSync(path.join(secondHome, "config.toml"), 'model_provider = "sub2api"\n', "utf8");
  try {
    trustCodexHome(value.codexHome, value);
    trustCodexHome(secondHome, { ...value, discoveredHomes: [...value.discoveredHomes, { codexHome: secondHome }] });
    assert.deepEqual(readTrustedCodexHomes(value.dataRoot).map((item) => path.basename(item.codexHome)).sort(), ["home", "second-home"]);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("refuses an undiscovered or invalid Codex Home", () => {
  const value = fixture("not valid = [\n");
  try {
    assert.throws(() => trustCodexHome(value.codexHome, { ...value, discoveredHomes: [] }), /不在客户端已发现范围/);
    assert.throws(() => trustCodexHome(value.codexHome, value), /config\.toml 无法解析/);
    assert.equal(fs.existsSync(registryPath(value.dataRoot)), false);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});
