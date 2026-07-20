# Codex Feishu Bridge Desktop 0.7.5

## Fixed

- Windows selected Bot restarts no longer wait for inherited PowerShell output pipes after the Bridge is already online.
- A three-Bot safe restart now completes in seconds instead of accumulating one timeout per Bot.

## Distribution

- GitHub Releases are the supported Windows update channel and contain Windows assets only.
- The physical macOS client continues to be maintained directly through Tailscale and SSH and is not changed by this Windows-specific release.
