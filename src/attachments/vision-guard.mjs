import fs from "node:fs";
import path from "node:path";

export const VISION_IMAGE_MIME_TYPES = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
});

export const DEFAULT_MAX_INLINE_VISION_IMAGES = 10;
export const DEFAULT_MAX_SINGLE_VISION_IMAGE_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_VISION_IMAGE_BYTES = 20 * 1024 * 1024;

function positiveInt(raw, fallback) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function visionImageMimeType(filePathOrName = "") {
  const ext = path.extname(String(filePathOrName || "")).toLowerCase();
  return VISION_IMAGE_MIME_TYPES[ext] || "";
}

export function isPromotableImageFile(filePathOrName = "", sizeBytes = 0, maxBytes = DEFAULT_MAX_SINGLE_VISION_IMAGE_BYTES) {
  const mime = visionImageMimeType(filePathOrName);
  if (!mime) return false;
  const bytes = Number(sizeBytes || 0);
  return Number.isFinite(bytes) && bytes > 0 && bytes <= maxBytes;
}

export function partitionVisionAttachments(attachments = [], options = {}) {
  const maxImages = options.maxImages != null
    ? positiveInt(options.maxImages, DEFAULT_MAX_INLINE_VISION_IMAGES)
    : positiveInt(process.env.CODEX_FEISHU_MAX_INLINE_VISION_IMAGES, DEFAULT_MAX_INLINE_VISION_IMAGES);
  const maxSingleBytes = options.maxSingleBytes != null
    ? positiveInt(options.maxSingleBytes, DEFAULT_MAX_SINGLE_VISION_IMAGE_BYTES)
    : positiveInt(process.env.CODEX_FEISHU_MAX_SINGLE_VISION_IMAGE_BYTES, DEFAULT_MAX_SINGLE_VISION_IMAGE_BYTES);
  const maxTotalBytes = options.maxTotalBytes != null
    ? positiveInt(options.maxTotalBytes, DEFAULT_MAX_TOTAL_VISION_IMAGE_BYTES)
    : positiveInt(process.env.CODEX_FEISHU_MAX_TOTAL_VISION_IMAGE_BYTES, DEFAULT_MAX_TOTAL_VISION_IMAGE_BYTES);

  const inlineImages = [];
  const demotedImages = [];
  const files = [];
  let totalInlineBytes = 0;

  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    if (!attachment?.path) continue;
    const isImage = attachment.type === "image";
    const mimeType = isImage ? (visionImageMimeType(attachment.path) || visionImageMimeType(attachment.fileName)) : "";
    if (isImage && mimeType && fs.existsSync(attachment.path)) {
      let size = 0;
      try {
        size = fs.statSync(attachment.path).size;
      } catch {
        size = Number(attachment.sizeBytes || 0);
      }
      if (size > maxSingleBytes) {
        demotedImages.push({ attachment, mimeType, size, reason: "too_large" });
        files.push({ attachment, demoted: true, reason: "too_large", size });
        continue;
      }
      if (inlineImages.length >= maxImages) {
        demotedImages.push({ attachment, mimeType, size, reason: "count_limit" });
        files.push({ attachment, demoted: true, reason: "count_limit", size });
        continue;
      }
      if (totalInlineBytes + size > maxTotalBytes) {
        demotedImages.push({ attachment, mimeType, size, reason: "total_size_limit" });
        files.push({ attachment, demoted: true, reason: "total_size_limit", size });
        continue;
      }
      inlineImages.push({ attachment, mimeType, size });
      totalInlineBytes += size;
      continue;
    }
    files.push({ attachment, demoted: false });
  }

  return {
    inlineImages,
    demotedImages,
    files,
    totalInlineBytes,
    limits: { maxImages, maxSingleBytes, maxTotalBytes },
  };
}

export function formatDemotedVisionNotice(demotedImages = [], limits = {}) {
  if (!Array.isArray(demotedImages) || !demotedImages.length) return "";
  const maxImages = limits.maxImages || DEFAULT_MAX_INLINE_VISION_IMAGES;
  const maxTotalMb = Math.round((limits.maxTotalBytes || DEFAULT_MAX_TOTAL_VISION_IMAGE_BYTES) / (1024 * 1024));
  const lines = demotedImages.map((entry, idx) => {
    const label = entry.attachment?.fileName || entry.attachment?.name || path.basename(entry.attachment?.path || "");
    const reasonText = entry.reason === "too_large"
      ? "单张超限"
      : entry.reason === "count_limit"
        ? `超出单轮直传张数上限(${maxImages}张)`
        : `超出单轮直传总大小上限(${maxTotalMb}MiB)`;
    return `${idx + 1}. ${label}: ${entry.attachment?.path || ""} (${reasonText})`;
  });
  return [
    `[图片附件降级保留] 以下 ${demotedImages.length} 张图片未直接内联进视觉通道，已完整保存在本地路径，如需查看请使用文件读取工具打开：`,
    ...lines,
  ].join("\n");
}

export function formatAttachmentFailurePromptNote(failures = [], maxFileBytes = 50 * 1024 * 1024) {
  if (!Array.isArray(failures) || !failures.length) return "";
  const maxMb = (Number(maxFileBytes || 50 * 1024 * 1024) / (1024 * 1024)).toFixed(0);
  const lines = failures.map((item, idx) => {
    const name = item.fileName || item.fileKey || (item.kind === "image" ? "图片附件" : "文件附件");
    const reason = item.reason === "too_large"
      ? `超过 ${maxMb}MB 大小限制`
      : item.reason === "missing_file"
        ? "下载后未落盘"
        : "网络波动下载失败";
    return `${idx + 1}. ${name}（${reason}）`;
  });
  return [
    `[附件下载缺失提示] 用户本条消息中共有 ${failures.length} 个附件未能成功下载，请勿假设已看到这些附件，并在回复中必要时提示用户重发：`,
    ...lines,
  ].join("\n");
}
