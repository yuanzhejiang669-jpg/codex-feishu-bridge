import fs from "node:fs";
import path from "node:path";
import {
  normalizeUserContent,
  parseCommand as parseCommandInput,
} from "../commands/parser.mjs";
import { messageIdOf } from "./events.mjs";
import { formatRecentHistory } from "../codex/prompt.mjs";
import { parseJsonLoose } from "../utils/json.mjs";

export function createAttachmentManager(deps = {}) {
  const {
    CONFIG,
    log,
    runLark,
    safeFilePart,
  } = deps;

  function larkTextIndicatesRecalled(text) {
    return /recalled|message\s+is\s+recalled|230011|撤回|已撤回/i.test(String(text || ""));
  }

  function messageRecordLooksRecalled(message) {
    if (!message || typeof message !== "object") return false;
    const status = String(
      message.status
        || message.msg_status
        || message.message_status
        || message.state
        || "",
    ).toLowerCase();
    if (["recalled", "recall", "deleted", "removed"].includes(status)) return true;
    return Boolean(message.recalled || message.is_recalled || message.is_recalled_message || message.deleted || message.is_deleted);
  }

  async function enrichEvent(event) {
    const messageId = messageIdOf(event);
    if (!messageId) return event;

    const result = await runLark([
      "im",
      "+messages-mget",
      "--as",
      "bot",
      "--message-ids",
      messageId,
    ], { timeoutMs: 45_000, attempts: 2 });

    if (result.code !== 0) {
      const detail = `${result.stderr || ""}\n${result.stdout || ""}`;
      if (larkTextIndicatesRecalled(detail)) {
        return {
          ...event,
          recalled: true,
          recallReason: detail.slice(0, 500),
        };
      }
      log("WARN", "message mget failed; using event payload", {
        messageId,
        error: (result.stderr || result.stdout).slice(0, 1000),
      });
      return event;
    }

    try {
      const parsed = JSON.parse(result.stdout);
      const msg = parsed?.data?.messages?.[0];
      if (!msg) return event;
      if (messageRecordLooksRecalled(msg)) {
        return {
          ...event,
          chat_id: msg.chat_id || event.chat_id,
          recalled: true,
          recallReason: "message record is recalled",
        };
      }
      return {
        ...event,
        chat_id: msg.chat_id || event.chat_id,
        content: msg.content ?? event.content,
        message_type: msg.msg_type || event.message_type,
        sender_id: msg.sender?.id || event.sender_id,
      };
    } catch (error) {
      log("WARN", "message mget parse failed", { messageId, error: String(error) });
      return event;
    }
  }

  function parseMessageContentJson(content) {
    const raw = String(content || "").trim();
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function imageKeysFromContent(content) {
    const keys = new Set();
    const parsed = parseMessageContentJson(content);
    if (parsed?.image_key) keys.add(String(parsed.image_key));
    if (parsed?.content && typeof parsed.content === "string") {
      for (const key of imageKeysFromContent(parsed.content)) keys.add(key);
    }
    for (const match of String(content || "").matchAll(/\b(img_[A-Za-z0-9_:-]+)\b/g)) {
      keys.add(match[1]);
    }
    return [...keys];
  }

  function decodeXmlAttribute(value) {
    return String(value || "")
      .replace(/&quot;/g, "\"")
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  }

  function xmlAttribute(tag, name) {
    const match = String(tag || "").match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
    return match ? decodeXmlAttribute(match[1] ?? match[2] ?? "") : "";
  }

  function addFileEntry(entries, seen, fileKey, fileName = "") {
    const key = String(fileKey || "").trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    entries.push({
      fileKey: key,
      fileName: String(fileName || "").trim() || key,
    });
  }

  function fileEntriesFromContent(content) {
    const entries = [];
    const seen = new Set();
    const visit = (value) => {
      if (value == null) return;
      if (typeof value === "string") {
        const parsed = parseMessageContentJson(value);
        if (parsed && parsed !== value) visit(parsed);
        for (const match of value.matchAll(/<file\b[^>]*\/?>/gi)) {
          const tag = match[0];
          addFileEntry(entries, seen, xmlAttribute(tag, "key"), xmlAttribute(tag, "name"));
        }
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (typeof value !== "object") return;
      const fileKey = value.file_key || value.fileKey;
      const fileName = value.file_name || value.fileName || value.name;
      addFileEntry(entries, seen, fileKey, fileName);
      if (value.content) visit(value.content);
      if (value.file) visit(value.file);
      if (value.files) visit(value.files);
    };
    visit(content);
    return entries;
  }

  function userTextFromContent(content) {
    const parsed = parseMessageContentJson(content);
    if (typeof parsed?.text === "string") return normalizeUserContent(parsed.text);
    if (parsed?.image_key && Object.keys(parsed).every((key) => key === "image_key")) return "";
    if (fileEntriesFromContent(content).length && parsed && !parsed.text && !parsed.content) {
      return "";
    }

    let text = normalizeUserContent(content);
    text = text.replace(/^\s*\[Image:\s+img_[^\]]+\]\s*/gmi, "");
    text = text.replace(/^\s*\[File:\s+file_[^\]]+\]\s*/gmi, "");
    text = text.replace(/<file\b[^>]*\/?>/gi, "");
    if (parsed?.image_key && !text.includes(parsed.image_key)) return text.trim();
    if (parsed?.image_key && text === JSON.stringify(parsed)) return "";
    return text.trim();
  }

  function relAttachmentPath(messageId, fileKey, index, fileName = "") {
    const date = new Date().toISOString().slice(0, 10);
    const namePart = safeFilePart(fileName || fileKey) || safeFilePart(fileKey);
    return path.posix.join(
      CONFIG.attachmentRelDir.replace(/\\/g, "/"),
      date,
      safeFilePart(messageId),
      `${String(index + 1).padStart(2, "0")}-${namePart}`,
    );
  }

  function downloadedAttachmentPath(payload, relOutput) {
    const reported = String(payload?.data?.saved_path || "").trim();
    if (!reported) return path.join(CONFIG.workspace, relOutput);
    return path.isAbsolute(reported) ? reported : path.join(CONFIG.workspace, reported);
  }

  async function downloadImageAttachments(event) {
    const messageId = event.message_id || event.id;
    const keys = imageKeysFromContent(event.content);
    if (!messageId || !keys.length) return [];

    const attachments = [];
    for (let index = 0; index < keys.length; index += 1) {
      const fileKey = keys[index];
      const relOutput = relAttachmentPath(messageId, fileKey, index);
      const result = await runLark([
        "im",
        "+messages-resources-download",
        "--as",
        "bot",
        "--message-id",
        messageId,
        "--file-key",
        fileKey,
        "--type",
        "image",
        "--output",
        relOutput,
      ], { timeoutMs: 120_000, attempts: 2 });

      if (result.code !== 0) {
        log("WARN", "image download failed", {
          messageId,
          fileKey,
          error: (result.stderr || result.stdout).slice(0, 1200),
        });
        continue;
      }

      const payload = parseJsonLoose(result.stdout);
      const savedPath = downloadedAttachmentPath(payload, relOutput);
      if (!fs.existsSync(savedPath)) {
        log("WARN", "image download reported success without a saved file", {
          messageId,
          fileKey,
          savedPath,
        });
        continue;
      }
      attachments.push({
        type: "image",
        fileKey,
        messageId,
        path: savedPath,
        sizeBytes: payload?.data?.size_bytes,
        receivedAt: Date.now(),
      });
    }

    if (attachments.length) {
      log("INFO", "image attachments downloaded", {
        messageId,
        count: attachments.length,
        paths: attachments.map((item) => item.path),
      });
    }
    return attachments;
  }

  async function downloadFileAttachments(event) {
    const messageId = event.message_id || event.id;
    const entries = fileEntriesFromContent(event.content);
    if (!messageId || !entries.length) return [];

    const attachments = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const relOutput = relAttachmentPath(messageId, entry.fileKey, index, entry.fileName);
      const result = await runLark([
        "im",
        "+messages-resources-download",
        "--as",
        "bot",
        "--message-id",
        messageId,
        "--file-key",
        entry.fileKey,
        "--type",
        "file",
        "--output",
        relOutput,
      ], { timeoutMs: 180_000, attempts: 2 });

      if (result.code !== 0) {
        log("WARN", "file download failed", {
          messageId,
          fileKey: entry.fileKey,
          fileName: entry.fileName,
          error: (result.stderr || result.stdout).slice(0, 1200),
        });
        continue;
      }

      const payload = parseJsonLoose(result.stdout);
      const savedPath = downloadedAttachmentPath(payload, relOutput);
      if (!fs.existsSync(savedPath)) {
        log("WARN", "file download reported success without a saved file", {
          messageId,
          fileKey: entry.fileKey,
          fileName: entry.fileName,
          savedPath,
        });
        continue;
      }
      let sizeBytes = Number(payload?.data?.size_bytes || 0);
      if (!sizeBytes) {
        try {
          sizeBytes = fs.statSync(savedPath).size;
        } catch {
          sizeBytes = 0;
        }
      }
      if (sizeBytes > CONFIG.maxFileAttachmentBytes) {
        try {
          fs.rmSync(savedPath, { force: true });
        } catch {}
        log("WARN", "file attachment skipped because it is too large", {
          messageId,
          fileKey: entry.fileKey,
          fileName: entry.fileName,
          sizeBytes,
          maxBytes: CONFIG.maxFileAttachmentBytes,
        });
        continue;
      }

      attachments.push({
        type: "file",
        fileKey: entry.fileKey,
        fileName: entry.fileName,
        messageId,
        path: savedPath,
        sizeBytes,
        receivedAt: Date.now(),
      });
    }

    if (attachments.length) {
      log("INFO", "file attachments downloaded", {
        messageId,
        count: attachments.length,
        paths: attachments.map((item) => item.path),
      });
    }
    return attachments;
  }

  function attachmentCounts(attachments) {
    const counts = { image: 0, file: 0 };
    for (const attachment of attachments || []) {
      if (attachment?.type === "image") counts.image += 1;
      else if (attachment?.type === "file") counts.file += 1;
    }
    return counts;
  }

  function formatAttachmentCounts(attachments) {
    const counts = attachmentCounts(attachments);
    const parts = [];
    if (counts.image) parts.push(`${counts.image} 张图片`);
    if (counts.file) parts.push(`${counts.file} 个文件`);
    return parts.join("和") || "附件";
  }

  async function prepareCommandAttachments(event, command) {
    if (command?.name !== "/steer") return event;

    const requested = {
      image: imageKeysFromContent(event.content).length,
      file: fileEntriesFromContent(event.content).length,
    };
    if (!requested.image && !requested.file) return event;

    const downloadedAttachments = [
      ...(await downloadImageAttachments(event)),
      ...(await downloadFileAttachments(event)),
    ];
    const downloaded = attachmentCounts(downloadedAttachments);
    event.attachments = [
      ...(Array.isArray(event.attachments) ? event.attachments : []),
      ...downloadedAttachments,
    ];
    event.attachmentDownload = {
      requested,
      downloaded,
      failed: {
        image: Math.max(0, requested.image - downloaded.image),
        file: Math.max(0, requested.file - downloaded.file),
      },
    };
    return event;
  }

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (!Number.isFinite(value) || value <= 0) return "";
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }

  const parseCommand = (content) => parseCommandInput(content, { extractText: userTextFromContent, engine: CONFIG.engine });

  function attachmentPromptBlock(attachments) {
    const items = Array.isArray(attachments) ? attachments : [];
    const imageLines = items
      .filter((item) => item?.type === "image" && item.path)
      .map((item, index) => `${index + 1}. ${item.path}`);
    const fileLines = items
      .filter((item) => item?.type === "file" && item.path)
      .map((item, index) => {
        const label = item.fileName || path.basename(item.path);
        const size = formatBytes(item.sizeBytes);
        return `${index + 1}. ${label}: ${item.path}${size ? ` (${size})` : ""}`;
      });

    return [
      imageLines.length
        ? [
            "Local image attachments:",
            ...imageLines,
            "",
            "Use the attached images directly. The image files above were already downloaded locally.",
          ].join("\n")
        : "Local image attachments: none",
      "",
      fileLines.length
        ? [
            "Local file attachments:",
            ...fileLines,
            "",
            "The files above were already downloaded locally. Read these local paths with filesystem tools when needed.",
          ].join("\n")
        : "Local file attachments: none",
    ].join("\n");
  }

  function buildPrompt(event, session) {
    const content = userTextFromContent(event.content);
    const attachments = Array.isArray(event.attachments) ? event.attachments : [];
    const history = formatRecentHistory(session);

    const parts = [];
    if (history) parts.push(`最近上下文：\n${history}`);
    parts.push(content || (attachments.length ? "(attachment only)" : "(empty message)"));
    if (attachments.length) parts.push(attachmentPromptBlock(attachments));
    return parts.join("\n\n");
  }

  return {
    larkTextIndicatesRecalled,
    messageRecordLooksRecalled,
    enrichEvent,
    parseMessageContentJson,
    imageKeysFromContent,
    decodeXmlAttribute,
    xmlAttribute,
    addFileEntry,
    fileEntriesFromContent,
    userTextFromContent,
    relAttachmentPath,
    downloadedAttachmentPath,
    downloadImageAttachments,
    downloadFileAttachments,
    attachmentCounts,
    formatAttachmentCounts,
    prepareCommandAttachments,
    formatBytes,
    parseCommand,
    attachmentPromptBlock,
    buildPrompt,
    withAttachmentLock: (...args) => deps.pendingAttachmentStore?.withAttachmentLock?.(...args) ?? deps.withAttachmentLock(...args),
    addPendingAttachments: (...args) => deps.addPendingAttachments?.(...args),
    takePendingAttachments: (...args) => deps.takePendingAttachments?.(...args),
    restorePendingAttachments: (...args) => deps.pendingAttachmentStore?.restore?.(...args) ?? deps.addPendingAttachments?.(...args),
    cleanupPendingAttachments: (...args) => deps.cleanupPendingAttachments?.(...args),
    dropPendingAttachmentsForMessage: (...args) => deps.dropPendingAttachmentsForMessage?.(...args),
    dropPendingAttachmentsByMessageId: (...args) => deps.dropPendingAttachmentsByMessageId?.(...args),
    cleanupClearedDownloads: (...args) => deps.cleanupClearedDownloads?.(...args),
  };
}
