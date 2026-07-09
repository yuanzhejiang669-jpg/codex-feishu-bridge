# Codex Browser Control MCP

Independent MCP server for controlling local Chrome or Edge through Chrome DevTools Protocol and an optional Chrome/Edge extension bridge.

## What It Provides

- CDP browser lifecycle: `browser_start`, `browser_status`, `browser_stop`.
- Tab management: `browser_list_tabs`, `browser_open`, `browser_activate`, `browser_close`.
- Page actions: `browser_click`, `browser_type`, `browser_scroll`, `browser_wait_for`.
- Inspection: `browser_snapshot`, `browser_scan`, `browser_screenshot`.
- Advanced CDP: `browser_eval`, `browser_cdp`, `browser_cdp_batch`, `browser_cookies`.
- Trace/replay diagnostics: `browser_trace_start`, `browser_trace_status`, `browser_trace_stop`, `browser_trace_export`.
- Workflow reliability helpers: `browser_wait_for_new_tab`, `browser_dialog`, `browser_set_download_behavior`, `browser_wait_for_download`, `browser_grant_permissions`, `browser_reset_permissions`.
- Visual verification helpers: `browser_element_screenshot`, `browser_region_screenshot`, `browser_visual_analyze`, `browser_visual_compare`.
- Page health diagnostics: `browser_page_diagnostics`.
- Optional Playwright backend: `browser_playwright_status`, `browser_playwright_start`, `browser_playwright_open`, `browser_playwright_click`, `browser_playwright_type`, `browser_playwright_screenshot`, `browser_playwright_stop`.
- Web workflows: file input upload, iframe evaluation, shadow DOM piercing.
- Extension bridge tools for logged-in browser profiles: `browser_extension_*`.
- The extension bridge `tabs` command supports `method: "create"` for opening a new logged-in-profile tab through the existing browser extension session.

## Security Model

The MCP stdio server is only reachable by the Codex process that starts it. The optional extension bridge listens on `127.0.0.1` and now requires a shared token for HTTP and WebSocket traffic.

Environment variables:

| Name | Default | Purpose |
|---|---|---|
| `BROWSER_CONTROL_EXTENSION_TOKEN` | local config or `<local-extension-token>` | Shared local bridge token used by the MCP server. Keep the real value in Codex `config.toml` or the process environment. |
| `BROWSER_CONTROL_EXTENSION_REQUIRE_TOKEN` | enabled | Set to `0` only for legacy local integrations. |
| `BROWSER_CONTROL_EXTENSION_PORT` | `18795` | Local extension bridge port. |
| `BROWSER_CONTROL_EXTENSION_BRIDGE` | enabled | Set to `0` to disable the extension bridge entirely. |
| `BROWSER_CONTROL_ALLOW_UNSAFE_CSP` | disabled | Server-side status flag for documenting unsafe CSP bypass. The bundled extension also defaults its CSP bypass constant to `false`. |

Extension management and content settings commands are gated twice: the server environment variables default to disabled, and the extension constants default to disabled. To use them intentionally, enable both sides and add the required manifest permission before reloading the extension.

Important boundaries:

- CDP and extension JS execution are powerful by design. Use them only for pages the user asked Codex to automate.
- The extension no longer strips Content Security Policy headers by default.
- The extension no longer overrides page dialogs by default.
- The extension no longer ships a page-dialog override content script.
- The popup no longer needs to be used for normal automation. Prefer MCP tools.

## Install The Extension

1. Open Chrome or Edge extension management.
2. Enable developer mode.
3. Load the unpacked extension directory:

```text
C:\Users\12644\Documents\Codex\tools\browser-control-mcp\extension\codex_browser_bridge
```

Copy `bridge-token.example.js` to `bridge-token.local.js` in the extension directory and put the same local token there before loading/reloading the extension. `bridge-token.local.js` is intentionally ignored by Git.

## Run

```powershell
cd C:\Users\12644\Documents\Codex\tools\browser-control-mcp
npm run smoke
npm run start
```

## Trace Diagnostics

Start a trace before a browser workflow when you need a reproducible operation log:

```json
{
  "name": "baike-portrait-check",
  "includeSnapshots": true,
  "includeScreenshots": true,
  "includeConsole": true,
  "includeNetwork": true
}
```

The trace tools write JSONL events during execution and can export a consolidated JSON file at the end. Arguments and results are sanitized by default: tokens, cookies, passwords, credentials, and typed text are redacted. Screenshots and compact page snapshots are opt-in because they add browser overhead and can include visible page data.

## Workflow Reliability

Use the high-level helpers instead of hand-writing raw CDP commands when a workflow may open tabs, block on dialogs, download files, or ask for browser permissions:

- `browser_wait_for_new_tab` waits for a new page target and can run a triggering page-side script first.
- `browser_click` and `browser_locator_click` accept `waitForNewTab`, `newTabTimeoutMs`, and `requireNewTab`.
- After a new tab opens, use `browser_activate` to return to the original tab before sending further user-like clicks there.
- `browser_dialog` waits for, accepts, or dismisses JavaScript `alert` / `confirm` / `prompt` dialogs, and can run `actionScript` after event listening is armed.
- `browser_set_download_behavior` configures the download directory and download event reporting.
- `browser_wait_for_download` waits for the next matching download to complete and returns the saved path.
- `browser_grant_permissions` and `browser_reset_permissions` wrap common browser permission setup and cleanup.

## Visual Verification

Use the visual helpers when DOM text is insufficient and you need to verify what actually rendered:

- `browser_element_screenshot` captures a located element with optional padding and optional visual statistics.
- `browser_region_screenshot` captures a viewport clip.
- `browser_visual_analyze` captures a page, element, or region and returns luminance, color-bin, dominant-color, transparency, and nonblank-score metrics.
- `browser_visual_compare` captures before/after screenshots around an optional `actionScript` and reports changed-pixel ratio and mean delta.

These tools use CDP screenshots and browser-side canvas analysis, so they do not add external image-processing dependencies.

## Optional Playwright Backend

The `browser_playwright_*` tools provide an explicit Playwright-controlled browser path for workflows that benefit from Playwright locator auto-waiting or cross-browser testing. This backend is optional and separate from the CDP and extension bridge tools.

If Playwright is not installed, `browser_playwright_status` returns `available: false` and the other Playwright tools report a clear installation message. Existing CDP and extension tools continue to work.

Install Playwright only when this backend is needed:

```powershell
cd C:\Users\12644\Documents\Codex\tools\browser-control-mcp
npm install playwright
```

Use `browser_playwright_start` to create a Playwright session, then call `browser_playwright_open`, `browser_playwright_click`, `browser_playwright_type`, or `browser_playwright_screenshot`. End the session with `browser_playwright_stop`.

## Diagnostics And Benchmark

Use `browser_page_diagnostics` before risky or multi-step workflows when you need a single page-health signal. It combines a DOM snapshot, optional accessibility summary, optional visual nonblank analysis, active trace status, and optional locator actionability check. The result includes `issues`, `recommendations`, and a 0-100 `score`.

Example:

```json
{
  "role": "button",
  "name": "Submit",
  "includeAccessibility": true,
  "includeVisual": true
}
```

Run the benchmark when changing browser-control behavior:

```powershell
npm run benchmark
```

The benchmark launches an isolated headless browser on temporary ports and covers lifecycle/status, locator find/type/click/actionability, accessibility snapshots, page diagnostics, visual analyze/compare/element screenshots, trace start/status/stop/export, dialogs, new-tab detection, downloads, permission grant/reset, and the optional Playwright status payload. It cleans its temporary profile, downloads, screenshots, and trace directory in `finally`.

Codex MCP config example:

```toml
[mcp_servers.codex_browser_control]
type = "stdio"
command = "D:/Node.js/node.exe"
args = ["C:/Users/12644/Documents/Codex/tools/browser-control-mcp/src/server.mjs"]
env = { BROWSER_CONTROL_EXTENSION_PORT = "18795", BROWSER_CONTROL_EXTENSION_TOKEN = "replace-with-local-token" }
```

## Verification

`npm run smoke` validates:

- JSON-RPC initialize/list/call protocol.
- Required browser tools are registered.
- Disconnected `browser_status` returns a clean result.
- Trace start/status/stop/export is registered and can record a tool call.
- Dialog/download/permission/new-tab helpers are registered.
- Visual screenshot/analyze/compare helpers are registered.
- Page diagnostics is registered.
- Optional Playwright backend tools are registered and `browser_playwright_status` returns a stable status payload even when Playwright is not installed.
- Extension bridge rejects unauthenticated local requests and accepts token-authenticated ones.

## Before And After

Before this hardening, any local process could post compatible bridge requests to the extension port, the extension stripped CSP headers globally, and documentation was partially unreadable.

After hardening, the bridge requires a token, unsafe CSP bypass is off by default, extension management and content settings commands are gated, tests cover bridge auth, and the README documents the security boundary and setup path.
