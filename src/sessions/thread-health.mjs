const DEFAULT_WARNING_BYTES = 120 * 1_000_000;
const DEFAULT_CRITICAL_BYTES = 200 * 1_000_000;
const DEFAULT_WARNING_RESUME_MS = 30_000;
const DEFAULT_CRITICAL_RESUME_MS = 60_000;
const DEFAULT_SAMPLE_WINDOW = 3;
const DEFAULT_CRITICAL_SAMPLE_COUNT = 2;

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function positiveInteger(value, fallback) {
  return Math.max(1, Math.round(positiveNumber(value, fallback)));
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

export function normalizeThreadHealthConfig(config = {}) {
  const warningBytes = positiveNumber(config.warningBytes, DEFAULT_WARNING_BYTES);
  const criticalBytes = Math.max(
    warningBytes,
    positiveNumber(config.criticalBytes, DEFAULT_CRITICAL_BYTES),
  );
  const warningResumeMs = positiveNumber(config.warningResumeMs, DEFAULT_WARNING_RESUME_MS);
  const criticalResumeMs = Math.max(
    warningResumeMs,
    positiveNumber(config.criticalResumeMs, DEFAULT_CRITICAL_RESUME_MS),
  );
  const sampleWindow = positiveInteger(config.sampleWindow, DEFAULT_SAMPLE_WINDOW);
  const criticalSampleCount = Math.min(
    sampleWindow,
    positiveInteger(config.criticalSampleCount, DEFAULT_CRITICAL_SAMPLE_COUNT),
  );
  return {
    warningBytes,
    criticalBytes,
    warningResumeMs,
    criticalResumeMs,
    sampleWindow,
    criticalSampleCount,
  };
}

export function normalizeThreadHealth(value, threadId = "") {
  const source = value && typeof value === "object" ? value : {};
  const recordedThreadId = String(source.threadId || threadId || "").trim();
  const rawRolloutBytes = source.rolloutBytes;
  const rolloutBytes = rawRolloutBytes === null || rawRolloutBytes === undefined || rawRolloutBytes === ""
    ? null
    : Number(rawRolloutBytes);
  const resumeSamplesMs = Array.isArray(source.resumeSamplesMs)
    ? source.resumeSamplesMs
      .map(Number)
      .filter((item) => Number.isFinite(item) && item >= 0)
      .slice(-12)
    : [];
  return {
    threadId: recordedThreadId,
    resumeSamplesMs,
    rolloutBytes: Number.isFinite(rolloutBytes) && rolloutBytes >= 0 ? rolloutBytes : null,
    notifiedLevel: Math.max(0, Math.min(2, Math.round(Number(source.notifiedLevel) || 0))),
    lastReminderAt: Math.max(0, Number(source.lastReminderAt) || 0),
    updatedAt: Math.max(0, Number(source.updatedAt) || 0),
  };
}

export function recordThreadHealthSample(previous, sample, config = {}) {
  const thresholds = normalizeThreadHealthConfig(config);
  const threadId = String(sample?.threadId || "").trim();
  const current = normalizeThreadHealth(previous);
  const sameThread = Boolean(threadId && current.threadId === threadId);
  const next = sameThread ? current : normalizeThreadHealth(null, threadId);
  const resumeMs = Number(sample?.resumeMs);
  if (Number.isFinite(resumeMs) && resumeMs >= 0) {
    next.resumeSamplesMs = [...next.resumeSamplesMs, Math.round(resumeMs)].slice(-thresholds.sampleWindow);
  }
  const rolloutBytes = Number(sample?.rolloutBytes);
  if (Number.isFinite(rolloutBytes) && rolloutBytes >= 0) next.rolloutBytes = Math.round(rolloutBytes);
  next.threadId = threadId;
  next.updatedAt = Math.max(0, Number(sample?.now) || Date.now());
  return next;
}

export function evaluateThreadHealth(value, config = {}) {
  const thresholds = normalizeThreadHealthConfig(config);
  const health = normalizeThreadHealth(value);
  const samples = health.resumeSamplesMs.slice(-thresholds.sampleWindow);
  const medianResumeMs = median(samples);
  const criticalSamples = samples.slice(-thresholds.criticalSampleCount);
  const criticalByResume = criticalSamples.length === thresholds.criticalSampleCount
    && criticalSamples.every((item) => item >= thresholds.criticalResumeMs);
  const rolloutSizeKnown = Number.isFinite(health.rolloutBytes);
  const criticalBySize = rolloutSizeKnown && health.rolloutBytes >= thresholds.criticalBytes;
  const warningByCombinedSignal = rolloutSizeKnown
    && health.rolloutBytes >= thresholds.warningBytes
    && samples.length === thresholds.sampleWindow
    && medianResumeMs >= thresholds.warningResumeMs;

  let level = 0;
  let reason = "healthy";
  if (criticalBySize || criticalByResume) {
    level = 2;
    reason = criticalBySize && criticalByResume
      ? "critical_size_and_resume"
      : criticalBySize ? "critical_size" : "critical_resume";
  } else if (warningByCombinedSignal) {
    level = 1;
    reason = "warning_size_and_resume";
  }

  return {
    ...health,
    ...thresholds,
    level,
    reason,
    samples,
    medianResumeMs,
    rolloutSizeKnown,
    shouldNotify: level > health.notifiedLevel,
  };
}

export function markThreadHealthNotified(value, level, now = Date.now()) {
  const health = normalizeThreadHealth(value);
  health.notifiedLevel = Math.max(health.notifiedLevel, Math.max(0, Math.min(2, Math.round(Number(level) || 0))));
  health.lastReminderAt = Math.max(0, Number(now) || Date.now());
  health.updatedAt = health.lastReminderAt;
  return health;
}
