---
name: delegated-execution-workflow
description: Plan and verify non-trivial execution tasks while delegating implementation to GPT-5.6 Sol Medium on the active Codex Home's provider. Use for code, file, configuration, command, browser, cloud, API-write, or other multi-step execution work. Medium may receive one focused correction; High and higher efforts require fresh user approval.
---

# Delegated Execution Workflow

## Purpose

Use the active Codex session to understand the request, define the plan and
acceptance criteria, coordinate execution, and verify the result. Do not change
the active Codex Home's `config.toml` as part of this workflow.

Delegate the implementation phase to `gpt-5.6-sol` with `medium` reasoning
effort. Keep the active Codex Home's configured provider.

## Native Delegation Contract

- Use the runtime-provided `spawn_agent` tool. Its namespace or version may
  vary, but Shell, PowerShell, `codex exec`, `codex app-server`, background
  processes, and other CLI subprocesses are not delegated agents and must
  never be used to simulate delegation.
- Inspect the currently visible `spawn_agent` schema first and use the matching
  call format. Do not assume a fixed runtime version.
- For the V1 schema, pass `agent_type=worker`, `model=gpt-5.6-sol`,
  `reasoning_effort=medium`, `fork_context=false`, and
  `message=<planning packet>`.
- For the complete GPT-5.6/Multi-Agent V2 schema, pass the required
  `task_name=<lowercase_snake_case unique task name>` and
  `message=<planning packet>`, plus `agent_type=worker`, `model=gpt-5.6-sol`,
  `reasoning_effort=medium`, and `fork_turns=none`. Do not pass `service_tier`
  unless the user explicitly requests it.
- Do not pass a provider parameter. The provider must be inherited from the
  active runtime.
- If V2 exposes only `task_name`, `message`, and `fork_turns` while hiding
  `model` and `reasoning_effort`, report that the Codex Home must configure
  `[features.multi_agent_v2]` with `enabled=true`,
  `hide_spawn_agent_metadata=false`, and `tool_namespace="agents"`, then start
  a new thread. Do not use CLI or Shell as a substitute or claim Medium was
  used.
- For long tasks, use the native `wait` lifecycle; do not use a shell timeout
  to limit the delegated Agent's total lifetime. Close Agents that are no
  longer needed after completion.
- If `spawn_agent` is unavailable, cannot set `model` or `reasoning_effort`, or
  cannot inherit the required provider, report that the workflow cannot run.
  Do not claim success or fall back to a CLI subprocess.
- An Agent already running as the delegated executor or worker must execute its
  bounded task directly. It must not trigger this workflow again or require
  secondary delegation.

## Trigger

Use this workflow for non-trivial tasks involving one or more of the following:

- code, file, or configuration changes;
- commands with side effects;
- browser actions or authenticated page operations;
- cloud changes or API writes;
- multi-step execution that requires verification;
- a bounded implementation or research subtask that materially benefits from
  independent execution.

## Direct-Handling Exceptions

The current session may handle these without delegation:

- direct questions and explanations;
- simple read-only inspection or fact lookup;
- planning, clarification, and acceptance-criteria definition;
- urgent blocking work when delegation would only add latency;
- live authenticated browser or cloud steps when delegated access cannot be
  verified.

Do not delegate merely to satisfy a ceremony. Delegate when there is meaningful
execution work that can be handed off with a clear boundary.

## Planning Packet

Before delegation, provide the executor with:

1. a concrete objective;
2. all relevant context needed for the task;
3. absolute paths, resource identifiers, and current state when applicable;
4. an explicit write or action scope;
5. constraints and actions that are forbidden;
6. verifiable acceptance criteria;
7. the strongest practical verification to run.

Do not assume the executor can recover missing context from the parent thread.
Provide an explicit planning packet because context inheritance is disabled by
default: V1 uses `fork_context=false`, and V2 uses `fork_turns=none`.

## Provider And Model

- Keep the active Codex Home's configured model provider.
- Do not attempt to switch providers during delegation.
- Set the delegated model to `gpt-5.6-sol`.
- Set delegated reasoning effort to `medium`.
- Do not override the service tier unless the user explicitly requests it.
- If the active provider does not support the requested model or effort, stop
  and report the incompatibility. Do not silently fall back to another provider.

## Tool And Context Preflight

- Do not assume the executor inherits every tool, MCP server, browser session,
  process, credential, environment variable, or transient state.
- Confirm that the delegated runtime exposes the tools required for its assigned
  work.
- Pass required context, paths, acceptance criteria, and constraints explicitly.
- Keep authenticated browser and live cloud operations in the current session
  unless the executor's access to the required session has been verified.
- Treat missing tools, authentication, permissions, network access, or session
  state as an environment blocker, not a Medium reasoning failure.

## Medium Execution

1. Spawn one executor with model `gpt-5.6-sol` and effort `medium`.
2. Give it the complete planning packet and a clearly bounded responsibility.
3. Do not duplicate the delegated implementation in the current session.
4. Do not allow the executor to recursively spawn more agents unless the user
   explicitly approves nested delegation for the current task.
5. Require the executor to report changed resources, commands run, verification
   evidence, and any unmet acceptance criteria.

## Verification

Verify the returned work against the acceptance criteria. Use concrete evidence
such as tests, file contents, process state, logs, screenshots, API responses,
or cloud read-back. Do not accept an executor's statement of completion without
checking the result when checking is practical.

## One Focused Correction

If the first Medium result fails verification:

1. identify the exact unmet criteria and supporting evidence;
2. provide one focused correction request at `medium`;
3. reuse the same executor when supported, otherwise create one replacement
   Medium executor with the original planning packet and failure evidence;
4. do not broaden the task or repeat the same attempt without new information.

## Escalation

If the focused Medium correction still does not meet the acceptance criteria:

- stop execution;
- report the unresolved criteria, attempts made, verification evidence, and
  actual blocker;
- explain why additional reasoning may help;
- request fresh user approval for a `high` executor for this task.

Never automatically use `high`, `xhigh`, `max`, or `ultra`. Approval applies
only to the current task and does not carry over. If an approved High attempt
also fails, stop and report before requesting any higher effort.

Do not request a higher effort for authentication failures, missing permissions,
unavailable services, ambiguous requirements, or other blockers that additional
reasoning cannot fix.

## Runtime Failure

If the native delegation contract cannot be met, report that this workflow
cannot be executed in the current runtime. Never simulate or claim delegation.
