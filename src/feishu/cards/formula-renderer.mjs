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
  maxImages = 8,
  maxParagraphChars = 1400,
  renderTimeoutMs = 20_000,
  log = () => {},
} = {}) {
  const resolvedBrowser = resolveFormulaBrowserExecutable(browserExecutable);

  async function enrichBlocks(blocks) {
    if (!enabled || !resolvedBrowser || typeof uploadImage !== "function") {
      return {
        blocks,
        sources: [],
        stats: { enabled: Boolean(enabled), browser: Boolean(resolvedBrowser), planned: 0, rendered: 0, failed: 0 },
      };
    }

    const blockPlans = [];
    let plannedCount = 0;
    for (const block of blocks) {
      if (block?.kind !== "text" || !String(block.content || "").trim()) {
        blockPlans.push([{ ...block }]);
        continue;
      }
      const plans = planFormulaRendering(block.content, { maxParagraphChars });
      plannedCount += plans.filter((plan) => plan.kind === "image").length;
      blockPlans.push(plans);
    }
    if (plannedCount === 0) {
      return { blocks, sources: [], stats: { enabled: true, browser: true, planned: 0, rendered: 0, failed: 0 } };
    }

    await fs.promises.mkdir(tempDir, { recursive: true });
    let browser;
    const output = [];
    const sources = [];
    let rendered = 0;
    let failed = 0;
    const deadline = Date.now() + Math.max(2_000, Number(renderTimeoutMs || 20_000));
    try {
      const { katex, chromium } = await loadFormulaDependencies();
      browser = await chromium.launch({
        executablePath: resolvedBrowser,
        headless: true,
        args: ["--disable-gpu", "--hide-scrollbars"],
        timeout: renderTimeoutMs,
      });
      const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
      page.setDefaultTimeout(renderTimeoutMs);

      for (const plans of blockPlans) {
        for (const plan of plans) {
          if (plan.kind !== "image") {
            pushOutputBlock(output, plan);
            continue;
          }
          if (rendered >= Math.max(1, Number(maxImages || 1))) {
            pushOutputBlock(output, { kind: "text", content: plan.original });
            continue;
          }
          const remainingMs = deadline - Date.now();
          if (remainingMs < 1_000) {
            failed += 1;
            pushOutputBlock(output, { kind: "text", content: plan.original });
            log("WARN", "formula rendering deadline reached; preserving remaining markdown", {
              planned: plannedCount,
              rendered,
              failed,
            });
            continue;
          }
          const fileName = `formula-${process.pid}-${Date.now()}-${crypto.randomUUID()}.png`;
          const imagePath = path.join(tempDir, fileName);
          try {
            const html = formulaCaptureHtml(plan, katex);
            await page.setContent(html, { waitUntil: "load", timeout: Math.max(1_000, deadline - Date.now()) });
            await page.locator(".capture").screenshot({
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
            pushOutputBlock(output, { kind: "text", content: plan.original });
            log("WARN", "formula rendering failed; preserving original markdown", {
              mode: plan.mode,
              error: String(error?.message || error).slice(0, 1000),
            });
          } finally {
            await fs.promises.rm(imagePath, { force: true }).catch(() => {});
          }
        }
      }
    } catch (error) {
      log("WARN", "formula renderer unavailable; preserving original markdown", {
        browser: resolvedBrowser,
        error: String(error?.message || error).slice(0, 1000),
      });
      return {
        blocks,
        sources: [],
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
  };
}

function formulaOpenerAt(text, index) {
  if (text.startsWith("$$", index) && !isEscaped(text, index)) return { open: "$$", close: "$$", display: true };
  if (text.startsWith("\\[", index) && !isEscaped(text, index)) return { open: "\\[", close: "\\]", display: true };
  if (text.startsWith("\\(", index) && !isEscaped(text, index)) return { open: "\\(", close: "\\)", display: false };
  if (text[index] === "$" && !isEscaped(text, index)) return { open: "$", close: "$", display: false };
  return null;
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
  if (!display && /^\d+(?:[.,]\d+)?$/.test(body.trim())) return false;
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
      pushTextPlan(plans, simplifyFormulaRange(paragraph.slice(cursor, formula.start)));
      plans.push({
        kind: "image",
        mode: "block",
        original: formula.raw,
        content: formula.raw,
        formulas: [formula],
      });
      cursor = formula.end;
    }
    pushTextPlan(plans, simplifyFormulaRange(paragraph.slice(cursor)));
    return plans;
  }
  const complex = formulas.filter((formula) => isComplexLatex(formula.latex));
  if (complex.length > 0 && paragraph.length <= maxParagraphChars) {
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

function formulaCaptureHtml(plan, katex) {
  const body = plan.mode === "block"
    ? katex.renderToString(plan.formulas[0].latex, { displayMode: true, throwOnError: false, strict: "ignore" })
    : renderParagraphHtml(plan.content, katex);
  const css = embeddedKatexCss();
  const compact = plan.mode === "block";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
${css}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:transparent}
body{font-family:"Microsoft YaHei","PingFang SC","Segoe UI",sans-serif;color:#1f2329}
.capture{width:1200px;padding:${compact ? "28px 42px" : "30px 44px"};background:#f5f8ff}
.inner{width:1112px;padding:${compact ? "34px 40px" : "28px 34px"};background:#fff;border:1px solid #d9e2ff;border-left:7px solid #4e83fd;border-radius:18px;font-size:${compact ? "28px" : "29px"};line-height:${compact ? "1.5" : "1.9"}}
.block{display:flex;align-items:center;justify-content:center;min-height:150px}
.paragraph{white-space:normal;overflow-wrap:anywhere}
.paragraph strong{font-weight:700}
.katex{font-size:1.02em}
.katex-display{margin:0}
</style>
</head>
<body><div class="capture"><div class="inner ${compact ? "block" : "paragraph"}">${body}</div></div></body>
</html>`;
}

function renderParagraphHtml(content, katex) {
  const formulas = scanLatexFormulas(content);
  let html = "";
  let cursor = 0;
  for (const formula of formulas) {
    html += basicMarkdownHtml(content.slice(cursor, formula.start));
    html += katex.renderToString(formula.latex, {
      displayMode: false,
      throwOnError: false,
      strict: "ignore",
    });
    cursor = formula.end;
  }
  html += basicMarkdownHtml(content.slice(cursor));
  return html;
}

function basicMarkdownHtml(text) {
  return escapeHtml(text)
    .replace(/\*\*([^*\r\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\r?\n/g, "<br>");
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
    ]).then(([katexModule, playwright]) => ({
      katex: katexModule.default || katexModule,
      chromium: playwright.chromium,
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
