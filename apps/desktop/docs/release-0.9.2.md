# 0.9.2

- Codex Provider changes prepare a native continuation from the latest history before confirming the logical session switch. Same-Provider model/account changes resume the current thread. Internal handoffs are persisted, recovered after restart, and folded out of the Bridge session list.
- Provider/configuration errors retain RPC details and no longer appear as generic cloud-config timeouts. These failures do not create blank threads or trigger unrelated service-tier/exec retries.
- Windows Provider creation and key rotation verify registry persistence without blocking on desktop-wide environment notifications. Failed writes roll back, dotted Provider IDs round-trip correctly, and affected managed Codex Bots reload credentials only when idle.
- Explicitly entered models missing from the live upstream catalog can be selected after a separate ephemeral native inference completes successfully. Verification is scoped to Provider/account/credentials and displayed separately from the live directory. No model names are hard-coded.
- Provider commands recognize Feishu mailto Markdown aliases. Workspaces, source native histories and existing logical sessions remain available.

Validation includes root/desktop checks, Windows registry operations with fake credentials, native Provider/account isolation tests, and an isolated real Bridge process exercising A→B→A, both 6.2 models, command idempotency and process restart. Its Feishu transport is local; no unsolicited production-chat messages are sent.
