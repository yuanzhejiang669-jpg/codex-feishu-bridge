# Codex Feishu Bridge Desktop Implementation Plan

## 1. Product goal

Deliver a Windows desktop client that a new Windows user can install from a provided installer and use to configure and operate Codex Feishu Bridge without cloning source code, running PowerShell commands, editing JSON/TOML, or opening a localhost URL manually.

The current milestone is the first GitHub-distributable Windows client. GitHub Release publishing and active-task-aware automatic updates are included; Authenticode signing and clean-VM Feishu E2E remain later release work.

Final acceptance flow:

```text
Receive installer
-> install and launch
-> inspect local Codex availability and authentication
-> configure Feishu credentials/profile
-> create a Bot and workspace
-> select Provider, MCP servers, and Skills
-> start the Bot
-> send a Feishu message and receive a Codex response
```

If Codex is unavailable, the client reports the missing dependency and stops that flow. It must not download Codex or open an installation guide automatically.

## 2. Non-negotiable compatibility boundary

Desktop development is additive. While building or maintaining the desktop client, the existing Codex Feishu Bridge is the stable engine and recovery baseline, not a refactoring target for the desktop-client task:

- Do not modify the behavior of the existing Bridge, control panel, queue, cards, threads, sessions, scripts, or watchdogs.
- Do not modify any existing Bridge source file outside `apps/desktop` as part of a desktop-client task.
- Do not restart, stop, reconfigure, migrate, or adopt existing Bots on either device.
- Do not write to the production runtime root at `%LOCALAPPDATA%\CodexFeishuBridge` during development.
- Use `%LOCALAPPDATA%\CodexFeishuBridgeDesktopDev` for development state.
- Keep the existing browser control panel and PowerShell recovery path functional.
- Put desktop code, dependencies, build output, tests, and documentation under `apps/desktop`.
- The client may inspect existing Bridge state read-only and package an allowlisted, versioned snapshot of the existing engine.
- The client may create and manage only instances that were created by the client itself.
- If a desktop requirement appears to need a Bridge change, first record it as a compatibility gap and solve it through an adapter under `apps/desktop` where practical.
- The Bridge is not frozen forever. It may continue to evolve for its own bugs and features through a separately scoped Bridge task with its own review, tests, synchronization, and explicit user authorization. Such changes must not be hidden inside desktop-client work.

## 3. Reference projects

### 3.1 Proma

Reference checkout:

```text
D:\Proma-Source
```

Use as a reference for:

- Electron main/preload/renderer separation.
- Typed, narrow IPC boundaries.
- Single-instance window lifecycle and system tray behavior.
- NSIS packaging with electron-builder.
- GitHub release publishing and electron-updater.
- Program files and user data separation.
- Workspace-scoped MCP and Skills management.
- Bundled default Skills with explicit version-based upgrades.

Do not copy its Agent orchestration, storage model, branding, or product layout wholesale.

### 3.2 CC Connect

Reference checkout:

```text
C:\Users\yzjiang\Documents\Codex\research\cc-connect-src
```

Use as a reference for:

- Reproducible Windows x64/arm64 release assets.
- Embedded web resources.
- SHA-256 release manifests.
- Portable Bridge distribution and self-update behavior.
- Windows daemon/watchdog recovery.
- Agent/platform capability boundaries and health checks.

Do not replace the existing Bridge with CC Connect and do not copy implementation code without confirming the repository license terms.

## 4. Target architecture

```text
Electron renderer
  -> preload allowlist
  -> Electron main process
     -> environment inspector
     -> configuration service
     -> Bot/workspace service
     -> MCP/Skills migration service
     -> optional non-GPT translation proxy service
     -> Bridge supervisor
     -> update service
        -> packaged existing Bridge engine
           -> lark-cli / Feishu
           -> official local Codex app-server
```

The renderer never receives secrets and never receives an unrestricted shell or filesystem API.

## 5. Installed layout

Recommended program directory:

```text
%LOCALAPPDATA%\Programs\Codex Feishu Bridge
```

Persistent user data:

```text
%LOCALAPPDATA%\CodexFeishuBridgeDesktop
%LOCALAPPDATA%\CodexFeishuBridgeDesktop\runtime-localappdata\CodexFeishuBridge
%USERPROFILE%\Documents\Codex\workspaces
%USERPROFILE%\.codex
```

The existing `%LOCALAPPDATA%\CodexFeishuBridge` tree is read-only legacy state from the desktop client's perspective. Client-owned Bot metadata, encrypted credentials, lark-cli Profiles, transactions, and runtime state must remain under `%LOCALAPPDATA%\CodexFeishuBridgeDesktop`.

Uninstalling or upgrading the application must not remove persistent user data unless the user explicitly selects a separate destructive cleanup action.

## 6. User experience

### 6.1 First launch

1. Inspect Windows, Codex package registration, runtime executable, CLI version, official login, and third-party Provider readiness.
2. Report missing or unhealthy prerequisites without downloading them.
3. Configure or import Feishu application/profile data.
4. Create the first Bot and workspace.
5. Select shared or isolated Codex Home, choose direct Responses API or a managed non-GPT translation proxy, and validate it with a minimal real model request.
6. Preview and apply selected Provider, MCP, and Skills migrations.
7. Run a Bot readiness check that separately reports verified Bot identity, readable app scopes, Provider, Codex runtime, bundled engine, Bridge process, and the configured message EventKey.
8. Run a real Feishu end-to-end test. A configured EventKey is never reported as verified until a real Feishu message is received.

### 6.2 Daily use

- Show aggregate health and version alignment.
- Show Bridge protocol, bundled dependency, Codex runtime, Provider, data Schema, and runtime-isolation compatibility.
- List Bot connection state, PID, active run, workspace, and last error.
- Start, stop, and restart only after active-run checks.
- Open workspace and logs through explicit, path-confined actions.
- Manage workspaces, Providers, MCP servers, and Skills.
- Remain in the system tray while Bots continue running.
- Apply updates only after active tasks become idle, with rollback metadata retained.

## 7. Delivery phases

### Phase 0: planning and isolation

- Create the standalone `apps/desktop` project.
- Add this plan and an append-only execution log.
- Establish development-only state and strict IPC boundaries.

Acceptance: no existing production file or process changes.

### Phase 1: desktop foundation and read-only discovery

- Electron main/preload/renderer foundation.
- Single-instance desktop window.
- Read-only Codex package/runtime/auth inspection.
- Read-only discovery of existing Bridge instances.
- Native open-folder actions restricted to known paths.
- Automated tests for parsing, redaction, and path confinement.

Acceptance: client runs and reports the current machine without changing it.

### Phase 2: distributable Bridge engine

- Package the existing Bridge engine and required Node dependencies as application resources.
- Define installed and development engine resolution.
- Add version/protocol compatibility metadata.
- Add a development sandbox instance isolated from production.

Acceptance: a packaged client can start one disposable test Bot without a source checkout.

### Phase 3: first-run Feishu and Bot setup

- Feishu application/profile entry and validation.
- Permission/scope validation and QR authorization flow.
- Workspace and Codex Home selection.
- Transactional Bot configuration creation.
- Failure rollback for partially created instances.
- Automated QR lifecycle coverage for success, cancellation, expiration/timeout, malformed responses, and remote-success/local-save failure.
- Post-creation Bot readiness checks must verify Bot identity with the isolated Profile, compare tenant/user scopes against the embedded recommended policy, and keep real message delivery as a separate pending E2E state.
- Default permission readiness must use the versioned 41-scope Bridge/Lark common policy embedded in the client, not a Profile or Bot already present on the machine. The 1,658-scope snapshot remains advanced reference data only. The default policy fixes `im.message.receive_v1` as the only required event and compares Bot/tenant and user scopes separately.

Acceptance: a clean Windows user can create a Bot through the UI without editing files.

Client-owned persistent data uses an explicit Schema version. Every Schema transition must be ordered, atomic, idempotent, reject data from a newer unsupported client, and provide rollback for partial failure.

### Phase 4: Provider, MCP, and Skills management

- Parse configuration structurally where supported.
- Support direct OpenAI-compatible Responses Providers.
- Identify the approved non-GPT translation proxy repository, version, license, and redistribution terms before bundling it.
- Manage the approved proxy under the desktop client with isolated runtime data, DPAPI credentials, port allocation, health checks, logs, crash recovery, and version reporting.
- Preview the upstream non-GPT model to Codex-facing model/Provider mapping.
- Preview source and target differences.
- Copy only selected Skills with dependency manifests.
- Copy only selected MCP blocks; never copy inline secrets silently.
- Validate executables, environment variables, imports, and one minimal real call.

Acceptance: migration is selective, reviewable, testable, and reversible; at least one real non-GPT model completes a Codex app-server request through the managed proxy.

Implemented in `0.1.8`:

- Parse MCP definitions structurally so nested `env` and `tools` tables are not reported as separate servers.
- Show the absolute global Codex Home, MCP config, command/runtime entry, Skill directory, and `SKILL.md` paths without returning environment-variable values.
- Restrict native open/copy operations to paths exposed by inspected desktop state.
- Group migration targets by shared isolated Codex Home and show source, target, and every affected Bot before applying.
- Reuse a validated global Provider for a single isolated Bot without copying its API key.
- Unify single-Bot defaults with the workspace naming grammar and preview final workspace, Codex Home, metadata, Profile, runtime, and log paths.
- Distinguish client-managed Bots from existing read-only Bridge instances and avoid duplicate names in combined views.

### Phase 5: supervision and read-only legacy visibility

- Discover existing installations read-only.
- Show existing Bots separately from client-managed Bots.
- Allow copying selected non-secret settings into a new client-managed instance only after preview and confirmation.
- One desktop supervisor with active-run-aware restart semantics.
- Apply supervisor actions only to client-managed instances.
- Keep legacy scripts as a recovery path.

Implemented in `0.1.4`:

- Windows login startup for the packaged client with a background launch argument.
- Close-to-tray behavior and explicit tray exit.
- Per-client-Bot auto-start controls.
- Rate-limited recovery with exponential backoff for offline client-managed Bots only.
- Manual stop disables Bot auto-start, while a failed stop restores the previous setting.
- Legacy/existing Bots remain read-only and are excluded from all recovery actions.

Acceptance: existing Bots and their runtime remain unchanged; new client-managed instances can be created, operated, and removed independently.

### Phase 6: release engineering

Deferred until after the functional client flow is complete; excluded from the current functional-completeness estimate.

- NSIS x64 installer, desktop/start-menu shortcuts, and uninstall behavior.
- Signed release artifacts when a signing certificate is available.
- GitHub Actions build, tests, SHA-256 manifest, and release upload.
- Update download, idle install, data migration, and rollback.

Acceptance: install, upgrade, downgrade, and uninstall pass on a clean Windows VM.

### Phase 7: production E2E and release candidate

- Real Feishu send/receive/card E2E.
- Codex app-server smoke with supported desktop versions.
- Crash recovery, power loss, locked session, network loss, and partial update tests.
- Accessibility, scaling, long-path, non-ASCII username, and antivirus checks.

Acceptance: release candidate passes the compatibility matrix and adversarial review.

### Functional parity backlog (71 tracked items)

This list is the durable parity checklist against the existing local control panel and the clean-Windows client goal. Items stay here until implemented and verified; chat history is not the source of truth.

1. [x] Detect Codex Desktop package and runtime.
2. [x] Report Codex Desktop, CLI, and cached runtime versions.
3. [x] Isolate all desktop-client state from the existing Bridge.
4. [x] Package the Bridge engine and required Node/lark-cli runtime.
5. [x] Create one client-managed workspace and Bot.
6. [x] Create an isolated Codex Home.
7. [x] Register a Feishu Bot with App ID/App Secret.
8. [x] Register a Feishu Bot through QR authorization.
9. [x] Embed the full current Feishu permission snapshot as advanced reference data and a separate recommended default policy.
10. [x] Verify tenant and user scopes separately.
11. [x] Guide remediation of missing Feishu permissions with an exact batch-import payload and direct application-console entry points; retain approval as an explicit Feishu-side step.
12. [ ] Verify the `im.message.receive_v1` subscription from a real message.
13. [x] Start a client-managed Bot.
14. [x] Stop a client-managed Bot with active-run protection.
15. [ ] Restart a client-managed Bot with active-run protection.
16. [x] Configure per-Bot auto-start.
17. [x] Recover an unexpectedly stopped client-managed Bot with backoff.
18. [x] Start the packaged client at Windows login.
19. [x] Keep the client running in the system tray.
20. [x] Discover existing Bridge instances read-only.
21. [x] Never adopt, stop, or rewrite a legacy Bot.
22. [ ] Show recent client-managed Bot errors and logs.
23. [ ] Open a client-managed Bot log folder.
24. [ ] Diagnose occupied ports and stale PID/state files.
25. [ ] Export a redacted diagnostic bundle.
26. [x] List every global Provider without returning plaintext keys.
27. [x] Show Provider Base URL, wire API, environment key, selected state, and key availability.
28. [x] Add a global Responses Provider.
29. [x] Pull and preview `/models`.
30. [x] Probe a model through `/responses`.
31. [x] Replace an existing Provider API Key only after validation.
32. [x] Preview global Provider synchronization.
33. [x] Apply Provider definitions only to client-managed isolated Codex Homes.
34. [x] Preserve target MCP configuration during Provider synchronization.
35. [x] Reject inline Provider secrets during synchronization.
36. [ ] Select and apply a global default Provider/model.
37. [ ] Edit or remove a global Provider definition safely.
38. [ ] Restart selected idle Bots after an environment-key replacement.
39. [x] Identify the approved non-GPT translation proxy and license.
40. [x] Bundle and supervise the approved translation proxy.
41. [x] Keep proxy credentials outside configuration files in Windows user environment variables.
42. [x] Allocate and diagnose proxy ports.
43. [ ] Verify one real non-GPT upstream end to end.
44. [x] Inventory global MCP servers and Skills.
45. [x] Preview selected MCP/Skill migration.
46. [x] Copy selected non-secret MCP definitions.
47. [x] Copy selected Skills.
48. [ ] Validate migrated MCP runtimes, imports, executables, and environment variables.
49. [ ] Run one minimal real call for each selected MCP.
50. [ ] Show migration conflicts and remediation actions in the UI.
51. [ ] Remove a migrated MCP or Skill from one client Bot.
52. [x] Batch-create workspaces and Bot drafts.
53. [x] Batch-register Feishu applications/Bots through a resumable serial QR queue.
54. [x] Apply one validated global Provider/model template to a space batch.
55. [ ] Apply an MCP/Skill template to a batch.
56. [x] Preview the complete batch plan before writing.
57. [ ] Roll back a partially failed batch operation.
58. [ ] Batch start, stop, and restart selected idle Bots.
59. [ ] Rename a client-managed Bot without breaking Profile/runtime references.
60. [x] Remove one client-managed Bot with an explicit residual-file preview.
61. [x] Remove one client-managed workspace only after ownership checks.
62. [x] Preserve user workspace content during Bot uninstall by default.
63. [x] Version and migrate persistent desktop data atomically.
64. [x] Report bundled dependency and protocol compatibility.
65. [ ] Complete clean-Windows install-to-first-reply E2E.
66. [ ] Complete installer upgrade, downgrade, and uninstall tests.
67. [ ] Sign the installer with Authenticode.
68. [x] Build and verify releases in GitHub Actions.
69. [x] Add an idle-aware client updater with rollback.
70. [ ] Test non-ASCII usernames, long paths, scaling, antivirus, and locked sessions.
71. [ ] Complete real Feishu dynamic-card, tool-call, and final-reply E2E.
72. [x] Detect Bot and user Lark CLI identities separately for every client-managed Bot.
73. [x] Launch per-Bot Lark CLI user OAuth from the client and verify the resulting user identity.
74. [x] Expose the required single event separately from the QR template's extra default events.
75. [x] Default permission import to Bridge messaging, cards, chat search, Docs, Drive, and Wiki without HR/payroll/admin scopes.
76. [x] Request only the recommended user scopes during Lark CLI OAuth.
77. [x] Verify packaged executable, installer, update metadata, and package versions match after every build.
78. [x] Complete a real in-place upgrade from an older installed client while preserving managed Bot data and restoring every idle Bot after the expected client/Bridge restart.
79. [x] Produce one unambiguous `out/latest` installer entry instead of requiring users to choose among historical artifacts.
80. [x] Verify the required Feishu message event from managed runtime evidence and show the latest verified time instead of a permanent warning.
81. [x] Let single-Bot creation explicitly choose either the global Codex Home or an existing isolated workspace space.
82. [x] Let a new isolated space initialize its shared `AGENTS.md` from the user's global Codex Home with visible source and destination paths.
83. [x] Keep the desktop sidebar fixed while only the main content area scrolls.
84. [x] De-emphasize user reauthorization after a Lark CLI user identity is already verified.
85. [x] Let Provider creation select Responses API or client-managed Chat Completions translation.
86. [x] Show the managed proxy version, health, endpoint, and actionable port/startup failures.
87. [x] Preview and remove one managed Bot while preserving its workspace by default.
88. [x] Preview and remove one isolated space together with all affected managed Bots.
89. [x] Never delete shared/global Codex Home data or Feishu cloud applications implicitly.
90. [x] Block a Release when the pinned protocol proxy or its MIT license is missing from the packaged client.

`0.1.6 Provider center` acceptance: items 26-35 are implemented; API keys never enter TOML, renderer state, IPC results, or logs; synchronization is previewable and transactional; only client-managed isolated Codex Homes are eligible; existing Bridge processes and legacy Bot files remain unchanged.

`0.1.9 Feishu capability completion` acceptance: QR registration remains the application-creation step; the post-registration panel must distinguish core Bot messaging from the full embedded permission target, copy a Feishu batch-import JSON containing all 1,098 tenant and 560 user scopes, open only the selected managed application's developer-console pages, launch `lark-cli auth login --domain all` against that Bot's isolated Profile, and verify user identity afterward. The client must not claim that permissions, administrator approval, event removal, publication, or user consent completed unless Feishu or Lark CLI verifies them. Existing Bridge source and legacy Bots remain untouched.

`0.1.10 Recommended Feishu permissions` acceptance: the normal workflow copies exactly 9 Bot/tenant scopes and 32 user scopes for Bridge messaging/cards, user-visible chat search/history, Docs, Drive, and Wiki. It excludes HR, payroll, recruiting, access control, organization-wide administration, and unrelated event domains. User OAuth requests the exact 32 user scopes through an ephemeral device flow and verifies the selected isolated Profile afterward. The 1,658-scope policy remains available to tests/reference but is neither the default readiness target nor the default clipboard payload.

`0.1.11 Upgrade integrity` acceptance: every Windows build fails unless the unpacked executable, versioned installer, and `latest.yml` agree with `package.json`; a byte-identical installer is copied to a single `out/latest` path with a version/hash manifest; and a real older installed client is upgraded in place after refusing active runs. Client-managed Bridge processes may restart with new PIDs, but every auto-start Bot and persistent configuration must recover within five minutes.

`0.1.12 Space completion and readiness` acceptance: a managed Bot with non-empty `state/seen-events.json` is shown as message-event verified with the file's last-update time; the single-Bot dialog requires either global configuration or one existing isolated space and inherits the selected space's Codex Home, Provider, and naming context without modifying existing members; new spaces can copy the visible global `AGENTS.md` into the shared isolated Codex Home without overwriting an existing target; the sidebar remains fixed while main content scrolls; and an already verified Lark CLI user identity no longer presents reauthorization as the primary action.

`0.2.0 GitHub distribution and updates` acceptance: a matching `v*` tag builds and tests the Windows x64 client on a clean GitHub runner and publishes the installer, blockmap, `latest.yml`, and checksums to a public stable Release; packaged clients display current/latest versions and download progress; installation is refused while any client-managed Bot has an active task; online managed Bots are stopped transactionally and restored after relaunch; legacy/script-managed Bots and persistent client data remain untouched. The release is explicitly described as unsigned until Authenticode signing is configured.

`0.3.0 Provider translation and managed removal` acceptance: the Provider center can validate and save either native Responses endpoints or OpenAI-compatible Chat Completions endpoints; Chat endpoints are routed through the pinned MIT-licensed `mimo2codex` runtime bundled and supervised by the desktop client, without storing API keys in TOML, proxy JSON, renderer state, IPC results, or logs. Bot and isolated-space removal always previews affected processes and paths, refuses active tasks, preserves user workspaces by default, never touches legacy Bots or Feishu cloud applications, and requires explicit confirmation before deleting client-owned runtime or isolated Codex Home data.

## 8. Verification strategy

Every phase records:

- Files changed.
- Unit, integration, packaging, and E2E commands.
- Expected and actual results.
- Existing Bridge PID and active-run evidence when relevant.
- Security and rollback review.
- Git commit and release artifact hashes.

The implementation plan is updated whenever product scope or acceptance criteria change. The execution log is updated in the same iteration as every meaningful implementation, verification, installation test, or discovered blocker.

The strongest practical verification must run before a phase is marked complete.

## 9. Main risks

1. Packaged engine differs from source-checkout behavior.
2. Update or supervision interrupts an active task.
3. Configuration migration copies secrets or invalid absolute paths.
4. Codex Desktop changes package/runtime layout.
5. Feishu permissions differ across tenants.
6. Unsigned installers trigger SmartScreen or antivirus warnings.
7. A bundled translation proxy has incompatible licensing, unstable protocol translation, port conflicts, or leaks Provider credentials.

These risks are addressed with protocol versioning, active-run guards, transactional writes, runtime inspection, scope checks, license review, DPAPI secret storage, proxy health supervision, clean-VM testing, and signed artifacts.
