# Codex Feishu Bridge Desktop 0.7.6

## Session deletion consistency

- `/list all` now aggregates Bridge bindings from every registered Bot instance and discovers current and future Codex Homes from persisted instance configuration.
- Confirmed deletion removes the selected thread from every discovered Codex Home, including SQLite state, rollout files, sidebar indexes, global state, desktop mirrors, and Bridge bindings.
- Persistent deletion tombstones prevent a background mirror or another Bot from restoring a deleted thread.
- Active runs are checked across all registered Bot state directories before deletion and again immediately before each item in a batch is removed.
- Batch ranges retain their preview-time thread identities. For example, deleting `2-9` removes exactly eight selected sessions and does not include item `1`.

## Distribution

- GitHub Releases continue to publish Windows assets only.
- The physical Apple Silicon Mac is updated directly through Tailscale and SSH, then built, installed, and verified locally.
- The powered-off old Windows device is intentionally excluded from this rollout.
