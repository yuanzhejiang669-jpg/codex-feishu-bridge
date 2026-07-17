const fs = require("node:fs");
const path = require("node:path");

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;

function createCredentialStore(options) {
  const root = path.resolve(options.root);

  function credentialPath(name) {
    const normalized = String(name || "").trim().toUpperCase();
    if (!ENV_NAME.test(normalized)) throw new Error("Provider environment variable name is invalid");
    return path.join(root, `${normalized}.bin`);
  }

  async function read(name) {
    const destination = credentialPath(name);
    try {
      return String(options.decrypt(fs.readFileSync(destination)) || "");
    } catch (error) {
      if (error?.code === "ENOENT") return String(process.env[String(name || "").trim()] || "");
      throw new Error(`Unable to read the protected Provider credential: ${error.message}`);
    }
  }

  async function set(name, value) {
    const normalized = String(name || "").trim().toUpperCase();
    const destination = credentialPath(normalized);
    if (value == null || value === "") {
      fs.rmSync(destination, { force: true });
      delete process.env[normalized];
      return;
    }
    const encrypted = options.encrypt(String(value));
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new Error("Provider credential encryption failed");
    fs.mkdirSync(root, { recursive: true });
    const temporary = `${destination}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, encrypted);
    fs.chmodSync(temporary, 0o600);
    fs.rmSync(destination, { force: true });
    fs.renameSync(temporary, destination);
    process.env[normalized] = String(value);
  }

  function hydrate() {
    let names = [];
    try {
      names = fs.readdirSync(root).filter((name) => name.endsWith(".bin"));
    } catch {
      return { loaded: [], failed: [] };
    }
    const loaded = [];
    const failed = [];
    for (const fileName of names) {
      const name = fileName.slice(0, -4);
      if (!ENV_NAME.test(name)) continue;
      try {
        const value = String(options.decrypt(fs.readFileSync(path.join(root, fileName))) || "");
        if (value) {
          process.env[name] = value;
          loaded.push(name);
        }
      } catch (error) {
        failed.push({ name, error: String(error?.message || error) });
      }
    }
    return { loaded, failed };
  }

  return { credentialPath, hydrate, read, root, set };
}

module.exports = { createCredentialStore };
