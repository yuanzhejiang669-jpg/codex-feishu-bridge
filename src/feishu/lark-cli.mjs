import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { parseJsonLoose } from "../utils/json.mjs";
import { buildLarkCliEnv } from "../config/env.mjs";
import {
  cardMarkdownContent,
  containsMarkdownTable,
  hasFencedCodeBlock,
  markdownElements,
} from "./cards/primitives.mjs";

export function createLarkClient({
  larkCli,
  larkProfileHome = "",
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
      const env = larkProfileHome
        ? buildLarkCliEnv(larkProfileHome, { ...process.env, ...(options.env || {}) })
        : options.env;
      last = await runTool(larkCli, args, {
        ...options,
        ...(env ? { env } : {}),
        timeoutMs: options.timeoutMs || 60_000,
      });
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
        "-",
        "--idempotency-key",
        idempotencyKey(baseId, `${idempotencySuffix}-text-${i}`),
      ], { stdin: chunks[i] });
      if (result.code !== 0) throw new Error(`lark-cli send failed (${result.code}): ${result.stderr || result.stdout}`);
    }
  }

  async function sendMarkdown(chatId, markdown, idempotencySuffix, baseId = chatId) {
    const normalized = cardMarkdownContent(markdown);
    const chunks = splitText(normalized, maxReplyChars);
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const preferCard = containsMarkdownTable(chunk) || hasFencedCodeBlock(chunk);
      if (preferCard) {
        const cardPayload = JSON.stringify({
          schema: "2.0",
          config: {},
          body: { elements: markdownElements(chunk) },
        });
        if (Buffer.byteLength(cardPayload, "utf8") <= 28_000) {
          const cardResult = await runLark([
            "im",
            "+messages-send",
            "--as",
            "bot",
            "--chat-id",
            chatId,
            "--msg-type",
            "interactive",
            "--content",
            "-",
            "--idempotency-key",
            idempotencyKey(baseId, `${idempotencySuffix}-md-${i}`),
          ], { stdin: cardPayload });
          if (cardResult.code === 0) continue;
          log("WARN", "static Card 2.0 markdown send failed; falling back to post markdown", {
            chatId,
            chunk: i,
            error: String(cardResult.stderr || cardResult.stdout || "").slice(0, 500),
          });
          const fallbackResult = await runLark([
            "im",
            "+messages-send",
            "--as",
            "bot",
            "--chat-id",
            chatId,
            "--markdown",
            "-",
            "--idempotency-key",
            idempotencyKey(baseId, `${idempotencySuffix}-md-fb-${i}`),
          ], { stdin: chunk });
          if (fallbackResult.code !== 0) {
            throw new Error(`lark-cli markdown send failed (${fallbackResult.code}): ${fallbackResult.stderr || fallbackResult.stdout}`);
          }
          continue;
        }
      }
      const result = await runLark([
        "im",
        "+messages-send",
        "--as",
        "bot",
        "--chat-id",
        chatId,
        "--markdown",
        "-",
        "--idempotency-key",
        idempotencyKey(baseId, `${idempotencySuffix}-md-${i}`),
      ], { stdin: chunk });
      if (result.code !== 0) throw new Error(`lark-cli markdown send failed (${result.code}): ${result.stderr || result.stdout}`);
    }
  }

  async function recallMessage(messageId) {
    const id = String(messageId || "").trim();
    if (!id) return false;
    try {
      const result = await runLark([
        "api",
        "DELETE",
        `/open-apis/im/v1/messages/${encodeURIComponent(id)}`,
        "--as",
        "bot",
      ], { timeoutMs: 10_000, attempts: 1 });
      return result.code === 0;
    } catch {
      return false;
    }
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
        "-",
        "--idempotency-key",
        idempotencyKey(messageId, `${idempotencySuffix}-${i}`),
      ];
      if (useThreadReply) args.push("--reply-in-thread");
      const result = await runLark(args, { stdin: chunks[i] });
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

  const unionIdCache = new Map();
  const unionIdInFlight = new Map();
  const UNION_ID_POSITIVE_TTL_MS = 24 * 60 * 60_000;
  const UNION_ID_NEGATIVE_TTL_MS = 60_000;
  const UNION_ID_CACHE_MAX = 2000;

  async function resolveUserUnionId(openId, options = {}) {
    const id = String(openId || "").trim();
    if (!/^ou_[A-Za-z0-9]+$/.test(id)) return "";
    const now = Date.now();
    const cached = unionIdCache.get(id);
    if (cached && cached.expiresAt > now) {
      return cached.unionId;
    }
    const existing = unionIdInFlight.get(id);
    if (existing) return existing;

    const pending = (async () => {
      try {
        const result = await runLark([
          "api",
          "GET",
          `/open-apis/contact/v3/users/${id}`,
          "--params",
          JSON.stringify({ user_id_type: "open_id" }),
          "--as",
          "bot",
        ], {
          timeoutMs: options.timeoutMs || 10_000,
          attempts: options.attempts ?? 1,
        });
        if (result.code === 0) {
          const parsed = parseJsonLoose(result.stdout) || {};
          const candidate = String(
            parsed?.data?.user?.union_id
            || parsed?.user?.union_id
            || "",
          ).trim();
          if (/^on_[A-Za-z0-9]+$/.test(candidate)) {
            if (unionIdCache.size >= UNION_ID_CACHE_MAX) {
              const oldestKey = unionIdCache.keys().next().value;
              if (oldestKey) unionIdCache.delete(oldestKey);
            }
            unionIdCache.set(id, { unionId: candidate, expiresAt: Date.now() + UNION_ID_POSITIVE_TTL_MS });
            return candidate;
          }
        }
        unionIdCache.set(id, { unionId: "", expiresAt: Date.now() + UNION_ID_NEGATIVE_TTL_MS });
        return "";
      } catch (error) {
        log("WARN", "failed to resolve Feishu user union_id", {
          openId: id,
          error: String(error?.message || error).slice(0, 500),
        });
        unionIdCache.set(id, { unionId: "", expiresAt: Date.now() + UNION_ID_NEGATIVE_TTL_MS });
        return "";
      } finally {
        unionIdInFlight.delete(id);
      }
    })();
    unionIdInFlight.set(id, pending);
    return pending;
  }

  return {
    larkJson,
    larkJsonWithData,
    parseJsonLoose,
    recallMessage,
    replyFallback,
    resolveUserUnionId,
    runLark,
    sendMarkdown,
    sendText,
    uploadImage,
  };
}

export function isTransientLarkError(result) {
  const text = `${result?.stderr || ""}\n${result?.stdout || ""}`;
  if (/\bHTTP\s*4(?:00|01|03|04|09|22)\b/i.test(text)) return false;
  return /connectex|ECONN(?:RESET|REFUSED|ABORTED)|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|TLS|\b(?:unexpected\s+)?EOF\b|i\/o timeout|connection reset|broken pipe|HTTP\s*(?:429|50[234])|tenant_access_token|cardid is invalid|ErrCode:\s*11310|"subtype"\s*:\s*"server_error"|"retryable"\s*:\s*true|"code"\s*:\s*2200\b/i.test(text);
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
