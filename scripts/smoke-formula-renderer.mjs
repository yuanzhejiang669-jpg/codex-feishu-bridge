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
      uploads.push({ bytes: bytes.length, file: path.basename(imagePath) });
      return `img_smoke_${uploads.length}`;
    },
  });
  const result = await service.enrichBlocks([{
    kind: "text",
    content: [
      "普通正文中的简单公式 $x^2+y^2=1$ 保持文字。",
      "",
      "复杂行内公式 \\(p(\\theta\\mid D)=\\frac{p(D\\mid\\theta)p(\\theta)}{p(D)}\\) 应渲染所在段落。",
      "",
      "\\[\\sum_{i=1}^{n}\\lVert x_i-\\mu\\rVert_2^2\\]",
    ].join("\n"),
    streaming: false,
  }]);
  assert.equal(result.stats.rendered, 2);
  assert.equal(result.stats.failed, 0);
  assert.equal(uploads.length, 2);
  assert.equal(result.blocks.filter((block) => block.kind === "formula_image").length, 2);
  assert.match(result.blocks.find((block) => block.kind === "text")?.content || "", /x²\+y²=1/);
  assert.equal(fs.readdirSync(tempDir).filter((name) => name.endsWith(".png")).length, 0);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    browserExecutable,
    uploads,
    stats: result.stats,
  })}\n`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
