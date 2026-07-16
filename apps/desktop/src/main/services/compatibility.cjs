const path = require("node:path");

const SUPPORTED_ENGINE_PROTOCOL = 1;
const MIN_NODE_MAJOR = 20;
const MIN_LARK_CLI_MAJOR = 1;

function majorVersion(value) {
  const match = String(value || "").match(/^(?:v)?(\d+)/);
  return match ? Number(match[1]) : null;
}

function item(id, label, status, detail) {
  return { id, label, status, detail: String(detail || "") };
}

function assessCompatibility(state) {
  const items = [];
  const protocol = Number(state.engine?.protocolVersion);
  items.push(item(
    "engine-protocol",
    "Bridge 引擎协议",
    protocol === SUPPORTED_ENGINE_PROTOCOL ? "good" : "bad",
    protocol ? `${protocol}（客户端支持 ${SUPPORTED_ENGINE_PROTOCOL}）` : "未检测到协议版本",
  ));

  const nodeMajor = majorVersion(state.engine?.nodeVersion);
  items.push(item(
    "node",
    "内置 Node.js",
    nodeMajor !== null && nodeMajor >= MIN_NODE_MAJOR ? "good" : "bad",
    state.engine?.nodeVersion || "不可用",
  ));

  const larkMajor = majorVersion(state.engine?.larkCliVersion);
  items.push(item(
    "lark-cli",
    "内置 lark-cli",
    larkMajor !== null && larkMajor >= MIN_LARK_CLI_MAJOR ? "good" : "bad",
    state.engine?.larkCliVersion || "不可用",
  ));

  items.push(item(
    "codex-runtime",
    "Codex 运行时",
    state.codex?.runtimeFound ? "good" : "bad",
    state.codex?.runtimeFound ? (state.codex.cliVersion || state.codex.packageVersion || "已检测") : "未检测到",
  ));

  const provider = state.provider || {};
  let providerStatus = "warn";
  let providerDetail = "尚未配置 Provider";
  if (provider.configured && provider.thirdParty) {
    providerStatus = provider.credentialAvailable === false ? "warn" : "good";
    providerDetail = `${provider.id} · ${provider.model || "模型未设置"}${provider.credentialAvailable === false ? " · 当前进程未发现密钥" : ""}`;
  } else if (provider.configured && provider.requiresOpenaiAuth) {
    providerStatus = state.codex?.loginState === "signed-in" ? "good" : "warn";
    providerDetail = state.codex?.loginState === "signed-in" ? "OpenAI 已登录" : "OpenAI 未登录";
  }
  items.push(item("provider", "当前用户 Provider", providerStatus, providerDetail));

  const schema = state.setup?.dataSchema || {};
  items.push(item(
    "data-schema",
    "客户端数据 Schema",
    schema.status === "ready" ? "good" : (schema.status === "migration-required" ? "warn" : "bad"),
    `${schema.currentVersion ?? "未知"} / ${schema.supportedVersion ?? "未知"}${schema.error ? ` · ${schema.error}` : ""}`,
  ));

  const dataRoot = String(state.setup?.dataRoot || "");
  const runtimeRoot = String(state.setup?.runtimeLocalAppData || "");
  const normalizedData = path.resolve(dataRoot || ".");
  const normalizedRuntime = path.resolve(runtimeRoot || ".");
  const isolated = Boolean(dataRoot && runtimeRoot && normalizedRuntime.startsWith(`${normalizedData}${path.sep}`));
  items.push(item(
    "runtime-isolation",
    "客户端运行目录隔离",
    isolated ? "good" : "bad",
    isolated ? "客户端 Bot 与现有 Bridge 数据分离" : "运行目录不在客户端数据根目录内",
  ));

  const status = items.some((entry) => entry.status === "bad")
    ? "bad"
    : (items.some((entry) => entry.status === "warn") ? "warn" : "good");
  return {
    status,
    items,
    versions: {
      app: state.app?.version || "",
      electron: process.versions.electron || "",
      node: state.engine?.nodeVersion || "",
      larkCli: state.engine?.larkCliVersion || "",
      engineCommit: state.engine?.sourceCommit || "",
      engineProtocol: state.engine?.protocolVersion || null,
      codexPackage: state.codex?.packageVersion || "",
      codexCli: state.codex?.cliVersion || "",
      dataSchema: schema.currentVersion ?? null,
    },
  };
}

module.exports = {
  MIN_LARK_CLI_MAJOR,
  MIN_NODE_MAJOR,
  SUPPORTED_ENGINE_PROTOCOL,
  assessCompatibility,
  majorVersion,
};
