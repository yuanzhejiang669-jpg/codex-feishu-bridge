function textContent(message) {
  if (!message || typeof message !== "object") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((item) => item?.type === "text")
    .map((item) => String(item.text || ""))
    .join("");
}

function resultText(result) {
  if (!result || typeof result !== "object") return "";
  if (typeof result === "string") return result;
  if (!Array.isArray(result.content)) return "";
  return result.content
    .filter((item) => item?.type === "text")
    .map((item) => String(item.text || ""))
    .join("\n");
}

export function normalizePiUsage(value) {
  if (!value || typeof value !== "object") return null;
  return {
    inputTokens: Number(value.input) || 0,
    outputTokens: Number(value.output) || 0,
    cachedInputTokens: Number(value.cacheRead) || 0,
    cacheWriteTokens: Number(value.cacheWrite) || 0,
    totalTokens: Number(value.totalTokens) || 0,
  };
}

export function normalizePiEvent(event) {
  if (!event || typeof event !== "object") return null;
  const usage = normalizePiUsage(event.usage);
  switch (event.type) {
    case "agent_start": return { kind: "agent_started" };
    case "agent_settled": return { kind: "agent_settled" };
    case "turn_start": return { kind: "turn_started" };
    case "turn_end": return { kind: "turn_completed", text: textContent(event.message) };
    case "message_update": {
      const delta = event.assistantMessageEvent || {};
      if (delta.type === "text_delta") return { kind: "text_delta", text: String(delta.delta || ""), usage };
      if (delta.type === "thinking_delta") return { kind: "thinking_delta", text: String(delta.delta || ""), usage };
      return usage ? { kind: "usage", usage } : null;
    }
    case "message_end": {
      const role = String(event.message?.role || "");
      return role === "assistant" ? { kind: "assistant_message", text: textContent(event.message) } : null;
    }
    case "tool_execution_start":
      return {
        kind: "tool_started",
        id: String(event.toolCallId || ""),
        name: String(event.toolName || "tool"),
        input: event.args || {},
      };
    case "tool_execution_update":
      return {
        kind: "tool_updated",
        id: String(event.toolCallId || ""),
        name: String(event.toolName || "tool"),
        input: event.args || {},
        output: resultText(event.partialResult),
      };
    case "tool_execution_end":
      return {
        kind: "tool_completed",
        id: String(event.toolCallId || ""),
        name: String(event.toolName || "tool"),
        output: resultText(event.result),
        isError: event.isError === true,
      };
    case "compaction_start": return { kind: "compaction_started" };
    case "compaction_end": return { kind: "compaction_completed", result: event.result || null };
    case "auto_retry_start": return { kind: "retry_started", attempt: Number(event.attempt) || 0, delayMs: Number(event.delayMs) || 0 };
    case "auto_retry_end": return { kind: "retry_completed", success: event.success !== false };
    case "extension_error": return { kind: "extension_error", error: String(event.error || event.message || "Pi extension error") };
    case "protocol_error": return { kind: "protocol_error", error: String(event.error || "Invalid Pi RPC record") };
    default: return null;
  }
}

export function assistantTextFromPiMessage(message) {
  return textContent(message).trim();
}
