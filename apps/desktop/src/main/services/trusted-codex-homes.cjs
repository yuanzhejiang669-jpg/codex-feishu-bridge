const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const TOML = require("smol-toml");

const FILE_NAME = "trusted-codex-homes.json";

function registryPath(dataRoot) {
  return path.join(dataRoot, FILE_NAME);
}

function canonical(value) {
  return path.resolve(String(value || "").trim());
}

function readTrustedCodexHomes(dataRoot) {
  const file = registryPath(dataRoot);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.homes)) return [];
    return parsed.homes
      .filter((item) => String(item?.codexHome || "").trim())
      .map((item) => ({ codexHome: canonical(item.codexHome), trustedAt: String(item?.trustedAt || "") }))
      .filter((item) => item.codexHome);
  } catch {
    return [];
  }
}

function isTrustedCodexHome(codexHome, dataRoot) {
  const target = canonical(codexHome).toLowerCase();
  return readTrustedCodexHomes(dataRoot).some((item) => item.codexHome.toLowerCase() === target);
}

function writeRegistry(dataRoot, homes) {
  fs.mkdirSync(dataRoot, { recursive: true });
  const destination = registryPath(dataRoot);
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  const backup = `${destination}.${crypto.randomUUID()}.bak`;
  const existed = fs.existsSync(destination);
  fs.writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, homes }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    if (existed) fs.renameSync(destination, backup);
    fs.renameSync(temporary, destination);
    fs.rmSync(backup, { force: true });
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    if (fs.existsSync(backup)) {
      fs.rmSync(destination, { force: true });
      fs.renameSync(backup, destination);
    }
    throw error;
  }
  try { fs.chmodSync(destination, 0o600); } catch {}
  return destination;
}

function trustCodexHome(codexHome, options) {
  const resolved = canonical(codexHome);
  const discovered = (options.discoveredHomes || []).some((item) => canonical(item.codexHome).toLowerCase() === resolved.toLowerCase());
  if (!discovered) throw new Error("该 Codex Home 不在客户端已发现范围内");
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) throw new Error("Codex Home 目录不存在");
  const configPath = path.join(resolved, "config.toml");
  if (!fs.statSync(configPath, { throwIfNoEntry: false })?.isFile()) throw new Error("Codex Home 缺少 config.toml");
  try {
    TOML.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Codex Home 的 config.toml 无法解析：${error.message}`);
  }
  const homes = readTrustedCodexHomes(options.dataRoot);
  if (homes.some((item) => item.codexHome.toLowerCase() === resolved.toLowerCase())) {
    return { codexHome: resolved, trusted: true, changed: false, registryPath: registryPath(options.dataRoot) };
  }
  homes.push({ codexHome: resolved, trustedAt: new Date().toISOString() });
  return { codexHome: resolved, trusted: true, changed: true, registryPath: writeRegistry(options.dataRoot, homes) };
}

module.exports = {
  isTrustedCodexHome,
  readTrustedCodexHomes,
  registryPath,
  trustCodexHome,
};
