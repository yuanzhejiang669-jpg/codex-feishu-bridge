import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import katex from "katex";
import MarkdownIt from "markdown-it";

import {
  createFormulaImageService,
  createFormulaMarkdownRenderer,
  planDenseFormulaRendering,
  renderMixedHtml,
  resolveFormulaBrowserExecutable,
  splitFormulaPlan,
} from "../src/feishu/cards/formula-renderer.mjs";

const executablePath = resolveFormulaBrowserExecutable();

function readPngDimensions(filePath) {
  const buf = fs.readFileSync(filePath);
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

test("v0.10.27: dense formula planner keeps leading prose and section headings native instead of swallowing them into giant images", () => {
  const source = [
    "明白！下面讲 **母题 1（[2020年.pdf](file:///C:/Users/a/Desktop/矩阵论/2020年.pdf)）**。",
    "",
    "---",
    "",
    "### 第 1 站：特征值",
    "",
    String.raw`$$A = \begin{bmatrix} 2 & -1 & -1 \\ 2 & -1 & -2 \\ -1 & 1 & 2 \end{bmatrix}$$`,
    "",
    "---",
    "",
    "### 第 2 站：特征向量",
    "",
    String.raw`$$(A - I)x = \begin{bmatrix} 1 & -1 & -1 \\ 2 & -2 & -2 \\ -1 & 1 & 1 \end{bmatrix}x = 0$$`,
  ].join("\n");

  const plans = planDenseFormulaRendering(source);
  const texts = plans.filter((p) => p.kind === "text").map((p) => p.content).join("\n");
  const images = plans.filter((p) => p.kind === "image");

  assert.equal(images.length, 2);
  assert.match(texts, /母题 1/);
  assert.match(texts, /### 第 1 站：特征值/);
  assert.match(texts, /### 第 2 站：特征向量/);
  assert.doesNotMatch(images[0].content, /明白！/);
  assert.doesNotMatch(images[1].content, /### 第 2 站/);
});

test("v0.10.27: splitFormulaPlan splits tall multi-matrix blocks safely without breaking tables or multi-line display math", () => {
  const tallPlan = {
    kind: "image",
    mode: "mixed",
    content: [
      "1. 第一步说明：",
      "$$",
      String.raw`A = \begin{bmatrix} 2 & -1 \\ 1 & 3 \end{bmatrix}`,
      "$$",
      "2. 第二步说明：",
      "$$",
      String.raw`B = \begin{bmatrix} 1 & 0 \\ 0 & 4 \end{bmatrix}`,
      "$$",
      "| 列1 | 列2 |",
      "|---|---|",
      "| 值1 | 值2 |",
    ].join("\n"),
    formulas: [
      { latex: String.raw`A = \begin{bmatrix} 2 & -1 \\ 1 & 3 \end{bmatrix}`, display: true },
      { latex: String.raw`B = \begin{bmatrix} 1 & 0 \\ 0 & 4 \end{bmatrix}`, display: true },
    ],
  };

  const parts = splitFormulaPlan(tallPlan);
  assert.ok(Array.isArray(parts) && parts.length === 2);
  for (const part of parts) {
    const raw = part.content;
    const dollarPairs = (raw.match(/\$\$/g) || []).length;
    assert.equal(dollarPairs % 2, 0, "Multi-line $$ block must never be split in half");
  }
  const combined = parts.map((p) => p.content).join("\n");
  assert.match(combined, /\| 列1 \| 列2 \|\n\|---\|---\|\n\| 值1 \| 值2 \|/);
});

test("v0.10.27: renderMixedHtml strips local file:/// link syntax to clean readable labels without leaving URLs or anchors", () => {
  const markdown = createFormulaMarkdownRenderer(MarkdownIt);
  const source = [
    "母题 1（[2020年.pdf](file:///C:/Users/a/Desktop/矩阵论/02-历年真题/2020年.pdf)）与行内代码 `[raw](file:///C:/keep.pdf)` 和公式 $\\frac{a}{b}$。",
  ].join("\n");

  const html = renderMixedHtml(source, katex, markdown);
  assert.match(html, /2020年\.pdf/);
  assert.doesNotMatch(html, /file:\/\/\/C:\/Users\/a\/Desktop/);
  assert.doesNotMatch(html, /<a\b/);
  assert.match(html, /\[raw\]\(file:\/\/\/C:\/keep\.pdf\)/);
});

test("v0.10.27: medium formula replies (<= 12 formulas) stay in normal mode with native prose and crisp block cards", async () => {
  const uploaded = [];
  const service = createFormulaImageService({
    enabled: true,
    browserExecutable: "",
    uploadImage: null,
  });
  // Verify through planFormulaRendering / enrichBlocks fallback counts (no dense collapse at 10 display formulas).
  const tenFormulas = Array.from({ length: 10 }, (_, i) => [
    `第 ${i + 1} 步纯文字说明：`,
    "",
    String.raw`$$M_${i + 1} = \begin{bmatrix} ${i + 1} & 0 \\ 0 & 1 \end{bmatrix}$$`,
  ].join("\n")).join("\n\n");

  const res = await service.enrichBlocks([{ kind: "text", content: tenFormulas }]);
  assert.equal(res.stats.planned, 10, "10 display formulas must stay in normal mode instead of collapsing into dense mode");
  assert.equal(uploaded.length, 0);
});

test("v0.10.27: browser height guard automatically splits ultra-tall dense math into crisp low-aspect-ratio PNGs", { skip: !executablePath }, async (t) => {
  const dims = [];
  const service = createFormulaImageService({
    enabled: true,
    maxImages: 24,
    renderTimeoutMs: 60_000,
    uploadImage: async (imagePath) => {
      dims.push(readPngDimensions(imagePath));
      return `img_${dims.length}`;
    },
  });
  t.after(() => service.close());

  const megaReply = [
    "开场纯文字介绍（[2020年.pdf](file:///C:/Users/a/Desktop/矩阵论/2020年.pdf)）。",
    "",
    "---",
    "",
    "### 第 1 站：特征值与矩阵推导",
    "",
    ...Array.from({ length: 14 }, (_, idx) => [
      `${idx + 1}. **第 ${idx + 1} 步操作**：按行变换直接化简，注意对角线减去 $\\lambda$：`,
      String.raw`$$|\lambda I - A_{${idx + 1}}| = \begin{vmatrix} \lambda - 2 & 1 & 1 \\ -2 & \lambda + 1 & 2 \\ 1 & -1 & \lambda - 2 \end{vmatrix} = (\lambda - 1)\begin{vmatrix} \lambda - 2 & 1 \\ -1 & \lambda \end{vmatrix} = (\lambda - 1)^3$$`,
    ].join("\n")),
  ].join("\n");

  const res = await service.enrichBlocks([{ kind: "text", content: megaReply }]);
  assert.equal(res.stats.failed, 0);
  assert.ok(dims.length >= 4 && dims.length <= 24, `Expected multiple crisp cards, got ${dims.length}`);

  for (const dim of dims) {
    const ratio = dim.height / dim.width;
    assert.ok(ratio <= 1.35, `Image ${dim.width}x${dim.height} has tall ratio ${ratio.toFixed(2)} (> 1.35), which Feishu card preview would blur`);
    assert.equal(dim.width, 1600, `Slightly wide equation should fit 800px CSS card (1600px @2x) instead of widening to ${dim.width}px`);
  }

  const nativeTexts = res.blocks.filter((b) => b.kind === "text").map((b) => b.content).join("\n");
  assert.match(nativeTexts, /开场纯文字介绍/);
  assert.match(nativeTexts, /### 第 1 站：特征值与矩阵推导/);
});
