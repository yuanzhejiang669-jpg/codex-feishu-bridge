import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { writeJsonFileAtomicSync } from "../utils/json.mjs";

export const PI_SETUP_FILE = "pi-setup-batch.json";
export const PI_SETUP_STAGES = Object.freeze({
  PENDING: "PENDING",
  APP_QR_REQUESTING: "APP_QR_REQUESTING",
  APP_QR_READY: "APP_QR_READY",
  APP_QR_SENT: "APP_QR_SENT",
  APP_REGISTERED: "APP_REGISTERED",
  PROFILE_CREATED: "PROFILE_CREATED",
  USER_AUTH_QR_REQUESTING: "USER_AUTH_QR_REQUESTING",
  USER_AUTH_QR_READY: "USER_AUTH_QR_READY",
  USER_AUTH_QR_SENT: "USER_AUTH_QR_SENT",
  USER_AUTHORIZED: "USER_AUTHORIZED",
  PERMISSIONS_VERIFIED: "PERMISSIONS_VERIFIED",
  READY: "READY",
  FAILED: "FAILED",
  SKIPPED: "SKIPPED",
});

const FORBIDDEN_KEY = /(?:app[_-]?secret|client[_-]?secret|device[_-]?code|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization[_-]?url|verification[_-]?url)/i;
const TRANSIENT_FALLBACK = Object.freeze({
  APP_QR_REQUESTING: "PENDING",
  USER_AUTH_QR_REQUESTING: "PROFILE_CREATED",
});

export function piSetupPath(dataRoot) {
  return path.join(path.resolve(dataRoot), PI_SETUP_FILE);
}

export function createPiSetupRequest({
  conversationId,
  coordinatorBotName,
  coordinatorProfile,
  providerId = "backup-api",
  model = "gpt-5.6-sol",
  brand = "feishu",
  now = new Date().toISOString(),
} = {}) {
  const conversation = String(conversationId || "").trim();
  const coordinator = String(coordinatorBotName || "").trim();
  if (!conversation || !coordinator) throw new Error("Pi setup requires a conversation and coordinator Bot");
  const batchId = crypto.randomUUID();
  const bots = Array.from({ length: 5 }, (_, offset) => {
    const suffix = String(offset + 1).padStart(2, "0");
    return {
      index: offset + 1,
      engine: "pi",
      name: `pi-agent-${suffix}`,
      label: `Pi Agent ${suffix}`,
      stage: PI_SETUP_STAGES.PENDING,
      attempt: 0,
      error: "",
      appId: "",
      profile: `pi-agent-${suffix}`,
      qrArtifact: null,
      permissionVerification: null,
      readiness: null,
      createdAt: now,
      updatedAt: now,
      completedAt: "",
    };
  });
  return assertSecretFree({
    schemaVersion: 1,
    revision: 1,
    batchId,
    status: "requested",
    conversationId: conversation,
    coordinator: { botName: coordinator, profile: String(coordinatorProfile || coordinator).trim() },
    provider: { mode: "global", id: String(providerId).trim(), model: String(model).trim() },
    brand: String(brand || "feishu").trim(),
    currentBotName: bots[0].name,
    control: { resendRequestedAt: "", skipRequestedAt: "", cancelRequestedAt: "" },
    bots,
    createdAt: now,
    updatedAt: now,
    completedAt: "",
  });
}

export function readPiSetupState(filePath) {
  try {
    return assertSecretFree(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function writePiSetupState(filePath, state) {
  const next = assertSecretFree(structuredClone(state));
  writeJsonFileAtomicSync(filePath, next);
  return next;
}

export async function mutatePiSetupState(filePath, mutate, { timeoutMs = 5_000, retryMs = 25 } = {}) {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + timeoutMs;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let handle;
  while (!handle) {
    try {
      handle = fs.openSync(lockPath, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST" || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
  try {
    const current = readPiSetupState(filePath);
    const next = await mutate(current ? structuredClone(current) : null);
    if (next == null) return current;
    next.revision = Number(current?.revision || 0) + 1;
    next.updatedAt = new Date().toISOString();
    return writePiSetupState(filePath, next);
  } finally {
    fs.closeSync(handle);
    fs.rmSync(lockPath, { force: true });
  }
}

export function recoverPiSetupState(state, { artifactExists = (target) => fs.existsSync(target) } = {}) {
  const next = structuredClone(state);
  for (const bot of next?.bots || []) {
    const fallback = TRANSIENT_FALLBACK[bot.stage];
    if (fallback) {
      bot.stage = fallback;
      bot.error = "上次执行被客户端退出中断，已恢复到可重试阶段";
    }
    if ([PI_SETUP_STAGES.APP_QR_READY, PI_SETUP_STAGES.USER_AUTH_QR_READY].includes(bot.stage)
      && (!bot.qrArtifact?.path || !artifactExists(bot.qrArtifact.path))) {
      bot.stage = bot.stage === PI_SETUP_STAGES.APP_QR_READY
        ? PI_SETUP_STAGES.PENDING
        : PI_SETUP_STAGES.PROFILE_CREATED;
      bot.qrArtifact = null;
      bot.error = "二维码临时文件已失效，请重发当前阶段";
    }
  }
  return assertSecretFree(next);
}

export function activePiSetupBot(state) {
  return (state?.bots || []).find((bot) => bot.name === state.currentBotName)
    || (state?.bots || []).find((bot) => ![PI_SETUP_STAGES.READY, PI_SETUP_STAGES.SKIPPED].includes(bot.stage))
    || null;
}

export function assertSecretFree(value, location = "root") {
  if (!value || typeof value !== "object") return value;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) throw new Error(`Pi setup state contains forbidden credential field at ${location}.${key}`);
    assertSecretFree(nested, `${location}.${key}`);
  }
  return value;
}
