# Codex MCP Tools

This directory vendors the reusable local MCP tools used by the Codex Feishu Bridge workspaces.

Included tools:

- `codex-browser-control-mcp`: Chrome/Edge control through CDP and the local browser extension bridge.
- `codex-desktop-control-mcp`: Windows desktop automation, screenshots, OCR, UIA, and visual fallback tools.
- `codex-android-control-mcp`: Android/ADB automation MCP server.
- `tavily-router`: Tavily Advanced search router backed by a local key pool.
- `firecrawl-router`: Firecrawl router backed by a local key pool.

The Firecrawl pool may define `rotation_policy` values for
`rate_limit_cooldown_seconds` (default 180), `transient_error_cooldown_seconds`
(default 30), `credits_error_fallback_cooldown_seconds` (default 21600),
`auth_error_cooldown_seconds`, and `payment_error_cooldown_seconds` (both default
86400). Credit exhaustion uses the official billing-period end when available.
`firecrawl_pool_status` queries official credit usage per key and degrades each
failed status query independently without exposing key values.
The first three defaults can also be set with the corresponding
`FIRECRAWL_RATE_LIMIT_COOLDOWN_SECONDS`,
`FIRECRAWL_TRANSIENT_ERROR_COOLDOWN_SECONDS`, and
`FIRECRAWL_CREDITS_FALLBACK_COOLDOWN_SECONDS` environment variables; pool policy
values take precedence.

Local-only files are intentionally not committed:

- API key pools under `~/Documents/Codex/mcp-data/key-pools` and router state
  under `~/Documents/Codex/mcp-data/state`.
- Browser extension `bridge-token.local.js`.
- `node_modules`, Python caches, traces, screenshots, logs, and generated runtime output.

For Browser Control, copy `extension/codex_browser_bridge/bridge-token.example.js` to `bridge-token.local.js` on each device and set the same token as the device's `BROWSER_CONTROL_EXTENSION_TOKEN`.
