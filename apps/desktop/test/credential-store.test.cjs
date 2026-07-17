const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createCredentialStore } = require("../src/main/services/credential-store.cjs");

test("credential store encrypts, hydrates, and removes Provider keys", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-credentials-"));
  const name = "CFB_TEST_PROVIDER_KEY";
  delete process.env[name];
  try {
    const store = createCredentialStore({
      root,
      encrypt: (value) => Buffer.from(`protected:${value}`, "utf8"),
      decrypt: (value) => value.toString("utf8").replace(/^protected:/, ""),
    });
    await store.set(name, "secret-value");
    assert.equal(await store.read(name), "secret-value");
    assert.notEqual(fs.readFileSync(store.credentialPath(name), "utf8"), "secret-value");
    delete process.env[name];
    assert.deepEqual(store.hydrate(), { loaded: [name], failed: [] });
    assert.equal(process.env[name], "secret-value");
    await store.set(name, null);
    assert.equal(fs.existsSync(store.credentialPath(name)), false);
    assert.equal(process.env[name], undefined);
  } finally {
    delete process.env[name];
    fs.rmSync(root, { recursive: true, force: true });
  }
});
