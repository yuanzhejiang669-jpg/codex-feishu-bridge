import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  createFormulaImageService,
  isComplexLatex,
  planFormulaRendering,
  scanLatexFormulas,
  simplifyInlineLatex,
  simplifySimpleFormulasInMarkdown,
} from "../src/feishu/cards/formula-renderer.mjs";

test("v0.10.26 (#1): digit-prefixed inline math ($0, ..., $1 + 2 = 3$, $1, 0, -1 \\xrightarrow{...}$) is no longer misclassified as currency, while real prices stay intact", () => {
  const realMessage = [
    "一格一格变给你看：",
    String.raw`- **第 1 行**：原来的 $1,\ 0,\ -1 \xrightarrow{\text{全变号}} -1,\ 0,\ 1 \xrightarrow{\text{第1格在对角线上, 加 }\lambda} \mathbf{\lambda - 1},\ 0,\ 1$`,
    String.raw`- **第 2 行**：原来的 $2,\ 1,\ 0 \xrightarrow{\text{全变号}} -2,\ -1,\ 0 \xrightarrow{\text{第2格在对角线上, 加 }\lambda} -2,\ \mathbf{\lambda - 1},\ 0$`,
    String.raw`- **第 3 行**：原来的 $0,\ 0,\ 3 \xrightarrow{\text{全变号}} 0,\ 0,\ -3 \xrightarrow{\text{第3格在对角线上, 加 }\lambda} 0,\ 0,\ \mathbf{\lambda - 3}$`,
    "",
    String.raw`一眼看到**第 3 行是 $0,\ 0,\ \lambda-3$**，**3 个特征值就是：$1,\ 1,\ 3$**，且 $1 + 2 = 3$、$2 \times 2$、$0 \le x \le 1$，纯元组 $1, 1, 3$。`,
    "",
    "价格对照：单价 $25，区间 $25-$30，昨天 $10 今天 $20，满 $100 送 $x^2$，特价 $10，详见$x^2$。",
  ].join("\n");

  const plans = planFormulaRendering(realMessage);
  const imagePlans = plans.filter((p) => p.kind === "image");
  assert.equal(imagePlans.length, 1, "Complex \\xrightarrow bullet paragraph must be planned as KaTeX image");
  assert.equal(imagePlans[0].formulas.length, 3);

  const textOutput = plans.filter((p) => p.kind === "text").map((p) => p.content).join("\n");
  assert.match(textOutput, /\*\*第 3 行是 0, 0, λ-3\*\*/);
  assert.match(textOutput, /\*\*3 个特征值就是：1, 1, 3\*\*/);
  assert.match(textOutput, /1 \+ 2 = 3/);
  assert.match(textOutput, /2 × 2/);
  assert.match(textOutput, /0 ≤ x ≤ 1/);
  assert.match(textOutput, /纯元组 1, 1, 3/);
  assert.doesNotMatch(textOutput, /\\ |\\lambda|\\times|\\le/);
  assert.match(textOutput, /单价 \$25，区间 \$25-\$30，昨天 \$10 今天 \$20，满 \$100 送 x²，特价 \$10，详见x²。/);
});

test("v0.10.26 (#2): simple-only math replies simplify synchronously via simplifyBlocks & enrichBlocks without launching Playwright", async () => {
  let launched = false;
  const service = createFormulaImageService({
    enabled: true,
    uploadImage: async () => {
      launched = true;
      return "img_should_not_run";
    },
  });

  const blocks = [{
    kind: "text",
    content: String.raw`深层区域诊断（红区 $\Delta E$、范数 $\|x\|_2$、共轭转置 $A^H$ 与 $A^\top$、克罗内克积 $I_2 \otimes A$）。`,
  }];

  assert.equal(service.hasPlannedFormulas(blocks), false);
  const syncSimplified = service.simplifyBlocks(blocks);
  assert.match(syncSimplified[0].content, /红区 Δ E/);
  assert.match(syncSimplified[0].content, /范数 ‖x‖₂/);
  assert.match(syncSimplified[0].content, /共轭转置 Aᴴ 与 Aᵀ/);
  assert.match(syncSimplified[0].content, /克罗内克积 I₂ ⊗ A/);
  assert.doesNotMatch(syncSimplified[0].content, /\$|\\/);

  const enriched = await service.enrichBlocks(blocks);
  assert.equal(launched, false);
  assert.equal(enriched.stats.planned, 0);
  assert.equal(enriched.blocks[0].content, syncSimplified[0].content);

  const disabled = createFormulaImageService({ enabled: false });
  assert.equal(disabled.simplifyBlocks(blocks)[0].content, blocks[0].content);
});

test("v0.10.26 (#3, #4, #7): TeX spaces, norms, set braces, Matrix Theory operators simplify cleanly and unconvertible scripts escalate to KaTeX without leaking backslashes", () => {
  assert.equal(simplifyInlineLatex(String.raw`0,\ 0,\ \lambda-3`), "0, 0, λ-3");
  assert.equal(simplifyInlineLatex(String.raw`1,\, 2\; 3\: 4\!`), "1, 2 3 4");
  assert.equal(simplifyInlineLatex(String.raw`\|x\|_2`), "‖x‖₂");
  assert.equal(simplifyInlineLatex(String.raw`\{\lambda_1, \lambda_2\}`), "{λ₁, λ₂}");
  assert.equal(simplifyInlineLatex(String.raw`A^H A = I_n`), "Aᴴ A = Iₙ");
  assert.equal(simplifyInlineLatex(String.raw`A^\top + B^*`), "Aᵀ + B∗");
  assert.equal(simplifyInlineLatex(String.raw`I_2 \otimes A \Rightarrow \lambda \in \emptyset`), "I₂ ⊗ A ⇒ λ ∈ ∅");
  assert.equal(simplifyInlineLatex(String.raw`x\_1 = 0`), "x_1 = 0");

  // Unconvertible scripts like Frobenius norm `\|A\|_F`, `J_A`, or `\\` must escalate to complex KaTeX instead of leaking raw `_` or `\`
  assert.equal(isComplexLatex(String.raw`\|A\|_F`), true);
  assert.equal(isComplexLatex(String.raw`J_A`), true);
  assert.equal(isComplexLatex(String.raw`a \\ b`), true);
  assert.equal(simplifyInlineLatex(String.raw`\|A\|_F`), null);
});

test("v0.10.26 (#5): JS/shell template variables like ${provider.baseUrl} are not misparsed as LaTeX formulas", () => {
  const text = "请求地址为 ${provider.baseUrl}/models\\Bearer $，环境变量 ${HOME}/bin 与公式 $\\lambda_1 = 1$ 共存。";
  const formulas = scanLatexFormulas(text);
  assert.equal(formulas.length, 1);
  assert.equal(formulas[0].latex, String.raw`\lambda_1 = 1`);
  const simplified = simplifySimpleFormulasInMarkdown(text);
  assert.match(simplified, /\$\{provider\.baseUrl\}\/models\\Bearer \$/);
  assert.match(simplified, /公式 λ₁ = 1 共存/);
});

test("v0.10.26 (#6): bridge wires synchronous simplifyBlocks, fallback simplification, and expanded formula render budgets", () => {
  const bridgeSrc = fs.readFileSync(new URL("../codex-feishu-bridge.mjs", import.meta.url), "utf8");
  assert.match(bridgeSrc, /formulaImageService\.simplifyBlocks\(state\.blocks\)/);
  assert.match(bridgeSrc, /simplifySimpleFormulasInMarkdown\(formatted\)/);
  assert.match(bridgeSrc, /CODEX_FEISHU_FORMULA_MAX_IMAGES \|\| "(?:16|24)"/);
  assert.match(bridgeSrc, /CODEX_FEISHU_FORMULA_RENDER_TIMEOUT_MS, (?:45_000|60_000)/);
});
