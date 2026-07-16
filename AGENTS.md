# Codex Feishu Bridge Project Rules

## Release And Device Synchronization

A user-requested Bridge or desktop-client update is not complete after local code and tests alone. Unless the user explicitly limits the scope, complete and verify every affected target before reporting success:

1. Commit and push the tested source to `origin/main`.
2. If desktop code or packaged engine content changed, publish the matching stable GitHub Release and verify its assets.
3. Fast-forward the old Windows device repository without overwriting unrelated local changes, run its checks, and restart only idle script-managed Bots that need the new code.
4. Restart only idle affected script-managed Bots on the current Windows device; never interrupt an active run.
5. Upgrade the installed desktop client through the verified Release, preserving persistent client/Bot data, and verify its version and managed-Bot recovery.
6. Confirm current source, `origin/main`, old-device source, GitHub Release, and installed client agree on the intended version or commit.

Before any restart or update installation, inspect `active-runs.json` by its `runs` entries. If the current conversation Bot is active, skip it and arrange one idle restart after the turn instead of killing it.

Do not claim an update is synchronized while any required target above remains only locally built, unpushed, unpublished, uninstalled, or unverified. Record deliberate exceptions explicitly.
