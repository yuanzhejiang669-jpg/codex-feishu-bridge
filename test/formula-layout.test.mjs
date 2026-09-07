import assert from "node:assert/strict";
import test from "node:test";
import katex from "katex";
import MarkdownIt from "markdown-it";
import { chromium } from "playwright-core";
import {
  formulaCaptureHtml, prepareFormulaCapture, createFormulaMarkdownRenderer,
  resolveFormulaBrowserExecutable, createFormulaImageService,
} from "../src/feishu/cards/formula-renderer.mjs";

const executablePath = resolveFormulaBrowserExecutable();
const markdown = createFormulaMarkdownRenderer(MarkdownIt);
const html = (content, mode = "mixed") => formulaCaptureHtml({
  content, mode, formulas: [{ latex: content }],
}, katex, markdown);

test("formula layout adversarial browser regressions", { skip: !executablePath }, async (t) => {
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ deviceScaleFactor: 2 });

  await t.test("KaTeX overlap classes never acquire card borders or padding", async () => {
    await page.setContent(html(String.raw`向量 $\mathbf v$，$(2,3)\neq(3,2)$，$x\notin A$，$\not\subseteq$，$\frac{a}{b}$。`));
    await prepareFormulaCapture(page);
    const styles = await page.locator(".katex .inner").evaluateAll((nodes) => nodes.map((e) => {
      const s = getComputedStyle(e);
      return { padding: s.padding, border: s.borderLeftWidth, width: e.getBoundingClientRect().width };
    }));
    assert.ok(styles.length > 0, "fixture must exercise KaTeX internal .inner");
    for (const style of styles) {
      assert.equal(style.padding, "0px");
      assert.equal(style.border, "0px");
      assert.ok(style.width < 100);
    }
    assert.equal(await page.locator(".cf-formula-card").count(), 1);
  });

  await t.test("short formulas stay compact; matrices and tables fit; huge formulas fail closed", async () => {
    await page.setContent(html(String.raw`\mathbf v=(2,3)`, "block"));
    const short = await prepareFormulaCapture(page);
    assert.equal(short.width, 640);
    assert.ok(short.height < 160);
    await page.setContent(html(String.raw`| 名称 | 矩阵 | 推导 | 条件 |
|---|---|---|---|
| 条件分布 | $\begin{bmatrix}A&B\\B^\top&C\end{bmatrix}$ | $S=C-B^\top A^{-1}B$ | $A\succ0$，$S\neq C$ |
| 积分 | $\int_0^\infty e^{-x}\,dx$ | $\sum_{i=1}^n\frac{x_i}{n}$ | 中文说明自动换行，不侵入公式。 |`));
    const table = await prepareFormulaCapture(page);
    assert.equal(table.width, 1100);
    const crossed = await page.locator("td .base").evaluateAll((nodes) => nodes.some((e) => {
      const a=e.getBoundingClientRect(), b=e.closest("td").getBoundingClientRect();
      return a.left < b.left || a.right > b.right;
    }));
    assert.equal(crossed, false);
    await page.setContent(html(String.raw`\underbrace{` + "x".repeat(250) + String.raw`}_{\text{too wide}}`, "block"));
    await assert.rejects(prepareFormulaCapture(page), /safe image width/);
  });

  await t.test("bad fonts and invalid LaTeX cannot be reported as render success", async () => {
    await page.setContent(html(String.raw`\frac{1}{2}`, "block"));
    await page.addStyleTag({ content: "@font-face{font-family:BrokenFormula;src:url(data:font/woff2;base64,AAAA)} .katex *{font-family:BrokenFormula!important}" });
    await assert.rejects(prepareFormulaCapture(page), /font failed/);
    assert.throws(() => html(String.raw`\invalidFormulaCommand`, "block"), /Undefined control sequence/);
    let uploads = 0;
    const service = createFormulaImageService({ uploadImage: async () => { uploads++; return "must-not-upload"; } });
    const result = await service.enrichBlocks([{kind:"text",content:String.raw`\[\invalidFormulaCommand\]`}]);
    assert.equal(uploads, 0);
    assert.equal(result.stats.failed, 1);
    assert.deepEqual(result.sources, [String.raw`\invalidFormulaCommand`]);
  });
});
