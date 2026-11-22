import assert from 'node:assert/strict';
import test from 'node:test';
import { createRunActivity, markRunPhase, renderRunActivityMarkdown } from '../src/runtime/run-activity.mjs';

test('Claude cards show HTTP retry status and countdown instead of a normal waiting state', () => {
  const now = Date.now();
  const state = { startedAt: now - 90_000, blocks: [], activity: createRunActivity(now - 90_000),
    meta: { engine: 'claude', upstreamRetry: { provider: 'DukouAI', statusCode: 502,
      attempt: 1, maxRetries: 2, at: now - 5_000, delayMs: 60_000 } } };
  markRunPhase(state, 'reconnecting', { connection: 'connected', retryAttempt: 1, progress: false }, now - 5_000);
  const text = renderRunActivityMarkdown(state, now);
  assert.match(text, /运行状态：恢复中/);
  assert.match(text, /HTTP 502/);
  assert.match(text, /1\/2 次重试/);
  assert.match(text, /55 秒/);
  assert.match(text, /Claude Code 连接/);
  assert.doesNotMatch(text, /Codex 连接/);
});
