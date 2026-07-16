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

Status: completed locally; GitHub Release verification follows the tag workflow

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
