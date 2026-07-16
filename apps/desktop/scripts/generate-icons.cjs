const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const desktopRoot = path.resolve(__dirname, "..");
const source = path.join(desktopRoot, "resources", "icon.svg");
const generatedRoot = path.join(desktopRoot, "generated", "icons");
const icoPath = path.join(desktopRoot, "resources", "icon.ico");
const pngPath = path.join(desktopRoot, "resources", "icon.png");
const rendererPath = path.join(desktopRoot, "src", "renderer", "icon.png");
const sizes = [16, 24, 32, 48, 64, 128, 256];

(async () => {
  const pngToIco = (await import("png-to-ico")).default;
  fs.mkdirSync(generatedRoot, { recursive: true });
  const files = [];
  for (const size of sizes) {
    const output = path.join(generatedRoot, `icon-${size}.png`);
    await sharp(source).resize(size, size).png().toFile(output);
    files.push(output);
  }
  await sharp(source).resize(512, 512).png().toFile(pngPath);
  await sharp(source).resize(64, 64).png().toFile(rendererPath);
  fs.writeFileSync(icoPath, await pngToIco(files));
  process.stdout.write(`Generated ${icoPath}\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});

