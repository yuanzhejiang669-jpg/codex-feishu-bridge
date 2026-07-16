function createRecoverySupervisor(options) {
  const intervalMs = Math.max(1_000, Number(options.intervalMs || 30_000));
  const baseBackoffMs = Math.max(intervalMs, Number(options.baseBackoffMs || 30_000));
  const maxBackoffMs = Math.max(baseBackoffMs, Number(options.maxBackoffMs || 15 * 60_000));
  const now = options.now || Date.now;
  const records = new Map();
  let timer = null;
  let inFlight = false;

  function snapshot() {
    return Object.fromEntries([...records.entries()].map(([name, value]) => [name, { ...value }]));
  }

  async function tick() {
    if (inFlight) return { action: "busy" };
    inFlight = true;
    try {
      const bots = await options.inspectBots();
      const enabled = new Set(bots.filter((bot) => bot.autoStart).map((bot) => bot.name));
      for (const name of records.keys()) {
        if (!enabled.has(name)) records.delete(name);
      }
      const timestamp = now();
      for (const bot of bots) {
        if (!bot.autoStart) continue;
        if (bot.online) {
          const previous = records.get(bot.name);
          if (previous?.status !== "healthy") {
            records.set(bot.name, {
              status: "healthy",
              failures: 0,
              lastError: "",
              lastCheckedAt: timestamp,
              nextAttemptAt: 0,
            });
          } else {
            previous.lastCheckedAt = timestamp;
          }
          continue;
        }
        const previous = records.get(bot.name) || { failures: 0, nextAttemptAt: 0 };
        if (previous.nextAttemptAt > timestamp) continue;
        records.set(bot.name, {
          ...previous,
          status: "starting",
          lastAttemptAt: timestamp,
          lastError: "",
        });
        try {
          await options.startBot(bot.name);
          records.set(bot.name, {
            status: "healthy",
            failures: 0,
            lastError: "",
            lastAttemptAt: timestamp,
            lastStartedAt: now(),
            nextAttemptAt: 0,
          });
          return { action: "started", name: bot.name };
        } catch (error) {
          const failures = Number(previous.failures || 0) + 1;
          const delay = Math.min(maxBackoffMs, baseBackoffMs * (2 ** Math.min(failures - 1, 10)));
          records.set(bot.name, {
            status: "failed",
            failures,
            lastError: String(error?.message || error).replace(/\s+/g, " ").slice(0, 300),
            lastAttemptAt: timestamp,
            nextAttemptAt: timestamp + delay,
          });
          return { action: "failed", name: bot.name, delay };
        }
      }
      return { action: "idle" };
    } finally {
      inFlight = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { void tick(); }, intervalMs);
    timer.unref?.();
    void tick();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { snapshot, start, stop, tick };
}

module.exports = { createRecoverySupervisor };
