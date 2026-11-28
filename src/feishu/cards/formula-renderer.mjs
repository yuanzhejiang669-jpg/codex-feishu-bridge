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
  "leftarrow", "leftrightarrow", "Rightarrow", "Leftarrow", "Leftrightarrow",
  "implies", "iff", "mapsto", "infty", "partial", "nabla", "ell", "hbar", "mid",
  "Vert", "vert", "left", "right", "big", "Big", "bigg", "Bigg", "bigl", "bigr",
  "Bigl", "Bigr", "quad", "qquad", "enspace", "thinspace",
  "otimes", "oplus", "odot", "circ", "ast", "star", "top", "perp", "parallel",
  "sim", "simeq", "cong", "equiv", "propto", "ll", "gg", "prec", "succ", "preceq",
  "succeq", "dots", "ldots", "cdots", "cup", "cap", "setminus", "emptyset",
  "varnothing", "forall", "exists", "neg", "lnot", "land", "wedge", "lor", "vee",
  "langle", "rangle", "lfloor", "rfloor", "lceil", "rceil", "angle", "triangle",
  "deg", "prime",
]);
const COMPLEX_COMMAND_PATTERN = /\\(?:frac|dfrac|tfrac|sqrt|sum|prod|int|iint|iiint|oint|begin|end|matrix|pmatrix|bmatrix|vmatrix|Vmatrix|cases|aligned|substack|operatorname|overset|underset|underbrace|overbrace|xrightarrow|xleftarrow|lim|mathbb|mathcal|mathbf|mathrm|mathit|mathsf|mathtt|boldsymbol|text|textrm|textbf|textit|overline|underline|widehat|widetilde|hat|bar|tilde|vec|dot|ddot)\b/;
const SUPERSCRIPTS = {
  0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹",
  "+": "⁺", "-": "⁻", "(": "⁽", ")": "⁾", "*": "∗", "⊤": "ᵀ", "′": "′",
  a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", i: "ⁱ", k: "ᵏ", m: "ᵐ", n: "ⁿ",
  p: "ᵖ", r: "ʳ", s: "ˢ", t: "ᵗ", x: "ˣ", y: "ʸ", z: "ᶻ", H: "ᴴ", T: "ᵀ",
};
const SUBSCRIPTS = {
  0: "₀", 1: "₁", 2: "₂", 3: "₃", 4: "₄", 5: "₅", 6: "₆", 7: "₇", 8: "₈", 9: "₉",
  "+": "₊", "-": "₋", "(": "₍", ")": "₎",
  a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ",
  o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ",
};
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
  ["to", "→"], ["rightarrow", "→"], ["leftarrow", "←"], ["leftrightarrow", "↔"],
  ["Rightarrow", "⇒"], ["Leftarrow", "⇐"], ["Leftrightarrow", "⇔"],
  ["implies", "⇒"], ["iff", "⇔"], ["mapsto", "↦"],
  ["infty", "∞"], ["partial", "∂"], ["nabla", "∇"], ["ell", "ℓ"], ["hbar", "ℏ"],
  ["mid", "|"], ["Vert", "‖"], ["vert", "|"], ["left", ""], ["right", ""],
  ["big", ""], ["Big", ""], ["bigg", ""], ["Bigg", ""], ["bigl", ""], ["bigr", ""],
  ["Bigl", ""], ["Bigr", ""], ["quad", "  "], ["qquad", "    "], ["enspace", " "],
  ["thinspace", " "], ["otimes", "⊗"], ["oplus", "⊕"], ["odot", "⊙"], ["circ", "∘"],
  ["ast", "∗"], ["star", "⋆"], ["top", "⊤"], ["perp", "⊥"], ["parallel", "∥"],
  ["sim", "∼"], ["simeq", "≃"], ["cong", "≅"], ["equiv", "≡"], ["propto", "∝"],
  ["ll", "≪"], ["gg", "≫"], ["prec", "≺"], ["succ", "≻"], ["preceq", "≼"],
  ["succeq", "≽"], ["dots", "…"], ["ldots", "…"], ["cdots", "…"], ["cup", "∪"],
  ["cap", "∩"], ["setminus", "∖"], ["emptyset", "∅"], ["varnothing", "∅"],
  ["forall", "∀"], ["exists", "∃"], ["neg", "¬"], ["lnot", "¬"], ["land", "∧"],
  ["wedge", "∧"], ["lor", "∨"], ["vee", "∨"], ["langle", "⟨"], ["rangle", "⟩"],
  ["lfloor", "⌊"], ["rfloor", "⌋"], ["lceil", "⌈"], ["rceil", "⌉"],
  ["angle", "∠"], ["triangle", "△"], ["deg", "°"], ["prime", "′"],
]);
const NUMERIC_TUPLE_PATTERN = /^-?\d+(?:\.\d+)?(?:\s*,\s*-?\d+(?:\.\d+)?)+$/;
const LITERAL_LBRACE = "\uE001";
const LITERAL_RBRACE = "\uE002";
const LITERAL_UNDERSCORE = "\uE003";

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

function convertSimpleScripts(value) {
  let out = value.replace(/\^\s*(?:\{([^{}]+)\}|([^\s{}^_]))/g, (match, braced, single) => {
    const source = braced ?? single;
    const converted = [...source].map((char) => SUPERSCRIPTS[char] || "").join("");
    return converted.length === source.length ? converted : match;
  });
  out = out.replace(/_\s*(?:\{([^{}]+)\}|([^\s{}^_]))/g, (match, braced, single) => {
    const source = braced ?? single;
    const converted = [...source].map((char) => SUBSCRIPTS[char] || "").join("");
    return converted.length === source.length ? converted : match;
  });
  return out;
}

function trySimplifySimpleLatex(latex) {
  let value = String(latex || "").trim();
  if (!value) return null;
  if (/\\\\/.test(value)) return null;
  value = value
    .replace(/\\\|/g, "‖")
    .replace(/\\\{/g, LITERAL_LBRACE)
    .replace(/\\\}/g, LITERAL_RBRACE)
    .replace(/\\_/g, LITERAL_UNDERSCORE)
    .replace(/\\([A-Za-z]+)/g, (match, command) => COMMAND_REPLACEMENTS.get(command) ?? match)
    .replace(/\\!/g, "")
    .replace(/\\[,;: ]/g, " ")
    .replace(/\\([$%&#])/g, "$1");
  if (/\\/.test(value)) return null;
  value = convertSimpleScripts(value);
  if (/[\^_]/.test(value)) return null;
  value = value
    .replace(/[{}]/g, "")
    .replaceAll(LITERAL_LBRACE, "{")
    .replaceAll(LITERAL_RBRACE, "}")
    .replaceAll(LITERAL_UNDERSCORE, "_")
    .replace(/\s+/g, " ")
    .trim();
  return value || null;
}

export function isComplexLatex(latex) {
  const value = String(latex || "").trim();
  if (!value) return false;
  if (COMPLEX_COMMAND_PATTERN.test(value)) return true;
  if (/\\\\/.test(value)) return true;
  if (value.length > 48) return true;
  if ((value.match(/[{}]/g) || []).length >= 6) return true;
  if (/\^\s*\{[^}]{2,}\}|_\s*\{[^}]{2,}\}/.test(value)) return true;
  const commands = [...value.matchAll(/\\([A-Za-z]+)/g)].map((match) => match[1]);
  if (commands.some((command) => !SIMPLE_COMMANDS.has(command))) return true;
  return trySimplifySimpleLatex(value) === null;
}

export function simplifyInlineLatex(latex) {
  const value = String(latex || "").trim();
  if (!value || isComplexLatex(value)) return null;
  return trySimplifySimpleLatex(value);
}

export function simplifySimpleFormulasInMarkdown(markdownText) {
  const chunks = splitProtectedMarkdown(markdownText);
  let out = "";
  for (const chunk of chunks) {
    if (chunk.protected) {
      out += chunk.content;
      continue;
    }
    const paragraphs = chunk.content.split(/(\r?\n\s*\r?\n+)/);
    for (const paragraph of paragraphs) {
      if (!paragraph || /^\r?\n\s*\r?\n+$/.test(paragraph)) {
        out += paragraph;
        continue;
      }
      const formulas = scanLatexFormulas(paragraph);
      if (!formulas.length) {
        out += paragraph;
        continue;
      }
      let cursor = 0;
      for (const formula of formulas) {
        out += paragraph.slice(cursor, formula.start);
        if (!formula.display) {
          const simplified = simplifyInlineLatex(formula.latex);
          out += simplified !== null ? simplified : formula.raw;
        } else {
          out += formula.raw;
        }
        cursor = formula.end;
      }
      out += paragraph.slice(cursor);
    }
  }
  return out;
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
  maxGroupChars = 900,
  maxGroupFormulas = 6,
} = {}) {
  const charLimit = Math.max(500, Number(maxGroupChars || 900));
  const formulaLimit = Math.max(1, Number(maxGroupFormulas || 6));
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
        const trimmed = content.trim();
        if (trimmed) {
          planned.push({
            kind: "image",
            mode: "mixed",
            original: trimmed,
            content: trimmed,
            formulas,
          });
        }
      } else {
        pushTextPlan(planned, content);
      }
      content = "";
      formulas = [];
    };
    for (const unit of units) {
      const isSeparator = /^\r?\n\s*\r?\n+$/.test(unit);
      if (isSeparator) {
        if (content) content += unit;
        else pushTextPlan(planned, unit);
        continue;
      }
      const unitFormulas = scanLatexFormulas(unit);
      if (unitFormulas.length === 0) {
        if (formulas.length === 0) {
          pushTextPlan(planned, unit);
          continue;
        }
        if (isSectionBoundaryUnit(unit)) {
          flush();
          pushTextPlan(planned, unit);
          continue;
        }
      }
      const exceedsChars = content && content.length + unit.length > charLimit;
      const exceedsFormulas = formulas.length > 0
        && formulas.length + unitFormulas.length > formulaLimit;
      if (exceedsChars || exceedsFormulas) flush();
      content += unit;
      formulas.push(...unitFormulas);
    }
    flush();
  }
  return planned;
}

function isSectionBoundaryUnit(unit) {
  const trimmed = String(unit || "").trim();
  if (!trimmed) return false;
  return /^(?:#{1,6}\s|[-*_]{3,}\s*$)/.test(trimmed);
}

export function splitFormulaPlan(plan) {
  if (!plan || plan.kind !== "image" || plan.mode === "block") return null;
  const source = String(plan.content || "").trim();
  if (!source) return null;
  const segments = tokenizeVerticalSegments(source);
  if (segments.length < 2) return null;

  const weights = segments.map((seg) => segmentVisualWeight(seg.text));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight <= 0) return null;

  const prefix = [];
  let running = 0;
  for (const w of weights) {
    running += w;
    prefix.push(running);
  }

  const pickSplitIndex = (maxTier, minRatio, maxRatio) => {
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let i = 1; i < segments.length; i += 1) {
      const tier = segments[i].breakTier;
      if (tier > maxTier) continue;
      const ratio = prefix[i - 1] / totalWeight;
      if (ratio < minRatio || ratio > maxRatio) continue;
      const distance = Math.abs(ratio - 0.5);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
    return bestIndex;
  };

  let splitIndex = pickSplitIndex(1, 0.2, 0.8);
  if (splitIndex < 0) splitIndex = pickSplitIndex(2, 0.15, 0.85);
  if (splitIndex < 0) splitIndex = pickSplitIndex(3, 0.15, 0.85);
  if (splitIndex < 0) return null;

  const leftText = segments.slice(0, splitIndex).map((s) => s.text).join("").trim();
  const rightText = segments.slice(splitIndex).map((s) => s.text).join("").trim();
  if (!leftText || !rightText) return null;

  const nextDepth = (plan.splitDepth || 0) + 1;
  return [
    classifySplitHalf(leftText, plan.mode, nextDepth),
    classifySplitHalf(rightText, plan.mode, nextDepth),
  ];
}

function classifySplitHalf(text, fallbackMode, splitDepth) {
  const formulas = scanLatexFormulas(text);
  if (formulas.length === 0) {
    return { kind: "text", content: text, splitText: true };
  }
  const hasDisplay = formulas.some((formula) => formula.display);
  const hasComplex = formulas.some((formula) => isComplexLatex(formula.latex));
  if (!hasDisplay && !hasComplex) {
    return { kind: "text", content: simplifyFormulaRange(text), splitText: true };
  }
  if (formulas.length === 1 && formulas[0].display && text.trim() === formulas[0].raw.trim()) {
    return {
      kind: "image",
      mode: "block",
      original: formulas[0].raw,
      content: formulas[0].raw,
      formulas,
      splitDepth,
    };
  }
  return {
    kind: "image",
    mode: fallbackMode,
    original: text,
    content: text,
    formulas,
    splitDepth,
  };
}

function segmentVisualWeight(text) {
  const formulas = scanLatexFormulas(text);
  const displayCount = formulas.filter((formula) => formula.display).length;
  return text.length + displayCount * 260;
}

function tokenizeVerticalSegments(content) {
  const lines = String(content || "").split(/(?<=\n)/);
  const segments = [];
  let i = 0;
  let pendingBlank = false;
  let prevEndedDisplay = false;

  const isTableDelimiter = (line) => {
    const trimmed = String(line || "").trim().replace(/^\|/, "").replace(/\|$/, "");
    if (!trimmed.includes("|") && !/^:?-{3,}:?$/.test(trimmed)) return false;
    const cells = trimmed.split("|").map((cell) => cell.trim());
    return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      if (segments.length > 0) segments[segments.length - 1].text += line;
      pendingBlank = true;
      i += 1;
      continue;
    }

    // Keep Markdown tables as indivisible atomic blocks.
    if (line.includes("|") && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      let block = line + lines[i + 1];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        block += lines[i];
        i += 1;
      }
      segments.push({ text: block, breakTier: pendingBlank ? 1 : 2 });
      pendingBlank = false;
      prevEndedDisplay = false;
      continue;
    }

    // Keep multi-line $$...$$ or \[...\] display math blocks indivisible.
    if ((trimmed.startsWith("$$") && !trimmed.slice(2).includes("$$"))
      || (trimmed.startsWith("\\[") && !trimmed.slice(2).includes("\\]"))) {
      const closeMarker = trimmed.startsWith("$$") ? "$$" : "\\]";
      let block = line;
      i += 1;
      while (i < lines.length) {
        block += lines[i];
        const foundClose = lines[i].includes(closeMarker);
        i += 1;
        if (foundClose) break;
      }
      segments.push({ text: block, breakTier: pendingBlank ? 1 : 2 });
      pendingBlank = false;
      prevEndedDisplay = true;
      continue;
    }

    const isSingleLineDisplay = (trimmed.startsWith("$$") && trimmed.endsWith("$$") && trimmed.length > 4)
      || (trimmed.startsWith("\\[") && trimmed.endsWith("\\]") && trimmed.length > 4);
    const isStructuralStart = /^(?:#{1,6}\s|[-*_]{3,}\s*$|\d+[.)]\s|[-*+]\s)/.test(line);
    const breakTier = pendingBlank ? 1 : (prevEndedDisplay || isStructuralStart ? 2 : 3);
    segments.push({ text: line, breakTier });
    pendingBlank = false;
    prevEndedDisplay = isSingleLineDisplay;
    i += 1;
  }

  return segments;
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
  denseFormulaThreshold = 12,
  maxGroupChars = 900,
  maxGroupFormulas = 6,
  maxImageHeight = 950,
  maxImageAspectRatio = 1.2,
  renderTimeoutMs = 20_000,
  idleCloseMs = 5 * 60_000,
  loadDeps = loadFormulaDependencies,
  log = () => {},
} = {}) {
  const resolvedBrowser = resolveFormulaBrowserExecutable(browserExecutable);
  let activeBrowser = null;
  let browserLaunchPromise = null;
  let idleTimer = null;
  let inUseCount = 0;

  function clearIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  async function close() {
    clearIdleTimer();
    const pending = browserLaunchPromise;
    browserLaunchPromise = null;
    const browser = activeBrowser;
    activeBrowser = null;
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (pending) {
      const launched = await pending.catch(() => null);
      if (launched && launched !== browser) {
        await launched.close().catch(() => {});
      }
    }
  }

  function scheduleIdleClose() {
    clearIdleTimer();
    if (!activeBrowser || inUseCount > 0) return;
    const delayMs = Math.max(10, Number(idleCloseMs) || 5 * 60_000);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (inUseCount === 0) void close();
    }, delayMs);
    idleTimer.unref?.();
  }

  async function ensureBrowser(chromium) {
    clearIdleTimer();
    if (activeBrowser && (typeof activeBrowser.isConnected !== "function" || activeBrowser.isConnected())) {
      return activeBrowser;
    }
    activeBrowser = null;
    if (!browserLaunchPromise) {
      browserLaunchPromise = chromium.launch({
        executablePath: resolvedBrowser,
        headless: true,
        args: ["--disable-gpu", "--hide-scrollbars"],
        timeout: Math.max(30_000, Number(renderTimeoutMs || 20_000) * 2),
      }).then((browser) => {
        activeBrowser = browser;
        browser.on?.("disconnected", () => {
          if (activeBrowser === browser) activeBrowser = null;
        });
        return browser;
      }).finally(() => {
        browserLaunchPromise = null;
      });
    }
    return browserLaunchPromise;
  }

  async function warmup() {
    if (!enabled || !resolvedBrowser) {
      return { enabled, browser: Boolean(resolvedBrowser), warmed: false };
    }
    const startedAt = Date.now();
    const { chromium } = await loadDeps();
    inUseCount += 1;
    try {
      const browser = await ensureBrowser(chromium);
      const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
      try {
        await page.setContent("<!doctype html><meta charset=\"utf-8\"><div>ready</div>", { waitUntil: "load" });
      } finally {
        await page.close().catch(() => {});
      }
      return { enabled: true, browser: true, warmed: true, durationMs: Date.now() - startedAt };
    } finally {
      inUseCount = Math.max(0, inUseCount - 1);
      scheduleIdleClose();
    }
  }

  function planDenseWithinBudget(content, imageBudget) {
    const budget = Math.max(1, Number(imageBudget || maxImages || 24));
    let chars = Math.max(500, Number(maxGroupChars || 900));
    let formulas = Math.max(1, Number(maxGroupFormulas || 6));
    let plans = planDenseFormulaRendering(content, { maxGroupChars: chars, maxGroupFormulas: formulas });
    for (let step = 0; step < 4; step += 1) {
      const imageCount = plans.filter((plan) => plan.kind === "image").length;
      if (imageCount <= budget) return plans;
      chars = Math.min(4000, Math.round(chars * 1.6));
      formulas = Math.min(24, Math.ceil(formulas * 1.6));
      plans = planDenseFormulaRendering(content, { maxGroupChars: chars, maxGroupFormulas: formulas });
    }
    return plans;
  }

  function planBlocks(blocks) {
    const blockPlans = [];
    let plannedCount = 0;
    const denseLimit = Math.max(1, Number(denseFormulaThreshold || 12));
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (block?.kind !== "text" || !String(block.content || "").trim()) {
        blockPlans.push([{ ...block }]);
        continue;
      }
      const normalPlans = planFormulaRendering(block.content, { maxParagraphChars });
      const normalImageCount = normalPlans.filter((plan) => plan.kind === "image").length;
      const plans = normalImageCount > denseLimit
        ? planDenseWithinBudget(block.content, Math.max(1, Number(maxImages || 24) - plannedCount))
        : normalPlans;
      plannedCount += plans.filter((plan) => plan.kind === "image").length;
      blockPlans.push(plans);
    }
    return { blockPlans, plannedCount };
  }

  function hasPlannedFormulas(blocks) {
    if (!enabled) return false;
    return planBlocks(blocks).plannedCount > 0;
  }

  function simplifyBlocks(blocks) {
    if (!enabled) return blocks;
    return (Array.isArray(blocks) ? blocks : []).map((block) => {
      if (block?.kind !== "text" || !String(block.content || "").trim()) return block;
      const simplified = simplifySimpleFormulasInMarkdown(block.content);
      return simplified === block.content ? block : { ...block, content: simplified };
    });
  }

  async function enrichBlocks(blocks) {
    if (!enabled) {
      return {
        blocks,
        sources: [],
        stats: { enabled: false, browser: Boolean(resolvedBrowser), planned: 0, rendered: 0, failed: 0 },
      };
    }

    let { blockPlans, plannedCount } = planBlocks(blocks);
    if (plannedCount === 0) {
      const simplifiedBlocks = [];
      for (const plans of blockPlans) {
        for (const plan of plans) pushOutputBlock(simplifiedBlocks, plan);
      }
      return {
        blocks: simplifiedBlocks,
        sources: [],
        stats: { enabled: true, browser: Boolean(resolvedBrowser), planned: 0, rendered: 0, failed: 0 },
      };
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
    let page = null;
    const output = [];
    const sources = [];
    let rendered = 0;
    let failed = 0;
    inUseCount += 1;
    try {
      const { katex, chromium, markdown } = await loadDeps();
      const browser = await ensureBrowser(chromium);
      // Start per-batch render deadline after cold browser launch so launch time never drops trailing formulas.
      const deadline = Date.now() + Math.max(2_000, Number(renderTimeoutMs || 45_000));
      page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
      page.setDefaultTimeout?.(renderTimeoutMs);

      const imageLimit = Math.max(1, Number(maxImages || 1));
      const heightBase = Math.max(400, Number(maxImageHeight || 950));
      const aspectCap = Math.max(0.8, Number(maxImageAspectRatio || 1.2));
      const queue = blockPlans.flat();
      let plannedTotal = plannedCount;

      while (queue.length > 0) {
        const plan = queue.shift();
        if (plan.kind !== "image") {
          pushOutputBlock(output, plan);
          continue;
        }
        if (rendered >= imageLimit) {
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
            planned: plannedTotal,
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
          const metrics = await prepareFormulaCapture(page, {
            timeoutMs: Math.max(1_000, deadline - Date.now()),
            maxHeight: Infinity,
          });
          const heightLimit = Math.max(heightBase, Math.round(metrics.width * aspectCap));
          const remainingImages = queue.filter((item) => item.kind === "image").length;
          const canSplitForSharpness = plan.mode !== "block"
            && metrics.height > heightLimit
            && (plan.splitDepth || 0) < 4
            && (deadline - Date.now()) > 3_000
            && (rendered + remainingImages + 2 <= imageLimit || metrics.height > 6000);
          if (canSplitForSharpness) {
            const parts = splitFormulaPlan(plan);
            if (parts) {
              const addedImages = parts.filter((part) => part.kind === "image").length - 1;
              plannedTotal = Math.max(1, plannedTotal + addedImages);
              queue.unshift(...parts);
              continue;
            }
          }
          if (metrics.height > 6000) {
            throw new Error("Formula image exceeds safe height");
          }
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
      plannedCount = plannedTotal;
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
      await page?.close?.().catch(() => {});
      inUseCount = Math.max(0, inUseCount - 1);
      scheduleIdleClose();
    }

    return {
      blocks: output,
      sources: [...new Set(sources)],
      stats: { enabled: true, browser: true, planned: plannedCount, rendered, failed },
    };
  }

  return {
    browserExecutable: resolvedBrowser,
    close,
    enrichBlocks,
    hasPlannedFormulas,
    simplifyBlocks,
    warmup,
    isBrowserActive: () => Boolean(activeBrowser),
  };
}

function formulaOpenerAt(text, index) {
  if (text.startsWith("$$", index) && !isEscaped(text, index)) return { open: "$$", close: "$$", display: true };
  if (text.startsWith("\\[", index) && !isEscaped(text, index)) return { open: "\\[", close: "\\]", display: true };
  if (text.startsWith("\\(", index) && !isEscaped(text, index)) return { open: "\\(", close: "\\)", display: false };
  if (text[index] === "$" && !isEscaped(text, index) && !templateDollarAt(text, index) && !currencyDollarAt(text, index)) {
    return { open: "$", close: "$", display: false };
  }
  return null;
}

function templateDollarAt(text, index) {
  if (text[index] !== "$") return false;
  const match = text.slice(index).match(/^\$\{([A-Za-z_][A-Za-z0-9_.:-]*)\}/);
  if (!match) return false;
  const name = match[1];
  const after = text[index + match[0].length] || "";
  if (/^[A-Za-z]$/.test(name) && (after === "^" || after === "_")) return false;
  return name.includes(".") || name.includes("_") || name.length >= 2 || after === "/";
}

function stripLatexTextCommands(latex) {
  let out = String(latex || "");
  for (let pass = 0; pass < 3; pass += 1) {
    const next = out.replace(/\\(?:text|textrm|textbf|textit|textsf|texttt|mathrm|mathbf|mathit|operatorname|mbox|hbox)\s*\{[^{}]*\}/g, "");
    if (next === out) break;
    out = next;
  }
  return out;
}

function currencyDollarAt(text, index) {
  const tail = text.slice(index + 1);
  if (/^\d+(?:[.,]\d+)?\s*[-–—]\s*\$\d+(?:[.,]\d+)?/.test(tail)) return true;
  const amount = tail.match(/^\d+(?:[.,]\d+)?/);
  if (!amount) return false;
  const following = tail[amount[0].length] || "";
  if (following === "$") return false;
  if (!following || /[\s,.;:!?，。；：！？、]/.test(following)) {
    const closeAt = findFormulaClose(text, index + 1, "$");
    if (closeAt < 0) return true;
    const body = text.slice(index + 1, closeAt);
    if (!body || /[\r\n]/.test(body) || /^\s|\s$/.test(body)) return true;
    const afterClose = text[closeAt + 1] || "";
    if (/\d/.test(afterClose)) return true;
    const outsideText = stripLatexTextCommands(body);
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(outsideText)) return true;
    const hasLatexOrOperator = /\\(?:[A-Za-z]+|[,;:! |{}])|[=<>+\-*/^_]/.test(outsideText);
    if (hasLatexOrOperator || NUMERIC_TUPLE_PATTERN.test(outsideText.trim())) return false;
    return true;
  }
  return false;
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

const MATH_SPACE_KEYWORDS = new Set([
  "sin", "cos", "tan", "cot", "sec", "csc",
  "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh",
  "log", "ln", "lg", "exp", "det", "tr", "rank", "dim",
  "ker", "im", "Im", "Re", "span", "diag", "min", "max",
  "sup", "inf", "arg", "mod", "gcd", "lcm", "adj", "sgn",
  "cov", "var", "Var", "Cov", "Corr", "Pr", "deg", "lim",
]);

function isValidSpaceMathExpression(outsideText) {
  const trimmed = String(outsideText || "").trim();
  if (!trimmed || trimmed.length > 64) return false;
  if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(trimmed)) return false;
  if (!/^[A-Za-z0-9()[\],.;:'!\s-]+$/.test(trimmed)) return false;
  const tokens = trimmed.match(/[A-Za-z0-9.]+/g);
  if (!tokens || tokens.length === 0) return false;
  if (!tokens.some((token) => /[A-Za-z0-9]/.test(token))) return false;
  return tokens.every((token) => (
    /^-?\d+(?:\.\d+)?$/.test(token)
    || /^[A-Za-z]\d*$/.test(token)
    || MATH_SPACE_KEYWORDS.has(token)
  ));
}

function validFormulaCandidate(text, start, end, latex, display) {
  const body = String(latex || "");
  if (!body.trim()) return false;
  if (!display && /[\r\n]/.test(body)) return false;
  if (!display && (/^\s|\s$/.test(body))) return false;
  if (!display) {
    const outsideText = stripLatexTextCommands(body);
    // Reject CJK prose or CJK punctuation outside \text{...} (blocks `$、$` parity desync and prose between prices).
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(outsideText)) return false;
    // Reject pure ASCII punctuation with no math symbols/identifiers.
    if (/^[,.;:!?'"`~\s]+$/.test(outsideText)) return false;
    if (
      /\s/.test(body)
      && !/[\\^_={}|<>+\-*/]/.test(body)
      && !NUMERIC_TUPLE_PATTERN.test(body.trim())
      && !isValidSpaceMathExpression(outsideText)
    ) {
      return false;
    }
  }
  const previous = text[start - 1] || "";
  const next = text[end] || "";
  if (!display && /\d/.test(previous) && /\d/.test(body[0] || "")) return false;
  if (!display && /\d/.test(body.at(-1) || "") && /\d/.test(next)) return false;
  return true;
}

function parseFenceStart(line) {
  const clean = String(line || "").replace(/[\r\n]+$/, "");
  const match = clean.match(/^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})(.*)$/);
  if (!match) return null;
  const marker = match[1];
  const info = match[2] || "";
  if (marker[0] === "`" && info.includes("`")) return null;
  return { char: marker[0], len: marker.length };
}

function isFenceEnd(line, fence) {
  const clean = String(line || "").replace(/[\r\n]+$/, "");
  const stripped = clean.replace(/^[ \t]*(?:>[ \t]*)*[ \t]*/, "").trimEnd();
  if (!stripped.startsWith(fence.char.repeat(fence.len))) return false;
  for (let i = 0; i < stripped.length; i += 1) {
    if (stripped[i] !== fence.char) return false;
  }
  return true;
}

function splitProtectedMarkdown(text) {
  const lines = String(text || "").split(/(?<=\n)/);
  const chunks = [];
  let activeFence = null;
  let buffer = "";
  const flush = () => {
    if (buffer) chunks.push({ protected: Boolean(activeFence), content: buffer });
    buffer = "";
  };
  for (const line of lines) {
    if (!activeFence) {
      const open = parseFenceStart(line);
      if (open) {
        flush();
        activeFence = open;
        buffer = line;
        continue;
      }
      buffer += line;
      continue;
    }
    buffer += line;
    if (isFenceEnd(line, activeFence)) {
      flush();
      activeFence = null;
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
  if (last?.kind === "text") {
    const needsBreak = plan?.splitText && !last.content.endsWith("\n") && !content.startsWith("\n");
    last.content += needsBreak ? `\n\n${content}` : content;
  } else {
    output.push({ kind: "text", content, streaming: false });
  }
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
.cf-formula-card{box-sizing:border-box;width:100%;padding:${compact ? "16px 24px" : "24px"};background:#fff;border:1px solid #d9e2ff;border-left:5px solid #4e83fd;border-radius:14px;font-size:${compact ? "28px" : "24px"};line-height:1.75}
.cf-formula-block{display:flex;align-items:center;justify-content:center}
.cf-formula-paragraph{white-space:normal;overflow-wrap:anywhere}
.cf-formula-paragraph p{margin:.25em 0}.cf-formula-paragraph p:first-child{margin-top:0}.cf-formula-paragraph p:last-child{margin-bottom:0}
.cf-formula-paragraph ul,.cf-formula-paragraph ol{margin:.3em 0;padding-left:1.35em}
.cf-formula-paragraph code{padding:1px 5px;border-radius:4px;background:#eef3ff;font-family:Consolas,monospace;font-size:.9em}
.cf-formula-paragraph pre{margin:.4em 0;padding:8px 10px;border-radius:6px;background:#f4f6fb;overflow-x:auto}
.cf-formula-paragraph blockquote{margin:.4em 0;padding:.2em .7em;border-left:3px solid #b8c7e8;color:#4e5969}
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
export async function prepareFormulaCapture(page, { timeoutMs = 20_000, maxHeight = 6000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // Force layout first so fonts used by the formula are requested.
    await page.locator(".cf-formula-capture").boundingBox();
    await page.waitForFunction(() => document.fonts.status === "loaded", null, {
      timeout: Math.max(1, deadline - Date.now()),
    });
    if (attempt === 0) {
      // Gently shrink slightly wide display equations inside mixed cards so one wide equation
      // doesn't widen the entire card and shrink all surrounding prose text.
      await page.evaluate(() => {
        for (const box of document.querySelectorAll(".cf-formula-paragraph .cf-display-formula")) {
          const katexNode = box.querySelector(".katex");
          if (!katexNode) continue;
          const avail = box.getBoundingClientRect().width - 16;
          const actual = katexNode.getBoundingClientRect().width;
          if (avail > 0 && actual > avail + 1) {
            const ratio = (avail / actual) * 0.96;
            if (ratio >= 0.74) {
              katexNode.style.fontSize = `${ratio.toFixed(3)}em`;
            }
          }
        }
      });
    }
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
    if (Number.isFinite(maxHeight) && result.height > maxHeight) {
      throw new Error("Formula image exceeds safe height");
    }
    if (!result.overflow) return result;
    if (result.width >= 1600 || Date.now() >= deadline) break;
    await page.locator(".cf-formula-capture").evaluate((element, width) => {
      element.style.width = `${width}px`;
    }, Math.min(1600, Math.ceil(result.width * 1.35)));
  }
  throw new Error("Formula exceeds safe image width; retaining source instead");
}

function stripFileProtocolLinks(text) {
  const source = String(text || "");
  const protectedRanges = inlineCodeRanges(source);
  if (!protectedRanges.length) {
    return source.replace(/\[([^\]\r\n]+)\]\(file:\/\/\/[^)\r\n]+\)/gi, "$1");
  }
  let out = "";
  let cursor = 0;
  for (const range of protectedRanges) {
    out += source.slice(cursor, range.start).replace(/\[([^\]\r\n]+)\]\(file:\/\/\/[^)\r\n]+\)/gi, "$1");
    out += source.slice(range.start, range.end);
    cursor = range.end;
  }
  out += source.slice(cursor).replace(/\[([^\]\r\n]+)\]\(file:\/\/\/[^)\r\n]+\)/gi, "$1");
  return out;
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
  protectedMarkdown = stripFileProtocolLinks(protectedMarkdown);

  let html = markdown
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
  if (plan?.mode === "block") {
    return "\n\n【独立公式暂时无法渲染；LaTeX 源码已保存在下方“公式源码”中】\n\n";
  }
  const source = String(plan?.content || "");
  if (!source.trim()) {
    return "\n\n【含公式段落暂时无法渲染；LaTeX 源码已保存在下方“公式源码”中】\n\n";
  }
  const formulas = scanLatexFormulas(source);
  if (!formulas.length) {
    return `${source}\n\n（以上部分复杂公式暂时无法渲染；LaTeX 源码已保存在下方“公式源码”中）\n\n`;
  }
  let readable = "";
  let cursor = 0;
  for (const formula of formulas) {
    readable += source.slice(cursor, formula.start);
    const simplified = simplifyInlineLatex(formula.latex);
    readable += simplified ?? (formula.display ? "[独立公式]" : "[公式]");
    cursor = formula.end;
  }
  readable += source.slice(cursor);
  return `${readable.trim()}\n\n（以上部分复杂公式暂时无法渲染；LaTeX 源码已保存在下方“公式源码”中）\n\n`;
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
