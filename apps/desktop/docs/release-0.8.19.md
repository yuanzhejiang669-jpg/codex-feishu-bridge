# Codex Feishu Bridge Desktop 0.8.19

## Release scope

- Publish the first GitHub-hosted macOS desktop packages alongside the Windows installer.
- Build unsigned macOS DMG and ZIP artifacts for both Apple Silicon (`arm64`) and Intel (`x64`) on a clean GitHub macOS runner.
- Include the current Browser Control and Desktop Control improvements from the reviewed `main` branch.

## macOS trust model

The macOS artifacts are intentionally unsigned and not notarized. First launch therefore requires explicit approval through Finder's Open command or System Settings > Privacy & Security. No paid Apple Developer certificate is required for this release.

## Verification

- Both platform build jobs must pass before the Release is created or updated.
- The publish job requires the Windows installer metadata and checksums plus both macOS architectures, `latest-mac.yml`, and macOS checksums.
- Unexpected assets are rejected before publication.
