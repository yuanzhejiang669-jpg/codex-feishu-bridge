import katex from "katex";
import { chromium } from "playwright-core";

const rendered = katex.renderToString(String.raw`\frac{P_s}{P_n}`, {
  displayMode: false,
  output: "html",
  throwOnError: true,
});

if (!rendered.includes("katex") || typeof chromium?.launch !== "function") {
  throw new Error("Formula runtime dependencies are incomplete");
}

process.stdout.write("Formula runtime dependencies are available\n");
