# Codex + Claude Code CLI

Each Bot has one fixed execution engine. Existing Bot configurations default to Codex; new Claude Bots use the native Claude Code CLI. Feishu transport, attachments, live cards, queues, and file delivery remain shared.

## Configure and create Claude Bots

1. Install Claude Code CLI 2.1.327 or later. The System page displays its detected path and version. `CLAUDE_CLI_BIN` can select another installed native CLI.
2. Under Provider → Claude Provider, enter a channel ID, Base URL, authentication scheme, API key, model, and effort. The channel must support Anthropic Messages API and model discovery at `/v1/models`. OpenAI-only channels require a separate protocol adapter and are not treated as native Claude channels.
3. Read the model list and optionally test the connection. Saving validates the selected model and protects the key using Electron safeStorage. The JSON catalog stores a credential reference, never the key.
4. Under Bot → Create Claude 1–10, select the channel and preview the plan. Ten Bots is the default; count and starting index can be changed.
5. Generate the persistent queue. Under Workspaces, scan each Bot's QR code to authorize its Feishu application. A prepared queue is not a registered application. Run the Bot readiness check, start the Bot, and send a real Feishu message to verify message events.

Each Claude Bot gets `DATA_ROOT/claude-homes/BOT_NAME` and a separate workspace and Feishu profile. Native session UUIDs persist in Bridge sessions and are resumed with `claude --resume`. A CLI process serves one queued turn; different Bots can run independently. Native authentication is supplied to that child process only. Existing Codex homes and settings are not used for Claude authentication.

## Channels and key replacement

Editing a channel with a blank key keeps its protected key. Entering a replacement validates model access before replacing the stored key. Single or multiple Claude Bots can be assigned a saved channel, model and effort. Busy Bots finish their current tasks; a durable queue applies new process credentials when they are idle. Disabled offline Bots stay offline. Native transcripts, shared tools and private homes survive a channel change. Explicit per-session `/provider` and `/model` overrides retain precedence over the Bot default.

`high` is the default effort. The installed CLI accepts low, medium, high, xhigh and max; a particular upstream model may support a subset. Native errors remain visible when a provider rejects a model or effort. No extra writing style, outline, length requirement, or system prompt is added by the Bridge. Extracted Feishu message text is passed as its own native user content block; attachment paths and images are separate blocks. Normal Feishu mention/transport decoding still applies.

## MCP and Skills

The Claude section of MCP / Skills manages `DATA_ROOT/claude-tools/.mcp.json` and `DATA_ROOT/claude-tools/.claude/skills`. Claude loads this shared directory through its native `--add-dir`/`--mcp-config` options, along with each Bot's private MCP configuration and workspace configuration. Changes apply on the next turn.

Selected standard Codex MCP definitions can be converted to Claude JSON. Environment references are preserved. Inline credentials are rejected or skipped. Skills are linked to their existing source directories, so ten Bots do not create ten copies. Same-name target entries are preserved. Skills containing Codex-host-specific tool calls are marked for adaptation; linking such a Skill alone does not make those host tools available in Claude.

Configured tool inventories are separate from actual runtime reports. The System page shows the most recent native CLI version, model, MCP connection statuses and observation time for each Claude Bot. Those reports describe the last run, not a permanently connected process.

Each turn also exposes the built-in `feishu_bridge` MCP server. `current_conversation` reads the current chat/profile/workspace metadata; `send_file` delivers a workspace file through the existing Lark CLI as this Bot. The recipient is fixed to the conversation that requested the turn, sends use a stable idempotency key, and success requires a returned Feishu message ID. The write tool uses the same host permission flow as other writes. Its tool description limits use to requested file delivery. No transport metadata is inserted into the user's own text.

## Conversation controls and limits

Bridge handles `/new`, `/list`, `/sessions`, `/switch`, `/rename`, `/reset`, `/status`, `/context`, `/provider`, `/model`, `/effort`, `/queue`, queue-clearing and stop commands. Native skill names and `/compact` travel through an ordinary queued Claude turn. Codex-specific goal/fast/steer and transcript-deletion commands are not implemented as Claude equivalents.

Tool calls requiring permission produce a Feishu request with one-use `/approve TOKEN` and `/deny TOKEN` commands. The reply must come from the requesting user in the same chat. Requests expire after 30 minutes and are cancelled when their turn ends. There is no blanket permission bypass. Stopping uses the native interrupt control with a process-tree fallback.

Context usage comes from native events, and compaction timestamps come from native compact-boundary events. A provider's advertised model window is not assumed to be its real compaction threshold. Until native capacity is available, cards explicitly show that capacity was not supplied.

Local implementation and Windows validation do not constitute a GitHub release or completion of Feishu QR authorizations. Those delivery stages must be reported separately.
