const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bridgeDesktop", Object.freeze({
  getState: () => ipcRenderer.invoke("desktop:get-state"),
  checkUpdate: () => ipcRenderer.invoke("desktop:check-update"),
  installUpdate: () => ipcRenderer.invoke("desktop:install-update"),
  openPath: (value) => ipcRenderer.invoke("desktop:open-path", value),
  copyPath: (value) => ipcRenderer.invoke("desktop:copy-path", value),
  previewBot: (value) => ipcRenderer.invoke("desktop:preview-bot", value),
  createBot: (value) => ipcRenderer.invoke("desktop:create-bot", value),
  registerBotWithQr: (value) => ipcRenderer.invoke("desktop:register-bot-qr", value),
  previewWorkspaceFactory: (value) => ipcRenderer.invoke("desktop:preview-workspace-factory", value),
  createWorkspaceFactoryQueue: (value) => ipcRenderer.invoke("desktop:create-workspace-factory-queue", value),
  registerWorkspaceFactoryBot: (value) => ipcRenderer.invoke("desktop:register-workspace-factory-bot", value),
  cancelRegistration: () => ipcRenderer.invoke("desktop:cancel-registration"),
  testProvider: (value) => ipcRenderer.invoke("desktop:test-provider", value),
  listProviderModels: (value) => ipcRenderer.invoke("desktop:list-provider-models", value),
  probeProvider: (value) => ipcRenderer.invoke("desktop:probe-provider", value),
  addGlobalProvider: (value) => ipcRenderer.invoke("desktop:add-global-provider", value),
  replaceGlobalProviderKey: (value) => ipcRenderer.invoke("desktop:replace-global-provider-key", value),
  previewGlobalProviderRemoval: (value) => ipcRenderer.invoke("desktop:preview-global-provider-removal", value),
  applyGlobalProviderRemoval: (value) => ipcRenderer.invoke("desktop:apply-global-provider-removal", value),
  previewProviderSync: () => ipcRenderer.invoke("desktop:preview-provider-sync"),
  applyProviderSync: () => ipcRenderer.invoke("desktop:apply-provider-sync"),
  startOpenAiLogin: (codexHome) => ipcRenderer.invoke("desktop:start-openai-login", codexHome),
  previewModelSourceSwitch: (value) => ipcRenderer.invoke("desktop:preview-model-source-switch", value),
  applyModelSourceSwitch: (value) => ipcRenderer.invoke("desktop:apply-model-source-switch", value),
  startBot: (name) => ipcRenderer.invoke("desktop:start-bot", name),
  stopBot: (name) => ipcRenderer.invoke("desktop:stop-bot", name),
  setBotAutoStart: (value) => ipcRenderer.invoke("desktop:set-bot-autostart", value),
  previewManagedRemoval: (value) => ipcRenderer.invoke("desktop:preview-managed-removal", value),
  applyManagedRemoval: (value) => ipcRenderer.invoke("desktop:apply-managed-removal", value),
  setSettings: (value) => ipcRenderer.invoke("desktop:set-settings", value),
  checkBotReadiness: (name) => ipcRenderer.invoke("desktop:check-bot-readiness", name),
  copyPermissionPolicy: (name) => ipcRenderer.invoke("desktop:copy-permission-policy", name),
  openFeishuConsole: (value) => ipcRenderer.invoke("desktop:open-feishu-console", value),
  authorizeLarkUser: (name) => ipcRenderer.invoke("desktop:authorize-lark-user", name),
  previewCapabilityMigration: (value) => ipcRenderer.invoke("desktop:preview-capability-migration", value),
  applyCapabilityMigration: (value) => ipcRenderer.invoke("desktop:apply-capability-migration", value),
  onRegistrationProgress: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("desktop:registration-progress", listener);
    return () => ipcRenderer.removeListener("desktop:registration-progress", listener);
  },
  onFactoryRegistrationProgress: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("desktop:factory-registration-progress", listener);
    return () => ipcRenderer.removeListener("desktop:factory-registration-progress", listener);
  },
  onUpdateState: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("desktop:update-state", listener);
    return () => ipcRenderer.removeListener("desktop:update-state", listener);
  },
}));
