export function createAppServerPool({
  createClient,
  maxSize = 1,
  idleTtlMs = 15 * 60_000,
  log = () => {},
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof createClient !== "function") {
    throw new Error("App-server pool requires createClient");
  }

  const capacity = Math.max(1, Math.floor(Number(maxSize) || 1));
  const ttlMs = Math.max(0, Number(idleTtlMs) || 0);
  const entries = new Set();
  const waiters = [];
  let closed = false;

  function createEntry(options = {}) {
    const client = createClient(options);
    const entry = {
      client,
      busy: false,
      initialized: false,
      initializationResult: null,
      idleTimer: null,
      createdAt: now(),
      lastReleasedAt: 0,
    };
    entries.add(entry);
    return entry;
  }

  function cancelIdleTimer(entry) {
    if (!entry?.idleTimer) return;
    clearTimer(entry.idleTimer);
    entry.idleTimer = null;
  }

  function removeEntry(entry) {
    if (!entry || !entries.has(entry)) return false;
    cancelIdleTimer(entry);
    entries.delete(entry);
    return true;
  }

  async function stopEntry(entry, reason) {
    if (!removeEntry(entry)) return;
    log("INFO", "app-server pool stopping client", {
      pid: entry.client?.child?.pid || 0,
      reason,
      ageMs: Math.max(0, now() - entry.createdAt),
    });
    await entry.client?.stop?.();
  }

  function reusableEntry() {
    for (const entry of entries) {
      if (!entry.busy && !entry.client?.closed) return entry;
    }
    return null;
  }

  function pruneClosedEntries() {
    for (const entry of [...entries]) {
      if (!entry.busy && entry.client?.closed) removeEntry(entry);
    }
  }

  function createLease(entry) {
    cancelIdleTimer(entry);
    entry.busy = true;
    let released = false;
    const initializedBeforeAcquire = entry.initialized;

    return {
      client: entry.client,
      initializedBeforeAcquire,
      get initialized() {
        return entry.initialized;
      },
      get initializationResult() {
        return entry.initializationResult;
      },
      async ensureInitialized(initialize) {
        if (entry.initialized) {
          return {
            result: entry.initializationResult,
            warm: true,
            durationMs: 0,
          };
        }
        const startedAt = now();
        const result = await initialize(entry.client);
        entry.initialized = true;
        entry.initializationResult = result;
        return {
          result,
          warm: false,
          durationMs: Math.max(0, now() - startedAt),
        };
      },
      async release({ discard = false, reason = "" } = {}) {
        if (released) return;
        released = true;
        if (discard || entry.client?.closed || closed || ttlMs === 0) {
          await stopEntry(entry, reason || (discard ? "discarded" : "released"));
          dispatchWaiters();
          return;
        }

        entry.busy = false;
        entry.lastReleasedAt = now();
        if (waiters.length) {
          dispatchWaiters();
          return;
        }
        entry.idleTimer = setTimer(() => {
          entry.idleTimer = null;
          if (!entry.busy) {
            void stopEntry(entry, "idle-ttl").then(dispatchWaiters);
          }
        }, ttlMs);
        entry.idleTimer?.unref?.();
      },
    };
  }

  function acquire(options = {}) {
    if (closed) return Promise.reject(new Error("App-server pool is closed"));
    pruneClosedEntries();
    const reusable = reusableEntry();
    if (reusable) return Promise.resolve(createLease(reusable));
    if (entries.size < capacity) {
      try {
        return Promise.resolve(createLease(createEntry(options)));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return new Promise((resolve, reject) => {
      waiters.push({ resolve, reject, options, queuedAt: now() });
    });
  }

  function dispatchWaiters() {
    if (closed) {
      const error = new Error("App-server pool is closed");
      for (const waiter of waiters.splice(0)) waiter.reject(error);
      return;
    }
    pruneClosedEntries();
    while (waiters.length) {
      let entry = reusableEntry();
      if (!entry && entries.size < capacity) {
        const waiter = waiters.shift();
        try {
          entry = createEntry(waiter.options);
          waiter.resolve(createLease(entry));
        } catch (error) {
          waiter.reject(error);
        }
        continue;
      }
      if (!entry) return;
      const waiter = waiters.shift();
      waiter.resolve(createLease(entry));
    }
  }

  async function closeAll(reason = "shutdown") {
    if (closed) return;
    closed = true;
    dispatchWaiters();
    await Promise.all([...entries].map((entry) => stopEntry(entry, reason)));
  }

  function stats() {
    let busy = 0;
    let initialized = 0;
    for (const entry of entries) {
      if (entry.busy) busy += 1;
      if (entry.initialized) initialized += 1;
    }
    return {
      size: entries.size,
      busy,
      idle: entries.size - busy,
      initialized,
      waiting: waiters.length,
      maxSize: capacity,
      idleTtlMs: ttlMs,
    };
  }

  return {
    acquire,
    closeAll,
    stats,
  };
}
