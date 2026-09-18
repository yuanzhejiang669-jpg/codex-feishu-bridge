const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { verifyPackagedEngineDependencies } = require("./verify-packaged-engine-dependencies.cjs");

if (process.platform !== "linux") throw new Error("Linux release verification must run on Linux");

const desktopRoot = path.resolve(__dirname, "..");
const outRoot = path.join(desktopRoot, "out");
const packageJson = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
const version = String(packageJson.version);
const artifactName = `Codex-Feishu-Bridge-${version}-linux-amd64.deb`;
const artifactPath = path.join(outRoot, artifactName);
if (!fs.existsSync(artifactPath)) throw new Error(`Missing Linux release artifact: ${artifactName}`);

const packageVersion = String(execFileSync("dpkg-deb", ["--field", artifactPath, "Version"], { encoding: "utf8" })).trim();
const expectedPackageVersion = version.replace("-", "~");
if (packageVersion !== expectedPackageVersion) throw new Error(`Debian package version mismatch: ${packageVersion}`);
const packageDependencies = String(execFileSync("dpkg-deb", ["--field", artifactPath, "Depends"], { encoding: "utf8" }));
for (const dependency of ["libgtk-3-0", "libnss3", "xdg-utils", "libsecret-1-0"]) {
  if (!packageDependencies.includes(dependency)) throw new Error(`Debian package dependency is missing: ${dependency}`);
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-linux-release-"));
try {
  execFileSync("dpkg-deb", ["--extract", artifactPath, temporary], { stdio: "inherit" });
  const roots = [];
  const visit = (directory, depth = 0) => {
    if (depth > 7) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name === "resources" && fs.existsSync(path.join(candidate, "app.asar"))) roots.push(candidate);
      visit(candidate, depth + 1);
    }
  };
  visit(temporary);
  if (roots.length !== 1) throw new Error(`Expected one packaged Linux resources directory, found ${roots.length}`);
  const resources = roots[0];
  const nodePath = path.join(resources, "tools", "node");
  const larkPath = path.join(resources, "tools", "lark-cli");
  const manifestPath = path.join(resources, "tools", "manifest.json");
  const bridgePath = path.join(resources, "engine", "codex-feishu-bridge.mjs");
  const proxyLicense = path.join(resources, "proxy", "node_modules", "mimo2codex", "LICENSE");
  const updateHelper = path.join(resources, "scripts", "install-linux-update.sh");
  for (const required of [nodePath, larkPath, manifestPath, bridgePath, proxyLicense, updateHelper]) {
    if (!fs.existsSync(required)) throw new Error(`Packaged Linux item is missing: ${required}`);
  }
  execFileSync("/bin/bash", ["-n", updateHelper], { stdio: "inherit" });
  for (const executable of [nodePath, larkPath]) fs.accessSync(executable, fs.constants.X_OK);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.platform !== "linux" || manifest.architecture !== "x64") {
    throw new Error(`Bundled tool manifest mismatch: ${JSON.stringify(manifest)}`);
  }
  const nodeArchitecture = String(execFileSync("file", [nodePath], { encoding: "utf8" }));
  const larkArchitecture = String(execFileSync("file", [larkPath], { encoding: "utf8" }));
  if (!/x86-64|x86_64/i.test(nodeArchitecture) || !/x86-64|x86_64/i.test(larkArchitecture)) {
    throw new Error("Bundled Linux tool architecture mismatch");
  }
  verifyPackagedEngineDependencies({ engineRoot: path.join(resources, "engine"), nodeRuntime: nodePath });
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

process.stdout.write(`Verified Linux ${version} release for x64\n`);
