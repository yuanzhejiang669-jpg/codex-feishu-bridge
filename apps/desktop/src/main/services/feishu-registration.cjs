const { assertLarkProfileAvailable, createManagedBot, previewBot } = require("./bot-setup.cjs");

async function loadRegistrationDependencies() {
  const [larkModule, qrModule] = await Promise.all([
    import("@larksuiteoapi/node-sdk"),
    import("qrcode"),
  ]);
  const registerApp = larkModule.registerApp || larkModule.default?.registerApp;
  const QRCode = qrModule.default || qrModule;
  if (typeof registerApp !== "function") throw new Error("飞书 SDK 不支持自动注册应用");
  return { registerApp, QRCode };
}

async function registerBotWithQr(raw, options, onProgress = () => {}) {
  const preview = previewBot(raw, options);
  if (!preview.available) throw new Error(preview.conflict);
  const assertProfileAvailable = options.assertProfileAvailable || assertLarkProfileAvailable;
  const createBot = options.createManagedBot || createManagedBot;
  await assertProfileAvailable(preview.bot.profile, options);
  const { registerApp, QRCode } = options.registrationDependencies || await loadRegistrationDependencies();
  const abort = new AbortController();
  const timeoutMs = options.timeoutMs == null
    ? Math.max(30, Number(options.timeoutSeconds || 600)) * 1000
    : Math.max(1, Number(options.timeoutMs));
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  timer.unref?.();
  options.setAbort?.(() => abort.abort());

  try {
    onProgress({ stage: "requesting", message: "正在请求飞书注册二维码" });
    const result = await registerApp({
      source: "codex",
      signal: abort.signal,
      appPreset: { name: preview.bot.label },
      onQRCodeReady: async (info) => {
        if (!info?.url) throw new Error("飞书返回了空的二维码地址");
        const dataUrl = await QRCode.toDataURL(info.url, {
          width: 320,
          margin: 2,
          errorCorrectionLevel: "M",
        });
        onProgress({
          stage: "qr-ready",
          message: "请使用飞书扫描二维码并完成授权",
          qrDataUrl: dataUrl,
          expiresIn: Number(info.expireIn || 0),
        });
      },
      onStatusChange: (info) => {
        const status = String(info?.status || "");
        if (status && status !== "polling") {
          onProgress({ stage: "authorizing", message: `飞书注册状态：${status}` });
        }
      },
    });
    const appId = String(result?.client_id || result?.appId || "").trim();
    const appSecret = String(result?.client_secret || result?.appSecret || "").trim();
    if (!appId || !appSecret) throw new Error("飞书注册完成，但没有返回应用凭据");
    onProgress({ stage: "saving", message: "授权完成，正在保存 Bot 配置" });
    let bot;
    try {
      bot = await createBot({ ...raw, ...preview.bot, provider: raw.provider }, { appId, appSecret }, options);
    } catch (error) {
      throw new Error(`飞书应用已创建，但本地 Bot 配置保存失败：${error.message}`);
    }
    onProgress({ stage: "complete", message: "Bot 配置已创建" });
    return bot;
  } catch (error) {
    if (abort.signal.aborted) throw new Error("飞书扫码注册已取消或超时");
    throw error;
  } finally {
    clearTimeout(timer);
    options.setAbort?.(null);
  }
}

module.exports = { loadRegistrationDependencies, registerBotWithQr };
