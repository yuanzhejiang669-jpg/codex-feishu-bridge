---
name: delegated-execution-workflow
description: Coordinate non-trivial execution through a GPT-5.6 Sol Medium Worker while the main Agent performs only minimal planning and targeted read-only acceptance review.
---

# Delegated Execution Workflow

## Purpose

For non-trivial execution, the main Agent owns request understanding, essential
clarification, concise planning, coordination, targeted read-only acceptance
review, and final reporting. One `gpt-5.6-sol` Worker at `medium` reasoning
effort owns all substantive execution while inheriting the active Codex Home's
configured provider.

Do not call the main Agent "High" or assume its model or effort. The active
Codex Home selects those settings. Do not change `config.toml` as part of this
workflow.

## Responsibility Boundary

The main Agent may:

- understand the request and ask only essential clarification questions;
- perform the minimum read-only preflight needed for a safe planning packet;
- define a concise plan, write scope, constraints, and acceptance criteria;
- spawn, coordinate, and wait for the Worker;
- perform targeted read-only acceptance review after the Worker returns;
- send one focused correction to the same Medium Worker when supported; and
- report the final result, evidence, risks, and blockers.

The main Agent must not perform substantive execution by default. This includes
implementation edits, side-effect commands, broad repository exploration,
tests, browser or cloud actions, API writes, commit, and push. It must not
repeat the Worker's broad exploration during acceptance review.

The Medium Worker owns broad exploration, file and configuration changes,
commands, tests, browser or cloud actions, API writes, commit and push when
requested, and evidence collection. A Worker must execute its bounded task
directly and must not recursively delegate or require another Agent.

## Trigger And Direct Handling

Use this workflow for non-trivial work involving code, files, configuration,
commands with side effects, browser actions, cloud operations, API writes,
multi-step verification, or requested commit and push.

Handle direct questions, explanations, and simple read-only inspection or fact
lookup directly. Do not spawn a Worker for trivial or read-only work that the
main Agent can complete with a narrow inspection.

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

Do not perform broad exploration to build the packet. Context inheritance is
off by default, so include facts the Worker cannot safely infer.

## Worker Execution And Return

Spawn one Worker using the active provider, model `gpt-5.6-sol`, and `medium`
reasoning effort. The Worker performs the complete bounded task and returns a
structured summary containing:

- changed resources;
- tests and verification evidence; and
- remaining risks or unmet criteria.

The main Agent coordinates but does not duplicate execution.

## Targeted Acceptance Review

After the Worker returns, inspect only the outputs and evidence needed to check
the stated acceptance criteria. Read specific changed files, diffs, test
results, process state, logs, screenshots, API read-backs, or remote hashes as
appropriate. Avoid a second full repository or environment exploration.

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
