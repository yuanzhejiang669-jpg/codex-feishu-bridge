# Codex MCP Tools

This directory vendors the reusable local MCP tools used by the Codex Feishu Bridge workspaces.

Included tools:

- `codex-browser-control-mcp`: Chrome/Edge control through CDP and the local browser extension bridge.
- `codex-desktop-control-mcp`: Windows desktop automation, screenshots, OCR, UIA, and visual fallback tools.
- `codex-android-control-mcp`: Android/ADB automation MCP server.
- `tavily-router`: Tavily Advanced search router backed by a local key pool.
- `firecrawl-router`: Firecrawl router backed by a local key pool.

Local-only files are intentionally not committed:

- API key pools and router state files under `.proma`.
- Browser extension `bridge-token.local.js`.
- `node_modules`, Python caches, traces, screenshots, logs, and generated runtime output.

For Browser Control, copy `extension/codex_browser_bridge/bridge-token.example.js` to `bridge-token.local.js` on each device and set the same token as the device's `BROWSER_CONTROL_EXTENSION_TOKEN`.
