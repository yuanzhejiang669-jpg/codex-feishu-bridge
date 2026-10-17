import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import { chatIdOf, eventIdOf, messageIdOf } from "../src/feishu/events.mjs";
import { extractCardContent, isCardEvent, parseEventCommand, prepareCardEvent } from "../src/feishu/card-content.mjs";
import { parseCommand } from "../src/commands/parser.mjs";

test("reads the actual lark-cli card envelope without losing markdown, paths, or table rows", () => {
  const body = 'oldpc | 100.66.156.47\nnewpc | 100.117.86.75\nC:\\Users\\a\n**检查结果**：A &amp; B';
  assert.equal(extractCardContent(`<card title="Codex 已完成">\n${body}\n</card>`).text,
    'Codex 已完成\noldpc | 100.66.156.47\nnewpc | 100.117.86.75\nC:\\Users\\a\n**检查结果**：A & B');
});

test("reads received card JSON with nested rows and links", () => {
  const content = { title: "设备核查", elements: [[
    { tag: "text", text: "oldpc 正常" }, { tag: "a", text: "详情", href: "https://example.com" },
  ], [{ tag: "text", text: "newpc 离线" }]] };
  assert.equal(extractCardContent(JSON.stringify(content)).text, "设备核查\noldpc 正常\n[详情](https://example.com)\nnewpc 离线");
});

test("reads classic and schema 2.0 cards, keeping ordered table values", () => {
  const content = { schema: "2.0", header: { title: { tag: "plain_text", content: "设备" } }, body: { elements: [
    { tag: "markdown", content: "正文" },
    { tag: "column_set", columns: [{ tag: "column", elements: [{ tag: "div", text: { tag: "lark_md", content: "分栏文字" } }] }] },
    { tag: "table", columns: [{ name: "device", display_name: "名称" }, { name: "ip", display_name: "IP" }], rows: [{ device: "oldpc", ip: "100.66.156.47" }] },
    { tag: "button", text: { content: "危险按钮" }, value: { command: "/delete all" } },
  ] } };
  assert.equal(extractCardContent(content).text, "设备\n正文\n分栏文字\n名称：oldpc\nIP：100.66.156.47");
});

test("same-bot and cross-bot forwards follow the same card path without sender filtering", () => {
  for (const sender_id of ["same-bot-user", "other-bot-user"]) {
    const event = prepareCardEvent({ message_id: "om_forward", chat_id: "oc_target", sender_id, message_type: "interactive", content: '<card title="结果">测试结果</card>' });
    assert.equal(event.cardReadable, true);
    assert.equal(event.chat_id, "oc_target");
    assert.match(JSON.parse(event.content).text, /测试结果/);
    assert.equal(parseEventCommand(event, parseCommand), null);
  }
});

test("raw receive events are recognized when enrichment is unavailable", () => {
  const raw = { event: { message: { message_type: "interactive", content: JSON.stringify({ title: "结果", elements: [[{ tag: "text", text: "可读取正文" }]] }) } } };
  assert.equal(isCardEvent(raw), true);
  assert.match(JSON.parse(prepareCardEvent(raw).content).text, /可读取正文/);
});

test("card text never dispatches control commands, including before enrichment", () => {
  for (const content of ['{"text":"/stop"}', '<card title="命令">/delete all</card>']) {
    const raw = { message_type: "interactive", content };
    assert.equal(parseEventCommand(raw, parseCommand), null);
    assert.equal(parseEventCommand(prepareCardEvent(raw), parseCommand), null);
  }
  assert.equal(parseEventCommand({ message_type: "text", content: '{"text":"/stop"}' }, (content) => parseCommand(JSON.parse(content).text)).name, "/stop");
});

test("empty, inaccessible, and unsupported cards explicitly report unreadable", () => {
  for (const content of ["", "not JSON", "{broken", '{"title":"只有标题","elements":[]}', '{"card_id":"123"}', '{"type":"template","data":{"template_id":"ABC"}}', '<card title="结果"></card>']) {
    assert.equal(prepareCardEvent({ message_type: "interactive", content }).cardReadable, false, content);
  }
  const regular = { message_type: "text", content: '{"text":"正常消息"}' };
  assert.equal(prepareCardEvent(regular), regular);
});

test("large and deeply nested card content is bounded and marked partial", () => {
  const clipped = extractCardContent({ elements: [{ tag: "markdown", content: "x".repeat(100) }] }, { maxChars: 12 });
  assert.equal(clipped.text.length, 12);
  assert.equal(clipped.truncated, true);
  let nested = { tag: "markdown", content: "深层文字" };
  for (let index = 0; index < 50; index++) nested = { elements: [nested] };
  assert.equal(extractCardContent(nested).truncated, true);
  const manyColumns = { tag: "table", columns: Array.from({ length: 200 }, () => ({ name: "x" })), rows: [{ x: "value" }, null] };
  assert.equal(extractCardContent(manyColumns, { maxNodes: 20 }).truncated, true);
  assert.doesNotThrow(() => extractCardContent({ tag: "table", columns: [null, { name: "x" }], rows: [null, { x: "value" }] }));
});

// Execute the real handler preflight without starting a bot or sending live messages.
function handlerHarness(enrich = async (event) => event) {
  const source = fs.readFileSync(new URL("../codex-feishu-bridge.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function handleEvent(");
  const end = source.indexOf("  await syncChatSessionsWithCodex(", start);
  const calls = { sent: [], downloads: 0, commands: 0, pendingTaken: 0 };
  const context = {
    messageIdOf, eventIdOf, chatIdOf, prepareCardEvent, parseEventCommand,
    parseCommand: (content) => parseCommand(JSON.parse(content).text),
    userTextFromContent: (content) => JSON.parse(content).text,
    isMessageRecalled: () => false, rememberEvent: () => false,
    enrichEvent: enrich, log: () => {}, stats: { events: 0, commands: 0 },
    sendText: async (...args) => calls.sent.push(args),
    downloadImageAttachments: async () => { calls.downloads++; return []; },
    downloadFileAttachments: async () => { calls.downloads++; return []; },
    takePendingAttachments: () => { calls.pendingTaken++; return []; },
    prepareCommandAttachments: async () => {},
    handleCommand: async () => { calls.commands++; },
  };
  const handle = vm.runInNewContext(`(${source.slice(start, end)} return { event, userContent };\n})`, context);
  return { handle, calls };
}

test("real message handler accepts enriched forwarded cards and does not download quoted image keys", async () => {
  const harness = handlerHarness(async (event) => ({ ...event, content: '<card title="结果">/stop\n![图](img_quoted_key)</card>' }));
  const result = await harness.handle({ message_id: "om_forward", chat_id: "oc_1", message_type: "interactive" });
  assert.match(result.userContent, /\/stop/);
  assert.equal(result.event.cardReadable, true);
  assert.equal(harness.calls.commands, 0);
  assert.equal(harness.calls.downloads, 0);
  assert.equal(harness.calls.sent.length, 0);
});

test("real message handler explains inaccessible cards without consuming pending attachments", async () => {
  const harness = handlerHarness();
  await harness.handle({ message_id: "om_forward", chat_id: "oc_1", message_type: "interactive", content: '{"card_id":"123"}' });
  assert.equal(harness.calls.sent[0][2], "card-unreadable");
  assert.equal(harness.calls.pendingTaken, 0);
  assert.equal(harness.calls.downloads, 0);
});
