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
      last = await runTool(larkCli, args, { timeoutMs: options.timeoutMs || 60_000 });
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
      return await larkJson([...args, "--data", `@${dataFile}`], options);
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
    sendText,
  };
}

export function isTransientLarkError(result) {
  const text = `${result?.stderr || ""}\n${result?.stdout || ""}`;
  return /connectex|ECONN|ETIMEDOUT|open\.feishu\.cn|tenant_access_token|socket|cardid is invalid|ErrCode:\s*11310/i.test(text);
}
