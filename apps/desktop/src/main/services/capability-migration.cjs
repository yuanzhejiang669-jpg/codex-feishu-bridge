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

function samePath(left, right) {
  const normalize = (value) => path.resolve(String(value || ""));
  return process.platform === "win32"
    ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
    : normalize(left) === normalize(right);
}

function entryInfo(targetPath) {
  try {
    const entry = fs.lstatSync(targetPath);
    if (!entry.isSymbolicLink()) return { exists: true, linked: false, broken: false, realPath: targetPath };
    try { return { exists: true, linked: true, broken: false, realPath: fs.realpathSync(targetPath) }; }
    catch { return { exists: true, linked: true, broken: true, realPath: "" }; }
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, linked: false, broken: false, realPath: "" };
    throw error;
  }
}

function directoryDigest(root) {
  const rows = [];
  const walk = (current, relativeRoot = "") => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name);
      const relative = path.join(relativeRoot, entry.name).split(path.sep).join("/");
      if (entry.isDirectory()) walk(absolute, relative);
      else if (entry.isFile()) rows.push(`${relative}\0${crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")}`);
      else if (entry.isSymbolicLink()) rows.push(`${relative}\0link:${fs.readlinkSync(absolute)}`);
    }
  };
  walk(root);
  return crypto.createHash("sha256").update(rows.join("\n")).digest("hex");
}

function sharedSkillPlan(sourceItem, targetPath, sharedSkillsRoot) {
  const sourceEntry = entryInfo(sourceItem.path);
  if (!sourceEntry.exists || sourceEntry.broken) return { status: sourceEntry.broken ? "broken-source-link" : "missing" };
  const sourceRealPath = sourceItem.sourceType === "symlink" ? sourceItem.realPath : sourceItem.path;
  const sharedPath = sourceItem.sourceType === "symlink"
    ? sourceRealPath
    : path.join(sharedSkillsRoot, sourceItem.name);
  const sharedEntry = entryInfo(sharedPath);
  if (sharedEntry.broken) return { status: "broken-shared-link", sharedPath };
  if (sharedEntry.exists && !samePath(sharedPath, sourceItem.path)
      && directoryDigest(sourceRealPath) !== directoryDigest(sharedEntry.realPath || sharedPath)) {
    return { status: "shared-conflict", sharedPath };
  }

  const targetEntry = entryInfo(targetPath);
  if (targetEntry.broken) return { status: "broken-target-link", sharedPath };
  if (targetEntry.linked) {
    return { status: samePath(targetEntry.realPath, sharedEntry.realPath || sharedPath) ? "aligned" : "target-conflict", sharedPath };
  }
  if (targetEntry.exists && directoryDigest(targetPath) !== directoryDigest(sourceRealPath)) {
    return { status: "target-conflict", sharedPath };
  }
  return { status: "ready", sharedPath, replaceExisting: targetEntry.exists };
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
  const sharedSkillsRoot = path.resolve(options.sharedSkillsRoot || path.join(path.dirname(options.sourceCodexHome), "skill-sources", "shared"));

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
    if (itemName === ".system") return { name: itemName, status: "blocked-system", ...paths };
    if (!sourceItem) return { name: itemName, status: "missing", ...paths };
    return { name: itemName, ...paths, ...sharedSkillPlan(sourceItem, paths.targetPath, sharedSkillsRoot) };
  });
  return {
    bot: { name: bot.name, codexHome: bot.codexHome },
    affectedBots,
    source: { codexHome: source.codexHome, configPath: source.configPath, skillsRoot: source.skillsRoot, sharedSkillsRoot },
    target: { codexHome: bot.codexHome, configPath: path.join(bot.codexHome, "config.toml"), skillsRoot: targetSkillsRoot },
    mcpServers,
    skills,
    summary: {
      ready: [...mcpServers, ...skills].filter((item) => item.status === "ready").length,
      aligned: [...mcpServers, ...skills].filter((item) => item.status === "aligned").length,
      blocked: [...mcpServers, ...skills].filter((item) => !new Set(["ready", "aligned"]).has(item.status)).length,
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
  const sourceBackups = path.join(transactionRoot, "source-backups");
  const targetBackups = path.join(transactionRoot, "target-backups");
  const targetSkillsRoot = path.join(bot.codexHome, "skills");
  const skillChanges = [];
  const configExisted = fs.existsSync(targetConfigPath);
  const originalConfig = configExisted ? fs.readFileSync(targetConfigPath) : null;
  const temporaryConfig = `${targetConfigPath}.cfb-${crypto.randomUUID()}.tmp`;
  const backupConfig = `${targetConfigPath}.cfb-${crypto.randomUUID()}.bak`;
  fs.mkdirSync(sourceBackups, { recursive: true });
  fs.mkdirSync(targetBackups, { recursive: true });

  try {
    for (const item of readySkills) {
      const sourceItem = source.skills.find((candidate) => candidate.name === item.name);
      if (!sourceItem) throw new Error(`Skill source disappeared: ${item.name}`);
      const sourcePath = sourceItem.path;
      const sharedPath = item.sharedPath;
      const targetPath = path.join(targetSkillsRoot, item.name);
      const change = { name: item.name, sourcePath, sharedPath, targetPath, sourceBackup: "", targetBackup: "", canonicalCreated: false, sourceLinked: false, targetLinked: false };
      skillChanges.push(change);
      fs.mkdirSync(path.dirname(sharedPath), { recursive: true });

      if (sourceItem.sourceType !== "symlink") {
        const sharedEntry = entryInfo(sharedPath);
        if (!sharedEntry.exists) {
          fs.renameSync(sourcePath, sharedPath);
          change.canonicalCreated = true;
        } else {
          change.sourceBackup = path.join(sourceBackups, item.name);
          fs.renameSync(sourcePath, change.sourceBackup);
        }
        fs.symlinkSync(sharedPath, sourcePath, "junction");
        change.sourceLinked = true;
      }

      const targetEntry = entryInfo(targetPath);
      if (targetEntry.exists) {
        change.targetBackup = path.join(targetBackups, item.name);
        fs.renameSync(targetPath, change.targetBackup);
      }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.symlinkSync(sharedPath, targetPath, "junction");
      change.targetLinked = true;
    }
    options.beforeCommit?.({ preview });
    if (readyMcp.length) {
      fs.writeFileSync(temporaryConfig, `${TOML.stringify(nextConfig).trim()}\n`, "utf8");
      if (configExisted) fs.renameSync(targetConfigPath, backupConfig);
      fs.renameSync(temporaryConfig, targetConfigPath);
      fs.rmSync(backupConfig, { force: true });
    }
    fs.rmSync(transactionRoot, { recursive: true, force: true });
    return { ...preview, applied: readyMcp.length + readySkills.length };
  } catch (error) {
    for (const change of [...skillChanges].reverse()) {
      if (change.targetLinked) fs.rmSync(change.targetPath, { recursive: true, force: true });
      if (change.targetBackup && entryInfo(change.targetBackup).exists) fs.renameSync(change.targetBackup, change.targetPath);
      if (change.sourceLinked) fs.rmSync(change.sourcePath, { recursive: true, force: true });
      if (change.canonicalCreated && entryInfo(change.sharedPath).exists) fs.renameSync(change.sharedPath, change.sourcePath);
      else if (change.sourceBackup && entryInfo(change.sourceBackup).exists) fs.renameSync(change.sourceBackup, change.sourcePath);
    }
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
  directoryDigest,
  entryInfo,
  sharedSkillPlan,
};
