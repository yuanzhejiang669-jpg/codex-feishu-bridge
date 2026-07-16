const path = require("node:path");

function normalize(value) {
  if (!value || typeof value !== "string") return "";
  return path.resolve(value).toLowerCase();
}

function collectKnownPaths(state) {
  const values = new Set();
  const add = (value) => {
    const normalized = normalize(value);
    if (normalized) values.add(normalized);
  };

  add(state?.bridge?.root);
  add(state?.codex?.runtimePath);
  add(state?.capabilities?.codexHome);
  add(state?.capabilities?.configPath);
  add(state?.capabilities?.skillsRoot);
  add(state?.setup?.dataRoot);
  add(state?.setup?.workspaceRoot);
  add(state?.setup?.codexHomeRoot);
  for (const item of state?.capabilities?.skills || []) {
    add(item.path);
    add(item.skillFile);
  }
  for (const item of state?.capabilities?.mcpServers || []) {
    add(item.configPath);
    add(item.commandPath);
    add(item.entryPath);
  }
  for (const bot of state?.setup?.managedBots || []) {
    add(bot.workspace);
    add(bot.codexHome);
    add(bot.configPath);
    add(bot.logDir);
    if (bot.codexHome) {
      add(path.join(bot.codexHome, "config.toml"));
      add(path.join(bot.codexHome, "skills"));
    }
  }
  for (const instance of state?.bridge?.instances || []) {
    add(instance.workspace);
    add(instance.codexHome);
    add(instance.stateDir);
    add(instance.logDir);
  }
  return values;
}

function isKnownPath(value, knownPaths) {
  return knownPaths instanceof Set && knownPaths.has(normalize(value));
}

module.exports = { collectKnownPaths, isKnownPath, normalize };
