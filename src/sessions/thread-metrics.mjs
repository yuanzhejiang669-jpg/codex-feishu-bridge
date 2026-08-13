import fs from "node:fs";

const DEFAULT_SAMPLE_COUNT = 3;
const DEFAULT_INITIAL_READ_BYTES = 512 * 1024;
const DEFAULT_MAX_READ_BYTES = 32 * 1024 * 1024;

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function taskCompleteFirstTokenMs(line) {
  try {
    const parsed = JSON.parse(line);
    if (parsed?.type !== "event_msg" || parsed?.payload?.type !== "task_complete") return null;
    return finiteNonNegative(parsed.payload.time_to_first_token_ms);
  } catch {
    return null;
  }
}

export function readThreadMetrics(rolloutPath, {
  sampleCount = DEFAULT_SAMPLE_COUNT,
  initialReadBytes = DEFAULT_INITIAL_READ_BYTES,
  maxReadBytes = DEFAULT_MAX_READ_BYTES,
} = {}) {
  const result = { rolloutBytes: null, firstTokenSamplesMs: [] };
  if (!rolloutPath || !fs.existsSync(rolloutPath)) return result;

  let file;
  try {
    file = fs.openSync(rolloutPath, "r");
    const stat = fs.fstatSync(file);
    result.rolloutBytes = stat.size;
    const wanted = Math.max(1, Math.round(Number(sampleCount) || DEFAULT_SAMPLE_COUNT));
    const maximum = Math.max(1, Math.min(stat.size, Number(maxReadBytes) || DEFAULT_MAX_READ_BYTES));
    let readBytes = Math.max(1, Math.min(maximum, Number(initialReadBytes) || DEFAULT_INITIAL_READ_BYTES));

    while (readBytes <= maximum) {
      const buffer = Buffer.allocUnsafe(readBytes);
      fs.readSync(file, buffer, 0, readBytes, stat.size - readBytes);
      let text = buffer.toString("utf8");
      if (readBytes < stat.size) text = text.slice(Math.max(0, text.indexOf("\n") + 1));
      const samples = [];
      const lines = text.split(/\r?\n/);
      for (let index = lines.length - 1; index >= 0 && samples.length < wanted; index -= 1) {
        const value = taskCompleteFirstTokenMs(lines[index]);
        if (value !== null) samples.push(value);
      }
      if (samples.length >= wanted || readBytes === maximum) {
        result.firstTokenSamplesMs = samples.reverse();
        break;
      }
      readBytes = Math.min(maximum, readBytes * 2);
    }
  } catch {
    return result;
  } finally {
    if (file !== undefined) fs.closeSync(file);
  }
  return result;
}
