# Codex Skills

This directory vendors public-safe reusable Codex skills that support Bridge and personal Codex workflows.

- `imagegen-router`: routes GPT image generation/editing through local OpenAI-compatible providers. Provider API keys stay in environment variables and are not committed.
- `delegated-execution-workflow`: coordinates bounded implementation through a runtime-native delegated worker.
- `powershell-safe-invocation`: provides Windows PowerShell and native-process safety patterns.
- `tencent-docs-sheet-batch`: provides guarded Tencent Docs sheet automation helpers. The vendored subset intentionally excludes private case notes, document URLs, and local case paths.

Install these skills with the personal environment bootstrap described in [the migration guide](../docs/personal-environment-migration.md). Never add `.system` skills or local authentication/state files here.
