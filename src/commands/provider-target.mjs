// Only command arguments are normalized; ordinary chat text never passes here.
export function normalizeProviderTarget(value) {
  const text = String(value || "").trim();
  const markdown = text.match(/^\[([^\]\r\n]+)\]\(\s*<?mailto:[^\s)]+>?\s*\)$/i);
  const wrapped = text.match(/^<mailto:([^<>\s]+)>$/i);
  if (!markdown && !wrapped) return text;
  let alias = markdown?.[1] || wrapped[1];
  try { alias = decodeURIComponent(alias); } catch { return text; }
  return /^[^\s<>\[\]()`]+@[^\s<>\[\]()`]+$/.test(alias) ? alias : text;
}
