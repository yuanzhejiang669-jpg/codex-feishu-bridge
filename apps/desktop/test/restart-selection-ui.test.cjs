const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(desktopRoot, relative), "utf8");

test("ships selected safe and forced Bot restart controls through every desktop layer", () => {
  const html = read("src/renderer/index.html");
  const renderer = read("src/renderer/app.js");
  const preload = read("src/preload/index.cjs");
  const main = read("src/main/index.cjs");

  for (const id of [
    "select-all-bots-button",
    "clear-all-bots-button",
    "safe-restart-bots-button",
    "force-restart-bots-button",
    "force-restart-dialog",
    "force-restart-confirm",
  ]) assert.match(html, new RegExp(`id=["']${id}["']`));
  assert.match(renderer, /managed-bot-selection/);
  assert.match(renderer, /selectedManagedBotNames/);
  assert.match(renderer, /restartBots\(\{ names, force \}\)/);
  assert.match(preload, /desktop:restart-bots/);
  assert.match(main, /restartSelectedManagedBots/);
  assert.doesNotMatch(html, /restart-online-bots-button/);
});

test("installed-upgrade verification scales its recovery window with managed Bot count", () => {
  const script = read("scripts/verify-installed-upgrade.ps1");
  assert.match(script, /\$recoveryTimeoutSeconds\s*=\s*\[Math\]::Max\(300, \(\$before\.Count \* 120\) \+ 90\)/);
  assert.match(script, /AddSeconds\(\$recoveryTimeoutSeconds\)/);
  assert.doesNotMatch(script, /AddMinutes\(5\)/);
});
