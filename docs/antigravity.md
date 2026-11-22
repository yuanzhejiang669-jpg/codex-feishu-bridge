# Antigravity Feishu Bots

Antigravity Bots run the installed official `agy acp` process. Feishu is the message transport; native Antigravity executes model calls, tools, permissions, Skills, session persistence and compaction.

## Setup

Install Antigravity CLI 1.5 or later and sign in using the native CLI. In the desktop client, open **Bot → 创建 Antigravity-1～5**, preview the five entries, then generate the queue. Open **工作空间** and scan each registration QR with the Feishu account that should own the applications. The registration uses the same SDK preset and permission policy as Codex Bots.

Each Bot has a workspace. All Antigravity Bots share `antigravity-home`, `antigravity-tools` and `antigravity-shared-sessions` under the desktop data root. `/list` and `/switch` can select another Bot's session. The original workspace and native session ID remain unchanged. A cross-process lease prevents two Bots from executing the same session simultaneously.

## Official accounts

On Windows, `--gemini-dir` does **not** isolate official authentication: the native CLI uses the shared Windows Credential Manager entry `gemini:antigravity`. The client saves opaque snapshots encrypted with Electron safeStorage. Snapshot data is never hydrated into environment variables or used to call private model endpoints.

Use **Provider → Antigravity 账号与渠道** to save the current login with an alias. To add another login, close the native App/CLI, open the official login window, use the CLI's `/logout` and sign-in flow, close that window, and save another alias. Switching is manual and requires all Antigravity runs and native clients to be idle/closed. The login window also blocks official Bot runs while login is in progress. There is no automatic quota/account rotation. Other operating systems use their native current login; encrypted account switching in this version is Windows-only.

Official ACP integration reference: https://antigravity.google/docs/ide/extensions/acp/

Native account/plan conditions: https://antigravity.google/docs/faq

## Third-party channels

The native Gemini API path uses `GEMINI_API_KEY` and `GOOGLE_GEMINI_BASE_URL`, plus an explicit `modelProvider: "gemini"` in native settings. Each API channel has a separate `antigravity-api-CHANNEL_ID` application-data directory to prevent fallback to the shared official login or concurrent settings conflicts. Endpoints must implement Gemini GenerateContent streaming. Save verifies the native model directory and a real streamed generation before storing the key. Keys are encrypted separately under `antigravity-provider-credentials` and loaded by idle Bot restarts.

Only IDs accepted by the current CLI's native model directory are selectable. OpenAI Responses/Chat Completions and Anthropic Messages endpoints cannot be substituted for Gemini endpoints. The CLI may call auxiliary Gemini models as well as the selected model; the channel must support those calls. An existing native session stays bound to its source channel. Create `/new` before switching it to a different channel.

## Commands and tools

Bridge commands: `/help`, `/new`, `/reset`, `/list`, `/sessions`, `/switch`, `/rename`, `/delete`, `/confirm`, `/status`, `/now`, `/how`, `/context`, `/provider`, `/model`, `/effort`, `/mode`, `/approve`, `/deny`, `/stop`, `/stopall`, `/queue`, `/clearqueue`, `/clearqueueall`.

Native Skills and native slash commands such as `/compact` and `/plan` travel through the regular task queue. `/context` reads native usage events; it is not sent to the model as a fake native command. Model and effort values are checked by the native CLI, without silent fallback. `/provider save` and `/model save` set this Bot's defaults; `clear` removes the corresponding session overrides.

`/delete` previews and confirms removal of the shared Bridge binding across Bots. **It does not erase native Antigravity history or workspace files.**

Shared MCP configuration supports stdio, HTTP and SSE. Environment references are resolved before ACP initialization. Shared Skills use `.agents/skills` directory links. The per-turn `feishu_bridge` MCP exposes the current conversation and authorized local-file delivery. Codex-specific embedded tools and Skills that depend on those tools still need adaptation. Lark user-resource actions require separate user login.

Native context capacity and compaction are controlled by Antigravity. The verified CLI 1.5.14 reported a 1,048,576-token window; no Codex or Claude threshold is imposed.

## Verification

`npm run check` and `npm --prefix apps/desktop run check` include protocol, permission, stop/start, account/secret, factory and shared-session regression tests. Native smoke tests are explicit opt-ins:

```powershell
$env:ANTIGRAVITY_CLI_BIN = 'C:\path\to\agy.exe'
node scripts/smoke-antigravity.mjs C:\path\to\test-output
node scripts/smoke-antigravity-provider.mjs C:\path\to\test-output
```

The first uses the current official account to verify an MCP invocation, native session continuation and cancellation. The second uses a local fake-key Gemini server to verify actual native HTTP routing and SSE parsing; it does not prove compatibility with an arbitrary third-party service.
