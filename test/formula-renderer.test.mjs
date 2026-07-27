import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isComplexLatex,
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

test("oversized formula paragraphs stay as original markdown instead of producing extreme images", () => {
  const formula = "\\(p(x)=\\frac{1}{\\sqrt{2\\pi}}e^{-x^2/2}\\)";
  const source = `${"很长的正文。".repeat(250)}${formula}`;
  const plans = planFormulaRendering(source, { maxParagraphChars: 1400 });
  assert.equal(plans.some((plan) => plan.kind === "image"), false);
  assert.equal(plans.map((plan) => plan.content || "").join(""), source);
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
