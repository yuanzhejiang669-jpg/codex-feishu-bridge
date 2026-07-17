# Codex Feishu Bridge Desktop

Windows and macOS desktop distribution for Codex Feishu Bridge.

This subproject is isolated from the existing Bridge runtime. Development and packaged smoke tests must not adopt, restart, or reconfigure existing Bots.

Implemented in the current development build:

- Read-only Codex, Bridge, workspace, MCP, and Skills discovery.
- Client-managed Bot creation with existing Feishu credentials or in-client QR registration.
- Shared or isolated Codex Home selection.
- Third-party Responses Provider configuration and minimal real API validation.
- Windows DPAPI and macOS Keychain-backed encryption for client-managed Provider API keys.
- Versioned desktop data Schema with atomic migration and rollback.
- Automated Feishu QR lifecycle coverage for success, cancellation, timeout, malformed QR, and local-save failure.
- System compatibility view for Bridge protocol, Node.js, lark-cli, Codex runtime, Provider, data Schema, and runtime isolation.
- Bot readiness checks for verified Feishu Bot identity, readable app scopes, Provider, Codex runtime, bundled engine, Bridge process, and pending real-message validation.
- A versioned recommended policy with 9 Bot/tenant scopes, 32 user scopes, and the single `im.message.receive_v1` event for messaging, cards, chat search, Docs, Drive, and Wiki; the 1,658-scope snapshot remains advanced reference data only.
- Post-registration Feishu capability completion with exact recommended permission batch-import JSON, direct permission/event console entry points, and per-Bot minimal-scope Lark CLI user OAuth verification.
- Native Windows/macOS login startup, close-to-tray behavior, per-Bot auto-start, and rate-limited crash recovery for client-managed Bots.
- Bundled Node.js, lark-cli, and Bridge engine.
- Client-managed Bot start and active-run-aware stop.
- GitHub Releases update checks, background download, active-task installation guard, and post-upgrade Bot restoration.
- Selective MCP and Skills migration into isolated Codex Homes.
- Inline-secret blocking, transactional writes, and failure rollback.

Provider migration, legacy Bot adoption, signed releases, and clean-VM Feishu E2E remain release work.

## Commands

```powershell
npm install
npm run check
npm run pack
npm run smoke:packaged-engine
npm run dist:win
npm run dist:mac
```

Outputs are generated under:

```text
apps\desktop\out
```

Windows releases are unsigned and may trigger SmartScreen. macOS test releases are also unsigned and unnotarized, so Gatekeeper may require explicit user approval. macOS in-app update installation remains disabled until Developer ID signing and notarization are configured.

## Documentation

```text
apps\desktop\docs\implementation-plan.md
apps\desktop\docs\execution-log.md
apps\desktop\docs\release-process.md
```
