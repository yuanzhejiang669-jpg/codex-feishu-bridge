# 0.9.0 — Claude Code CLI engine

Adds fixed per-Bot Claude execution alongside the existing Codex engine, independent native sessions and homes, encrypted Claude provider management, idle-only key/configuration refresh, default Claude 1–10 QR creation, and a shared native MCP/Skills library.

The Claude adapter uses the native CLI streaming/control protocol for text, tools, host permissions and interruption. User text is passed without extra writing instructions. Unknown model capacity stays unknown. Existing Codex Bots keep their original engine and configuration path.

See [the dual-engine guide](dual-engine.md) for setup, protocol requirements, native tool migration, supported controls and current limits. Release publication and Feishu application authorization are separate from a locally validated build.
