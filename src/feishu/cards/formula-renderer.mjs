import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const SIMPLE_COMMANDS = new Set([
  "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "theta", "lambda",
  "mu", "nu", "pi", "rho", "sigma", "tau", "phi", "varphi", "chi", "psi", "omega",
  "Gamma", "Delta", "Theta", "Lambda", "Pi", "Sigma", "Phi", "Psi", "Omega",
  "cdot", "times", "pm", "mp", "le", "leq", "ge", "geq", "ne", "neq", "approx",
  "in", "notin", "subset", "subseteq", "supset", "supseteq", "to", "rightarrow",
  "leftarrow", "infty", "partial", "nabla", "ell", "hbar", "mid", "Vert", "vert",
  "left", "right",
]);
const COMPLEX_COMMAND_PATTERN = /\\(?:frac|dfrac|tfrac|sqrt|sum|prod|int|iint|iiint|oint|begin|end|matrix|pmatrix|bmatrix|cases|aligned|substack|operatorname|overset|underset|underbrace|overbrace|lim|mathbb|mathcal|boldsymbol|text)\b/;
const SUPERSCRIPTS = { 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹", "+": "⁺", "-": "⁻", n: "ⁿ", i: "ⁱ", T: "ᵀ" };
const SUBSCRIPTS = { 0: "₀", 1: "₁", 2: "₂", 3: "₃", 4: "₄", 5: "₅", 6: "₆", 7: "₇", 8: "₈", 9: "₉", "+": "₊", "-": "₋", i: "ᵢ", j: "ⱼ", k: "ₖ", n: "ₙ", x: "ₓ" };
const COMMAND_REPLACEMENTS = new Map([
  ["alpha", "α"], ["beta", "β"], ["gamma", "γ"], ["delta", "δ"], ["epsilon", "ε"],
  ["varepsilon", "ε"], ["theta", "θ"], ["lambda", "λ"], ["mu", "μ"], ["nu", "ν"],
  ["pi", "π"], ["rho", "ρ"], ["sigma", "σ"], ["tau", "τ"], ["phi", "φ"],
  ["varphi", "φ"], ["chi", "χ"], ["psi", "ψ"], ["omega", "ω"], ["Gamma", "Γ"],
  ["Delta", "Δ"], ["Theta", "Θ"], ["Lambda", "Λ"], ["Pi", "Π"], ["Sigma", "Σ"],
  ["Phi", "Φ"], ["Psi", "Ψ"], ["Omega", "Ω"], ["cdot", "·"], ["times", "×"],
  ["pm", "±"], ["mp", "∓"], ["le", "≤"], ["leq", "≤"], ["ge", "≥"], ["geq", "≥"],
  ["ne", "≠"], ["neq", "≠"], ["approx", "≈"], ["in", "∈"], ["notin", "∉"],
  ["subset", "⊂"], ["subseteq", "⊆"], ["supset", "⊃"], ["supseteq", "⊇"],
  ["to", "→"], ["rightarrow", "→"], ["leftarrow", "←"], ["infty", "∞"],
  ["partial", "∂"], ["nabla", "∇"], ["ell", "ℓ"], ["hbar", "ℏ"], ["mid", "|"],
  ["Vert", "‖"], ["vert", "|"], ["left", ""], ["right", ""],
]);

export function scanLatexFormulas(input) {
  const text = String(input || "");
  const protectedRanges = inlineCodeRanges(text);
  const formulas = [];
  let index = 0;
  while (index < text.length) {
    const protectedRange = protectedRanges.find((range) => index >= range.start && index < range.end);
    if (protectedRange) {
      index = protectedRange.end;
      continue;
    }
    const opener = formulaOpenerAt(text, index);
    if (!opener) {
      index += 1;
      continue;
    }
    const closeAt = findFormulaClose(text, index + opener.open.length, opener.close);
    if (closeAt < 0) {
      index += opener.open.length;
      continue;
    }
    const latex = text.slice(index + opener.open.length, closeAt);
    const end = closeAt + opener.close.length;
    if (validFormulaCandidate(text, index, end, latex, opener.display)) {
      formulas.push({
        start: index,
        end,
        raw: text.slice(index, end),
        latex,
        display: opener.display,
      });
      index = end;
      continue;
    }
    index += opener.open.length;
  }
  return formulas;
}

export function isComplexLatex(latex) {
  const value = String(latex || "").trim();
  if (!value) return false;
  if (COMPLEX_COMMAND_PATTERN.test(value)) return true;
  if (value.length > 48) return true;
  if ((value.match(/[{}]/g) || []).length >= 6) return true;
  if (/\^\s*\{[^}]{2,}\}|_\s*\{[^}]{2,}\}/.test(value)) return true;
  const commands = [...value.matchAll(/\\([A-Za-z]+)/g)].map((match) => match[1]);
  return commands.some((command) => !SIMPLE_COMMANDS.has(command));
}

export function simplifyInlineLatex(latex) {
  let value = String(latex || "").trim();
  if (!value || isComplexLatex(value)) return null;
  value = value.replace(/\\([A-Za-z]+)/g, (match, command) => COMMAND_REPLACEMENTS.get(command) ?? match);
  if (/\\[A-Za-z]+/.test(value)) return null;
  value = value
    .replace(/\\([{}_$%&#])/g, "$1")
    .replace(/\\left|\\right/g, "")
    .replace(/\s+/g, " ")
    .trim();
  value = value.replace(/\^(\{([^{}]+)\}|([0-9+\-niT]))/g, (match, _group, braced, single) => {
    const source = braced ?? single;
    const converted = [...source].map((char) => SUPERSCRIPTS[char] || "").join("");
    return converted.length === source.length ? converted : match;
  });
  value = value.replace(/_(\{([^{}]+)\}|([0-9+\-ijknx]))/g, (match, _group, braced, single) => {
    const source = braced ?? single;
    const converted = [...source].map((char) => SUBSCRIPTS[char] || "").join("");
    return converted.length === source.length ? converted : match;
  });
  value = value.replace(/[{}]/g, "");
  return value;
}

export function planFormulaRendering(markdownText, {
  maxParagraphChars = 1400,
} = {}) {
  const chunks = splitProtectedMarkdown(markdownText);
  const planned = [];
  for (const chunk of chunks) {
    if (chunk.protected) {
      pushTextPlan(planned, chunk.content);
      continue;
    }
    const paragraphs = chunk.content.split(/(\r?\n\s*\r?\n+)/);
    for (const paragraph of paragraphs) {
      if (!paragraph) continue;
      if (/^\r?\n\s*\r?\n+$/.test(paragraph)) {
        pushTextPlan(planned, paragraph);
        continue;
      }
      planned.push(...planParagraph(paragraph, { maxParagraphChars }));
    }
  }
  return planned;
}

export function planDenseFormulaRendering(markdownText, {
  maxGroupChars = 4000,
  maxGroupFormulas = 20,
} = {}) {
  const planned = [];
  for (const chunk of splitProtectedMarkdown(markdownText)) {
    if (chunk.protected) {
      pushTextPlan(planned, chunk.content);
      continue;
    }
    const units = chunk.content.split(/(\r?\n\s*\r?\n+)/).filter(Boolean);
    let content = "";
    let formulas = [];
    const flush = () => {
      if (!content) return;
      if (formulas.length > 0) {
        planned.push({
          kind: "image",
          mode: "mixed",
          original: content,
          content,
          formulas,
        });
      } else {
        pushTextPlan(planned, content);
      }
      content = "";
      formulas = [];
    };
    for (const unit of units) {
      const unitFormulas = scanLatexFormulas(unit);
      const exceedsChars = content && content.length + unit.length > Math.max(500, Number(maxGroupChars || 4000));
      const exceedsFormulas = formulas.length > 0
        && formulas.length + unitFormulas.length > Math.max(1, Number(maxGroupFormulas || 20));
      if (exceedsChars || exceedsFormulas) flush();
      content += unit;
      formulas.push(...unitFormulas);
    }
    flush();
  }
  return planned;
}

export function resolveFormulaBrowserExecutable(explicitPath = "") {
  const configured = String(explicitPath || "").trim();
  if (configured && fs.existsSync(configured)) return configured;
  const candidates = process.platform === "win32"
    ? [
      path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    ]
    : process.platform === "darwin"
      ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      ]
      : [
        "/usr/bin/google-chrome",
        "/usr/bin/microsoft-edge",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
      ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || "";
}

export function createFormulaImageService({
  enabled = true,
  browserExecutable = "",
  tempDir = path.join(os.tmpdir(), "codex-feishu-formulas"),
  uploadImage,
  maxImages = 24,
  maxParagraphChars = 1400,
  denseFormulaThreshold = 6,
  maxGroupChars = 4000,
  maxGroupFormulas = 20,
  renderTimeoutMs = 20_000,
  log = () => {},
} = {}) {
  const resolvedBrowser = resolveFormulaBrowserExecutable(browserExecutable);
  let warmupPromise;

  function warmup() {
    if (!enabled || !resolvedBrowser) {
      return Promise.resolve({ enabled, browser: Boolean(resolvedBrowser), warmed: false });
    }
    if (!warmupPromise) {
      warmupPromise = (async () => {
        const startedAt = Date.now();
        const { chromium } = await loadFormulaDependencies();
        const browser = await chromium.launch({
          executablePath: resolvedBrowser,
          headless: true,
          args: ["--disable-gpu", "--hide-scrollbars"],
          timeout: Math.max(30_000, Number(renderTimeoutMs || 20_000) * 6),
        });
        try {
          const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
          await page.setContent("<!doctype html><meta charset=\"utf-8\"><div>ready</div>", { waitUntil: "load" });
        } finally {
          await browser.close().catch(() => {});
        }
        return { enabled: true, browser: true, warmed: true, durationMs: Date.now() - startedAt };
      })().catch((error) => {
        warmupPromise = undefined;
        throw error;
      });
    }
    return warmupPromise;
  }

  async function enrichBlocks(blocks) {
    if (!enabled) {
      return {
        blocks,
        sources: [],
        stats: { enabled: false, browser: Boolean(resolvedBrowser), planned: 0, rendered: 0, failed: 0 },
      };
    }

    const blockPlans = [];
    let plannedCount = 0;
    for (const block of blocks) {
      if (block?.kind !== "text" || !String(block.content || "").trim()) {
        blockPlans.push([{ ...block }]);
        continue;
      }
      const normalPlans = planFormulaRendering(block.content, { maxParagraphChars });
      const normalImageCount = normalPlans.filter((plan) => plan.kind === "image").length;
      const plans = normalImageCount > Math.max(1, Number(denseFormulaThreshold || 6))
        ? planDenseFormulaRendering(block.content, { maxGroupChars, maxGroupFormulas })
        : normalPlans;
      plannedCount += plans.filter((plan) => plan.kind === "image").length;
      blockPlans.push(plans);
    }
    if (plannedCount === 0) {
      return { blocks, sources: [], stats: { enabled: true, browser: true, planned: 0, rendered: 0, failed: 0 } };
    }
    if (!resolvedBrowser || typeof uploadImage !== "function") {
      const fallback = fallbackFormulaPlans(blockPlans);
      return {
        blocks: fallback.blocks,
        sources: fallback.sources,
        stats: {
          enabled: true,
          browser: Boolean(resolvedBrowser),
          planned: plannedCount,
          rendered: 0,
          failed: plannedCount,
        },
      };
    }

    await fs.promises.mkdir(tempDir, { recursive: true });
    let browser;
    const output = [];
    const sources = [];
    let rendered = 0;
    let failed = 0;
    try {
      await warmup();
      const { katex, chromium, markdown } = await loadFormulaDependencies();
      const deadline = Date.now() + Math.max(2_000, Number(renderTimeoutMs || 20_000));
      browser = await chromium.launch({
        executablePath: resolvedBrowser,
        headless: true,
        args: ["--disable-gpu", "--hide-scrollbars"],
        timeout: renderTimeoutMs,
      });
      const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
      page.setDefaultTimeout(renderTimeoutMs);

      for (const plans of blockPlans) {
        for (const plan of plans) {
          if (plan.kind !== "image") {
            pushOutputBlock(output, plan);
            continue;
          }
          if (rendered >= Math.max(1, Number(maxImages || 1))) {
            failed += 1;
            sources.push(...formulaSources(plan));
            pushOutputBlock(output, { kind: "text", content: formulaFallbackText(plan) });
            continue;
          }
          const remainingMs = deadline - Date.now();
          if (remainingMs < 1_000) {
            failed += 1;
            sources.push(...formulaSources(plan));
            pushOutputBlock(output, { kind: "text", content: formulaFallbackText(plan) });
            log("WARN", "formula rendering deadline reached; using readable fallback", {
              planned: plannedCount,
              rendered,
              failed,
            });
            continue;
          }
          const fileName = `formula-${process.pid}-${Date.now()}-${crypto.randomUUID()}.png`;
          const imagePath = path.join(tempDir, fileName);
          try {
            const html = formulaCaptureHtml(plan, katex, markdown);
            await page.setContent(html, { waitUntil: "load", timeout: Math.max(1_000, deadline - Date.now()) });
            await prepareFormulaCapture(page, { timeoutMs: Math.max(1_000, deadline - Date.now()) });
            await page.locator(".cf-formula-capture").screenshot({
              path: imagePath,
              type: "png",
              timeout: Math.max(1_000, deadline - Date.now()),
            });
            const imageKey = await uploadImage(imagePath, {
              timeoutMs: Math.max(1_000, deadline - Date.now()),
              attempts: 1,
            });
            if (!imageKey) throw new Error("Feishu image upload returned no image_key");
            output.push({
              kind: "formula_image",
              imgKey: imageKey,
              alt: plan.mode === "block" ? "复杂数学公式" : "包含复杂行内公式的正文段落",
              title: plan.mode === "block" ? "公式" : "公式密集段落",
              source: plan.formulas.map((item) => item.latex.trim()).filter(Boolean).join("\n\n"),
            });
            sources.push(...plan.formulas.map((item) => item.latex.trim()).filter(Boolean));
            rendered += 1;
          } catch (error) {
            failed += 1;
            sources.push(...formulaSources(plan));
            pushOutputBlock(output, { kind: "text", content: formulaFallbackText(plan) });
            log("WARN", "formula rendering failed; using readable fallback", {
              mode: plan.mode,
              error: String(error?.message || error).slice(0, 1000),
            });
          } finally {
            await fs.promises.rm(imagePath, { force: true }).catch(() => {});
          }
        }
      }
    } catch (error) {
      log("WARN", "formula renderer unavailable; using readable fallback", {
        browser: resolvedBrowser,
        error: String(error?.message || error).slice(0, 1000),
      });
      const fallback = fallbackFormulaPlans(blockPlans);
      return {
        blocks: fallback.blocks,
        sources: fallback.sources,
        stats: { enabled: true, browser: true, planned: plannedCount, rendered: 0, failed: plannedCount },
      };
    } finally {
      await browser?.close().catch(() => {});
    }

    return {
      blocks: output,
      sources: [...new Set(sources)],
      stats: { enabled: true, browser: true, planned: plannedCount, rendered, failed },
    };
  }

  return {
    browserExecutable: resolvedBrowser,
    enrichBlocks,
    warmup,
  };
}

function formulaOpenerAt(text, index) {
  if (text.startsWith("$$", index) && !isEscaped(text, index)) return { open: "$$", close: "$$", display: true };
  if (text.startsWith("\\[", index) && !isEscaped(text, index)) return { open: "\\[", close: "\\]", display: true };
  if (text.startsWith("\\(", index) && !isEscaped(text, index)) return { open: "\\(", close: "\\)", display: false };
  if (text[index] === "$" && !isEscaped(text, index) && !currencyDollarAt(text, index)) {
    return { open: "$", close: "$", display: false };
  }
  return null;
}

function currencyDollarAt(text, index) {
  const tail = text.slice(index + 1);
  if (/^\d+(?:[.,]\d+)?\s*[-–—]\s*\$\d+(?:[.,]\d+)?/.test(tail)) return true;
  const amount = tail.match(/^\d+(?:[.,]\d+)?/);
  if (!amount) return false;
  const following = tail[amount[0].length] || "";
  if (following === "$") return false;
  return !following || /[\s,.;:!?，。；：！？、]/.test(following);
}

function findFormulaClose(text, start, close) {
  for (let index = start; index <= text.length - close.length; index += 1) {
    if (text.startsWith(close, index) && !isEscaped(text, index)) return index;
  }
  return -1;
}

function isEscaped(text, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function inlineCodeRanges(text) {
  const ranges = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "`" || isEscaped(text, index)) {
      index += 1;
      continue;
    }
    let runLength = 1;
    while (text[index + runLength] === "`") runLength += 1;
    const marker = "`".repeat(runLength);
    const closeAt = text.indexOf(marker, index + runLength);
    if (closeAt < 0) {
      index += runLength;
      continue;
    }
    ranges.push({ start: index, end: closeAt + runLength });
    index = closeAt + runLength;
  }
  return ranges;
}

function validFormulaCandidate(text, start, end, latex, display) {
  const body = String(latex || "");
  if (!body.trim()) return false;
  if (!display && /[\r\n]/.test(body)) return false;
  if (!display && (/^\s|\s$/.test(body))) return false;
  if (!display && /\s/.test(body) && !/[\\^_={}|<>+\-*/]/.test(body)) return false;
  const previous = text[start - 1] || "";
  const next = text[end] || "";
  if (!display && /\d/.test(previous) && /\d/.test(body[0] || "")) return false;
  if (!display && /\d/.test(body.at(-1) || "") && /\d/.test(next)) return false;
  return true;
}

function splitProtectedMarkdown(text) {
  const lines = String(text || "").split(/(?<=\n)/);
  const chunks = [];
  let protectedMode = false;
  let buffer = "";
  const flush = () => {
    if (buffer) chunks.push({ protected: protectedMode, content: buffer });
    buffer = "";
  };
  for (const line of lines) {
    const fence = /^\s*(```|~~~)/.test(line);
    if (fence && !protectedMode) {
      flush();
      protectedMode = true;
      buffer = line;
      continue;
    }
    buffer += line;
    if (fence && protectedMode) {
      flush();
      protectedMode = false;
    }
  }
  flush();
  return chunks;
}

function planParagraph(paragraph, { maxParagraphChars }) {
  const formulas = scanLatexFormulas(paragraph);
  if (formulas.length === 0) return [{ kind: "text", content: paragraph }];
  const blockFormulas = formulas.filter((formula) => formula.display);
  if (blockFormulas.length > 0) {
    const plans = [];
    let cursor = 0;
    for (const formula of formulas) {
      if (!formula.display) continue;
      plans.push(...planInlineFormulaRange(paragraph.slice(cursor, formula.start), { maxParagraphChars }));
      plans.push({
        kind: "image",
        mode: "block",
        original: formula.raw,
        content: formula.raw,
        formulas: [formula],
      });
      cursor = formula.end;
    }
    plans.push(...planInlineFormulaRange(paragraph.slice(cursor), { maxParagraphChars }));
    return plans;
  }
  const complex = formulas.filter((formula) => isComplexLatex(formula.latex));
  if (complex.length > 0) {
    return [{
      kind: "image",
      mode: "inline-paragraph",
      original: paragraph,
      content: paragraph,
      formulas,
    }];
  }
  return [{ kind: "text", content: simplifyFormulaRange(paragraph) }];
}

function planInlineFormulaRange(content, { maxParagraphChars }) {
  if (!content) return [];
  const formulas = scanLatexFormulas(content);
  if (formulas.length === 0) return [{ kind: "text", content }];
  const complex = formulas.some((formula) => isComplexLatex(formula.latex));
  if (complex) {
    return [{
      kind: "image",
      mode: content.length > maxParagraphChars ? "mixed" : "inline-paragraph",
      original: content,
      content,
      formulas,
    }];
  }
  return [{ kind: "text", content: simplifyFormulaRange(content) }];
}

function simplifyFormulaRange(text) {
  const formulas = scanLatexFormulas(text);
  if (formulas.length === 0) return text;
  let output = "";
  let cursor = 0;
  for (const formula of formulas) {
    output += text.slice(cursor, formula.start);
    output += simplifyInlineLatex(formula.latex) ?? formula.raw;
    cursor = formula.end;
  }
  output += text.slice(cursor);
  return output;
}

function pushTextPlan(plans, content) {
  if (!content) return;
  const last = plans[plans.length - 1];
  if (last?.kind === "text") last.content += content;
  else plans.push({ kind: "text", content });
}

function pushOutputBlock(output, plan) {
  if (plan?.kind === "tool" || plan?.kind === "formula_image") {
    output.push(plan);
    return;
  }
  const content = String(plan?.content || "");
  if (!content) return;
  const last = output[output.length - 1];
  if (last?.kind === "text") last.content += content;
  else output.push({ kind: "text", content, streaming: false });
}

export function formulaCaptureHtml(plan, katex, markdown) {
  const body = plan.mode === "block"
    ? katex.renderToString(plan.formulas[0].latex, { displayMode: true, throwOnError: true, strict: "ignore" })
    : renderMixedHtml(plan.content, katex, markdown);
  const css = embeddedKatexCss();
  const compact = plan.mode === "block";
  const width = compact ? 640 : containsMarkdownTable(plan.content) ? 1100 : 800;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
${css}
html,body{margin:0;padding:0;background:transparent}
body{font-family:"Microsoft YaHei","PingFang SC","Segoe UI",sans-serif;color:#1f2329}
.cf-formula-capture{box-sizing:border-box;width:${width}px;padding:16px;background:#f5f8ff}
.cf-formula-card{box-sizing:border-box;width:100%;padding:${compact ? "16px 24px" : "24px"};background:#fff;border:1px solid #d9e2ff;border-left:5px solid #4e83fd;border-radius:14px;font-size:${compact ? "28px" : "23px"};line-height:1.8}
.cf-formula-block{display:flex;align-items:center;justify-content:center}
.cf-formula-paragraph{white-space:normal;overflow-wrap:anywhere}
.cf-formula-paragraph strong{font-weight:700}
.cf-formula-paragraph h1,.cf-formula-paragraph h2,.cf-formula-paragraph h3{margin:.35em 0 .25em;font-weight:700;line-height:1.35}
.cf-formula-paragraph h1{font-size:1.28em}.cf-formula-paragraph h2{font-size:1.18em}.cf-formula-paragraph h3{font-size:1.1em}
.cf-formula-paragraph table{width:100%;margin:8px 0;border-collapse:collapse;table-layout:auto;font-size:.9em;line-height:1.55}
.cf-formula-paragraph th,.cf-formula-paragraph td{padding:12px 14px;border:1px solid #c8d3e8;text-align:left;vertical-align:top;overflow-wrap:anywhere}
.cf-formula-paragraph th{background:#eef3ff;font-weight:700}
.cf-formula-paragraph tr:nth-child(even) td{background:#fafcff}
  .cf-display-formula{display:flex;align-items:center;justify-content:center;margin:12px 0;padding:16px 8px 24px;background:#f8faff;border-radius:12px;overflow:visible}
  .katex{font-size:1.02em}
  .katex-display{margin:0;padding:.15em .2em .45em}
</style>
</head>
<body><div class="cf-formula-capture"><div class="cf-formula-card ${compact ? "cf-formula-block" : "cf-formula-paragraph"}">${body}</div></div></body>
</html>`;
}

// Reject unusable images rather than uploading a successful but clipped PNG.
export async function prepareFormulaCapture(page, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // Force layout first so fonts used by the formula are requested.
    await page.locator(".cf-formula-capture").boundingBox();
    await page.waitForFunction(() => document.fonts.status === "loaded", null, {
      timeout: Math.max(1, deadline - Date.now()),
    });
    const result = await page.evaluate(() => {
      if (document.querySelector(".katex-error")) throw new Error("Formula parse error");
      if ([...document.fonts].some((font) => font.status === "error")) {
        throw new Error("Formula font failed to load");
      }
      const capture = document.querySelector(".cf-formula-capture");
      const box = capture.getBoundingClientRect();
      const elements = [...document.querySelectorAll(".katex-html .base, table")];
      const overflow = elements.some((element) => {
        const owner = element.closest("td,th,.cf-display-formula,.cf-formula-card");
        const parent = owner.getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        return rect.left < parent.left - 1 || rect.right > parent.right + 1;
      });
      return { width: box.width, height: box.height, overflow };
    });
    if (result.height > 6000) throw new Error("Formula image exceeds safe height");
    if (!result.overflow) return result;
    if (result.width >= 1600 || Date.now() >= deadline) break;
    await page.locator(".cf-formula-capture").evaluate((element, width) => {
      element.style.width = `${width}px`;
    }, Math.min(1600, Math.ceil(result.width * 1.35)));
  }
  throw new Error("Formula exceeds safe image width; retaining source instead");
}

export function renderMixedHtml(content, katex, markdown) {
  const formulas = scanLatexFormulas(content);
  const markerPrefix = formulaMarkerPrefix(content);
  const renderedFormulas = [];
  let protectedMarkdown = "";
  let cursor = 0;
  for (const [index, formula] of formulas.entries()) {
    protectedMarkdown += content.slice(cursor, formula.start);
    const rendered = katex.renderToString(formula.latex, {
      displayMode: formula.display,
      throwOnError: true,
      strict: "ignore",
    });
    renderedFormulas.push(formula.display ? `<span class="cf-display-formula">${rendered}</span>` : rendered);
    protectedMarkdown += `${markerPrefix}${index}END`;
    cursor = formula.end;
  }
  protectedMarkdown += content.slice(cursor);

  let html = containsMarkdownTable(protectedMarkdown) && markdown
    ? markdown.render(protectedMarkdown)
    : basicMarkdownHtml(protectedMarkdown);
  for (const [index, rendered] of renderedFormulas.entries()) {
    html = html.split(`${markerPrefix}${index}END`).join(rendered);
  }
  return html;
}

export function createFormulaMarkdownRenderer(MarkdownIt) {
  const markdown = new MarkdownIt({
    breaks: true,
    html: false,
    linkify: false,
    typographer: false,
  });
  markdown.renderer.rules.image = (tokens, index) => escapeHtml(tokens[index]?.content || "");
  markdown.renderer.rules.link_open = () => "";
  markdown.renderer.rules.link_close = () => "";
  return markdown;
}

function formulaMarkerPrefix(content) {
  let prefix = "CODEXFORMULATOKEN";
  while (String(content || "").includes(prefix)) prefix += "X";
  return prefix;
}

function containsMarkdownTable(text) {
  const lines = String(text || "").split(/\r?\n/);
  for (let index = 1; index < lines.length; index += 1) {
    if (!lines[index - 1].includes("|")) continue;
    const delimiter = lines[index].trim().replace(/^\|/, "").replace(/\|$/, "");
    const cells = delimiter.split("|").map((cell) => cell.trim());
    if (cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))) return true;
  }
  return false;
}

function basicMarkdownHtml(text) {
  return escapeHtml(text)
    .replace(/^###\s+(.+)$/gm, "<h3>$1</h3>")
    .replace(/^##\s+(.+)$/gm, "<h2>$1</h2>")
    .replace(/^#\s+(.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*([^*\r\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\r?\n/g, "<br>");
}

function formulaSources(plan) {
  return (plan?.formulas || []).map((item) => String(item?.latex || "").trim()).filter(Boolean);
}

function formulaFallbackText(plan) {
  const label = plan?.mode === "block" ? "独立公式" : "含公式段落";
  return `\n\n【${label}暂时无法渲染；LaTeX 源码已保存在下方“公式源码”中】\n\n`;
}

function fallbackFormulaPlans(blockPlans) {
  const blocks = [];
  const sources = [];
  for (const plans of blockPlans) {
    for (const plan of plans) {
      if (plan.kind === "image") {
        sources.push(...formulaSources(plan));
        pushOutputBlock(blocks, { kind: "text", content: formulaFallbackText(plan) });
      } else {
        pushOutputBlock(blocks, plan);
      }
    }
  }
  return { blocks, sources: [...new Set(sources)] };
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

let cachedKatexCss = "";
let formulaDependencyPromise;
function loadFormulaDependencies() {
  if (!formulaDependencyPromise) {
    formulaDependencyPromise = Promise.all([
      import("katex"),
      import("playwright-core"),
      import("markdown-it"),
    ]).then(([katexModule, playwright, markdownModule]) => ({
      katex: katexModule.default || katexModule,
      chromium: playwright.chromium,
      markdown: createFormulaMarkdownRenderer(markdownModule.default || markdownModule),
    }));
  }
  return formulaDependencyPromise;
}

function embeddedKatexCss() {
  if (cachedKatexCss) return cachedKatexCss;
  const cssPath = require.resolve("katex/dist/katex.min.css");
  const fontDir = path.join(path.dirname(cssPath), "fonts");
  let css = fs.readFileSync(cssPath, "utf8");
  css = css.replace(/url\((?:['"]?)(fonts\/[^)'"]+)(?:['"]?)\)/g, (_match, relative) => {
    const fontPath = path.join(path.dirname(cssPath), relative);
    try {
      const extension = path.extname(fontPath).toLowerCase();
      const mime = extension === ".woff2" ? "font/woff2" : extension === ".woff" ? "font/woff" : "application/octet-stream";
      return `url(data:${mime};base64,${fs.readFileSync(fontPath).toString("base64")})`;
    } catch {
      return `url(${pathToFileURL(path.join(fontDir, path.basename(relative))).href})`;
    }
  });
  cachedKatexCss = css;
  return css;
}
