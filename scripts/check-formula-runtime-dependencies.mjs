import katex from "katex";
import MarkdownIt from "markdown-it";
import { chromium } from "playwright-core";

const rendered = katex.renderToString(String.raw`\frac{P_s}{P_n}`, {
  displayMode: false,
  output: "html",
  throwOnError: true,
});

const table = new MarkdownIt({ html: false }).render("| A | B |\n|---|---|\n| 1 | 2 |");

if (!rendered.includes("katex") || !table.includes("<table>") || typeof chromium?.launch !== "function") {
  throw new Error("Formula runtime dependencies are incomplete");
}

process.stdout.write("Formula runtime dependencies are available\n");
