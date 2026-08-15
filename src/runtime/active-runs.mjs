import fs from "node:fs";

import { writeJsonFileAtomicSync } from "../utils/json.mjs";

export function createActiveRunStore({
  activeRunsPath,
  bridgePid = process.pid,
  workspace = "",
} = {}) {
  const activeRuns = loadActiveRuns(activeRunsPath);

  function saveActiveRuns() {
    writeJsonFileAtomicSync(activeRunsPath, activeRuns);
  }

  function recordActiveRun(record) {
    const key = activeRunKey(record?.messageId);
    if (!key) return;
    const previous = activeRuns.runs[key];
    activeRuns.runs[key] = {
      messageId: key,
      chatId: String(record.chatId || ""),
      sessionId: String(record.sessionId || ""),
      cardId: String(record.cardId || ""),
      cardMessageId: String(record.cardMessageId || ""),
      startedAt: Number(record.startedAt || 0) || Date.now(),
      updatedAt: Date.now(),
      bridgePid,
      workspace,
    };
    try {
      saveActiveRuns();
    } catch (error) {
      if (previous) activeRuns.runs[key] = previous;
      else delete activeRuns.runs[key];
      throw error;
    }
  }

  function touchActiveRun(messageId) {
    const key = activeRunKey(messageId);
    if (!key || !activeRuns.runs[key]) return;
    if (Date.now() - Number(activeRuns.runs[key].updatedAt || 0) < 10_000) return;
    const previousUpdatedAt = activeRuns.runs[key].updatedAt;
    activeRuns.runs[key].updatedAt = Date.now();
    try {
      saveActiveRuns();
    } catch (error) {
      activeRuns.runs[key].updatedAt = previousUpdatedAt;
      throw error;
    }
  }

  function clearActiveRun(messageId) {
    const key = activeRunKey(messageId);
    if (!key || !activeRuns.runs[key]) return;
    const previous = activeRuns.runs[key];
    delete activeRuns.runs[key];
    try {
      saveActiveRuns();
    } catch (error) {
      activeRuns.runs[key] = previous;
      throw error;
    }
  }

  return {
    activeRuns,
    clearActiveRun,
    recordActiveRun,
    saveActiveRuns,
    touchActiveRun,
  };
}

function activeRunKey(messageId) {
  return String(messageId || "").trim();
}

function loadActiveRuns(activeRunsPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(activeRunsPath, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.runs && typeof parsed.runs === "object") return parsed;
  } catch {}
  return { runs: {} };
}
