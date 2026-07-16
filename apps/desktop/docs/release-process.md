# Windows Release Process

The Windows client is published from this repository through GitHub Actions. GitHub Releases is the stable update channel used by packaged clients.

## Release contract

1. Update `apps/desktop/package.json` and `package-lock.json` to the same semantic version.
2. Update the implementation plan and execution log.
3. Run `npm run check` and `npm run dist:win` from `apps/desktop`.
4. Verify `out/latest.yml`, the installer, blockmap, checksums, and `out/latest/release.json` agree.
5. Commit and push the release source.
6. Create and push the matching tag, for example `v0.2.0`.
7. `.github/workflows/release-windows.yml` builds on a clean Windows runner and publishes the verified assets.
8. Verify the GitHub Release is public and contains the installer, blockmap, `latest.yml`, and checksums.
9. Fast-forward the old Windows device repository to the released source without overwriting unrelated local modifications, run the root checks, and restart only affected idle script-managed Bots.
10. Restart affected idle script-managed Bots on the current device; never interrupt the Bot carrying the release task.
11. Upgrade the installed desktop client from the verified stable Release and verify the installed version, persistent data, and managed-Bot recovery.
12. Confirm the local repository, `origin/main`, old-device repository, stable Release, and installed client all match the intended release before reporting completion.

The published installer uses the fixed `Codex-Feishu-Bridge-Setup-<version>.exe` artifact pattern. The filename must exactly match the URL recorded in `latest.yml`; do not upload a space-normalized alias.

The updater compares the packaged application version with the latest stable GitHub Release. It never installs source from the `main` branch.
The build command always passes `--publish never`; only the final workflow step may create or upload a Release, preventing electron-builder's tag-triggered implicit publishing from producing partial assets.

## Runtime safety

- Downloading an update does not stop a Bot.
- Installation is refused while any client-managed Bot has an active task.
- Immediately before installation, online client-managed Bots are stopped without changing their auto-start settings.
- Their names are persisted under `%LOCALAPPDATA%\CodexFeishuBridgeDesktop` and restored after the upgraded client launches.
- Script-managed and legacy Bots remain read-only and are never stopped by the desktop updater.
- Persistent Bot, Provider, workspace, Profile, and runtime data is outside the program directory and is preserved by NSIS upgrades.
- Script-managed Bot restarts on either device are limited to Bots whose current `active-runs.json` contains no non-null run entries.
- An unrelated dirty file on the old device must be preserved. A fast-forward pull is allowed only when Git confirms it will not overwrite that file.

## Signing

The initial community release is unsigned and may trigger Windows SmartScreen. A trusted Authenticode certificate and CI secret should be added before describing the installer as signed.
