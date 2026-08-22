#!/usr/bin/env node
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { provisionPiGlobalBots } from "../src/pi/standalone.mjs";
import { resolvePiModelLimits, resolvePiModelThinkingMetadata } from "../src/pi/model-metadata.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const { inspectCodexHome } = require("../src/codex/model-source.cjs");
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const userHome = path.basename(codexHome).toLowerCase() === ".codex" ? path.dirname(path.resolve(codexHome)) : os.homedir();
const catalog = inspectCodexHome(codexHome);
const providers = [
  provider("deepseek-direct", "deepseek-chat"),
  provider("backup-api", "gpt-5.6-sol"),
];
const bots = provisionPiGlobalBots({
  bridgeRoot: root,
  documentsRoot: path.join(userHome, "Documents"),
  skillPaths: [path.join(userHome, ".codex", "skills"), path.join(userHome, ".agents", "skills")],
  providers,
});
process.stdout.write(`${JSON.stringify({ bots: bots.map(publicBot), providerIds: providers.map((item) => item.id) }, null, 2)}\n`);

function provider(id, model) {
  const definition = catalog.providers.find((item) => item.id === id);
  if (!definition) throw new Error(`Global Codex Provider is unavailable: ${id}`);
  const metadata = resolvePiModelLimits(id, model);
  const thinking = resolvePiModelThinkingMetadata(id, model) || { reasoning: false };
  return {
    id,
    name: definition.name,
    baseUrl: definition.baseUrl,
    envKey: definition.envKey,
    wireApi: definition.wireApi,
    model,
    ...metadata,
    ...thinking,
  };
}

function publicBot(bot) {
  return {
    name: bot.name,
    label: bot.label,
    manifestPath: bot.manifestPath,
    workspace: bot.workspace,
    agentHome: bot.agentHome,
    sessionDir: bot.sessionDir,
    defaultProvider: bot.defaultProvider,
    defaultModel: bot.defaultModel,
  };
}
