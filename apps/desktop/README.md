# Codex Feishu Bridge Desktop

Windows and macOS desktop distribution for Codex Feishu Bridge. The packaged app is the recommended user-facing installation; root-level PowerShell scripts and the web control panel remain advanced compatibility tools.

## User workflow

1. Download the latest installer from the repository's GitHub Releases page.
2. Launch **Codex Feishu Bridge** from the normal OS application entry.
3. Confirm runtime compatibility on the System page.
4. Create a Bot with existing Feishu credentials or in-client QR registration, or adopt a compatible legacy Bot.
5. Configure Providers and selectively migrate MCP servers and Skills into isolated Codex Homes.

The application supports native login startup and close-to-tray behavior. A terminal process does not need to remain open. On Windows, the System page can check, download, and install stable GitHub Releases while protecting active tasks, then restore previously enabled managed Bots.

Windows releases are currently unsigned and may trigger SmartScreen. macOS test releases are unsigned and unnotarized, so Gatekeeper may require explicit user approval. macOS in-app installation remains disabled until Developer ID signing and notarization are configured.

## Current capabilities

- Read-only Codex, Bridge, workspace, MCP, and Skills discovery.
- Client-managed Bot creation with existing Feishu credentials or QR registration.
- Legacy Bot adoption with active-run protection and old-watchdog handoff.
- Shared or isolated Codex Home selection and workspace factory queues.
- OpenAI login, third-party Responses Providers, and Chat Completions Providers through the bundled mimo2codex adapter.
- Minimal real Provider validation, model and reasoning selection, and protected whole-space source switching.
- Windows DPAPI and macOS Keychain-backed Provider credential encryption.
- Selective MCP and Skills source/target preview and migration.
- Bundled Node.js, lark-cli, and version-matched Bridge engine.
- Bot start, active-run-aware stop/restart, login startup, tray operation, and rate-limited crash recovery.
- GitHub Release checks, background download, active-task installation guard, and post-upgrade Bot restoration.
- Versioned desktop data Schema with atomic migration and rollback.
- Feishu permission guidance and per-Bot user OAuth verification.
- System compatibility checks for Bridge protocol, Node.js, lark-cli, Codex runtime, Provider, data Schema, and runtime isolation.
- Transactional writes, inline-secret blocking, and failure rollback.

## Development

This subproject is isolated from existing Bridge runtime data. Development and packaged smoke tests must not adopt, restart, or reconfigure existing Bots.

```powershell
npm install
npm run check
npm run pack
npm run smoke:packaged-engine
npm run dist:win
npm run dist:mac
```

Build output is generated under:

```text
apps\desktop\out
```

## Documentation

```text
apps\desktop\docs\implementation-plan.md
apps\desktop\docs\execution-log.md
apps\desktop\docs\release-process.md
```
