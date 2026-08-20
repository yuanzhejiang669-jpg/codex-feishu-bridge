import assert from "node:assert/strict";

import { SnapshotCache } from "../src/snapshot-cache.mjs";
import { runBrowserWorkflow } from "../src/workflow.mjs";

function result(data, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text: JSON.stringify(data) }],
  };
}

const calls = [];
const workflow = await runBrowserWorkflow([
  { tool: "echo", args: { value: 7 } },
  { tool: "echo", args: { copied: "$0.data.value", embedded: "value=$0.data.value" } },
  { tool: "fail", continueOnError: true },
  { tool: "echo", args: { priorFailed: "$2.ok" } },
], {
  invoke: async (tool, args) => {
    calls.push({ tool, args });
    if (tool === "fail") return result({ error: "expected" }, true);
    return result(args);
  },
});

assert.equal(workflow.ok, false);
assert.equal(workflow.results.length, 4);
assert.equal(workflow.stoppedAt, null);
assert.deepEqual(calls[1].args, { copied: 7, embedded: "value=7" });
assert.deepEqual(calls[3].args, { priorFailed: false });

const stopped = await runBrowserWorkflow([
  { tool: "fail" },
  { tool: "echo", args: { unreachable: true } },
], {
  invoke: async (tool, args) => tool === "fail" ? result({ error: "stop" }, true) : result(args),
});
assert.equal(stopped.stoppedAt, 0);
assert.equal(stopped.results.length, 1);

await assert.rejects(
  () => runBrowserWorkflow([{ tool: "browser_workflow" }], { invoke: async () => result({}) }),
  /cannot invoke itself/,
);

const cache = new SnapshotCache(2);
const first = {
  title: "Before",
  url: "https://example.test/",
  readyState: "complete",
  text: "Alpha",
  elements: [{ selector: "#go", tag: "BUTTON", text: "Go" }],
};
const baseline = cache.compare("tab-1", first);
assert.equal(baseline.baseline, true);
assert.deepEqual(baseline.snapshot, first);

const unchanged = cache.compare("tab-1", structuredClone(first));
assert.equal(unchanged.changed, false);

const changed = cache.compare("tab-1", {
  ...first,
  title: "After",
  text: "Alpha Beta",
  elements: [
    { selector: "#go", tag: "BUTTON", text: "Run" },
    { selector: "#status", tag: "P", text: "Ready" },
  ],
});
assert.equal(changed.changed, true);
assert.equal(changed.title, "After");
assert.equal(changed.text.text, " Beta");
assert.equal(changed.counts.added, 1);
assert.equal(changed.counts.changed, 1);

cache.compare("127.0.0.1:9222:tab-a", first);
cache.compare("127.0.0.1:9333:tab-b", first);
cache.clearPrefix("127.0.0.1:9222:");
assert.equal(cache.entries.has("127.0.0.1:9222:tab-a"), false);
assert.equal(cache.entries.has("127.0.0.1:9333:tab-b"), true);

console.log("OK: workflow references/error handling and incremental snapshot diffs passed.");
