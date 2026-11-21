import fs from 'node:fs';
import crypto from 'node:crypto';
import { writeJsonFileAtomicSync } from '../utils/json.mjs';

export function createVerifiedModelStore(file, { ttlMs = 24 * 60 * 60_000, now = Date.now } = {}) {
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  state ||= { version: 1, salt: crypto.randomBytes(32).toString('hex'), entries: {} };
  function scope(identity) { return crypto.createHmac('sha256', state.salt).update(identity).digest('hex'); }
  function list(identity) {
    return Object.values(state.entries[scope(identity)] || {}).filter(x => x.verifiedAt > now() - ttlMs);
  }
  function record(identity, result) {
    if (result.status !== 'completed' || !result.model || !result.provider) throw new Error('没有正常完成的模型验证结果');
    const previous = structuredClone(state);
    for (const [identity, models] of Object.entries(state.entries)) {
      for (const [model, entry] of Object.entries(models)) if (entry.verifiedAt <= now() - ttlMs) delete models[model];
      if (!Object.keys(models).length) delete state.entries[identity];
    }
    const key = scope(identity);
    state.entries[key] ||= {};
    state.entries[key][result.model] = { model: result.model, provider: result.provider, verifiedAt: now(), source: 'native-probe' };
    try { writeJsonFileAtomicSync(file, state); } catch (error) { state = previous; throw error; }
    return state.entries[key][result.model];
  }
  return { list, record, has: (identity, model) => list(identity).some(x => x.model === model) };
}
