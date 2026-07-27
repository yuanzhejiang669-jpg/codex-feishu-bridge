import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createFormulaImageService,
  isComplexLatex,
  planDenseFormulaRendering,
  planFormulaRendering,
  scanLatexFormulas,
  simplifyInlineLatex,
} from "../src/feishu/cards/formula-renderer.mjs";
import { createLarkClient } from "../src/feishu/lark-cli.mjs";

test("formula scanner recognizes explicit inline and display delimiters without treating prices as math", () => {
  const text = "价格是 $25，行内为 \\(x^2+y^2=1\\)，块级为 \\[\\frac{a}{b}\\]。";
  const formulas = scanLatexFormulas(text);
  assert.equal(formulas.length, 2);
  assert.equal(formulas[0].display, false);
  assert.match(formulas[0].latex, /x\^2/);
  assert.equal(formulas[1].display, true);
  assert.match(formulas[1].latex, /\\frac/);
});

test("simple inline formulas stay native and receive conservative Unicode conversion", () => {
  assert.equal(isComplexLatex("x^2 + y^2 = 1"), false);
  assert.equal(simplifyInlineLatex("x^2 + y^2 = 1"), "x² + y² = 1");
  assert.equal(simplifyInlineLatex("\\alpha + \\beta \\le 1"), "α + β ≤ 1");

  const plans = planFormulaRendering("复杂度是 $O(n^2)$，并且 $\\alpha+\\beta\\le1$。");
  assert.equal(plans.some((plan) => plan.kind === "image"), false);
  assert.match(plans.map((plan) => plan.content || "").join(""), /O\(n²\)/);
  assert.match(plans.map((plan) => plan.content || "").join(""), /α\+β≤1/);
});

test("paired numeric inline formulas lose delimiters without rewriting prices", () => {
  const source = "半径都是 $1$，距离都是 $2$，误差为 $-1.5$，样本数为 $1,000$，价格是 $25，区间是 $25-$30，转义价格是 \\$40，代码为 `$3$`。";
  const formulas = scanLatexFormulas(source);
  assert.equal(formulas.length, 4);
  assert.deepEqual(formulas.map((formula) => formula.latex), ["1", "2", "-1.5", "1,000"]);

  const visible = planFormulaRendering(source).map((plan) => plan.content || "").join("");
  assert.match(visible, /半径都是 1，距离都是 2/);
  assert.match(visible, /误差为 -1\.5/);
  assert.match(visible, /样本数为 1,000/);
  assert.match(visible, /价格是 \$25/);
  assert.match(visible, /区间是 \$25-\$30/);
  assert.match(visible, /转义价格是 \\\$40/);
  assert.match(visible, /代码为 `\$3\$`/);
  assert.doesNotMatch(visible, /\$(?:1|2|-1\.5|1,000)\$/);
});

test("a prose paragraph with complex inline formulas becomes one paragraph image", () => {
  const text = "后验分布 \\(p(\\theta\\mid D)=\\frac{p(D\\mid\\theta)p(\\theta)}{p(D)}\\) 综合先验与证据，距离为 \\(d_M=\\sqrt{x^T\\Sigma^{-1}x}\\)。";
  const plans = planFormulaRendering(text);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].kind, "image");
  assert.equal(plans[0].mode, "inline-paragraph");
  assert.equal(plans[0].formulas.length, 2);
});

test("display formulas become isolated images while surrounding prose stays native", () => {
  const plans = planFormulaRendering("前文。\n\n\\[\\sum_{i=1}^{n}x_i\\]\n\n后文。");
  assert.equal(plans.filter((plan) => plan.kind === "image").length, 1);
  assert.equal(plans.find((plan) => plan.kind === "image").mode, "block");
  assert.match(plans.filter((plan) => plan.kind === "text").map((plan) => plan.content).join(""), /前文/);
  assert.match(plans.filter((plan) => plan.kind === "text").map((plan) => plan.content).join(""), /后文/);
});

test("formula parsing never rewrites fenced code or unmatched delimiters", () => {
  const source = "行内代码 `$x^2$` 保持不变。\n\n```js\nconst price = '$25';\nconst latex = '\\\\frac{a}{b}';\n```\n\n未闭合公式 $x^2";
  const plans = planFormulaRendering(source);
  assert.equal(plans.some((plan) => plan.kind === "image"), false);
  assert.equal(plans.map((plan) => plan.content || "").join(""), source);
});

test("oversized formula paragraphs remain renderable instead of leaking raw LaTeX", () => {
  const formula = "\\(p(x)=\\frac{1}{\\sqrt{2\\pi}}e^{-x^2/2}\\)";
  const source = `${"很长的正文。".repeat(250)}${formula}`;
  const plans = planFormulaRendering(source, { maxParagraphChars: 1400 });
  assert.equal(plans.filter((plan) => plan.kind === "image").length, 1);
  assert.equal(plans[0].mode, "inline-paragraph");
  assert.equal(plans[0].formulas.length, 1);
});

test("complex inline formulas beside display formulas never leak raw LaTeX", () => {
  const source = [
    String.raw`SNR is \(\mathrm{SNR}=P_s/P_n\).`,
    "",
    String.raw`\[\mathrm{SNR}_{\mathrm{dB}}=10\log_{10}\left(\frac{P_s}{P_n}\right)\]`,
  ].join("\n");
  const plans = planFormulaRendering(source);
  assert.equal(plans.filter((plan) => plan.kind === "image").length, 2);
  assert.equal(
    plans.filter((plan) => plan.kind === "text").some((plan) => /\\(?:mathrm|frac|log)/.test(plan.content)),
    false,
  );
});

test("formula-dense responses are grouped into a small number of mixed images", () => {
  const source = Array.from({ length: 14 }, (_, index) => [
    `${index + 1}. Formula ${index + 1}`,
    String.raw`\[\frac{P_s}{P_n}+\sum_{i=1}^{n}x_i\]`,
  ].join("\n")).join("\n\n");
  const plans = planDenseFormulaRendering(source, {
    maxGroupChars: 4000,
    maxGroupFormulas: 20,
  });
  assert.equal(plans.filter((plan) => plan.kind === "image").length, 1);
  assert.equal(plans[0].mode, "mixed");
  assert.equal(plans[0].formulas.length, 14);
});

test("dense mixed rendering includes paired numeric formulas instead of drawing dollar delimiters", () => {
  const source = [
    "三个圆的半径都是 $1$，圆心距离都是 $2$。",
    "",
    String.raw`\[\frac{P_s}{P_n}+\sum_{i=1}^{n}x_i\]`,
  ].join("\n");
  const plans = planDenseFormulaRendering(source);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].kind, "image");
  assert.deepEqual(plans[0].formulas.map((formula) => formula.latex), ["1", "2", String.raw`\frac{P_s}{P_n}+\sum_{i=1}^{n}x_i`]);
});

test("very large formula sets stay bounded without dropping formulas", () => {
  const source = Array.from({ length: 100 }, (_, index) => [
    `${index + 1}. Formula ${index + 1}`,
    String.raw`\[\frac{P_s}{P_n}+\sum_{i=1}^{n}x_i\]`,
  ].join("\n")).join("\n\n");
  const plans = planDenseFormulaRendering(source, {
    maxGroupChars: 4000,
    maxGroupFormulas: 20,
  });
  const images = plans.filter((plan) => plan.kind === "image");
  assert.equal(images.length, 5);
  assert.equal(images.every((plan) => plan.formulas.length <= 20), true);
  assert.equal(images.reduce((total, plan) => total + plan.formulas.length, 0), 100);
});

test("dense planning preserves fenced code as native text", () => {
  const source = [
    String.raw`\[\frac{a}{b}\]`,
    "",
    "```js",
    "const price = '$25';",
    String.raw`const latex = '\\frac{a}{b}';`,
    "```",
    "",
    String.raw`\[\sum_{i=1}^{n}x_i\]`,
  ].join("\n");
  const plans = planDenseFormulaRendering(source);
  assert.equal(plans.filter((plan) => plan.kind === "image").length, 2);
  const native = plans.filter((plan) => plan.kind === "text").map((plan) => plan.content).join("");
  assert.match(native, /const price/);
  assert.match(native, /const latex/);
});

test("renderer fallback never exposes raw LaTeX when image upload is unavailable", async () => {
  const service = createFormulaImageService({ uploadImage: null });
  const result = await service.enrichBlocks([{
    kind: "text",
    content: [
      String.raw`SNR is \(\mathrm{SNR}=P_s/P_n\).`,
      "",
      String.raw`\[\frac{E_b}{N_0}=\mathrm{SNR}\frac{B}{R_b}\]`,
    ].join("\n"),
  }]);
  const visibleText = result.blocks.map((block) => block.content || "").join("");
  assert.equal(/\\(?:mathrm|frac)/.test(visibleText), false);
  assert.match(visibleText, /暂时无法渲染/);
  assert.equal(result.sources.length, 2);
  assert.equal(result.stats.failed, 2);
});

test("lark client uploads images with stdin JSON and a cwd-relative file argument", async (t) => {
  const calls = [];
  const client = createLarkClient({
    larkCli: { command: "lark-cli", argsPrefix: ["--profile", "bot"] },
    runTool: async (tool, args, options) => {
      calls.push({ tool, args, options });
      return { code: 0, stdout: JSON.stringify({ data: { image_key: "img_test" } }), stderr: "" };
    },
    delay: async () => {},
    splitText: (text) => [text],
    idempotencyKey: () => "key",
  });

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "formula-upload-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const imagePath = path.join(directory, "formula.png");
  fs.writeFileSync(imagePath, "png");
  assert.equal(await client.uploadImage(imagePath), "img_test");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(-8), [
    "--as", "bot", "--data", "-", "--file", "image=formula.png", "--format", "json",
  ]);
  assert.equal(calls[0].options.cwd, path.dirname(imagePath));
  assert.equal(calls[0].options.stdin, JSON.stringify({ image_type: "message" }));
});
