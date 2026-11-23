export function normalizeUserContent(content) {
  return String(content || "")
    .replace(/^@\S+\s*/u, "")
    .trim();
}

const CLAUDE_BRIDGE_COMMANDS = new Set(['/help', '/new', '/list', '/sessions', '/switch', '/rename', '/reset',
  '/status', '/context', '/how', '/now', '/provider', '/model', '/effort', '/stop', '/stopall', '/queue',
  '/clearqueue', '/clearqueueall', '/approve', '/deny', '/goal', '/fast', '/compact', '/delete', '/del', '/rm', '/confirm', '/steer']);
const ANTIGRAVITY_BRIDGE_COMMANDS = new Set(['/help', '/new', '/list', '/sessions', '/switch', '/rename', '/reset',
  '/status', '/context', '/how', '/now', '/provider', '/model', '/effort', '/mode', '/stop', '/stopall', '/queue',
  '/clearqueue', '/clearqueueall', '/approve', '/deny', '/delete', '/del', '/rm', '/confirm',
  '/steer', '/goal', '/fast', '/compact']);

export function parseCommand(content, { extractText = null, engine = 'codex' } = {}) {
  const text = (typeof extractText === "function" ? extractText(content) : "") || normalizeUserContent(content);
  if (!text.startsWith("/")) return null;
  const [nameRaw, ...rest] = text.split(/\s+/);
  // Native Claude skills and slash commands travel through the regular queued turn.
  if (engine === 'claude' && !CLAUDE_BRIDGE_COMMANDS.has(nameRaw.toLowerCase())) return null;
  if (engine === 'antigravity' && !ANTIGRAVITY_BRIDGE_COMMANDS.has(nameRaw.toLowerCase())) return null;
  return {
    name: nameRaw.toLowerCase(),
    rest: rest.join(" ").trim(),
    text,
  };
}
