# Claude / Codex Bot command parity

The shared Bridge handles message and attachment ingress, queues, stop controls,
cards, formula rendering, error reporting and file delivery for both engines.
Managed Claude Bots share a catalog while keeping per-Bot current selections.
Native records remain in their original Claude Home and resume in the original
workspace. See [shared sessions](claude-shared-sessions.md).

| Operation | Claude command | Scope / implementation |
| --- | --- | --- |
| Help and status | `/help`, `/status`, `/now`, `/how`, `/context` | Claude-specific metadata; queue uses shared controller |
| Sessions | `/new`, `/list`, `/sessions`, `/switch`, `/rename`, `/reset` | Shared managed-Bot catalog; per-Bot current selection; list indices use the last displayed snapshot |
| Delete | `/delete`, `/del`, `/rm`, `/confirm delete` | Confirmed global deletion; exact native files in the original Home; tombstones prevent stale imports |
| Queue / stop | `/stop`, `/stop queue`, `/stop all`, `/stopall`, `/queue`, `/clearqueue`, `/clearqueueall` | Same Bridge implementation as Codex |
| Provider | `/provider`, `list`, `shortcuts`, `<id>`, `save <id>`, `clear` | Catalog shared; overrides per session; save changes this Bot's default |
| Model | `/model`, `list`, `capability`, `test <id>`, `<id> [effort]`, `effort <level>`, `reasoning <level>`, `save`, `clear` | Model list refreshes `/v1/models`; test uses a nonpersistent native CLI session |
| Effort alias | `/effort <level>` | `low`, `medium`, `high`, `xhigh`, `max`; native values, no Codex-effort remapping |
| Manual compact | `/compact [focus]` | Native CLI command; success requires `compact_boundary`, not merely a successful result |
| Running input | `/steer <text>` | Same native process/session, streaming input with `priority: next`; wait for all answered input UUIDs before closing |
| Approval | `/approve`, `/deny` | Native CLI permission requests; bound to chat and sender |
| Native skills | `/<skill-name> [arguments]` | Normal queue; explicit command dispatch, not verbatim text |

Ordinary user messages use `client_composed: true` to preserve their wording.
Explicit native slash commands use `client_composed: false` so the CLI dispatches
them. Sending `/compact` as verbatim text does not invoke native compaction.

`save` updates this Bot's configuration and Claude settings, preserving its
compaction policy and unrelated settings. Current-session overrides are stored
automatically without `save`. `/model save effort` saves only effort, not a
temporary model selection. Configured compaction window is displayed separately
from the model's unreported context capacity.

Codex native Goal and Codex Fast service tiers have no equivalent integration in
this Claude adapter. Their commands explain the limitation without falling
through to a Codex client or reporting false success. Claude CLI/model/provider
capabilities and SDK-supplied proprietary tools are not asserted to be identical.

Native protocol verification uses an isolated Home and local mock Anthropic SSE
gateway. It checks a real shell tool plus steering and a manual compact boundary;
it does not call a real upstream provider. The normal repository check includes
command scope, default persistence, original-session preservation and queue
fallback tests.
