export const BRIDGE_START_SCRIPT_TIMEOUT_MS = 10_000;

export function bridgeStartIsConfirmed({ pid, processAlive, lock, instanceName }) {
  const processId = Number(pid || 0);
  if (!Number.isInteger(processId) || processId <= 0 || !processAlive) return false;
  return Number(lock?.pid || 0) === processId
    && String(lock?.instance || "") === String(instanceName || "");
}

export function normalizeConfirmedStartResult(result, confirmed) {
  if (!confirmed || result?.ok) return result;
  return {
    ...result,
    ok: true,
    detached: true,
    wrapperError: String(result?.error || ""),
    error: "",
  };
}
