import crypto from "node:crypto";
import fs from "node:fs";

export function createAppServerProtocol({
  config,
  applySessionThreadOverrides,
  applySessionTurnOverrides,
  userTextFromContent,
  attachmentPromptBlock,
} = {}) {
  function threadConfig() {
    const value = {};
    if (config.disableMcp) value.mcp_servers = {};
    return Object.keys(value).length ? value : null;
  }

  function startParams(session, options = {}) {
    const params = {
      cwd: config.workspace,
      approvalPolicy: "never",
      sandbox: config.codexSandbox,
      threadSource: "user",
      config: threadConfig(),
      serviceName: "codex-feishu-bridge",
    };
    return applySessionThreadOverrides(params, session, options);
  }

  function resumeParams(session, options = {}) {
    const params = {
      threadId: session.codexThreadId,
      cwd: config.workspace,
      approvalPolicy: "never",
      sandbox: config.codexSandbox,
      config: threadConfig(),
    };
    return applySessionThreadOverrides(params, session, options);
  }

  function inputItems(event, userContent) {
    const input = [];
    const text = userText(event, userContent);
    if (text) input.push({ type: "text", text, text_elements: [] });
    for (const attachment of Array.isArray(event.attachments) ? event.attachments : []) {
      if (attachment?.type === "image" && attachment.path && fs.existsSync(attachment.path)) {
        input.push({ type: "localImage", path: attachment.path });
      }
    }
    if (!input.length) input.push({ type: "text", text: "(attachment only)", text_elements: [] });
    return input;
  }

  function turnParams(threadId, event, userContent, session, options = {}) {
    const params = {
      threadId,
      input: inputItems(event, userContent),
      clientUserMessageId: event.message_id || event.id || undefined,
      cwd: config.workspace,
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    };
    return applySessionTurnOverrides(params, session, options);
  }

  function steerParams(threadId, turnId, event, userContent) {
    return {
      threadId,
      expectedTurnId: turnId,
      clientUserMessageId: event.message_id || event.id || crypto.randomUUID(),
      input: inputItems(event, userContent),
    };
  }

  function userText(event, userContent) {
    const text = String(userContent || userTextFromContent(event.content) || "").trim();
    const attachments = Array.isArray(event.attachments) ? event.attachments : [];
    if (!text && !attachments.length) return "";
    const parts = [];
    if (text) parts.push(text);
    if (attachments.length) parts.push(attachmentPromptBlock(attachments));
    return parts.join("\n\n");
  }

  return {
    inputItems,
    resumeParams,
    startParams,
    steerParams,
    threadConfig,
    turnParams,
    userText,
  };
}
