import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createFormulaImageService,
  resolveFormulaBrowserExecutable,
} from "../src/feishu/cards/formula-renderer.mjs";

const browserExecutable = resolveFormulaBrowserExecutable(process.env.CODEX_FEISHU_FORMULA_BROWSER_BIN || "");
if (!browserExecutable) {
  process.stdout.write(`${JSON.stringify({ ok: true, skipped: true, reason: "browser-unavailable" })}\n`);
  process.exit(0);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-formula-smoke-"));
const uploads = [];
try {
  const service = createFormulaImageService({
    browserExecutable,
    tempDir,
    uploadImage: async (imagePath) => {
      const bytes = fs.readFileSync(imagePath);
      assert.ok(bytes.length > 1000);
      assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      const width = bytes.readUInt32BE(16);
      const height = bytes.readUInt32BE(20);
      assert.equal(width, 1200);
      assert.ok(height > 100 && height < 12_000);
      uploads.push({ bytes: bytes.length, file: path.basename(imagePath), width, height });
      return `img_smoke_${uploads.length}`;
    },
  });
  const result = await service.enrichBlocks([
    {
      kind: "text",
      content: [
        "普通正文中的数字公式 $1$ 与简单公式 $x^2+y^2=1$ 保持文字。",
        "",
        "复杂行内公式 \\(p(\\theta\\mid D)=\\frac{p(D\\mid\\theta)p(\\theta)}{p(D)}\\) 应渲染所在段落。",
        "",
        "\\[\\sum_{i=1}^{n}\\lVert x_i-\\mu\\rVert_2^2\\]",
      ].join("\n"),
      streaming: false,
    },
    {
      kind: "text",
      content: Array.from({ length: 14 }, (_, index) => [
        `${index + 1}. 通信公式${index === 0 ? "，归一化系数为 $1$" : ""}`,
        "\\[\\mathrm{SNR}_{\\mathrm{dB}}=10\\log_{10}\\left(\\frac{P_s}{P_n}\\right)\\]",
      ].join("\n")).join("\n\n"),
      streaming: false,
    },
  ]);
  assert.equal(result.stats.rendered, 3);
  assert.equal(result.stats.failed, 0);
  assert.equal(uploads.length, 3);
  assert.equal(result.blocks.filter((block) => block.kind === "formula_image").length, 3);
  assert.equal(result.sources.includes("1"), true);
  assert.match(result.blocks.find((block) => block.kind === "text")?.content || "", /x²\+y²=1/);
  assert.match(result.blocks.find((block) => block.kind === "text")?.content || "", /数字公式 1/);
  assert.doesNotMatch(result.blocks.find((block) => block.kind === "text")?.content || "", /\$1\$/);
  assert.equal(fs.readdirSync(tempDir).filter((name) => name.endsWith(".png")).length, 0);

  const cappedService = createFormulaImageService({
    browserExecutable,
    tempDir,
    maxImages: 1,
    uploadImage: async () => "img_capped",
  });
  const capped = await cappedService.enrichBlocks([{
    kind: "text",
    content: [
      "\\[\\frac{P_s}{P_n}\\]",
      "",
      "\\[\\sum_{i=1}^{n}x_i\\]",
    ].join("\n"),
  }]);
  assert.equal(capped.stats.rendered, 1);
  assert.equal(capped.stats.failed, 1);
  assert.equal(capped.sources.length, 2);
  assert.equal(/\\(?:frac|sum)/.test(capped.blocks.map((block) => block.content || "").join("")), false);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    browserExecutable,
    uploads,
    stats: result.stats,
  })}\n`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
