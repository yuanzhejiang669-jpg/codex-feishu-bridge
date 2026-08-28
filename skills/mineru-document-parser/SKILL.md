---
name: mineru-document-parser
description: Parse PDFs, scans, office documents, or images into Markdown and structured JSON on the Ubuntu Bridge host before analysis, extraction, summarization, or RAG preparation.
---

# MinerU Document Parser

Use the local CPU-compatible MinerU pipeline before reading large or structured documents directly.

Run:

```bash
/home/yzj666/Codex/tools/mineru/convert-with-mineru.sh INPUT [OUTPUT_DIR] [auto|txt|ocr] [ch|en]
```

- Default output: `/home/yzj666/Documents/MinerU-Outputs`.
- Use `txt` for clean text PDFs, `ocr` for scans, and `auto` when uncertain.
- Read the generated Markdown first. Use JSON artifacts when page mapping, tables, images, or layout structure matters.
- This host has no discrete GPU. Keep backend `pipeline`; do not select a local VLM engine unless the hardware changes and is revalidated.
