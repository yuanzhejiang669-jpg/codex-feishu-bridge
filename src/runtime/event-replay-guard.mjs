import { findDeepKey } from "../utils/json.mjs";

export function eventTimestampMs(event) {
  const candidates = [
    event?.create_time,
    event?.event_time,
    event?.timestamp,
    event?.header?.create_time,
    event?.header?.event_time,
    event?.event?.create_time,
    event?.event?.event_time,
    event?.event?.message?.create_time,
    event?.message?.create_time,
    findDeepKey(event, "create_time"),
    findDeepKey(event, "event_time"),
  ];
  for (const candidate of candidates) {
    const normalized = normalizeEventTimestamp(candidate);
    if (normalized > 0) return normalized;
  }
  return 0;
}

export function createEventReplayGuard({
  startedAt = Date.now(),
  graceMs = 2 * 60_000,
  timestampOf = eventTimestampMs,
} = {}) {
  const watermarkMs = Math.max(0, Number(startedAt) || 0);
  const allowedGraceMs = Math.max(0, Number(graceMs) || 0);

  function inspect(event) {
    const timestampMs = timestampOf(event);
    const cutoffMs = Math.max(0, watermarkMs - allowedGraceMs);
    return {
      stale: timestampMs > 0 && timestampMs < cutoffMs,
      timestampMs,
      cutoffMs,
      ageMs: timestampMs > 0 ? Math.max(0, watermarkMs - timestampMs) : 0,
    };
  }

  return {
    inspect,
    shouldSkip: (event) => inspect(event).stale,
    startedAt: watermarkMs,
    graceMs: allowedGraceMs,
  };
}

export function normalizeEventTimestamp(value) {
  if (value === null || value === undefined || value === "") return 0;
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) {
    if (number < 100_000_000_000) return Math.floor(number * 1000);
    if (number > 100_000_000_000_000) return Math.floor(number / 1000);
    return Math.floor(number);
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
