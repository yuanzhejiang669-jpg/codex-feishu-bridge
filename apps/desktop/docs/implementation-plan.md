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
91. [x] Preview and remove one global Provider definition from global and client-managed isolated configuration files.
92. [x] Delete a Provider API Key only when no retained Provider or isolated space references the same environment variable.
93. [x] Remove a client-managed Chat Provider from the proxy registry and stop the proxy when no managed routes remain.
94. [x] Add independent select-all, clear-selection, and selected-count controls for MCP and Skills migration.
95. [x] Preserve unrelated TOML sections and comments during Provider removal and block deletion while a managed Bot still depends on it.
96. [x] Use one versioned model-reasoning capability registry across script-hosted and desktop-managed execution.
97. [x] Show requested, effective, and upstream reasoning values and reject known impossible combinations.
98. [x] Warn when a known capability rule is due for review and mark unknown models as unverified generic passthrough.
99. [x] Show every canonical request effort as a request-to-Codex-to-upstream mapping and mark the current request in `/model capability`.
100. [x] Make `/model effort` without a value show the current Provider/model mapping instead of a fixed generic effort list.
101. [x] Show reasoning choices as `user request -> model outcome` by default while retaining the internal Codex hop for diagnostics and tests.
102. [x] Discover Codex Homes dynamically from Bot bindings and the standard Codex Homes root instead of hard-coding current spaces.
103. [x] Present OpenAI official account login separately from dynamically discovered third-party Providers.
104. [x] Check ChatGPT login status and launch `codex login` with the exact selected `CODEX_HOME` without reading or copying credentials.
105. [x] Keep unowned Codex Homes visible but read-only across script-hosted and desktop-managed ownership boundaries.
106. [x] Refuse a model-source switch while any owned Bot in the selected Home has an active run.
107. [x] Clear persisted per-session Provider overrides when switching an entire Home so old sessions cannot silently retain the previous source.
108. [x] Preserve unrelated TOML sections and roll back config, session overrides, and process recovery after a failed switch.
109. [x] Recognize both user-environment credentials and client-managed encrypted Provider credentials.
110. [x] Verify the packaged `0.5.0` engine, public Release, installed upgrade, and both script-hosted devices.
111. [x] Bound OpenAI browser login jobs to ten minutes and expose the two-minute expiry warning to both control surfaces.
112. [x] Make a deliberate second login click terminate the exact stale login child before launching a fresh browser flow.
113. [x] Preserve each Home's unsubmitted Provider target, confirmation text, expanded state, and focused field across status refreshes.
114. [x] Keep the desktop client manual-refresh-first while retaining its two-second login-status polling without losing drafts.
115. [x] Present OpenAI official login as the primary local action and move whole-Home Provider switching into advanced management.
116. [x] Verify `0.5.1` packaging, public Release, current-device script panel, installed upgrade, and managed Bot recovery; intentionally defer the powered-off old device.
117. [x] Preserve the existing Windows launcher while adding a native macOS Bridge supervisor that does not depend on PowerShell.
118. [x] Discover the Codex macOS application and bundled CLI from system or per-user application locations with a PATH fallback.
119. [x] Bundle architecture-matched Node.js and Lark CLI executables for both Apple Silicon and Intel packages with upstream checksum verification.
120. [x] Store macOS Provider credentials through Electron safe storage backed by Keychain and hydrate only the client process environment.
121. [x] Support macOS login items, isolated Lark Profiles, Codex Homes, workspaces, managed Bot recovery, and active-run-aware stop.
122. [x] Produce separate macOS `arm64` and `x64` DMG/ZIP assets without changing Windows artifact names or persistent data paths.
123. [x] Replace the Windows-only tag workflow with a gated Windows/macOS build and one atomic GitHub Release publication job.
124. [x] Pass the cross-platform desktop test suite and rebuild the Windows `0.6.0` installer locally.
125. [x] Pass the clean GitHub macOS runner build and verify both unpacked application architectures and release assets.
126. [ ] Complete a real Mac install, Codex discovery, OpenAI/Provider login, Feishu registration, Bot start, and message E2E before calling macOS production-ready.
127. [x] Discover the current official `ChatGPT.app` bundle (`com.openai.codex`) as well as the legacy `Codex.app` name on system and per-user application paths.
128. [x] Install the updated Apple Silicon client on the physical Mac and verify official runtime discovery before Provider, Skill, MCP, and Bot provisioning.
129. [x] Provision the physical Mac ordinary and writing Codex Homes through an idempotent, credential-free bootstrap script without creating Feishu Bots.
130. [x] Validate `sub2api`, `lthome`, the Browser Control extension bridge, Firecrawl, Tavily, Git-backed writing Skills, and local writing Skills on the physical Mac.
131. [x] Replace the Windows-only Desktop Control limitation with a native macOS core backend that does not import `pywin32`, while preserving Windows UI Automation and tool contracts.
132. [x] Optionally keep a dedicated physical Mac and its display awake through a reversible user LaunchAgent without changing system-wide power settings.
133. [x] Require an explicit, validated trust action before an unbound discovered Codex Home becomes writable in the desktop client.
134. [x] Install and verify the official Google Chrome bundle on the physical Mac and verify Bing as its selected default without modifying protected browser preferences or extension security settings.
135. [x] Keep the macOS Lark event-bus Unix socket below the platform path limit through a validated short symlink to the existing isolated Profile Home; never move, copy, or recreate Profile credentials.
136. [ ] Verify all six physical-Mac Bots remain online and receive a real `im.message.receive_v1` event after the short-Profile-Home fix.
137. [x] Complete the physical-Mac Accessibility consent and pass window discovery plus non-destructive activation/input readiness checks alongside screen capture, clipboard, protocol, and both-Home registration.
138. [x] Refresh configured macOS Provider environment keys from the current `launchctl` login session on every Bot start so login-item ordering and temporary boot-time network loss cannot strand long-lived Bots with a stale environment snapshot.

`0.1.6 Provider center` acceptance: items 26-35 are implemented; API keys never enter TOML, renderer state, IPC results, or logs; synchronization is previewable and transactional; only client-managed isolated Codex Homes are eligible; existing Bridge processes and legacy Bot files remain unchanged.

`0.1.9 Feishu capability completion` acceptance: QR registration remains the application-creation step; the post-registration panel must distinguish core Bot messaging from the full embedded permission target, copy a Feishu batch-import JSON containing all 1,098 tenant and 560 user scopes, open only the selected managed application's developer-console pages, launch `lark-cli auth login --domain all` against that Bot's isolated Profile, and verify user identity afterward. The client must not claim that permissions, administrator approval, event removal, publication, or user consent completed unless Feishu or Lark CLI verifies them. Existing Bridge source and legacy Bots remain untouched.

`0.1.10 Recommended Feishu permissions` acceptance: the normal workflow copies exactly 9 Bot/tenant scopes and 32 user scopes for Bridge messaging/cards, user-visible chat search/history, Docs, Drive, and Wiki. It excludes HR, payroll, recruiting, access control, organization-wide administration, and unrelated event domains. User OAuth requests the exact 32 user scopes through an ephemeral device flow and verifies the selected isolated Profile afterward. The 1,658-scope policy remains available to tests/reference but is neither the default readiness target nor the default clipboard payload.

`0.1.11 Upgrade integrity` acceptance: every Windows build fails unless the unpacked executable, versioned installer, and `latest.yml` agree with `package.json`; a byte-identical installer is copied to a single `out/latest` path with a version/hash manifest; and a real older installed client is upgraded in place after refusing active runs. Client-managed Bridge processes may restart with new PIDs, but every auto-start Bot and persistent configuration must recover within five minutes.

`0.1.12 Space completion and readiness` acceptance: a managed Bot with non-empty `state/seen-events.json` is shown as message-event verified with the file's last-update time; the single-Bot dialog requires either global configuration or one existing isolated space and inherits the selected space's Codex Home, Provider, and naming context without modifying existing members; new spaces can copy the visible global `AGENTS.md` into the shared isolated Codex Home without overwriting an existing target; the sidebar remains fixed while main content scrolls; and an already verified Lark CLI user identity no longer presents reauthorization as the primary action.

`0.2.0 GitHub distribution and updates` acceptance: a matching `v*` tag builds and tests the Windows x64 client on a clean GitHub runner and publishes the installer, blockmap, `latest.yml`, and checksums to a public stable Release; packaged clients display current/latest versions and download progress; installation is refused while any client-managed Bot has an active task; online managed Bots are stopped transactionally and restored after relaunch; legacy/script-managed Bots and persistent client data remain untouched. The release is explicitly described as unsigned until Authenticode signing is configured.

`0.3.0 Provider translation and managed removal` acceptance: the Provider center can validate and save either native Responses endpoints or OpenAI-compatible Chat Completions endpoints; Chat endpoints are routed through the pinned MIT-licensed `mimo2codex` runtime bundled and supervised by the desktop client, without storing API keys in TOML, proxy JSON, renderer state, IPC results, or logs. Bot and isolated-space removal always previews affected processes and paths, refuses active tasks, preserves user workspaces by default, never touches legacy Bots or Feishu cloud applications, and requires explicit confirmation before deleting client-owned runtime or isolated Codex Home data.

`0.4.0 Provider removal and capability selection` acceptance: Provider deletion shows global configuration, managed-space, Bot, proxy, and environment-variable impact before confirmation; it refuses to break any client-managed Bot, preserves unrelated TOML content, removes managed proxy routes transactionally, and deletes a Windows user environment variable only when no retained definition references it. MCP and Skills each expose independent select-all, clear-selection, and selected/eligible counts; missing-path MCP entries remain unselected and disabled.

`0.4.1 Reasoning defaults and runtime clarity` acceptance: every new script-hosted or desktop-managed Bot defaults to requested `medium` reasoning unless the user explicitly selects another accepted effort; one offline, versioned registry maps that request to the selected model's effective Codex value and upstream meaning; known impossible combinations are rejected, unknown models are visibly marked unverified, rules older than the review interval are flagged, and existing Bot configuration is never rewritten. The system view distinguishes the Codex runtime entry executable from its containing directory and companion EXE count.

`0.4.2 Complete reasoning-map visibility` acceptance: `/model capability` lists every canonical request value in the stable `request -> Codex -> upstream` order, marks the current request, and visibly labels unsupported model-specific values without changing execution or persistence behavior. `/model effort` without a value renders the same current Provider/model-specific map and a concrete switching example instead of a fixed seven-value usage string. The script-hosted Bridge and packaged desktop engine use the same shared formatter and registry.

`0.4.3 Empty-reasoning watchdog compatibility` acceptance: a watchdog restart omits `-Reasoning` when the configured value is empty so the Bridge can fall back to session, environment, `config.toml`, or `medium`; an explicit reasoning value is still forwarded unchanged. Script-managed Bots must remain persistently online after remote synchronization through their existing scheduled watchdog tasks.

`0.4.3` delivery is complete: the source checkout, public GitHub Release, old-device script-managed deployment, current-device script-managed deployment, and installed Windows client are synchronized to the same fix. Persistent scheduled-task recovery, installed-client recovery, and the downloaded public installer checksum were independently verified.

`0.5.0 Model-source management` acceptance: user-facing reasoning capability cards show only the selected request and final model outcome; the diagnostic layer retains request, effective Codex effort, and upstream semantics. Both local control surfaces discover current and future Codex Homes dynamically, separate OpenAI official account login from third-party Provider selection, invoke the official runtime with the exact `CODEX_HOME`, never expose credentials, keep foreign/unbound Homes read-only, refuse active tasks, clear persisted session overrides, preserve unrelated Provider/MCP configuration, restart only owned online Bots, and roll back on failure.

`0.5.1 Login lifecycle and refresh safety` acceptance: an OpenAI login child is scoped to its exact Codex Home, expires after ten minutes, enters a visible warning state for its final two minutes, and is replaced only by a deliberate second login action. Login polling and ordinary script-panel refreshes must update server state without discarding an unsubmitted Provider target, confirmation text, advanced-section state, or focused field. Official login remains the primary action; whole-Home Provider switching is explicitly advanced administration, while daily switching is directed to Feishu.

`0.6.x macOS distribution` acceptance: one source tree preserves the verified Windows behavior and builds unsigned Intel and Apple Silicon macOS clients. Each Mac asset contains architecture-matched checksum-verified Node.js and Lark CLI tools, discovers the current `ChatGPT.app` (`com.openai.codex`) and legacy `Codex.app` names without fixed version paths, uses Keychain-backed safe storage, starts Bridge directly without PowerShell, uses native login items, and keeps client data outside the application bundle. A tag is publishable only after clean Windows and macOS jobs both pass. Unsigned Mac packages remain test releases: automatic in-app installation and production-ready claims are deferred until Developer ID signing, notarization, and a real-device Feishu message E2E pass.

`0.6.3 physical Mac bootstrap` acceptance: `bootstrap/install-macos-personal-environment.sh` can run repeatedly on Apple Silicon without overwriting existing configuration or skill paths, stores no credential, provisions `~/.codex` plus `~/Documents/Codex/codex-homes/codex-space-writing`, and records but does not create the six planned Bots. Provider keys and MCP key pools are transferred separately into permission-restricted local files. Git-backed writing Skills remain updateable through symlinks. Browser Control, Firecrawl, and Tavily must pass protocol and live checks. The current Windows-only Desktop Control must not be presented as available on macOS.

The physical-Mac Bridge supervisor must not expose the long desktop data root as Lark CLI `HOME` because the resulting per-App event-bus Unix socket exceeds the macOS path limit. It creates or validates `~/.cfb-lark-profile` as a symlink to the unchanged `~/Library/Application Support/CodexFeishuBridgeDesktop/profile-home` directory and passes only that short alias to Bridge children. An occupied or incorrectly targeted alias is a startup error; the client must never replace it. Windows keeps its existing Profile Home contract.

An unbound Codex Home remains read-only until the user explicitly selects `纳入客户端管理`. The backend accepts only a Home already present in discovery, requires an existing directory and parseable `config.toml`, and persists the decision in a permission-restricted registry outside the Home. A trusted Home can use official OpenAI login and whole-Home Provider switching without creating a Feishu Bot; Bot start/stop remains unavailable until a managed Bot is actually created and bound.

The optional `--install-chrome` bootstrap mode downloads Google's current universal stable DMG from `dl.google.com`, requires bundle ID `com.google.Chrome`, strict code-signature verification, Gatekeeper acceptance, and an arm64 executable before and after installation. It never bypasses quarantine or browser security settings. Chrome's default search engine is selected by the user in Chrome settings because editing protected profile preferences or installing a machine policy would be disproportionate and could overwrite an existing profile.

Browser Control on macOS is limited to its extension bridge until native application discovery accepts `.app` Chrome/Edge executables. The current direct-launch allowlist still requires `chrome.exe` or `msedge.exe`. Both Homes must share one permission-restricted extension token because the local extension bridge uses one loopback port; the unpacked extension requires one manual load in Chrome or Edge.

The optional `--keep-awake` mode installs a user-owned `LaunchAgent` for `/usr/bin/caffeinate -dimsu`, refuses to overwrite an existing same-name plist, and is verified through both `launchctl` and the live process. It is reversible by booting out and removing that one plist. The UI must state that permanent display and system wake assertions materially increase battery use and energy consumption.

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
8. An unsigned or unnotarized macOS bundle is blocked by Gatekeeper, or carries a helper binary for the wrong architecture.

These risks are addressed with protocol versioning, active-run guards, transactional writes, runtime inspection, scope checks, license review, DPAPI secret storage, proxy health supervision, clean-VM testing, and signed artifacts.
## 2026-07-18 - Reuse a pre-provisioned macOS Codex Home for the first space Bot

- Treat an existing space Home as reusable only when it is already present in the desktop trusted-Home registry and contains `config.toml`.
- In reuse mode, create only the Bot registration queue and per-Bot workspaces. Never rewrite the existing Home's `config.toml`, `AGENTS.md`, Skills, MCP configuration, or other contents.
- Validate that the selected Provider is already defined in the reused Home before creating the queue.
- Keep the existing new-space behavior unchanged when reuse mode is not selected.
- For the Mac rollout, create three global Bots against `~/.codex` and three writing Bots against the existing `codex-space-writing`; each Feishu application still requires an explicit user QR confirmation.

## 2026-07-18 - Physical Mac permission and capability audit

- Treat Feishu application scopes, user OAuth scopes, developer-console event subscriptions, and Bridge runtime event consumers as four separate evidence layers. Never infer the developer-console subscription list from the runtime listener.
- Show each managed Codex Home's existing MCP and Skill inventory when the user selects a target space. Preserve the global Home as the migration source and label an empty global Skill source explicitly.
- Follow only valid directory symlinks when discovering Skills. Report both the configured Skill path and its resolved source path so Git-backed and local shared sources remain visible without copying them.
- Keep the ordinary and writing Homes separate: ordinary Bots share `~/.codex`; writing Bots share `~/Documents/Codex/codex-homes/codex-space-writing`.

## 2026-07-18 - Safe macOS in-app update path and capability wording

- Permit `electron-updater` on packaged macOS only when the installed `.app` has a valid `Developer ID Application` signature and passes Gatekeeper execution assessment. Development, capture, smoke-test, ad-hoc, unsigned, and unnotarized builds remain disabled with a precise user-facing reason.
- Reuse the existing active-run guard, online-Bot snapshot, transactional stop, recovery marker, rollback, and post-update Bot restoration for both Windows and macOS. macOS consumes the existing `latest-mac.yml` and ZIP release metadata; it must not bypass Gatekeeper or install source from `main`.
- Configure release signing only through the complete GitHub Secret set `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. A partial set fails the release job. No certificate, password, Apple credential, or key is stored in the repository.
- Keep unsigned macOS builds available for development verification, but never label them auto-update capable. Production auto-update acceptance additionally requires an Apple Developer Program membership, a Developer ID Application certificate, successful notarization, and signed/notarized artifact checks in CI.
- Label the MCP/Skills page as a migration tool: the left inventory is the global Home migration-source candidate set, while a selected target shows its independently installed MCP/Skill inventory and resolved source paths. An empty global Skill source must not imply the writing Home has no Skills.

## 2026-07-18 - 0.7.0 signed stable-release gate

- Version the accumulated trusted-Home, existing-space reuse, macOS Lark Profile, capability inventory, and guarded macOS updater work as desktop `0.7.0`.
- A stable `v0.7.0` tag must fail closed unless all five Apple signing and notarization Secrets are configured. An unsigned macOS build remains suitable only for local verification and must never reach the stable update channel.
- Commit and push the reviewed source independently of the distribution tag. Create the tag only after Apple Developer Program access, a Developer ID Application certificate, notarization credentials, and CI artifact verification are available.
- Preserve the six physical-Mac Bot records, Profiles, workspaces, Codex Homes, and active processes; source publication does not replace the installed local overlay.

## 2026-07-18 - Native macOS Desktop Control and repeatable browser setup

- Keep the existing Desktop Control MCP tool names and Windows behavior while adding a native macOS backend for screen geometry, top-level window discovery, activation, screenshots, coordinate clicks, hotkeys, clipboard paste, and permission diagnostics.
- Use only macOS public user-session facilities (`screencapture`, System Events, AppleScript, and `pbcopy`/`pbpaste`) for the core backend. Never bypass Accessibility or Screen Recording consent; report each missing permission as an actionable diagnostic.
- Preserve OCR and visual detection as optional layers. Core macOS control must remain usable when heavyweight OCR or UI-model dependencies are absent.
- Register one shared Desktop Control program body in both the ordinary and writing Codex Homes, with separate per-Home output directories. Installation must be idempotent and must not rewrite unrelated Provider, MCP, Skill, or secret configuration.
- Keep the unpacked Browser Control extension as an explicit Chrome developer-mode installation. The bootstrap verifies the extension directory and token file, while the user performs Chrome's one-time `Load unpacked` confirmation.
- Acceptance requires Windows protocol/smoke regression tests plus physical-Mac MCP protocol status, window listing, screenshot, clipboard, and non-destructive permission checks. Pointer and keyboard mutation tests run only after macOS Accessibility consent is visible.

## 2026-07-20 - Split Windows release and macOS maintenance channels

- Publish only the Windows x64 installer, blockmap, update metadata, and checksums through the stable GitHub Release workflow.
- Maintain the physical Apple Silicon Mac directly through Tailscale and SSH. Transfer reviewed changes from the trusted Windows device, then build, install, and verify locally without requiring GitHub connectivity on the Mac.
- Do not publish unsigned or locally overlaid macOS artifacts in the stable Windows channel. A future public Mac distribution requires a separate, explicitly approved signing and notarization project.
- Preserve the same shared supervisor contract for ordinary and writing Bots while retaining platform-specific launchers: PowerShell on Windows and direct detached process groups on macOS.

## 2026-07-20 - Cross-Bot session deletion consistency

- Discover all registered Codex Homes and Bot state directories from the current runtime, instance configuration, and persisted launch configurations.
- Make `/list all` include bindings owned by other registered Bridge instances while retaining one stable entry per Codex thread.
- Delete a confirmed thread from every discovered Home's SQLite state, rollout storage, sidebar index, global state, desktop mirror, and Bridge binding.
- Write deletion tombstones to every discovered Home before physical cleanup so reconciliation and mirroring cannot restore a deleted thread.
- Refuse deletion when any registered Bot is actively using the thread, and repeat that check immediately before each batch item is removed.
- Lock batch selection to preview-time thread IDs. `/delete 2-9` followed by `/confirm delete 2-9` must remove exactly eight sessions without including item `1`.
- Deliver the same engine through Windows script deployment, Windows desktop `0.7.6`, GitHub source/Windows Release, and the SSH-maintained physical Apple Silicon Mac. The powered-off old Windows device remains excluded.

## 2026-07-20 - Codex Home session isolation correction

- Treat the resolved Codex Home as the visibility and deletion ownership boundary.
- Aggregate `/list all` bindings only from Bot state directories assigned to the current Home.
- Delete physical Codex records only from the current Home, while removing matching Bridge bindings from other Bots sharing that Home.
- Continue checking active runs across every registered Bot before deletion, including Bots in other Homes, so isolation does not weaken task protection.
- Disable cross-Home `desktopCodexHome` mirroring at runtime and make the workspace factory emit no mirror target for future spaces.
- Ship and validate Windows desktop `0.7.7` first. Update the physical Mac through Tailscale and SSH only after user acceptance; do not contact the powered-off old Windows device.
