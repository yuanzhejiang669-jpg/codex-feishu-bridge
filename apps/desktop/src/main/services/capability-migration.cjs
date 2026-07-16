const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const TOML = require("smol-toml");
const { inspectCapabilities } = require("./capabilities.cjs");
const { readManagedBots } = require("./bot-setup.cjs");

const SENSITIVE_KEY = /(?:secret|token|password|api[_-]?key|credential)/i;

function containsSensitiveValue(value, key = "") {
  if (SENSITIVE_KEY.test(key) && value !== "" && value !== null && value !== undefined) return true;
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([childKey, child]) => containsSensitiveValue(child, childKey));
}

function readToml(configPath) {
  try {
    const text = fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
    return { text, value: TOML.parse(text) };
  } catch (error) {
    if (error?.code === "ENOENT") return { text: "", value: {} };
    throw new Error(`无法解析 Codex 配置：${error.message}`);
  }
}

function selectedNames(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || "").trim()).filter(Boolean))];
}

function findBot(name, dataRoot) {
  const bot = readManagedBots(dataRoot).find((item) => item.name === name);
  if (!bot) throw new Error(`找不到客户端管理的 Bot：${name}`);
  if (bot.codexHomeMode !== "isolated") throw new Error("只有隔离 Codex Home 才需要迁移 MCP 或 Skills");
  return bot;
}

function previewCapabilityMigration(name, selection, options) {
  const bot = findBot(name, options.dataRoot);
  const affectedBots = readManagedBots(options.dataRoot)
    .filter((item) => item.codexHomeMode === "isolated" && path.resolve(item.codexHome).toLowerCase() === path.resolve(bot.codexHome).toLowerCase())
    .map((item) => item.name);
  const source = inspectCapabilities(options.sourceCodexHome);
  const sourceConfig = readToml(source.configPath).value;
  const targetConfig = readToml(path.join(bot.codexHome, "config.toml")).value;
  const sourceMcp = sourceConfig.mcp_servers || {};
  const targetMcp = targetConfig.mcp_servers || {};
  const sourceSkills = new Map(source.skills.map((item) => [item.name, item]));
  const targetSkillsRoot = path.join(bot.codexHome, "skills");

  const mcpServers = selectedNames(selection?.mcpServers).map((itemName) => {
    const sourceItem = source.mcpServers.find((item) => item.name === itemName);
    const paths = { sourcePath: source.configPath, targetPath: path.join(bot.codexHome, "config.toml"), entryPath: sourceItem?.entryPath || sourceItem?.commandPath || "" };
    if (!Object.hasOwn(sourceMcp, itemName)) return { name: itemName, status: "missing", ...paths };
    if (Object.hasOwn(targetMcp, itemName)) return { name: itemName, status: "exists", ...paths };
    if (containsSensitiveValue(sourceMcp[itemName])) return { name: itemName, status: "blocked-sensitive", ...paths };
    return { name: itemName, status: "ready", ...paths };
  });
  const skills = selectedNames(selection?.skills).map((itemName) => {
    const sourceItem = sourceSkills.get(itemName);
    const paths = { sourcePath: sourceItem?.path || "", targetPath: path.join(targetSkillsRoot, itemName), entryPath: sourceItem?.skillFile || "" };
    if (!sourceItem) return { name: itemName, status: "missing", ...paths };
    if (fs.existsSync(paths.targetPath)) return { name: itemName, status: "exists", ...paths };
    return { name: itemName, status: "ready", ...paths };
  });
  return {
    bot: { name: bot.name, codexHome: bot.codexHome },
    affectedBots,
    source: { codexHome: source.codexHome, configPath: source.configPath, skillsRoot: source.skillsRoot },
    target: { codexHome: bot.codexHome, configPath: path.join(bot.codexHome, "config.toml"), skillsRoot: targetSkillsRoot },
    mcpServers,
    skills,
    summary: {
      ready: [...mcpServers, ...skills].filter((item) => item.status === "ready").length,
      blocked: [...mcpServers, ...skills].filter((item) => item.status !== "ready").length,
    },
  };
}

function applyCapabilityMigration(name, selection, options) {
  const preview = previewCapabilityMigration(name, selection, options);
  const bot = findBot(name, options.dataRoot);
  const source = inspectCapabilities(options.sourceCodexHome);
  const sourceConfig = readToml(source.configPath).value;
  const targetConfigPath = path.join(bot.codexHome, "config.toml");
  const targetRead = readToml(targetConfigPath);
  const nextConfig = structuredClone(targetRead.value);
  const readyMcp = preview.mcpServers.filter((item) => item.status === "ready");
  const readySkills = preview.skills.filter((item) => item.status === "ready");
  if (!readyMcp.length && !readySkills.length) return { ...preview, applied: 0 };

  if (readyMcp.length) {
    nextConfig.mcp_servers ||= {};
    for (const item of readyMcp) nextConfig.mcp_servers[item.name] = structuredClone(sourceConfig.mcp_servers[item.name]);
  }

  const transactionRoot = path.join(bot.codexHome, `.cfb-migration-${crypto.randomUUID()}`);
  const stagedSkills = path.join(transactionRoot, "skills");
  const targetSkillsRoot = path.join(bot.codexHome, "skills");
  const copiedSkills = [];
  const configExisted = fs.existsSync(targetConfigPath);
  const originalConfig = configExisted ? fs.readFileSync(targetConfigPath) : null;
  const temporaryConfig = `${targetConfigPath}.cfb-${crypto.randomUUID()}.tmp`;
  const backupConfig = `${targetConfigPath}.cfb-${crypto.randomUUID()}.bak`;
  fs.mkdirSync(stagedSkills, { recursive: true });

  try {
    for (const item of readySkills) {
      const sourcePath = path.join(source.skillsRoot, item.name);
      fs.cpSync(sourcePath, path.join(stagedSkills, item.name), { recursive: true, errorOnExist: true });
    }
    fs.mkdirSync(bot.codexHome, { recursive: true });
    fs.mkdirSync(targetSkillsRoot, { recursive: true });
    for (const item of readySkills) {
      fs.renameSync(path.join(stagedSkills, item.name), path.join(targetSkillsRoot, item.name));
      copiedSkills.push(item.name);
    }
    if (readyMcp.length) {
      fs.writeFileSync(temporaryConfig, `${TOML.stringify(nextConfig).trim()}\n`, "utf8");
      if (configExisted) fs.renameSync(targetConfigPath, backupConfig);
      fs.renameSync(temporaryConfig, targetConfigPath);
      fs.rmSync(backupConfig, { force: true });
    }
    fs.rmSync(transactionRoot, { recursive: true, force: true });
    return { ...preview, applied: readyMcp.length + readySkills.length };
  } catch (error) {
    for (const itemName of copiedSkills) fs.rmSync(path.join(targetSkillsRoot, itemName), { recursive: true, force: true });
    if (readyMcp.length) {
      fs.rmSync(temporaryConfig, { force: true });
      if (fs.existsSync(backupConfig)) {
        fs.rmSync(targetConfigPath, { force: true });
        fs.renameSync(backupConfig, targetConfigPath);
      } else if (originalConfig) {
        fs.writeFileSync(targetConfigPath, originalConfig);
      } else {
        fs.rmSync(targetConfigPath, { force: true });
      }
    }
    fs.rmSync(transactionRoot, { recursive: true, force: true });
    throw error;
  }
}

module.exports = {
  applyCapabilityMigration,
  containsSensitiveValue,
  previewCapabilityMigration,
  readToml,
};
