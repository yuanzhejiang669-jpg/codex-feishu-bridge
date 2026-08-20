# Desktop Release Process

GitHub Releases is the stable Windows and macOS distribution channel. Windows artifacts are unsigned unless a certificate is configured; macOS artifacts are intentionally unsigned and not notarized.

## Release contract

1. Update `apps/desktop/package.json` and `package-lock.json` to the same semantic version.
2. Update the implementation plan and execution log.
3. Run `npm run check` and `npm run dist:win` from `apps/desktop`; the clean GitHub workflow also runs `npm run dist:mac` on macOS.
4. Verify Windows `latest.yml`, NSIS assets, bundled engine content and checksums, plus macOS x64/arm64 DMG, ZIP, `latest-mac.yml`, bundled tools, engine dependencies and checksums.
5. Commit and push the release source.
6. Create and push the matching tag, for example `v0.7.5`.
7. `.github/workflows/release-desktop.yml` builds and tests on clean Windows and macOS runners, then atomically publishes both platforms only after both jobs pass.
8. Verify the GitHub Release is public, latest, and contains the required Windows assets plus x64/arm64 macOS DMG and ZIP assets.
9. Fast-forward the old Windows device repository to the released source without overwriting unrelated local modifications, run the root checks, and restart only affected idle script-managed Bots.
10. Restart affected idle script-managed Bots on the current device; never interrupt the Bot carrying the release task.
11. Upgrade the installed Windows client from the verified stable Release and verify the installed version, persistent data, and managed-Bot recovery.
12. Confirm the local repository, `origin/main`, old-device repository, stable Release, and installed Windows client all match the intended release before reporting completion.

Windows keeps `Codex-Feishu-Bridge-Setup-<version>.exe`. macOS publishes `Codex-Feishu-Bridge-<version>-mac-<arch>.dmg` and `.zip` for `x64` and `arm64`.

The Windows updater compares the packaged application version with the latest stable GitHub Release. The build command always passes `--publish never`; only the final workflow step may create or upload a Release, preventing electron-builder's tag-triggered implicit publishing from producing partial assets.

## macOS installation and maintenance

- Public GitHub artifacts are unsigned. On first launch, use Finder's Open command or System Settings > Privacy & Security to approve the application. Do not claim Apple notarization.
- Reach the physical Mac through its verified Tailscale address and SSH identity for managed internal upgrades and verification.
- Inspect every managed Bot's `active-runs.json` before replacing the application or restarting a Bridge process.
- Use the verified GitHub arm64 artifact or transfer reviewed source directly when GitHub access is unavailable.
- Build, install, and verify on the physical Apple Silicon Mac. Keep persistent data outside the application bundle.
- Confirm all six managed Bots, Provider environments, Profiles, Codex Homes, MCP servers, and Skills after any affected update.
- The macOS in-app updater remains outside the supported distribution contract; installation and managed upgrades are explicit operations.

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

Windows requires a trusted Authenticode certificate to avoid SmartScreen warnings. macOS GitHub artifacts are published without a Developer ID signature or notarization and therefore show the standard first-launch warning.
