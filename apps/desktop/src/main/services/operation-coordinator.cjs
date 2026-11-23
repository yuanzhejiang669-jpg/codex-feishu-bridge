function createOperationCoordinator({
  pauseRecovery = () => {},
  resumeRecovery = () => {},
} = {}) {
  let tail = Promise.resolve();
  let pauseDepth = 0;
  let activeOperation = "";
  let queuedCount = 0;

  function runExclusive(name, fn, { pause = true } = {}) {
    const opName = String(name || "operation");
    queuedCount += 1;
    const result = tail.catch(() => {}).then(async () => {
      queuedCount = Math.max(0, queuedCount - 1);
      activeOperation = opName;
      if (pause) {
        pauseDepth += 1;
        if (pauseDepth === 1) {
          try { await pauseRecovery(); } catch {}
        }
      }
      try {
        return await fn();
      } finally {
        activeOperation = "";
        if (pause) {
          pauseDepth = Math.max(0, pauseDepth - 1);
          if (pauseDepth === 0) {
            try { await resumeRecovery(); } catch {}
          }
        }
      }
    });
    tail = result.catch(() => {});
    return result;
  }

  function snapshot() {
    return {
      activeOperation,
      queuedCount,
      paused: pauseDepth > 0,
    };
  }

  return {
    runExclusive,
    snapshot,
  };
}

module.exports = { createOperationCoordinator };
