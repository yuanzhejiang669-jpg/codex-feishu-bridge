# Antigravity implementation and validation

## Plan

1. Verify installed native CLI capabilities, account-storage scope and supported third-party protocol.
2. Implement ACP transport, native sessions, tool permissions, cancellation and context reporting.
3. Add manual encrypted account snapshots, Gemini API channel validation and separate native settings directories.
4. Integrate five-Bot creation, shared sessions, shared MCP/Skills and desktop controls.
5. Run regression, native integration, desktop rendering and release-package verification.
6. Register the five Feishu applications with the intended owner, verify real message events, and upgrade only idle affected runtimes.

## Executed

- Native CLI 1.5.14 advertised protocol version 1, session load/list support, permission requests and a 1,048,576-token context window.
- A real official session invoked the Feishu conversation MCP, was closed and resumed by a new native process, recalled the original tool result, and accepted cancellation.
- A fake-key local Gemini endpoint received the native CLI's actual main and auxiliary `streamGenerateContent` requests; the client parsed SSE output successfully.
- API channels explicitly require native `modelProvider: "gemini"` settings. API keys in environment variables alone are insufficient and can leave official-account mode selected. The regression suite covers separate channel directories and rejects an official directory configured in API mode.
- Unit and process tests cover startup cancellation, permission settlement, UTF-8 streaming, secret redaction, shared-session locking/deletion, account leases and idle reloads, five-entry factory routing, direct Windows start/stop, and existing Codex/Claude behavior.
- Desktop capture verifies Antigravity account/channel/tool sections, five-Bot default and password inputs without startup errors.

## Delivery boundaries

Prepared entries are not registered Feishu applications. Native smoke results do not verify production Feishu delivery. Application QR registration, any requested Lark user login, idle installation and affected-device synchronization must be verified and recorded separately in the deployment report. A running conversation Bot must not be killed for upgrade.
