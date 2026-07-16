const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { normalizeReleaseVersion } = require("./release-version.cjs");

const desktopRoot = path.resolve(__dirname, "..");
const outRoot = path.join(desktopRoot, "out");
const latestRoot = path.join(outRoot, "latest");
const packageJson = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
const version = String(packageJson.version || "").trim();
const installerName = `Codex Feishu Bridge Setup ${version}.exe`;
const installerPath = path.join(outRoot, installerName);
const unpackedPath = path.join(outRoot, "win-unpacked", "Codex Feishu Bridge.exe");
const latestYmlPath = path.join(outRoot, "latest.yml");

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}

function windowsProductVersion(filePath) {
  if (process.platform !== "win32") throw new Error("Windows release verification must run on Windows");
  const script = "[Console]::Out.Write((Get-Item -LiteralPath $env:CFB_RELEASE_FILE).VersionInfo.ProductVersion)";
  return String(execFileSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", script,
  ], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, CFB_RELEASE_FILE: filePath },
  })).trim();
}

for (const required of [installerPath, unpackedPath, latestYmlPath]) {
  if (!fs.existsSync(required)) throw new Error(`Release artifact is missing: ${required}`);
}

const unpackedVersion = windowsProductVersion(unpackedPath);
const installerVersion = windowsProductVersion(installerPath);
const latestYml = fs.readFileSync(latestYmlPath, "utf8");
const metadataVersion = latestYml.match(/^version:\s*([^\s]+)\s*$/m)?.[1] || "";
if ([unpackedVersion, installerVersion, metadataVersion].some((value) => (
  normalizeReleaseVersion(value) !== normalizeReleaseVersion(version)
))) {
  throw new Error(`Release version mismatch: package=${version}, unpacked=${unpackedVersion}, installer=${installerVersion}, metadata=${metadataVersion}`);
}

fs.mkdirSync(latestRoot, { recursive: true });
const stableInstallerPath = path.join(latestRoot, "Codex Feishu Bridge Setup.exe");
fs.copyFileSync(installerPath, stableInstallerPath);
const installerHash = sha256(installerPath);
const stableHash = sha256(stableInstallerPath);
if (stableHash !== installerHash) throw new Error("Stable latest installer differs from the versioned installer");

const manifest = {
  schemaVersion: 1,
  version,
  source: installerName,
  installer: path.basename(stableInstallerPath),
  size: fs.statSync(stableInstallerPath).size,
  sha256: stableHash,
};
fs.writeFileSync(path.join(latestRoot, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
fs.writeFileSync(path.join(latestRoot, "VERSION.txt"), `${version}\n`, "utf8");
process.stdout.write(`Verified ${version} and wrote ${stableInstallerPath}\n`);
