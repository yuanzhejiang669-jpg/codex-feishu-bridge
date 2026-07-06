export function normalizeUserContent(content) {
  return String(content || "")
    .replace(/^@\S+\s*/u, "")
    .trim();
}

export function parseCommand(content, { extractText = null } = {}) {
  const text = (typeof extractText === "function" ? extractText(content) : "") || normalizeUserContent(content);
  if (!text.startsWith("/")) return null;
  const [nameRaw, ...rest] = text.split(/\s+/);
  return {
    name: nameRaw.toLowerCase(),
    rest: rest.join(" ").trim(),
    text,
  };
}
