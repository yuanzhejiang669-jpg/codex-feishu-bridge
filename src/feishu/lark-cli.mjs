import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { parseJsonLoose } from "../utils/json.mjs";

export function createLarkClient({
  larkCli,
  runTool,
  delay,
  splitText,
  idempotencyKey,
  maxReplyChars = 6000,
  useThreadReply = false,
  dataFileThreshold = 8000,
  dataTempDir,
  log = () => {},
} = {}) {
  async function runLark(args, options = {}) {
    const attempts = options.attempts ?? 3;
    let last;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      last = await runTool(larkCli, args, { ...options, timeoutMs: options.timeoutMs || 60_000 });
      if (last.code === 0) return last;
      if (attempt < attempts && isTransientLarkError(last)) {
        await delay(1500 * attempt);
        continue;
      }
      return last;
    }
    return last;
  }

  async function sendText(chatId, text, idempotencySuffix, baseId = chatId) {
    const chunks = splitText(text, maxReplyChars);
    for (let i = 0; i < chunks.length; i += 1) {
      const result = await runLark([
        "im",
        "+messages-send",
        "--as",
        "bot",
        "--chat-id",
        chatId,
        "--text",
        chunks[i],
        "--idempotency-key",
        idempotencyKey(baseId, `${idempotencySuffix}-text-${i}`),
      ]);
      if (result.code !== 0) throw new Error(`lark-cli send failed (${result.code}): ${result.stderr || result.stdout}`);
    }
  }

  async function sendMarkdown(chatId, markdown, idempotencySuffix, baseId = chatId) {
    const chunks = splitText(markdown, maxReplyChars);
    for (let i = 0; i < chunks.length; i += 1) {
      const result = await runLark([
        "im",
        "+messages-send",
        "--as",
        "bot",
        "--chat-id",
        chatId,
        "--markdown",
        chunks[i],
        "--idempotency-key",
        idempotencyKey(baseId, `${idempotencySuffix}-md-${i}`),
      ]);
      if (result.code !== 0) throw new Error(`lark-cli markdown send failed (${result.code}): ${result.stderr || result.stdout}`);
    }
  }

  async function sendImage(chatId, imageKey, idempotencySuffix, baseId = chatId) {
    const key = String(imageKey || "").trim();
    if (!key) throw new Error("Feishu image key is required");
    const result = await runLark([
      "im", "+messages-send", "--as", "bot", "--chat-id", chatId,
      "--image", key,
      "--idempotency-key", idempotencyKey(baseId, `${idempotencySuffix}-image`),
    ]);
    if (result.code !== 0) throw new Error(`lark-cli image send failed (${result.code}): ${result.stderr || result.stdout}`);
  }

  async function replyFallback(messageId, text, idempotencySuffix) {
    const chunks = splitText(text, maxReplyChars);
    for (let i = 0; i < chunks.length; i += 1) {
      const args = [
        "im",
        "+messages-reply",
        "--as",
        "bot",
        "--message-id",
        messageId,
        "--text",
        chunks[i],
        "--idempotency-key",
        idempotencyKey(messageId, `${idempotencySuffix}-${i}`),
      ];
      if (useThreadReply) args.push("--reply-in-thread");
      const result = await runLark(args);
      if (result.code !== 0) throw new Error(`lark-cli reply failed (${result.code}): ${result.stderr || result.stdout}`);
    }
  }

  async function uploadImage(imagePath, options = {}) {
    const resolvedPath = path.resolve(String(imagePath || ""));
    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
      throw new Error(`Image file is unavailable: ${resolvedPath || imagePath}`);
    }
    const result = await runLark([
      "im",
      "images",
      "create",
      "--as",
      "bot",
      "--data",
      "-",
      "--file",
      `image=${path.basename(resolvedPath)}`,
      "--format",
      "json",
    ], {
      cwd: path.dirname(resolvedPath),
      stdin: JSON.stringify({ image_type: "message" }),
      timeoutMs: options.timeoutMs || 60_000,
      attempts: options.attempts ?? 2,
    });
    if (result.code !== 0) {
      throw new Error(`lark-cli image upload failed (${result.code}): ${result.stderr || result.stdout}`);
    }
    const parsed = parseJsonLoose(result.stdout) || {};
    const imageKey = String(
      parsed?.data?.image_key
      || parsed?.image_key
      || findNestedValue(parsed, "image_key")
      || "",
    ).trim();
    if (!imageKey) {
      throw new Error(`lark-cli image upload returned no image_key: ${String(result.stdout || "").slice(0, 500)}`);
    }
    return imageKey;
  }

  async function larkJson(args, options = {}) {
    const result = await runLark(args, options);
    if (result.code !== 0) {
      throw new Error(`lark-cli failed (${result.code}): ${result.stderr || result.stdout}`);
    }
    return parseJsonLoose(result.stdout) || {};
  }

  async function larkJsonWithData(args, data, options = {}) {
    const payload = JSON.stringify(data);
    if (!shouldUseLarkDataFile(payload)) {
      return larkJson([...args, "--data", payload], options);
    }

    const dataFile = await writeLarkDataFile(payload);
    try {
      return await larkJson([...args, "--data", `@${path.basename(dataFile)}`], {
        ...options,
        cwd: path.dirname(dataFile),
      });
    } finally {
      await fs.promises.rm(dataFile, { force: true }).catch((error) => {
        log("WARN", "failed to remove temporary lark data file", {
          path: dataFile,
          error: String(error.message || error).slice(0, 500),
        });
      });
    }
  }

  function shouldUseLarkDataFile(payload) {
    const threshold = Math.max(0, Number(dataFileThreshold || 0));
    return threshold === 0 || Buffer.byteLength(String(payload || ""), "utf8") > threshold;
  }

  async function writeLarkDataFile(payload) {
    await fs.promises.mkdir(dataTempDir, { recursive: true });
    const fileName = `lark-data-${process.pid}-${Date.now()}-${crypto.randomUUID()}.json`;
    const dataFile = path.join(dataTempDir, fileName);
    await fs.promises.writeFile(dataFile, payload, { encoding: "utf8", flag: "wx" });
    return dataFile;
  }

  return {
    larkJson,
    larkJsonWithData,
    parseJsonLoose,
    replyFallback,
    runLark,
    sendMarkdown,
    sendImage,
    sendText,
    uploadImage,
  };
}

export function isTransientLarkError(result) {
  const text = `${result?.stderr || ""}\n${result?.stdout || ""}`;
  return /connectex|ECONN|ETIMEDOUT|open\.feishu\.cn|tenant_access_token|socket|cardid is invalid|ErrCode:\s*11310/i.test(text);
}

function findNestedValue(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const found = findNestedValue(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}
