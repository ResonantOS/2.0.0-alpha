# Agent Handoff Orchestration

## Trigger

Use this skill when a user asks ResonantOS to prepare, review, or hand off a coding-agent package for continued work, especially when Hot Rod Rig or Z-Rig context must be preserved.

## Inputs

- Current user objective and latest instructions.
- Repository `AGENTS.md` and local project docs.
- Current branch and `git status`.
- Relevant source files, tests, and manifests.
- Hot Rod Rig evidence from the master runbook and package manifest.

## Outputs

- A concise handoff objective.
- File map for the next agent.
- Evidence list with source paths or channel names.
- Boundaries and non-goals.
- Deterministic verification commands.
- Known risks and incomplete checks.

## Workflow

1. Collect repository instructions, current worktree state, and relevant source files.
2. Separate evidence from claims. Mark unverified rig executions as unverified.
3. Choose the smallest useful mode: Micro for small edits, Standard for code package changes, Full only for high-risk cross-system changes.
4. Implement scoped changes through the repository's existing patterns.
5. Run focused validation, then required broader checks.
6. Return a handoff summary that includes changed files, test evidence, and residual risks.

## Approval Gates

- Ask before changing branches, committing, pushing, or publishing.
- Ask before enabling shell/provider execution for an add-on.
- Ask before moving anything into trusted Living Archive knowledge pages.
- Ask before using external credentials or public send/schedule actions.

## Never Do

- Do not claim an autonomous Hot Rod Rig run without execution ledger evidence.
- Do not grant shell, provider, wallet, or trusted memory-write authority from this package.
- Do not hide failed or skipped verification.
- Do not replace repository-specific tests with protocol language.
