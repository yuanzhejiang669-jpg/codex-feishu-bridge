import fs from "node:fs";

import { writeJsonFileAtomicSync } from "../utils/json.mjs";

export function createSessionStore({
  sessionsPath,
  createSessionData,
  normalizeSessionData,
  dedupeSessions,
  sessionListLimit,
  isSessionCompatible = () => true,
} = {}) {
  const sessions = loadSessions(sessionsPath);

  function saveSessions() {
    writeJsonFileAtomicSync(sessionsPath, sessions);
  }

  function getSession(chatId) {
    const chatState = getChatState(chatId);
    let session = chatState.sessions.find((item) => item.id === chatState.currentSessionId);
    if (session && !isSessionCompatible(session)) session = null;
    if (!session) {
      session = chatState.sessions.find(isSessionCompatible) || createSessionData("默认会话");
      if (!chatState.sessions.includes(session)) chatState.sessions.unshift(session);
      chatState.currentSessionId = session.id;
      saveSessions();
    }
    return session;
  }

  function resetSession(chatId, title = "") {
    const session = createSessionData(title || "新会话");
    const chatState = getChatState(chatId);
    chatState.currentSessionId = session.id;
    chatState.sessions.unshift(session);
    chatState.sessions = dedupeSessions(chatState.sessions).slice(0, sessionListLimit());
    saveSessions();
    return session;
  }

  function getChatState(chatId) {
    const current = sessions.chats[chatId];
    if (!current) {
      const session = createSessionData("默认会话");
      sessions.chats[chatId] = {
        currentSessionId: session.id,
        sessions: [session],
      };
      saveSessions();
      return sessions.chats[chatId];
    }

    if (Array.isArray(current.sessions)) {
      current.sessions = dedupeSessions(current.sessions.map(normalizeSessionData)).slice(0, sessionListLimit());
      if (!current.currentSessionId && current.sessions[0]) current.currentSessionId = current.sessions[0].id;
      return current;
    }

    if (current.id) {
      const migrated = normalizeSessionData(current);
      sessions.chats[chatId] = {
        currentSessionId: migrated.id,
        sessions: [migrated],
      };
      saveSessions();
      return sessions.chats[chatId];
    }

    const session = createSessionData("默认会话");
    sessions.chats[chatId] = {
      currentSessionId: session.id,
      sessions: [session],
    };
    saveSessions();
    return sessions.chats[chatId];
  }

  return {
    getChatState,
    getSession,
    resetSession,
    saveSessions,
    sessions,
  };
}

function loadSessions(sessionsPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.chats) return parsed;
  } catch {}
  return { chats: {} };
}
