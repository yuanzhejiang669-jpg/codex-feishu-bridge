import crypto from "node:crypto";

const FEISHU_ALLOWED_HTML_TAGS = new Set([
  "at",
  "font",
  "text_tag",
  "link",
  "person",
  "br",
  "hr",
]);

function countLeadingSpaces(line) {
  let count = 0;
  while (count < line.length && line[count] === " ") count += 1;
  return count;
}

function expandLeadingTabs(line) {
  return String(line || "").replace(/^[ \t]+/, (ws) => ws.replace(/\t/g, "    "));
}

function stripIndentFromLine(line, stripSpaces, blockquoteDepth = 0) {
  let text = String(line || "");
  for (let i = 0; i < blockquoteDepth; i += 1) {
    text = text.replace(/^[ \t]*>[ \t]?/, "");
  }
  if (stripSpaces <= 0) return text;
  const expanded = expandLeadingTabs(text);
  const removable = Math.min(stripSpaces, countLeadingSpaces(expanded));
  return expanded.slice(removable);
}

function parseFenceOpenLine(rawLine) {
  const expanded = expandLeadingTabs(rawLine);

  // Case 1: Optional blockquotes / whitespace directly before fence: `   ```ps1` or `> ```bash`
  const direct = expanded.match(/^((?:[ ]*>[ ]?)*)([ ]*)(`{3,}|~{3,})(.*)$/);
  if (direct) {
    const quotePrefix = direct[1] || "";
    const spaces = direct[2] || "";
    const marker = direct[3];
    const info = direct[4] || "";
    // Per CommonMark, a backtick fence info string cannot contain backticks (it's inline code).
    if (marker[0] === "`" && info.includes("`")) return null;
    const blockquoteDepth = (quotePrefix.match(/>/g) || []).length;
    return {
      listPrefix: "",
      blockquoteDepth,
      stripSpaces: spaces.length,
      markerChar: marker[0],
      markerLen: marker.length,
      info: info.trim(),
    };
  }

  // Case 2: Fence right after a list marker on the same line: `- ```js` or `1. ```ps1`
  const afterList = expanded.match(/^([ ]*(?:\d{1,9}[.)]|[+\-*])[ ]+)(`{3,}|~{3,})(.*)$/);
  if (afterList) {
    const marker = afterList[2];
    const info = afterList[3] || "";
    if (marker[0] === "`" && info.includes("`")) return null;
    return {
      listPrefix: afterList[1].trimEnd(),
      blockquoteDepth: 0,
      stripSpaces: afterList[1].length,
      markerChar: marker[0],
      markerLen: marker.length,
      info: info.trim(),
    };
  }

  return null;
}

function isFenceCloseLine(rawLine, fence) {
  const stripped = stripIndentFromLine(rawLine, Number.MAX_SAFE_INTEGER, fence.blockquoteDepth);
  const trimmed = stripped.trimEnd();
  if (!trimmed.startsWith(fence.markerChar.repeat(fence.markerLen))) return false;
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] !== fence.markerChar) return false;
  }
  return true;
}

function maxBacktickRun(text) {
  let maxRun = 0;
  let current = 0;
  const value = String(text || "");
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === "`") {
      current += 1;
      if (current > maxRun) maxRun = current;
    } else {
      current = 0;
    }
  }
  return maxRun;
}

export function wrapCodeBlock(content, lang = "") {
  const body = String(content ?? "").replace(/\r\n?/g, "\n");
  const fenceLen = Math.max(3, maxBacktickRun(body) + 1);
  const fence = "`".repeat(fenceLen);
  const safeLang = String(lang || "").replace(/[`\r\n]/g, "").trim();
  return `${fence}${safeLang}\n${body}\n${fence}`;
}

function decodeFileUri(uri) {
  const raw = String(uri || "").trim();
  if (!/^file:\/\//i.test(raw)) return raw;
  let pathname = raw.replace(/^file:\/\//i, "");
  try {
    pathname = decodeURIComponent(pathname);
  } catch {}
  if (/^\/[A-Za-z]:/.test(pathname)) {
    return pathname.slice(1).replace(/\//g, "\\");
  }
  return pathname;
}

function isFeishuNativeImageTarget(target) {
  const trimmed = String(target || "").trim();
  if (!trimmed) return false;
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (/^img_[A-Za-z0-9_-]+$/.test(trimmed)) return true;
  return false;
}

function escapeNonWhitelistAngleTags(segment) {
  return segment.replace(/<(\/?[A-Za-z\u4e00-\u9fff_!?][^<>\r\n]*)>/g, (full, inner) => {
    const trimmed = inner.trim();
    if (/^(?:https?:\/\/|mailto:)/i.test(trimmed)) return full;
    const tagMatch = trimmed.match(/^\/?([A-Za-z_][A-Za-z0-9_-]*)(?=[\s/>]|$)/);
    if (tagMatch && FEISHU_ALLOWED_HTML_TAGS.has(tagMatch[1].toLowerCase())) {
      return full;
    }
    return `&lt;${inner}&gt;`;
  });
}

function transformPlainProseSegment(segment) {
  if (!segment) return "";

  // 1) Local / non-Feishu Markdown images: `![alt](C:\foo.png)` -> safe copyable inline code label
  let out = segment.replace(/!\[([^\]\r\n]*)\]\(([^)\r\n]+)\)/g, (full, alt, target) => {
    const cleanTarget = String(target || "").trim();
    if (isFeishuNativeImageTarget(cleanTarget)) return full;
    const readableTarget = /^file:\/\//i.test(cleanTarget) ? decodeFileUri(cleanTarget) : cleanTarget;
    const label = String(alt || "").trim();
    return label ? `\`[图片: ${label}] (${readableTarget})\`` : `\`[图片] (${readableTarget})\``;
  });

  // 2) Local `file:///` links: `[name.docx](file:///C:/...)` -> readable backticked label + path
  out = out.replace(/\[([^\]\r\n]+)\]\((file:\/\/\/[^)\s\r\n]+)\)/gi, (_full, label, uri) => {
    const decoded = decodeFileUri(uri);
    const cleanLabel = String(label || "").trim();
    if (!cleanLabel || cleanLabel === decoded || decoded.endsWith(`\\${cleanLabel}`) || decoded.endsWith(`/${cleanLabel}`)) {
      return `\`${decoded}\``;
    }
    return `\`${cleanLabel}\` (\`${decoded}\`)`;
  });

  // 3) Escape non-whitelist `<tag>` / `<模型ID>` / `List<T>` so Feishu won't drop or reject them
  return escapeNonWhitelistAngleTags(out);
}

function transformProsePreservingInlineCode(line) {
  const text = String(line || "");
  if (!text.includes("`") && !text.includes("<") && !text.includes("![") && !/file:\/\/\//i.test(text)) {
    return text;
  }

  let result = "";
  let cursor = 0;
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "`") {
      index += 1;
      continue;
    }
    let run = 1;
    while (text[index + run] === "`") run += 1;
    const marker = "`".repeat(run);
    const closeAt = text.indexOf(marker, index + run);
    if (closeAt < 0) {
      index += run;
      continue;
    }
    result += transformPlainProseSegment(text.slice(cursor, index));
    // Preserve inline code verbatim (fixes backtick stripping & protects `_`, `*`, `\`, `<...>`)
    result += text.slice(index, closeAt + run);
    index = closeAt + run;
    cursor = index;
  }
  if (cursor < text.length) {
    result += transformPlainProseSegment(text.slice(cursor));
  }
  return result;
}

function isTableDelimiterLine(line) {
  const expanded = expandLeadingTabs(line).replace(/^[ ]*(?:>[ ]?)+/, "").trim();
  if (!expanded.includes("-") || !expanded.includes("|")) return false;
  const trimmed = expanded.replace(/^\|/, "").replace(/\|$/, "");
  const cells = trimmed.split("|").map((cell) => cell.trim());
  return cells.length >= 1 && cells.some((cell) => /^:?-{3,}:?$/.test(cell))
    && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function looksLikeTableRow(line) {
  const expanded = expandLeadingTabs(line).replace(/^[ ]*(?:>[ ]?)+/, "").trim();
  return Boolean(expanded) && expanded.includes("|");
}

function normalizeTablesAndDividers(lines) {
  // Runs on already fence-normalized lines (top-level code fences are unindented at col 0).
  const output = [];
  let inFence = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (inFence) {
      output.push(line);
      if (isFenceCloseLine(line, inFence)) inFence = null;
      continue;
    }
    const open = parseFenceOpenLine(line);
    if (open) {
      inFence = open;
      output.push(line);
      continue;
    }

    // Detect GFM tables (possibly indented inside a list or missing blank lines)
    if (i + 1 < lines.length && looksLikeTableRow(line) && isTableDelimiterLine(lines[i + 1])) {
      let end = i + 1;
      while (end + 1 < lines.length && looksLikeTableRow(lines[end + 1]) && !parseFenceOpenLine(lines[end + 1])) {
        end += 1;
      }
      const tableLines = lines.slice(i, end + 1);
      const cleanTableLines = tableLines.map((row) =>
        expandLeadingTabs(row).replace(/^[ ]*(?:>[ ]?)+/, "").replace(/^[ ]+/, "")
      );
      if (output.length > 0 && output[output.length - 1].trim() !== "") {
        output.push("");
      }
      output.push(...cleanTableLines.map((row) => transformProsePreservingInlineCode(row)));
      if (end + 1 < lines.length && lines[end + 1].trim() !== "") {
        output.push("");
      }
      i = end;
      continue;
    }

    // Prevent accidental Setext heading when `text` is immediately followed by `---` or `===`
    if (/^[ \t]*(?:-{3,}|={3,})[ \t]*$/.test(line)) {
      const prev = output.length > 0 ? output[output.length - 1] : "";
      if (prev && prev.trim() !== "" && !/^[ \t]*(?:#|>|---|===)/.test(prev)) {
        output.push("");
      }
      output.push(line.trim());
      continue;
    }

    output.push(transformProsePreservingInlineCode(line));
  }

  return output;
}

export function cardMarkdownContent(content, _options = {}) {
  const lines = String(content ?? "").replace(/\r\n?/g, "\n").split("\n");
  const fenceNormalized = [];
  let activeFence = null;

  const emitFenceBlock = (fence) => {
    const innerText = fence.lines.join("\n");
    const maxInner = maxBacktickRun(innerText);
    const useTilde = fence.markerChar === "~" && maxInner >= 3;
    const outFence = useTilde
      ? "~".repeat(Math.max(3, fence.markerLen))
      : "`".repeat(Math.max(3, fence.markerLen, maxInner + 1));

    if (fenceNormalized.length > 0 && fenceNormalized[fenceNormalized.length - 1].trim() !== "") {
      fenceNormalized.push("");
    }
    fenceNormalized.push(`${outFence}${fence.info}`);
    fenceNormalized.push(...fence.lines);
    fenceNormalized.push(outFence);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (activeFence) {
      if (isFenceCloseLine(line, activeFence)) {
        emitFenceBlock(activeFence);
        activeFence = null;
        if (i + 1 < lines.length && lines[i + 1].trim() !== "") {
          fenceNormalized.push("");
        }
      } else {
        activeFence.lines.push(stripIndentFromLine(line, activeFence.stripSpaces, activeFence.blockquoteDepth));
      }
      continue;
    }

    const open = parseFenceOpenLine(line);
    if (open) {
      if (open.listPrefix) {
        fenceNormalized.push(open.listPrefix);
      }
      activeFence = {
        ...open,
        lines: [],
      };
      continue;
    }

    fenceNormalized.push(line);
  }

  if (activeFence) {
    emitFenceBlock(activeFence);
  }

  return normalizeTablesAndDividers(fenceNormalized).join("\n");
}

function fenceStateUpTo(lines) {
  let activeFence = null;
  for (const line of lines) {
    if (activeFence) {
      if (isFenceCloseLine(line, activeFence)) activeFence = null;
      continue;
    }
    const open = parseFenceOpenLine(line);
    if (open) activeFence = open;
  }
  return activeFence;
}

function sliceSafeUtf16(text, maxChars) {
  if (text.length <= maxChars) return text;
  let end = Math.max(0, maxChars);
  if (end > 0) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return text.slice(0, end);
}

export function truncateCardText(text, max) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  const sliced = sliceSafeUtf16(value, max).trimEnd();
  const openFence = fenceStateUpTo(sliced.split(/\r?\n/));
  const closer = openFence
    ? `\n${openFence.markerChar.repeat(openFence.markerLen)}`
    : "";
  return `${sliced}${closer}\n\n...(已截断)`;
}

export function truncateCardTextByBytes(text, maxBytes, suffix = "\n\n...(内容过长已截断)") {
  const value = String(text ?? "");
  const limit = Math.max(64, Number(maxBytes || 0));
  if (Buffer.byteLength(value, "utf8") <= limit) return value;

  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const budget = Math.max(32, limit - suffixBytes - 16);

  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = sliceSafeUtf16(value, mid);
    if (Buffer.byteLength(candidate, "utf8") <= budget) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  let cutText = sliceSafeUtf16(value, low);
  const lastNewline = cutText.lastIndexOf("\n");
  if (lastNewline > cutText.length * 0.6) {
    cutText = cutText.slice(0, lastNewline);
  }
  cutText = cutText.trimEnd();
  const openFence = fenceStateUpTo(cutText.split(/\r?\n/));
  const closer = openFence ? `\n${openFence.markerChar.repeat(openFence.markerLen)}` : "";
  const combined = `${cutText}${closer}${suffix}`;
  if (Buffer.byteLength(combined, "utf8") <= limit) return combined;
  return `${sliceSafeUtf16(cutText, Math.max(0, cutText.length - 16)).trimEnd()}${closer}${suffix}`;
}

export function escapeInlineMarkdown(text) {
  return String(text ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([`*_~[\]|])/g, "\\$1");
}

export function markdown(content, options = {}) {
  return { tag: "markdown", content: cardMarkdownContent(content, options) };
}

export function noteMd(content, options = {}) {
  return { tag: "markdown", content: cardMarkdownContent(content, options), text_size: "notation" };
}

export function splitText(text, maxChars) {
  const normalized = String(text || "").trim() || "(Codex 没有返回内容)";
  const limit = Math.max(32, Number(maxChars || 6000));
  if (normalized.length <= limit) return [normalized];

  const chunks = [];
  let rest = normalized;
  while (rest.length > limit) {
    const reserve = Math.min(16, Math.floor(limit * 0.25));
    const searchLimit = Math.max(16, limit - reserve);
    let cut = rest.lastIndexOf("\n", searchLimit);
    if (cut < searchLimit * 0.5) cut = searchLimit;

    let head = sliceSafeUtf16(rest, cut).trimEnd();
    let tail = rest.slice(cut).trimStart();

    const openFence = fenceStateUpTo(head.split(/\r?\n/));
    if (openFence && tail) {
      const fenceLine = openFence.markerChar.repeat(openFence.markerLen);
      const reopenLine = `${fenceLine}${openFence.info}`;
      head = `${head}\n${fenceLine}`;
      tail = `${reopenLine}\n${tail}`;
    }

    chunks.push(head);
    rest = tail;
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
