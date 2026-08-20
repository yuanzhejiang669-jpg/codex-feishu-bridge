import { createHash } from "node:crypto";

function snapshotHash(snapshot) {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function elementKey(element, index) {
  return element?.selector || `${element?.tag || "element"}:${element?.role || ""}:${element?.text || ""}:${index}`;
}

function elementChanges(previous = [], current = []) {
  const before = new Map(previous.map((item, index) => [elementKey(item, index), item]));
  const after = new Map(current.map((item, index) => [elementKey(item, index), item]));
  const added = [];
  const removed = [];
  const changed = [];

  for (const [key, item] of after) {
    if (!before.has(key)) added.push(item);
    else if (JSON.stringify(before.get(key)) !== JSON.stringify(item)) changed.push({ before: before.get(key), after: item });
  }
  for (const [key, item] of before) {
    if (!after.has(key)) removed.push(item);
  }
  return { added, removed, changed };
}

function textChange(previousText = "", currentText = "", maxChars = 6000) {
  if (previousText === currentText) return { changed: false, text: "" };
  let prefix = 0;
  const maxPrefix = Math.min(previousText.length, currentText.length);
  while (prefix < maxPrefix && previousText[prefix] === currentText[prefix]) prefix += 1;

  let suffix = 0;
  const maxSuffix = Math.min(previousText.length - prefix, currentText.length - prefix);
  while (suffix < maxSuffix && previousText[previousText.length - 1 - suffix] === currentText[currentText.length - 1 - suffix]) suffix += 1;

  const end = suffix ? currentText.length - suffix : currentText.length;
  const inserted = currentText.slice(prefix, end);
  return {
    changed: true,
    prefixLength: prefix,
    removedLength: previousText.length - prefix - suffix,
    insertedLength: inserted.length,
    text: inserted.slice(0, maxChars),
    truncated: inserted.length > maxChars,
  };
}

export class SnapshotCache {
  constructor(maxEntries = 100) {
    this.maxEntries = Math.max(1, maxEntries);
    this.entries = new Map();
  }

  clear(key) {
    if (key == null) this.entries.clear();
    else this.entries.delete(String(key));
  }

  clearPrefix(prefix) {
    const value = String(prefix);
    for (const key of this.entries.keys()) {
      if (key.startsWith(value)) this.entries.delete(key);
    }
  }

  compare(key, snapshot, options = {}) {
    const cacheKey = String(key);
    const hash = snapshotHash(snapshot);
    const previous = this.entries.get(cacheKey);
    this.entries.delete(cacheKey);
    this.entries.set(cacheKey, { hash, snapshot });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);

    if (!previous) {
      return { baseline: true, changed: true, hash, snapshot };
    }
    if (previous.hash === hash) {
      return { baseline: false, changed: false, hash, previousHash: previous.hash };
    }

    const elements = elementChanges(previous.snapshot?.elements, snapshot?.elements);
    const text = textChange(previous.snapshot?.text, snapshot?.text, Number(options.maxTextLength || 6000));
    return {
      baseline: false,
      changed: true,
      hash,
      previousHash: previous.hash,
      title: previous.snapshot?.title === snapshot?.title ? undefined : snapshot?.title,
      url: previous.snapshot?.url === snapshot?.url ? undefined : snapshot?.url,
      readyState: previous.snapshot?.readyState === snapshot?.readyState ? undefined : snapshot?.readyState,
      text,
      elements,
      counts: {
        added: elements.added.length,
        removed: elements.removed.length,
        changed: elements.changed.length,
      },
    };
  }
}
