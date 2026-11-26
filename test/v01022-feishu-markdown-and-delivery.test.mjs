import assert from "node:assert/strict";
import test from "node:test";
import MarkdownIt from "markdown-it";

import {
  cardMarkdownContent,
  escapeInlineMarkdown,
  markdown,
  splitText,
  truncateCardText,
  truncateCardTextByBytes,
  wrapCodeBlock,
} from "../src/feishu/cards/primitives.mjs";
import { createRunCardRenderer } from "../src/feishu/cards/run-card.mjs";
import { createLarkClient } from "../src/feishu/lark-cli.mjs";
import {
  createFormulaImageService,
  createFormulaMarkdownRenderer,
  renderMixedHtml,
} from "../src/feishu/cards/formula-renderer.mjs";

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

test("v0.10.22 (P0-1): indented, quoted, same-line list, tilde, and nested code fences are hoisted cleanly to top-level", () => {
  const input = [
    "1. 右键开始菜单",
    "2. 把下面这 3 行整段复制进去：",
    "   ```powershell",
    "   Disable-ScheduledTask -TaskPath '\\' -TaskName 'WpsUpdate'",
    "   if ($true) {",
    "     Set-Service -Name 'LenovoPcManagerService' -StartupType Disabled",
    "   }",
    "   ```",
    "3. 重启电脑。",
    "",
    "> ```bash",
    "> echo hi",
    "> ```",
    "",
    "- ~~~python",
    "  print('tilde inside list')",
    "  ~~~",
  ].join("\n");

  const out = cardMarkdownContent(input);
  assert.match(out, /\n\n```powershell\nDisable-ScheduledTask -TaskPath '\\' -TaskName 'WpsUpdate'\nif \(\$true\) \{\n  Set-Service -Name 'LenovoPcManagerService' -StartupType Disabled\n\}\n```\n\n\*\*3\.\*\* 重启电脑/);
  assert.match(out, /\n\n```bash\necho hi\n```\n\n/);
  assert.match(out, /-\n\n```python\nprint\('tilde inside list'\)\n```/);
});

test("v0.10.22 (P0-1 & P2-10): nested 4-backtick outer fence preserves inner triple backticks and unclosed streaming fence auto-closes", () => {
  const nested = [
    "````markdown",
    "```js",
    "console.log(1);",
    "```",
    "````",
  ].join("\n");
  const normalized = cardMarkdownContent(nested);
  assert.match(normalized, /^````markdown\n```js\nconsole\.log\(1\);\n```\n````$/);

  const partialStream = "步骤如下：\n\n```ts\nconst x = 1;\nconst y = 2;";
  const streamed = cardMarkdownContent(partialStream, { streaming: true });
  assert.match(streamed, /\n\n```ts\nconst x = 1;\nconst y = 2;\n```$/);
});

test("v0.10.22 (P0-2): preserves inline backticks, protects underscores/Windows paths, and escapes non-whitelist angle tags", () => {
  const input = [
    "路径：`C:\\Users\\a\\_build\\*test*` 与泛型 `List<String>`，命令 `/model <模型ID>`。",
    "未包反引号：<模型ID>、List<String>、<script>alert(1)</script>、1 < 2 且 3 > 1。",
    "保留飞书白名单标签：<at id=\"ou_1\">张三</at>、<font color=\"red\">注意</font>、<text_tag color=\"blue\">TAG</text_tag>、<br/>、<https://open.feishu.cn>。",
  ].join("\n");

  const out = cardMarkdownContent(input);
  assert.match(out, /`C:\\Users\\a\\_build\\\*test\*`/);
  assert.match(out, /`List<String>`/);
  assert.match(out, /`\/model <模型ID>`/);
  assert.match(out, /&lt;模型ID&gt;/);
  assert.match(out, /List&lt;String&gt;/);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(out, /1 < 2 且 3 > 1/);
  assert.match(out, /<at id="ou_1">张三<\/at>/);
  assert.match(out, /<font color="red">注意<\/font>/);
  assert.match(out, /<text_tag color="blue">TAG<\/text_tag>/);
  assert.match(out, /<br\/>/);
  assert.match(out, /<https:\/\/open\.feishu\.cn>/);
});

test("v0.10.22 (P0-3): lark-cli sendText, sendMarkdown, and replyFallback use stdin so leading @ or - never fail", async () => {
  const calls = [];
  const lark = createLarkClient({
    larkCli: "lark-cli",
    splitText,
    idempotencyKey: (b, s) => `${b}:${s}`,
    delay: async () => {},
    runTool: async (_cmd, args, options) => {
      calls.push({ args, stdin: options?.stdin });
      return { code: 0, stdout: "{}", stderr: "" };
    },
  });

  await lark.sendText("oc_1", "@echo off\n- item", "sfx", "base1");
  await lark.sendMarkdown("oc_1", "@decorator\n1. step\n   ```sh\n   echo hi\n   ```", "msfx", "base2");
  await lark.replyFallback("om_1", "-", "rsfx");

  assert.equal(calls.length, 3);
  assert.equal(calls[0].args[calls[0].args.indexOf("--text") + 1], "-");
  assert.equal(calls[0].stdin, "@echo off\n- item");

  assert.equal(calls[1].args[calls[1].args.indexOf("--msg-type") + 1], "interactive");
  assert.equal(calls[1].args[calls[1].args.indexOf("--content") + 1], "-");
  const cardPayload = JSON.parse(calls[1].stdin);
  assert.equal(cardPayload.schema, "2.0");
  assert.match(cardPayload.body.elements[0].content, /^@decorator\n1\. step\n\n```sh\necho hi\n```$/);

  assert.equal(calls[2].args[calls[2].args.indexOf("--text") + 1], "-");
  assert.equal(calls[2].stdin, "-");
});

test("v0.10.22 (P0-4): splitText, truncateCardText, and wrapCodeBlock keep code fences intact", () => {
  const longCode = `前文说明。\n\n\`\`\`powershell\n${Array.from({ length: 40 }, (_, i) => `Write-Output "line_${i}"`).join("\n")}\n\`\`\`\n\n末尾总结。`;
  const parts = splitText(longCode, 220);
  assert.ok(parts.length >= 3);
  for (const part of parts) {
    assert.ok(part.length <= 230, `part too long: ${part.length}`);
    const fenceCount = (part.match(/^```/gm) || []).length;
    assert.equal(fenceCount % 2, 0, `unbalanced fence in chunk:\n${part}`);
  }
  assert.match(parts[1], /^```powershell\n/);

  const truncated = truncateCardText(longCode, 140);
  assert.equal((truncated.match(/^```/gm) || []).length % 2, 0);
  assert.match(truncated, /\.\.\.\(已截断\)$/);

  const wrapped = wrapCodeBlock("echo start\n```js\nalert(1)\n```\necho end", "text");
  assert.match(wrapped, /^````text\n/);
  assert.match(wrapped, /\n````$/);
});

test("v0.10.22 (P0-5 & P2-11): formula fallback preserves prose and mixed HTML uses markdown-it for inline code and lists", async () => {
  const service = createFormulaImageService({ uploadImage: null });
  const result = await service.enrichBlocks([{
    kind: "text",
    content: [
      String.raw`关键结论：后验概率为 \(\frac{P(D\mid\theta)P(\theta)}{P(D)}\)，必须保留这段说明文字。`,
      "",
      String.raw`\[\sum_{i=1}^n x_i\]`,
    ].join("\n"),
  }]);
  const full = result.blocks.map((b) => b.content || "").join("");
  assert.match(full, /关键结论：后验概率为.*必须保留这段说明文字/);
  assert.match(full, /暂时无法渲染/);
  assert.equal(/\\(?:frac|mid)/.test(full), false);

  const md = createFormulaMarkdownRenderer(MarkdownIt);
  const katex = { renderToString: (l) => `<span class="k">${l}</span>` };
  const html = renderMixedHtml("步骤：\n- 使用 `my_var`\n- 公式：\\(\\frac{a}{b}\\)", katex, md);
  assert.match(html, /<ul>/);
  assert.match(html, /<code>my_var<\/code>/);
  assert.match(html, /<span class="k">\\frac\{a\}\{b\}<\/span>/);
});

test("v0.10.22 (P1-7 & P1-8): tables are unindented & padded, Setext --- is guarded, local images & file:/// links degrade cleanly", () => {
  const input = [
    "1. 核对结果：",
    "   | 项目 | 状态 |",
    "   |---|---|",
    "   | 内存 | 已释放 |",
    "2. 接着看这段总结",
    "---",
    "交付文档：[report_final.docx](file:///C:/Users/a/docs/report_final.docx) 与 [架构说明](file:///C:/Users/a/docs/arch_note.md)",
    "本地图：![预览图](C:\\Users\\a\\out\\preview_1.png)，远程图：![图](img_v3_123)",
  ].join("\n");

  const out = cardMarkdownContent(input);
  assert.match(out, /\n\n\| 项目 \| 状态 \|\n\|---\|---\|\n\| 内存 \| 已释放 \|\n\n/);
  assert.match(out, /\*\*2\.\*\* 接着看这段总结\n\n---/);
  assert.match(out, /`C:\\Users\\a\\docs\\report_final\.docx`/);
  assert.match(out, /`架构说明` \(`C:\\Users\\a\\docs\\arch_note\.md`\)/);
  assert.match(out, /`\[图片: 预览图\] \(C:\\Users\\a\\out\\preview_1\.png\)`/);
  assert.match(out, /!\[图\]\(img_v3_123\)/);
  assert.doesNotMatch(out, /file:\/\/\//);
});

test("v0.10.22 (P1-6 & P1-9): runCard caps failed tool panels, escapes header commands, and fits strictly within 28KB UTF-8 budget", () => {
  const renderer = makeRenderer();
  const makeToolsState = (bodyText) => {
    const state = renderer.createRunState({ id: "s1", title: "test" }, {}, "prompt");
    for (let i = 0; i < 12; i += 1) {
      state.blocks.push({
        kind: "tool",
        tool: {
          id: `t-${i}`,
          source: "command",
          name: "bash",
          input: { command: `Get-ChildItem *_log_${i}* <tag> | echo done` },
          output: `error output ${i}\n\`\`\`\ninside\n\`\`\`\n${"细节".repeat(60)}`,
          status: "error",
        },
      });
    }
    state.blocks.push({ kind: "text", content: bodyText, streaming: false });
    state.terminal = "done";
    return state;
  };

  // Normal body + 12 failed tools: capped to 1 summary panel + 5 recent failed panels, headers escaped
  const normalCard = renderer.renderRunCard(makeToolsState("排查完成。"));
  const panelCount = normalCard.body.elements.filter((e) => e.tag === "collapsible_panel").length;
  assert.equal(panelCount, 6);
  const normalJson = JSON.stringify(normalCard);
  assert.match(normalJson, /\\\\\*\\\\_log\\\\_11\\\\\*/);
  assert.match(normalJson, /&lt;tag&gt;/);
  assert.match(normalJson, /````/);

  // Giant Chinese body + 12 failed tools: enforced strictly under 28KB UTF-8 limit
  const hugeCard = renderer.renderRunCard(
    makeToolsState(`${"中文长报告内容段落，包含重要数据与结论。".repeat(900)}\n\`\`\`js\n${"const a = 1;\n".repeat(40)}\`\`\``),
  );
  const bytes = Buffer.byteLength(JSON.stringify(hugeCard), "utf8");
  assert.ok(bytes <= 28_000, `card UTF-8 bytes (${bytes}) exceeded 28000`);

  assert.equal(markdown("hello").tag, "markdown");
  assert.equal(truncateCardTextByBytes("```js\n" + "中文".repeat(500) + "\n```", 200).endsWith("...(内容过长已截断)"), true);
  assert.equal(escapeInlineMarkdown("a_b*<x>"), "a\\_b\\*&lt;x&gt;");
});
