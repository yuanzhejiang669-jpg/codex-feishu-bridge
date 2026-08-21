import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PI_GLOBAL_BOT_PRESETS, provisionPiGlobalBots } from "../src/pi/standalone.mjs";

test("standalone Pi provisioning creates three isolated global Bots with shared capabilities", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-pi-standalone-"));
  const bridgeRoot = path.join(root, "bridge");
  const documentsRoot = path.join(root, "Documents");
  const skillOne = path.join(root, "skills-one");
  const skillTwo = path.join(root, "skills-two");
  fs.mkdirSync(path.join(bridgeRoot, "extensions"), { recursive: true });
  fs.mkdirSync(skillOne, { recursive: true });
  fs.mkdirSync(skillTwo, { recursive: true });
  fs.writeFileSync(path.join(bridgeRoot, "codex-feishu-bridge.mjs"), "", "utf8");
  fs.writeFileSync(path.join(bridgeRoot, "extensions", "pi-capabilities.ts"), "", "utf8");
  const previousDeepSeek = process.env.DEEPSEEK_API_KEY;
  const previousBackup = process.env.BACKUP_API_KEY;
  process.env.DEEPSEEK_API_KEY = "deepseek-secret-must-not-leak";
  process.env.BACKUP_API_KEY = "backup-secret-must-not-leak";
  try {
    const bots = provisionPiGlobalBots({
      bridgeRoot,
      documentsRoot,
      skillPaths: [skillOne, skillTwo],
      providers: [
        { id: "deepseek-direct", name: "DeepSeek", baseUrl: "https://deepseek.test", envKey: "DEEPSEEK_API_KEY", wireApi: "responses", model: "deepseek-chat" },
        { id: "backup-api", name: "Backup", baseUrl: "https://backup.test/v1", envKey: "BACKUP_API_KEY", wireApi: "responses", model: "gpt-5.6-sol" },
      ],
    });
    assert.equal(bots.length, 3);
    assert.deepEqual(bots.map((item) => item.name), PI_GLOBAL_BOT_PRESETS.map((item) => item.name));
    assert.equal(new Set(bots.map((item) => item.workspace)).size, 3);
    assert.equal(new Set(bots.map((item) => item.agentHome)).size, 3);
    assert.equal(new Set(bots.map((item) => item.sessionDir)).size, 3);
    assert.equal(new Set(bots.map((item) => item.capabilitiesPath)).size, 1);
    for (const bot of bots) {
      const models = fs.readFileSync(bot.modelsPath, "utf8");
      assert.deepEqual(Object.keys(JSON.parse(models).providers).sort(), ["backup-api", "deepseek-direct"]);
      assert.match(models, /\$DEEPSEEK_API_KEY/);
      assert.match(models, /\$BACKUP_API_KEY/);
      assert.doesNotMatch(models, /secret-must-not-leak/);
      const manifest = fs.readFileSync(bot.manifestPath, "utf8");
      assert.doesNotMatch(manifest, /secret-must-not-leak/);
      assert.deepEqual(JSON.parse(manifest).skillPaths, [skillOne, skillTwo]);
    }
  } finally {
    if (previousDeepSeek === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousDeepSeek;
    if (previousBackup === undefined) delete process.env.BACKUP_API_KEY;
    else process.env.BACKUP_API_KEY = previousBackup;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("standalone Pi provisioning rejects a missing default Provider", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-pi-standalone-invalid-"));
  const bridgeRoot = path.join(root, "bridge");
  const skillRoot = path.join(root, "skills");
  fs.mkdirSync(path.join(bridgeRoot, "extensions"), { recursive: true });
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(bridgeRoot, "codex-feishu-bridge.mjs"), "", "utf8");
  fs.writeFileSync(path.join(bridgeRoot, "extensions", "pi-capabilities.ts"), "", "utf8");
  try {
    assert.throws(() => provisionPiGlobalBots({
      bridgeRoot,
      documentsRoot: path.join(root, "Documents"),
      skillPaths: [skillRoot],
      providers: [{ id: "backup-api", baseUrl: "https://backup.test/v1", envKey: "BACKUP_API_KEY", wireApi: "responses", model: "gpt-5.6-sol" }],
    }), /Default Pi provider is not configured/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("standalone Pi defaults derive the real user root from CODEX_HOME", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-pi-standalone-home-"));
  const bridgeRoot = path.join(root, "bridge");
  const realHome = path.join(root, "real-home");
  fs.mkdirSync(path.join(bridgeRoot, "extensions"), { recursive: true });
  fs.mkdirSync(path.join(realHome, ".codex", "skills"), { recursive: true });
  fs.mkdirSync(path.join(realHome, ".agents", "skills"), { recursive: true });
  fs.writeFileSync(path.join(bridgeRoot, "codex-feishu-bridge.mjs"), "", "utf8");
  fs.writeFileSync(path.join(bridgeRoot, "extensions", "pi-capabilities.ts"), "", "utf8");
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(realHome, ".codex");
  try {
    const bots = provisionPiGlobalBots({
      bridgeRoot,
      providers: [
        { id: "deepseek-direct", baseUrl: "https://deepseek.test", envKey: "DEEPSEEK_API_KEY", wireApi: "responses", model: "deepseek-chat" },
        { id: "backup-api", baseUrl: "https://backup.test/v1", envKey: "BACKUP_API_KEY", wireApi: "responses", model: "gpt-5.6-sol" },
      ],
    });
    assert.ok(bots.every((item) => item.workspace.startsWith(path.join(realHome, "Documents"))));
    assert.deepEqual(bots[0].skillPaths, [path.join(realHome, ".codex", "skills"), path.join(realHome, ".agents", "skills")]);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Pi launcher restores real Windows profile paths before starting the shared Bridge", () => {
  const script = fs.readFileSync(new URL("../start-pi-feishu-bridge.ps1", import.meta.url), "utf8");
  const restoreOffset = script.indexOf("$env:USERPROFILE = $resolvedUserHome");
  const launchOffset = script.indexOf("& $bridgeScript @launch");
  assert.ok(restoreOffset > 0 && restoreOffset < launchOffset);
  assert.match(script, /\$env:LOCALAPPDATA = Join-Path \$resolvedUserHome "AppData\\Local"/);
  assert.match(script, /\$env:APPDATA = Join-Path \$resolvedUserHome "AppData\\Roaming"/);
  assert.match(script, /@\(\$manifest\.extensionPaths\) \+ @\(\$manifest\.skillPaths\)/);
});
