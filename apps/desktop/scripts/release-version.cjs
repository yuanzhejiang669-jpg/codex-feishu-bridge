function normalizeReleaseVersion(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:\.0)?$/);
  if (!match) return text;
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3] || 0)}`;
}

module.exports = { normalizeReleaseVersion };
