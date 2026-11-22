# 0.9.3

- Add Antigravity as a third native Bot engine through the official `agy acp` CLI. The desktop client detects the runtime and prepares Antigravity-1 through Antigravity-5 by default, using the existing Feishu registration queue and permission policy.
- Add manually switched official Windows account snapshots protected by system encryption. Native login is shared by Windows clients; active-run leases and native-process checks guard switching. No automatic account rotation is performed.
- Add Gemini API channels with encrypted keys, native model discovery and streamed-generation verification. API mode is explicitly selected in separate native settings directories, preventing fallback to the official account. OpenAI/Anthropic wire protocols and arbitrary model IDs are not presented as native compatibility.
- Share Antigravity sessions across Bots while preserving their native IDs and original workspaces. Cross-process locks serialize session runs and protect catalog updates. Add transport commands, permission replies, context usage and native cancellation, including cancellation during startup.
- Reuse shared MCP/Skills migration with a separate Antigravity tool root and per-turn Feishu context/file tools. Native Bot start/stop on Windows uses direct Node supervision rather than PowerShell launch scripts.
- Preserve the deployed Claude command, retry and shared-session behavior alongside the existing Codex Provider-continuation changes.

Validation covers the root and desktop regression suites, native official MCP invocation, cross-process conversation continuation and stop, fake-key native Gemini HTTP/SSE routing, account encryption guards and desktop rendering. Feishu registration and user-resource authentication still require the intended owner's scan.
