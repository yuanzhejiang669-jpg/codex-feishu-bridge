import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isTransientLarkError } from "../src/feishu/lark-cli.mjs";
import { createFormulaImageService } from "../src/feishu/cards/formula-renderer.mjs";
import { createEventDispatcher } from "../src/runtime/event-dispatcher.mjs";
import { createSeenEventsStore } from "../src/runtime/seen-events.mjs";

test("FEISHU-001: isTransientLarkError rejects HTTP 4xx business errors even when URL contains open.feishu.cn", () => {
  assert.equal(isTransientLarkError({ stderr: "POST https://open.feishu.cn/open-apis/im/v1/messages HTTP 400 invalid param", stdout: "" }), false);
  assert.equal(isTransientLarkError({ stderr: "POST https://open.feishu.cn/open-apis/im/v1/messages HTTP 401 unauthorized", stdout: "" }), false);
  assert.equal(isTransientLarkError({ stderr: "POST https://open.feishu.cn/open-apis/im/v1/messages HTTP 403 forbidden", stdout: "" }), false);
  assert.equal(isTransientLarkError({ stderr: "POST https://open.feishu.cn/open-apis/im/v1/messages HTTP 404 not found", stdout: "" }), false);
  assert.equal(isTransientLarkError({ stderr: "POST https://open.feishu.cn/open-apis/im/v1/messages HTTP 422 unprocessable", stdout: "" }), false);
  assert.equal(isTransientLarkError({ stderr: "https://open.feishu.cn/api generic invalid request", stdout: "" }), false);

  assert.equal(isTransientLarkError({ stderr: "connectex: connection refused", stdout: "" }), true);
  assert.equal(isTransientLarkError({ stderr: "ECONNRESET while reading response", stdout: "" }), true);
  assert.equal(isTransientLarkError({ stderr: "HTTP 429 too many requests", stdout: "" }), true);
  assert.equal(isTransientLarkError({ stderr: "HTTP 503 service unavailable", stdout: "" }), true);
  assert.equal(isTransientLarkError({ stderr: "ErrCode: 11310 rate limited", stdout: "" }), true);
});

test("FEISHU-001: pre-queue dedupe prevents duplicate event_id from triggering a second acknowledgeQueued", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-dedupe-prequeue-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const seen = createSeenEventsStore({
    seenPath: path.join(dir, "seen.json"),
    eventLocksDir: path.join(dir, "locks"),
    instanceName: "bot-1",
  });

  const queuedAcks = [];
  let releaseFirst;
  const firstGate = new Promise((r) => { releaseFirst = r; });
  const dispatcher = createEventDispatcher({
    maxConcurrent: 1,
    chatIdOf: (e) => e.chat_id,
    messageIdOf: (e) => e.message_id,
    eventIdOf: (e) => e.event_id,
    acknowledgeQueued: async (e) => queuedAcks.push(e.message_id),
    handleEvent: async (e) => {
      if (e.message_id === "m1") await firstGate;
    },
  });

  function ingest(event) {
    const dedupeId = event.event_id || event.message_id;
    if (seen.rememberEvent(dedupeId, event.message_id)) return false;
    event._alreadyRemembered = true;
    dispatcher.enqueue(event);
    return true;
  }

  assert.equal(ingest({ event_id: "ev-1", chat_id: "c1", message_id: "m1" }), true);
  assert.equal(ingest({ event_id: "ev-2", chat_id: "c1", message_id: "m2" }), true);
  // Duplicate delivery of ev-2 must be dropped BEFORE enqueue -> zero extra queued ack
  assert.equal(ingest({ event_id: "ev-2", chat_id: "c1", message_id: "m2" }), false);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(queuedAcks, ["m2"]);
  releaseFirst();
});

test("FEISHU-001: formulaImageService launches browser lazily on first render, reuses it, and auto-closes after idleCloseMs", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-formula-lazy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fakeBrowserBin = path.join(dir, "fake-edge.exe");
  fs.writeFileSync(fakeBrowserBin, "fake");

  let launchCount = 0;
  let closeCount = 0;
  let connected = false;

  const service = createFormulaImageService({
    enabled: true,
    browserExecutable: fakeBrowserBin,
    tempDir: dir,
    idleCloseMs: 60,
    uploadImage: async () => "img_fake_key",
    loadDeps: async () => ({
      katex: { renderToString: (latex) => `<span>${latex}</span>` },
      markdown: { render: (s) => `<p>${s}</p>` },
      chromium: {
        launch: async () => {
          launchCount += 1;
          connected = true;
          return {
            isConnected: () => connected,
            on: () => {},
            newPage: async () => ({
              setDefaultTimeout: () => {},
              setContent: async () => {},
              waitForFunction: async () => {},
              evaluate: async () => ({ width: 400, height: 120, overflow: false }),
              locator: () => ({
                boundingBox: async () => ({ x: 0, y: 0, width: 400, height: 120 }),
                screenshot: async ({ path: outPath }) => fs.writeFileSync(outPath, "PNG"),
              }),
              close: async () => {},
            }),
            close: async () => {
              connected = false;
              closeCount += 1;
            },
          };
        },
      },
    }),
  });
  t.after(() => service.close());

  // No browser launched on creation or plain text without complex formulas
  assert.equal(launchCount, 0);
  assert.equal(service.isBrowserActive(), false);
  await service.enrichBlocks([{ kind: "text", content: "普通中文消息没有复杂公式" }]);
  assert.equal(launchCount, 0);

  // First complex formula triggers lazy single launch
  const r1 = await service.enrichBlocks([{ kind: "text", content: String.raw`\[\frac{a}{b}\]` }]);
  assert.equal(r1.stats.rendered, 1);
  assert.equal(launchCount, 1);
  assert.equal(service.isBrowserActive(), true);

  // Second render immediately reuses same browser (still 1 launch, never double-launched!)
  const r2 = await service.enrichBlocks([{ kind: "text", content: String.raw`\[\sum_{i=1}^n x_i\]` }]);
  assert.equal(r2.stats.rendered, 1);
  assert.equal(launchCount, 1);

  // Idle timer closes browser automatically after idleCloseMs
  await new Promise((r) => setTimeout(r, 140));
  assert.equal(closeCount, 1);
  assert.equal(service.isBrowserActive(), false);
});

test("FEISHU-001: im.message.recalled_v1 is subscribed by default in policy, supervisor, and PowerShell wrappers", () => {
  const repoRoot = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const policy = JSON.parse(fs.readFileSync(path.join(repoRoot, "apps/desktop/src/main/services/recommended-permission-policy.json"), "utf8"));
  assert.ok(policy.eventKeys.includes("im.message.recalled_v1"));
  assert.ok(policy.eventKeys.includes("im.message.receive_v1"));

  const supervisor = fs.readFileSync(path.join(repoRoot, "apps/desktop/src/main/services/supervisor.cjs"), "utf8");
  assert.match(supervisor, /CODEX_FEISHU_EVENT_KEYS:\s*"im\.message\.receive_v1,im\.message\.recalled_v1"/);

  const startPs1 = fs.readFileSync(path.join(repoRoot, "start-codex-feishu-bridge.ps1"), "utf8");
  assert.match(startPs1, /\$EventKeys\s*=\s*"im\.message\.receive_v1,im\.message\.recalled_v1"/);
  assert.match(startPs1, /\[ValidateSet\('codex',\s*'claude',\s*'antigravity'\)\]/);

  const watchPs1 = fs.readFileSync(path.join(repoRoot, "watch-codex-feishu-bridge.ps1"), "utf8");
  assert.match(watchPs1, /\$EventKeys\s*=\s*"im\.message\.receive_v1,im\.message\.recalled_v1"/);
});
