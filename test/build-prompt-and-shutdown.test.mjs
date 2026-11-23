import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import { buildExecPrompt, formatRecentHistory } from "../src/codex/prompt.mjs";
import {
  isProcessAlive,
  terminateProcessTree,
  waitForActiveChildrenShutdown,
} from "../src/runtime/process-runner.mjs";

async function waitForFile(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForDead(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Process ${pid} remained alive`);
}

test("buildExecPrompt formats history, text, and attachments without ReferenceError", () => {
  const session = {
    history: [
      { role: "user", text: "first question" },
      { role: "assistant", text: "first answer" },
      { role: "user", text: "   " },
    ],
  };
  const prompt = buildExecPrompt(
    {
      content: "follow up",
      attachments: [{ type: "file", path: "C:\\tmp\\doc.txt" }],
    },
    session,
    {
      userTextFromContent: (value) => String(value || "").trim(),
      attachmentPromptBlock: (items) => `ATTACH:${items.length}`,
    },
  );
  assert.match(prompt, /^最近上下文：\nUser: first question\nAssistant: first answer\n\nfollow up\n\nATTACH:1$/);
  assert.equal(formatRecentHistory(null), "");
  assert.equal(buildExecPrompt({ content: "" }, {}), "(empty message)");
  assert.equal(
    buildExecPrompt({ content: "", attachments: [{ type: "image", path: "a.png" }] }, {}),
    "(attachment only)",
  );
  const attachmentsSource = fs.readFileSync(new URL("../src/feishu/attachments.mjs", import.meta.url), "utf8");
  const buildPromptStart = attachmentsSource.indexOf("function buildPrompt(");
  const buildPromptBlock = attachmentsSource.slice(buildPromptStart, buildPromptStart + 600);
  assert.match(buildPromptBlock, /const history = formatRecentHistory\(session\)/);
});

test("waitForActiveChildrenShutdown escalates and reaps child and grandchild process tree before returning", { timeout: 15_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-shutdown-tree-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const grandchildPidFile = path.join(dir, "grandchild.pid");
  const parentScript = path.join(dir, "parent.mjs");
  fs.writeFileSync(
    parentScript,
    `
      import fs from "node:fs";
      import { spawn } from "node:child_process";
      process.on("SIGTERM", () => {});
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      fs.writeFileSync(${JSON.stringify(grandchildPidFile)}, String(child.pid), "utf8");
      setInterval(() => {}, 1000);
    `,
    "utf8",
  );
  const child = spawn(process.execPath, [parentScript], {
    ...(process.platform !== "win32" ? { detached: true } : {}),
    windowsHide: true,
    stdio: "ignore",
  });
  const activeChildren = new Map([[child.pid, { child, label: "shutdown-tree-fixture" }]]);
  child.once("close", () => activeChildren.delete(child.pid));
  let grandchildPid = 0;
  try {
    await waitForFile(grandchildPidFile);
    grandchildPid = Number(fs.readFileSync(grandchildPidFile, "utf8"));
    assert.equal(isProcessAlive(child.pid), true);
    assert.equal(isProcessAlive(grandchildPid), true);

    const outcome = await waitForActiveChildrenShutdown({
      activeChildren,
      terminate: terminateProcessTree,
      totalTimeoutMs: 5000,
      escalateMs: 400,
      pollMs: 50,
    });
    assert.equal(outcome.remaining, 0);
    await waitForDead(child.pid, 3000);
    await waitForDead(grandchildPid, 3000);
  } finally {
    if (child.pid && isProcessAlive(child.pid)) terminateProcessTree(child.pid, true);
    if (grandchildPid && isProcessAlive(grandchildPid)) terminateProcessTree(grandchildPid, true);
  }
});
