const { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, safeStorage, shell, Tray } = require("electron");
const { autoUpdater } = require("electron-updater");
const fs = require("node:fs");
const path = require("node:path");
const { inspectCodex } = require("./services/environment.cjs");
const { discoverBridge } = require("./services/bridge-discovery.cjs");
const { inspectCapabilities } = require("./services/capabilities.cjs");
const { inspectEngine } = require("./services/engine.cjs");
const { collectKnownPaths, isKnownPath } = require("./services/known-paths.cjs");
const { createManagedBot, previewBot, readManagedBots, runLarkCli } = require("./services/bot-setup.cjs");
const { registerBotWithQr } = require("./services/feishu-registration.cjs");
const { authorizeLarkUser } = require("./services/lark-user-auth.cjs");
const {
  inspectManagedBots,
  setManagedBotAutoStart,
  startManagedBot,
  stopManagedBot,
  stopManagedBotAndDisableAutoStart,
} = require("./services/supervisor.cjs");
const { checkBotReadiness } = require("./services/bot-readiness.cjs");
const { permissionImportJson, publicPermissionPolicy } = require("./services/permission-policy.cjs");
const { createRecoverySupervisor } = require("./services/recovery-supervisor.cjs");
const { readDesktopSettings, writeDesktopSettings } = require("./services/desktop-settings.cjs");
const { createWindowsStartup } = require("./services/windows-startup.cjs");
const { applyCapabilityMigration, previewCapabilityMigration } = require("./services/capability-migration.cjs");
const { inspectProvider, testProvider } = require("./services/provider-setup.cjs");
const { reasoningRegistry } = require("./services/reasoning-effort.cjs");
const {
  applyDesktopModelSourceSwitch,
  listDesktopModelSources,
  previewDesktopModelSourceSwitch,
  startDesktopOpenAiLogin,
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
const {
  clearRecoveryMarker,
  restoreUpdateBots,
  writeRecoveryMarker,
} = require("./services/update-recovery.cjs");
const {
  createWorkspaceFactoryQueue,
  previewWorkspaceFactory,
  readWorkspaceFactoryQueue,
  registerFactoryBot,
} = require("./services/workspace-factory.cjs");

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

const singleInstance = capturePath ? true : app.requestSingleInstanceLock();
let mainWindow = null;
let currentState = null;
let cancelRegistration = null;
let userAuthorizationInProgress = "";
let startupError = "";
let tray = null;
let isQuitting = false;
let recoverySupervisor = null;
let updaterService = null;
let protocolProxyService = null;
let proxyStoppedForQuit = false;
let desktopSettings = { launchAtLogin: false, closeToTray: true, error: "" };
const windowsStartup = createWindowsStartup(app);

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

function inspectDesktopSettings() {
  const saved = readDesktopSettings(managedDataRoot());
  const login = windowsStartup.inspect();
  return {
    ...saved,
    launchAtLogin: login.supported ? login.enabled : saved.launchAtLogin,
    launchAtLoginSupported: login.supported,
    trayAvailable: Boolean(tray),
  };
}

function setupOptions() {
  return {
    dataRoot: managedDataRoot(),
    workspaceRoot: workspaceRoot(),
    codexHomeRoot: codexHomeRoot(),
    defaultCodexHome: path.join(app.getPath("home"), ".codex"),
    sourceCodexHome: path.join(app.getPath("home"), ".codex"),
    runtimeLocalAppData: runtimeLocalAppData(),
    larkCliPath: currentState?.engine?.larkCliPath || "",
    existingNames: currentState?.bridge?.instances?.map((item) => item.name) || [],
    encryptSecret: (value) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 安全存储暂不可用");
      return safeStorage.encryptString(value);
    },
  };
}

function supervisorOptions() {
  return {
    dataRoot: managedDataRoot(),
    localAppData: runtimeLocalAppData(),
    engineRoot: currentState?.engine?.engineRoot || "",
    nodePath: currentState?.engine?.nodePath || "",
    larkCliPath: currentState?.engine?.larkCliPath || "",
    defaultCodexHome: path.join(app.getPath("home"), ".codex"),
    codexAvailable: Boolean(currentState?.codex?.runtimeFound),
    decryptSecret: (value) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 安全存储暂不可用");
      return safeStorage.decryptString(value);
    },
  };
}

function migrationOptions() {
  return {
    dataRoot: managedDataRoot(),
    sourceCodexHome: path.join(app.getPath("home"), ".codex"),
  };
}

function providerManagerOptions() {
  return {
    codexHome: path.join(app.getPath("home"), ".codex"),
    dataRoot: managedDataRoot(),
    timeoutMs: 30_000,
    prepareProtocolProxyProvider: (provider, model) => protocolProxyService?.prepareProvider(provider, model),
    prepareProtocolProxyRemoval: (id) => protocolProxyService?.prepareProviderRemoval(id),
    restartProtocolProxy: () => protocolProxyService?.restart(),
    decorateProviderCatalog: (catalog) => protocolProxyService?.decorateCatalog(catalog) || catalog,
  };
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

function readinessOptions() {
  return {
    dataRoot: managedDataRoot(),
    larkCliPath: currentState?.engine?.larkCliPath || "",
    codexAvailable: Boolean(currentState?.codex?.runtimeFound),
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
  writeRecoveryMarker(managedDataRoot(), restartNames, targetVersion);
  recoverySupervisor?.stop();
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
    recoverySupervisor?.start();
    await protocolProxyService?.start().catch(() => {});
    throw error;
  }
  return {
    rollback: async () => {
      for (const name of stoppedNames) {
        try { await startManagedBot(name, supervisorOptions()); } catch {}
      }
      clearRecoveryMarker(managedDataRoot());
      recoverySupervisor?.start();
      await protocolProxyService?.start().catch(() => {});
    },
  };
}

function createDesktopUpdater() {
  return createUpdaterService({
    supported: app.isPackaged && !smokeTest && !capturePath,
    updater: autoUpdater,
    currentVersion: app.getVersion(),
    inspectBots: async () => inspectManagedBots(managedDataRoot(), runtimeLocalAppData()),
    prepareInstall: prepareUpdateInstall,
    onState: sendUpdateState,
  });
}

function managedBotForAction(name) {
  const normalized = String(name || "").trim();
  const bot = readManagedBots(managedDataRoot()).find((item) => item.name === normalized);
  if (!bot) throw new Error(`找不到客户端创建的 Bot：${normalized}`);
  return bot;
}

function feishuConsoleUrl(appId, section) {
  if (!/^cli_[A-Za-z0-9]+$/.test(String(appId || ""))) throw new Error("飞书 App ID 无效");
  const suffix = section === "event" ? "event" : "permission";
  return `https://open.feishu.cn/app/${encodeURIComponent(appId)}/${suffix}`;
}

function detectorScriptPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "scripts", "detect-codex.ps1")
    : path.join(__dirname, "..", "..", "resources", "scripts", "detect-codex.ps1");
}

async function loadState() {
  const desktopRoot = path.join(__dirname, "..", "..");
  const [codex, bridge, engine, capabilities] = await Promise.all([
    inspectCodex(detectorScriptPath()),
    Promise.resolve(discoverBridge()),
    inspectEngine({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, desktopRoot }),
    Promise.resolve(inspectCapabilities()),
  ]);
  const providerCatalog = inspectProviderCatalog(path.join(app.getPath("home"), ".codex"));
  currentState = {
    generatedAt: new Date().toISOString(),
    app: { version: app.getVersion(), packaged: app.isPackaged },
    codex,
    bridge,
    engine,
    capabilities,
    provider: inspectProvider(path.join(app.getPath("home"), ".codex")),
    providerCatalog: protocolProxyService?.decorateCatalog(providerCatalog) || providerCatalog,
    settings: inspectDesktopSettings(),
    setup: {
      mode: app.isPackaged ? "production" : "development-sandbox",
      dataRoot: managedDataRoot(),
      workspaceRoot: workspaceRoot(),
      codexHomeRoot: codexHomeRoot(),
      runtimeLocalAppData: runtimeLocalAppData(),
      managedBots: inspectManagedBots(managedDataRoot(), runtimeLocalAppData()),
      managedSpaces: isolatedSpaces(managedDataRoot()),
      permissionPolicy: publicPermissionPolicy(),
      dataSchema: inspectDataSchema(managedDataRoot()),
      startupError,
      recovery: recoverySupervisor?.snapshot() || {},
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
  currentState.modelSources = await listDesktopModelSources(modelSourceOptions());
  currentState.compatibility = assessCompatibility(currentState);
  return currentState;
}

function showMainWindow() {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
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
  return createRecoverySupervisor({
    inspectBots: async () => inspectManagedBots(managedDataRoot(), runtimeLocalAppData()),
    startBot: async (name) => {
      await loadState();
      const result = await startManagedBot(name, supervisorOptions());
      await loadState();
      return result;
    },
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 920,
    minHeight: 620,
    show: false,
    backgroundColor: "#f4f6f8",
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
    if (!backgroundStart || capturePath || !tray) mainWindow.show();
  });
  if (capturePath) {
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          if (captureSetup) {
            await mainWindow.webContents.executeJavaScript('document.querySelector("[data-view=bots]").click(); document.querySelector("#create-bot-button").click();');
            await new Promise((resolve) => setTimeout(resolve, 300));
          } else if (captureView === "factory") {
            await mainWindow.webContents.executeJavaScript('document.querySelectorAll(".view").forEach((view) => view.classList.add("hidden")); document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active")); document.querySelector(\'[data-view="workspaces"]\').classList.add("active"); document.querySelector("#workspaces-view").classList.remove("hidden"); document.querySelector("#workspace-factory-editor").classList.remove("hidden"); document.querySelector("#view-title").textContent = "工作空间工厂";');
            await new Promise((resolve) => setTimeout(resolve, 300));
          } else if (["overview", "bots", "workspaces", "providers", "capabilities", "system"].includes(captureView)) {
            await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-view="${captureView}"]').click();`);
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
          if (captureReadiness) {
            await mainWindow.webContents.executeJavaScript('document.querySelector(".managed-bot-readiness")?.click();');
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }
          if (captureProviderRemoval) {
            await mainWindow.webContents.executeJavaScript('document.querySelector(".provider-remove")?.click();');
            await new Promise((resolve) => setTimeout(resolve, 800));
          }
          const image = await mainWindow.webContents.capturePage();
          fs.mkdirSync(path.dirname(capturePath), { recursive: true });
          fs.writeFileSync(capturePath, image.toPNG());
          app.exit(0);
        } catch {
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
        if (desktopSettings.launchAtLogin && windowsStartup.supported()) windowsStartup.setEnabled(true);
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
    if (!capturePath) {
      await loadState();
      const proxyCliPath = app.isPackaged
        ? path.join(process.resourcesPath, "proxy", "node_modules", "mimo2codex", "dist", "cli.js")
        : path.join(__dirname, "..", "..", "..", "proxy-runtime", "node_modules", "mimo2codex", "dist", "cli.js");
      protocolProxyService = createProtocolProxyService({
        dataRoot: managedDataRoot(),
        nodePath: currentState?.engine?.nodePath || "",
        proxyCliPath,
        readUserEnvironmentVariable,
      });
      await protocolProxyService.start().catch(() => {});
      createTray();
      updaterService = createDesktopUpdater();
      if (!startupError && app.isPackaged) {
        recoverySupervisor = createManagedRecoverySupervisor();
        void restoreUpdateBots(managedDataRoot(), async (name) => {
          await loadState();
          await startManagedBot(name, supervisorOptions());
        }).finally(() => recoverySupervisor?.start());
      }
      updaterService.start();
    }
    ipcMain.handle("desktop:get-state", () => loadState());
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
    ipcMain.handle("desktop:create-bot", async (_event, input) => {
      assertStartupReady();
      const result = await createManagedBot(input?.bot, input?.credentials, setupOptions());
      await loadState();
      return result;
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
      const result = await addGlobalProvider(input, providerManagerOptions());
      await loadState();
      return result;
    });
    ipcMain.handle("desktop:replace-global-provider-key", async (_event, input) => {
      assertStartupReady();
      const result = await replaceGlobalProviderKey(input, providerManagerOptions());
      await loadState();
      return result;
    });
    ipcMain.handle("desktop:preview-global-provider-removal", (_event, input) => (
      previewGlobalProviderRemoval(input, providerManagerOptions())
    ));
    ipcMain.handle("desktop:apply-global-provider-removal", async (_event, input) => {
      assertStartupReady();
      const result = await applyGlobalProviderRemoval(input, providerManagerOptions());
      await loadState();
      return result;
    });
    ipcMain.handle("desktop:preview-provider-sync", () => (
      providerSyncPlan(providerManagerOptions(), false)
    ));
    ipcMain.handle("desktop:apply-provider-sync", async () => {
      assertStartupReady();
      const result = providerSyncPlan(providerManagerOptions(), true);
      await loadState();
      return result;
    });
    ipcMain.handle("desktop:start-openai-login", async (_event, codexHome) => {
      assertStartupReady();
      const result = startDesktopOpenAiLogin(codexHome, modelSourceOptions());
      await loadState();
      return result;
    });
    ipcMain.handle("desktop:preview-model-source-switch", (_event, input) => (
      previewDesktopModelSourceSwitch(input, modelSourceOptions())
    ));
    ipcMain.handle("desktop:apply-model-source-switch", async (_event, input) => {
      assertStartupReady();
      const result = await applyDesktopModelSourceSwitch(input, modelSourceOptions());
      await loadState();
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
    ipcMain.handle("desktop:set-bot-autostart", async (_event, input) => {
      assertStartupReady();
      const enabled = input?.enabled === true;
      const previousSettings = desktopSettings;
      const previousLogin = windowsStartup.inspect();
      if (enabled) {
        const login = windowsStartup.setEnabled(true);
        if (!login.supported || !login.enabled) throw new Error("无法启用 Windows 登录启动");
      }
      let result;
      try {
        if (enabled) desktopSettings = writeDesktopSettings(managedDataRoot(), { launchAtLogin: true });
        result = setManagedBotAutoStart(String(input?.name || ""), enabled, {
          dataRoot: managedDataRoot(),
        });
      } catch (error) {
        if (enabled) {
          windowsStartup.setEnabled(previousLogin.enabled);
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
      recoverySupervisor?.stop();
      try {
        const result = await applyManagedRemoval(input, removalOptions());
        await loadState();
        return result;
      } finally {
        recoverySupervisor?.start();
      }
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
        const login = windowsStartup.setEnabled(enabled);
        if (!login.supported) throw new Error("当前环境不支持 Windows 登录启动设置");
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
      await shell.openExternal(feishuConsoleUrl(bot.appId, section));
      return { ok: true, section };
    });
    ipcMain.handle("desktop:authorize-lark-user", async (_event, name) => {
      const normalized = String(name || "").trim();
      managedBotForAction(normalized);
      if (userAuthorizationInProgress) {
        throw new Error(`正在为 ${userAuthorizationInProgress} 完成用户授权，请先完成或关闭浏览器授权页`);
      }
      userAuthorizationInProgress = normalized;
      try {
        const result = await authorizeLarkUser(normalized, {
          ...readinessOptions(),
          openExternal: (url) => shell.openExternal(url),
        });
        await loadState();
        return result;
      } finally {
        userAuthorizationInProgress = "";
      }
    });
    ipcMain.handle("desktop:preview-capability-migration", (_event, input) => (
      previewCapabilityMigration(String(input?.name || ""), input?.selection, migrationOptions())
    ));
    ipcMain.handle("desktop:apply-capability-migration", async (_event, input) => {
      assertStartupReady();
      const result = applyCapabilityMigration(String(input?.name || ""), input?.selection, migrationOptions());
      await loadState();
      return result;
    });
    createWindow();
  });

  app.on("before-quit", (event) => {
    isQuitting = true;
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
