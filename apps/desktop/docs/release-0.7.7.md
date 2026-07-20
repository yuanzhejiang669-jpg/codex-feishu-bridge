# Codex Feishu Bridge Desktop 0.7.7

## Codex Home session isolation

- `/list all` aggregates Bridge bindings only from Bots using the same resolved Codex Home.
- Confirmed deletion removes the thread only from the current Codex Home and same-Home Bridge bindings; active-run protection still checks every registered Bot.
- Different Codex Homes no longer use `desktopCodexHome` to mirror sessions into the global `.codex` sidebar.
- The workspace factory creates future spaces without a desktop mirror target.
- Existing current-device writing Bot launch configurations were migrated to an empty `desktopCodexHome`. The drawing Bots were already isolated.

## Distribution

- GitHub Releases publish Windows assets only.
- The physical Apple Silicon Mac remains on 0.7.6 until the Windows behavior is accepted, then receives the reviewed change directly through Tailscale and SSH.
- The powered-off old Windows device remains excluded.
