function selectedBackend(safeStorage, platform = process.platform) {
  if (platform !== "linux") return platform === "darwin" ? "keychain" : "dpapi";
  try {
    return String(safeStorage.getSelectedStorageBackend?.() || "unknown");
  } catch {
    return "unknown";
  }
}

function inspectSecureStorage(safeStorage, platform = process.platform) {
  let encryptionAvailable = false;
  try { encryptionAvailable = safeStorage.isEncryptionAvailable() === true; } catch {}
  const backend = selectedBackend(safeStorage, platform);
  const insecureFallback = platform === "linux" && backend === "basic_text";
  const available = encryptionAvailable && !insecureFallback;
  const id = platform === "darwin"
    ? "macos-keychain"
    : (platform === "linux" ? `linux-${backend}` : "windows-dpapi");
  const label = platform === "darwin"
    ? "macOS Keychain"
    : (platform === "linux" ? `Linux Secret Service（${backend}）` : "Windows DPAPI");
  const error = insecureFallback
    ? "Linux 安全存储退化为 basic_text，已拒绝保存 Provider 密钥"
    : (!encryptionAvailable ? "系统安全存储暂不可用" : "");
  return { available, backend, encryptionAvailable, error, id, label };
}

function assertSecureStorage(safeStorage, platform = process.platform) {
  const state = inspectSecureStorage(safeStorage, platform);
  if (!state.available) throw new Error(state.error || "系统安全存储暂不可用");
  return state;
}

module.exports = { assertSecureStorage, inspectSecureStorage, selectedBackend };
