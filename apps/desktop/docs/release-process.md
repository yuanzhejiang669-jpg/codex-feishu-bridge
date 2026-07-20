# Desktop Release Process

GitHub Releases is the stable Windows distribution channel. The physical macOS client is maintained directly through Tailscale and SSH and is not published or updated through GitHub Releases.

## Release contract

1. Update `apps/desktop/package.json` and `package-lock.json` to the same semantic version.
2. Update the implementation plan and execution log.
3. Run `npm run check` and `npm run dist:win` from `apps/desktop`.
4. Verify Windows `latest.yml`, NSIS assets, bundled engine content, and checksums.
5. Commit and push the release source.
6. Create and push the matching tag, for example `v0.7.5`.
7. `.github/workflows/release-desktop.yml` builds and tests on a clean Windows runner, then atomically publishes exactly the Windows installer, blockmap, update metadata, and checksum files.
8. Verify the GitHub Release is public, latest, and contains no macOS assets.
9. Fast-forward the old Windows device repository to the released source without overwriting unrelated local modifications, run the root checks, and restart only affected idle script-managed Bots.
10. Restart affected idle script-managed Bots on the current device; never interrupt the Bot carrying the release task.
11. Upgrade the installed Windows client from the verified stable Release and verify the installed version, persistent data, and managed-Bot recovery.
12. Confirm the local repository, `origin/main`, old-device repository, stable Release, and installed Windows client all match the intended release before reporting completion.

Windows keeps `Codex-Feishu-Bridge-Setup-<version>.exe`. A stable GitHub Release must not contain macOS DMG, ZIP, blockmap, checksum, or update-metadata assets.

The Windows updater compares the packaged application version with the latest stable GitHub Release. The build command always passes `--publish never`; only the final workflow step may create or upload a Release, preventing electron-builder's tag-triggered implicit publishing from producing partial assets.

## macOS maintenance channel

- Reach the physical Mac through its verified Tailscale address and SSH identity.
- Inspect every managed Bot's `active-runs.json` before replacing the application or restarting a Bridge process.
- Transfer reviewed source or a locally built artifact directly from the trusted Windows device. Do not require the Mac to pull from GitHub.
- Build, install, and verify on the physical Apple Silicon Mac. Keep persistent data outside the application bundle.
- Confirm all six managed Bots, Provider environments, Profiles, Codex Homes, MCP servers, and Skills after any affected update.
- macOS local artifacts are operational builds, not GitHub stable-release assets, and the macOS in-app updater is not part of the supported distribution contract.

## Runtime safety

- Downloading an update does not stop a Bot.
- Installation is refused while any client-managed Bot has an active task.
- Immediately before installation, online client-managed Bots are stopped without changing their auto-start settings.
- Their names are persisted under `%LOCALAPPDATA%\CodexFeishuBridgeDesktop` and restored after the upgraded client launches.
- Script-managed and legacy Bots remain read-only and are never stopped by the desktop updater.
- Persistent Bot, Provider, workspace, Profile, and runtime data is outside the program directory and is preserved by NSIS upgrades.
- macOS persistent data is stored under `~/Library/Application Support/CodexFeishuBridgeDesktop`, outside the `.app` bundle, and is preserved during SSH-managed updates.
- Script-managed Bot restarts on either device are limited to Bots whose current `active-runs.json` contains no non-null run entries.
- An unrelated dirty file on the old device must be preserved. A fast-forward pull is allowed only when Git confirms it will not overwrite that file.

## Signing

Windows requires a trusted Authenticode certificate to avoid SmartScreen warnings. The SSH-maintained macOS build is not represented as a signed/notarized GitHub distribution.
