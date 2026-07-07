import { readFile } from "node:fs/promises";

export function jsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

export function textResponse(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

export function binaryResponse(res, statusCode, body, contentType) {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

export async function readTextFile(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export async function readJsonFile(filePath) {
  const rawText = await readTextFile(filePath);
  const text = rawText?.replace(/^\uFEFF/, "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function readRequestJson(req, maxBytes = 64_000) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error("请求体过大");
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  return JSON.parse(text);
}
