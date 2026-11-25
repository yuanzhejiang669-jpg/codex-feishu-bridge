import crypto from "node:crypto";
import {
  formatAttachmentFailurePromptNote,
  formatDemotedVisionNotice,
  partitionVisionAttachments,
} from "../attachments/vision-guard.mjs";

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
      cwd: session?.codexWorkspace || config.workspace,
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
      cwd: session?.codexWorkspace || config.workspace,
      approvalPolicy: "never",
      sandbox: config.codexSandbox,
      config: threadConfig(),
    };
    return applySessionThreadOverrides(params, session, options);
  }

  function inputItems(event, userContent) {
    const input = [];
    const { inlineImages, demotedImages, limits } = partitionVisionAttachments(event.attachments);
    const text = userText(event, userContent, demotedImages, limits);
    if (text) input.push({ type: "text", text, text_elements: [] });
    for (const { attachment } of inlineImages) {
      input.push({ type: "localImage", path: attachment.path });
    }
    if (!input.length) input.push({ type: "text", text: "(attachment only)", text_elements: [] });
    return input;
  }

  function turnParams(threadId, event, userContent, session, options = {}) {
    const params = {
      threadId,
      input: inputItems(event, userContent),
      clientUserMessageId: event.message_id || event.id || undefined,
      cwd: session?.codexWorkspace || config.workspace,
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

  function userText(event, userContent, demotedImages = null, limits = null) {
    const text = String(userContent || userTextFromContent(event.content) || "").trim();
    const attachments = Array.isArray(event.attachments) ? event.attachments : [];
    const failures = Array.isArray(event.attachmentFailures) ? event.attachmentFailures : [];
    const effectiveDemoted = demotedImages ?? partitionVisionAttachments(attachments).demotedImages;
    const effectiveLimits = limits ?? partitionVisionAttachments(attachments).limits;
    if (!text && !attachments.length && !failures.length) return "";
    const parts = [];
    if (text) parts.push(text);
    if (attachments.length) parts.push(attachmentPromptBlock(attachments));
    const demotedNotice = formatDemotedVisionNotice(effectiveDemoted, effectiveLimits);
    if (demotedNotice) parts.push(demotedNotice);
    const failureNote = formatAttachmentFailurePromptNote(failures, config?.maxFileAttachmentBytes);
    if (failureNote) parts.push(failureNote);
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
