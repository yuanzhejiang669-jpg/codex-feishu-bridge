const path = require("node:path");
const { readManagedBots, runLarkCli } = require("./bot-setup.cjs");
const { DEFAULT_PERMISSION_POLICY } = require("./permission-policy.cjs");

function parseJsonOutput(value) {
  const text = String(value || "").replace(/^\uFEFF/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("lark-cli 未返回有效的授权结果");
  return JSON.parse(text.slice(start, end + 1));
}

function managedBot(name, dataRoot) {
  const bot = readManagedBots(dataRoot).find((item) => item.name === String(name || "").trim());
  if (!bot) throw new Error(`找不到客户端创建的 Bot：${name}`);
  return bot;
}

function publicUserIdentity(status) {
  const user = status?.identities?.user || {};
  return {
    available: user.available === true,
    verified: user.verified === true,
    status: String(user.status || "unknown"),
    name: String(user.name || user.displayName || ""),
    message: String(user.message || ""),
  };
}

async function beginLarkUserAuthorization(name, options) {
  const bot = managedBot(name, options.dataRoot);
  const runCli = options.runLarkCli || runLarkCli;
  const profileHome = path.join(options.dataRoot, "profile-home");

  const begin = await runCli(options.larkCliPath, [
    "auth", "login", "--scope", DEFAULT_PERMISSION_POLICY.userScopes.join(","),
    "--no-wait", "--json", "--profile", bot.profile,
  ], { profileHome, timeoutMs: 30_000 });
  const beginValue = parseJsonOutput(begin.stdout);
  const authorization = beginValue?.data || beginValue;
  const verificationUrl = String(
    authorization?.verification_url
    || authorization?.verification_uri_complete
    || authorization?.verification_uri
    || "",
  ).trim();
  const deviceCode = String(authorization?.device_code || "").trim();
  if (!verificationUrl || !deviceCode) throw new Error("飞书未返回有效的用户授权地址");
  return {
    name: bot.name,
    profile: bot.profile,
    verificationUrl,
    deviceCode,
    expiresIn: Number(authorization?.expires_in || authorization?.expire_in || 0),
  };
}

async function completeLarkUserAuthorization(name, deviceCode, options) {
  const bot = managedBot(name, options.dataRoot);
  const code = String(deviceCode || "").trim();
  if (!code) throw new Error("飞书用户授权 device code 为空");
  const runCli = options.runLarkCli || runLarkCli;
  const profileHome = path.join(options.dataRoot, "profile-home");

  await runCli(options.larkCliPath, [
    "auth", "login", "--device-code", code, "--json", "--profile", bot.profile,
  ], { profileHome, timeoutMs: options.timeoutMs || 10 * 60_000 });

  const result = await runCli(options.larkCliPath, [
    "auth", "status", "--json", "--verify", "--profile", bot.profile,
  ], { profileHome, timeoutMs: 30_000 });
  const identity = publicUserIdentity(parseJsonOutput(result.stdout));
  if (!identity.available || !identity.verified) {
    throw new Error(identity.message || "飞书用户授权尚未完成");
  }
  return {
    name: bot.name,
    profile: bot.profile,
    requestedScopeCount: DEFAULT_PERMISSION_POLICY.userScopes.length,
    identity,
  };
}

async function authorizeLarkUser(name, options) {
  const authorization = await beginLarkUserAuthorization(name, options);
  if (typeof options.openExternal !== "function") throw new Error("客户端无法打开飞书用户授权页面");
  await options.openExternal(authorization.verificationUrl);
  return completeLarkUserAuthorization(authorization.name, authorization.deviceCode, options);
}

module.exports = {
  authorizeLarkUser,
  beginLarkUserAuthorization,
  completeLarkUserAuthorization,
  parseJsonOutput,
  publicUserIdentity,
};
