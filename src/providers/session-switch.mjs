import crypto from 'node:crypto';
import { normalizeThreadContinuity } from '../codex/thread-continuity.mjs';

const SETTING_KEYS = ['providerOverride', 'openaiAccountOverride', 'providerBundleOverride', 'modelOverride', 'reasoningOverride'];
const selection = value => Object.fromEntries(SETTING_KEYS.map(k => [k, String(value?.[k] || '')]));
export function normalizeProviderSwitch(value) {
  if (!value || !['preparing', 'prepared', 'committing'].includes(value.stage)) return null;
  return { id: String(value.id || ''), stage: value.stage, target: selection(value.target),
    defaults: value.defaults && typeof value.defaults === 'object' ? {
      values: Object.fromEntries(Object.entries(value.defaults.values || {}).filter(([k, v]) => ['model_provider', 'model', 'model_reasoning_effort'].includes(k) && (typeof v === 'string' || v === null))),
      account: String(value.defaults.account || ''),
    } : null,
    beforeDefaults: value.beforeDefaults || null,
  };
}

// Persist intent before touching defaults, and the final selection/binding in
// one session-store write. A crash in the committing phase can roll forward.
export function createProviderSwitchController({ save, prepare, snapshotDefaults, applyDefaults, restoreDefaults, validate = () => {} }) {
  async function execute(session, transaction, recovering = false) {
    const oldSelection = selection(session);
    const oldBinding = { ...normalizeThreadContinuity(session), codexThreadId: session.codexThreadId };
    validate(session);
    session.providerSwitchTransaction = transaction;
    save();
    const staged = { ...session, ...transaction.target };
    let defaultsApplied = false;
    let preparedTransition = null;
    try {
      const binding = await prepare(session, staged);
      validate(session);
      preparedTransition = session.codexThreadTransition;
      transaction.stage = 'prepared';
      session.providerSwitchTransaction = transaction;
      save();
      if (transaction.defaults) {
        transaction.beforeDefaults ||= snapshotDefaults(transaction.defaults);
        transaction.stage = 'committing';
        session.providerSwitchTransaction = transaction;
        save();
        defaultsApplied = true;
        applyDefaults(transaction.defaults, recovering ? transaction.beforeDefaults : null);
      }
      Object.assign(session, transaction.target, { codexThreadId: binding.threadId, codexThreadProvider: binding.provider,
        codexThreadLineage: binding.lineage, codexThreadTransition: binding.transition || null, providerSwitchTransaction: null, updatedAt: Date.now() });
      save();
      return binding;
    } catch (error) {
      // Retain a prepared handoff so repeating the command can reuse it.
      const handoff = session.codexThreadTransition || preparedTransition;
      Object.assign(session, oldSelection, oldBinding, { codexThreadTransition: handoff });
      let rollbackError;
      if (defaultsApplied) { try { restoreDefaults(transaction.beforeDefaults, transaction.defaults); } catch (e) { rollbackError = e; } }
      session.providerSwitchTransaction = rollbackError ? { ...transaction, stage: 'committing' } : null;
      try { save(); } catch (e) { rollbackError ||= e; }
      if (rollbackError) throw new Error(`切换失败，原会话绑定已保留；默认设置或状态尚待恢复：${rollbackError.message}`, { cause: error });
      throw error;
    }
  }
  return {
    async switch(session, target, defaults = null) {
      if (session.providerSwitchTransaction?.stage === 'committing') await this.recover(session);
      return execute(session, { id: crypto.randomUUID(), stage: 'preparing', target: selection(target), defaults, beforeDefaults: null });
    },
    async recover(session) {
      const transaction = normalizeProviderSwitch(session.providerSwitchTransaction);
      if (transaction?.stage === 'committing') return execute(session, transaction, true);
    },
  };
}
