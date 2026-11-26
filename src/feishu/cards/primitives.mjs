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
      hoisted: blockquoteDepth > 0 || spaces.length > 0,
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
      hoisted: true,
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

// Feishu Card 2.0 `![alt](...)` ONLY accepts uploaded Feishu image keys (`img_...`);
// even external `https://...` URLs fail CardKit validation with code 200570.
function isFeishuNativeImageTarget(target) {
  const trimmed = String(target || "").trim();
  return /^img_[A-Za-z0-9_-]+$/.test(trimmed);
}

function fixBoldCjkFlanking(segment) {
  if (!segment.includes("**")) return segment;
  return segment.replace(/\*\*([^\r\n*]+?)\*\*/g, (full, inner, offset, source) => {
    if (!inner || /^\s|\s$/.test(inner)) return full;
    const prev = offset > 0 ? source[offset - 1] : "";
    const next = offset + full.length < source.length ? source[offset + full.length] : "";
    const chars = [...inner];
    const firstInner = chars[0] || "";
    const lastInner = chars[chars.length - 1] || "";
    const needLeadSpace = Boolean(prev && /[\p{L}\p{N}]/u.test(prev) && /[\p{P}\p{S}]/u.test(firstInner));
    const needTrailSpace = Boolean(next && /[\p{L}\p{N}]/u.test(next) && /[\p{P}\p{S}]/u.test(lastInner));
    if (!needLeadSpace && !needTrailSpace) return full;
    return `${needLeadSpace ? " " : ""}${full}${needTrailSpace ? " " : ""}`;
  });
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

  // 1) Non-Feishu Markdown images:
  //    - `img_xxx`: keep native Feishu image syntax
  //    - `https?://...`: convert to clickable link `[图片: alt](url)` so CardKit never fails with 200570
  //    - local/file/other targets: convert to readable backtick text
  let out = segment.replace(/!\[([^\]\r\n]*)\]\(([^)\r\n]+)\)/g, (full, alt, target) => {
    const cleanTarget = String(target || "").trim();
    if (isFeishuNativeImageTarget(cleanTarget)) return full;
    const label = String(alt || "").trim();
    if (/^https?:\/\//i.test(cleanTarget)) {
      return `[${label ? `图片: ${label}` : "图片"}](${cleanTarget})`;
    }
    const readableTarget = /^file:\/\//i.test(cleanTarget) ? decodeFileUri(cleanTarget) : cleanTarget;
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

  // 3) Fix CommonMark flanking delimiter failures when `**...**` starts/ends with punctuation next to CJK/letters
  out = fixBoldCjkFlanking(out);

  // 4) Escape non-whitelist `<tag>` / `<模型ID>` / `List<T>` so Feishu won't drop or reject them
  return escapeNonWhitelistAngleTags(out);
}

function transformProsePreservingInlineCode(line) {
  const text = String(line || "");
  if (
    !text.includes("`")
    && !text.includes("<")
    && !text.includes("![")
    && !text.includes("**")
    && !/file:\/\/\//i.test(text)
  ) {
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
    // Preserve inline code verbatim (protects `_`, `*`, `\`, `<...>`)
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

export function containsMarkdownTable(text) {
  const lines = String(text || "").split(/\r?\n/);
  let inFence = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (inFence) {
      if (isFenceCloseLine(line, inFence)) inFence = null;
      continue;
    }
    const open = parseFenceOpenLine(line);
    if (open) {
      inFence = open;
      continue;
    }
    if (i + 1 < lines.length && looksLikeTableRow(line) && isTableDelimiterLine(lines[i + 1])) {
      return true;
    }
  }
  return false;
}

export function hasFencedCodeBlock(text) {
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    if (parseFenceOpenLine(line)) return true;
  }
  return false;
}

function normalizeTablesDividersAndLists(entries) {
  // Each entry is { text: string, hoistedBlock?: boolean }.
  const output = [];
  let inFence = null;
  let inOrderedList = false;
  let orderedListInterrupted = false;
  let sawBlankAfterList = false;

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const line = entry.text;

    if (inFence) {
      output.push(line);
      if (isFenceCloseLine(line, inFence)) inFence = null;
      continue;
    }

    const open = parseFenceOpenLine(line);
    if (open) {
      if (inOrderedList && entry.hoistedBlock) {
        orderedListInterrupted = true;
      } else if (inOrderedList) {
        orderedListInterrupted = true;
      }
      inFence = open;
      output.push(line);
      sawBlankAfterList = false;
      continue;
    }

    // Detect GFM tables (possibly indented inside a list or missing blank lines)
    if (i + 1 < entries.length && looksLikeTableRow(line) && isTableDelimiterLine(entries[i + 1].text)) {
      let end = i + 1;
      while (end + 1 < entries.length && looksLikeTableRow(entries[end + 1].text) && !parseFenceOpenLine(entries[end + 1].text)) {
        end += 1;
      }
      if (inOrderedList) orderedListInterrupted = true;
      const tableLines = entries.slice(i, end + 1).map((item) => item.text);
      const cleanTableLines = tableLines.map((row) =>
        expandLeadingTabs(row).replace(/^[ ]*(?:>[ ]?)+/, "").replace(/^[ ]+/, "")
      );
      if (output.length > 0 && output[output.length - 1].trim() !== "") {
        output.push("");
      }
      output.push(...cleanTableLines.map((row) => transformProsePreservingInlineCode(row)));
      if (end + 1 < entries.length && entries[end + 1].text.trim() !== "") {
        output.push("");
      }
      i = end;
      sawBlankAfterList = false;
      continue;
    }

    // Blank line
    if (line.trim() === "") {
      output.push(line);
      if (inOrderedList) sawBlankAfterList = true;
      continue;
    }

    // Prevent accidental Setext heading when `text` is immediately followed by `---` or `===`
    if (/^[ \t]*(?:-{3,}|={3,})[ \t]*$/.test(line)) {
      const prev = output.length > 0 ? output[output.length - 1] : "";
      if (prev && prev.trim() !== "" && !/^[ \t]*(?:#|>|---|===)/.test(prev)) {
        output.push("");
      }
      output.push(line.trim());
      inOrderedList = false;
      orderedListInterrupted = false;
      sawBlankAfterList = false;
      continue;
    }

    // Headings reset ordered list tracking
    if (/^[ \t]*#{1,6}[ \t]+/.test(line)) {
      inOrderedList = false;
      orderedListInterrupted = false;
      sawBlankAfterList = false;
      output.push(transformProsePreservingInlineCode(line));
      continue;
    }

    // Top-level ordered list item: lock numbering as `**N.** ` if a hoisted fence/table broke list continuity
    const orderedMatch = line.match(/^([ ]{0,1})(\d{1,9})\.([ \t]+)(.*)$/);
    if (orderedMatch) {
      const lead = orderedMatch[1];
      const num = Number(orderedMatch[2]);
      const body = transformProsePreservingInlineCode(orderedMatch[4]);
      if (num === 1) {
        inOrderedList = true;
        orderedListInterrupted = false;
        sawBlankAfterList = false;
        output.push(`${lead}1.${orderedMatch[3]}${body}`);
      } else if (orderedListInterrupted && num > 1) {
        inOrderedList = true;
        sawBlankAfterList = false;
        output.push(`${lead}**${num}.** ${body}`);
      } else {
        inOrderedList = true;
        sawBlankAfterList = false;
        output.push(`${lead}${num}.${orderedMatch[3]}${body}`);
      }
      continue;
    }

    // Non-indented prose paragraph after a blank line exits ordered list tracking
    if (inOrderedList && sawBlankAfterList && !/^[ \t]+/.test(line) && !/^[ \t]*[-+*][ \t]+/.test(line)) {
      inOrderedList = false;
      orderedListInterrupted = false;
      sawBlankAfterList = false;
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

    if (fenceNormalized.length > 0 && fenceNormalized[fenceNormalized.length - 1].text.trim() !== "") {
      fenceNormalized.push({ text: "" });
    }
    fenceNormalized.push({ text: `${outFence}${fence.info}`, hoistedBlock: fence.hoisted });
    for (const innerLine of fence.lines) {
      fenceNormalized.push({ text: innerLine, hoistedBlock: fence.hoisted });
    }
    fenceNormalized.push({ text: outFence, hoistedBlock: fence.hoisted });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (activeFence) {
      if (isFenceCloseLine(line, activeFence)) {
        emitFenceBlock(activeFence);
        activeFence = null;
        if (i + 1 < lines.length && lines[i + 1].trim() !== "") {
          fenceNormalized.push({ text: "" });
        }
      } else {
        activeFence.lines.push(stripIndentFromLine(line, activeFence.stripSpaces, activeFence.blockquoteDepth));
      }
      continue;
    }

    const open = parseFenceOpenLine(line);
    if (open) {
      if (open.listPrefix) {
        fenceNormalized.push({ text: open.listPrefix });
      }
      activeFence = {
        ...open,
        lines: [],
      };
      continue;
    }

    fenceNormalized.push({ text: line });
  }

  if (activeFence) {
    emitFenceBlock(activeFence);
  }

  return normalizeTablesDividersAndLists(fenceNormalized).join("\n");
}

export function splitCardMarkdownSegments(normalizedText, { maxTablesPerElement = 3 } = {}) {
  const text = String(normalizedText ?? "");
  if (!text.trim()) return [];
  const cap = Math.max(1, Number(maxTablesPerElement || 3));
  const lines = text.split("\n");
  const segments = [];
  let buffer = [];
  let tableCount = 0;
  let inFence = null;

  const flush = () => {
    const joined = buffer.join("\n").trim();
    if (joined) segments.push(joined);
    buffer = [];
    tableCount = 0;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (inFence) {
      buffer.push(line);
      if (isFenceCloseLine(line, inFence)) inFence = null;
      continue;
    }
    const open = parseFenceOpenLine(line);
    if (open) {
      inFence = open;
      buffer.push(line);
      continue;
    }
    if (i + 1 < lines.length && looksLikeTableRow(line) && isTableDelimiterLine(lines[i + 1])) {
      if (tableCount >= cap && buffer.some((row) => row.trim() !== "")) {
        const carry = [];
        while (buffer.length > 0 && buffer[buffer.length - 1].trim() === "") {
          carry.unshift(buffer.pop());
        }
        if (buffer.length > 0 && /^[ \t]*#{1,6}[ \t]+/.test(buffer[buffer.length - 1])) {
          carry.unshift(buffer.pop());
        } else {
          buffer.push(...carry);
          carry.length = 0;
        }
        flush();
        if (carry.length > 0) buffer.push(...carry);
      }
      tableCount += 1;
      let end = i + 1;
      while (end + 1 < lines.length && looksLikeTableRow(lines[end + 1]) && !parseFenceOpenLine(lines[end + 1])) {
        end += 1;
      }
      buffer.push(...lines.slice(i, end + 1));
      i = end;
      continue;
    }
    buffer.push(line);
  }
  flush();
  return segments.length ? segments : [text];
}

export function markdownElements(content, options = {}) {
  const normalized = cardMarkdownContent(content, options);
  const segments = splitCardMarkdownSegments(normalized, options);
  return segments.map((segment) => ({ tag: "markdown", content: segment }));
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

export function truncateWithOverflowByBytes(text, maxBytes, suffix = "\n\n...(当前卡片已达体积上限，剩余内容续发在下方)") {
  const value = String(text ?? "");
  const limit = Math.max(96, Number(maxBytes || 0));
  if (Buffer.byteLength(value, "utf8") <= limit) {
    return { text: value, overflow: "", truncated: false };
  }

  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const budget = Math.max(32, limit - suffixBytes - 24);

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

  let cutIndex = low;
  let rawHead = sliceSafeUtf16(value, cutIndex);
  const lastNewline = rawHead.lastIndexOf("\n");
  if (lastNewline > rawHead.length * 0.6) {
    cutIndex = lastNewline;
    rawHead = value.slice(0, cutIndex);
  }
  const headTrimmed = rawHead.trimEnd();
  const rawTail = value.slice(cutIndex).trimStart();

  const openFence = fenceStateUpTo(headTrimmed.split(/\r?\n/));
  const fenceLine = openFence ? openFence.markerChar.repeat(openFence.markerLen) : "";
  const closer = openFence ? `\n${fenceLine}` : "";
  const reopen = openFence && rawTail ? `${fenceLine}${openFence.info}\n` : "";

  let head = `${headTrimmed}${closer}${suffix}`;
  if (Buffer.byteLength(head, "utf8") > limit) {
    const trimmedShorter = sliceSafeUtf16(headTrimmed, Math.max(0, headTrimmed.length - 16)).trimEnd();
    head = `${trimmedShorter}${closer}${suffix}`;
  }

  return {
    text: head,
    overflow: rawTail ? `${reopen}${rawTail}` : "",
    truncated: true,
  };
}

export function truncateCardTextByBytes(text, maxBytes, suffix = "\n\n...(内容过长已截断)") {
  return truncateWithOverflowByBytes(text, maxBytes, suffix).text;
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
