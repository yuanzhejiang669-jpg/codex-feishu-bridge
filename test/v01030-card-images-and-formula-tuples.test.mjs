import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import { chatIdOf, eventIdOf, messageIdOf } from "../src/feishu/events.mjs";
import { extractCardContent, parseEventCommand, prepareCardEvent } from "../src/feishu/card-content.mjs";
import { createAttachmentManager } from "../src/feishu/attachments.mjs";
import { parseCommand } from "../src/commands/parser.mjs";
import {
  planFormulaRendering,
  scanLatexFormulas,
  simplifySimpleFormulasInMarkdown,
} from "../src/feishu/cards/formula-renderer.mjs";

test("v0.10.30 (#1): extractCardContent & prepareCardEvent extract embedded card img_keys while ignoring quoted prose image strings", () => {
  const envelope = `<card title="Antigravity 已完成">
核心策略：
🖼️ 公式密集段落(img_key:img_v3_0217s_7a0d11a9-9ef1-4f1f-8089-c3092f4595bg)
🖼️ 公式密集段落(img_key:img_v3_0217s_25b82644-4292-45de-ac89-bd9bc4291eeg)
普通文字里提了一句 ![图](img_quoted_only) 和 img_plain_mention
</card>`;
  const extracted = extractCardContent(envelope);
  assert.deepEqual(extracted.imageKeys, [
    "img_v3_0217s_7a0d11a9-9ef1-4f1f-8089-c3092f4595bg",
    "img_v3_0217s_25b82644-4292-45de-ac89-bd9bc4291eeg",
  ]);

  const prepared = prepareCardEvent({
    message_id: "om_card_1",
    chat_id: "oc_chat_1",
    message_type: "interactive",
    content: envelope,
  });
  assert.equal(prepared.cardReadable, true);
  assert.deepEqual(prepared.cardImageKeys, extracted.imageKeys);
  assert.match(JSON.parse(prepared.content).text, /图片已自动下载/);

  const schema2Card = {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: "公式卡片" } },
    body: {
      elements: [
        { tag: "markdown", content: "标题文字" },
        { tag: "img", img_key: "img_v3_schema2_abc", title: { tag: "plain_text", content: "公式" } },
      ],
    },
  };
  const extractedJson = extractCardContent(schema2Card);
  assert.deepEqual(extractedJson.imageKeys, ["img_v3_schema2_abc"]);
  assert.match(extractedJson.text, /\[卡片图片：公式\]\(img_key:img_v3_schema2_abc\)/);
});

test("v0.10.30 (#1): handleEvent downloads authentic forwarded card img_keys and attaches them to event.attachments", async () => {
  const source = fs.readFileSync(new URL("../codex-feishu-bridge.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function handleEvent(");
  const end = source.indexOf("  await syncChatSessionsWithCodex(", start);
  const downloadedKeys = [];
  const context = {
    messageIdOf, eventIdOf, chatIdOf, prepareCardEvent, parseEventCommand,
    parseCommand: (content) => parseCommand(JSON.parse(content).text),
    userTextFromContent: (content) => JSON.parse(content).text,
    isMessageRecalled: () => false, rememberEvent: () => false,
    enrichEvent: async (event) => ({
      ...event,
      content: `<card title="Antigravity 已完成">\n说明文字\n🖼️ 公式密集段落(img_key:img_v3_card_1)\n🖼️ 公式密集段落(img_key:img_v3_card_2)\n</card>`,
    }),
    attachSenderUnionId: async (event) => event,
    log: () => {},
    stats: { events: 0, commands: 0 },
    sendText: async () => {},
    downloadImageAttachments: async (_event, options) => {
      downloadedKeys.push(...(options?.keys || []));
      return (options?.keys || []).map((key) => ({ type: "image", fileKey: key, path: `/tmp/${key}.png` }));
    },
    downloadFileAttachments: async () => {
      throw new Error("Forwarded cards must not call downloadFileAttachments");
    },
    downloadAllAttachments: async () => {
      throw new Error("Forwarded cards must not call downloadAllAttachments");
    },
    takePendingAttachments: () => [],
    withAttachmentLock: async (_chatId, fn) => fn(),
    prepareCommandAttachments: async () => {},
    handleCommand: async () => {},
  };
  const handle = vm.runInNewContext(`(${source.slice(start, end)} return { event, userContent };\n})`, context);
  const res = await handle({ message_id: "om_fwd_card", chat_id: "oc_1", message_type: "interactive" });
  assert.deepEqual(downloadedKeys, ["img_v3_card_1", "img_v3_card_2"]);
  assert.equal(res.event.attachments.length, 2);
  assert.deepEqual(Array.from(res.event.attachments, (a) => a.fileKey), ["img_v3_card_1", "img_v3_card_2"]);
});

test("v0.10.30 (#1): downloadImageAttachments respects explicit keys without scanning unrelated content keys", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "card-img-att-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const seenKeys = [];
  const manager = createAttachmentManager({
    CONFIG: { workspace, attachmentRelDir: ".att", maxFileAttachmentBytes: 10_000_000 },
    log: () => {},
    safeFilePart: (v) => String(v).replace(/[^A-Za-z0-9_.-]/g, "_"),
    runLark: async (args) => {
      const keyIdx = args.indexOf("--file-key");
      const outIdx = args.indexOf("--output");
      const fileKey = args[keyIdx + 1];
      const relOut = args[outIdx + 1];
      seenKeys.push(fileKey);
      const absOut = path.join(workspace, relOut);
      fs.mkdirSync(path.dirname(absOut), { recursive: true });
      fs.writeFileSync(absOut, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      return { code: 0, stdout: JSON.stringify({ ok: true, data: { saved_path: absOut, size_bytes: 8 } }), stderr: "" };
    },
  });

  const event = {
    message_id: "om_card_dl",
    content: JSON.stringify({ text: "prose mentions img_ignore_me and img_v3_real_1" }),
  };
  const downloaded = await manager.downloadImageAttachments(event, { keys: ["img_v3_real_1"] });
  assert.deepEqual(seenKeys, ["img_v3_real_1"]);
  assert.equal(downloaded.length, 1);
  assert.equal(downloaded[0].fileKey, "img_v3_real_1");
});

test("v0.10.30 (#2): letter tuples/pairs ($B, C$, $(x, y)$, $f(x, y)$, $A B$) parse cleanly and CJK punctuation ($、$) never causes dollar parity desync", () => {
  const exactLine = String.raw`4. 卡片最底部折叠栏里提取出的 **41 条零散 LaTeX 公式片段**（如 $J_A, A^+, P=B(B^HB)^{-1}B^H$，以及最后几个矩阵 $B, C$、$\lambda I - C$、$\lambda=1,1,1$、$(A-I)x=0$）`;
  const formulas = scanLatexFormulas(exactLine);
  assert.deepEqual(
    formulas.map((f) => f.latex),
    [
      "J_A, A^+, P=B(B^HB)^{-1}B^H",
      "B, C",
      String.raw`\lambda I - C`,
      String.raw`\lambda=1,1,1`,
      "(A-I)x=0",
    ],
  );

  // Tuple/pair/interval/product/keyword forms simplify cleanly without leaking `$`
  const tuples = "变量 $B, C$、坐标 $(x, y)$、区间 $[0, 1]$、函数 $f(x, y)$、乘积 $A B$、秩 $rank A$，价格对比 $10 today and $20，打折 $25，现价 $20。";
  const simplified = simplifySimpleFormulasInMarkdown(tuples);
  assert.match(simplified, /变量 B, C、坐标 \(x, y\)、区间 \[0, 1\]、函数 f\(x, y\)、乘积 A B、秩 rank A/);
  assert.match(simplified, /价格对比 \$10 today and \$20，打折 \$25，现价 \$20。/);

  // Unmatched `$` before Chinese punctuation must NEVER swallow `$、$` and desync subsequent formulas
  const brokenPrefix = String.raw`异常未闭合 $abc def、$\lambda I - C$、$\lambda=1,1,1$、$(A-I)x=0$`;
  const recovered = scanLatexFormulas(brokenPrefix);
  assert.deepEqual(
    recovered.map((f) => f.latex),
    [String.raw`\lambda I - C`, String.raw`\lambda=1,1,1`, "(A-I)x=0"],
  );
  const plans = planFormulaRendering(brokenPrefix);
  const text = plans.map((p) => p.content || "").join("");
  assert.match(text, /λ I - C、λ=1,1,1、\(A-I\)x=0/);
});
