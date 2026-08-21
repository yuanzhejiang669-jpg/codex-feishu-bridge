import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  activePiSetupBot,
  assertSecretFree,
  createPiSetupRequest,
  mutatePiSetupState,
  PI_SETUP_STAGES,
  readPiSetupState,
  recoverPiSetupState,
  writePiSetupState,
} from "../src/pi/setup-state.mjs";

test("creates the fixed secret-free five Bot setup request", () => {
  const state = createPiSetupRequest({ conversationId: "oc_chat", coordinatorBotName: "codex-1" });
  assert.deepEqual(state.bots.map((bot) => bot.name), [
    "pi-agent-01", "pi-agent-02", "pi-agent-03", "pi-agent-04", "pi-agent-05",
  ]);
  assert.equal(state.bots.every((bot) => bot.engine === "pi" && bot.stage === "PENDING"), true);
  assert.equal(JSON.stringify(state).includes("BACKUP_API_KEY"), false);
  assert.throws(() => assertSecretFree({ deviceCode: "secret" }), /forbidden credential field/);
  assert.throws(() => assertSecretFree({ app_secret: "secret" }), /forbidden credential field/);
});

test("serializes mutations and increments a persistent revision", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-pi-setup-state-"));
  const filePath = path.join(root, "batch.json");
  try {
    writePiSetupState(filePath, createPiSetupRequest({ conversationId: "oc_chat", coordinatorBotName: "codex-1" }));
    await Promise.all(Array.from({ length: 4 }, () => mutatePiSetupState(filePath, (state) => {
      state.bots[0].attempt += 1;
      return state;
    })));
    const state = readPiSetupState(filePath);
    assert.equal(state.bots[0].attempt, 4);
    assert.equal(state.revision, 5);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("recovers interrupted and expired QR stages without repeating completed objects", () => {
  const state = createPiSetupRequest({ conversationId: "oc_chat", coordinatorBotName: "codex-1" });
  state.bots[0].stage = PI_SETUP_STAGES.APP_QR_REQUESTING;
  state.bots[1].stage = PI_SETUP_STAGES.USER_AUTH_QR_REQUESTING;
  state.bots[1].appId = "cli_public";
  state.bots[2].stage = PI_SETUP_STAGES.APP_QR_READY;
  state.bots[2].qrArtifact = { path: "missing.png", kind: "app", expiresAt: "" };
  const recovered = recoverPiSetupState(state, { artifactExists: () => false });
  assert.equal(recovered.bots[0].stage, PI_SETUP_STAGES.PENDING);
  assert.equal(recovered.bots[1].stage, PI_SETUP_STAGES.PROFILE_CREATED);
  assert.equal(recovered.bots[1].appId, "cli_public");
  assert.equal(recovered.bots[2].stage, PI_SETUP_STAGES.PENDING);
  assert.equal(activePiSetupBot(recovered).name, "pi-agent-01");
});
