import { AGENT_ENGINE_CODEX } from "../agents/engine.mjs";

function required(value, name) {
  if (typeof value !== "function") throw new Error(`CodexEngineAdapter requires ${name}`);
  return value;
}

export class CodexEngineAdapter {
  constructor({ run, steer, abort, compact, status, dispose } = {}) {
    this.id = AGENT_ENGINE_CODEX;
    this.runDelegate = required(run, "run");
    this.steerDelegate = required(steer, "steer");
    this.abortDelegate = required(abort, "abort");
    this.compactDelegate = required(compact, "compact");
    this.statusDelegate = required(status, "status");
    this.disposeDelegate = required(dispose, "dispose");
  }

  run(event, session, state, onState) {
    return this.runDelegate(event, session, state, onState);
  }

  steer(activeRun, input) {
    return this.steerDelegate(activeRun, input);
  }

  abort(activeRun) {
    return this.abortDelegate(activeRun);
  }

  compact(session) {
    return this.compactDelegate(session);
  }

  status(session) {
    return this.statusDelegate(session);
  }

  dispose(reason) {
    return this.disposeDelegate(reason);
  }
}
