const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const TOML = require("smol-toml");

function parseMcpServers(configText, configPath = "") {
  const config = TOML.parse(String(configText || "").replace(/^\uFEFF/, ""));
  return Object.entries(config.mcp_servers || {}).map(([name, raw]) => {
    const command = String(raw?.command || "").trim();
    const args = Array.isArray(raw?.args) ? raw.args.map(String) : [];
    const commandPath = resolveCommandPath(command);
    const entryPath = args.map((item) => path.isAbsolute(item) ? path.resolve(item) : "").find(Boolean) || "";
    return {
      name,
      configPath,
      configSection: `[mcp_servers.${name}]`,
      command,
      commandPath,
      entryPath,
      envKeys: raw?.env && typeof raw.env === "object" ? Object.keys(raw.env).sort() : [],
      commandAvailable: commandPath ? fs.existsSync(commandPath) : null,
      entryAvailable: entryPath ? fs.existsSync(entryPath) : null,
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

function parseMcpServerIds(configText) {
  return parseMcpServers(configText).map((item) => item.name);
}

function resolveCommandPath(command, envPath = process.env.PATH || "") {
  if (!command) return "";
  if (path.isAbsolute(command)) return path.resolve(command);
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const root of envPath.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.resolve(root, `${command}${extension}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return "";
}

function listSkills(skillsRoot) {
  try {
    return fs.readdirSync(skillsRoot, { withFileTypes: true })
      .map((entry) => {
        const skillPath = path.join(skillsRoot, entry.name);
        let sourceType = "directory";
        let realPath = skillPath;
        try {
          const stat = fs.statSync(skillPath);
          if (!stat.isDirectory()) return null;
          if (entry.isSymbolicLink()) {
            sourceType = "symlink";
            realPath = fs.realpathSync(skillPath);
          } else if (!entry.isDirectory()) {
            return null;
          }
        } catch {
          return null;
        }
        const skillFile = path.join(skillPath, "SKILL.md");
        return fs.existsSync(skillFile)
          ? { name: entry.name, path: skillPath, realPath, sourceType, skillFile }
          : null;
      })
      .filter(Boolean)
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

function inspectCapabilities(codexHome = path.join(os.homedir(), ".codex")) {
  const skillsRoot = path.join(codexHome, "skills");
  const configPath = path.join(codexHome, "config.toml");
  const agentsPath = path.join(codexHome, "AGENTS.md");
  let configText = "";
  let error = "";
  try { configText = fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""); }
  catch (readError) { if (readError?.code !== "ENOENT") error = readError.message; }
  let mcpServers = [];
  if (configText) {
    try { mcpServers = parseMcpServers(configText, configPath); }
    catch (parseError) { error = `无法解析 ${configPath}：${parseError.message}`; }
  }
  const skills = listSkills(skillsRoot);
  return {
    codexHome,
    configPath,
    agentsPath,
    agentsAvailable: fs.existsSync(agentsPath),
    skillsRoot,
    skills,
    mcpServers,
    error,
    summary: { skills: skills.length, mcpServers: mcpServers.length },
  };
}

function inspectCapabilityHomes(codexHomes = []) {
  const seen = new Set();
  return (codexHomes || []).map((value) => path.resolve(String(value || "")))
    .filter((value) => value && !seen.has(value) && seen.add(value))
    .map((value) => inspectCapabilities(value));
}

module.exports = { inspectCapabilities, inspectCapabilityHomes, listSkills, parseMcpServerIds, parseMcpServers, resolveCommandPath };
