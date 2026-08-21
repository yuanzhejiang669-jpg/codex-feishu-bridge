import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildPiRpcArguments,
  createPiModelsConfig,
  createPiSettings,
  resolvePiDirectories,
  writePiRuntimeConfig,
} from "../src/pi/config.mjs";

test("Pi directories isolate workspaces and agent homes while sharing a space", () => {
  const one = resolvePiDirectories({ documentsRoot: "C:/Users/test/Documents", botName: "pi-agent-01" });
  const two = resolvePiDirectories({ documentsRoot: "C:/Users/test/Documents", botName: "pi-agent-02" });
  assert.notEqual(one.workspace, two.workspace);
  assert.notEqual(one.agentHome, two.agentHome);
  assert.equal(one.configurationSpaceHome, two.configurationSpaceHome);
});

test("Pi runtime config writes atomic environment-only Provider files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-pi-config-"));
  const directories = { modelsPath: path.join(root, "models.json"), settingsPath: path.join(root, "settings.json") };
  const previous = process.env.BACKUP_API_KEY;
  process.env.BACKUP_API_KEY = "must-not-be-rendered";
  try {
    writePiRuntimeConfig({
      directories,
      provider: {
        id: "backup-api",
        baseUrl: "https://example.test/v1",
        envKey: "BACKUP_API_KEY",
        wireApi: "responses",
        model: "gpt-5.6-sol",
      },
    });
    const models = fs.readFileSync(directories.modelsPath, "utf8");
    assert.match(models, /\$BACKUP_API_KEY/);
    assert.doesNotMatch(models, /must-not-be-rendered/);
    assert.equal(JSON.parse(models).providers["backup-api"].api, "openai-responses");
    assert.equal(JSON.parse(fs.readFileSync(directories.settingsPath, "utf8")).defaultProjectTrust, "always");
  } finally {
    if (previous === undefined) delete process.env.BACKUP_API_KEY;
    else process.env.BACKUP_API_KEY = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Pi models config references an environment variable instead of a secret", () => {
  const config = createPiModelsConfig({
    id: "backup-api",
    name: "Backup API",
    baseUrl: "https://example.test/v1/",
    envKey: "BACKUP_API_KEY",
    wireApi: "responses",
    model: "gpt-5.6-sol",
  });
  assert.equal(config.providers["backup-api"].api, "openai-responses");
  assert.equal(config.providers["backup-api"].apiKey, "$BACKUP_API_KEY");
  assert.equal(config.providers["backup-api"].baseUrl, "https://example.test/v1");
});

test("Pi RPC arguments use explicit session and extension paths", () => {
  const args = buildPiRpcArguments({
    entryPath: "C:/engine/node_modules/pi/dist/cli.js",
    provider: "backup-api",
    model: "gpt-5.6-sol",
    sessionDir: "C:/pi/sessions",
    sessionFile: "C:/pi/sessions/a.jsonl",
    extensionPaths: ["C:/pi/extensions/mcp.ts"],
  });
  assert.deepEqual(args.slice(1, 5), ["--mode", "rpc", "--approve", "--provider"]);
  assert.ok(args.includes(path.resolve("C:/pi/sessions/a.jsonl")));
  assert.ok(args.includes(path.resolve("C:/pi/extensions/mcp.ts")));
  assert.equal(createPiSettings({ shellPath: "C:/Program Files/Git/bin/bash.exe" }).defaultProjectTrust, "always");
});
