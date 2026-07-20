# ADR-033: Local Model Engineering Loop

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Development only
- Superseded by: None
- Owner: Engineering workflow
- Decision date: 2026-05-12
- Alpha note: Governs local-model contribution work, not a shipped runtime
  component.

## Context

ResonantOS can use local GX10-hosted models through OpenCode and Hermes. The local Qwen route is fast enough for agentic coding, but testing showed that first-pass output can pass tests while still missing hidden side effects, overbroad parsing, or instruction-scope issues. The system should not rely on one-shot model judgment for final quality.

## Decision

Local-model engineering work uses a four-pass loop by default:

1. Implement pass: make the smallest scoped change.
2. Review pass: adversarially inspect the diff and test claims, starting with a trace against every explicit user requirement.
3. Fix pass: patch concrete review findings without broad redesign.
4. Verification pass: run deterministic checks and, when relevant, the actual command or UI path. For behavior changes, include direct spot checks for every accepted input category or externally visible mode requested by the user.

This applies by default to non-trivial code, config, infrastructure, provider, credential, CLI, persistence, and test changes performed through Qwen, OpenCode, Hermes, or their subagents.

## Required Review Checks

- instruction drift
- missed explicit requirements in the user request
- scope creep outside the requested write set
- hidden module side effects
- tests that pass for the wrong reason
- self-written tests treated as proof without independent requirement checks
- secret or credential exposure
- brittle parsing or broad redaction
- missing edge cases
- unrequested model/provider routing changes

## Consequences

- First-pass local-model output is treated as a draft.
- A final "done" report must include changed files, review result, commands run, pass/fail status, and residual risk.
- If review or verification is skipped, the result must be labeled code-reviewed or needs testing rather than verified.
- For small low-risk tasks the loop can be compact, but it cannot be omitted when the change touches routing, credentials, providers, CLI commands, persistence, tests, or infrastructure.
