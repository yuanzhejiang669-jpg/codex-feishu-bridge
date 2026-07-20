import assert from "node:assert/strict";
import test from "node:test";

import {
  compressIndexes,
  parseDeleteSelectionSpec,
} from "../src/sessions/delete-selection.mjs";

test("delete range 2-9 keeps item 1 and selects exactly eight sessions", () => {
  const selection = parseDeleteSelectionSpec("2-9");

  assert.deepEqual(selection, {
    indexes: [2, 3, 4, 5, 6, 7, 8, 9],
    isBatch: true,
  });
  assert.equal(compressIndexes(selection.indexes), "2-9");
  assert.equal(selection.indexes.includes(1), false);
});

test("delete selection rejects reversed ranges and mixed thread IDs", () => {
  assert.match(parseDeleteSelectionSpec("9-2").error, /无效序号或区间/);
  assert.match(parseDeleteSelectionSpec("2 thread-id").error, /无法混用 ID/);
});
