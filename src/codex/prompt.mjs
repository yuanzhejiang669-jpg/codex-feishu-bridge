export function formatRecentHistory(session, maxTurns = 8, maxChars = 4000) {
  const items = Array.isArray(session?.history) ? session.history.slice(-maxTurns) : [];
  const lines = items
    .filter((item) => item && typeof item.text === "string" && item.text.trim())
    .map((item) => `${item.role === "assistant" ? "Assistant" : "User"}: ${item.text.trim()}`);
  return lines.join("\n").slice(-maxChars);
}

export function buildExecPrompt(event, session, { userTextFromContent, attachmentPromptBlock } = {}) {
  const content = typeof userTextFromContent === "function"
    ? userTextFromContent(event?.content)
    : String(event?.content || "").trim();
  const attachments = Array.isArray(event?.attachments) ? event.attachments : [];
  const history = formatRecentHistory(session);
  const parts = [];
  if (history) parts.push(`最近上下文：\n${history}`);
  parts.push(content || (attachments.length ? "(attachment only)" : "(empty message)"));
  if (attachments.length && typeof attachmentPromptBlock === "function") {
    parts.push(attachmentPromptBlock(attachments));
  }
  return parts.join("\n\n");
}
