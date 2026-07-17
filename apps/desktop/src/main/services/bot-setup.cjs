const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { publicPermissionPolicy } = require("./permission-policy.cjs");
const { prepareProviderConfiguration } = require("./provider-setup.cjs");

const NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,62}[A-Za-z0-9])?$/;

function resolveBotCreationTarget(raw = {}, options = {}) {
  const mode = String(raw.configurationTarget || "").trim().toLowerCase();
  if (!mode) return { input: raw, target: null };
  if (mode === "global") {
    return {
      input: {
        ...raw,
        codexHomeMode: "shared",
        codexHome: options.defaultCodexHome,
        provider: { mode: "current" },
      },
      target: { mode: "global", sourceName: "", spaceName: "" },
    };
  }
  if (mode !== "space") throw new Error("Bot 配置归属只能是全局配置或已有空间");
  const sourceName = String(raw.spaceSourceName || "").trim();
  const source = readManagedBots(options.dataRoot).find((item) => item.name === sourceName);
  if (!source || source.codexHomeMode !== "isolated" || !source.codexHome || !source.workspaceFactory) {
    throw new Error("请选择有效的已有空间");
  }
  if (!source.provider || source.provider.mode !== "global") {
    throw new Error("目标空间缺少可继承的 Provider 配置");
  }
  const workspaceFactory = source.workspaceFactory;
  return {
    input: {
      ...raw,
      codexHomeMode: "isolated",
      codexHome: source.codexHome,
    },
    target: {
      mode: "space",
      sourceName: source.name,
      spaceName: String(workspaceFactory.spaceName || source.label || source.name),
      workspaceFactory,
      provider: source.provider ? structuredClone(source.provider) : null,
    },
  };
}

function normalizeBotInput(raw = {}, { workspaceRoot, codexHomeRoot, defaultCodexHome } = {}) {
  const name = String(raw.name || "").trim();
  if (!NAME_PATTERN.test(name)) {
    throw new Error("Bot 标识只能包含字母、数字、点、下划线和连字符，长度为 1-64 个字符");
  }
  const profile = String(raw.profile || name).trim();
  if (!NAME_PATTERN.test(profile)) throw new Error("飞书 Profile 名称格式无效");
  const brand = String(raw.brand || "feishu").trim().toLowerCase();
  if (!new Set(["feishu", "lark"]).has(brand)) throw new Error("飞书品牌只能是 feishu 或 lark");
  const root = path.resolve(workspaceRoot || path.join(os.homedir(), "Documents", "Codex", "workspaces"));
  const workspace = path.resolve(String(raw.workspace || "").trim() || path.join(root, `feishu-bridge-${name}`));
  if (workspace === path.parse(workspace).root) throw new Error("工作空间不能是磁盘根目录");
  const codexHomeMode = String(raw.codexHomeMode || "shared").trim().toLowerCase();
  if (!new Set(["shared", "isolated"]).has(codexHomeMode)) throw new Error("Codex Home 模式无效");
  const codexHome = codexHomeMode === "isolated"
    ? path.resolve(String(raw.codexHome || "").trim() || path.join(codexHomeRoot || root, name))
    : path.resolve(String(raw.codexHome || "").trim() || defaultCodexHome || path.join(os.homedir(), ".codex"));
  return {
    name,
    profile,
    label: String(raw.label || name).trim().slice(0, 100) || name,
    brand,
    workspace,
    codexHome,
    codexHomeMode,
  };
}

function readManagedBots(dataRoot) {
  const botsRoot = path.join(dataRoot, "managed-bots");
  try {
    return fs.readdirSync(botsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        try {
          const configPath = path.join(botsRoot, entry.name, "bot.json");
          return { ...JSON.parse(fs.readFileSync(configPath, "utf8")), configPath };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

function previewBot(raw, options) {
  const resolved = resolveBotCreationTarget(raw, options);
  const bot = normalizeBotInput(resolved.input, options);
  const conflicts = new Set([
    ...(options?.existingNames || []),
    ...readManagedBots(options.dataRoot).map((item) => item.name),
  ]);
  return {
    bot,
    paths: {
      workspace: bot.workspace,
      codexHome: bot.codexHome,
      botConfig: path.join(options.dataRoot, "managed-bots", bot.name, "bot.json"),
      profileHome: path.join(options.dataRoot, "profile-home"),
      runtimeRoot: options.runtimeLocalAppData
        ? path.join(options.runtimeLocalAppData, "CodexFeishuBridge", "instances", bot.name)
        : "",
      logDir: options.runtimeLocalAppData
        ? path.join(options.runtimeLocalAppData, "CodexFeishuBridge", "instances", bot.name, "logs")
        : "",
    },
    available: !conflicts.has(bot.name),
    conflict: conflicts.has(bot.name) ? `Bot 标识已存在：${bot.name}` : "",
    target: resolved.target ? {
      mode: resolved.target.mode,
      sourceName: resolved.target.sourceName,
      spaceName: resolved.target.spaceName,
    } : null,
  };
}

function runLarkCli(larkCliPath, args, { input = "", profileHome, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(larkCliPath, args, {
      windowsHide: true,
      timeout: timeoutMs,
      encoding: "utf8",
      env: {
        ...process.env,
        USERPROFILE: profileHome,
        HOME: profileHome,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
      },
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || stdout || error.message).trim()));
        return;
      }
      resolve({ stdout, stderr });
    });
    if (input) child.stdin?.end(input);
  });
}

async function assertLarkProfileAvailable(profile, options) {
  const runCli = options.runLarkCli || runLarkCli;
  const profileHome = path.join(options.dataRoot, "profile-home");
  fs.mkdirSync(profileHome, { recursive: true });
  const result = await runCli(options.larkCliPath, ["profile", "list"], { profileHome });
  let profiles;
  try {
    profiles = JSON.parse(String(result.stdout || "[]").replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("无法读取客户端隔离的飞书 Profile 列表");
  }
  if (profiles.some((item) => item?.name === profile)) throw new Error(`飞书 Profile 已存在：${profile}`);
}

async function createManagedBot(raw, credentials, options) {
  const preview = previewBot(raw, options);
  const resolved = resolveBotCreationTarget(raw, options);
  if (!preview.available) throw new Error(preview.conflict);
  const appId = String(credentials?.appId || "").trim();
  const appSecret = String(credentials?.appSecret || "").trim();
  if (!/^cli_[A-Za-z0-9]+$/.test(appId)) throw new Error("飞书 App ID 格式无效");
  if (!appSecret) throw new Error("飞书 App Secret 不能为空");
  await assertLarkProfileAvailable(preview.bot.profile, options);

  const runCli = options.runLarkCli || runLarkCli;
  const transactionId = crypto.randomUUID();
  const transactionRoot = path.join(options.dataRoot, ".transactions", transactionId);
  const finalRoot = path.join(options.dataRoot, "managed-bots", preview.bot.name);
  const profileHome = path.join(options.dataRoot, "profile-home");
  const workspaceExisted = fs.existsSync(preview.bot.workspace);
  const codexHomeExisted = fs.existsSync(preview.bot.codexHome);
  let profileAdded = false;
  let providerPlan = null;
  fs.mkdirSync(transactionRoot, { recursive: true });

  try {
    fs.mkdirSync(preview.bot.workspace, { recursive: true });
    fs.mkdirSync(preview.bot.codexHome, { recursive: true });
    fs.mkdirSync(profileHome, { recursive: true });
    if (resolved.target?.mode !== "space") {
      providerPlan = prepareProviderConfiguration(preview.bot, resolved.input.provider, {
        transactionRoot,
        encryptSecret: options.encryptSecret,
        sourceCodexHome: options.sourceCodexHome,
        env: options.env,
      });
    }
    await runCli(options.larkCliPath, [
      "profile", "add", "--name", preview.bot.profile,
      "--app-id", appId, "--brand", preview.bot.brand, "--app-secret-stdin",
    ], { input: appSecret, profileHome });
    profileAdded = true;

    const config = {
      schemaVersion: 1,
      ...preview.bot,
      ...(resolved.target?.provider ? { provider: resolved.target.provider } : {}),
      ...(providerPlan ? { provider: providerPlan.publicConfig } : {}),
      ...(resolved.target?.workspaceFactory ? { workspaceFactory: resolved.target.workspaceFactory } : {}),
      ...(resolved.target ? { creationTarget: { mode: resolved.target.mode, sourceName: resolved.target.sourceName } } : {}),
      permissionPolicy: publicPermissionPolicy(),
      appId,
      createdAt: new Date().toISOString(),
      state: "configured",
    };
    fs.writeFileSync(path.join(transactionRoot, "bot.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
    providerPlan?.commit();
    fs.mkdirSync(path.dirname(finalRoot), { recursive: true });
    fs.renameSync(transactionRoot, finalRoot);
    return { ...config, configPath: path.join(finalRoot, "bot.json") };
  } catch (error) {
    providerPlan?.rollback();
    if (profileAdded) {
      try {
        await runCli(options.larkCliPath, ["profile", "remove", preview.bot.profile], { profileHome });
      } catch {
        // The original failure remains the actionable error; reconciliation will detect a leftover profile.
      }
    }
    fs.rmSync(transactionRoot, { recursive: true, force: true });
    if (!workspaceExisted) {
      try {
        if (fs.readdirSync(preview.bot.workspace).length === 0) fs.rmdirSync(preview.bot.workspace);
      } catch {
        // Never remove a non-empty workspace during rollback.
      }
    }
    if (!codexHomeExisted) {
      try {
        if (fs.readdirSync(preview.bot.codexHome).length === 0) fs.rmdirSync(preview.bot.codexHome);
      } catch {
        // Never remove a non-empty Codex Home during rollback.
      }
    }
    throw error;
  }
}

module.exports = {
  assertLarkProfileAvailable,
  createManagedBot,
  normalizeBotInput,
  previewBot,
  readManagedBots,
  resolveBotCreationTarget,
  runLarkCli,
};
