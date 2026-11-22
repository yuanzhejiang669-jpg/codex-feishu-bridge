# Shared sessions across Claude Bots

Managed Claude Bots using the same tools/data root share a catalog at
`<dataRoot>/claude-shared-sessions/sessions.json`. Set
`CLAUDE_FEISHU_SHARED_SESSIONS_ROOT` to choose another catalog root. Standalone
instances without a tools root keep the existing private-store behavior.

Each Bot's existing `state/sessions.json` retains its chat's current selection.
The shared catalog is authoritative for titles, native IDs, context state and
session overrides. `/new` creates a globally visible session. `/list` and
`/sessions` show all shared entries. `/switch` can resume a session created by
another Bot, by displayed index, Bridge ID or native Claude UUID. The index and
`/rename <index>` refer to that sender's last list snapshot for five minutes.

Existing managed Bot bindings are imported without moving or rewriting native
JSONL records. A session stores its original Home, workspace and creator Bot.
Cross-Bot continuation resumes the same native UUID in that Home and workspace,
using the receiving Bot's Provider credentials, permission policy and delivery
identity. No test message is injected into existing real user conversations.

The native CLI receives `CFB_CLAUDE_BOT_HOME` separately from
`CLAUDE_CONFIG_DIR`. The shared MCP configuration is passed inline, with
CloakBrowser profile/output paths bound to the receiving Bot's own Home, so two
Bots resuming records in the same original Home keep independent profiles.
The persistent MCP config is preserved. Settings remain per Bot; the current
deployment retains Opus 5.5 High and the 400000 compaction window.

Catalog writes use an interprocess lock and field-level merges, preserving
concurrent edits made by other Bots and the identity of a running session's
JavaScript object. Execution, manual compaction, reset and confirmed deletion
use per-session leases. A live lease blocks concurrent use from another Bot;
dead-process leases can be recovered. Existing persisted active-run markers are
also checked during an idle-only rollout.

Rename, reset and compaction affect the selected shared conversation. A delete
preview explicitly says the record will disappear for every Claude Bot. The
confirmation acquires session leases, rechecks native identity and running
tasks, removes only exact UUID artifacts in the original registered Home, and
records catalog tombstones. Stale Bot caches cannot recreate deleted records.
Workspace files remain in place. Deletion failures remain visible for retry.

Current selections and Bot defaults are separate from the shared conversation:
`/model save` and `/provider save` still save that Bot's defaults. Explicit
session overrides follow the shared session. Skills/MCP program files may be
shared independently of conversation data.
