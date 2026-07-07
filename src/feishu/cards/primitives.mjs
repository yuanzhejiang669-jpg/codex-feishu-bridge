import crypto from "node:crypto";

export function markdown(content) {
  return { tag: "markdown", content: cardMarkdownContent(content) };
}

export function noteMd(content) {
  return { tag: "markdown", content: cardMarkdownContent(content), text_size: "notation" };
}

export function cardMarkdownContent(content) {
  const lines = String(content || "").split(/\r?\n/);
  let inFence = false;
  return lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    return line.replace(/(^|[^`])`([^`\r\n]+)`(?!`)/g, "$1$2");
  }).join("\n");
}

export function truncateCardText(text, max) {
  const value = String(text || "");
  return value.length > max ? `${value.slice(0, max)}\n\n...(已截断)` : value;
}

export function splitText(text, maxChars) {
  const normalized = String(text || "").trim() || "(Codex 没有返回内容)";
  if (normalized.length <= maxChars) return [normalized];

  const chunks = [];
  let rest = normalized;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf("\n", maxChars);
    if (cut < maxChars * 0.5) cut = maxChars;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function idempotencyKey(baseId, suffix) {
  return crypto
    .createHash("sha256")
    .update(`${baseId}:${suffix}`)
    .digest("hex")
    .slice(0, 32);
}
