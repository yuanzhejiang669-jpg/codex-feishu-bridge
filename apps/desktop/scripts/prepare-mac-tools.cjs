const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const desktopRoot = path.resolve(__dirname, "..");
const generatedRoot = path.join(desktopRoot, "generated", "tools");
const packageJson = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
const larkPackage = JSON.parse(fs.readFileSync(path.join(desktopRoot, "node_modules", "@larksuite", "cli", "package.json"), "utf8"));
const nodeVersion = String(packageJson.dependencies.node);
const larkVersion = String(larkPackage.version).replace(/-.+$/, "");
const requested = process.argv.slice(2).filter((value) => new Set(["x64", "arm64"]).has(value));
const architectures = requested.length ? [...new Set(requested)] : ["x64", "arm64"];

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toLowerCase();
}

function download(url, destination) {
  const parsed = new URL(url);
  if (!new Set(["github.com", "nodejs.org"]).has(parsed.hostname)) throw new Error(`Download host is not allowed: ${parsed.hostname}`);
  execFileSync("curl", [
    "--fail", "--location", "--silent", "--show-error",
    "--connect-timeout", "15", "--max-time", "1200", "--max-redirs", "5",
    "--retry", "5", "--retry-all-errors", "--retry-delay", "2", "--retry-max-time", "1800",
    "--output", destination, url,
  ], { stdio: ["ignore", "inherit", "inherit"] });
}

function expectedLarkHash(archiveName) {
  const checksums = fs.readFileSync(path.join(desktopRoot, "node_modules", "@larksuite", "cli", "checksums.txt"), "utf8");
  const line = checksums.split(/\r?\n/).find((item) => item.trim().endsWith(`  ${archiveName}`));
  if (!line) throw new Error(`Missing Lark CLI checksum for ${archiveName}`);
  return line.trim().split(/\s+/)[0].toLowerCase();
}

function copyExecutable(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, 0o755);
}

for (const architecture of architectures) {
  const larkArch = architecture === "x64" ? "amd64" : "arm64";
  const nodeArch = architecture;
  const targetRoot = path.join(generatedRoot, `darwin-${architecture}`);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `cfb-mac-tools-${architecture}-`));
  try {
    fs.rmSync(targetRoot, { recursive: true, force: true });
    fs.mkdirSync(targetRoot, { recursive: true });

    const larkArchiveName = `lark-cli-${larkVersion}-darwin-${larkArch}.tar.gz`;
    const larkArchive = path.join(temporary, larkArchiveName);
    download(`https://github.com/larksuite/cli/releases/download/v${larkVersion}/${larkArchiveName}`, larkArchive);
    const larkHash = sha256(larkArchive);
    const expected = expectedLarkHash(larkArchiveName);
    if (larkHash !== expected) throw new Error(`Lark CLI checksum mismatch for ${architecture}: ${larkHash}`);
    execFileSync("tar", ["-xzf", larkArchive, "-C", temporary], { stdio: "inherit" });
    copyExecutable(path.join(temporary, "lark-cli"), path.join(targetRoot, "lark-cli"));

    const nodeArchiveName = `node-v${nodeVersion}-darwin-${nodeArch}.tar.gz`;
    const nodeArchive = path.join(temporary, nodeArchiveName);
    const nodeChecksums = path.join(temporary, "SHASUMS256.txt");
    download(`https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`, nodeChecksums);
    download(`https://nodejs.org/dist/v${nodeVersion}/${nodeArchiveName}`, nodeArchive);
    const checksumLine = fs.readFileSync(nodeChecksums, "utf8").split(/\r?\n/)
      .find((line) => line.trim().endsWith(`  ${nodeArchiveName}`));
    if (!checksumLine) throw new Error(`Missing Node.js checksum for ${nodeArchiveName}`);
    const expectedNodeHash = checksumLine.trim().split(/\s+/)[0].toLowerCase();
    const nodeHash = sha256(nodeArchive);
    if (nodeHash !== expectedNodeHash) throw new Error(`Node.js checksum mismatch for ${architecture}: ${nodeHash}`);
    execFileSync("tar", ["-xzf", nodeArchive, "-C", temporary], { stdio: "inherit" });
    copyExecutable(
      path.join(temporary, `node-v${nodeVersion}-darwin-${nodeArch}`, "bin", "node"),
      path.join(targetRoot, "node"),
    );

    fs.writeFileSync(path.join(targetRoot, "manifest.json"), `${JSON.stringify({
      schemaVersion: 1,
      platform: "darwin",
      architecture,
      nodeVersion,
      nodeSha256: nodeHash,
      larkCliVersion: larkVersion,
      larkCliSha256: larkHash,
    }, null, 2)}\n`, "utf8");
    process.stdout.write(`Prepared macOS ${architecture} tools\n`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
