const assert = require("node:assert/strict");
const test = require("node:test");
const { assertSecureStorage, inspectSecureStorage } = require("../src/main/services/secure-storage.cjs");

test("accepts Linux Secret Service encryption", () => {
  const state = inspectSecureStorage({
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
  }, "linux");
  assert.equal(state.available, true);
  assert.equal(state.id, "linux-gnome_libsecret");
  assert.match(state.label, /Secret Service/);
});

test("rejects Electron basic_text fallback on Linux", () => {
  const storage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "basic_text",
  };
  const state = inspectSecureStorage(storage, "linux");
  assert.equal(state.available, false);
  assert.match(state.error, /basic_text/);
  assert.throws(() => assertSecureStorage(storage, "linux"), /basic_text/);
});

test("keeps native Windows and macOS storage labels", () => {
  const storage = { isEncryptionAvailable: () => true };
  assert.equal(inspectSecureStorage(storage, "win32").id, "windows-dpapi");
  assert.equal(inspectSecureStorage(storage, "darwin").id, "macos-keychain");
});
