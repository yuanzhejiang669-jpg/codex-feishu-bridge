const fs = require("node:fs");
const path = require("node:path");
const QRCode = require("qrcode");

function createPiSetupCoordinator(options) {
  let stateApiPromise = null;
  let inFlight = null;
  let timer = null;
  let recovered = false;
  let abortCurrent = null;
  let activeBotName = "";

  const stateApi = () => stateApiPromise ||= import(options.stateModuleUrl);
  const filePath = path.join(options.dataRoot, "pi-setup-batch.json");
  const artifactRoot = path.join(options.dataRoot, ".pi-setup-artifacts");

  async function mutate(callback) {
    const api = await stateApi();
    return api.mutatePiSetupState(filePath, callback);
  }

  async function recoverOnce() {
    if (recovered) return;
    recovered = true;
    const api = await stateApi();
    const current = api.readPiSetupState(filePath);
    if (!current || !["requested", "active"].includes(current.status)) return;
    const next = api.recoverPiSetupState(current, { artifactExists: () => false });
    for (const bot of next.bots || []) {
      if ([api.PI_SETUP_STAGES.APP_QR_READY, api.PI_SETUP_STAGES.APP_QR_SENT].includes(bot.stage)) {
        bot.stage = api.PI_SETUP_STAGES.PENDING;
        bot.qrArtifact = null;
      }
      if ([api.PI_SETUP_STAGES.USER_AUTH_QR_READY, api.PI_SETUP_STAGES.USER_AUTH_QR_SENT].includes(bot.stage)) {
        bot.stage = api.PI_SETUP_STAGES.PROFILE_CREATED;
        bot.qrArtifact = null;
      }
    }
    await mutate(() => next);
    fs.rmSync(artifactRoot, { recursive: true, force: true });
  }

  function writeQrArtifact(batchId, botName, kind, dataUrl) {
    const match = /^data:image\/png;base64,(.+)$/i.exec(String(dataUrl || ""));
    if (!match) throw new Error("二维码渲染结果不是 PNG data URL");
    fs.mkdirSync(artifactRoot, { recursive: true });
    const target = path.join(artifactRoot, `${batchId}-${botName}-${kind}.png`);
    fs.writeFileSync(target, Buffer.from(match[1], "base64"), { mode: 0o600 });
    return target;
  }

  function removeArtifact(bot) {
    if (bot?.qrArtifact?.path) fs.rmSync(bot.qrArtifact.path, { force: true });
  }

  function activeWritableBot(state, botName) {
    if (state?.status !== "active" || state.currentBotName !== botName) return null;
    if (state.control?.cancelRequestedAt || state.control?.skipRequestedAt) return null;
    const bot = state.bots.find((item) => item.name === botName);
    return bot && !["READY", "SKIPPED"].includes(bot.stage) ? bot : null;
  }

  async function setQr(botName, kind, dataUrl, expiresIn) {
    return mutate((state) => {
      const bot = activeWritableBot(state, botName);
      if (!bot) return state;
      removeArtifact(bot);
      const artifactPath = writeQrArtifact(state.batchId, botName, kind, dataUrl);
      const seconds = Math.max(0, Number(expiresIn || 0));
      bot.stage = kind === "app" ? "APP_QR_READY" : "USER_AUTH_QR_READY";
      bot.qrArtifact = {
        path: artifactPath,
        kind,
        expiresAt: seconds ? new Date(Date.now() + seconds * 1000).toISOString() : "",
        idempotencyKey: `${state.batchId}-${botName}-${kind}-${bot.attempt}`,
        sentAt: "",
      };
      bot.error = "";
      return state;
    });
  }

  async function initializeBatch(state) {
    const queue = options.createQueue({
      engine: "pi",
      providerId: state.provider.id,
      model: state.provider.model,
      brand: state.brand,
      reasoning: "medium",
    });
    await mutate((next) => {
      next.status = "active";
      for (const target of next.bots) {
        const queued = queue.bots.find((bot) => bot.name === target.name);
        if (!queued) throw new Error(`Pi setup queue is missing ${target.name}`);
        Object.assign(target, {
          workspace: queued.workspace,
          agentHome: queued.agentHome,
          sessionDir: queued.sessionDir,
          configurationSpace: queued.configurationSpace,
        });
      }
      return next;
    });
  }

  async function registerApp(bot) {
    let claimed = false;
    await mutate((state) => {
      const target = activeWritableBot(state, bot.name);
      if (!target) return state;
      claimed = true;
      target.stage = "APP_QR_REQUESTING";
      target.retryStage = "PENDING";
      target.attempt += 1;
      target.error = "";
      return state;
    });
    if (!claimed) return;
    const registrationOptions = {
      ...options.registrationOptions(),
      setAbort: (abort) => { abortCurrent = abort; },
    };
    await options.registerFactoryBot(bot.name, {
      dataRoot: options.dataRoot,
      registerBot: options.registerBot,
      registrationOptions,
      retryFailed: true,
    }, async (progress) => {
      if (progress.stage === "qr-ready") {
        await setQr(bot.name, "app", progress.qrDataUrl, progress.expiresIn);
      }
    });
    abortCurrent = null;
    const managed = options.readManagedBots().find((item) => item.name === bot.name);
    if (!managed) throw new Error(`应用注册完成后找不到 ${bot.name} 的本地配置`);
    await mutate((state) => {
      const target = activeWritableBot(state, bot.name);
      if (!target) return state;
      removeArtifact(target);
      target.qrArtifact = null;
      target.appId = managed.appId;
      target.profile = managed.profile;
      target.stage = "PROFILE_CREATED";
      target.retryStage = "PROFILE_CREATED";
      return state;
    });
  }

  async function authorizeUser(bot) {
    let claimed = false;
    await mutate((state) => {
      const target = activeWritableBot(state, bot.name);
      if (!target) return state;
      claimed = true;
      target.stage = "USER_AUTH_QR_REQUESTING";
      target.retryStage = "PROFILE_CREATED";
      target.attempt += 1;
      target.error = "";
      return state;
    });
    if (!claimed) return;
    const auth = await options.beginUserAuthorization(bot.name);
    const dataUrl = await (options.qrToDataUrl || QRCode.toDataURL)(auth.verificationUrl, {
      width: 320, margin: 2, errorCorrectionLevel: "M",
    });
    await setQr(bot.name, "user-auth", dataUrl, auth.expiresIn);
    const result = await options.completeUserAuthorization(bot.name, auth.deviceCode);
    await mutate((state) => {
      const target = activeWritableBot(state, bot.name);
      if (!target) return state;
      removeArtifact(target);
      target.qrArtifact = null;
      target.stage = "USER_AUTHORIZED";
      target.retryStage = "USER_AUTHORIZED";
      target.userIdentity = result.identity;
      return state;
    });
  }

  async function verifyAndStart(bot) {
    const readiness = await options.checkReadiness(bot.name);
    if (!readiness.actions?.userIdentityReady) throw new Error("飞书用户身份尚未验证");
    if (!readiness.permissionComparison?.complete) throw new Error("飞书推荐权限尚未完整授予");
    if (!readiness.readyToStart) throw new Error(readiness.summary || "Pi Bot readiness 未通过");
    let verified = false;
    await mutate((state) => {
      const target = activeWritableBot(state, bot.name);
      if (!target) return state;
      verified = true;
      target.stage = "PERMISSIONS_VERIFIED";
      target.retryStage = "USER_AUTHORIZED";
      target.permissionVerification = {
        complete: true,
        grantedTotal: readiness.permissionComparison.grantedTotal,
        expectedTotal: readiness.permissionComparison.expectedTotal,
        checkedAt: readiness.checkedAt,
      };
      return state;
    });
    if (!verified) return;
    await options.startBot(bot.name);
    const online = options.readManagedBots().find((item) => item.name === bot.name);
    await mutate((state) => {
      const target = activeWritableBot(state, bot.name);
      if (!target) return state;
      target.stage = "READY";
      target.readiness = { readyToStart: true, online: online?.online === true, checkedAt: readiness.checkedAt };
      target.completedAt = new Date().toISOString();
      const next = state.bots.find((item) => !["READY", "SKIPPED"].includes(item.stage));
      state.currentBotName = next?.name || "";
      if (!next) {
        state.status = "complete";
        state.completedAt = new Date().toISOString();
      }
      return state;
    });
  }

  async function processCurrent() {
    const api = await stateApi();
    const state = api.readPiSetupState(filePath);
    if (!state || !["requested", "active"].includes(state.status)) return { action: "idle" };
    if (state.control?.cancelRequestedAt) {
      abortCurrent?.();
      await mutate((next) => { next.status = "cancelled"; next.currentBotName = ""; return next; });
      return { action: "cancelled" };
    }
    if (state.status === "requested") {
      await initializeBatch(state);
      return { action: "initialized" };
    }
    const bot = api.activePiSetupBot(state);
    if (!bot) return { action: "idle" };
    activeBotName = bot.name;
    if (bot.stage === "PENDING") await registerApp(bot);
    else if (bot.stage === "PROFILE_CREATED") await authorizeUser(bot);
    else if (["USER_AUTHORIZED", "PERMISSIONS_VERIFIED"].includes(bot.stage)) await verifyAndStart(bot);
    else return { action: "waiting", stage: bot.stage };
    return { action: "advanced", name: bot.name };
  }

  async function tick() {
    await recoverOnce();
    if (inFlight) {
      const api = await stateApi();
      const state = api.readPiSetupState(filePath);
      if (state?.control?.cancelRequestedAt || state?.control?.skipRequestedAt) {
        abortCurrent?.();
        await mutate((next) => {
          const interrupted = next.bots.find((item) => item.name === activeBotName);
          removeArtifact(interrupted);
          if (interrupted) interrupted.qrArtifact = null;
          if (next.control?.cancelRequestedAt) {
            next.status = "cancelled";
            next.currentBotName = "";
          }
          next.control.skipRequestedAt = "";
          return next;
        });
      }
      return { action: "busy" };
    }
    inFlight = processCurrent().catch(async (error) => {
      abortCurrent = null;
      await mutate((state) => {
        if (!state) return state;
        if (state.control?.cancelRequestedAt) {
          state.status = "cancelled";
          state.currentBotName = "";
          return state;
        }
        if (state.control?.skipRequestedAt) return state;
        const bot = state.bots.find((item) => item.name === activeBotName);
        if (!bot || bot.stage === "SKIPPED" || state.currentBotName !== activeBotName) return state;
        if (bot) {
          removeArtifact(bot);
          bot.qrArtifact = null;
          bot.stage = "FAILED";
          bot.error = String(error?.message || error).slice(0, 1000);
        }
        return state;
      });
      return { action: "failed", error: String(error?.message || error) };
    }).finally(() => {
      inFlight = null;
      activeBotName = "";
    });
    return inFlight;
  }

  function start(intervalMs = 1_000) {
    if (timer) return;
    timer = setInterval(() => { void tick(); }, intervalMs);
    timer.unref?.();
    void tick();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    abortCurrent?.();
  }

  return { filePath, start, stop, tick };
}

module.exports = { createPiSetupCoordinator };
