const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  createCredentialStore,
  waitForCredentialStoreHydration,
} = require("../src/main/services/credential-store.cjs");

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

test("waits for macOS credential storage before hydrating Provider keys", async () => {
  let availabilityChecks = 0;
  let createCalls = 0;
  const waits = [];
  const store = {
    hydrate: () => ({ loaded: ["LTHOME_API_KEY"], failed: [] }),
  };

  const result = await waitForCredentialStoreHydration({
    attempts: 4,
    delayMs: 250,
    isAvailable: () => {
      availabilityChecks += 1;
      return availabilityChecks >= 3;
    },
    createStore: () => {
      createCalls += 1;
      return store;
    },
    wait: async (duration) => { waits.push(duration); },
  });

  assert.equal(result.ready, true);
  assert.equal(result.attempt, 3);
  assert.equal(result.store, store);
  assert.deepEqual(result.hydration, { loaded: ["LTHOME_API_KEY"], failed: [] });
  assert.equal(createCalls, 1);
  assert.deepEqual(waits, [250, 250]);
});

test("bounds credential hydration retries when macOS storage stays unavailable", async () => {
  let createCalls = 0;
  let waitCalls = 0;
  const result = await waitForCredentialStoreHydration({
    attempts: 3,
    delayMs: 1,
    isAvailable: () => false,
    createStore: () => {
      createCalls += 1;
      return { hydrate: () => ({ loaded: [], failed: [] }) };
    },
    wait: async () => { waitCalls += 1; },
  });

  assert.equal(result.ready, false);
  assert.equal(result.attempt, 3);
  assert.equal(result.store, null);
  assert.equal(createCalls, 0);
  assert.equal(waitCalls, 2);
});
