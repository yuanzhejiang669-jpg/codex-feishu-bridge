# Desktop Release Process

Windows and macOS clients are built from this repository through GitHub Actions. GitHub Releases is the stable distribution channel.

## Release contract

1. Update `apps/desktop/package.json` and `package-lock.json` to the same semantic version.
2. Update the implementation plan and execution log.
3. Run `npm run check` and `npm run dist:win` from `apps/desktop`; macOS packaging runs on a clean macOS runner with `npm run dist:mac`.
4. Verify Windows `latest.yml`, NSIS assets, and checksums, plus macOS `latest-mac.yml`, DMG/ZIP assets, bundled tool architectures, and checksums.
5. Commit and push the release source.
6. Create and push the matching tag, for example `v0.2.0`.
7. `.github/workflows/release-desktop.yml` builds on clean Windows and macOS runners; its publish job runs only after both pass.
8. Verify the GitHub Release is public and contains Windows x64 plus macOS x64/arm64 assets and metadata.
9. Fast-forward the old Windows device repository to the released source without overwriting unrelated local modifications, run the root checks, and restart only affected idle script-managed Bots.
10. Restart affected idle script-managed Bots on the current device; never interrupt the Bot carrying the release task.
11. Upgrade the installed desktop client from the verified stable Release and verify the installed version, persistent data, and managed-Bot recovery.
12. Confirm the local repository, `origin/main`, old-device repository, stable Release, and installed client all match the intended release before reporting completion.

Windows keeps `Codex-Feishu-Bridge-Setup-<version>.exe`. macOS uses `Codex-Feishu-Bridge-<version>-mac-<arch>.dmg` and `.zip`.

The Windows updater compares the packaged application version with the latest stable GitHub Release. Unsigned macOS builds require manual replacement until signing and notarization are configured. Neither platform installs source from `main`.
The build command always passes `--publish never`; only the final workflow step may create or upload a Release, preventing electron-builder's tag-triggered implicit publishing from producing partial assets.

## Runtime safety

- Downloading an update does not stop a Bot.
- Installation is refused while any client-managed Bot has an active task.
- Immediately before installation, online client-managed Bots are stopped without changing their auto-start settings.
- Their names are persisted under `%LOCALAPPDATA%\CodexFeishuBridgeDesktop` and restored after the upgraded client launches.
- Script-managed and legacy Bots remain read-only and are never stopped by the desktop updater.
- Persistent Bot, Provider, workspace, Profile, and runtime data is outside the program directory and is preserved by NSIS upgrades.
- macOS persistent data is stored under `~/Library/Application Support/CodexFeishuBridgeDesktop`, outside the `.app` bundle.
- Script-managed Bot restarts on either device are limited to Bots whose current `active-runs.json` contains no non-null run entries.
- An unrelated dirty file on the old device must be preserved. A fast-forward pull is allowed only when Git confirms it will not overwrite that file.

## Signing

Windows requires a trusted Authenticode certificate to avoid SmartScreen warnings. macOS requires an Apple Developer ID Application certificate, hardened runtime configuration, and notarization credentials before the DMG can be described as production-ready or use in-app installation safely.
