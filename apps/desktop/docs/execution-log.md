# Codex Feishu Bridge Desktop Execution Log

This file is append-only. A node is complete only after its acceptance checks pass.

## Node 0 - Project boundary and reference baseline

Date: 2026-07-14

Status: completed

Goal:

- Confirm the existing Bridge repository is clean and synchronized.
- Update both reference checkouts to their upstream latest `main` commits.
- Define a desktop-only change boundary.

Results:

- Bridge repository remained at `00762ee2fb169ceffe7d81d81882ce0e17aca7ee`, matching `origin/main`.
- Proma updated/aligned to canonical `upstream/main` at `2a3d9b3776e5a940474fb12d1902a965fb891f04` (the personal `origin/main` fork is intentionally divergent and behind upstream).
- CC Connect updated/aligned to `72d6fb617d972966c7eb9080b012171ee45dd819`.
- No Bridge process, Bot, watchdog, workspace, production runtime state, or control-panel process was changed.

Reference decisions:

- Use Proma for Electron, IPC, installer, updater, workspace, MCP, and Skills patterns.
- Use CC Connect for embedded assets, release matrices, checksums, portable Bridge, and Windows supervision patterns.
- Do not replace the current Bridge engine with either project.

Files added by this node:

```text
apps/desktop/docs/implementation-plan.md
apps/desktop/docs/execution-log.md
```

Verification:

- `git status --short --branch` was clean before desktop files were added.
- Reference repository HEAD values were read after fast-forward updates.

Rollback:

- Remove `apps/desktop`; existing Bridge behavior is unaffected.

## Node 1 - Desktop foundation and read-only discovery

Date: 2026-07-14

Status: completed

Goal:

- Create an isolated Electron project.
- Show Codex and existing Bridge health without changing production state.
- Establish a narrow preload API and development-only data path.

Planned verification:

- Unit tests for environment parsing and allowed paths.
- Electron syntax/build check.
- Launch screenshot on desktop viewport.
- Existing Bridge PID and active-run files unchanged before and after launch.

Implementation:

- Added an isolated Electron 43.1.0 and electron-builder 26.15.3 project.
- Added context-isolated, sandboxed renderer IPC with no arbitrary shell or filesystem access.
- Added dynamic AppX/runtime/CLI/login inspection.
- Added read-only instance, PID, active-run, workspace, Codex Home, state, and log discovery.
- Added exact-path confinement before native folder opening.
- Added a desktop overview, Bot list, and system-path view.
- Added packaged smoke and screenshot modes that use development-only Electron state.

Verification results:

- Desktop syntax and unit tests: 5/5 passed.
- Existing Bridge suite: 41/41 passed.
- PowerShell Codex inspection found package `OpenAI.Codex_26.707.8479.0_x64__2p2nqsd0c76g0` and CLI `0.144.2`.
- electron-builder produced a Windows x64 unpacked application successfully.
- Packaged smoke test exited successfully.
- Packaged renderer screenshot showed 15 instances, 14 online Bots, and 1 active run.
- `codex-assistant-1` remained PID `8228`, with its original process start time and PID-file timestamp.

Generated verification artifact (ignored by Git):

```text
apps/desktop/out/desktop-foundation.png
apps/desktop/out/win-unpacked/
```

Known follow-up:

- The foundation build uses Electron's default icon. Product icon and signed installer work remain in the release phase.

## Node 2 - Packaged Bridge engine baseline

Date: 2026-07-14

Status: completed

Goal:

- Stage an allowlisted copy of the existing Bridge and production dependencies under client-generated resources.
- Bundle the official lark-cli Windows binary as a client dependency.
- Prove the packaged client contains a runnable engine without changing or starting production instances.

Implementation:

- Added deterministic allowlist staging for existing Bridge source and production dependencies.
- Added an engine manifest with source commit and protocol version.
- Bundled Node.js `24.18.0` so end users do not need a separate Node installation.
- Bundled official `lark-cli 1.0.69` and its MIT license.
- Downloaded and bundled the official Node.js `v24.18.0` license.
- Added an isolated packaged-engine health smoke that starts the embedded control panel under a disposable `LOCALAPPDATA`.
- Added deterministic SVG-to-PNG/ICO generation and configured the Windows installer icon.
- Added SHA-256 release checksum generation.

Verification results:

- Staged engine commit: `00762ee2fb169ceffe7d81d81882ce0e17aca7ee`.
- Staged Bridge entrypoint, control-panel entrypoint, and production dependencies exist.
- Packaged Node reports `v24.18.0`.
- Packaged lark-cli reports `1.0.69`.
- Packaged control-panel `/api/health` passed on isolated port `18329`.
- NSIS x64 installer was generated successfully.
- Production dependency audit: 0 vulnerabilities.
- Secret-pattern scan found no likely embedded credentials.

Release blocker:

- The local installer is not Authenticode signed. It is a development artifact and must not be published as a final release until a trusted code-signing workflow is configured.

## Node 3 - First-run inventory and configuration foundation

Date: 2026-07-14

Status: completed for the development build

Completed:

- Read-only workspace inventory from discovered Bots.
- Read-only MCP server inventory from global Codex `config.toml` table names.
- Read-only Skill inventory from global Codex `skills` directories containing `SKILL.md`.
- Renderer output escapes discovered names and paths before insertion.
- Transactional Bot and workspace creation in the desktop development sandbox.
- Existing Feishu App ID/Secret setup without persisting App Secret in Bot JSON.
- In-client Feishu QR registration with QR progress events.
- Isolated lark-cli Profile storage under the client data root.
- Shared or per-Bot isolated Codex Home selection.
- Packaged-engine start and active-run-aware stop for client-managed Bots.
- Preflight checks for duplicate Bot names and lark-cli Profiles.
- Explicit partial-success error if a Feishu app is created but local setup fails.

Verification:

- Desktop syntax/unit/integration tests: 19/19 passed.
- Real isolated lark-cli Profile add/list smoke passed and its temporary directory was removed.
- Fake packaged PowerShell start contract produced and confirmed a live PID.
- Packaged desktop smoke exited with code 0.
- Final Bot setup screenshot passed visual inspection at the packaged desktop viewport.

Remaining release validation:

- Real clean-machine Feishu end-to-end validation.

## Node 4 - Selective MCP and Skills migration

Date: 2026-07-14

Status: completed for isolated Codex Homes

Implementation:

- Added structural TOML parsing with `smol-toml`.
- Added selectable MCP and Skills migration into a client-managed isolated Codex Home.
- Added preview states for ready, missing, existing, and blocked-sensitive items.
- Blocked automatic MCP copying when nested keys contain Secret, Token, Password, Credential, or API Key data.
- Added staged Skill copies, atomic configuration replacement, and rollback.
- Rejected migration into a shared Codex Home.
- Overrode the Feishu SDK transitive Axios dependency to patched `1.16.0`.

Verification:

- Safe MCP and Skill migration test passed.
- Inline-secret non-copy test passed.
- Shared Codex Home rejection test passed.
- Production dependency audit: 0 vulnerabilities.

Remaining:

- Selective Provider preview/apply workflow.
- User-supplied secret re-entry workflow for blocked MCP definitions.

## Node 5 - Development installer and adversarial review

Date: 2026-07-14

Status: development artifact completed; final release blocked

Artifact:

```text
apps/desktop/out/Codex Feishu Bridge Setup 0.1.0.exe
Size: 164924075 bytes
SHA-256: 5965DC039CE87389DE99F7DFD84A8600C31102327E343C218F720079A072BF63
Authenticode: NotSigned
```

Verification:

- Desktop tests: 19/19 passed.
- Existing Bridge tests: 41/41 passed.
- Packaged desktop smoke: passed.
- Packaged Bridge engine health smoke: passed on isolated port 18329.
- Production dependency audit: 0 vulnerabilities.
- `git diff --check`: passed.
- Existing Bridge source and production Bot processes were not restarted or reconfigured.

Adversarial review and fixes:

1. Three-month failure: QR registration creates a remote app but local setup collides with an existing Profile. Fix: Profile conflict is checked before QR creation and partial remote/local success is reported explicitly.
2. Three-month failure: a desktop stop action interrupts an active Codex turn. Fix: the supervisor reads shaped `active-runs.json` state and refuses stop while any run is active.
3. Three-month failure: selective MCP migration silently copies credentials. Fix: nested sensitive keys block automatic copying, the preview names blocked MCP entries, and tests verify the secret is absent from the target config.

Release blockers:

- Obtain and configure a trusted Windows code-signing certificate.
- Run real Feishu QR/create/send/receive/card E2E on a clean Windows VM.
- Complete Provider migration, read-only legacy visibility, updater, upgrade/downgrade, and uninstall validation.

## Node 6 - Installed alpha review and desktop-task Bridge boundary

Date: 2026-07-14

Status: reviewed; blockers recorded

Boundary decision:

- The existing Codex Feishu Bridge remains unchanged throughout desktop-client work.
- Desktop implementation remains under `apps/desktop`.
- Existing Bots are read-only observations and are never adopted, reconfigured, restarted, or stopped by the client.
- The desktop supervisor may operate only instances created and owned by the desktop client.
- Compatibility logic required only by the client must be implemented as an adapter under `apps/desktop`, not smuggled into the existing Bridge.
- The Bridge is not frozen: independent Bridge bug fixes and feature work remain allowed when separately requested, reviewed, tested, and synchronized outside the desktop-client task.

Installed alpha observations:

- The NSIS installer completed and installed under `%LOCALAPPDATA%\Programs\Codex Feishu Bridge`.
- The packaged application launched and discovered the existing Codex runtime and 15 Bridge entries.
- The desktop reported 14/15 online while the legacy control panel reported the root `default` Bot online. The desktop default-instance discovery is incomplete and must be fixed in the desktop adapter only.
- The desktop reported OpenAI signed-out. This is not a valid readiness failure when Codex uses a configured third-party Provider; Provider readiness must replace official-login status as the actionable check.
- The Bot form displayed example text as placeholders, which looked like entered values. QR registration therefore received an empty Bot ID, failed local validation before contacting Feishu, and left a stale QR loading panel. No remote Feishu app should have been created by that attempt.

New release blockers:

- Fix required-field defaults, client-side validation, friendly IPC errors, and QR loading cleanup.
- Add third-party Provider discovery, configuration, secret handling, and a minimal real model request.
- Correct read-only root `default` Bot discovery without changing the existing Bridge.
- Complete a clean-machine sequence from installation through Feishu send/receive/card response.

Repository verification:

- Existing Bridge HEAD remained `00762ee2fb169ceffe7d81d81882ce0e17aca7ee`, matching `origin/main`.
- Repository status contained only the additive untracked `apps/` tree.
- No existing Bridge source file was modified by this documentation update.

## Node 7 - Isolated client runtime and third-party Provider onboarding

Date: 2026-07-14

Status: implementation completed; real Feishu E2E pending

Implementation:

- Bumped the desktop client from `0.1.0` to `0.1.1` for in-place NSIS upgrade.
- Moved all installed client metadata to `%LOCALAPPDATA%\CodexFeishuBridgeDesktop`.
- Moved client-managed Bridge runtime state beneath `%LOCALAPPDATA%\CodexFeishuBridgeDesktop\runtime-localappdata` so it cannot overlap the existing `%LOCALAPPDATA%\CodexFeishuBridge` runtime.
- Added read-only discovery of the root `default` Bridge instance and ignored a stale `instances/default` duplicate.
- Replaced placeholder-only Bot identity with a real, collision-aware suggested value.
- Added renderer validation before QR registration, removed raw Electron IPC prefixes, and cleared failed QR loading state.
- Replaced the misleading installed labels `正式模式` and `正式配置` with `已安装客户端` and `写入客户端独立数据`.
- Added current third-party Provider inspection so official OpenAI login is reported as unnecessary when a configured third-party Provider is selected.
- Added first-run custom Responses Provider fields for Provider ID, Base URL, model, reasoning effort, and API Key.
- Added an explicit minimal `/responses` model request before Bot registration.
- Added Windows DPAPI encryption through Electron `safeStorage`; the plain Provider API Key is absent from Bot JSON, Codex TOML, logs, and user environment variables.
- Injected the decrypted API Key only into the child environment of the client-managed Bot.
- Fixed release checksum generation to include only the current package version.

Verification:

- Desktop syntax/unit/integration tests: 25/25 passed.
- Existing Bridge tests: 41/41 passed without source changes.
- Packaged desktop smoke: passed.
- Packaged Bridge engine health smoke: passed on isolated port `18329`.
- Production dependency audit: 0 vulnerabilities.
- Packaged Bot setup screenshot passed visual inspection with a real suggested Bot ID and Provider fields.
- Existing Bridge HEAD remained `00762ee2fb169ceffe7d81d81882ce0e17aca7ee`, matching `origin/main` with no tracked diff.
- `codex-assistant-1` remained PID `8228`, start time `2026-07-14T13:43:02.5310318+08:00`.
- `%LOCALAPPDATA%\CodexFeishuBridgeDesktop` did not exist after automated tests, proving the packaged smoke and screenshot did not create installed client state.

Artifact:

```text
apps/desktop/out/Codex Feishu Bridge Setup 0.1.1.exe
Size: 164927256 bytes
SHA-256: BF0D90CA0D026EAEC8A171B16C3BCCBD9E8AD4996F91858F8B2D3174B8884D2D
Authenticode: NotSigned
```

Adversarial review and fixes:

1. Three-month failure: client-owned runtime collides with an existing Bridge instance. Fix: metadata, lark Profiles, transactions, cached Codex runtime, PID state, and logs now live under the separate desktop root.
2. Three-month failure: a copied or logged API Key leaks from configuration. Fix: DPAPI ciphertext is stored beside the client-managed Bot, plaintext is injected only into its child process, and integration tests scan JSON/TOML for absence of the key.
3. Three-month failure: release checksums validate an older installer left in `out`. Fix: checksum generation selects artifacts using the exact current `package.json` version.

Remaining release blockers:

- Install `0.1.1` over `0.1.0` and complete one real Provider test, Feishu QR registration, client-managed Bridge start, Feishu message, dynamic card, and final reply.
- Add startup preference and recovery for client-managed Bots.
- Add signed GitHub Actions release and clean-VM install/upgrade/uninstall coverage.

## Node 8 - Public distribution and non-GPT proxy gap audit

Date: 2026-07-14

Status: public general-availability release blocked

Findings:

- `0.1.1` is suitable only as an explicitly labeled alpha artifact for controlled testing, not as a download-and-use release for all Windows users.
- The desktop client accepts a Provider that already exposes an OpenAI-compatible Responses API.
- The desktop client does not contain, install, launch, configure, supervise, or update the `mimo2codex` translation proxy referenced by the legacy control panel on ports `8788` and `8789`.
- `http-proxy-agent`, `https-proxy-agent`, and `proxy-from-env` entries in `package-lock.json` are transitive networking dependencies, not a model-protocol translation proxy.
- The actual `mimo2codex` source or binary was not found under `C:\Users\yzjiang\Documents\Codex`; its repository/path and license must be identified before integration.

Required before general availability:

- Bundle or separately install the approved non-GPT translation proxy with license compliance.
- Add client-owned proxy configuration, DPAPI credentials, port allocation, start/stop, health, logs, crash recovery, and update behavior.
- Validate at least one real non-GPT upstream model through proxy translation, Codex app-server, Bridge, Feishu dynamic card, and final reply.
- Complete clean-Windows install/upgrade/uninstall E2E and trusted Authenticode signing.

## Node 9 - Functional-client scope clarification

Date: 2026-07-14

Status: scope updated

Current milestone:

- A Windows user who already has the installer can install the desktop client and deploy a new Codex Feishu Bridge environment, workspace Bot, Provider, Feishu application/Profile, and client-managed Bridge without source checkout or manual scripts.
- GitHub publishing, public distribution, Authenticode signing, and automatic client updates are deferred release-engineering work and are excluded from the functional-client completion estimate.

Functional acceptance remains:

```text
Install provided client
-> detect local Codex
-> configure direct Responses Provider or managed non-GPT proxy
-> create workspace and isolated Codex Home
-> register Feishu Bot/Profile
-> start client-managed Bridge
-> send a Feishu message
-> receive dynamic progress card and final reply
-> recover the client-managed Bot after Windows restart
```

## Node 10 - Data migrations, QR lifecycle, and compatibility view

Date: 2026-07-14

Status: completed

Implementation:

- Bumped the desktop client from `0.1.1` to `0.1.2` for in-place NSIS upgrade.
- Added desktop data Schema version `1` in `desktop-state.json`.
- Added ordered, atomic, idempotent migration execution with explicit rollback actions and temporary transaction cleanup.
- Added rejection for data written by a newer unsupported client.
- Added app-version recording even when the data Schema does not change.
- Blocked Bot creation, QR registration, client-managed Bot start/stop, and capability writes when desktop data initialization fails.
- Refactored Feishu QR registration for dependency injection without changing the production SDK path.
- Added automated QR tests for success, cancellation, timeout, empty QR URL, and remote-success/local-save failure.
- Added a System compatibility view covering Bridge engine protocol, bundled Node.js, bundled lark-cli, Codex runtime, current Provider, data Schema, and client runtime isolation.
- Added packaged screenshot routing for deterministic Bot-setup and System-page visual verification.

Verification:

- Desktop syntax/unit/integration tests: 39/39 passed.
- Existing Bridge tests: 41/41 passed without source changes.
- Production dependency audit: 0 vulnerabilities.
- Packaged desktop smoke: passed.
- Packaged Bridge engine health smoke: passed on isolated port `18329`.
- Bot setup and System compatibility screenshots passed visual inspection without overlap.
- Existing Bridge HEAD remained `00762ee2fb169ceffe7d81d81882ce0e17aca7ee`, matching `origin/main` with no tracked diff.
- `codex-assistant-1` remained PID `8228`, start time `2026-07-14T13:43:02.5310318+08:00`.

Artifact:

```text
apps/desktop/out/Codex Feishu Bridge Setup 0.1.2.exe
Size: 164929851 bytes
SHA-256: 2476F378F2227725B90E5647A875D3C34A0DE8CB7A32BAEF5EF2B3FC2212223A
Authenticode: NotSigned
```

Adversarial review and fixes:

1. Three-month failure: a client upgrade leaves half-migrated state or silently opens newer data. Fix: ordered Schema migration, atomic state replacement, rollback, idempotence tests, and newer-version rejection.
2. Three-month failure: QR registration hangs, expires, or creates a remote app before local failure without a distinguishable state. Fix: bounded timeout/cancel handling and five explicit lifecycle tests with separate partial-success errors.
3. Three-month failure: bundled dependency or Bridge protocol drift reaches users unnoticed. Fix: a visible compatibility assessment with hard failures for unsupported protocol, missing runtime, old bundled tools, invalid Schema, or broken runtime isolation.

Remaining functional blockers:

- Complete one real Provider, Feishu QR, client-managed Bridge, dynamic-card, and final-reply E2E.
- Add Windows startup preference and crash recovery for client-managed Bots.
- Identify and integrate the approved non-GPT translation proxy.

## Node 11 - Bot readiness and truthful Feishu verification states

Date: 2026-07-14

Status: completed

Implementation:

- Bumped the desktop client from `0.1.2` to `0.1.3` for in-place NSIS upgrade.
- Added a client-managed Bot readiness service and narrow IPC endpoint.
- Added server-verified Feishu Bot identity checks through the Bot identity, never through user-login state.
- Added app-scope inspection that reports the returned count without claiming that every optional tool permission is complete.
- Kept `im.message.receive_v1` explicitly marked as pending until a real Feishu message completes E2E verification.
- Added separate checks for the selected Provider, Codex runtime, bundled Bridge/Node/lark-cli engine, and client-owned Bridge process.
- Added concise Chinese handling for known lark-cli Profile errors instead of rendering raw JSON envelopes.
- Suppressed lark-cli update and Skills notifier output in isolated Profile subprocesses so machine-readable JSON remains stable.
- Moved client-managed Bots before read-only legacy Bots so the `检查` and `启动` actions remain immediately visible.
- Added an isolated capture-data root for packaged visual tests; production client data is not used for visual fixtures.

Verification:

- Desktop syntax/unit/integration tests: 47/47 passed.
- Existing Bridge syntax/static/unit tests: 41/41 passed without source changes.
- Production dependency audit: 0 vulnerabilities.
- Packaged Bridge engine health smoke: passed on isolated port `18329`.
- Bot list and readiness-panel screenshots passed visual inspection at the desktop viewport without overlap.
- Existing Bridge HEAD remained `00762ee2fb169ceffe7d81d81882ce0e17aca7ee`, matching `origin/main` with no tracked diff.
- `codex-assistant-1` remained PID `8228`, start time `2026-07-14T13:43:02.5310318+08:00`.

Artifact:

```text
apps/desktop/out/Codex Feishu Bridge Setup 0.1.3.exe
Size: 164932151 bytes
SHA-256: 48AB8E660AAD41AEE958B5BF40D8A1EE4171EF80E9D5F97BE2FE01BC9631ADD3
Authenticode: NotSigned
```

Adversarial review and fixes:

1. Three-month failure: lark-cli notifier text intermittently corrupts readiness JSON. Fix: isolated lark subprocesses now disable update and Skills notifiers, with an environment-contract test.
2. Three-month failure: zero scopes or an unavailable current Provider is shown as healthy. Fix: zero scopes remain pending, and current third-party credentials or OpenAI login are checked explicitly.
3. Three-month failure: visual tests silently read production client data or raw CLI errors make the result unusable. Fix: packaged capture supports an explicit isolated data root, and known configuration envelopes are reduced to concise user-facing messages.

Remaining functional blockers:

- Install `0.1.3`, create one real client-managed Bot, and complete Feishu message, dynamic-card, tool-call, and final-reply E2E.
- Add Windows startup preference and crash recovery for client-managed Bots.
- Add the batch workspace factory and permission remediation workflow.
- Identify and integrate the approved non-GPT translation proxy.

## Node 12 - Windows startup, tray, and client-Bot recovery

Date: 2026-07-14

Status: completed for packaged client-managed Bots

Implementation:

- Bumped the desktop client from `0.1.3` to `0.1.4` for in-place NSIS upgrade.
- Added atomically written desktop settings with conservative defaults: Windows login startup disabled and close-to-tray enabled.
- Added packaged Windows login startup using the installed executable and the `--background` argument.
- Added a system tray menu for reopening or explicitly exiting the client.
- Added per-client-Bot auto-start controls; enabling a Bot also enables Windows login startup.
- Added client-Bot recovery with one start attempt per tick and exponential backoff from 30 seconds to 15 minutes.
- Limited recovery to offline Bots created by this desktop client with `autoStart: true`; legacy Bots remain read-only.
- Made manual stop disable Bot auto-start so an intentionally stopped Bot is not immediately recovered.
- Restored the previous auto-start setting when manual stop fails.
- Added the Windows settings and recovery summary to the System page.

Verification:

- Desktop syntax/unit/integration tests: 58/58 passed.
- Existing Bridge syntax/static/unit tests: 41/41 passed without source changes.
- Production dependency audit: 0 vulnerabilities.
- Packaged Bridge engine health smoke: passed on isolated port `18329`.
- Isolated Bot-list and System-page screenshots passed visual inspection without overlap or clipped controls.
- Existing Bridge HEAD remained `00762ee2fb169ceffe7d81d81882ce0e17aca7ee`, matching `origin/main` with no tracked diff outside `apps/desktop`.
- `codex-assistant-1` remained PID `8228`; it was not restarted, stopped, adopted, or reconfigured.

Adversarial review and fixes:

1. Three-month failure: Windows login starts the wrong executable or opens a duplicate foreground window. Fix: startup is restricted to packaged Windows, uses the actual executable path plus `--background`, and is covered by a focused startup contract test.
2. Three-month failure: repeated Bot crashes cause a tight restart loop or affect legacy Bots. Fix: recovery sees only client-owned Bot metadata, attempts one offline Bot per tick, and backs off failures from 30 seconds to 15 minutes.
3. Three-month failure: manually stopping an auto-start Bot causes immediate recovery, or a failed stop silently loses the setting. Fix: manual stop transactionally disables auto-start, restores it on failure, and has success/failure regression tests.

Artifact:

```text
apps/desktop/out/Codex Feishu Bridge Setup 0.1.4.exe
Size: 164935111 bytes
SHA-256: 27334D1F1A13ECE75CC6FC1D33F6F6E70F831FCB164CD06B51E8DA76F95B47B9
Authenticode: NotSigned
```

Remaining functional blockers:

- Install `0.1.4` and complete one real client-managed Provider, Feishu QR registration, Bridge start, message, dynamic-card, tool-call, and final-reply E2E.
- Add the batch workspace factory and permission remediation workflow.
- Identify and integrate the approved non-GPT translation proxy.

## Node 13 - Embedded full Feishu permission policy

Date: 2026-07-15

Status: completed; clean-user permission remediation remains follow-up work

Implementation:

- Bumped the desktop client from `0.1.4` to `0.1.5`.
- Replaced the runtime baseline-Profile concept with a versioned permission policy embedded under `apps/desktop`.
- Captured every unique permission currently granted to `codex-assistant-1`: 1,098 tenant scopes and 560 user scopes.
- Fixed `im.message.receive_v1` as the only required Bridge event.
- Added a raw Bot-identity check through `GET /open-apis/application/v6/scopes` and compared tenant/user grants separately.
- Made any missing embedded permission a blocking readiness failure and included missing counts plus representative names in the result.
- Recorded the permission-policy ID and counts in newly created Bot metadata and exposed the current policy on the System page.
- Kept event delivery pending until a real Feishu message completes E2E validation; the API does not prove that the event subscription is functioning.

Verification completed before packaging:

- Desktop syntax/unit/integration tests: 62/62 passed.
- Real `codex-assistant-1` comparison: tenant 1,098/1,098, user 560/560, missing 0.
- The embedded policy contains no runtime dependency on an existing Bot or Profile.

Adversarial review and fixes:

1. Three-month failure: a long permission snapshot is silently truncated during generation. Fix: regenerated it through compressed in-memory transfer and added tests rejecting truncation markers and abnormally long scope names.
2. Three-month failure: a scope with the same name in tenant and user identity is treated as one permission. Fix: comparison uses separate tenant/user sets and tests remove one permission from each identity independently.
3. Three-month failure: a new Bot returns a non-empty scope list but still lacks hundreds of required grants. Fix: readiness now performs exact set comparison against all 1,658 embedded permissions instead of accepting a positive count.

Artifact:

```text
apps/desktop/out/Codex Feishu Bridge Setup 0.1.5.exe
Size: 164942642 bytes
SHA-256: 47412BF3D39A8604AD9A1D88577E15E4097282E84B85D9A17AA7553E047D86DB
Authenticode: NotSigned
```

Remaining functional blockers:

- Add a user-facing remediation flow for permissions that Feishu does not grant during QR registration.
- Complete a real clean-user QR, permission, event, Bridge, dynamic-card, tool-call, and final-reply E2E.
- Add the batch workspace factory and Provider management center.

## Node 14 - Provider center and transactional global synchronization

Date: 2026-07-15

Status: completed for global Responses Providers and client-managed isolated Codex Homes

Implementation:

- Bumped the desktop client from `0.1.5` to `0.1.6`.
- Added a dedicated Provider center that lists every global Provider and shows Base URL, wire API, environment-variable name, selected state, and credential availability without returning plaintext keys.
- Added UI and isolated IPC operations for `/models` preview, `/responses` probe, global Provider creation, and validated replacement of an existing Provider key.
- Stored global Provider keys in Windows user environment variables and kept key values out of TOML, renderer state, IPC results, and logs.
- Added Provider synchronization preview/apply for desktop-client Bots using isolated Codex Homes only.
- Preserved target MCP configuration and skipped Provider definitions containing top-level or nested inline secret fields.
- Made multi-target synchronization transactional: a later write failure restores every earlier target to its exact original text.
- Fixed environment-variable rollback so a previously absent key is removed rather than persisted as an empty user variable.
- Persisted the 71-item functional-parity backlog in the implementation plan.

Verification:

- Desktop syntax/unit/integration tests: 69/69 passed.
- Existing Bridge syntax/static/unit tests: 41/41 passed without source changes.
- Production dependency audit: 0 vulnerabilities.
- Packaged desktop smoke: passed.
- Packaged Bridge engine health smoke: passed on isolated port `18329`.
- Packaged Provider-page screenshot passed visual inspection; long Provider names wrap without overlapping adjacent fields.
- Existing Bridge `HEAD` remained `00762ee2fb169ceffe7d81d81882ce0e17aca7ee`, matching `origin/main` with no tracked change outside `apps/desktop`.
- `codex-assistant-1` remained PID `8228`, start time `2026-07-14 13:43:02`; it was not restarted, stopped, adopted, or reconfigured.

Artifact:

```text
apps/desktop/out/Codex Feishu Bridge Setup 0.1.6.exe
Size: 164947236 bytes
SHA-256: C3D1287027CDBD29D98DFD6F9783CF4FE342AFE61799BC77A3E6CBB9C0756123
Authenticode: NotSigned
```

Adversarial review and fixes:

1. Three-month failure: adding a Provider updates the user key, then the TOML write fails and leaves an unexpected empty or new credential behind. Fix: true user-environment deletion on rollback plus a focused write-failure test.
2. Three-month failure: synchronizing several Bots fails midway and leaves different Provider definitions across Bots. Fix: whole-batch rollback to exact original config text plus a two-target failure regression test.
3. Three-month failure: a Provider hides a key in nested headers or synchronization reaches a shared/legacy Codex Home. Fix: recursive sensitive-field detection and tests proving nested authorization data is skipped while shared Codex Homes remain untouched.

Remaining functional blockers:

- Add permission remediation for clean-user Feishu applications.
- Add the batch workspace/Bot factory and batch lifecycle controls.
- Identify and integrate the approved non-GPT translation proxy.
- Complete clean-Windows real Feishu message, dynamic-card, tool-call, and final-reply E2E.

## Node 15 - Resumable workspace and Bot factory

Date: 2026-07-15

Status: completed for one-or-many Bot planning and serial Feishu QR registration

Implementation:

- Bumped the desktop client from `0.1.6` to `0.1.7`.
- Added a workspace factory to the Workspaces page with space name/slug, Bot count `1-16`, start index, Bot/display-name templates, global Provider/model, reasoning effort, brand, and shared Codex Home name.
- Added a read-only preview that expands `{index}`, `{slug}`, and `{space}`, and reports all Bot-name, workspace, and Codex Home conflicts before writing.
- Initialized one isolated Codex Home per logical space while creating a distinct workspace, Profile, Feishu application, metadata record, and process identity for every Bot.
- Added a persistent serial QR queue. Each Bot is selected and scanned separately because Feishu creates one application per Bot.
- Kept App Secret, token, and API Key out of the queue. The shared space config references a validated global Provider through its environment-variable name only.
- Recorded the actual global Provider/model reference in each created Bot so readiness checks do not incorrectly report the current global default.
- Converted registrations interrupted by client exit from `registering` to an explicit failed/interrupted state instead of displaying a permanently active operation.
- Left existing Bridge instances and legacy Bots read-only; no current process was restarted or reconfigured.

Verification:

- Desktop syntax/unit/integration tests: 74/74 passed.
- Existing Bridge syntax/static/unit tests: 41/41 passed without source changes.
- Production dependency audit: 0 vulnerabilities.
- Packaged desktop smoke: passed.
- Packaged Bridge engine smoke: passed on isolated port `18329`.
- Electron workspace-factory screenshot passed visual inspection without clipped fields or overlap.
- Existing Bridge `HEAD` remained `00762ee2fb169ceffe7d81d81882ce0e17aca7ee`, matching `origin/main`.
- `codex-assistant-1` remained PID `8228`, start time `2026-07-14 13:43:02`.

Artifact:

```text
apps/desktop/out/Codex Feishu Bridge Setup 0.1.7.exe
Size: 164950540 bytes
SHA-256: B6F328770AFC0AF35AE3E8CF0508205D8A0D8BA5DC87A281AE610044DE221587
Authenticode: NotSigned
```

Adversarial review and fixes:

1. Three-month failure: a batch queue leaks credentials or copies a Provider containing hidden authorization headers. Fix: the queue contains only public references, keys remain in user environment variables, and recursive sensitive-field rejection is tested.
2. Three-month failure: the client exits during QR registration and forever displays that Bot as active. Fix: interrupted `registering` entries reopen as an explicit failed state with a Feishu-console reconciliation warning.
3. Three-month failure: a space uses Provider B while readiness reports global Provider A. Fix: each created Bot records its actual global Provider/model/env-key reference and readiness evaluates that reference.

Remaining functional blockers:

- Add permission remediation after each newly registered Feishu application.
- Add batch lifecycle actions for starting/stopping selected idle Bots and safe space removal.
- Add batch MCP/Skill template application during space initialization.
- Complete a real multi-Bot Feishu QR, permission, start, message, card, tool-call, and reply E2E.

## Node 16 - Truthful capability inventory and path-visible operations

Date: 2026-07-15

Status: completed

Implementation:

- Bumped the desktop client from `0.1.7` to `0.1.8`.
- Replaced regex MCP-header scanning with structural TOML parsing. Nested `env` and `tools` tables no longer appear as fake MCP servers; the current machine now reports the real five servers instead of eight rows.
- Added absolute MCP config, config-section, command, runtime-entry, and environment-variable-name metadata without returning environment-variable values.
- Added absolute Skill directory and `SKILL.md` paths.
- Added open/copy path actions guarded by the main-process exact known-path allowlist.
- Grouped capability migration targets by shared isolated Codex Home and exposed source paths, target paths, and every affected Bot in preview results.
- Unified single-Bot defaults as `codex-assistant-N` / `Codex助手N`; workspace Bots remain `codex-assistant-N-slug` / `Codex助手N-空间`.
- Made saved global Provider reuse the default single-Bot flow while preserving custom Responses API and shared-current-home modes.
- Added final workspace, Codex Home, Bot metadata, Profile data, runtime, and log path preview before Bot creation.
- Combined Bot status views with explicit `客户端管理` and `现有只读` ownership, excluding duplicate names.

Verification:

- Desktop syntax/unit/integration tests: 75/75 passed.
- Existing Bridge syntax/static/unit tests: 41/41 passed without source changes.
- Current structural inventory: 5 MCP servers and 3 Skills, with all expected absolute runtime/entry paths resolved.
- Production dependency audit: 0 vulnerabilities.
- Packaged desktop smoke: passed.
- Packaged Bridge engine smoke: passed on isolated port `18329`.
- MCP/Skills and single-Bot setup screenshots passed visual inspection at desktop size with long paths wrapping without overlap.
- Existing Bridge `HEAD` remained `00762ee2fb169ceffe7d81d81882ce0e17aca7ee`, matching `origin/main`.
- `codex-assistant-1` remained PID `8228`, start time `2026-07-14 13:43:02`.

Artifact:

```text
apps/desktop/out/Codex Feishu Bridge Setup 0.1.8.exe
Size: 164954647 bytes
SHA-256: 0A91D0A40B7B8077BBC64C5882DC1F1F9D9569E8ED962640D22B0B78E5673592
Authenticode: NotSigned
```

Adversarial review and fixes:

1. Three-month failure: nested MCP tables are counted as independent servers and copied under fake names. Fix: structural TOML inventory plus a regression fixture containing nested `tools` and `env` tables.
2. Three-month failure: a renderer path button opens or copies an arbitrary filesystem path, or capability state exposes secret values. Fix: exact main-process known-path validation and public metadata limited to environment-variable names; tests verify secret values are absent.
3. Three-month failure: six workspace Bots sharing one Codex Home are shown as six independent migration targets, causing repeated or misleading writes. Fix: UI grouping by normalized Codex Home and backend preview returning every affected Bot; the migration test covers two Bots sharing one target.

Remaining functional blockers:

- Pull and probe the selected global Provider/model directly inside single-Bot and workspace-factory forms.
- Apply an MCP/Skill template during workspace-factory initialization.
- Add permission remediation and real message-event verification for newly registered applications.
- Add restart, recent errors/logs, queue reconciliation, and safe Bot/space removal.
- Complete clean-Windows real Feishu E2E, signing, and update/rollback work.

## Node 17 - Feishu capability-completion workflow

Date: 2026-07-15

Status: completed for guided permission/event remediation and per-Bot user OAuth; Feishu approval and publication remain external steps

Observed real-client gap:

- Three QR-created workspace Bots were locally configured and online, and a real Feishu message completed the Bridge/Codex/reply path.
- QR registration granted enough default Bot permissions for messaging but did not apply the embedded 1,658-scope target.
- The QR-created application contained several Feishu template events although the Bridge requires only `im.message.receive_v1`.
- The isolated Lark CLI Profiles had verified Bot identities but no user identity, so user-scoped calendar, Drive, mail, and related skills were unavailable.

Implementation scope:

- Keep QR registration as application creation because the official SDK accepts only avatar/name/description presets, not permissions or event lists.
- Add a post-registration capability-completion panel for every client-managed Bot.
- Copy the exact embedded permission policy in Feishu batch-import format and open the selected application's permission/event console pages.
- Show administrator approval, event cleanup, publication, and user consent as explicit external steps instead of reporting false automation.
- Add per-Bot Lark CLI user OAuth using the client's isolated Profile home and verify the resulting identity.
- Reclassify incomplete full permissions and missing user login as capability warnings rather than claiming that a functioning messaging Bot cannot start.
- Do not change existing Bridge source, existing Bot configuration, or existing Bot processes.

Implementation:

- Bumped the desktop client from `0.1.8` to `0.1.9`.
- Added an exact Feishu batch-import payload containing all 1,098 tenant and 560 user scopes from the embedded policy; the payload contains no App Secret, token, API key, or event configuration.
- Added managed-Bot-only actions to copy the permission JSON and open the selected application's permission and event pages. App IDs are validated and the destination origin/section is fixed by the main process.
- Added a separate `Lark CLI 用户身份` readiness row. Missing user login is a capability warning because Bot messaging remains usable.
- Added per-Bot `lark-cli auth login --domain all` with the selected isolated Profile and a server-verified `auth status --verify` check before reporting success.
- Changed incomplete full permissions from a false start blocker to `完整扩展权限` warning while retaining exact granted/missing counts.
- Exposed `im.message.receive_v1` as the sole target event and made event cleanup/publication an explicit Feishu-console step.
- Added a single post-registration action area that orders permission import, event cleanup/publication, and user login.

Verification:

- Desktop syntax/unit/integration tests: 80/80 passed.
- Existing Bridge syntax/static/unit tests: 41/41 passed without source changes.
- Production dependency audit: 0 vulnerabilities.
- Packaged desktop smoke: passed.
- Packaged Bridge engine smoke: passed on isolated port `18329`.
- Real installed-client state screenshot passed visual inspection with `36/1658` granted permissions, missing-user warning, sole target event, and four remediation controls visible without overlap.
- Three client-managed drawing Bots remained online after verification; no restart or configuration write was issued by this iteration.
- Existing Bridge `HEAD` remained `00762ee2fb169ceffe7d81d81882ce0e17aca7ee`, matching `origin/main`.

Artifact:

```text
apps/desktop/out/Codex Feishu Bridge Setup 0.1.9.exe
Size: 164954814 bytes
SHA-256: 37F8E21388C7BBA99A3CF457F6F3528F21069A65E153F159937C28179E325BE4
Authenticode: NotSigned
```

Adversarial review and fixes:

1. Three-month failure: the copied permission payload is truncated, mixes tenant/user identity, or silently includes credentials. Validation: exact-array regression coverage compares all 1,658 entries and restricts the payload to one top-level `scopes` object. Fix: generate it directly from the versioned policy instead of renderer strings or runtime Bot data.
2. Three-month failure: a user OAuth action authenticates the wrong Bot, writes into the normal user Profile, or attempts to adopt a legacy Bot. Validation: tests assert the exact selected Profile and isolated Profile home and reject unmanaged names. Fix: resolve every action through client-owned metadata in the main process and allow only one authorization at a time.
3. Three-month failure: a future permission gap again marks a working messaging Bot unusable. Validation: readiness regression tests remove a required scope and a user identity while asserting `readyToStart` remains true. Fix: full permissions and user login are capability warnings; only Bot identity, runtime, engine, and Provider failures block startup.

Remaining functional blockers:

- Feishu does not accept permissions/events in the initial QR registration SDK. Users must confirm batch permission import, administrator approval, event cleanup, and application publication in the developer console.
- Complete one clean-Windows real flow through permission import, publication, `--domain all` user OAuth, Lark CLI user-resource call, and final message E2E.
- Persist a verified real-message marker if the client is expected to replace the current pending event status automatically.

## Node 18 - Recommended Bridge and Lark CLI permission policy

Date: 2026-07-15

Status: completed; fresh-application permission and user-OAuth E2E remains the next manual acceptance test

Reason for change:

- A real 1,658-scope import exposed many HR, payroll, meeting, and other sensitive application-identity permissions that require separate data-range confirmation.
- The full snapshot was technically reproducible but unsuitable as a secure or usable default for other Windows users.
- The actual target is Bridge messaging/cards plus Lark CLI access to the logged-in user's visible conversations, Docs, Drive, and Wiki.

Implementation scope:

- Make a versioned `bridge-lark-common-v1` policy the default with 9 Bot/tenant and 32 user scopes.
- Retain the 1,658-scope snapshot only as advanced reference data.
- Copy and compare the recommended policy by default.
- Replace `auth login --domain all` with the exact recommended user-scope list.
- Use an ephemeral split device flow, open the returned verification URL unchanged, complete with the returned device code, and verify the selected Profile.
- Keep `im.message.receive_v1` as the only required event.

Implementation:

- Bumped the desktop client from `0.1.9` to `0.1.10`.
- Added `bridge-lark-common-v1` as the default policy with 9 Bot/tenant scopes and 32 user scopes.
- Limited Bot/tenant permissions to Bot identity, messaging, chat lookup, message resources, and dynamic cards.
- Limited user permissions to the logged-in user's visible chat history/search, document content/comments/collaborators, Docx editing, Drive search/read/upload/download, and Wiki read access.
- Excluded HR, payroll, recruiting, attendance, contacts, mail, meetings, approval, access-control, and tenant-administration domains from the default policy.
- Retained `full-current-permissions-v1` only as advanced reference/test data; readiness and clipboard output no longer use it by default.
- Replaced the blocking all-domain OAuth request with the exact 32-scope device flow: initiate without waiting, open the returned opaque verification URL, complete with its ephemeral device code, and verify the selected isolated Profile.
- Renamed UI and readiness text from full permissions to recommended permissions.

Verification:

- Desktop syntax/unit/integration tests: 81/81 passed.
- Existing Bridge syntax/static/unit tests: 41/41 passed without source changes.
- Production dependency audit: 0 vulnerabilities.
- Packaged desktop smoke: passed.
- Packaged Bridge engine smoke: passed on isolated port `18329`.
- Real installed-client state screenshot reports `推荐权限 41/41（Bot/租户 9，用户 32）` without clipped text or controls.
- All three client-managed drawing Bots remained online; no restart or configuration write was issued by this iteration.
- Existing Bridge `HEAD` remained `00762ee2fb169ceffe7d81d81882ce0e17aca7ee`, matching `origin/main`.

Artifact:

```text
apps/desktop/out/Codex Feishu Bridge Setup 0.1.10.exe
Size: 164955523 bytes
SHA-256: 6CDDEE93F5D10C47441448DC97C1E4FD5C74709CE10B8FB8DC69F2DBC818A115
Authenticode: NotSigned
```

Adversarial review and fixes:

1. Three-month failure: later edits quietly add HR, payroll, contacts, mail, meetings, or administrative scopes back into the default. Validation: a regression test rejects sensitive business-domain prefixes and checks every recommended scope against the verified full snapshot. Fix: keep a small explicit policy file instead of deriving defaults from broad prefixes at runtime.
2. Three-month failure: the UI says recommended while clipboard/readiness silently returns the old 1,658-scope payload. Validation: tests assert the default policy ID, exact 9/32/41 counts, exact payload arrays, and retained-but-nondefault full count. Fix: one `DEFAULT_PERMISSION_POLICY` feeds metadata, readiness, clipboard, and OAuth.
3. Three-month failure: OAuth asks for all domains, authenticates the wrong Profile, persists a reusable device code, or reports success before verification. Validation: tests assert the exact 32-scope argv, isolated Profile home, ephemeral begin/complete calls, selected Profile, unmanaged-Bot rejection, and final verified user identity. Fix: use a managed-Bot-only split device flow and never store the URL or device code.

Remaining acceptance work:

- Create one fresh test Bot, import the 41-scope JSON, confirm that no unrelated data-range panels are required, publish, and complete the 32-scope user OAuth.
- Run real `im +chat-list`, `im +messages-search`, `docs +search`, `docs +fetch`, and Drive/Wiki reads with that fresh Profile.
- Keep the existing 1,652-scope test applications as-is or recreate them later; changing the client default does not revoke permissions already granted in Feishu.

## Node 19 - Installer upgrade integrity

Date: 2026-07-15

Status: completed

Observed real-device failure:

- The user launched what they understood to be the latest installer, but the running UI, installed executable, and Windows uninstall registry remained `0.1.1`.
- The source package, unpacked executable, and versioned `0.1.10` installer were correctly versioned, proving that build output correctness alone did not validate the installed upgrade path.
- Historical installers shared one directory and `0.1.1` versus `0.1.10` was visually ambiguous.
- The previous execution plan recorded packaged smoke tests but had not completed a real old-version in-place upgrade. This was an incomplete release acceptance standard.

Implementation scope:

- Fail the release build when package, unpacked executable, installer, or update metadata versions disagree.
- Produce one stable `out/latest` installer plus explicit version and SHA-256 metadata.
- Upgrade the current real `0.1.1` installation using the stable installer, after confirming zero active Bot runs.
- Verify installed executable and uninstall-registry versions, reopen the client, and confirm every auto-start managed Bot recovers after the expected client/Bridge restart.
- Keep planning and execution documentation synchronized with implementation and verification evidence.

Implementation completed:

- Bumped the desktop client to `0.1.11`.
- Added `scripts/verify-release.cjs` and made every Windows distribution build run release verification automatically.
- Release verification now rejects package, unpacked executable, installer, and `latest.yml` version mismatches.
- Release verification copies the versioned installer to the single stable path `out/latest/Codex Feishu Bridge Setup.exe` and writes `release.json` plus `VERSION.txt`.
- The stable installer must be byte-identical to the versioned installer.
- Added `scripts/verify-installed-upgrade.ps1` to reject upgrades during active Bot runs and verify the installed executable, uninstall registry, and recovery of every auto-start managed Bot.

Real upgrade evidence:

- Upgraded the installed client from `0.1.1` to `0.1.11` using the stable installer.
- Installed executable version: `0.1.11.0`.
- Windows uninstall-registry version: `0.1.11`.
- Installed and final unpacked executable SHA-256: `BE549ADC7082CB908523AB60D1EAA07B8D6FC4C7BDE294671BB9F1CE7C87211A`.
- Closing the old client also stopped its client-managed Bridge processes. The original PID-preservation assumption was therefore incorrect and the verifier was corrected to require bounded recovery instead.
- All three auto-start drawing Bots recovered sequentially with new PIDs and returned online within the five-minute deadline.
- Persistent client configuration and managed Bot records remained available after the upgrade.

Final release artifact:

```text
apps/desktop/out/latest/Codex Feishu Bridge Setup.exe
Version: 0.1.11
Size: 164955490 bytes
SHA-256: 8EAF8CB818BFEE2045F433A7A0FBE3C10A93AF045E6AD7DE89E41A9B8A55B2C6
```

Verification completed:

- Desktop tests: `81/81` passed.
- Existing Bridge tests: `41/41` passed.
- Packaged desktop smoke test: passed.
- Packaged engine smoke test: passed on port `18329`.
- Release-version and stable-installer verification: passed.
- Real installed upgrade and managed-Bot recovery: passed.
- Existing Bridge source remained at commit `00762ee2fb169ceffe7d81d81882ce0e17aca7ee`; no Bridge source file was changed.

Adversarial review and fixes:

1. Three-month failure: a stale or ambiguously named installer is mistaken for the latest release. Validation: compare `package.json`, unpacked executable, versioned installer, `latest.yml`, and the stable installer's bytes on every build. Fix: fail the build on any mismatch and expose only one `out/latest` installer with explicit version/hash metadata.
2. Three-month failure: an upgrade interrupts an active model/tool run and loses in-flight work. Validation: inspect managed Bot active-run state before replacement. Fix: `verify-installed-upgrade.ps1` refuses to upgrade while any managed Bot has an active run.
3. Three-month failure: replacing the client stops managed Bridges and one or more Bots never return. Validation: record every auto-start managed Bot before upgrade and wait for each to become online afterward. Fix: treat PID changes as expected, verify sequential recovery for up to five minutes, and fail with the unrecovered Bot names instead of claiming success early.

## Node 20 - Space completion and readiness

Date: 2026-07-15

Status: completed

Confirmed requirements:

- New-space creation continues to create one or many Bots in one operation.
- Single-Bot creation remains available, but must explicitly create either a normal Bot using the user's global Codex Home or one additional Bot attached to an existing isolated space.
- An additional space Bot inherits the selected space's shared Codex Home, Provider, and naming context while retaining its own Feishu application/Profile, workspace, process, state, and logs.
- New isolated spaces can initialize their shared `AGENTS.md` from the user's global Codex Home. Normal Bots already use the global file and additional space Bots reuse the existing space file.
- The left sidebar remains fixed and only the white main content area scrolls.
- Message-event readiness uses existing managed runtime evidence instead of remaining permanently hard-coded to warning.
- Planning and execution documentation are updated before implementation and completed with test/package evidence afterward.

Implementation scope:

- Read `state/seen-events.json` metadata through the desktop supervisor and expose the latest verified message-event time to readiness checks.
- Add an explicit Bot configuration target to the single-Bot dialog and backend normalization.
- Expose existing isolated spaces as selectable targets and inherit their space-owned configuration safely.
- Add a source/target-previewed `AGENTS.md` initialization choice to the new-space factory.
- Isolate main-content scrolling from the fixed sidebar and reduce the prominence of reauthorization when already verified.
- Add focused regression tests, package `0.1.12`, and complete a three-item adversarial review.

Implementation completed:

- Bumped the desktop client from `0.1.11` to `0.1.12`.
- Managed runtime inspection now treats a non-empty, parseable `state/seen-events.json` as historical proof that `im.message.receive_v1` reached the selected Bridge and exposes the file update time and retained event count.
- Readiness shows the message event as verified with its latest evidence time. A missing or damaged evidence file remains a warning and never invents success.
- Single-Bot creation now explicitly selects `normal Bot / global Codex configuration` or `add to existing space` instead of exposing arbitrary Codex Home mode combinations.
- Existing-space targets are restricted to real workspace-factory spaces with isolated Codex Homes and inheritable global Provider metadata. Old standalone isolated/custom-Provider Bots are not misrepresented as spaces.
- An additional space Bot inherits the selected space's Codex Home, public Provider metadata, and workspace-factory identity without rewriting the shared `config.toml` or copying secrets.
- New-space creation can copy the visible global `AGENTS.md` into the shared isolated Codex Home. Preview exposes both absolute paths, missing sources block creation, existing targets are never overwritten, and failed initialization removes a newly written target.
- The left sidebar is viewport-fixed while only the main content scrolls.
- Verified Lark CLI users see a secondary `重新授权用户身份` action instead of a primary login action.

Real runtime evidence check:

- `codex-assistant-1-drawing`: online; 7 retained message events; latest evidence `2026-07-15T05:21:56.785Z`.
- `codex-assistant-2-drawing`: online; no retained message event yet, so it correctly remains pending until its first real message.
- `codex-assistant-3-drawing`: online; 10 retained message events; latest evidence `2026-07-15T05:46:30.203Z`.
- The check was read-only and did not restart or rewrite any existing Bot.

Verification completed:

- Desktop syntax/unit/integration tests: `86/86` passed.
- Existing Bridge syntax/static/unit tests: `41/41` passed.
- Packaged desktop smoke: passed with exit code `0`.
- Packaged engine smoke: passed on port `18329`.
- Bot-dialog and workspace-factory Electron screenshots passed visual inspection; the fixed sidebar, configuration target, and `AGENTS.md` initialization control rendered without overlap.
- Release verifier confirmed package, unpacked executable, installer, update metadata, and stable latest installer all report `0.1.12`.
- Existing Bridge source remained at commit `00762ee2fb169ceffe7d81d81882ce0e17aca7ee`.

Final release artifact:

```text
apps/desktop/out/latest/Codex Feishu Bridge Setup.exe
Version: 0.1.12
Size: 164957306 bytes
SHA-256: FE0C7986FC5D68A7E1D75AA36769BB6A4044BCADD5229EA84B4DDAC25D1C88E2
```

Adversarial review and fixes:

1. Three-month failure: any old isolated Bot appears as a space; adding a member inherits custom Provider metadata but no DPAPI secret and then fails at startup. Validation: target discovery and backend resolution both require workspace-factory identity plus a global Provider. Fix: exclude standalone isolated/custom Bots and test invalid targets.
2. Three-month failure: adding a Bot to a healthy space rewrites shared `config.toml`, changes every existing member, or leaks/copies a credential. Validation: an integration test creates a new member and compares the shared configuration byte-for-byte before and after. Fix: inherit only public metadata, skip Provider preparation for additions, and never create a new secret file.
3. Three-month failure: space initialization silently overwrites `AGENTS.md` or leaves it behind after a later queue failure. Validation: preview checks source/target existence and tests verify one shared copy. Fix: atomic target creation, explicit no-overwrite behavior, and rollback removal only when this transaction created the target.

Installation note:

- `0.1.12` was built and verified but not installed automatically because replacing the running desktop client would briefly restart its managed Bots. The currently installed client remains `0.1.11` until the user runs the stable installer while managed Bots are idle.

## Node 21 - GitHub distribution and automatic updates

Date: 2026-07-16

Status: completed and verified locally; GitHub Release verification follows the tag workflow

Confirmed requirements:

- Publish the existing Bridge and the additive Windows client from the same GitHub repository.
- Use GitHub Releases, not the `main` branch, as the installed client's stable update source.
- Display current/latest versions and update progress in the client System view.
- Download updates in the background but never interrupt an active client-managed Bot task.
- Preserve and restore the set of online client-managed Bots across an update without changing their auto-start settings.
- Keep script-managed/legacy Bots and all persistent user data outside the updater's ownership boundary.
- Preserve the release process as a repository GitHub Actions workflow plus a concise release SOP.

Implementation scope:

- Bump the Windows client to `0.2.0` and add `electron-updater 6.8.9`.
- Add a narrow updater service, install policy, and persistent post-update recovery marker with unit tests.
- Add main/preload/renderer IPC and a System update panel.
- Add a tag-driven Windows GitHub Actions release workflow and release documentation.
- Build locally, verify all assets, push source and tag, then verify the public GitHub Release.

Implementation completed:

- Added `electron-updater 6.8.9` and bumped the packaged Windows client to `0.2.0`.
- Added a packaged-only stable updater that checks GitHub Releases after startup and every four hours, supports manual checks, downloads in the background, and exposes status/progress through narrow IPC.
- Added a System update panel with current/latest versions, stable-channel identity, progress, errors, active-task blockers, and explicit install confirmation.
- Added a second active-run check immediately before installation. Downloading never interrupts work; installation refuses every non-null active run.
- Added transactional shutdown of online client-managed Bots, a persistent recovery marker, rollback on preparation failure, and post-relaunch restoration without changing auto-start settings.
- Added a public tag-driven Windows GitHub Actions workflow and a repository release SOP. The clean runner repeats tests and release verification before publishing the installer, blockmap, `latest.yml`, and checksums.
- Kept `node_modules`, generated engine staging, build output, local Profiles, Bot data, runtime state, and credentials outside Git.

Verification completed:

- Desktop syntax/unit/integration tests: `93/93` passed.
- Existing Bridge syntax/static/unit tests: `41/41` passed.
- Packaged desktop smoke: passed.
- Packaged engine smoke: passed on port `18329`.
- System-view Electron screenshot passed visual inspection; the update panel fits the fixed-sidebar layout without overlap.
- High-confidence App ID/token/private-key pattern scan found no secrets in the staged client and workflow source.
- The packaged `app-update.yml` points to the public `yuanzhejiang669-jpg/codex-feishu-bridge` GitHub repository.
- Release verifier confirmed package, unpacked executable, installer, `latest.yml`, stable installer, and checksums agree on `0.2.0`.

Final local release artifact:

```text
apps/desktop/out/latest/Codex Feishu Bridge Setup.exe
Version: 0.2.0
Size: 165243850 bytes
SHA-256: 2078EED82470B1B04646326D8C969348CE15A08EF954248041E7F9A5DFD3D73E
```

Adversarial review and fixes:

1. Three-month failure: a private repository or mismatched updater feed makes every installed client report update errors. Validation: query repository visibility and inspect packaged `app-update.yml`. Result/fix: the repository is public and the generated owner/repository fields match the release workflow; clean GitHub Action validation remains the final external check.
2. Three-month failure: installation begins after an earlier idle check while a Bot has since started work, or a partial stop strands online Bots. Validation: updater and supervisor tests exercise both stages. Fix: inspect active runs again at install time, let `stopManagedBot` enforce the same guard during shutdown, roll back already stopped Bots on any failure, and persist the pre-update online set for relaunch recovery.
3. Three-month failure: Windows reports equivalent versions as `0.2`, `0.2.0`, or `0.2.0.0`, causing a valid release to fail verification; a stale recovery marker also blocks a later update. Validation: both failures were reproduced during packaging. Fix: normalize only equivalent numeric Windows versions while rejecting non-zero fourth components, and atomically replace stale generated recovery markers with focused regression tests.

First clean GitHub run:

- Run `29463004050` passed checkout, dependency installation, tag/version validation, and all desktop tests.
- The build produced the installer but electron-builder attempted implicit publishing because it detected the `v0.2.0` tag before the explicit Release step. No Release was created.
- Fixed the build contract by adding `--publish never`; GitHub publication remains exclusively owned by the final authenticated `gh release create` step.

First published-asset audit:

- Run `29463196922` passed all clean-runner tests, build verification, and Release publication.
- The post-publication audit found that GitHub normalized the space-containing installer asset to a dotted name while electron-builder's `latest.yml` referenced a hyphenated safe name. No download had occurred, but automatic updates would have returned 404.
- Fixed all build, checksum, verification, and workflow paths to use the exact `Codex-Feishu-Bridge-Setup-<version>.exe` artifact name before recreating the release.

Final GitHub and installed verification:

- Clean GitHub Actions run `29463507635` completed successfully at commit `c5a3e7cdb3ad8667ddf679509d338ccffdf46160`.
- Public stable Release `v0.2.0` contains the exact installer, blockmap, `latest.yml`, and checksums assets; it is neither draft nor prerelease.
- Remote `latest.yml` references `Codex-Feishu-Bridge-Setup-0.2.0.exe`, and an anonymous redirected HEAD request returned `200` with the exact `165244215` byte content length.
- Remote installer SHA-256: `40FAD90DB8FBD480E124CE93492F9981D1567E79DF702CA711A04F04B7123901`.
- Downloaded the actual GitHub asset, verified its SHA-256, and completed a silent in-place upgrade on this device from the previous installed client to `0.2.0`.
- Installed executable reports `0.2.0.0`; Windows uninstall registration reports `0.2.0`; both normalize to the expected release.
- All three client-managed drawing Bots were idle before upgrade and online afterward. `codex-assistant-1-drawing` restarted with a new PID; the other two remained online with their existing PIDs.
- A later health poll observed the remaining pre-upgrade Bot processes exit and recover sequentially through the rate-limited supervisor. The upgrade verifier was strengthened to require all managed Bots to remain online with an unchanged PID set for 60 continuous seconds before reporting success.
- Re-ran the in-place upgrade with the strengthened verifier: all three managed Bots restarted with new PIDs and remained stable for `62` continuous seconds before the verification returned success.
- The temporary GitHub download directory under `%TEMP%\cfb-release-v0.2.0-verify` was removed after verification.

## Node 22 - Managed Chat Completions and removal lifecycle

Date: 2026-07-16

Status: completed locally; GitHub Release verification follows the tag workflow

Confirmed requirements:

- Add client-managed support for upstreams that expose OpenAI Chat Completions but not Responses.
- Add Bot and isolated-space removal with an impact preview and conservative data ownership boundaries.
- Keep the existing script-hosted Bridge and every legacy Bot unchanged.
- Publish the completed work as `v0.3.0` so installed `v0.2.0` clients can update through the System view.

Translation-proxy decision:

- The already working local ports `8788` and `8789` are served by the npm package `mimo2codex 0.5.28` from `https://github.com/7as0nch/mimo2codex`.
- The package is MIT licensed and explicitly supports Responses-to-Chat translation, streaming, tool calls, reasoning, generic OpenAI-compatible providers, Node.js 18+, and local-only binding.
- The desktop will pin and bundle this audited package instead of copying the user's global npm installation or maintaining a second partial protocol translator.
- Managed provider definitions contain endpoint/model metadata only. API keys remain in Windows user environment variables and are injected into the child process at launch.

Removal boundaries:

- A managed Bot removal stops only that Bot, removes only its client Profile/registration/runtime records, and preserves its workspace unless the user explicitly selects local-data deletion.
- Removing one Bot never deletes an isolated Codex Home still referenced by another Bot.
- Isolated-space removal previews every member Bot and may remove the shared Codex Home only after all member Bots pass the active-task guard.
- No removal operation deletes a Feishu cloud application or any legacy/script-managed Bridge instance.

Implementation completed:

- Added a Responses / Chat Completions protocol selector to Provider creation. Chat endpoints are probed through `/chat/completions`, then stored as a local Responses endpoint backed by the managed proxy.
- Added the pinned `mimo2codex 0.5.28` runtime and complete production dependency tree as an `extraResources` payload, including the upstream MIT license.
- Added a local-only proxy service with secret-free `providers.json`, Windows user-environment credential injection, update-check suppression, health polling, bounded crash recovery, first-use port allocation across `18788-18807`, and visible status/paths.
- Added duplicate-model rejection so two managed Chat Providers cannot silently route the same model ID to the wrong upstream.
- Added Bot and isolated-space deletion previews, a second active-run check at apply time, recovery-supervisor suspension, Lark Profile removal, client-state/runtime cleanup, strict owned-root checks, optional workspace deletion, and optional isolated Codex Home deletion.
- Kept workspaces by default and never touched global Codex Home, legacy Bots, or Feishu cloud applications.

Verification completed before publication:

- Desktop syntax/unit/integration tests: final suite `104/104` passed, including proxy cancellation and removal-time active-task regression coverage.
- Existing Bridge syntax/static/unit tests: `41/41` passed without changing the script-hosted Bridge.
- A real bundled-runtime smoke started `mimo2codex`, translated a Responses request into Chat Completions against a local upstream, returned the translated response, killed the proxy process, and verified automatic recovery with a new PID.
- Packaged desktop smoke passed; packaged Bridge engine smoke passed on port `18329`; the packaged Node and `mimo2codex` files passed the same protocol smoke after the final rebuild.
- The Provider view screenshot passed visual inspection with no overlap or clipped text. Development capture is isolated from production client data and bypasses the production single-instance lock.
- Secret scanning found no high-confidence App ID, API key, or App Secret values in source/workflow files.
- Windows unpacked output contains `engine`, `tools`, `proxy`, scripts, and licenses; `mimo2codex` and its MIT license are present under the proxy payload.

Adversarial review and fixes:

1. Three-month failure: quit/update races with a proxy start that is still reading credentials or waiting for health, leaving an orphan process or letting an old exit callback corrupt the new status. Validation reproduced the lifecycle window and repeated real crash recovery three times. Fix: add a lifecycle generation guard, cancel health waiting after stop, ignore stale child exit callbacks, and cover stop-during-start with a regression test.
2. Three-month failure: a stale deletion preview says a Bot is idle, but a task starts before the user confirms. Validation writes a real `active-runs.json` after preview and applies removal. Fix/guard: apply always rebuilds the preview from disk and refuses the operation before stopping the Bot or removing its Profile/configuration; regression coverage confirms the files remain.
3. Three-month failure: a packaging edit omits `mimo2codex` or its license while version/update checks still pass. Validation inspects the final unpacked payload. Fix: release verification now requires the packaged proxy manifest, exact pinned version `0.5.28`, MIT metadata, and a non-empty license before publication.

Final local release artifact before GitHub publication:

```text
apps/desktop/out/Codex-Feishu-Bridge-Setup-0.3.0.exe
Size: 169701946 bytes
SHA-256: 8DA665392927FBCAC2752C80DAFAF30FC919E00BC8D4807F5157674189367C31
```

Remaining deliberate gap:

- Item 43 remains open until a newly created client-managed Chat Provider is exercised against a real paid/non-GPT upstream. The packaged translator itself has been verified end to end against a local protocol-accurate upstream, and the user's legacy `mimo2codex-apideepseek` path remains outside client ownership.

GitHub publication verification:

- Commit `9e20212adba498974526bd8a01eafa295cf08f10` was pushed to `main` and tagged `v0.3.0`.
- Clean Windows Actions run `29473072339` passed dependency installation, `104/104` desktop tests, final packaging verification, and Release publication.
- Public stable Release `v0.3.0` is neither draft nor prerelease and contains the exact installer, blockmap, `latest.yml`, and checksums assets.
- Public `latest.yml` reports `0.3.0` and references the exact GitHub asset `Codex-Feishu-Bridge-Setup-0.3.0.exe` with size `169702315` bytes.
- An anonymous download of the published installer produced SHA-256 `FAF298B3E04FDD5AFF6D08768F55123E773AF9189A0CE7311E07D1743F50F97D`, exactly matching the published `checksums.txt`; the temporary verification directory was removed afterward.

## Node 23 - Provider removal and capability batch selection

Date: 2026-07-16

Status: completed and verified locally; GitHub Release verification follows the tag workflow

Confirmed requirements:

- Complete the Provider lifecycle with deletion of its definition and optional deletion of its Windows user API-key environment variable.
- Show the actual impact before deletion and refuse to break any client-managed Bot that still references the Provider.
- Remove synchronized definitions from client-managed isolated Codex Homes without touching MCP, Skills, unrelated TOML sections, legacy Bots, or script-hosted Bridge files.
- Add independent select-all and clear-selection commands for the MCP and Skills lists, with visible selected counts.

Implementation completed:

- Added Provider deletion preview and apply IPC contracts, a dedicated confirmation dialog, per-row delete actions, shared-environment-variable detection, managed-Bot reference blocking, and optional managed-space/API-key cleanup.
- Added a transactional proxy-registry removal contract. Removing the last managed Chat Provider writes an empty secret-free route file and stops `mimo2codex`.
- Added section-preserving TOML deletion for plain and quoted Provider IDs, including nested Provider tables, while retaining adjacent comments and MCP configuration.
- Added MCP and Skills selected/eligible counts with independent select-all and clear-selection controls. MCP entries with unavailable commands or entry paths remain disabled.
- Added a development-only read-only Provider-removal capture mode; it opens the impact dialog but never submits deletion.

Verification completed:

- Desktop syntax/unit/integration suite passed `111/111`; existing script-hosted Bridge syntax/static/unit tests passed `41/41` without modifying its source.
- Real local proxy smoke translated Responses to Chat Completions, recovered from a killed process, removed its final route, stopped, and reported `unused`.
- `out/visual-v040-capabilities.png`, `out/visual-v040-providers.png`, and `out/visual-v040-provider-removal.png` passed visual inspection after correcting danger-link color, checkbox layout, and confirmation-button state.
- Final packaged desktop smoke passed; packaged Bridge engine was healthy on isolated port `18329`; packaged Node and `mimo2codex` passed translation, crash recovery, final-route deletion, and shutdown smoke.
- Release verification confirmed client/installer/update metadata version `0.4.0`, pinned `mimo2codex 0.5.28`, its non-empty MIT license, and the expected engine/tools/proxy payload.
- High-confidence source scan found no API keys, app secrets, or access tokens.

Adversarial review and fixes:

1. Three-month failure: a shared Bot records `provider.mode = current` instead of a concrete Provider ID, so deleting the selected global Provider silently breaks that Bot. Validation changed the regression fixture to the real shared-current shape. Fix: selected-global deletion now treats every matching shared-current Bot as a blocking reference.
2. Three-month failure: the second managed-space write fails after the global Provider block was removed, leaving configuration split across locations. Validation injects a disk failure on the second write. Fix: every completed write is rolled back in reverse order; the test confirms global and isolated files remain byte-identical to their originals.
3. Three-month failure: an API key is shared or the last Chat Provider route is removed only from TOML while a stale proxy route/process survives. Validation covers shared environment references and performs real final-route removal against bundled `mimo2codex`. Fix: shared keys cannot be selected for deletion, and proxy removal atomically writes the reduced registry/providers file, restarts remaining routes, or stops when empty.

Final local release artifact before GitHub publication:

```text
apps/desktop/out/Codex-Feishu-Bridge-Setup-0.4.0.exe
Size: 169705016 bytes
SHA-256: A1C3EB0B86CA5D099192E5B3EAF337473C1D07D13E965F80E8CA62C69C58A672
```

GitHub publication verification:

- Commit `5f6b2d6ea3988713eb398486e0bcb3fdc7fd16ac` was pushed to `main` and tagged `v0.4.0`.
- Clean Windows Actions run `29474368526` passed tag/version validation, dependency installation, all `111` desktop tests, packaging verification, and Release publication.
- Public stable Release `v0.4.0` is neither draft nor prerelease and contains the exact installer, blockmap, `latest.yml`, and checksums assets.
- Public `latest.yml` reports `0.4.0` and references `Codex-Feishu-Bridge-Setup-0.4.0.exe` with size `169705334` bytes.
- An anonymous download produced SHA-256 `83F80CF8FFAF73B42BA611CF994D2567D0EF9D2C99EC8F62B5CA5A96F27CEFAD`, exactly matching the published `checksums.txt`; the temporary verification directory was removed afterward.

## 0.4.1 reasoning defaults, model capability registry, and runtime clarity

Requirements confirmed:

- Use `medium` as the default reasoning effort across script-hosted and desktop-managed creation and startup paths without overwriting existing explicit Bot settings.
- Keep common reasoning choices convenient while allowing every Codex-supported reasoning effort and rejecting unknown values.
- Maintain an offline model capability pool for current non-GPT families and use the same mapping in the script-hosted Bridge and desktop client.
- Show the requested effort, effective Codex effort, and upstream meaning without silently rewriting existing Bot configuration.
- Make the system view distinguish the selected Codex runtime entry executable from its runtime directory and companion executables.

Implementation completed:

- Changed the Bridge final fallback, environment example, and built-in Provider bundles from `max` to `medium`; launcher/watchdog parameters remain empty unless explicitly supplied so an existing Codex config is not masked.
- Changed the script-hosted `mimo2codex` compatibility patch to preserve an explicit reasoning effort and apply `medium` only when the translated request does not specify one.
- Added a schema-validated registry for DeepSeek V4, Kimi K2.6/K2.7 Code, GLM-5.2, Grok 4.3/4.5/4.20 Multi-Agent, plus an explicit unverified generic fallback.
- Replaced generic reasoning inputs with model-aware selects. The UI shows aliases as mappings, for example `medium → high`, and identifies the capability source or the unverified fallback.
- Added shared Bridge/desktop mapping so slash commands and new Bot/space creation retain the requested value while sending or writing the effective value.
- Added `/model capability`; `/model` status now reports requested, effective, upstream, source verification, and review status. Known impossible values fail before execution or persistence.
- Added a 90-day review deadline and a documented update procedure; stale rules warn without taking a working Bot offline.
- Added runtime-directory and EXE-component inspection and exposed both beside the runtime entry path in the system view.

Verification completed:

- Desktop syntax, unit, and integration checks passed `119/119`.
- Script-hosted Bridge syntax, static checks, registry validation, and unit tests passed `45/45`; PowerShell parsing separately passed for the launcher, watchdog, and `mimo2codex` proxy launcher.
- Staged-engine validation loaded the same seven-entry registry, and the packaged Bridge engine smoke was healthy on isolated port `18329`.
- Isolated visual capture confirmed that workspace creation opens with `medium` in a model-aware select and displays the unverified fallback without overlap.
- A fresh Windows x64 unpacked build completed; its executable reports `0.4.1.0`, packaged smoke exited `0`, and both `resources\engine\config\model-reasoning-capabilities.json` and the shared loader are present.
- Isolated system-view capture rendered successfully; runtime-directory and component-count behavior is also covered by a focused filesystem test.

Adversarial review and fixes:

1. Three-month failure: provider semantics change while the offline pool still looks authoritative. Verification advanced the clock beyond the review interval. Fix: every known entry requires an official source and verification date; after 90 days the Bridge and client visibly mark it due for review, and the update SOP requires a registry-version bump and both test suites.
2. Three-month failure: source behavior is correct but the packaged client omits the registry or uses a divergent copy. Verification staged a fresh engine, ran the registry checker inside it, and started its Bridge on port `18329`. Fix: `stage-engine.cjs` now always copies `config`, while both runtime surfaces load the shared engine module instead of maintaining separate mappings.
3. Three-month failure: the launcher's default `medium` environment override masks an existing explicit `config.toml` choice, while a newly created client's requested value is visible only in Bot JSON. Verification traced the complete desktop supervisor → PowerShell → Bridge precedence chain. Fix: launchers no longer manufacture an environment override; Bridge applies `medium` only after session, explicit environment, and Codex config values are absent, and the desktop supervisor passes a client-managed Bot's recorded requested value explicitly. Existing Bot files remain untouched.

Completion boundary for this iteration:

- Local implementation and verification are only the first stage. Completion additionally requires `origin/main`, a matching stable GitHub Release, old-device script-hosted source/Bots, current-device script-hosted Bots, and the installed desktop client to be synchronized and independently verified.

## 0.4.2 complete reasoning-map visibility

Requirements confirmed:

- Let a Feishu user see how every canonical effort maps through the Bridge without repeatedly switching and checking `/model`.
- Keep execution, persistence, the offline capability registry, and existing Bot configuration unchanged.
- Use the same behavior in script-hosted Bridge instances and the packaged desktop engine.

Implementation completed:

- Added a shared complete-mapping formatter that emits every canonical request value in `request -> Codex -> upstream` order.
- Updated `/model capability` to display the complete map, mark the current requested effort, and label model-specific unsupported values explicitly.
- Updated `/model effort` without a value to show the current Provider/model-specific capability map plus the switching command instead of a fixed generic usage string.
- Bumped the desktop client to `0.4.2` because its packaged Bridge engine changed.

Verification completed so far:

- Focused reasoning tests cover the complete DeepSeek V4 map, current-value marker, Grok unsupported value, and unknown-model generic passthrough.
- Root syntax, static, registry, and unit checks pass `47/47`; desktop syntax, unit, and integration checks pass `119/119`.
- Windows x64 packaging, proxy smoke, checksums, and release verification pass for `0.4.2`.
- Source, staged engine, and unpacked engine copies of both the Bridge entry and shared formatter have byte-identical SHA-256 hashes; the unpacked Node runtime prints the expected seven-line DeepSeek map.

Adversarial review and fixes:

1. Three-month failure: the source formatter changes but `stage-engine` or the installer carries the previous engine, so script Bots and client Bots display different maps. Validation compared SHA-256 hashes across source, staged, and unpacked files and executed the unpacked formatter. Guard: desktop packaging continues to stage the complete shared engine, and the complete-map unit test runs before packaging.
2. Three-month failure: a capability update adds an unsupported canonical effort and the card silently presents it as selectable. Validation uses Grok 4.5, whose `none` mapping is null. Guard: the shared formatter emits `不支持`, while `acceptedEfforts` excludes it and command validation still rejects it.
3. Three-month failure: the complete mapping becomes too large or loses its current marker on Feishu mobile. Validation fixes the output to exactly one row per canonical effort, seven rows for the current schema, with one deterministic `← 当前` marker. Guard: regression tests assert the exact DeepSeek rows and marker and verify the unknown-model row count matches the canonical registry.

Completion boundary:

- Completed end-to-end delivery on 2026-07-16.

Delivery verification:

- Commit `f85c8347e2335ce808d68666d6dc650eac072be3` was pushed to `origin/main` and tagged `v0.4.2`.
- GitHub Actions run `29504630915` passed clean dependency installation, `119/119` desktop tests, Windows packaging, release verification, and publication.
- Stable Release `v0.4.2` is public, neither draft nor prerelease, and contains the installer, blockmap, `latest.yml`, and checksums. The downloaded installer SHA-256 is `F8E6B986D8606F4F04B3250FBD709BB66858061D07A442188C4F6C33A16E22A8`, matching the published checksum.
- The old device fast-forwarded to `f85c834`, preserved its unrelated Browser Control script modification, passed `47/47`, and restarted all 17 idle script-managed Bots. One Bot's first PID verification raced its startup; a focused retry confirmed PID `16752` alive.
- The current device restarted all 13 idle script-managed Bots. The active conversation Bot was intentionally deferred until it remains idle for 15 seconds; a guarded helper records its post-turn result under the instance state directory.
- The installed client upgraded from `0.4.1` to `0.4.2.0`; all three managed Bots restarted with new PIDs and remained stable for 61 seconds.
- The installed Bridge entry is byte-identical to source. The installed shared formatter differs only by CRLF line endings, normalizes byte-for-byte to the source text, and the installed Node runtime prints the expected seven-line DeepSeek map.

## 0.4.3 watchdog empty-reasoning compatibility

Discovery:

- The post-release old-device Doctor showed all 17 script-managed Bots offline even though direct SSH-launched processes initially had live PIDs.
- Direct launches died with the SSH session, and persistent scheduled watchdog tasks then failed every restart with `MissingArgument,start-codex-feishu-bridge.ps1` because they passed a bare `-Reasoning` when the configured value was empty.

Fix:

- Removed unconditional `-Reasoning`, empty-value emission from the watchdog start argument list.
- Added `-Reasoning <value>` only when the watchdog input is non-empty, preserving the intended precedence introduced in `0.4.1`.
- Added a source-contract regression test. A real stub launch confirms the empty case does not bind `Reasoning` while retaining all other startup arguments.

Completion boundary:

- Root checks pass `48/48`, desktop checks pass `119/119`, watchdog PowerShell parsing passes, and Windows x64 packaging/proxy/release verification pass for `0.4.3`.

Adversarial review and fixes:

1. Three-month failure: the default reasoning remains empty by design, but a watchdog builds a positional native command containing a bare `-Reasoning`. A real old-device scheduled-task restart reproduced `MissingArgument`. Fix: append the option/value pair only when non-empty; a source-contract test and real stub launch verify the bound parameter is absent for the empty case.
2. Three-month failure: remote synchronization reports live PIDs even though SSH-owned child processes die as soon as the session closes. The post-sync Doctor reproduced `17/17` offline. Fix/verification rule: old-device recovery must run through its persistent scheduled watchdog tasks and pass a later Doctor; transient SSH PID checks are not accepted as completion evidence.
3. Three-month failure: a local clean install uses `npm ci --ignore-scripts`, leaving the packaged Node dependency without `node.exe`; tests pass but proxy packaging fails. The protocol-proxy smoke reproduced the missing runtime. Fix/guard: standard `npm ci` restores the binary, and `dist:win` must pass proxy smoke before producing or publishing an installer.

Completion boundary:

- Completed end-to-end delivery on 2026-07-16.

Delivery verification:

- Commit `01b7c15e3b365f74b75e3292712e0c87b2c126cb` was pushed to `origin/main` and tagged `v0.4.3`.
- GitHub Actions run `29507408049` passed the clean Windows build, root `48/48` checks, desktop `119/119` checks, packaging verification, and stable Release publication.
- The public `v0.4.3` installer is `169711789` bytes. A fresh download produced SHA-256 `E6473A97413CC0A9105F4A66BF85F9FD6BDAB5AE837FE6E68334E875BD11649C`, exactly matching the published checksum.
- The old device fast-forwarded to `01b7c15`, preserved its unrelated Browser Control script modification, and recovered all `17/17` script-managed Bots through persistent scheduled watchdog tasks. A later Doctor reported `113` checks, `96` OK, `17` warnings, `0` bad, no active runs, and both managed proxies online.
- The current device source and `origin/main` both resolve to `01b7c15`. All idle script-managed Bots were restarted; the active conversation Bot uses a guarded post-turn helper so synchronization never interrupts its task.
- The installed Windows client upgraded in place from `0.4.2` to `0.4.3.0`. Its three managed Bots restarted with new PIDs and recovered online; the installed engine contains the conditional empty-`Reasoning` forwarding fix.

## 0.5.0 dynamic model sources and OpenAI official login

Requirements confirmed:

- Simplify the user-facing reasoning map to `request -> model outcome`; retain all three internal stages for diagnostics.
- Discover future Codex Homes rather than encoding the three Homes currently present on one device.
- Treat OpenAI official account login as a separate source from third-party API Providers discovered from `[model_providers.*]`.
- Support the script-hosted control panel and Windows client without allowing either surface to restart or mutate the other's Bots.

Implementation completed:

- Added one staged shared model-source module for Home discovery, Provider inspection, login-state checks, official login launch, comment-preserving top-level Provider writes, session-override cleanup, and transactional rollback.
- Updated `/model capability` and no-value `/model effort` to show the selected request and final model outcome only; the existing complete three-hop formatter remains covered by diagnostics tests.
- Added per-Home model-source UI and APIs to the script control panel and desktop client. Both show absolute paths, owned Bots, login state, current source, discovered third-party Providers, active runs, and session overrides.
- Official login launches the selected cached `codex.exe login` with only the exact `CODEX_HOME` environment override. Tokens are neither read nor returned.
- Whole-Home switching refuses active tasks, stops only online owned Bots, writes only `model_provider`, clears Provider session overrides, restarts previously online Bots, and restores prior files/processes after failure.

Verification completed so far:

- Root syntax, static, capability, and unit checks pass `55/55`; desktop syntax, unit, and integration checks pass `124/124`.
- The first `v0.5.0` CI run exposed Windows canonical-path aliases in temporary Codex Homes. Home ownership comparisons now use the shared canonical path identity, and a regression test covers DPAPI-backed Provider application without a process-level API-key environment variable.
- A real isolated control-panel server discovered the current cached Codex `0.144.2` runtime, global/writing/drawing Homes, all configured third-party Providers, exact Bot ownership, active-run counts, session overrides, and independent signed-out states without modifying configuration.
- The packaged engine smoke test passed from commit `112acfac009acdfc99a141732a8c79f5ef9a0db2`; the managed Chat Completions proxy smoke test also passed before the Windows build.

Adversarial review and fixes so far:

1. Three-month failure: a control surface discovers another surface's Home and treats discovery as ownership, silently changing configuration used by foreign Bots. Fix: unbound Homes remain visible but login and apply actions are blocked; only owned Bots may be stopped or restarted.
2. Three-month failure: a client-managed custom Provider uses a DPAPI-encrypted Bot secret rather than a user environment variable and is falsely marked unavailable. Fix: a Provider is usable when every affected client Bot has the matching encrypted secret, while no secret content enters state or IPC.
3. Three-month failure: `config.toml` changes but existing sessions retain `providerOverride`, so only some turns use the selected source. Fix: switching an entire Home clears both Provider override fields while Bots are stopped and restores the exact original session JSON if any later step fails.

Delivery verification:

- Implementation commits `5ae6ee9` and `112acfa` were pushed to `origin/main`; tag `v0.5.0` published through GitHub Actions run `29545774770` after all clean-runner tests and packaging checks passed.
- The public installer is `169721717` bytes. A fresh public download produced SHA-256 `8117B4911EB907624D9EA73991DB5F47A700FC27E518140AFB0BE2E028DA17A8`, exactly matching `checksums.txt` and the GitHub asset digest.
- The old device fast-forwarded to `112acfa`, preserved its unrelated Browser Control script modification, passed the root `55/55` checks, and restarted all `17/17` idle script-hosted Bots through their existing scheduled watchdog tasks. Every PID changed and remained alive.
- The current device uses the same source commit. Its legacy default instance and 13 other idle script-hosted Bots restarted with changed live PIDs; the active `codex-assistant-1` conversation is intentionally left running until a guarded post-turn restart can observe zero active runs.
- The installed client upgraded in place from `0.4.3` to `0.5.0.0` using the public installer. Its uninstall entry reports `0.5.0`, its persistent data remained under `C:\Users\yzjiang\AppData\Local\CodexFeishuBridgeDesktop`, and all three drawing Bots restarted with new PIDs and remained online for 61 seconds.

## 0.5.1 OpenAI login lifecycle and refresh-safe drafts

Discovery:

- A real script-panel OpenAI login remained at `running` with PID `43132` while `codex login status` still reported signed out. A second click returned the same job and could not reopen the browser because the shared manager had no retry or timeout lifecycle.
- The script panel rebuilds the model-source controls every ten seconds and every two seconds while login is running. The rebuild restored the persisted `currentProvider`, discarding an unsubmitted Provider selection, confirmation text, details state, and focus. The desktop client has no general periodic refresh, but it uses the same two-second polling while login is running and therefore shared the defect.

Implementation:

- Shared login jobs now expose warning and expiry timestamps, warn for the final two minutes, terminate after ten minutes, and kill the exact previous login child before a deliberate restart. Exit, error, restart, cancellation, and timeout paths clear their timers.
- Both renderers snapshot per-Home drafts before replacing status markup and restore the selected target, confirmation text, placeholder, advanced-section state, focus, and text selection afterward.
- OpenAI official login is now the primary action. Whole-Home default Provider switching is collapsed under advanced management with an explicit warning that it affects every owned Bot and that daily switching belongs in Feishu.
- The stale PID `43132` was verified as `codex.exe login` and stopped before deployment; no `codex.exe app-server` process was touched. The old device is powered off and explicitly excluded from this release synchronization until the user requests it after startup.

Verification so far:

- Root syntax, static, capability, and unit checks pass `56/56`; desktop syntax, unit, and integration checks pass `124/124`.
- Playwright opened the real isolated script panel, selected `mimo2codex-apideepseek`, entered a confirmation draft, waited twelve seconds across the automatic refresh boundary, and verified the selection, text, and expanded state remained intact.
- Script-panel and Electron capture screenshots show the primary login action and collapsed advanced Provider control without overlap at `1440x1100`.

Adversarial review and fixes:

1. Three-month failure: expired login timers or superseded login children survive and prevent the next browser login. Validation reproduced the stale `codex.exe login` PID, stopped only that exact process, and exercised restart and timeout paths in unit tests. Fix: every exit, error, restart, cancellation, and expiry path clears its timer and process reference before another login starts.
2. Three-month failure: a refresh draft still points at a Provider that was removed or became unavailable, causing the UI to display a false pending target. Validation covers state replacement after provider discovery. Fix: draft restoration accepts only a target present in the refreshed selectable Provider set; otherwise it falls back to the real current Provider.
3. Three-month failure: the script source and packaged client engine drift, so one surface contains the lifecycle fix while the other does not. Validation built the release from staged commit `5fce0bd1bd2affc38d086dc55fae2997fbe57165` and passed both root and desktop suites before packaging. Guard: release packaging continues to stage the shared engine from the checked-out commit and runs the complete verification suite.

Completion boundary:

- Completed end-to-end delivery on 2026-07-17.

Delivery verification:

- Commit `5fce0bd1bd2affc38d086dc55fae2997fbe57165` was pushed to `origin/main` and tagged `v0.5.1`.
- GitHub Actions run `29551367139` passed in 2m42s and published the stable public Release at `https://github.com/yuanzhejiang669-jpg/codex-feishu-bridge/releases/tag/v0.5.1`.
- A fresh public installer download produced SHA-256 `2BAF33E1E0C8CDCB6B502E52901421EC7B5BC71C4E722929ACBEE6EEA8B6E9C3`.
- The current-device script panel restarted from PID `40376` to PID `50800` and displayed the new OpenAI official-login UI. The stale login PID `43132` was removed, zero `codex.exe login` processes remained, and the active `codex.exe app-server` process was not touched. The 15 script-hosted Bots were intentionally left running because this control-panel-only change does not alter their message path.
- The installed client upgraded in place to file version `0.5.1.0`; its uninstall entry reports `0.5.1`. Managed Bots `codex-assistant-1-drawing`, `codex-assistant-2-drawing`, and `codex-assistant-3-drawing` all restarted with new PIDs `39516`, `27072`, and `50396` and remained online for 61 seconds.
- The powered-off old device was intentionally not contacted or synchronized. It remains a deferred follow-up after the user starts it and explicitly requests synchronization.

## 0.6.0 macOS dual-architecture client

Scope:

- Add a macOS client without changing the script-hosted deployment or adopting any existing Bot.
- Keep the Windows client behavior and artifact contract intact.
- Target both Apple Silicon `arm64` and Intel `x64`; publish unsigned test assets until Apple signing credentials and a real Mac E2E are available.

Implementation so far:

- Added macOS Codex application/runtime discovery for `/Applications`, per-user applications, nested Resources layouts, and PATH fallback.
- Added platform-native bundled tool resolution and a checksum-gated build script that downloads exact Node.js and Lark CLI binaries for both Mac architectures.
- Added a direct detached macOS Bridge launcher with isolated `HOME`, `CODEX_HOME`, Lark Profile, state/log paths, launch metadata, graceful stop marker, and `SIGTERM` fallback. Windows continues to use the established PowerShell contract.
- Added Keychain-backed Provider credential persistence through Electron `safeStorage`; plaintext keys remain outside TOML, renderer state, IPC results, and logs.
- Extended login startup to native macOS login items and replaced Windows-specific UI language with system-neutral wording.
- Added DMG/ZIP builder targets, platform checksums, unpacked-app architecture verification, and one gated GitHub workflow that publishes only after both Windows and macOS jobs succeed.
- Disabled in-app update installation on unsigned macOS builds. Test users update manually until Developer ID signing and notarization are configured.

Verification so far:

- Desktop syntax, unit, and integration checks pass `131/131`, including a real child-process simulation of the direct macOS launcher and stop contract.
- Local Windows `0.6.0` packaging passed PowerShell parsing, protocol-proxy smoke, engine staging, NSIS packaging, checksums, and release-version verification.
- macOS Runner packaging, public Release assets, and physical-Mac E2E remain pending and are not claimed complete.
- The powered-off old Windows device remains intentionally untouched.

First clean-runner finding:

- GitHub Actions run `29592273684` passed the complete Windows job but stopped the macOS job before packaging because three test fixtures encoded Windows path semantics or allowed a Provider test to fall back to PowerShell. The product implementation was not bypassed: compatibility fixtures now build native paths with `path.join`, and the Provider transaction test injects its credential reader explicitly. The corrected release version is `0.6.1`; the failed `v0.6.0` tag has no public Release.
- GitHub Actions run `29592578081` then passed all macOS tests and the complete Windows job, but the pre-package protocol-proxy smoke still selected development Node as `node.exe`. The smoke now selects `node.exe` only on Windows and `node` on macOS. The next immutable release attempt is `0.6.2`; `v0.6.1` also has no public Release.

Adversarial review and fixes:

1. Three-month failure: an Apple Silicon DMG accidentally carries Intel Node or Lark CLI, so the interface opens but every Bot fails at launch. Fix: the build downloads each architecture explicitly, verifies upstream SHA-256 values, and the clean macOS job uses `file` on both unpacked apps to require matching Node and Lark architectures.
2. Three-month failure: a Windows-only path survives in a test or smoke command and future macOS releases stop before packaging. The first two clean-runner attempts reproduced Windows fixture paths, PowerShell fallback, and a `node.exe` smoke path. Fix: tests use native `path.join`, credential operations are injected, and the proxy smoke selects the executable name by platform.
3. Three-month failure: users mistake an unsigned Mac build for a notarized production release, Gatekeeper blocks it, or in-app replacement fails signature checks. Fix: documentation labels the Mac assets as unsigned test builds and macOS in-app installation remains disabled until Developer ID signing, hardened runtime, and notarization are configured.

Completion boundary:

- Cross-platform source, clean-runner packaging, GitHub distribution, and current Windows synchronization completed on 2026-07-17.
- Physical-Mac installation, Codex discovery, OAuth, Feishu registration, and real-message E2E remain deliberately open acceptance item 126.

Delivery verification:

- Release source commit `1e7d2a8c94d7edeb26b1abf025297cccde6230b4` is identical across local `main`, `origin/main`, and tag `v0.6.2`.
- GitHub Actions run `29592889142` passed: macOS `131/131` tests, protocol-proxy smoke, checksum-gated native tools, x64/arm64 packaging and unpacked architecture verification; Windows tests, packaging, and release verification also passed. The atomic publish job completed only after both build jobs.
- Stable public Release `v0.6.2` is neither draft nor prerelease and contains Windows x64 plus macOS Intel and Apple Silicon DMG/ZIP assets, blockmaps, update metadata, and platform checksums.
- Apple Silicon DMG: `230639870` bytes, SHA-256 `B65AED68570685941401B072A1F73687C6CE10F0FB9AD9130FD661DD6C95B3F4`.
- Intel DMG: `234088738` bytes, SHA-256 `B9A8FED17CA4357C1B863DB418040915312380E37474DC43B220581847A102EB`.
- The public Windows installer SHA-256 is `1BED7BF05F7C89FBD308FAC1ED9ACFC7DCB8CD7CF19822EAC81E0A059D568139`.
- The current Windows client upgraded in place to file version `0.6.2.0`; its uninstall entry reports `0.6.2`. Drawing Bots 1, 2, and 3 restarted with new PIDs `13584`, `38300`, and `22308`, and remained online for 61 seconds. Persistent data was preserved.
- Script-hosted Bots were not restarted because the shared Bridge engine source did not change in this macOS client iteration. The powered-off old Windows device was not contacted.

## 0.6.3 current OpenAI macOS bundle discovery

Physical-Mac discovery:

- Established Windows-to-Mac SSH over Tailscale and verified the physical target as macOS 15.1 on Apple M4 Pro (`arm64`).
- Downloaded the current Apple Silicon image from OpenAI's official `persistent.oaistatic.com/codex-app-prod/Codex.dmg` endpoint.
- Verified the mounted and installed application with strict code-signature checks and Gatekeeper assessment; both report an accepted notarized Developer ID application.
- The current image is still named `Codex.dmg`, but now contains `/Applications/ChatGPT.app`, bundle ID `com.openai.codex`, version `26.715.31251`, with `codex` and `codex-code-mode-host` under `Contents/Resources`.
- Confirmed that client `0.6.2` only enumerates `Codex.app`, so it would incorrectly report the official current runtime as missing on a clean Mac.

Implementation:

- Added system and per-user `ChatGPT.app` candidates ahead of the legacy `Codex.app` candidates while retaining nested-resource and PATH fallback behavior.
- Require bundle ID `com.openai.codex` before accepting either application name as an official desktop runtime source.
- Extended regression coverage to require both current and legacy bundle names and to reject an executable inside an unrelated same-name application.
- No Bridge engine, Windows runtime, existing Bot, Provider, workspace, or credential was changed.

Open acceptance:

- Build and publish the matching `0.6.3` Windows/macOS release, install the Apple Silicon client on the physical Mac, and verify it reports `/Applications/ChatGPT.app/Contents/Resources/codex` before provisioning Providers, Skills, MCPs, or Bots.

## 2026-07-18 - Physical Mac bootstrap started

- Confirmed the target over Tailscale SSH as macOS 15.1 on Apple M4 Pro (`arm64`).
- Confirmed the notarized official runtime exists at `/Applications/ChatGPT.app/Contents/Resources/codex` and that the Bridge client, `~/.codex`, and `~/Documents/Codex` were not yet present.
- Confirmed local source, `origin`, and tag `v0.6.3` resolve to commit `9557380627a3b7b08b3a7e0a23d50dae88e4e121`.
- Added `bootstrap/install-macos-personal-environment.sh`. It is idempotent, contains no keys, refuses to replace existing configuration or skill paths, and never creates or authorizes Feishu Bots.
- Confirmed the current Desktop Control MCP is Windows-only (`pywin32`, Windows UI Automation, Windows clipboard/window APIs). It is deliberately not configured on Mac; a native implementation remains required.
- Deployment, secrets transfer, MCP checks, client discovery, and second-run idempotence verification are in progress.
- Added an opt-in `--keep-awake` mode for the dedicated Mac. It uses a user-level `LaunchAgent` running `/usr/bin/caffeinate -dimsu`, never replaces an existing same-name plist, and does not require administrator privileges or change global power settings.
- Physical-Mac verification showed the Browser Control MCP protocol starts under bundled Node, but its direct browser executable allowlist still requires Windows `chrome.exe`/`msedge.exe` names. The Mac bootstrap therefore provisions one shared token for the extension bridge and does not claim native browser launch support.

Completion evidence:

- Verified the `v0.6.3` Apple Silicon DMG at `230639671` bytes. Local SHA-256 `3e1ccabdc11ef76d026f95277e843317f35a3d2ac2ac37489ff55b75fd6636a2` exactly matched the GitHub API asset digest.
- Installed `/Applications/Codex Feishu Bridge.app` version `0.6.3`. The main executable, bundled Node `24.18.0`, and Lark CLI `1.0.69` are arm64. The unsigned bundle fails strict `codesign` and Gatekeeper assessment as documented; no quarantine bypass or trust override was performed.
- The packaged environment inspector found `/Applications/ChatGPT.app/Contents/Resources/codex`, reported Codex `0.145.0-alpha.18`, and correctly reported the new Home as signed out.
- Ran the bootstrap repeatedly with `--no-git-sync --keep-awake`. Existing configs were preserved, six writing Skill links remained stable, and the local plan still records exactly six uncreated Bots.
- Stored Provider secrets and the shared Browser Control token in user-only `0600` files. Both Home configs contain only `sub2api` and `lthome`, default to `medium`, expose Browser Control, Firecrawl, and Tavily, and omit Desktop Control.
- Live Provider checks passed: `sub2api` returned 19 models and `lthome` returned 10 models. Tavily returned one live result. Firecrawl CLI `1.19.24` completed a live search on its first key attempt.
- Browser Control started under the bundled Node, completed MCP initialization, and listed 56 tools including extension bridge tools. Loading the unpacked extension in a Mac browser remains a manual acceptance step; direct `.app` browser launch is not yet supported.
- Tavily tests passed `2/2`; Firecrawl tests passed `8/8`. `codex mcp list` parsed all three enabled MCP entries from both Homes without exposing their environment values.
- The user LaunchAgent remained `running`; a forced `launchctl kickstart -k` replaced caffeinate PID `4578` with PID `4922`, proving `KeepAlive` recovery. This permanent wake/display assertion increases battery drain and energy use.
- No Feishu application, Lark Profile, Bot registration, authorization, Bridge process, or message event was created. Those remain deferred until the user signs in to the new Feishu account.

## 2026-07-18 - Unbound Home management and Chrome bootstrap follow-up

- Confirmed from the physical-Mac screenshot and desktop source that `~/.codex` and `~/Documents/Codex/codex-homes/codex-space-writing` were discovered correctly but intentionally rendered read-only because zero client-managed Bots were bound.
- Added an explicit trusted Codex Home registry at the desktop data root. Import is idempotent and atomic, accepts only an already discovered directory with a parseable `config.toml`, and does not create, register, authorize, or start a Feishu Bot.
- Trusted unbound Homes now support OpenAI official login and transactional whole-Home Provider switching. UI text distinguishes `已由客户端管理 · 尚未绑定 Bot` from an unmanaged read-only Home. Bot start/stop still requires an actual managed Bot.
- Added `--install-chrome` to the idempotent macOS bootstrap. It downloads Google's official universal stable DMG and verifies `com.google.Chrome`, strict code signing, Gatekeeper acceptance, and arm64 support before and after copying the app.
- Verified the Google download endpoint redirects to a `dl.google.com` tagged URL and returns a `272891826`-byte `application/x-apple-diskimage` response on 2026-07-18; no DMG was downloaded on Windows.
- Deliberately did not edit Chrome profile JSON, deploy enterprise policy, enable Developer mode, or load an unpacked extension automatically. Bing selection and Browser Control extension loading remain small, visible user actions inside Chrome.
- Focused trusted-Home and model-source tests passed; the complete desktop check passed `136/136`; local POSIX shell syntax validation passed.
- Remote SSH to the physical Mac timed out during this follow-up. Chrome installation, Finder launch, physical-client installation, and the two Home trust clicks remain pending until the Mac is reachable.

Completion after the Mac returned online:

- Installed `/Applications/Google Chrome.app` version `150.0.7871.129` from Google's official universal stable DMG. The installed bundle is `com.google.Chrome`, contains `x86_64 arm64`, passes strict code-signature verification, and is accepted by Gatekeeper as a notarized Developer ID application.
- The first installer run correctly verified the mounted source but exposed a shell variable collision that made the second verification point at the source again. Renamed the verification variable, redeployed the script, and independently verified the installed `/Applications` target. No Gatekeeper or quarantine bypass was used.
- Opened Finder at `~/Documents/Codex` and opened Chrome's search settings. Structured inspection of Chrome's own `Default/Preferences` confirmed `Microsoft Bing`, prepopulated engine ID `3`, and `https://www.bing.com/search?q={searchTerms}` as the selected default; no profile JSON was edited and no enterprise policy was installed.
- Mac focused tests passed and the complete Mac desktop check completed with `135` passes, `0` failures, and the expected single Windows-only skip. The existing arm64 application was used as a verified packaging base after GitHub's unrelated Intel Lark CLI download stalled; only the tested desktop `app.asar` code was rebuilt.
- Isolated screenshot smoke testing showed both discovered Homes read-only with an explicit `纳入客户端管理` action. Imported exactly `~/.codex` and `~/Documents/Codex/codex-homes/codex-space-writing` through the same backend validation and persisted two entries in `~/Library/Application Support/CodexFeishuBridgeDesktop/trusted-codex-homes.json` with mode `0600`.
- Replaced the installed client transactionally using staged `next` and rollback `previous` bundles. The updated client launched as PID `7623`; `desktop-state.json` retained the same SHA-256 before and after installation; no next/previous bundle remained; and no managed Bot existed or was created.
- Installation-after screenshot smoke testing showed both Homes as `已由客户端管理 · 尚未绑定 Bot`, with OpenAI login and whole-Home Provider controls enabled. The local overlay remains version `0.6.3` and unsigned, matching the existing unsigned physical-Mac test build; no signing or Gatekeeper claim was added.
- Opened `chrome://extensions` and the unpacked Browser Control extension directory. Developer mode and `Load unpacked` remain a required visible user action; browser security settings were not changed automatically.
- Removed downloaded build dependencies, generated packaging output, screenshots, logs, and temporary scripts from both machines after verification. Cleanup initially removed the tracked remote `resources/icon.ico`; final status inspection caught it immediately and restored the byte source from the unchanged local checkout before completion.
## 2026-07-18 - Existing macOS writing space registration path

- Confirmed over SSH that the Mac desktop data root has zero managed Bots, no workspace-factory queue, and no Lark profiles yet.
- Confirmed both `~/.codex` and `~/Documents/Codex/codex-homes/codex-space-writing` are present in `trusted-codex-homes.json`.
- Added the workspace-factory `reuseExistingHome` option and guarded it with the trusted-Home registry.
- Reuse mode preserves the existing Home and checks that the selected Provider is already available there.
- Added positive preservation coverage and a negative untrusted-Home test.
- Verification: `npm run check` passed, 138/138 tests.
- No Feishu application, profile, workspace queue, or QR registration was created during this implementation step.

## 2026-07-18 - Physical Mac six-Bot recovery and Lark event-bus socket path

Discovery:

- Audited all six client-managed Bot records, isolated Lark Profiles, runtime state, workspaces, Codex Homes, Providers, MCPs, and writing Skills without deleting or recreating any application.
- All six App IDs are distinct and every Bot identity verifies successfully. Five Profiles have a verified user OAuth identity; only `codex-assistant-1-writing` still requires user OAuth for user-scoped Lark CLI tools.
- The six auto-start Bots were offline with zero active runs. Each attempted Bridge start reached `im.message.receive_v1`, but bundled Lark CLI exited with code 5 because its event-bus daemon did not become ready.
- The long Profile Home produced an approximately 130-byte per-App `bus.sock` path, beyond the macOS Unix socket path limit. Disk space, directory permissions, Feishu endpoints, configuration, and Bot identity all passed `lark-cli doctor`.

Isolation evidence:

- Removed only empty-PID, no-live-process `bus.pid`, `bus.fork.lock`, and `bus.alive.lock` cache files. Profiles, credentials, App IDs, Bot metadata, Codex Homes, and workspaces were unchanged.
- Lark CLI `1.0.72` failed under the long Home exactly like bundled `1.0.69`, excluding a simple dependency-version fix.
- Created `~/.cfb-lark-profile` as a symlink to the existing desktop Profile Home. Bundled `1.0.69` then started its bus daemon, connected the Feishu WebSocket, reported `ready event_key=im.message.receive_v1`, and completed an eight-second bounded consume normally.

Implementation:

- The macOS supervisor now creates or validates the short Profile alias before launching Bridge children and uses it for `HOME` and `USERPROFILE`. Profile data remains in the original desktop data root.
- Windows retains the existing long-path behavior. A foreign file, directory, or wrong symlink at the alias path is preserved and rejected instead of overwritten.
- Added regression tests for alias creation/validation and occupied-path refusal. The Windows desktop check passed 139 tests with the one macOS-only symlink test skipped.
- Extracted the physical Mac's current `app.asar` and verified its trusted-Home, model-source, workspace-factory, preload, and renderer files matched the current source before applying only the supervisor overlay. Staged and installed smoke tests passed before the transactional replacement.
- The recovery supervisor brought all six Bots online with distinct stable PIDs. Every latest launch segment reports `ready event_key=im.message.receive_v1` and `feishu-websocket: connected`, with no later event-consumer error or shutdown.
- All six Bot identities verify and all six App IDs are distinct. The five existing user OAuth Profiles expose the same 34-scope effective set. `codex-assistant-1-writing` remains message-capable but lacks user OAuth, so an ephemeral exact-32-scope split flow was opened in the Mac browser and QR viewer; completion awaits the user's confirmation.
- Real incoming-message evidence is still absent from all six `seen-events.json` files. Production-ready macOS E2E remains open until the user sends test messages and all six are observed.

## 2026-07-18 - Six-Bot permissions, MCP, and Skill-source audit

- Confirmed six distinct application fingerprints and six verified Bot identities. All six user OAuth identities now verify with the same 34-scope effective set; the replacement `codex-assistant-1-writing` authorization completed after the earlier report.
- Confirmed all six Bridge processes remain live with stable distinct PIDs. Every runtime log reports `ready event_key=im.message.receive_v1` and a connected Feishu WebSocket; no other event key appears in the inspected launch logs. A real incoming-message receipt is still not recorded.
- Separated the evidence boundary: every local Bot record requests policy `bridge-lark-common-v1` (9 tenant plus 32 user scopes), but the remote granted application scopes are not identical. The replacement writing Bot exactly matches 9/32; four legacy-created Bots share a larger 35/115 set while missing recommended tenant scope `im:chat:readonly`; the remaining ordinary Bot returned inconsistent scope-list responses and was not claimed complete. The developer-console event subscription list was not asserted because no verified read API was available.
- Confirmed both Homes configure exactly the same three MCP servers: `codex_browser_control`, `firecrawl`, and `tavily`. Commands, arguments, resolved entry paths, and content hashes match, proving both configurations use the same program bodies. Desktop Control remains absent because the current implementation is Windows-only.
- Confirmed the ordinary Home has no custom Skills beyond its system-managed directory. The writing Home has six valid Skill symlinks. `academic-research-suite` and `research-paper-writing` resolve to their two GitHub source repositories; `imagegen-router` and `powershell-safe-invocation` resolve to the Bridge repository; `mineru-document-parser` and `ppt-master` resolve to local shared sources.
- Fixed Skill discovery to follow valid directory symlinks, ignore broken links, and report `realPath` plus `sourceType`. Added a per-Home capability inventory to desktop state. Selecting the writing Home now shows `MCP 3 / Skills 6` and every configured-to-resolved absolute path; the global empty state explains that it is the migration source rather than claiming the writing space has no Skills.
- Complete desktop verification passed 142 tests with zero failures and one expected macOS-only skip on Windows. The focused capability suite passed 4/4.
- Repacked only the tested desktop `app.asar`, installed it transactionally on the physical Mac, and verified the final SHA-256 `96fe3d1e5c7cbcff5ee324b2ff0ceaf6f4173cc5f32c5a72c73282bea788c42f`. DOM inspection and a screenshot confirmed the six writing Skills and their source paths. All six Bridge engine processes remained live across both client restarts.

## 2026-07-18 - macOS updater safety and MCP/Skills UI clarification

- Confirmed the physical Mac Keychain contains zero valid code-signing identities. The repository currently has no configured Actions secrets, so the installed `0.6.3` overlay cannot truthfully perform in-app replacement yet.
- Added a platform-neutral update-support assessment. Packaged Windows remains enabled. Packaged macOS is enabled only after the application exposes a `Developer ID Application` signing authority and passes `spctl --assess --type execute`; every disabled state carries a concrete reason to the system page.
- Reused the existing updater flow without weakening it: downloaded updates still recheck active runs, preserve the online-Bot restart list, write the recovery marker, stop only managed Bots and the local proxy, roll back on preparation failure, then invoke `quitAndInstall`.
- Added a GitHub Actions signing/notarization entry that reads only the five documented Secrets, rejects incomplete secret sets, preserves unsigned test builds when none are configured, and verifies strict code signing, Developer ID authority, and Gatekeeper acceptance before uploading signed assets.
- Removed the false packaged-Mac message `开发模式不连接更新服务`. The page now displays the backend reason, such as `当前 macOS 客户端不是正式 Developer ID 签名版本，暂不能安全自动更新`.
- Renamed capability sections and counters to distinguish global-Home migration candidates from the selected target Home's installed inventory. Existing symlink discovery and resolved Skill source paths are preserved.
- Added updater-support and unsupported-reason regression coverage. Focused tests passed `7/7`; full Windows and physical-Mac verification follow in this entry before installation is marked complete.
- Complete Windows verification passed 147 tests with zero failures and one expected macOS-only skip. Both YAML configuration files parsed successfully and `git diff --check` reported no whitespace errors.
- Immediately before installation, all six physical-Mac Bots had zero active runs and six live Bridge PIDs. Built the overlay from the installed `96fe3d1e5c7cbcff5ee324b2ff0ceaf6f4173cc5f32c5a72c73282bea788c42f` app archive, installed the tested `3a154a642568249f35a7d665a42106673fc198aab345b746a97f423b4f823037` archive transactionally, and removed the rollback copy immediately after success.
- Restarted only the desktop process. Its new PID is `13981`; all six Bridge PID records were byte-for-byte unchanged, all six remained online, and all remained at zero active runs.
- Physical-Mac updater tests passed `7/7`. Runtime assessment now reports `当前 macOS 客户端不是正式 Developer ID 签名版本，暂不能安全自动更新`, matching the known invalid strict signature after local `app.asar` overlays rather than falsely calling the packaged app development mode.
- Physical-Mac inventory verification reports the ordinary Home as `MCP 3 / Skills 0` and the writing Home as `MCP 3 / Skills 6`. All six writing Skills remain valid symlinks with their existing resolved source paths; both Homes still expose Browser Control, Firecrawl, and Tavily.
- In-app macOS update is code-complete but not production-enabled. Activation still requires Apple Developer Program access, a Developer ID Application certificate, all five repository Secrets, a signed/notarized Release, and installation of that Release once so future updates inherit a trusted signature chain.

## 2026-07-18 - 0.7.0 release-source preparation

- Selected `0.7.0` for the accumulated desktop feature set and synchronized `package.json` with `package-lock.json`.
- Added release notes covering trusted unbound Homes, existing-space reuse, the macOS Lark socket-path fix, per-Home MCP/Skill inventory, and the guarded macOS updater.
- Tightened the stable tag workflow: an empty Apple credential set is no longer accepted. All five signing/notarization Secrets are mandatory before either platform can be published as one stable Release.
- Audited the worktree boundary. Local Mac overlay archives and extracted dependencies under `tmp/` are build intermediates and are excluded from source publication. The bootstrap script contains no Provider, MCP, Apple, Feishu, or GitHub credential value.
- GitHub currently exposes no repository Actions Secrets, so `v0.7.0` remains intentionally untagged and unpublished until the user completes Apple Developer setup. Source commit/push and stable Release publication are tracked as separate states.
- Local `npm run check` passed 147 tests with zero failures and one expected macOS-only skip. Local `npm run dist:win` then passed PowerShell syntax validation, protocol-proxy smoke testing, Windows x64 packaging, version/update-metadata checks, and release checksum verification for `0.7.0`.
- Added CI acceptance for stapled notarization tickets on both unpacked application bundles and both architecture-specific DMGs, in addition to strict signature and Gatekeeper checks.
- The root Bridge check passed all 56 tests. Both release YAML files parsed successfully, the macOS bootstrap passed POSIX shell syntax validation, production dependency audit reported zero vulnerabilities, `git diff --check` passed, and a credential-shaped-value scan found no GitHub token, API key, application secret, private key, or Feishu App ID in the publishable source boundary.
- The generated local Windows installer was used only for verification and was not installed or committed. The physical Mac's six Bot processes and installed local overlay were not restarted or replaced. The powered-off old Windows device remains the user's explicit synchronization exception.

## 2026-07-18 - Native macOS Desktop Control implementation

Scope accepted:

- Load and verify the existing Browser Control extension in the physical Mac's Chrome profile.
- Replace the previous Windows-only Desktop Control limitation with a native macOS core backend while preserving the Windows contract.
- Register and verify Desktop Control in both physical-Mac Codex Homes through an idempotent bootstrap path.

Execution and verification evidence will be appended here as each implementation and physical-device check completes.

## 2026-07-26 - 0.8.1 native `/steer` implementation

- Added the out-of-band `/steer <补充内容>` command for regular and goal-mode app-server turns.
- The command calls native `turn/steer` only, revalidates the exact active job immediately before dispatch, serializes rapid supplements per job, and records successful content in the owning session.
- It explicitly refuses missing, ended, exec-mode, or otherwise non-steerable tasks and never falls back to `turn/start` or the ordinary queue.
- Added architecture-boundary coverage for routing, serialization, active-job revalidation, help text, and the prohibition on replacement turns.
- Root `npm run check` passed all 67 tests; `git diff --check` passed. Desktop packaging, installed-client verification, GitHub Release verification, and old-device rollout evidence will be appended after those stages complete.

## 2026-07-27 - 0.8.4 deterministic formula rendering

- Added explicit formula parsing for `$...$`, `\(...\)`, `$$...$$`, and `\[...\]` while protecting fenced code, inline code, currency-like dollar text, and unmatched delimiters.
- Kept ordinary streaming unchanged. At terminal completion, simple expressions remain selectable Unicode/native text; complex inline expressions render with their containing paragraph; block expressions render independently.
- Added local KaTeX/Playwright rendering with embedded KaTeX fonts, system Edge/Chrome discovery, Bot-authenticated image upload, mixed card blocks, and one collapsed copyable LaTeX source panel.
- The renderer is lazy-loaded only when an explicit formula is present, never calls an image-generation model, and adds no model-token consumption.
- Added fail-open behavior with a shared 15-second deadline, one upload attempt per image, an eight-image limit, a 1,400-character paragraph limit, deterministic temporary-file cleanup, and original-Markdown fallback.
- Focused tests passed `7/7`; the complete Bridge suite passed `82/82`; syntax/static checks, `git diff --check`, staged-engine smoke, packaged-Node smoke, and two formal Feishu card E2E runs passed.
- Formal E2E message `om_x100b6942c4e154a0b4c5bf527afd308` completed formula enrichment in about 2.0 seconds and the final card open in about 1.7 seconds.

Adversarial review:

1. Three-month failure: prices, code samples, or unmatched delimiters become false formulas. Verification reproduced the inline-code gap. Fix: protect inline-code ranges in addition to fenced code and add focused currency/code/unmatched-delimiter regressions.
2. Three-month failure: Lark CLI retries make the documented 15-second limit ineffective. Verification traced independent retry budgets. Fix: enforce one shared absolute deadline across browser startup, page work, screenshot, and one image-upload attempt; fall back to the original Markdown on expiry.
3. Three-month failure: a long formula-heavy paragraph exceeds browser/card image limits or packaged dependencies disappear. Verification exercised oversized input and the staged engine with both system Node and the packaged Node runtime. Fix: cap rendered paragraphs at 1,400 characters, preserve raw text beyond the cap, and make staged/package smoke mandatory.

Release, installation, old-device synchronization, and Bot recovery evidence will be appended after those stages complete.

Implemented:

- Added a platform-dispatched macOS backend using System Events, AppleScript, `screencapture`, `pbcopy`, and `pbpaste`. Windows retains its existing `pywin32` and UI Automation implementation.
- Added macOS screen geometry, window enumeration/activation, screenshots, coordinate clicks, hotkeys, native paste with text-clipboard restoration, permission diagnostics, and stable `PERMISSION_DENIED` errors.
- Added minimal pinned macOS requirements, an idempotent dependency install with official-PyPI retries, and append-only Desktop Control registration for both existing Codex Homes.
- Added a physical-Mac smoke test and made the aggregate verifier choose the native Mac or Windows E2E path by platform.
- Corrected the bootstrap's obsolete “Desktop Control unavailable” completion message.

Physical-Mac evidence:

- Browser Control unpacked extension is enabled in Chrome and has an established loopback connection to `127.0.0.1:18795`.
- Both `~/.codex/config.toml` and the writing Home `config.toml` now register `codex_desktop_control` against the same shared program body with separate output directories.
- Installed `Pillow 12.1.1` arm64 from official PyPI after the initial download timed out; the retry used a 120-second read timeout and completed without a third-party mirror.
- Desktop MCP protocol test passed with all 19 tools. The real Mac smoke confirms a 1512x982 point desktop, working screen capture, and working clipboard.
- The user enabled Accessibility for the SSH control path. A repeated physical-Mac smoke reported `accessibility_permission=true`, six visible windows, working screen capture, and working clipboard.
- Corrected the AppleScript window enumerator after the first authorized run exposed two real-device differences: integer concatenation emitted list punctuation unless explicitly coerced to text, and querying a per-window `visible` property skipped valid windows. The corrected enumerator returns six windows.
- Added and passed a non-destructive input E2E: Desktop Control identified and activated the `System Settings` window titled `辅助功能`, clicked its title bar at `(419, 50)`, and sent `Esc`. This verifies native activation, pointer, and keyboard delivery without editing user data.

Regression evidence:

- Root Bridge check passed `56/56`.
- Desktop client check passed `147` tests with `1` expected macOS-only skip on Windows.
- Windows Desktop Control protocol exposed all 19 tools and the existing desktop smoke test passed.
- Python compilation, POSIX shell syntax, and `git diff --check` passed.

## 2026-07-18 - macOS reboot Provider-environment recovery

Discovery:

- After a network-late reboot, the Provider LaunchAgent completed successfully and the current `launchctl` login session contained both configured Provider keys, but the desktop login item had started earlier without either key.
- Quitting and reopening the desktop process produced a new client with both keys. The six detached Bridge children survived the client exit, so the UI still showed them online and manual Bot start was a no-op; every old child retained the missing-key environment and failed Codex turns with `Missing environment variable: LTHOME_API_KEY`.
- All six `active-runs.json` files contained zero non-null runs. The six old children were terminated normally and the existing recovery supervisor restarted them in batches. Every replacement PID contains both Provider variables, all six event consumers reconnected, and a real `codex-assistant-1` message completed successfully in about 9.3 seconds.

Permanent fix:

- The macOS supervisor now inspects every Provider definition in the Bot's selected Codex Home on each start and fills missing `env_key` values from the current `launchctl` session. It does not log values, mutate `process.env`, query malformed names, or override client-encrypted custom Provider credentials.
- Added regression coverage for login-item stale snapshots, duplicate Provider references, value trimming, process-environment isolation, and custom-Provider precedence.

## 2026-07-20 - 0.7.5 Windows restart latency and release-channel split

- Replaced the Windows supervisor's `execFile` close-based completion with an exit-based PowerShell process contract. A successful launcher now completes when its PowerShell process exits instead of waiting for output handles retained by descendants.
- Added a regression test that keeps simulated child pipes open after process exit. The supervisor must resolve immediately and close its local pipe readers.
- Physical Windows verification reduced a selected safe restart of three drawing Bots from about 180 seconds to 18.1 seconds. All three replacement Bridge processes remained online with zero active runs.
- Physical macOS verification restarted three ordinary Bots in 3.89 seconds. All six ordinary and writing Bots were then confirmed online with zero active runs, proving the direct macOS launcher does not require the Windows fix.
- Adopted separate distribution channels: GitHub Releases publish Windows assets only; the physical Mac remains maintained through Tailscale and SSH. The Mac is intentionally unchanged for this Windows-specific fix.
- Prepared desktop version `0.7.5` and changed the tag workflow to publish only the five verified Windows release files after a clean Windows build.
- Workflow YAML parsing and the new Windows-only release regression test passed. The complete desktop suite passed 171 tests with zero failures and three expected platform skips; the root Bridge suite passed 57/57.
- Local Windows packaging staged engine commit `b89494c26884206b68e793b029d7b3da9af941b5`, passed the protocol-proxy smoke, built the x64 NSIS installer and blockmap, generated update metadata/checksums, and verified every packaged version as `0.7.5`.
- GitHub Actions run `29733567573` passed its clean Windows build in 4m02s and its atomic publish job in 20s. Public latest Release `v0.7.5` is neither draft nor prerelease and contains exactly five Windows files with no macOS asset.
- The installer was downloaded again from the public Release and all three checksummed assets matched `checksums-windows.txt`. The current Windows client upgraded in place to file version `0.7.5.0`; its uninstall entry reports `0.7.5`.
- Drawing Bots 1, 2, and 3 restarted with new PIDs and remained online for more than 60 seconds with zero active runs. A final SSH audit left the Mac unchanged and confirmed all six ordinary/writing Bots online with zero active runs.

## 2026-07-20 - 0.7.6 cross-Bot session deletion consistency

- Reproduced session resurrection as a cross-Home ownership problem: deleting a desktop mirror did not remove the writing-Home source, and independent Bot `sessions.json` bindings could remain visible or mirror the source back.
- Added dynamic Codex Home and Bot-state discovery, cross-instance `/list all` binding aggregation, persistent deletion tombstones, cross-Home physical cleanup and verification, and active-run checks across registered Bot state directories.
- Added a final per-item active check inside batch deletion so a task that starts after confirmation preflight is skipped rather than interrupted.
- Added focused range regression coverage proving `2-9` selects exactly eight sessions and excludes item `1`.
- Windows script deployment passed the complete root check with 61 tests. The default Bridge and `codex-assistant-1` restarted with live replacement PIDs; the one-time safe restart helper removed itself afterward.
- Prepared desktop version `0.7.6`. Local Windows packaging staged engine commit `93d443b6ef77ca770f7e46835a4b53372dd3245d`, generated and verified the NSIS installer, blockmap, update metadata, and checksums.
- GitHub Actions run `29746036856` passed the clean Windows build and atomic publish jobs. Public latest Release `v0.7.6` is neither draft nor prerelease and contains exactly five Windows files with no macOS asset.
- Downloaded the public Release again and verified the installer (`507400b6adc7d3387a35daa09044be7700c5c40f3a9178ff6601a92c67872d6a`), blockmap, and `latest.yml` against `checksums-windows.txt`.
- Upgraded the installed Windows client in place to file version `0.7.6.0`; the uninstall registry reports `0.7.6`. Drawing Bots 1, 2, and 3 restarted with PIDs `71444`, `68592`, and `33740`, then remained online and idle for the required 60-second stability window.
- Transferred the reviewed source to the physical Apple Silicon Mac through a local Git bundle over Tailscale SSH. The two unrelated untracked Browser Control `.crx/.pem` files remained untouched.
- The first Mac test run exposed test-environment leakage from real Application Support into a temporary registry fixture; rerunning with an isolated test `APPDATA` passed all 61 Bridge tests. The complete physical-Mac desktop suite passed 172 tests with zero failures and two expected platform skips.
- Installed the Mac `0.7.6` overlay transactionally from its native arm64 application base, preserving Mac-native unpacked dependencies and replacing only tested desktop source plus engine commit `93d443b6ef77ca770f7e46835a4b53372dd3245d`. The temporary rollback was removed after success.
- All six Mac ordinary/writing Bots restarted with replacement PIDs `66988`, `67282`, `67700`, `67116`, `67468`, and `67957`. Final audit found all six alive, idle, launched from the installed `0.7.6` engine, and carrying an event-consumer/WebSocket-ready log marker.
- Restarted the remaining 13 idle current-device script instances after the final source change. Final script audit found all 15 live instances on the shared source path with ready connection logs; the current `codex-assistant-1` run remained uninterrupted and every other instance was idle.
- The powered-off old Windows device remains the user's explicit synchronization exception and was not contacted.

## 2026-07-20 - 0.7.7 Codex Home session isolation correction

- Corrected the 0.7.6 ownership model: `/list all` now loads cross-instance Bridge bindings only from state directories assigned to the current resolved Codex Home. Persisted `launch-config.json` is authoritative over stale instance-list metadata.
- Confirmed deletion now writes tombstones and removes physical Codex records only in the current Home, then removes matching bindings from other Bots sharing that Home. Active-run checks intentionally remain global across every registered Bot.
- Disabled different-Home `desktopCodexHome` targets at runtime, removed mirror targets from future workspace-factory output and public examples, and migrated the current device's four writing launch configs plus `180bot` to empty mirror targets. The three drawing Bot configs were already empty.
- Historical-mirror audit found zero source threads in the writing and drawing Homes, zero specialized Bridge bindings, and one global thread belonging to the active ordinary conversation. No SQLite, rollout, index, or global-state record was deleted during migration.
- Root verification passed 65/65 tests. Desktop verification passed 171 tests with three expected platform skips. The first local package was rejected because staging correctly reported old Git HEAD `b52fe10`; after implementation commit `e9e6188`, packaging was repeated and verified the packaged engine manifest against `e9e618884403238b1a8f6943fc412fc949ef7ca8`.
- GitHub Actions run `29753298247` completed both clean Windows build and atomic publish jobs successfully. Public Release `v0.7.7` is neither draft nor prerelease and contains exactly five Windows assets. The downloaded installer SHA-256 is `9aa3dab9604da12b9d9a51dcd735bb32cd61d0975a80f32dc54cdb4d83d54b72`.
- Upgraded the current Windows client to file/product version `0.7.7` / `0.7.7.0`; its installed engine manifest points to `e9e6188`. The NSIS process returned code 2 while finalizing, but independent file-version, uninstall-registry, packaged-manifest, process, and Bot-recovery checks all confirmed a complete installation.
- Safely restarted all 14 idle script-managed Bots and skipped the active `codex-assistant-1` conversation PID `27052`. All 14 received replacement PIDs with zero failures. The upgraded client recovered drawing Bot PIDs `21972`, `73560`, and `71488`.
- Final writing/drawing audit found all seven relevant Bots alive, idle, and carrying connection-ready log markers; every launch config has an empty `desktopCodexHome`. The physical Mac remains on 0.7.6 pending user acceptance, and the powered-off old Windows device was not contacted.

Adversarial review for the most likely three-month regressions:

1. A stale instance list could assign a Bot to the wrong Home and reintroduce cross-space bindings. Fixed by retaining launch-config authority and adding an explicit stale-config regression test.
2. A future workspace could silently restore global mirroring. Fixed by removing mirror arguments from factory registration/start commands, forcing an empty factory field, rejecting different-Home mirror targets at runtime, and covering the boundary statically.
3. Another same-Home Bot could retain or rewrite a deleted binding. Fixed by directly cleaning all same-Home session files while preserving the shared Home tombstone and periodic reconciliation as the race-resistant fallback; focused tests verify selected-file cleanup and current-session repair.

## 2026-07-20 - 0.7.7 physical Mac rollout

- Reached `CathydeMacBook-Pro.local` through Tailscale SSH at `100.71.171.84`. Before mutation, the installed client was `0.7.6`; all six managed Bots were alive with zero active runs, and every launch config already had an empty `desktopCodexHome`.
- Transferred reviewed source through a local Git bundle and fast-forwarded the Mac checkout from `b52fe10` to `4186c81`. The existing untracked Browser Control `.crx` and `.pem` files remained untouched.
- Mac-native verification passed all 65 Bridge tests. The desktop suite passed 172 tests with two expected platform skips. Tests used isolated temporary application-data roots and the installed arm64 Node runtime.
- Built the local overlay from the existing Apple Silicon application bundle, replacing only tested desktop source, version metadata, and Bridge engine files while retaining Mac-native unpacked dependencies and tools.
- The first recovery wait used unavailable zsh `EPOCHSECONDS` state after the new app had already installed and launched. Corrected the wait to `date +%s`, fixed PID-zero diagnostics, and verified the live installation instead of repeating the transaction.
- Final installed version is `0.7.7`; packaged engine commit is `4186c811b950ea22f7b965e7752057ef3a8c22c7`; installed `app.asar` SHA-256 is `f349278ef4085fc17bfab6163ebba10e08922aec043604c880de9e419ead0767`.
- All six Bots recovered sequentially with PIDs `73403`, `73465`, `73515`, `73581`, `73627`, and `73670`. Every Bot is alive, idle, has an empty desktop mirror target, and has a connection-ready log marker. The transactional rollback bundle and all remote deployment intermediates were removed after verification.

## 2026-07-27 - 0.8.5 packaged formula runtime correction

- Reproduced the user-visible raw-LaTeX fallback from the installed 0.8.4 log: the installed engine had neither `katex` nor `playwright-core`, although the staged engine contained both.
- Confirmed electron-builder omitted the staged engine's nested `node_modules`; the prior packaged-engine smoke only started the control panel and never loaded the formula renderer.
- Added an explicit engine dependency resource, staged dependency/file parity assertions, isolated packaged-engine dependency loading, and a real packaged Node + Edge formula render gate.
- The isolated check copies the packaged engine to the system temporary directory before importing dependencies, preventing repository-parent `node_modules` from hiding a broken installation.
- Bumped the Windows desktop release to `0.8.5`; rollout and final installed-source consistency evidence will be recorded after the Release and two-device deployment complete.

## 2026-07-28 - 0.8.6 dense-formula completeness correction

- Reproduced the accepted 0.8.5 card with `planned: 14, rendered: 8, failed: 0`. The installed dependencies and browser were healthy; the remaining visible LaTeX came from the intentional `maxImages = 8` cutoff.
- Confirmed a second planning defect: when one paragraph contained both a complex inline formula and a display formula, the display branch sent the inline range through the conservative Unicode simplifier and preserved unsupported commands such as `\mathrm`.
- Added density-aware mixed rendering. A representative answer with ten numbered sections, ten complex inline formulas, and ten display formulas now becomes one 1200-pixel-wide KaTeX PNG instead of twenty uploads or a partially raw card.
- Increased the emergency image ceiling to 24 while bounding dense groups to 4,000 source characters and 20 formulas. A 100-formula regression fixture produces five ordered groups and retains all 100 formulas.
- Replaced every enabled-renderer failure path with a readable visible placeholder plus the existing collapsed source panel; raw LaTeX is no longer returned as ordinary card text.
- Root verification currently passes 87 tests. The real local Edge smoke renders three normal/dense images, validates width and safe height, cleans temporary PNG files, and proves that an explicit one-image ceiling yields one rendered image plus one readable fallback without leaking `\frac` or `\sum`.
