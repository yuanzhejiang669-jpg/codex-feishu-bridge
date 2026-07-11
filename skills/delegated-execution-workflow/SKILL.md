---
name: delegated-execution-workflow
description: Delegate all non-trivial work, including multi-step read-only investigation, to a GPT-5.6 Sol Medium Worker while the main Agent only plans, coordinates, and performs targeted acceptance review.
---

# Delegated Execution Workflow

## Purpose

For all non-trivial work, read-only or mutating, the main Agent owns request understanding, essential
clarification, concise planning, coordination, targeted read-only acceptance
review, and final reporting. One `gpt-5.6-sol` Worker at `medium` reasoning
effort owns broad investigation and all substantive execution while inheriting the active Codex Home's
configured provider.

Do not call the main Agent "High" or assume its model or effort. The active
Codex Home selects those settings. Do not change `config.toml` as part of this
workflow.

## Responsibility Boundary

The main Agent may:

- understand the request and ask only essential clarification questions;
- perform only a trivial fact lookup or narrow read-only preflight that normally
  needs at most one or two tool calls and no remote host, broad search,
  iterative parsing, or substantial output synthesis;
- define a concise plan, write scope, constraints, and acceptance criteria;
- spawn, coordinate, and wait for the Worker;
- perform the smallest one or two targeted read-only acceptance checks after
  the Worker returns;
- send one focused correction to the same Medium Worker when supported; and
- report the final result, evidence, risks, and blockers.

The main Agent must not perform non-trivial work by default. This includes
remote inspection, broad or multi-file exploration, iterative search or
parsing, long-output analysis, multi-source synthesis, implementation edits,
commands, tests, browser or cloud actions, API operations, commit, and push. It
must not repeat the Worker's investigation during acceptance review.

The Medium Worker owns broad exploration, SSH and remote inspection, read-only
analysis, file and configuration changes, commands, tests, authenticated
browser or cloud actions, API operations, commit and push when requested, and
evidence collection. A Worker must execute its bounded task directly and must
not recursively delegate or require another Agent.

## Trigger And Direct Handling

Use this workflow for every non-trivial task, read-only or mutating. This
includes SSH or remote inspection; Thread, rollout, session, or long-log
analysis; multi-file or repository-wide investigation; iterative searching,
filtering, or parsing; multi-source research requiring synthesis;
authenticated browser inspection; tasks expected to need more than two tool
calls or substantial output analysis; code, file, or configuration changes;
commands and tests; browser, cloud, or API operations; and commit or push.

Handle directly only explanations from visible context and trivial fact lookup
or a narrow read-only check that normally needs at most one or two tool calls,
no remote host, broad search, iterative parsing, or substantial output
synthesis. For example, one weather search remains direct; SSH Thread analysis
unambiguously requires `spawn_agent`.

## Native Delegation Contract

- Use the runtime-provided `spawn_agent` tool. Never simulate delegation with
  Shell, PowerShell, `codex exec`, `codex app-server`, background processes, or
  another CLI subprocess.
- Inspect the visible `spawn_agent` schema and use its matching call format.
- For V1, pass `agent_type=worker`, `model=gpt-5.6-sol`,
  `reasoning_effort=medium`, `fork_context=false`, and the planning packet.
- For complete GPT-5.6/Multi-Agent V2, pass a unique lowercase snake-case
  `task_name`, the planning packet, `agent_type=worker`, `model=gpt-5.6-sol`,
  `reasoning_effort=medium`, and `fork_turns=none`. Do not set `service_tier`
  unless the user explicitly requests it.
- Do not pass or switch providers. The active provider must be inherited.
- If V2 hides model or effort metadata, report that the Codex Home must enable
  visible spawn metadata in `[features.multi_agent_v2]`, then use a new thread.
- Use the native wait lifecycle for long tasks and close completed Agents when
  supported.

If native delegation is unavailable, cannot select the required model and
effort, cannot inherit the active provider, or the Worker cannot access a
required authenticated or live tool, report the blocker. Request explicit user
approval for a narrowly scoped main-Agent execution exception before taking
that action. Do not silently fall back or claim delegation occurred.

## Planning Packet

Keep the packet concise but complete. Include:

1. objective and essential context;
2. absolute paths or resource identifiers when applicable;
3. explicit write and action scope;
4. constraints and forbidden actions;
5. verifiable acceptance criteria; and
6. strongest practical verification.

Do not perform broad or iterative exploration to build the packet. Context
inheritance is off by default, so include only visible facts and facts available
through a trivial narrow preflight; let the Worker discover the rest.

## Worker Execution And Return

Spawn one Worker using the active provider, model `gpt-5.6-sol`, and `medium`
reasoning effort. The Worker performs the complete bounded task and returns a
structured summary containing:

- changed resources;
- tests and verification evidence; and
- remaining risks or unmet criteria.

The main Agent coordinates but does not duplicate execution.

## Targeted Acceptance Review

After the Worker returns, perform only the smallest one or two read-only checks
needed to validate the stated acceptance criteria. If acceptance requires
broader investigation or substantial output analysis, send that work to the
Worker. Avoid a second full repository or environment exploration.

## One Focused Correction

If acceptance review fails, identify the exact unmet criteria and evidence and
send one focused correction to the same Medium Worker when supported. If reuse
is unavailable, use one replacement Medium Worker with the original packet and
failure evidence. Do not broaden the task.

If the correction still fails, stop and report the evidence. Request fresh
user approval before using a higher-effort Worker. Never automatically use
`high`, `xhigh`, `max`, or `ultra`; approval applies only to the current task.
Do not request higher effort for authentication, permissions, unavailable
services, missing tools, or ambiguity that additional reasoning cannot fix.
