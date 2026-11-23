const bridge = window.bridgeDesktop;

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

export function formatIpcError(error) {
  const raw = String(error?.message || error || "操作失败").trim();
  return raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, "").trim() || "操作失败";
}

function invoke(methodName, ...args) {
  if (!bridge || typeof bridge[methodName] !== "function") {
    return Promise.reject(new Error(`桌面端 IPC 通道不可用：${methodName}`));
  }
  return bridge[methodName](...args);
}

export const api = Object.freeze({
  getVersion: () => invoke("getVersion"),
  getState: (options) => invoke("getState", options || {}),
  checkUpdate: () => invoke("checkUpdate"),
  installUpdate: () => invoke("installUpdate"),
  openPath: (value) => invoke("openPath", value),
  copyPath: (value) => invoke("copyPath", value),
  previewBot: (value) => invoke("previewBot", value),
  createBot: (value) => invoke("createBot", value),
  previewLegacyAdoption: (value) => invoke("previewLegacyAdoption", value),
  applyLegacyAdoption: (value) => invoke("applyLegacyAdoption", value),
  registerBotWithQr: (value) => invoke("registerBotWithQr", value),
  previewWorkspaceFactory: (value) => invoke("previewWorkspaceFactory", value),
  createWorkspaceFactoryQueue: (value) => invoke("createWorkspaceFactoryQueue", value),
  registerWorkspaceFactoryBot: (value) => invoke("registerWorkspaceFactoryBot", value),
  retryWorkspaceFactoryBot: (value) => invoke("retryWorkspaceFactoryBot", value),
  discardWorkspaceFactoryQueue: () => invoke("discardWorkspaceFactoryQueue"),
  cancelRegistration: () => invoke("cancelRegistration"),
  testProvider: (value) => invoke("testProvider", value),
  listProviderModels: (value) => invoke("listProviderModels", value),
  probeProvider: (value) => invoke("probeProvider", value),
  addGlobalProvider: (value) => invoke("addGlobalProvider", value),
  refreshProviderCapacity: (value) => invoke("refreshProviderCapacity", value),
  replaceGlobalProviderKey: (value) => invoke("replaceGlobalProviderKey", value),
  previewGlobalProviderRemoval: (value) => invoke("previewGlobalProviderRemoval", value),
  applyGlobalProviderRemoval: (value) => invoke("applyGlobalProviderRemoval", value),
  previewProviderSync: () => invoke("previewProviderSync"),
  applyProviderSync: () => invoke("applyProviderSync"),
  startOpenAiLogin: (codexHome) => invoke("startOpenAiLogin", codexHome),
  addOpenAiAccount: (input) => invoke("addOpenAiAccount", input),
  setBotOpenAiAccount: (input) => invoke("setBotOpenAiAccount", input),
  forgetOpenAiAccount: (input) => invoke("forgetOpenAiAccount", input),
  trustCodexHome: (codexHome) => invoke("trustCodexHome", codexHome),
  previewModelSourceSwitch: (value) => invoke("previewModelSourceSwitch", value),
  applyModelSourceSwitch: (value) => invoke("applyModelSourceSwitch", value),
  startBot: (name) => invoke("startBot", name),
  stopBot: (name) => invoke("stopBot", name),
  restartBots: (value) => invoke("restartBots", value),
  setBotAutoStart: (value) => invoke("setBotAutoStart", value),
  updateBotConfig: (value) => invoke("updateBotConfig", value),
  readBotLogs: (value) => invoke("readBotLogs", value),
  previewManagedRemoval: (value) => invoke("previewManagedRemoval", value),
  applyManagedRemoval: (value) => invoke("applyManagedRemoval", value),
  setSettings: (value) => invoke("setSettings", value),
  setOwnerOpenId: (value) => invoke("setOwnerOpenId", value),
  checkBotReadiness: (name) => invoke("checkBotReadiness", name),
  copyPermissionPolicy: (name) => invoke("copyPermissionPolicy", name),
  openFeishuConsole: (value) => invoke("openFeishuConsole", value),
  authorizeLarkUser: (name) => invoke("authorizeLarkUser", name),
  previewCapabilityMigration: (value) => invoke("previewCapabilityMigration", value),
  applyCapabilityMigration: (value) => invoke("applyCapabilityMigration", value),
  probeMcpHealth: () => invoke("probeMcpHealth"),
  claudeListModels: (value) => invoke("claudeListModels", value),
  claudeProbeProvider: (value) => invoke("claudeProbeProvider", value),
  claudeSaveProvider: (value) => invoke("claudeSaveProvider", value),
  claudeReplaceKey: (value) => invoke("claudeReplaceKey", value),
  claudeAssignProvider: (value) => invoke("claudeAssignProvider", value),
  claudeSaveMcp: (value) => invoke("claudeSaveMcp", value),
  claudeMigrateCapabilities: (value) => invoke("claudeMigrateCapabilities", value),
  antigravityListModels: (value) => invoke("antigravityListModels", value),
  antigravityProbeProvider: (value) => invoke("antigravityProbeProvider", value),
  antigravitySaveProvider: (value) => invoke("antigravitySaveProvider", value),
  antigravityCaptureAccount: (value) => invoke("antigravityCaptureAccount", value),
  antigravitySwitchAccount: (value) => invoke("antigravitySwitchAccount", value),
  antigravityOpenLogin: () => invoke("antigravityOpenLogin"),
  antigravitySaveMcp: (value) => invoke("antigravitySaveMcp", value),
  antigravityMigrateCapabilities: (value) => invoke("antigravityMigrateCapabilities", value),
  antigravityAssignProvider: (value) => invoke("antigravityAssignProvider", value),
});

export function subscribeEvents(handlers = {}) {
  const unsubscribers = [];
  if (bridge?.onRegistrationProgress && handlers.onRegistrationProgress) {
    unsubscribers.push(bridge.onRegistrationProgress(handlers.onRegistrationProgress));
  }
  if (bridge?.onFactoryRegistrationProgress && handlers.onFactoryRegistrationProgress) {
    unsubscribers.push(bridge.onFactoryRegistrationProgress(handlers.onFactoryRegistrationProgress));
  }
  if (bridge?.onBotRestartProgress && handlers.onBotRestartProgress) {
    unsubscribers.push(bridge.onBotRestartProgress(handlers.onBotRestartProgress));
  }
  if (bridge?.onUpdateState && handlers.onUpdateState) {
    unsubscribers.push(bridge.onUpdateState(handlers.onUpdateState));
  }
  return () => {
    for (const unsubscribe of unsubscribers) {
      try {
        unsubscribe?.();
      } catch {
        // ignore listener cleanup errors
      }
    }
  };
}
