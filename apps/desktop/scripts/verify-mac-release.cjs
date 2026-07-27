const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { verifyPackagedEngineDependencies } = require("./verify-packaged-engine-dependencies.cjs");

if (process.platform !== "darwin") throw new Error("macOS release verification must run on macOS");

const desktopRoot = path.resolve(__dirname, "..");
const outRoot = path.join(desktopRoot, "out");
const packageJson = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
const version = String(packageJson.version);
const architectures = ["x64", "arm64"];
const releaseFiles = architectures.flatMap((arch) => [
  `Codex-Feishu-Bridge-${version}-mac-${arch}.dmg`,
  `Codex-Feishu-Bridge-${version}-mac-${arch}.zip`,
]);

for (const name of [...releaseFiles, "latest-mac.yml"]) {
  if (!fs.existsSync(path.join(outRoot, name))) throw new Error(`Missing macOS release artifact: ${name}`);
}
const metadata = fs.readFileSync(path.join(outRoot, "latest-mac.yml"), "utf8");
if (!new RegExp(`^version:\\s*${version.replaceAll(".", "\\.")}\\s*$`, "m").test(metadata)) {
  throw new Error(`latest-mac.yml does not report ${version}`);
}

const unpackedRoots = fs.readdirSync(outRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("mac"))
  .map((entry) => path.join(outRoot, entry.name, "Codex Feishu Bridge.app"))
  .filter((candidate) => fs.existsSync(candidate));
if (unpackedRoots.length < 2) throw new Error(`Expected two unpacked macOS applications, found ${unpackedRoots.length}`);

const verifiedArchitectures = new Set();
for (const appRoot of unpackedRoots) {
  const infoPlist = path.join(appRoot, "Contents", "Info.plist");
  const appVersion = String(execFileSync("/usr/bin/plutil", [
    "-extract", "CFBundleShortVersionString", "raw", infoPlist,
  ], { encoding: "utf8" })).trim();
  if (appVersion !== version) throw new Error(`App version mismatch at ${appRoot}: ${appVersion}`);
  const resources = path.join(appRoot, "Contents", "Resources");
  const nodePath = path.join(resources, "tools", "node");
  const larkPath = path.join(resources, "tools", "lark-cli");
  const bridgePath = path.join(resources, "engine", "codex-feishu-bridge.mjs");
  const proxyLicense = path.join(resources, "proxy", "node_modules", "mimo2codex", "LICENSE");
  for (const required of [nodePath, larkPath, bridgePath, proxyLicense]) {
    if (!fs.existsSync(required)) throw new Error(`Packaged macOS item is missing: ${required}`);
  }
  verifyPackagedEngineDependencies({
    engineRoot: path.join(resources, "engine"),
    nodeRuntime: nodePath,
  });
  const fileOutput = String(execFileSync("/usr/bin/file", [nodePath], { encoding: "utf8" }));
  const architecture = /arm64/.test(fileOutput) ? "arm64" : /x86_64/.test(fileOutput) ? "x64" : "";
  if (!architecture) throw new Error(`Unable to identify bundled Node architecture: ${fileOutput}`);
  const larkOutput = String(execFileSync("/usr/bin/file", [larkPath], { encoding: "utf8" }));
  if (architecture === "arm64" ? !/arm64/.test(larkOutput) : !/x86_64/.test(larkOutput)) {
    throw new Error(`Bundled tool architecture mismatch in ${appRoot}`);
  }
  verifiedArchitectures.add(architecture);
}
for (const architecture of architectures) {
  if (!verifiedArchitectures.has(architecture)) throw new Error(`No unpacked ${architecture} application was verified`);
}
process.stdout.write(`Verified macOS ${version} release for x64 and arm64\n`);
