# Codex Feishu Bridge Desktop 0.7.0

## Highlights

- Manage a discovered Codex Home before any Bot is bound, with explicit trust and validation.
- Reuse a trusted existing space Home without rewriting its Provider, MCP, Skills, or `AGENTS.md` configuration.
- Keep macOS Lark CLI event-bus socket paths short while retaining isolated Profile data.
- Show the installed MCP and Skill inventory for each Codex Home, including resolved symlink sources.
- Distinguish migration-source capabilities from target-Home installed capabilities in the UI.
- Enable in-app macOS updates only for Developer ID signed and Gatekeeper-accepted packages.
- Require complete Apple signing and notarization credentials before a stable tag can publish.

## Distribution Status

The `0.7.0` source may be committed and pushed before distribution credentials are available. Do not create the `v0.7.0` tag or stable GitHub Release until the complete Apple signing/notarization Secret set is configured and the signed/notarized macOS artifacts pass CI verification.

Existing Bot data, Provider keys, Lark Profiles, workspaces, and Codex Homes are stored outside the application bundle and are not part of the release artifacts.
