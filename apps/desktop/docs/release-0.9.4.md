# 0.9.4

- Ignore the empty global MCP configuration file that Antigravity creates on first startup. Non-empty malformed JSON still produces a visible error. This lets subsequent native turns resume normally after initial setup.
- Preserve Codex `env_vars` optional pass-through semantics when importing MCPs into Antigravity. Missing Codex-host metadata variables do not block all native Bot turns.
- Link the shared Skill library into Antigravity's documented global `config/skills` location when creating a native Bot. Existing native Skill directories are preserved.

Validation includes the empty-file regression, malformed-file refusal, native Skill-directory linkage, native session/protocol tests, desktop checks, and fresh Windows package startup.
