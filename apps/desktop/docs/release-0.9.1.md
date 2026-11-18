# 0.9.1

New Claude Bots use Claude Code's native full authorization mode by default, matching the fully authorized Codex Bot workflow. File writes, shell commands and MCP calls no longer stop for routine approval. Explicit manual configurations remain supported and are preserved on upgrade.

The saved Bot permission mode is read before each native turn. `/status` displays that mode, and runtime reports include Claude Code's observed permission mode. Provider credentials, native sessions and tool configuration are preserved.

Validation covers native bypass arguments, retained manual approval, permission changes between resumed turns, and the managed Bot creation default.
