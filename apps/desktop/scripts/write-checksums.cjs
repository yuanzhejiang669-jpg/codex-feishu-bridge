const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..");
const outRoot = path.join(desktopRoot, "out");
const { version } = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
const installer = `Codex-Feishu-Bridge-Setup-${version}.exe`;
const included = [installer, `${installer}.blockmap`, "latest.yml"]
  .filter((name) => fs.existsSync(path.join(outRoot, name)));

if (!included.includes(installer)) {
  throw new Error(`Current Windows installer was not found: ${installer}`);
}

const lines = included.map((name) => {
  const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(outRoot, name))).digest("hex");
  return `${hash}  ${name}`;
});
fs.writeFileSync(path.join(outRoot, "checksums.txt"), `${lines.join("\n")}\n`, "utf8");
process.stdout.write(`Wrote checksums for ${included.length} release files\n`);
