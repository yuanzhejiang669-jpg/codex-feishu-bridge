export function parseDeleteSelectionSpec(value) {
  const text = String(value || "").trim();
  const tokens = text.split(/[\s,，、]+/).filter(Boolean);
  if (!tokens.length) return { error: "empty" };

  const indexes = [];
  const invalid = [];
  const nonNumeric = [];
  let hasRange = false;
  for (const token of tokens) {
    const rangeMatch = token.match(/^(\d+)\s*[-~～]\s*(\d+)$/);
    if (rangeMatch) {
      hasRange = true;
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1 || start > end) {
        invalid.push(token);
        continue;
      }
      for (let index = start; index <= end; index += 1) indexes.push(index);
      continue;
    }

    if (/^\d+$/.test(token)) {
      const index = Number(token);
      if (Number.isInteger(index) && index >= 1) {
        indexes.push(index);
      } else {
        invalid.push(token);
      }
      continue;
    }

    nonNumeric.push(token);
  }

  if (invalid.length) return { error: `无效序号或区间：${invalid.join("、")}` };
  if (nonNumeric.length) {
    if (tokens.length === 1 && !hasRange && indexes.length === 0) return { target: nonNumeric[0] };
    return { error: `批量删除只支持序号和区间，无法混用 ID：${nonNumeric.join("、")}` };
  }

  const unique = [];
  const seenIndexes = new Set();
  for (const index of indexes) {
    if (seenIndexes.has(index)) continue;
    seenIndexes.add(index);
    unique.push(index);
  }
  return { indexes: unique, isBatch: unique.length > 1 || hasRange || tokens.length > 1 };
}

export function compressIndexes(indexes) {
  const sorted = [...new Set(indexes)].sort((a, b) => a - b);
  const parts = [];
  let start = null;
  let prev = null;
  for (const index of sorted) {
    if (start === null) {
      start = index;
      prev = index;
      continue;
    }
    if (index === prev + 1) {
      prev = index;
      continue;
    }
    parts.push(start === prev ? String(start) : `${start}-${prev}`);
    start = index;
    prev = index;
  }
  if (start !== null) parts.push(start === prev ? String(start) : `${start}-${prev}`);
  return parts.join(" ");
}
