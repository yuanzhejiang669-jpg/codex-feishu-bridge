const fs = require("node:fs");
const path = require("node:path");
const { readManagedBots, runLarkCli } = require("./bot-setup.cjs");
const {
  DEFAULT_PERMISSION_POLICY,
  comparePermissionPolicy,
  publicPermissionPolicy,
} = require("./permission-policy.cjs");

const REQUIRED_EVENT_KEYS = DEFAULT_PERMISSION_POLICY.eventKeys;

function parseJsonOutput(value) {
  const text = String(value || "").replace(/^\uFEFF/, "").trim();
  if (!text) throw new Error("lark-cli returned no JSON");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("lark-cli returned invalid JSON");
  return JSON.parse(text.slice(start, end + 1));
}

function shortError(error) {
  const raw = String(error?.message || error || "unknown error").trim();
  try {
    const parsed = parseJsonOutput(raw);
    const detail = parsed?.error || parsed;
    if (detail?.subtype === "not_configured") return "飞书 Profile 尚未配置";
    return String(detail?.message || detail?.hint || "lark-cli 请求失败")
      .replace(/\s+/g, " ")
      .slice(0, 220);
  } catch {
    return raw.replace(/\s+/g, " ").slice(0, 220);
  }
}

async function queryJson(runCli, tool, args, profileHome) {
  try {
    const result = await runCli(tool, args, { profileHome, timeoutMs: 30_000 });
    return { ok: true, value: parseJsonOutput(result.stdout) };
  } catch (error) {
    return { ok: false, error: shortError(error) };
  }
}

function providerCheck(bot, currentProvider = {}, codexLoginState = "unknown") {
  if (bot.provider?.mode === "global") {
    const available = Boolean(bot.provider.envKey && process.env[bot.provider.envKey]);
    return {
      id: "provider",
      label: "模型 Provider",
      status: available ? "good" : "bad",
      detail: available
        ? `使用空间 Provider：${bot.provider.id} / ${bot.provider.model}`
        : `空间 Provider 缺少环境变量 ${bot.provider.envKey || "未配置"}`,
    };
  }
  if (bot.provider?.mode !== "custom") {
    const providerError = String(currentProvider.error || "").trim();
    const missingThirdPartyCredential = currentProvider.thirdParty
      && currentProvider.envKey
      && currentProvider.credentialAvailable !== true;
    const missingOpenaiLogin = currentProvider.requiresOpenaiAuth
      && codexLoginState !== "signed-in";
    const currentReady = !providerError
      && !missingThirdPartyCredential
      && !missingOpenaiLogin
      && (currentProvider.configured || codexLoginState === "signed-in");
    return {
      id: "provider",
      label: "模型 Provider",
      status: currentReady ? "good" : "bad",
      detail: currentReady
        ? `使用当前 Codex 配置：${currentProvider.id || "OpenAI 登录"} / ${currentProvider.model || "默认模型"}`
        : providerError
          ? `当前 Codex 配置不可用：${providerError}`
          : missingThirdPartyCredential
            ? `当前 Provider 缺少环境变量 ${currentProvider.envKey}`
            : missingOpenaiLogin
              ? "当前 Provider 需要 OpenAI 登录，但尚未登录"
              : "当前 Codex 尚未配置可用 Provider 或 OpenAI 登录",
    };
  }
  const secretPath = path.join(path.dirname(bot.configPath), "provider-secret.bin");
  const secretAvailable = fs.existsSync(secretPath);
  return {
    id: "provider",
    label: "模型 Provider",
    status: secretAvailable ? "good" : "bad",
    detail: secretAvailable
      ? `${bot.provider.id || "custom"} / ${bot.provider.model || "未指定模型"}，密钥已安全保存`
      : "Provider 密钥文件缺失，需要重新配置",
  };
}

function agentRuntimeCheck(bot, options) {
  if (bot.engine === "pi") {
    const skillPaths = bot.piRuntime?.skillPaths || [];
    const required = [
      bot.agentHome,
      bot.sessionDir,
      bot.agentHome && path.join(bot.agentHome, "models.json"),
      bot.agentHome && path.join(bot.agentHome, "settings.json"),
      bot.piRuntime?.extensionPath,
      bot.piRuntime?.capabilitiesPath,
      ...skillPaths,
    ];
    return localCheck(
      "agentRuntime", "Pi 运行时", skillPaths.length > 0 && required.every((target) => target && fs.existsSync(target)),
      "Pi Agent Home、session、模型和能力配置完整",
      "Pi Agent Home、session、模型或能力配置不完整",
    );
  }
  return localCheck(
    "agentRuntime", "Codex 运行时", Boolean(options.codexAvailable),
    "已检测到可用 Codex 运行时", "未检测到可用 Codex 运行时",
  );
}

function localCheck(id, label, available, goodDetail, badDetail) {
  return {
    id,
    label,
    status: available ? "good" : "bad",
    detail: available ? goodDetail : badDetail,
  };
}

async function checkBotReadiness(name, options) {
  const bot = readManagedBots(options.dataRoot).find((item) => item.name === name);
  if (!bot) throw new Error(`找不到客户端创建的 Bot：${name}`);
  const runCli = options.runLarkCli || runLarkCli;
  const profileHome = path.join(options.dataRoot, "profile-home");
  const runtime = (options.runtimeBots || []).find((item) => item.name === name) || {};

  const [identityResult, authResult, permissionsResult] = await Promise.all([
    queryJson(runCli, options.larkCliPath, ["whoami", "--as", "bot", "--profile", bot.profile], profileHome),
    queryJson(runCli, options.larkCliPath, ["auth", "status", "--json", "--verify", "--profile", bot.profile], profileHome),
    queryJson(runCli, options.larkCliPath, [
      "api", "GET", "/open-apis/application/v6/scopes",
      "--as", "bot", "--profile", bot.profile, "--format", "json",
    ], profileHome),
  ]);

  const identity = identityResult.value || {};
  const botAuth = authResult.value?.identities?.bot || {};
  const userAuth = authResult.value?.identities?.user || {};
  const identityReady = identityResult.ok
    && identity.identity === "bot"
    && identity.available === true
    && identity.tokenStatus === "ready"
    && authResult.ok
    && botAuth.available === true
    && botAuth.verified === true;
  const permissionComparison = permissionsResult.ok
    ? comparePermissionPolicy(permissionsResult.value)
    : null;
  const missingExample = permissionComparison
    ? [...permissionComparison.missingTenant, ...permissionComparison.missingUser].slice(0, 3).join("、")
    : "";
  const messageEventVerified = runtime.messageEventVerified === true;
  const messageEventTime = runtime.messageEventVerifiedAt
    ? new Date(runtime.messageEventVerifiedAt).toLocaleString("zh-CN", { hour12: false })
    : "";

  const checks = [
    {
      id: "botIdentity",
      label: "飞书 Bot 身份",
      status: identityReady ? "good" : "bad",
      detail: identityReady
        ? `${botAuth.appName || bot.label || bot.name}，凭据已通过飞书服务端验证`
        : `验证失败：${identityResult.error || authResult.error || botAuth.message || "Bot 身份不可用"}`,
    },
    {
      id: "appScopes",
      label: "推荐权限",
      status: permissionComparison?.complete ? "good" : "warn",
      detail: permissionComparison?.complete
        ? `已满足推荐权限 ${permissionComparison.expectedTotal}/${permissionComparison.expectedTotal} 项（Bot/租户 ${permissionComparison.expectedTenant}，用户 ${permissionComparison.expectedUser}）`
        : permissionComparison
          ? `当前 ${permissionComparison.grantedTotal}/${permissionComparison.expectedTotal} 项；缺少 Bot/租户权限 ${permissionComparison.missingTenant.length} 项、用户权限 ${permissionComparison.missingUser.length} 项${missingExample ? `；例如 ${missingExample}` : ""}。只检查消息、卡片、会话和云文档常用能力`
          : `无法读取应用权限：${permissionsResult.error || "飞书未返回权限信息"}`,
    },
    {
      id: "userIdentity",
      label: "Lark CLI 用户身份",
      status: userAuth.available === true && userAuth.verified === true ? "good" : "warn",
      detail: userAuth.available === true && userAuth.verified === true
        ? `${userAuth.name || userAuth.displayName || "当前用户"}，用户身份已通过飞书服务端验证`
        : "尚未登录；Bot 对话可用，但日历、云盘、邮箱等用户资源暂不可用",
    },
    {
      id: "messageEvent",
      label: "消息事件",
      status: messageEventVerified ? "good" : "warn",
      detail: messageEventVerified
        ? `已收到 ${REQUIRED_EVENT_KEYS.join(", ")}；最近验证于 ${messageEventTime || "已记录"}`
        : `Bridge 将监听 ${REQUIRED_EVENT_KEYS.join(", ")}；需要在飞书发送真实消息完成验证`,
    },
    providerCheck(bot, options.currentProvider, options.codexLoginState),
    agentRuntimeCheck(bot, options),
    localCheck(
      "engine",
      "客户端引擎",
      Boolean(options.engineAvailable),
      "Bridge、Node 和 lark-cli 内置运行时完整",
      "客户端内置运行时不完整，请重新安装客户端",
    ),
    {
      id: "bridge",
      label: "Bridge 进程",
      status: runtime.online ? "good" : "warn",
      detail: runtime.online
        ? `正在运行，PID ${runtime.processId || "未知"}，活动任务 ${runtime.activeRunCount || 0}`
        : "尚未启动；基础检查通过后可以启动",
    },
  ];

  const hasBad = checks.some((item) => item.status === "bad");
  const hasWarn = checks.some((item) => item.status === "warn");
  return {
    name: bot.name,
    label: bot.label || bot.name,
    checkedAt: new Date().toISOString(),
    status: hasBad ? "bad" : hasWarn ? "warn" : "good",
    readyToStart: !hasBad,
    summary: hasBad
      ? "存在阻塞项，暂时不能确认 Bot 可用"
      : runtime.online
        ? hasWarn
          ? "基础连接正常，仍有待验证或建议完善的能力"
          : "运行准备检查已全部通过"
        : "基础配置正常，可以启动 Bot 并进行真实消息验收",
    requiredEventKeys: [...REQUIRED_EVENT_KEYS],
    permissionPolicy: publicPermissionPolicy(),
    permissionComparison,
    actions: {
      appId: String(bot.appId || ""),
      userIdentityReady: userAuth.available === true && userAuth.verified === true,
      requiredEventKeys: [...REQUIRED_EVENT_KEYS],
    },
    checks,
  };
}

module.exports = {
  REQUIRED_EVENT_KEYS,
  checkBotReadiness,
  parseJsonOutput,
};
