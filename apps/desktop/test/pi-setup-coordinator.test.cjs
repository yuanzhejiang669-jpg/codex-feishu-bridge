const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

const { createPiSetupCoordinator } = require("../src/main/services/pi-setup-coordinator.cjs");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function activeSetup(root, stage = "PENDING") {
  const stateModuleUrl = pathToFileURL(path.resolve(__dirname, "..", "..", "..", "src", "pi", "setup-state.mjs")).href;
  const stateApi = await import(stateModuleUrl);
  const state = stateApi.createPiSetupRequest({ conversationId: "oc_chat", coordinatorBotName: "codex-1" });
  state.status = "active";
  state.bots[0].stage = stage;
  stateApi.writePiSetupState(path.join(root, "pi-setup-batch.json"), state);
  return { stateApi, stateModuleUrl };
}

test("advances one Pi Bot through both QR stages and removes transient artifacts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-pi-setup-coordinator-"));
  const stateModuleUrl = pathToFileURL(path.resolve(__dirname, "..", "..", "..", "src", "pi", "setup-state.mjs")).href;
  const stateApi = await import(stateModuleUrl);
  const filePath = path.join(root, "pi-setup-batch.json");
  stateApi.writePiSetupState(filePath, stateApi.createPiSetupRequest({
    conversationId: "oc_chat",
    coordinatorBotName: "codex-1",
  }));
  const managed = [];
  const started = [];
  const observedQr = [];
  const queueBots = Array.from({ length: 5 }, (_, offset) => {
    const suffix = String(offset + 1).padStart(2, "0");
    const name = `pi-agent-${suffix}`;
    return {
      name,
      workspace: path.join(root, "workspaces", name),
      agentHome: path.join(root, "pi-homes", name),
      sessionDir: path.join(root, "pi-homes", name, "sessions"),
      configurationSpace: { id: "pi-general", home: path.join(root, "pi-general") },
    };
  });
  const coordinator = createPiSetupCoordinator({
    dataRoot: root,
    stateModuleUrl,
    createQueue: () => ({ bots: queueBots }),
    registrationOptions: () => ({}),
    registerBot: async () => {},
    registerFactoryBot: async (name, _options, onProgress) => {
      await onProgress({
        stage: "qr-ready",
        qrDataUrl: "data:image/png;base64," + Buffer.from("app-qr").toString("base64"),
        expiresIn: 120,
      });
      const state = stateApi.readPiSetupState(filePath);
      observedQr.push({ kind: state.bots[0].qrArtifact.kind, exists: fs.existsSync(state.bots[0].qrArtifact.path) });
      managed.push({ name, appId: "cli_public", profile: name, online: false });
      return { bots: [] };
    },
    readManagedBots: () => managed,
    beginUserAuthorization: async () => ({
      verificationUrl: "https://accounts.example.test/device",
      deviceCode: "one-time-device-code",
      expiresIn: 120,
    }),
    completeUserAuthorization: async (_name, code) => {
      assert.equal(code, "one-time-device-code");
      const state = stateApi.readPiSetupState(filePath);
      observedQr.push({ kind: state.bots[0].qrArtifact.kind, exists: fs.existsSync(state.bots[0].qrArtifact.path) });
      return { identity: { available: true, verified: true, name: "Test User" } };
    },
    qrToDataUrl: async () => "data:image/png;base64," + Buffer.from("user-qr").toString("base64"),
    checkReadiness: async () => ({
      checkedAt: "2026-08-21T00:00:00.000Z",
      readyToStart: true,
      summary: "ready",
      actions: { userIdentityReady: true },
      permissionComparison: { complete: true, grantedTotal: 41, expectedTotal: 41 },
    }),
    startBot: async (name) => {
      started.push(name);
      managed.find((bot) => bot.name === name).online = true;
    },
  });
  try {
    assert.equal((await coordinator.tick()).action, "initialized");
    assert.equal((await coordinator.tick()).action, "advanced");
    assert.equal((await coordinator.tick()).action, "advanced");
    assert.equal((await coordinator.tick()).action, "advanced");
    const state = stateApi.readPiSetupState(filePath);
    assert.deepEqual(observedQr, [{ kind: "app", exists: true }, { kind: "user-auth", exists: true }]);
    assert.equal(state.bots[0].stage, "READY");
    assert.equal(state.bots[0].readiness.online, true);
    assert.equal(state.currentBotName, "pi-agent-02");
    assert.deepEqual(started, ["pi-agent-01"]);
    assert.equal(fs.existsSync(path.join(root, ".pi-setup-artifacts")), true);
    assert.equal(fs.readdirSync(path.join(root, ".pi-setup-artifacts")).length, 0);
    const serialized = fs.readFileSync(filePath, "utf8");
    assert.equal(serialized.includes("one-time-device-code"), false);
    assert.equal(serialized.includes("secret"), false);
  } finally {
    coordinator.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("records a retry stage without deleting completed predecessor state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-pi-setup-failure-"));
  const stateModuleUrl = pathToFileURL(path.resolve(__dirname, "..", "..", "..", "src", "pi", "setup-state.mjs")).href;
  const stateApi = await import(stateModuleUrl);
  const state = stateApi.createPiSetupRequest({ conversationId: "oc_chat", coordinatorBotName: "codex-1" });
  state.status = "active";
  state.bots[0].stage = "PROFILE_CREATED";
  state.bots[0].appId = "cli_public";
  stateApi.writePiSetupState(path.join(root, "pi-setup-batch.json"), state);
  const coordinator = createPiSetupCoordinator({
    dataRoot: root,
    stateModuleUrl,
    beginUserAuthorization: async () => { throw new Error("authorization unavailable"); },
  });
  try {
    const result = await coordinator.tick();
    const failed = stateApi.readPiSetupState(path.join(root, "pi-setup-batch.json")).bots[0];
    assert.equal(result.action, "failed");
    assert.equal(failed.stage, "FAILED");
    assert.equal(failed.retryStage, "PROFILE_CREATED");
    assert.equal(failed.appId, "cli_public");
    assert.match(failed.error, /authorization unavailable/);
  } finally {
    coordinator.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cancelling a pending application registration aborts it and ignores late completion", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-pi-setup-cancel-"));
  const { stateApi, stateModuleUrl } = await activeSetup(root);
  const registrationStarted = deferred();
  const registrationFinished = deferred();
  const managed = [];
  let aborts = 0;
  const coordinator = createPiSetupCoordinator({
    dataRoot: root,
    stateModuleUrl,
    registrationOptions: () => ({}),
    registerBot: async () => {},
    registerFactoryBot: async (name, options) => {
      options.registrationOptions.setAbort(() => { aborts += 1; });
      registrationStarted.resolve();
      await registrationFinished.promise;
      managed.push({ name, appId: "cli_late", profile: name });
    },
    readManagedBots: () => managed,
  });
  try {
    const pending = coordinator.tick();
    await registrationStarted.promise;
    await stateApi.mutatePiSetupState(coordinator.filePath, (state) => {
      state.control.cancelRequestedAt = new Date().toISOString();
      return state;
    });
    assert.equal((await coordinator.tick()).action, "busy");
    assert.equal(aborts, 1);
    assert.equal(stateApi.readPiSetupState(coordinator.filePath).status, "cancelled");
    registrationFinished.resolve();
    await pending;
    const state = stateApi.readPiSetupState(coordinator.filePath);
    assert.equal(state.status, "cancelled");
    assert.equal(state.bots[0].appId, "");
    assert.notEqual(state.bots[0].stage, "PROFILE_CREATED");
  } finally {
    coordinator.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skipping a pending registration aborts it without failing the next Bot", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-pi-setup-skip-"));
  const { stateApi, stateModuleUrl } = await activeSetup(root);
  const registrationStarted = deferred();
  const registrationFinished = deferred();
  const managed = [];
  let aborts = 0;
  const coordinator = createPiSetupCoordinator({
    dataRoot: root,
    stateModuleUrl,
    registrationOptions: () => ({}),
    registerBot: async () => {},
    registerFactoryBot: async (name, options) => {
      options.registrationOptions.setAbort(() => { aborts += 1; });
      registrationStarted.resolve();
      await registrationFinished.promise;
      managed.push({ name, appId: "cli_late", profile: name });
    },
    readManagedBots: () => managed,
  });
  try {
    const pending = coordinator.tick();
    await registrationStarted.promise;
    await stateApi.mutatePiSetupState(coordinator.filePath, (state) => {
      state.control.skipRequestedAt = new Date().toISOString();
      state.bots[0].stage = "SKIPPED";
      state.bots[0].error = "用户跳过";
      state.currentBotName = state.bots[1].name;
      return state;
    });
    assert.equal((await coordinator.tick()).action, "busy");
    assert.equal(aborts, 1);
    registrationFinished.resolve();
    await pending;
    const state = stateApi.readPiSetupState(coordinator.filePath);
    assert.equal(state.control.skipRequestedAt, "");
    assert.equal(state.bots[0].stage, "SKIPPED");
    assert.equal(state.bots[0].appId, "");
    assert.equal(state.bots[1].stage, "PENDING");
    assert.equal(state.currentBotName, "pi-agent-02");
  } finally {
    coordinator.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("late user authorization completion cannot overwrite a cancelled batch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-pi-setup-auth-cancel-"));
  const { stateApi, stateModuleUrl } = await activeSetup(root, "PROFILE_CREATED");
  const authorizationStarted = deferred();
  const authorizationFinished = deferred();
  const coordinator = createPiSetupCoordinator({
    dataRoot: root,
    stateModuleUrl,
    beginUserAuthorization: async () => ({
      verificationUrl: "https://accounts.example.test/device",
      deviceCode: "one-time-device-code",
      expiresIn: 120,
    }),
    completeUserAuthorization: async () => {
      authorizationStarted.resolve();
      await authorizationFinished.promise;
      return { identity: { available: true, verified: true, name: "Late User" } };
    },
    qrToDataUrl: async () => "data:image/png;base64," + Buffer.from("user-qr").toString("base64"),
  });
  try {
    const pending = coordinator.tick();
    await authorizationStarted.promise;
    await stateApi.mutatePiSetupState(coordinator.filePath, (state) => {
      state.control.cancelRequestedAt = new Date().toISOString();
      return state;
    });
    assert.equal((await coordinator.tick()).action, "busy");
    authorizationFinished.resolve();
    await pending;
    const state = stateApi.readPiSetupState(coordinator.filePath);
    assert.equal(state.status, "cancelled");
    assert.notEqual(state.bots[0].stage, "USER_AUTHORIZED");
    assert.equal(state.bots[0].userIdentity, undefined);
    assert.equal(state.bots[0].qrArtifact, null);
  } finally {
    coordinator.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
