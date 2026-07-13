export function createRunWatchdog(label, onTimeout, {
  totalMs = 0,
  idleMs = 0,
} = {}) {
  let timedOut = false;
  let reason = "";
  let totalTimer = null;
  let idleTimer = null;

  const fire = (message) => {
    if (timedOut) return;
    timedOut = true;
    reason = message;
    onTimeout?.(message);
  };

  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (!hasDuration(idleMs)) return;
    idleTimer = setTimeout(() => {
      fire(`${label} idle timed out after ${Math.round(idleMs / 1000)}s without progress`);
    }, idleMs);
    idleTimer.unref?.();
  };

  if (hasDuration(totalMs)) {
    totalTimer = setTimeout(() => {
      fire(`${label} timed out after ${Math.round(totalMs / 1000)}s`);
    }, totalMs);
    totalTimer.unref?.();
  }
  armIdleTimer();

  return {
    touch: armIdleTimer,
    get timedOut() {
      return timedOut;
    },
    get reason() {
      return reason;
    },
    clear() {
      clearTimeout(totalTimer);
      clearTimeout(idleTimer);
    },
  };
}

function hasDuration(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}
