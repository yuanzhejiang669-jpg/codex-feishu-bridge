const fs = require("node:fs");
const path = require("node:path");
const { readManagedBots } = require("./bot-setup.cjs");
const { managedRuntimeRoot } = require("./supervisor.cjs");

const MAX_READ_BYTES = 256 * 1024;
const STREAM_FILES = Object.freeze({
  stdout: "bridge.stdout.log",
  stderr: "bridge.stderr.log",
  acp: "antigravity-acp.log",
});

function redactLogText(text) {
  let out = String(text || "");
  out = out.replace(/\b(?:sk|fc|tvly)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
  out = out.replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, "$1[REDACTED]");
  out = out.replace(/(\b(?:app_secret|appSecret|api[_-]?key|access_token|refresh_token|client_secret|authorization)\b["']?\s*[:=]\s*["']?)[^\s"',;}\]]+/gi, "$1[REDACTED]");
  out = out.replace(/(--app-secret|--api-key)\s+["']?[^\s"']+/gi, "$1 [REDACTED]");
  return out;
}

function assertInsideLogsDir(logsDir, candidate) {
  const root = path.resolve(logsDir);
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`日志路径超出允许目录：${resolved}`);
  }
  return resolved;
}

function readBotLogs(input = {}, options = {}) {
  const name = String(input?.name || "").trim();
  if (!name) throw new Error("必须指定 Bot 标识");
  const bot = readManagedBots(options.dataRoot).find((item) => item.name === name);
  if (!bot) throw new Error(`找不到客户端管理的 Bot：${name}`);

  const stream = String(input?.stream || "stdout").trim().toLowerCase();
  const filename = STREAM_FILES[stream];
  if (!filename) {
    throw new Error(`不支持的日志流类型：${stream}（仅支持 stdout、stderr、acp）`);
  }
  const lineLimit = Math.min(500, Math.max(10, Math.floor(Number(input?.lines) || 200)));

  const logsDir = path.resolve(managedRuntimeRoot(options.localAppData, bot.name), "logs");
  const filePath = assertInsideLogsDir(logsDir, path.join(logsDir, filename));

  if (!fs.existsSync(filePath)) {
    return {
      name: bot.name,
      stream,
      filePath,
      exists: false,
      truncated: false,
      text: "",
      updatedAt: "",
    };
  }

  const lstat = fs.lstatSync(filePath);
  if (lstat.isSymbolicLink() || !lstat.isFile()) {
    throw new Error(`日志文件不是受管普通文件：${filePath}`);
  }
  const realLogsDir = fs.realpathSync(logsDir);
  const realFilePath = fs.realpathSync(filePath);
  assertInsideLogsDir(realLogsDir, realFilePath);

  const fileSize = lstat.size;
  const startOffset = Math.max(0, fileSize - MAX_READ_BYTES);
  const byteLength = fileSize - startOffset;
  const buffer = Buffer.alloc(byteLength);
  let fd = null;
  try {
    fd = fs.openSync(realFilePath, "r");
    if (byteLength > 0) fs.readSync(fd, buffer, 0, byteLength, startOffset);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }

  let rawText = buffer.toString("utf8");
  let truncated = startOffset > 0;
  if (truncated) {
    const firstNewline = rawText.indexOf("\n");
    if (firstNewline >= 0) rawText = rawText.slice(firstNewline + 1);
  }

  const allLines = rawText.split(/\r?\n/);
  if (allLines.length && allLines[allLines.length - 1] === "") allLines.pop();
  if (allLines.length > lineLimit) truncated = true;
  const tailLines = allLines.slice(-lineLimit);

  return {
    name: bot.name,
    stream,
    filePath,
    exists: true,
    truncated,
    text: redactLogText(tailLines.join("\n")),
    updatedAt: lstat.mtime ? lstat.mtime.toISOString() : "",
  };
}

module.exports = {
  MAX_READ_BYTES,
  STREAM_FILES,
  readBotLogs,
  redactLogText,
};
