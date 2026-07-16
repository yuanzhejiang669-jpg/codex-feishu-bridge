const { buildInstallPlan } = require("./update-policy.cjs");

function createUpdaterService(options) {
  const supported = options.supported === true;
  const updater = options.updater;
  const checkDelayMs = Math.max(0, Number(options.checkDelayMs ?? 10_000));
  const checkIntervalMs = Math.max(60_000, Number(options.checkIntervalMs ?? 4 * 60 * 60_000));
  let timer = null;
  let interval = null;
  let state = {
    supported,
    status: supported ? "idle" : "unsupported",
    currentVersion: String(options.currentVersion || ""),
    latestVersion: "",
    progress: 0,
    error: "",
    activeBots: [],
  };

  function publish(patch) {
    state = { ...state, ...patch };
    options.onState?.({ ...state });
    return { ...state };
  }

  function snapshot() {
    return { ...state, activeBots: [...(state.activeBots || [])] };
  }

  async function check() {
    if (!supported) return snapshot();
    if (["checking", "downloading", "installing"].includes(state.status)) return snapshot();
    publish({ status: "checking", error: "", activeBots: [] });
    try {
      await updater.checkForUpdates();
    } catch (error) {
      publish({ status: "error", error: String(error?.message || error) });
    }
    return snapshot();
  }

  async function install() {
    if (!supported) throw new Error("当前环境不支持客户端自动更新");
    if (!["downloaded", "blocked"].includes(state.status)) throw new Error("更新尚未下载完成");
    const plan = buildInstallPlan(await options.inspectBots());
    if (!plan.allowed) {
      publish({ status: "blocked", activeBots: plan.activeBots, error: "请等待活动任务结束后再安装" });
      return snapshot();
    }
    let transaction = null;
    try {
      transaction = await options.prepareInstall(plan.restartNames, state.latestVersion);
      publish({ status: "installing", progress: 100, error: "", activeBots: [] });
      setImmediate(() => updater.quitAndInstall(true, true));
    } catch (error) {
      await transaction?.rollback?.();
      publish({ status: "downloaded", error: String(error?.message || error), activeBots: [] });
      throw error;
    }
    return snapshot();
  }

  function start() {
    if (!supported || timer || interval) return;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.on("checking-for-update", () => publish({ status: "checking", error: "" }));
    updater.on("update-available", (info) => publish({
      status: "available",
      latestVersion: String(info?.version || ""),
      releaseNotes: typeof info?.releaseNotes === "string" ? info.releaseNotes : "",
      error: "",
    }));
    updater.on("download-progress", (progress) => publish({
      status: "downloading",
      progress: Math.max(0, Math.min(100, Number(progress?.percent || 0))),
    }));
    updater.on("update-downloaded", (info) => publish({
      status: "downloaded",
      latestVersion: String(info?.version || state.latestVersion || ""),
      progress: 100,
      error: "",
    }));
    updater.on("update-not-available", (info) => publish({
      status: "not-available",
      latestVersion: String(info?.version || state.currentVersion || ""),
      progress: 0,
      error: "",
    }));
    updater.on("error", (error) => publish({
      status: "error",
      error: String(error?.message || error),
    }));
    timer = setTimeout(() => {
      timer = null;
      void check();
    }, checkDelayMs);
    timer.unref?.();
    interval = setInterval(() => { void check(); }, checkIntervalMs);
    interval.unref?.();
  }

  function stop() {
    if (timer) clearTimeout(timer);
    if (interval) clearInterval(interval);
    timer = null;
    interval = null;
  }

  return { check, install, snapshot, start, stop };
}

module.exports = { createUpdaterService };
