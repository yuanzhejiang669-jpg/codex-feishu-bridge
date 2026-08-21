import assert from "node:assert/strict";
import test from "node:test";

import { normalizePiEvent } from "../src/pi/events.mjs";

test("Pi text deltas and usage normalize to engine-neutral events", () => {
  assert.deepEqual(normalizePiEvent({
    type: "message_update",
    usage: { input: 4, output: 2, totalTokens: 6 },
    assistantMessageEvent: { type: "text_delta", delta: "hello" },
  }), {
    kind: "text_delta",
    text: "hello",
    usage: { inputTokens: 4, outputTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 0, totalTokens: 6 },
  });
});

test("Pi tool events preserve identity, input, output and failures", () => {
  assert.deepEqual(normalizePiEvent({
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "browser",
    result: { content: [{ type: "text", text: "done" }] },
    isError: true,
  }), { kind: "tool_completed", id: "call-1", name: "browser", output: "done", isError: true });
});

test("Pi agent_settled is distinct from low-level agent_end", () => {
  assert.equal(normalizePiEvent({ type: "agent_end" }), null);
  assert.deepEqual(normalizePiEvent({ type: "agent_settled" }), { kind: "agent_settled" });
});
