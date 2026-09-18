const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..");
const outRoot = path.join(desktopRoot, "out");
const { version } = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
const platform = process.argv.includes("--mac") ? "mac" : process.argv.includes("--linux") ? "linux" : "windows";
const installer = `Codex-Feishu-Bridge-Setup-${version}.exe`;
const candidates = platform === "mac"
  ? [
      `Codex-Feishu-Bridge-${version}-mac-x64.dmg`,
      `Codex-Feishu-Bridge-${version}-mac-x64.zip`,
      `Codex-Feishu-Bridge-${version}-mac-x64.zip.blockmap`,
      `Codex-Feishu-Bridge-${version}-mac-arm64.dmg`,
      `Codex-Feishu-Bridge-${version}-mac-arm64.zip`,
      `Codex-Feishu-Bridge-${version}-mac-arm64.zip.blockmap`,
      "latest-mac.yml",
    ]
  : platform === "linux"
    ? [`Codex-Feishu-Bridge-${version}-linux-amd64.deb`]
    : [installer, `${installer}.blockmap`, "latest.yml"];
const included = candidates
  .filter((name) => fs.existsSync(path.join(outRoot, name)));

if (platform === "windows" && !included.includes(installer)) {
  throw new Error(`Current Windows installer was not found: ${installer}`);
}
if (platform === "mac" && !included.some((name) => name.endsWith("-mac-arm64.dmg"))
  || platform === "mac" && !included.some((name) => name.endsWith("-mac-x64.dmg"))) {
  throw new Error("Current macOS x64 and arm64 installers were not found");
}
if (platform === "linux" && included.length !== candidates.length) {
  throw new Error("Current Linux x64 installer was not found");
}

const lines = included.map((name) => {
  const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(outRoot, name))).digest("hex");
  return `${hash}  ${name}`;
});
const outputName = platform === "mac" ? "checksums-macos.txt" : platform === "linux" ? "checksums-linux.txt" : "checksums-windows.txt";
fs.writeFileSync(path.join(outRoot, outputName), `${lines.join("\n")}\n`, "utf8");
if (platform === "windows") fs.writeFileSync(path.join(outRoot, "checksums.txt"), `${lines.join("\n")}\n`, "utf8");
process.stdout.write(`Wrote checksums for ${included.length} release files\n`);
