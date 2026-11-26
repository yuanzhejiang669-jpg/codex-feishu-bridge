import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  cardMarkdownContent,
  containsMarkdownTable,
  hasFencedCodeBlock,
  markdownElements,
  splitCardMarkdownSegments,
  splitText,
  truncateWithOverflowByBytes,
} from "../src/feishu/cards/primitives.mjs";
import { createRunCardRenderer } from "../src/feishu/cards/run-card.mjs";
import { createLarkClient, isTransientLarkError } from "../src/feishu/lark-cli.mjs";

function makeRenderer(configOverrides = {}) {
  return createRunCardRenderer({
    CONFIG: { engine: "antigravity", workspace: "C:\\work", debugCards: false, showFinalSteps: true, maxRunningToolDetails: 20, ...configOverrides },
    log: () => {},
    activeRuns: { runs: {} },
    saveActiveRuns: () => {},
    larkJsonWithData: async () => ({}),
    codexModelLabel: "gemini-4-neon",
    userTextFromContent: (c) => String(c || ""),
    effectiveSessionSettings: () => ({ model: "gemini-4-neon" }),
    updateSessionTokenUsage: () => {},
    updateSessionThreadStatus: () => {},
    updateSessionGoal: () => {},
    updateSessionFailure: () => {},
    clearSessionFailure: () => {},
    markSessionCompacted: () => {},
    resultTextFromState: () => "",
    goalStatusLabel: (s) => s,
    formatDuration: (ms) => `${ms}ms`,
    formatNumber: (n) => String(n),
    formatTime: () => "12:00",
  });
}

test("v0.10.23 (#12): external https:// image markdown downgrades to clickable link to prevent Feishu 200570 while keeping img_ keys", () => {
  const input = [
    "外链图：![示例架构](https://example.com/arch.png)",
    "无标题外链图：![](https://example.com/a.jpg)",
    "飞书原生图：![公式](img_v3_0217q_abc123)",
    "本地占位图：![截图](本地/私有图)",
    "行内代码里不动：`![demo](https://example.com/raw.png)`",
  ].join("\n");

  const out = cardMarkdownContent(input);
  assert.match(out, /外链图：\[图片: 示例架构\]\(https:\/\/example\.com\/arch\.png\)/);
  assert.match(out, /无标题外链图：\[图片\]\(https:\/\/example\.com\/a\.jpg\)/);
  assert.match(out, /飞书原生图：!\[公式\]\(img_v3_0217q_abc123\)/);
  assert.match(out, /本地占位图：`\[图片: 截图\] \(本地\/私有图\)`/);
  assert.match(out, /`!\[demo\]\(https:\/\/example\.com\/raw\.png\)`/);
  assert.doesNotMatch(out, /!\[示例架构\]\(https:/);
});

test("v0.10.23 (#13): ordered list numbering locks after hoisted code block or table, while new lists starting at 1. reset cleanly", () => {
  const input = [
    "1. 第一步",
    "2. 第二步执行命令：",
    "   ```powershell",
    "   echo hello",
    "   ```",
    "   *(附注说明)*",
    "3. 第三步重启电脑",
    "4. 第四步核验内存",
    "",
    "### 新章节",
    "1. 新列表第一项",
    "2. 新列表第二项",
  ].join("\n");

  const out = cardMarkdownContent(input);
  assert.match(out, /^1\. 第一步\n2\. 第二步执行命令：\n\n```powershell\necho hello\n```\n\n   \*\(附注说明\)\*\n\*\*3\.\*\* 第三步重启电脑\n\*\*4\.\*\* 第四步核验内存/m);
  assert.match(out, /### 新章节\n1\. 新列表第一项\n2\. 新列表第二项/);
});

test("v0.10.23 (#14): CJK punctuation adjacent to **bold** gains safe flanking spaces without altering normal bold or inline code", () => {
  const input = [
    "前面**“重点内容”**后面，再把**（括号）**和**「终端」**文字一起检查。",
    "**右键**点屏幕，**3 步（总共不到 30 秒）**：全部完成。",
    "代码不变：`**“保留原样”**`",
  ].join("\n");

  const out = cardMarkdownContent(input);
  assert.match(out, /前面 \*\*“重点内容”\*\* 后面，再把 \*\*（括号）\*\* 和 \*\*「终端」\*\* 文字一起检查。/);
  assert.match(out, /\*\*右键\*\*点屏幕，\*\*3 步（总共不到 30 秒）\*\*：全部完成。/);
  assert.match(out, /`\*\*“保留原样”\*\*`/);
});

test("v0.10.23 (#15): multi-table markdown splits into independent markdown elements capped at 3 tables per element", () => {
  const tables = Array.from({ length: 5 }, (_, i) => [
    `### 表 ${i + 1}`,
    `| 列A | 列B |`,
    `|---|---|`,
    `| v${i} | ok |`,
  ].join("\n")).join("\n\n");

  assert.equal(containsMarkdownTable(tables), true);
  assert.equal(hasFencedCodeBlock(tables), false);

  const elements = markdownElements(tables, { maxTablesPerElement: 3 });
  assert.equal(elements.length, 2);
  assert.equal(splitCardMarkdownSegments(cardMarkdownContent(tables), { maxTablesPerElement: 3 }).length, 2);
  assert.match(elements[0].content, /### 表 1/);
  assert.match(elements[0].content, /### 表 3/);
  assert.doesNotMatch(elements[0].content, /### 表 4/);
  assert.match(elements[1].content, /\| v3 \| ok \|/);
  assert.match(elements[1].content, /\| v4 \| ok \|/);
});

test("v0.10.23 (#16): >28KB finalized card captures exact overflow tail with balanced code fences instead of dropping text", () => {
  const renderer = makeRenderer({ maxCardJsonBytes: 6000 });
  const state = renderer.createRunState({ id: "s-ovf", title: "overflow" }, {}, "prompt");
  const lines = Array.from({ length: 120 }, (_, i) => `第 ${i + 1} 行：重要交付明细与验证结果标记_ROW_${i + 1}_END`);
  state.blocks.push({
    kind: "text",
    content: `${lines.slice(0, 60).join("\n")}\n\n\`\`\`powershell\n${lines.slice(60).join("\n")}\n\`\`\``,
    streaming: false,
  });
  state.terminal = "done";

  const card = renderer.renderRunCard(state);
  const bytes = Buffer.byteLength(JSON.stringify(card), "utf8");
  assert.ok(bytes <= 6000, `card bytes ${bytes} exceeded 6000`);
  assert.ok(state.cardOverflowText.length > 0, "expected non-empty overflow tail");
  assert.match(JSON.stringify(card), /剩余内容续发在下方/);
  assert.match(state.cardOverflowText, /ROW_120_END/);

  const cut = truncateWithOverflowByBytes("前文\n```js\n" + "const x = 1;\n".repeat(40) + "```", 260);
  assert.equal(cut.truncated, true);
  assert.equal((cut.text.match(/^```/gm) || []).length % 2, 0);
  assert.match(cut.overflow, /^```js\n/);
});

test("v0.10.23 (#17): superseded card renders concise notice, recallMessage calls DELETE, and bridge wires recall + overflow send", async () => {
  const renderer = makeRenderer();
  const superseded = renderer.renderSupersededCard({ meta: { engine: "antigravity" } });
  assert.equal(superseded.schema, "2.0");
  assert.equal(superseded.header.title.content, "Antigravity 已送达");
  assert.match(JSON.stringify(superseded), /已通过下方消息送达/);

  const calls = [];
  const lark = createLarkClient({
    larkCli: "lark-cli",
    splitText,
    idempotencyKey: (b, s) => `${b}:${s}`,
    delay: async () => {},
    runTool: async (_cmd, args) => {
      calls.push(args);
      return { code: 0, stdout: "{}", stderr: "" };
    },
  });
  assert.equal(await lark.recallMessage("om_late_card_1"), true);
  assert.deepEqual(calls[0], ["api", "DELETE", "/open-apis/im/v1/messages/om_late_card_1", "--as", "bot"]);

  const bridgeSrc = fs.readFileSync(new URL("../codex-feishu-bridge.mjs", import.meta.url), "utf8");
  assert.match(bridgeSrc, /await recallMessage\(opened\.messageId\)/);
  assert.match(bridgeSrc, /renderSupersededCard\(latestCardState\)/);
  assert.match(bridgeSrc, /latestCardState\?\.cardOverflowText/);
  assert.match(bridgeSrc, /"answer-overflow"/);
});

test("v0.10.23 (#18): isTransientLarkError retries Feishu 2200/server_error/retryable and sendMarkdown upgrades tables to Card 2.0 with fallback", async () => {
  const feishu2200 = JSON.stringify({
    ok: false,
    error: { type: "api", subtype: "server_error", code: 2200, message: "Something went wrong.", retryable: true },
  });
  assert.equal(isTransientLarkError({ stderr: feishu2200, stdout: "" }), true);
  assert.equal(isTransientLarkError({ stderr: '{"code":2200}', stdout: "" }), true);
  assert.equal(isTransientLarkError({ stderr: '{"retryable": true}', stdout: "" }), true);

  // 1) Transient 2200 on attempt 1 retries and succeeds on attempt 2, sending table as static Card 2.0
  let attempt = 0;
  const sent = [];
  const lark1 = createLarkClient({
    larkCli: "lark-cli",
    splitText,
    idempotencyKey: (b, s) => `${b}:${s}`,
    delay: async () => {},
    runTool: async (_cmd, args, options) => {
      attempt += 1;
      sent.push({ args, stdin: options?.stdin });
      if (attempt === 1) return { code: 1, stdout: feishu2200, stderr: "" };
      return { code: 0, stdout: "{}", stderr: "" };
    },
  });
  await lark1.sendMarkdown("oc_1", "对比表：\n| 项目 | 状态 |\n|---|---|\n| A | OK |", "bg-1", "om_1");
  assert.equal(attempt, 2);
  assert.equal(sent[1].args[sent[1].args.indexOf("--msg-type") + 1], "interactive");
  const card = JSON.parse(sent[1].stdin);
  assert.equal(card.schema, "2.0");
  assert.match(card.body.elements[0].content, /\| 项目 \| 状态 \|/);

  // 2) Permanent Card 2.0 failure automatically falls back to post `--markdown -`
  const fbCalls = [];
  const lark2 = createLarkClient({
    larkCli: "lark-cli",
    splitText,
    idempotencyKey: (b, s) => `${b}:${s}`,
    delay: async () => {},
    runTool: async (_cmd, args, options) => {
      fbCalls.push({ args, stdin: options?.stdin });
      if (args.includes("interactive")) {
        return { code: 1, stdout: "", stderr: "HTTP 400 invalid card" };
      }
      return { code: 0, stdout: "{}", stderr: "" };
    },
  });
  await lark2.sendMarkdown("oc_1", "```bash\necho fallback\n```", "bg-2", "om_2");
  assert.equal(fbCalls.length, 2);
  assert.equal(fbCalls[0].args.includes("interactive"), true);
  assert.equal(fbCalls[1].args[fbCalls[1].args.indexOf("--markdown") + 1], "-");
  assert.match(fbCalls[1].stdin, /echo fallback/);
});
