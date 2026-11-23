const { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, safeStorage, shell, Tray } = require("electron");
const { autoUpdater } = require("electron-updater");
const fs = require("node:fs");
const path = require("node:path");
const { inspectCodex } = require("./services/environment.cjs");
const { discoverBridge } = require("./services/bridge-discovery.cjs");
const { inspectCapabilities, inspectCapabilityHomes } = require("./services/capabilities.cjs");
const { inspectEngine } = require("./services/engine.cjs");
const { collectKnownPaths, isKnownPath } = require("./services/known-paths.cjs");
const { createManagedBot, previewBot, readManagedBots, runLarkCli } = require("./services/bot-setup.cjs");
const { registerBotWithQr } = require("./services/feishu-registration.cjs");
const { authorizeLarkUser } = require("./services/lark-user-auth.cjs");
const {
  inspectManagedBots,
  inspectManagedBotsAsync,
  runPowerShell,
  waitForMacosProviderEnvironment,
  restartSelectedManagedBots,
  setManagedBotAutoStart,
  startManagedBot,
  stopManagedBot,
  stopManagedBotAndDisableAutoStart,
} = require("./services/supervisor.cjs");
const {
  applyLegacyAdoption,
  previewLegacyAdoption,
  processPendingLegacyAdoptions,
} = require("./services/legacy-adoption.cjs");
const { checkBotReadiness } = require("./services/bot-readiness.cjs");
const { permissionImportJson, publicPermissionPolicy } = require("./services/permission-policy.cjs");
const { createRecoverySupervisor } = require("./services/recovery-supervisor.cjs");
const { readDesktopSettings, setOwnerOpenId, writeDesktopSettings } = require("./services/desktop-settings.cjs");
const { updateManagedBotConfig } = require("./services/bot-config-editor.cjs");
const { readBotLogs } = require("./services/bot-logs.cjs");
const { probeMcpHealth } = require("./services/mcp-health.cjs");
const { createDesktopStartup } = require("./services/windows-startup.cjs");
const { createCredentialStore, waitForCredentialStoreHydration } = require("./services/credential-store.cjs");
const { assertSecureStorage, inspectSecureStorage } = require("./services/secure-storage.cjs");
const { applyCapabilityMigration, previewCapabilityMigration } = require("./services/capability-migration.cjs");
const { inspectProvider, testProvider } = require("./services/provider-setup.cjs");
const { reasoningRegistry, resolveModelCapabilities } = require("./services/reasoning-effort.cjs");
const {
  applyDesktopModelSourceSwitch,
  listDesktopModelSources,
  previewDesktopModelSourceSwitch,
  startDesktopOpenAiLogin,
  trustDesktopCodexHome,
} = require("./services/model-source.cjs");
const {
  addGlobalProvider,
  applyGlobalProviderRemoval,
  inspectProviderCatalog,
  listProviderModels,
  probeProvider,
  previewGlobalProviderRemoval,
  providerSyncPlan,
  readUserEnvironmentVariable,
  replaceGlobalProviderKey,
  refreshProviderCapacity,
  refreshProviderCapacities,
} = require("./services/provider-manager.cjs");
const { createProtocolProxyService } = require("./services/protocol-proxy.cjs");
const {
  applyManagedRemoval,
  isolatedSpaces,
  previewManagedBotRemoval,
  previewManagedSpaceRemoval,
} = require("./services/managed-removal.cjs");
const { inspectDataSchema, migrateDesktopData } = require("./services/data-migrations.cjs");
const { assessCompatibility } = require("./services/compatibility.cjs");
const { createUpdaterService } = require("./services/updater.cjs");
const { assessUpdateSupport } = require("./services/update-support.cjs");
const { createLinuxReleaseUpdater } = require("./services/linux-release-updater.cjs");
const {
  clearRecoveryMarker,
  restoreUpdateBots,
  writeRecoveryMarker,
} = require("./services/update-recovery.cjs");
const {
  createWorkspaceFactoryQueue,
  discardFactoryQueue,
  previewWorkspaceFactory,
  readWorkspaceFactoryQueue,
  registerFactoryBot,
  retryFactoryBot,
} = require("./services/workspace-factory.cjs");
const { createOperationCoordinator } = require("./services/operation-coordinator.cjs");
const { readTrustedCodexHomes } = require("./services/trusted-codex-homes.cjs");
const { startAccountLogin, setBotAccount, forgetAccount } = require("./services/openai-accounts.cjs");
const { createWindowReadiness } = require("./services/window-readiness.cjs");
const { inspectClaudeRuntime } = require('./services/agent-engines.cjs');
const { inspectAntigravityRuntime, inspectAntigravity, listAntigravityModels, probeAntigravityProvider,
  saveAntigravityProvider, captureAntigravityAccount, switchAntigravityAccount,
  inspectAntigravityClients, openAntigravityLogin, assignAntigravityProvider } = require('./services/antigravity.cjs');
const { inspectClaudeProviders, listClaudeModels, probeClaudeProvider, saveClaudeProvider,
  replaceClaudeProviderKey } = require('./services/claude-providers.cjs');
const { assignClaudeProvider } = require('./services/claude-bots.cjs');
const { inspectClaudeCapabilities, migrateClaudeCapabilities, saveClaudeMcp } = require('./services/claude-capabilities.cjs');
const { queueClaudeReconfiguration, processClaudeReconfiguration, readPending: readClaudePending } = require('./services/claude-reconfiguration.cjs');
const { queueCodexBotReload, queueCodexCredentialReload, processCodexCredentialReload, readPendingCodexReload } = require('./services/codex-reconfiguration.cjs');

const smokeTest = process.argv.includes("--smoke-test");
const capturePath = process.env.CFB_DESKTOP_CAPTURE_PATH || "";
const captureSetup = process.env.CFB_DESKTOP_CAPTURE_SETUP === "1";
const captureView = String(process.env.CFB_DESKTOP_CAPTURE_VIEW || "").trim();
const captureReadiness = process.env.CFB_DESKTOP_CAPTURE_READINESS === "1";
const captureProviderRemoval = process.env.CFB_DESKTOP_CAPTURE_PROVIDER_REMOVAL === "1";
const captureDataRoot = capturePath
  ? String(process.env.CFB_DESKTOP_CAPTURE_DATA_ROOT || "").trim()
  : "";
const backgroundStart = process.argv.includes("--background");

if (!app.isPackaged || smokeTest || capturePath) {
  app.setPath("userData", path.join(process.env.LOCALAPPDATA || app.getPath("appData"), "CodexFeishuBridgeDesktopDev"));
}
if (capturePath && process.env.CFB_DESKTOP_CAPTURE_HOME) {
  const isolatedHome = path.resolve(process.env.CFB_DESKTOP_CAPTURE_HOME);
  fs.mkdirSync(isolatedHome, { recursive: true });
  app.setPath('home', isolatedHome);
}

const singleInstance = capturePath ? true : app.requestSingleInstanceLock();
let mainWindow = null;
let currentState = null;
let legacyAdoptionInFlight = false;
let legacyAdoptionTimer = null;
let cancelRegistration = null;
let activeLarkAuthorization = null;
let startupError = "";
let tray = null;
let isQuitting = false;
let recoverySupervisor = null;
let updaterService = null;
let protocolProxyService = null;
let proxyStoppedForQuit = false;
let desktopSettings = { launchAtLogin: false, closeToTray: true, error: "" };
const desktopStartup = createDesktopStartup(app);
let providerCredentialStore = null;
let claudeCredentialStore = null;
let antigravityCredentialStore = null;
let claudeConfigurationTimer = null;
let runtimeInitializing = true;
let batchRestartInFlight = false;

async function initializeClaudeCredentialStore() {
  const root = path.join(managedDataRoot(), 'claude-provider-credentials');
  claudeCredentialStore = createCredentialStore({ root,
    encrypt: (value) => { assertSecureStorage(safeStorage, process.platform); return safeStorage.encryptString(value); },
    decrypt: (value) => { assertSecureStorage(safeStorage, process.platform); return safeStorage.decryptString(value); } });
  if (!fs.existsSync(root) || !fs.readdirSync(root).some((name) => name.endsWith('.bin'))) return;
  const result = await waitForCredentialStoreHydration({ attempts: 61, delayMs: 1_000,
    isAvailable: () => inspectSecureStorage(safeStorage, process.platform).available,
    createStore: () => claudeCredentialStore });
  if (!result.ready || result.hydration.failed.length) throw new Error('Claude Provider 安全凭据未能解锁，请检查系统凭据存储');
}

async function initializeAntigravityCredentialStore() {
  const root = path.join(managedDataRoot(), 'antigravity-provider-credentials');
  antigravityCredentialStore = createCredentialStore({ root,
    encrypt: (value) => { assertSecureStorage(safeStorage, process.platform); return safeStorage.encryptString(value); },
    decrypt: (value) => { assertSecureStorage(safeStorage, process.platform); return safeStorage.decryptString(value); } });
  if (!fs.existsSync(root) || !fs.readdirSync(root).some((name) => name.endsWith('.bin'))) return;
  const result = await waitForCredentialStoreHydration({ attempts: 61, delayMs: 1_000,
    isAvailable: () => inspectSecureStorage(safeStorage, process.platform).available,
    createStore: () => antigravityCredentialStore });
  if (!result.ready || result.hydration.failed.length) throw new Error('Antigravity 渠道安全凭据未能解锁');
}

async function initializeProtectedProviderCredentialStore() {
  if (!new Set(["darwin", "linux"]).has(process.platform)) return;
  const credentialRoot = path.join(managedDataRoot(), "provider-credentials");
  providerCredentialStore = createCredentialStore({
    root: credentialRoot,
    encrypt: (value) => {
      assertSecureStorage(safeStorage, process.platform);
      return safeStorage.encryptString(value);
    },
    decrypt: (value) => {
      assertSecureStorage(safeStorage, process.platform);
      return safeStorage.decryptString(value);
    },
  });
  let hasStoredCredentials = false;
  try {
    hasStoredCredentials = fs.readdirSync(credentialRoot).some((name) => name.endsWith(".bin"));
  } catch {}
  if (!hasStoredCredentials) return;

  const result = await waitForCredentialStoreHydration({
    attempts: 61,
    delayMs: 1_000,
    isAvailable: () => inspectSecureStorage(safeStorage, process.platform).available,
    createStore: () => providerCredentialStore,
  });
  if (!result.ready) {
    const failedNames = result.hydration.failed.map((item) => item.name).filter(Boolean);
    console.warn("Provider credentials were not ready before startup timeout", {
      attempts: result.attempt,
      failedNames,
    });
  }

}

async function initializeMacProviderEnvironment() {
  if (process.platform !== "darwin") return;
  const result = await waitForMacosProviderEnvironment(
    path.join(app.getPath("home"), ".codex"),
    {
      attempts: backgroundStart ? 61 : 1,
      delayMs: 1_000,
      environment: process.env,
      platform: process.platform,
    },
  );
  if (!result.ready) {
    console.warn("macOS Provider environment was not ready before startup timeout", {
      attempts: result.attempt,
      missingNames: result.missingNames,
    });
  }
}

function assertStartupReady() {
  if (startupError) throw new Error(`客户端数据初始化失败：${startupError}`);
}

function managedDataRoot() {
  if (captureDataRoot) return path.resolve(captureDataRoot);
  if (!app.isPackaged) return app.getPath("userData");
  return path.join(process.env.LOCALAPPDATA || app.getPath("appData"), "CodexFeishuBridgeDesktop");
}

function workspaceRoot() {
  if (!app.isPackaged) return path.join(managedDataRoot(), "workspaces");
  return path.join(app.getPath("documents"), "Codex", "workspaces");
}

function codexHomeRoot() {
  if (!app.isPackaged) return path.join(managedDataRoot(), "codex-homes");
  return path.join(app.getPath("documents"), "Codex", "codex-homes");
}

function runtimeLocalAppData() {
  return path.join(managedDataRoot(), "runtime-localappdata");
}

function readAutoBoundOwnerOpenId(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    const value = String(raw?.primaryOwnerOpenId || raw?.ownerOpenId || "").trim();
    return /^ou_[A-Za-z0-9]+$/.test(value) ? value : "";
  } catch {
    return "";
  }
}

function inspectDesktopSettings() {
  const root = managedDataRoot();
  const saved = readDesktopSettings(root);
  const login = desktopStartup.inspect();
  const autoBoundOwnerOpenIds = {
    claude: readAutoBoundOwnerOpenId(path.join(root, "claude-shared-sessions", "owner.json")),
    antigravity: readAutoBoundOwnerOpenId(path.join(root, "antigravity-shared-sessions", "owner.json")),
  };
  const autoBoundOwnerOpenId = autoBoundOwnerOpenIds.antigravity || autoBoundOwnerOpenIds.claude || "";
  return {
    ...saved,
    autoBoundOwnerOpenId,
    autoBoundOwnerOpenIds,
    launchAtLogin: login.supported ? login.enabled : saved.launchAtLogin,
    launchAtLoginSupported: login.supported,
    trayAvailable: Boolean(tray),
  };
}

function setupOptions() {
  const secureStorage = inspectSecureStorage(safeStorage, process.platform);
  return {
    userHome: app.getPath('home'),
    dataRoot: managedDataRoot(),
    workspaceRoot: workspaceRoot(),
    codexHomeRoot: codexHomeRoot(),
    defaultCodexHome: path.join(app.getPath("home"), ".codex"),
    sourceCodexHome: path.join(app.getPath("home"), ".codex"),
    runtimeLocalAppData: runtimeLocalAppData(),
    codexPath: currentState?.codex?.runtimePath || "",
    larkCliPath: currentState?.engine?.larkCliPath || "",
    existingNames: currentState?.bridge?.instances?.map((item) => item.name) || [],
    encryptSecret: (value) => {
      assertSecureStorage(safeStorage, process.platform);
      return safeStorage.encryptString(value);
    },
    credentialStorage: secureStorage.id,
  };
}

function supervisorOptions() {
  return {
    userHome: app.getPath('home'),
    claudePath: currentState?.claude?.runtimePath || '',
    antigravityPath: currentState?.antigravity?.runtimePath || '',
    resolveCodex: () => inspectCodex(detectorScriptPath(), { home: app.getPath('home') }),
    dataRoot: managedDataRoot(),
    localAppData: runtimeLocalAppData(),
    engineRoot: currentState?.engine?.engineRoot || "",
    nodePath: currentState?.engine?.nodePath || "",
    larkCliPath: currentState?.engine?.larkCliPath || "",
    bridgeEntry: currentState?.engine?.bridgeEntry || "",
    codexPath: currentState?.codex?.runtimePath || "",
    platform: process.platform,
    defaultCodexHome: path.join(app.getPath("home"), ".codex"),
    codexAvailable: Boolean(currentState?.codex?.runtimeFound),
    decryptSecret: (value) => {
      assertSecureStorage(safeStorage, process.platform);
      return safeStorage.decryptString(value);
    },
  };
}

function migrationOptions() {
  return {
    dataRoot: managedDataRoot(),
    sourceCodexHome: path.join(app.getPath("home"), ".codex"),
    sharedSkillsRoot: path.join(app.getPath("documents"), "Codex", "skill-sources", "shared"),
  };
}

function providerManagerOptions() {
  const options = {
    codexHome: path.join(app.getPath("home"), ".codex"),
    dataRoot: managedDataRoot(),
    timeoutMs: 30_000,
    catalogTimeoutMs: 15_000,
    codexPath: currentState?.codex?.runtimePath || "",
    decryptSecret: (value) => {
      assertSecureStorage(safeStorage, process.platform);
      return safeStorage.decryptString(value);
    },
    prepareProtocolProxyProvider: (provider, model, models) => protocolProxyService?.prepareProvider(provider, model, models),
    prepareProtocolProxyRemoval: (id) => protocolProxyService?.prepareProviderRemoval(id),
    restartProtocolProxy: (providerId) => providerId
      ? protocolProxyService?.restartProvider(providerId)
      : protocolProxyService?.restart(),
    decorateProviderCatalog: (catalog) => protocolProxyService?.decorateCatalog(catalog) || catalog,
  };
  if (providerCredentialStore) {
    options.readUserEnvironmentVariable = providerCredentialStore.read;
    options.setUserEnvironmentVariable = providerCredentialStore.set;
  }
  return options;
}

function claudeOptions() {
  return { dataRoot: managedDataRoot(), userHome: app.getPath('home'),
    sourceCodexHome: path.join(app.getPath('home'), '.codex'),
    env: process.env, timeoutMs: 30_000,
    readCredential: async (name) => {
      if (!claudeCredentialStore) throw new Error('安全凭据存储尚未初始化');
      return claudeCredentialStore.read(name);
    },
    setCredential: async (name, value) => {
      assertSecureStorage(safeStorage, process.platform);
      if (!claudeCredentialStore) throw new Error('安全凭据存储尚未初始化');
      return claudeCredentialStore.set(name, value);
    } };
}

function antigravityOptions() {
  return { dataRoot: managedDataRoot(), userHome: app.getPath('home'), platform: process.platform,
    sourceCodexHome: path.join(app.getPath('home'), '.codex'), toolEngine: 'antigravity',
    engineRoot: currentState?.engine?.engineRoot || '', antigravityPath: currentState?.antigravity?.runtimePath || '',
    environment: process.env,
    readCredential: (name) => {
      if (!antigravityCredentialStore) throw new Error('安全凭据存储尚未初始化');
      return antigravityCredentialStore.read(name);
    },
    setCredential: (name, value) => {
      if (!antigravityCredentialStore) throw new Error('安全凭据存储尚未初始化');
      return antigravityCredentialStore.set(name, value);
    },
    encrypt: (value) => { assertSecureStorage(safeStorage, process.platform); return safeStorage.encryptString(value); },
    decrypt: (value) => { assertSecureStorage(safeStorage, process.platform); return safeStorage.decryptString(value); },
    inspectBots: () => inspectManagedBotsAsync(managedDataRoot(), runtimeLocalAppData()),
    inspectExternalClients: inspectAntigravityClients };
}

const operationCoordinator = createOperationCoordinator({
  pauseRecovery: () => recoverySupervisor?.stop(),
  resumeRecovery: () => { if (!isQuitting) recoverySupervisor?.start(); },
});

async function applyPendingAntigravityConfiguration() {
  if (runtimeInitializing || isQuitting || !Object.keys(readClaudePending(managedDataRoot(), 'antigravity').bots).length) return;
  return operationCoordinator.runExclusive('apply-antigravity-reconfiguration', async () => {
    if (runtimeInitializing || isQuitting || !Object.keys(readClaudePending(managedDataRoot(), 'antigravity').bots).length) return;
    await processClaudeReconfiguration({
      dataRoot: managedDataRoot(),
      engine: 'antigravity',
      inspectBots: () => inspectManagedBots(managedDataRoot(), runtimeLocalAppData()),
      stopBot: (name) => stopManagedBot(name, supervisorOptions()),
      startBot: (name) => startManagedBot(name, supervisorOptions()),
    });
  });
}

function queueClaudeProviderUsers(providerId) {
  const names = readManagedBots(managedDataRoot()).filter((bot) => bot.engine === 'claude' && bot.provider?.id === providerId).map((bot) => bot.name);
  return queueClaudeReconfiguration(managedDataRoot(), names);
}

async function applyPendingClaudeConfiguration() {
  if (runtimeInitializing || isQuitting || !Object.keys(readClaudePending(managedDataRoot()).bots).length) return;
  return operationCoordinator.runExclusive('apply-claude-reconfiguration', async () => {
    if (runtimeInitializing || isQuitting || !Object.keys(readClaudePending(managedDataRoot()).bots).length) return;
    await processClaudeReconfiguration({
      dataRoot: managedDataRoot(),
      inspectBots: () => inspectManagedBots(managedDataRoot(), runtimeLocalAppData()),
      stopBot: (name) => stopManagedBot(name, supervisorOptions()),
      startBot: (name) => startManagedBot(name, supervisorOptions()),
    });
  });
}

async function applyPendingCodexConfiguration() {
  if (runtimeInitializing || isQuitting || !Object.keys(readPendingCodexReload(managedDataRoot()).bots).length) return;
  return operationCoordinator.runExclusive('apply-codex-reconfiguration', async () => {
    if (runtimeInitializing || isQuitting || !Object.keys(readPendingCodexReload(managedDataRoot()).bots).length) return;
    await processCodexCredentialReload({
      dataRoot: managedDataRoot(),
      inspectBots: () => inspectManagedBots(managedDataRoot(), runtimeLocalAppData()),
      stopBot: (name) => stopManagedBot(name, supervisorOptions()),
      startBot: (name) => startManagedBot(name, supervisorOptions()),
    });
  });
}
function queueCodexProviderReload(result) {
  if (result.managedProxy || result.provider?.managedProxy) return result;
  try { result.queuedManagedBots = queueCodexCredentialReload(managedDataRoot(), readManagedBots(managedDataRoot()), result.provider.envKey); }
  catch { result.reloadError = '已保存新密钥，但写入 Bot 空闲重载队列失败；请手动安全重启受影响的 Codex Bot。'; }
  return result;
}
async function applyPendingProviderConfiguration() {
  await applyPendingClaudeConfiguration();
  await applyPendingCodexConfiguration();
  await applyPendingAntigravityConfiguration();
}

function modelSourceOptions() {
  return {
    dataRoot: managedDataRoot(),
    localAppData: runtimeLocalAppData(),
    codexHomeRoot: codexHomeRoot(),
    defaultCodexHome: path.join(app.getPath("home"), ".codex"),
    engineRoot: currentState?.engine?.engineRoot || "",
    codexPath: currentState?.codex?.runtimePath || "",
    envValue: (name) => process.env[name] || "",
    supervisorOptions: supervisorOptions(),
  };
}

function workspaceFactoryOptions() {
  return {
    dataRoot: managedDataRoot(),
    workspaceRoot: workspaceRoot(),
    codexHomeRoot: codexHomeRoot(),
    sourceCodexHome: path.join(app.getPath("home"), ".codex"),
    existingNames: currentState?.bridge?.instances?.map((item) => item.name) || [],
    trustedCodexHomes: readTrustedCodexHomes(managedDataRoot()).map((item) => item.codexHome),
  };
}

function removalOptions() {
  return {
    dataRoot: managedDataRoot(),
    localAppData: runtimeLocalAppData(),
    workspaceRoot: workspaceRoot(),
    codexHomeRoot: codexHomeRoot(),
    stopBot: (name) => stopManagedBot(name, supervisorOptions()),
    startBot: (name) => startManagedBot(name, supervisorOptions()),
    removeProfile: (bot) => runLarkCli(currentState?.engine?.larkCliPath || "", ["profile", "remove", bot.profile], {
      profileHome: path.join(managedDataRoot(), "profile-home"),
    }),
  };
}

function legacyAdoptionOptions() {
  const legacyLocalAppData = process.env.LOCALAPPDATA || app.getPath("appData");
  return {
    dataRoot: managedDataRoot(),
    runtimeLocalAppData: runtimeLocalAppData(),
    legacyLocalAppData,
    sourceProfileHome: app.getPath("home"),
    targetProfileHome: path.join(managedDataRoot(), "profile-home"),
    defaultCodexHome: path.join(app.getPath("home"), ".codex"),
    stopLegacy: (name) => runPowerShell(
      path.join(currentState?.engine?.engineRoot || "", "stop-codex-feishu-bridge.ps1"),
      name === "default" ? [] : ["-Name", name],
      { env: { ...process.env, LOCALAPPDATA: legacyLocalAppData }, timeoutMs: 30_000 },
    ),
    startManaged: (name) => startManagedBot(name, supervisorOptions()),
    stopManaged: (name) => stopManagedBot(name, { ...supervisorOptions(), force: true }),
  };
}

async function processPendingLegacyAdoptionQueue() {
  if (!currentState?.engine?.available) return;
  return operationCoordinator.runExclusive("pending-legacy-adoption", async () => {
    try {
      const result = await processPendingLegacyAdoptions(legacyAdoptionOptions());
      if (result.adopted.length || result.failed.length) await loadState({ force: true });
    } catch (error) {
      console.warn("Pending legacy Bot adoption failed", error);
    }
  });
}

function readinessOptions() {
  return {
    dataRoot: managedDataRoot(),
    larkCliPath: currentState?.engine?.larkCliPath || "",
    codexAvailable: Boolean(currentState?.codex?.runtimeFound),
    claudeAvailable: Boolean(currentState?.claude?.available),
    claudeProviders: currentState?.claudeProviders,
    antigravityAvailable: Boolean(currentState?.antigravity?.available),
    antigravityProviders: currentState?.antigravityConfiguration,
    engineAvailable: Boolean(currentState?.engine?.available),
    currentProvider: currentState?.provider || {},
    codexLoginState: currentState?.codex?.loginState || "unknown",
    runtimeBots: currentState?.setup?.managedBots || [],
  };
}

function sendUpdateState(value) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("desktop:update-state", value);
  }
}

async function prepareUpdateInstall(restartNames, targetVersion) {
  return operationCoordinator.runExclusive("prepare-update-install", async () => {
    writeRecoveryMarker(managedDataRoot(), restartNames, targetVersion);
    const stoppedNames = [];
    try {
      for (const name of restartNames) {
        await stopManagedBot(name, supervisorOptions());
        stoppedNames.push(name);
      }
      await protocolProxyService?.stop();
    } catch (error) {
      for (const name of stoppedNames) {
        try { await startManagedBot(name, supervisorOptions()); } catch {}
      }
      clearRecoveryMarker(managedDataRoot());
      await protocolProxyService?.start().catch(() => {});
      throw error;
    }
    return {
      rollback: async () => {
        for (const name of stoppedNames) {
          try { await startManagedBot(name, supervisorOptions()); } catch {}
        }
        clearRecoveryMarker(managedDataRoot());
        await protocolProxyService?.start().catch(() => {});
      },
    };
  });
}

function createDesktopUpdater() {
  const updateSupport = assessUpdateSupport({
    packaged: app.isPackaged,
    smokeTest,
    captureMode: Boolean(capturePath),
    platform: process.platform,
    arch: process.arch,
    executablePath: process.execPath,
  });
  const platformUpdater = process.platform === "linux"
    ? createLinuxReleaseUpdater({
        currentVersion: app.getVersion(),
        cacheRoot: path.join(app.getPath("userData"), "updates"),
        helperPath: app.isPackaged
          ? path.join(process.resourcesPath, "scripts", "install-linux-update.sh")
          : path.join(__dirname, "..", "..", "resources", "scripts", "install-linux-update.sh"),
        executablePath: process.execPath,
        logPath: path.join(managedDataRoot(), "logs", "linux-update.log"),
        quit: () => {
          isQuitting = true;
          app.quit();
        },
      })
    : autoUpdater;
  return createUpdaterService({
    supported: updateSupport.supported,
    unsupportedReason: updateSupport.reason,
    updater: platformUpdater,
    currentVersion: app.getVersion(),
    inspectBots: async () => inspectManagedBotsAsync(managedDataRoot(), runtimeLocalAppData()),
    prepareInstall: prepareUpdateInstall,
    onState: sendUpdateState,
  });
}

async function initializeDesktopRuntime(initialStatePromise) {
  await initialStatePromise;
  const proxyCliPath = app.isPackaged
    ? path.join(process.resourcesPath, "proxy", "node_modules", "mimo2codex", "dist", "cli.js")
    : path.join(__dirname, "..", "..", "..", "proxy-runtime", "node_modules", "mimo2codex", "dist", "cli.js");
  protocolProxyService = createProtocolProxyService({
    dataRoot: managedDataRoot(),
    nodePath: currentState?.engine?.nodePath || "",
    proxyCliPath,
    readUserEnvironmentVariable: providerCredentialStore?.read || readUserEnvironmentVariable,
    resolveModelCapabilities,
  });
  createTray();
  await protocolProxyService.start().catch(() => {});
  updaterService = createDesktopUpdater();
  if (!startupError && app.isPackaged) {
    recoverySupervisor = createManagedRecoverySupervisor();
    void restoreUpdateBots(managedDataRoot(), async (name) => {
      await loadState();
      await startManagedBot(name, supervisorOptions());
    }).finally(() => recoverySupervisor?.start());
    legacyAdoptionTimer = setInterval(() => { void processPendingLegacyAdoptionQueue(); }, 15_000);
    legacyAdoptionTimer.unref?.();
    void processPendingLegacyAdoptionQueue();
  }
  updaterService.start();
}

function managedBotForAction(name) {
  const normalized = String(name || "").trim();
  const bot = readManagedBots(managedDataRoot()).find((item) => item.name === normalized);
  if (!bot) throw new Error(`找不到客户端创建的 Bot：${normalized}`);
  return bot;
}

function feishuConsoleUrl(appId, section, brand = "feishu") {
  if (!/^cli_[A-Za-z0-9]+$/.test(String(appId || ""))) throw new Error("飞书 App ID 无效");
  const suffix = section === "event" ? "event" : "permission";
  const host = String(brand || "").toLowerCase() === "lark" ? "open.larksuite.com" : "open.feishu.cn";
  return `https://${host}/app/${encodeURIComponent(appId)}/${suffix}`;
}

function detectorScriptPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "scripts", "detect-codex.ps1")
    : path.join(__dirname, "..", "..", "resources", "scripts", "detect-codex.ps1");
}

const COLD_CACHE_TTL_MS = 60_000;
let coldStateCache = null;

async function loadState({ force = false } = {}) {
  const desktopRoot = path.join(__dirname, "..", "..");
  const userHome = app.getPath("home");
  const defaultCodexHome = path.join(userHome, ".codex");
  const useColdCache = !force && coldStateCache && (Date.now() - coldStateCache.at < COLD_CACHE_TTL_MS);

  let cold = coldStateCache;
  if (!useColdCache) {
    const [codex, bridge, engine, capabilities, claude, antigravity] = await Promise.all([
      inspectCodex(detectorScriptPath()),
      Promise.resolve(discoverBridge(process.platform === "win32" ? undefined : path.join(runtimeLocalAppData(), "CodexFeishuBridge"))),
      inspectEngine({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, desktopRoot }),
      Promise.resolve(inspectCapabilities()),
      inspectClaudeRuntime({ userHome }),
      inspectAntigravityRuntime({ userHome }),
    ]);
    const providerCatalog = inspectProviderCatalog(defaultCodexHome);
    const provider = inspectProvider(defaultCodexHome);
    const claudeCapabilities = inspectClaudeCapabilities(claudeOptions());
    const antigravityCapabilities = inspectClaudeCapabilities(antigravityOptions());
    cold = {
      at: Date.now(),
      codex,
      bridge,
      engine,
      capabilities,
      claude,
      antigravity,
      providerCatalog,
      provider,
      claudeCapabilities,
      antigravityCapabilities,
      modelSources: null,
    };
    coldStateCache = cold;
  }

  const managedBots = await inspectManagedBotsAsync(managedDataRoot(), runtimeLocalAppData());
  if (!useColdCache || !cold.capabilityHomes) {
    cold.capabilityHomes = inspectCapabilityHomes([
      cold.capabilities.codexHome,
      ...managedBots.filter((bot) => !['claude', 'antigravity'].includes(bot.engine)).map((bot) => bot.codexHome),
    ]);
  }
  const capabilityHomes = cold.capabilityHomes;
  const secureStorage = inspectSecureStorage(safeStorage, process.platform);
  currentState = {
    claude: cold.claude,
    claudeProviders: inspectClaudeProviders(managedDataRoot()),
    claudeCapabilities: cold.claudeCapabilities,
    claudePendingConfiguration: readClaudePending(managedDataRoot()),
    antigravity: cold.antigravity,
    antigravityConfiguration: inspectAntigravity(antigravityOptions()),
    antigravityCapabilities: cold.antigravityCapabilities,
    antigravityPendingConfiguration: readClaudePending(managedDataRoot(), 'antigravity'),
    codexPendingConfiguration: readPendingCodexReload(managedDataRoot()),
    generatedAt: new Date().toISOString(),
    app: {
      version: app.getVersion(),
      packaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      credentialStorage: secureStorage.label,
      credentialStorageAvailable: secureStorage.available,
      credentialStorageError: secureStorage.error,
    },
    codex: cold.codex,
    bridge: cold.bridge,
    engine: cold.engine,
    capabilities: cold.capabilities,
    provider: cold.provider,
    providerCatalog: protocolProxyService?.decorateCatalog(cold.providerCatalog) || cold.providerCatalog,
    settings: inspectDesktopSettings(),
    setup: {
      mode: app.isPackaged ? "production" : "development-sandbox",
      dataRoot: managedDataRoot(),
      workspaceRoot: workspaceRoot(),
      codexHomeRoot: codexHomeRoot(),
      runtimeLocalAppData: runtimeLocalAppData(),
      managedBots,
      capabilityHomes,
      managedSpaces: isolatedSpaces(managedDataRoot()),
      permissionPolicy: publicPermissionPolicy(),
      dataSchema: inspectDataSchema(managedDataRoot()),
      startupError,
      recovery: recoverySupervisor?.snapshot() || {},
      coordinator: operationCoordinator.snapshot(),
      workspaceFactory: readWorkspaceFactoryQueue(managedDataRoot()),
      reasoningCapabilities: reasoningRegistry(),
      protocolProxy: protocolProxyService?.snapshot() || { supported: false, status: "unavailable", providerCount: 0 },
    },
    update: updaterService?.snapshot() || {
      supported: false,
      status: "unsupported",
      currentVersion: app.getVersion(),
    },
  };
  if (!useColdCache || !cold.modelSources) {
    cold.modelSources = await listDesktopModelSources(modelSourceOptions());
  }
  currentState.modelSources = cold.modelSources;
  currentState.compatibility = assessCompatibility(currentState);
  return currentState;
}

function revealMainWindow() {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

const windowReadiness = createWindowReadiness(revealMainWindow);

function showMainWindow() {
  windowReadiness.requestShow();
}

function createTray() {
  if (tray || smokeTest || capturePath) return;
  const iconPath = path.join(__dirname, "..", "renderer", "icon.png");
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  if (icon.isEmpty()) return;
  tray = new Tray(icon);
  tray.setToolTip("Codex Feishu Bridge");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 Codex 飞书 Bridge", click: showMainWindow },
    { type: "separator" },
    {
      label: "退出客户端",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
  tray.on("double-click", showMainWindow);
}

function createManagedRecoverySupervisor() {
  const supervisor = createRecoverySupervisor({
    inspectBots: async () => inspectManagedBots(managedDataRoot(), runtimeLocalAppData()),
    startBot: async (name) => {
      await loadState();
      const result = await startManagedBot(name, supervisorOptions());
      await loadState();
      return result;
    },
  });
  const rawTick = supervisor.tick.bind(supervisor);
  supervisor.tick = () => operationCoordinator.runExclusive("recovery-tick", rawTick, { pause: false });
  return supervisor;
}

function createWindow() {
  const captureWidth = capturePath ? Number(process.env.CFB_DESKTOP_CAPTURE_WIDTH || 0) : 0;
  const captureHeight = capturePath ? Number(process.env.CFB_DESKTOP_CAPTURE_HEIGHT || 0) : 0;
  mainWindow = new BrowserWindow({
    width: captureWidth >= 920 ? captureWidth : 1180,
    height: captureHeight >= 620 ? captureHeight : 760,
    minWidth: 920,
    minHeight: 620,
    show: false,
    backgroundColor: "#f4f6f9",
    title: "Codex Feishu Bridge",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  mainWindow.once("ready-to-show", () => {
    if (!capturePath && (!backgroundStart || !tray)) mainWindow.show();
  });
  if (capturePath) {
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const deadline = Date.now() + 30_000;
          while (Date.now() < deadline && !await mainWindow.webContents.executeJavaScript('document.querySelector("#app-version")?.textContent !== "v..." && document.querySelector("#loading-band")?.classList.contains("hidden")')) {
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          if (captureSetup) {
            await mainWindow.webContents.executeJavaScript('document.querySelector("#btn-open-wizard")?.click();');
            await new Promise((resolve) => setTimeout(resolve, 350));
          } else if (captureView === "factory") {
            await mainWindow.webContents.executeJavaScript(`document.querySelector('#btn-open-wizard')?.click(); setTimeout(() => document.querySelector('[data-wizard-mode="batch"]')?.click(), 100);`);
            await new Promise((resolve) => setTimeout(resolve, 450));
          } else if (["overview", "bots", "providers", "capabilities", "system"].includes(captureView)) {
            await mainWindow.webContents.executeJavaScript(`document.querySelector('.nav-item[data-view="${captureView}"]')?.click();`);
            await new Promise((resolve) => setTimeout(resolve, 350));
          }
          if (captureReadiness) {
            await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-bot-detail]')?.click(); setTimeout(() => document.querySelector('[data-dtab="readiness"]')?.click(), 150);`);
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }
          if (captureProviderRemoval) {
            await mainWindow.webContents.executeJavaScript('document.querySelector(".provider-remove")?.click();');
            await new Promise((resolve) => setTimeout(resolve, 800));
          }
          const image = await mainWindow.webContents.capturePage();
          fs.mkdirSync(path.dirname(capturePath), { recursive: true });
          fs.writeFileSync(capturePath, image.toPNG());
          if (process.env.CFB_DESKTOP_CAPTURE_REPORT) {
            const report = await mainWindow.webContents.executeJavaScript(`(() => {
              const errorBand = document.querySelector('#error-band');
              const errorBandVisible = Boolean(errorBand && !errorBand.classList.contains('hidden'));
              const navViews = [...document.querySelectorAll('.nav-item[data-view]')].map((el) => el.dataset.view);
              const horizontalOverflow = document.documentElement.scrollWidth > document.documentElement.clientWidth;
              let sub12pxTextCount = 0;
              const sub12pxSamples = [];
              for (const el of document.querySelectorAll('body *')) {
                const style = getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden') continue;
                const rect = el.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) continue;
                const hasDirectText = [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim().length > 0);
                if (!hasDirectText) continue;
                const fontSize = parseFloat(style.fontSize);
                if (Number.isFinite(fontSize) && fontSize < 12) {
                  sub12pxTextCount += 1;
                  if (sub12pxSamples.length < 5) sub12pxSamples.push({ tag: el.tagName, text: el.textContent.trim().slice(0, 40), fontSize });
                }
              }
              const botsTable = document.querySelector('#bots-table');
              const botsViewBotListTopY = botsTable ? Math.round(botsTable.getBoundingClientRect().top) : null;
              const wizardSupportsAllThreeEngines = ['codex', 'claude', 'antigravity'].every(
                (engine) => Boolean(document.querySelector('[data-wizard-engine="' + engine + '"]')),
              );
              return {
                version: document.querySelector('#app-version')?.textContent || '',
                errorBandVisible,
                error: document.querySelector('#error-band-message')?.textContent || '',
                navViews,
                activeView: document.querySelector('.nav-item.active')?.dataset.view || '',
                horizontalOverflow,
                sub12pxTextCount,
                sub12pxSamples,
                botsViewBotListTopY,
                wizardSupportsAllThreeEngines,
                viewport: { width: window.innerWidth, height: window.innerHeight },
              };
            })()`);
            fs.writeFileSync(process.env.CFB_DESKTOP_CAPTURE_REPORT, JSON.stringify(report, null, 2) + '\n', 'utf8');
            const expectedNav = ['overview', 'bots', 'providers', 'capabilities', 'system'];
            const navMatches = Array.isArray(report.navViews)
              && report.navViews.length === expectedNav.length
              && expectedNav.every((item, idx) => report.navViews[idx] === item);
            const invalid = (
              report.version !== `v${app.getVersion()}`
              || report.errorBandVisible !== false
              || !navMatches
              || report.horizontalOverflow !== false
              || report.sub12pxTextCount !== 0
              || (captureView === 'bots' && (typeof report.botsViewBotListTopY !== 'number' || report.botsViewBotListTopY > 220))
              || ((captureSetup || captureView === 'factory') && report.wizardSupportsAllThreeEngines !== true)
              || (captureView && !['factory'].includes(captureView) && !captureSetup && report.activeView !== captureView)
            );
            if (invalid) {
              console.error('Desktop capture validation failed:', JSON.stringify(report));
              throw new Error('Desktop capture validation failed');
            }
          }
          app.exit(0);
        } catch (captureError) {
          console.error('Desktop capture error:', captureError?.message || captureError);
          app.exit(1);
        }
      }, 2500);
    });
  }
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.on("close", (event) => {
    if (!isQuitting && desktopSettings.closeToTray && tray && !capturePath) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    if (!smokeTest && !capturePath) {
      try {
        migrateDesktopData(managedDataRoot(), { appVersion: app.getVersion() });
        desktopSettings = readDesktopSettings(managedDataRoot());
        if (desktopSettings.error) throw new Error(`客户端设置损坏：${desktopSettings.error}`);
        await Promise.all([
          initializeProtectedProviderCredentialStore(),
          initializeClaudeCredentialStore(),
          initializeAntigravityCredentialStore(),
          initializeMacProviderEnvironment(),
        ]);
        if (desktopSettings.launchAtLogin && desktopStartup.supported()) desktopStartup.setEnabled(true);
      } catch (error) {
        startupError = error.message || String(error);
      }
    }
    if (smokeTest) {
      loadState().then(
        (state) => app.exit(state && state.codex && state.bridge ? 0 : 1),
        () => app.exit(1),
      );
      return;
    }
    let startupStatePromise = null;
    runtimeInitializing = !capturePath;
    const startupState = () => {
      if (!startupStatePromise) startupStatePromise = loadState();
      return startupStatePromise;
    };
    ipcMain.handle("desktop:get-version", () => app.getVersion());
    ipcMain.handle("desktop:get-state", (_event, options) => (
      runtimeInitializing ? startupState() : loadState({ force: Boolean(options?.force) })
    ));
    ipcMain.handle("desktop:check-update", () => updaterService?.check());
    ipcMain.handle("desktop:install-update", () => updaterService?.install());
    ipcMain.handle("desktop:open-path", async (_event, requestedPath) => {
      const knownPaths = collectKnownPaths(currentState);
      if (!isKnownPath(requestedPath, knownPaths)) {
        return { ok: false, error: "Path is not exposed by the current desktop state" };
      }
      const error = await shell.openPath(requestedPath);
      return error ? { ok: false, error } : { ok: true };
    });
    ipcMain.handle("desktop:copy-path", (_event, requestedPath) => {
      const knownPaths = collectKnownPaths(currentState);
      if (!isKnownPath(requestedPath, knownPaths)) throw new Error("Path is not exposed by the current desktop state");
      clipboard.writeText(path.resolve(requestedPath));
      return { ok: true };
    });
    ipcMain.handle("desktop:preview-bot", (_event, input) => previewBot(input, setupOptions()));
    ipcMain.handle('desktop:claude-list-models', (_event, input) => listClaudeModels(input, claudeOptions()));
    ipcMain.handle('desktop:antigravity-list-models', (_event, input) => listAntigravityModels(input, antigravityOptions()));
    ipcMain.handle('desktop:antigravity-probe-provider', (_event, input) => probeAntigravityProvider(input, antigravityOptions()));
    ipcMain.handle('desktop:antigravity-save-provider', async (_event, input) => {
      assertStartupReady();
      const result = await saveAntigravityProvider(input, antigravityOptions());
      const names = readManagedBots(managedDataRoot()).filter((bot) => bot.engine === 'antigravity').map((bot) => bot.name);
      result.queuedBots = queueClaudeReconfiguration(managedDataRoot(), names, 'antigravity');
      await loadState({ force: true }); return result;
    });
    ipcMain.handle('desktop:antigravity-capture-account', async (_event, input) => {
      assertStartupReady(); const result = captureAntigravityAccount(input, antigravityOptions()); await loadState(); return result;
    });
    ipcMain.handle('desktop:antigravity-switch-account', async (_event, input) => {
      assertStartupReady(); const result = await switchAntigravityAccount(input, antigravityOptions()); await loadState(); return result;
    });
    ipcMain.handle('desktop:antigravity-open-login', () => { assertStartupReady(); return openAntigravityLogin(antigravityOptions()); });
    ipcMain.handle('desktop:antigravity-save-mcp', async (_event, input) => {
      assertStartupReady(); const result = saveClaudeMcp(input, antigravityOptions()); await loadState({ force: true }); return result;
    });
    ipcMain.handle('desktop:antigravity-migrate-capabilities', async (_event, input) => {
      assertStartupReady(); const result = migrateClaudeCapabilities(input, antigravityOptions()); await loadState({ force: true }); return result;
    });
    ipcMain.handle('desktop:antigravity-assign-provider', async (_event, input) => {
      assertStartupReady(); const result = assignAntigravityProvider(input, antigravityOptions(), readManagedBots(managedDataRoot()));
      await loadState(); return result;
    });
    ipcMain.handle('desktop:claude-probe-provider', (_event, input) => probeClaudeProvider(input, claudeOptions()));
    ipcMain.handle('desktop:claude-save-provider', async (_event, input) => {
      assertStartupReady();
      const result = await saveClaudeProvider(input, claudeOptions());
      result.pendingBots = queueClaudeProviderUsers(result.provider.id);
      await loadState({ force: true }); return result;
    });
    ipcMain.handle('desktop:claude-replace-key', async (_event, input) => {
      assertStartupReady();
      const result = await replaceClaudeProviderKey(input, claudeOptions());
      result.pendingBots = queueClaudeProviderUsers(result.provider.id);
      await loadState(); return result;
    });
    ipcMain.handle('desktop:claude-assign-provider', async (_event, input) => {
      assertStartupReady();
      const result = assignClaudeProvider(input, claudeOptions(), readManagedBots(managedDataRoot()));
      queueClaudeReconfiguration(managedDataRoot(), result.botNames);
      await loadState(); return result;
    });
    ipcMain.handle('desktop:claude-save-mcp', async (_event, input) => {
      assertStartupReady(); const result = saveClaudeMcp(input, claudeOptions()); await loadState({ force: true }); return result;
    });
    ipcMain.handle('desktop:claude-migrate-capabilities', async (_event, input) => {
      assertStartupReady(); const result = migrateClaudeCapabilities(input, claudeOptions()); await loadState({ force: true }); return result;
    });
    ipcMain.handle("desktop:create-bot", async (_event, input) => {
      assertStartupReady();
      const result = await createManagedBot(input?.bot, input?.credentials, setupOptions());
      await loadState();
      return result;
    });
    ipcMain.handle("desktop:preview-legacy-adoption", (_event, input) => (
      previewLegacyAdoption(Array.isArray(input?.names) ? input.names : [], legacyAdoptionOptions())
    ));
    ipcMain.handle("desktop:apply-legacy-adoption", async (_event, input) => {
      assertStartupReady();
      return operationCoordinator.runExclusive("apply-legacy-adoption", async () => {
        const result = await applyLegacyAdoption(
          Array.isArray(input?.names) ? input.names : [],
          legacyAdoptionOptions(),
        );
        await loadState({ force: true });
        return result;
      });
    });
    ipcMain.handle("desktop:register-bot-qr", async (event, input) => {
      assertStartupReady();
      if (cancelRegistration) throw new Error("已有扫码注册正在进行");
      const options = {
        ...setupOptions(),
        setAbort: (abort) => { cancelRegistration = abort; },
      };
      try {
        const result = await registerBotWithQr(input, options, (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send("desktop:registration-progress", progress);
        });
        await loadState();
        return result;
      } finally {
        cancelRegistration = null;
      }
    });
    ipcMain.handle("desktop:preview-workspace-factory", (_event, input) => (
      previewWorkspaceFactory(input, workspaceFactoryOptions())
    ));
    ipcMain.handle("desktop:create-workspace-factory-queue", async (_event, input) => {
      assertStartupReady();
      const result = createWorkspaceFactoryQueue(input, workspaceFactoryOptions());
      await loadState();
      return result;
    });
    ipcMain.handle("desktop:register-workspace-factory-bot", async (event, input) => {
      assertStartupReady();
      if (cancelRegistration) throw new Error("已有扫码注册正在进行");
      const registrationOptions = {
        ...setupOptions(),
        setAbort: (abort) => { cancelRegistration = abort; },
      };
      try {
        const result = await registerFactoryBot(String(input?.name || ""), {
          dataRoot: managedDataRoot(),
          registerBot: registerBotWithQr,
          registrationOptions,
        }, (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send("desktop:factory-registration-progress", progress);
        });
        await loadState();
        return result;
      } finally {
        cancelRegistration = null;
      }
    });
    ipcMain.handle("desktop:cancel-registration", () => {
      cancelRegistration?.();
      return { ok: true };
    });
    ipcMain.handle("desktop:test-provider", (_event, input) => testProvider(input, {
      botName: String(input?.botName || "test"),
      timeoutMs: 30_000,
    }));
    ipcMain.handle("desktop:list-provider-models", (_event, input) => (
      listProviderModels(input, providerManagerOptions())
    ));
    ipcMain.handle("desktop:probe-provider", (_event, input) => (
      probeProvider(input, providerManagerOptions())
    ));
    ipcMain.handle("desktop:add-global-provider", async (_event, input) => {
      assertStartupReady();
      const result = queueCodexProviderReload(await addGlobalProvider(input, providerManagerOptions()));
      await loadState({ force: true });
      return result;
    });
    ipcMain.handle("desktop:replace-global-provider-key", async (_event, input) => {
      assertStartupReady();
      const result = queueCodexProviderReload(await replaceGlobalProviderKey(input, providerManagerOptions()));
      await loadState();
      return result;
    });
    ipcMain.handle("desktop:refresh-provider-capacity", async (_event, input) => {
      assertStartupReady();
      const result = await refreshProviderCapacity(input, providerManagerOptions());
      await loadState();
      return result;
    });
    ipcMain.handle("desktop:preview-global-provider-removal", (_event, input) => (
      previewGlobalProviderRemoval(input, providerManagerOptions())
    ));
    ipcMain.handle("desktop:apply-global-provider-removal", async (_event, input) => {
      assertStartupReady();
      const result = await applyGlobalProviderRemoval(input, providerManagerOptions());
      await loadState({ force: true });
      return result;
    });
    ipcMain.handle("desktop:preview-provider-sync", () => (
      providerSyncPlan(providerManagerOptions(), false)
    ));
    ipcMain.handle("desktop:apply-provider-sync", async () => {
      assertStartupReady();
      const result = providerSyncPlan(providerManagerOptions(), true);
      await loadState({ force: true });
      return result;
    });
    ipcMain.handle("desktop:start-openai-login", async (_event, codexHome) => {
      assertStartupReady();
      const result = startDesktopOpenAiLogin(codexHome, modelSourceOptions());
      await loadState();
      return result;
    });
    ipcMain.handle("desktop:add-openai-account", (_event, input) => {
      assertStartupReady();
      return startAccountLogin(input || {}, modelSourceOptions());
    });
    ipcMain.handle("desktop:set-bot-openai-account", async (_event, input) => {
      assertStartupReady();
      const result = await setBotAccount(input, modelSourceOptions());
      await loadState(); return result;
    });
    ipcMain.handle("desktop:forget-openai-account", async (_event, input) => {
      assertStartupReady();
      const result = await forgetAccount(input, modelSourceOptions());
      await loadState(); return result;
    });
    ipcMain.handle("desktop:trust-codex-home", async (_event, codexHome) => {
      assertStartupReady();
      const result = trustDesktopCodexHome(codexHome, modelSourceOptions());
      await loadState();
      return result;
    });
    ipcMain.handle("desktop:preview-model-source-switch", (_event, input) => (
      previewDesktopModelSourceSwitch(input, modelSourceOptions())
    ));
    ipcMain.handle("desktop:apply-model-source-switch", async (_event, input) => {
      assertStartupReady();
      const result = await applyDesktopModelSourceSwitch(input, modelSourceOptions());
      await loadState({ force: true });
      return result;
    });
    ipcMain.handle("desktop:start-bot", async (_event, name) => {
      assertStartupReady();
      const result = await startManagedBot(String(name || ""), supervisorOptions());
      await loadState();
      return result;
    });
    ipcMain.handle("desktop:stop-bot", async (_event, name) => {
      assertStartupReady();
      const result = await stopManagedBotAndDisableAutoStart(String(name || ""), supervisorOptions());
      await loadState();
      return result;
    });
    ipcMain.handle("desktop:restart-bots", async (event, input) => {
      assertStartupReady();
      return operationCoordinator.runExclusive("restart-bots", async () => {
        const result = await restartSelectedManagedBots({
          ...supervisorOptions(),
          names: Array.isArray(input?.names) ? input.names : [],
          force: input?.force === true,
          onProgress: (progress) => {
            if (!event.sender.isDestroyed()) event.sender.send("desktop:bot-restart-progress", progress);
          },
        });
        await loadState({ force: false });
        return result;
      });
    });
    ipcMain.handle("desktop:set-bot-autostart", async (_event, input) => {
      assertStartupReady();
      const enabled = input?.enabled === true;
      const previousSettings = desktopSettings;
      const previousLogin = desktopStartup.inspect();
      if (enabled) {
        const login = desktopStartup.setEnabled(true);
        if (!login.supported || !login.enabled) throw new Error("无法启用系统登录启动");
      }
      let result;
      try {
        if (enabled) desktopSettings = writeDesktopSettings(managedDataRoot(), { launchAtLogin: true });
        result = setManagedBotAutoStart(String(input?.name || ""), enabled, {
          dataRoot: managedDataRoot(),
        });
      } catch (error) {
        if (enabled) {
          desktopStartup.setEnabled(previousLogin.enabled);
          desktopSettings = writeDesktopSettings(managedDataRoot(), {
            launchAtLogin: previousSettings.launchAtLogin,
          });
        }
        throw error;
      }
      await loadState();
      if (enabled) void recoverySupervisor?.tick();
      return result;
    });
    ipcMain.handle("desktop:preview-managed-removal", (_event, input) => (
      input?.kind === "space"
        ? previewManagedSpaceRemoval(input?.id, removalOptions())
        : previewManagedBotRemoval(input?.id, removalOptions())
    ));
    ipcMain.handle("desktop:apply-managed-removal", async (_event, input) => {
      assertStartupReady();
      return operationCoordinator.runExclusive("apply-managed-removal", async () => {
        const result = await applyManagedRemoval(input, removalOptions());
        await loadState({ force: true });
        return result;
      });
    });
    ipcMain.handle("desktop:set-settings", async (_event, patch) => {
      assertStartupReady();
      const next = {};
      if (Object.prototype.hasOwnProperty.call(patch || {}, "launchAtLogin")) {
        const enabled = patch.launchAtLogin === true;
        if (!enabled) {
          const automaticBots = inspectManagedBots(managedDataRoot(), runtimeLocalAppData())
            .filter((bot) => bot.autoStart);
          if (automaticBots.length) throw new Error("请先关闭所有 Bot 的开机启动");
        }
        const login = desktopStartup.setEnabled(enabled);
        if (!login.supported) throw new Error("当前环境不支持系统登录启动设置");
        next.launchAtLogin = login.enabled;
      }
      if (Object.prototype.hasOwnProperty.call(patch || {}, "closeToTray")) {
        next.closeToTray = patch.closeToTray === true;
      }
      desktopSettings = writeDesktopSettings(managedDataRoot(), next);
      await loadState();
      return currentState.settings;
    });
    ipcMain.handle("desktop:check-bot-readiness", async (_event, name) => {
      assertStartupReady();
      return checkBotReadiness(String(name || ""), readinessOptions());
    });
    ipcMain.handle("desktop:copy-permission-policy", (_event, name) => {
      managedBotForAction(name);
      clipboard.writeText(permissionImportJson());
      return { ok: true, permissionPolicy: publicPermissionPolicy() };
    });
    ipcMain.handle("desktop:open-feishu-console", async (_event, input) => {
      const bot = managedBotForAction(input?.name);
      const section = input?.section === "event" ? "event" : "permission";
      await shell.openExternal(feishuConsoleUrl(bot.appId, section, bot.brand));
      return { ok: true, section };
    });
    ipcMain.handle("desktop:authorize-lark-user", async (_event, name) => {
      const normalized = String(name || "").trim();
      managedBotForAction(normalized);
      if (activeLarkAuthorization) {
        try {
          activeLarkAuthorization.controller.abort();
        } catch {}
        activeLarkAuthorization = null;
      }
      const controller = new AbortController();
      activeLarkAuthorization = { botName: normalized, controller };
      try {
        const result = await authorizeLarkUser(normalized, {
          ...readinessOptions(),
          signal: controller.signal,
          openExternal: (url) => shell.openExternal(url),
        });
        await loadState();
        return result;
      } finally {
        if (activeLarkAuthorization?.controller === controller) {
          activeLarkAuthorization = null;
        }
      }
    });
    ipcMain.handle("desktop:cancel-lark-user-auth", () => {
      if (!activeLarkAuthorization) return { ok: true, cancelled: false };
      const botName = activeLarkAuthorization.botName;
      try {
        activeLarkAuthorization.controller.abort();
      } catch {}
      activeLarkAuthorization = null;
      return { ok: true, cancelled: true, botName };
    });
    ipcMain.handle("desktop:preview-capability-migration", (_event, input) => (
      previewCapabilityMigration(String(input?.name || ""), input?.selection, migrationOptions())
    ));
    ipcMain.handle("desktop:apply-capability-migration", async (_event, input) => {
      assertStartupReady();
      const result = applyCapabilityMigration(String(input?.name || ""), input?.selection, migrationOptions());
      await loadState({ force: true });
      return result;
    });
    ipcMain.handle("desktop:update-bot-config", async (_event, input) => {
      assertStartupReady();
      return operationCoordinator.runExclusive("update-bot-config", async () => {
        const result = await updateManagedBotConfig(input || {}, {
          dataRoot: managedDataRoot(),
          localAppData: runtimeLocalAppData(),
          env: process.env,
          inspectBots: () => inspectManagedBots(managedDataRoot(), runtimeLocalAppData()),
          stopBot: (name) => stopManagedBot(name, supervisorOptions()),
          startBot: (name) => startManagedBot(name, supervisorOptions()),
          queueClaude: queueClaudeReconfiguration,
          queueCodexBotReload,
        });
        await loadState({ force: true });
        return result;
      });
    });
    ipcMain.handle("desktop:read-bot-logs", (_event, input) => readBotLogs(input || {}, {
      dataRoot: managedDataRoot(),
      localAppData: runtimeLocalAppData(),
    }));
    ipcMain.handle("desktop:retry-workspace-factory-bot", async (_event, input) => {
      assertStartupReady();
      const result = retryFactoryBot(String(input?.name || ""), managedDataRoot());
      await loadState({ force: false });
      return result;
    });
    ipcMain.handle("desktop:discard-workspace-factory-queue", async () => {
      assertStartupReady();
      const current = readWorkspaceFactoryQueue(managedDataRoot());
      const discardedCount = Array.isArray(current?.bots) ? current.bots.length : 0;
      if (cancelRegistration) {
        try { cancelRegistration(); } catch {}
      }
      discardFactoryQueue(managedDataRoot());
      await loadState({ force: false });
      return { ok: true, discardedCount };
    });
    ipcMain.handle("desktop:probe-mcp-health", async () => probeMcpHealth({
      dataRoot: managedDataRoot(),
      userHome: app.getPath("home"),
      codexHome: path.join(app.getPath("home"), ".codex"),
      engineRoot: currentState?.engine?.engineRoot || "",
      env: process.env,
      platform: process.platform,
    }));
    ipcMain.handle("desktop:set-owner-open-id", async (_event, input) => {
      assertStartupReady();
      const result = setOwnerOpenId(input || {}, {
        dataRoot: managedDataRoot(),
        readManagedBots,
        queueClaude: queueClaudeReconfiguration,
        queueCodexBotReload,
      });
      desktopSettings = result.settings;
      await loadState({ force: true });
      return { ok: true, ownerOpenId: result.ownerOpenId, queuedBots: result.queuedBots };
    });
    createWindow();
    windowReadiness.markReady();
    if (!capturePath) {
      try {
        await initializeDesktopRuntime(startupState());
      } finally {
        runtimeInitializing = false;
        startupStatePromise = null;
      }
      if (!startupError) {
        claudeConfigurationTimer = setInterval(() => { void applyPendingProviderConfiguration().catch((error) => console.error('Provider configuration update failed:', error.message)); }, 10_000);
        claudeConfigurationTimer.unref();
        void applyPendingProviderConfiguration().catch((error) => console.error('Provider configuration update failed:', error.message));
        void refreshProviderCapacities(providerManagerOptions()).then(() => loadState()).catch(() => {});
      }
    }
  });

  app.on("before-quit", (event) => {
    isQuitting = true;
    if (activeLarkAuthorization) {
      try { activeLarkAuthorization.controller.abort(); } catch {}
      activeLarkAuthorization = null;
    }
    if (legacyAdoptionTimer) clearInterval(legacyAdoptionTimer);
    if (claudeConfigurationTimer) clearInterval(claudeConfigurationTimer);
    recoverySupervisor?.stop();
    updaterService?.stop();
    const proxyStatus = protocolProxyService?.snapshot().status;
    if (!proxyStoppedForQuit && new Set(["online", "starting"]).has(proxyStatus)) {
      event.preventDefault();
      void protocolProxyService.stop().finally(() => {
        proxyStoppedForQuit = true;
        app.quit();
      });
    }
  });
  app.on("window-all-closed", () => {
    if (!desktopSettings.closeToTray || !tray) app.quit();
  });
}
