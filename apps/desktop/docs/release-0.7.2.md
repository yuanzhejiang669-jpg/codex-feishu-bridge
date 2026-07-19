# Codex Feishu Bridge Desktop 0.7.2

- Add a stable checkbox to every client-managed Bot row, plus select-all and clear-all commands.
- Restart only selected Bots in either safe or forced mode.
- Safe mode skips selected offline or active Bots and rechecks activity immediately before stopping.
- Forced mode warns about selected active tasks, terminates the Bot process tree/group, clears only its active-run state, and restarts sequentially.
- Preserve Bot selection across automatic state refreshes and continue after an individual Bot failure.
