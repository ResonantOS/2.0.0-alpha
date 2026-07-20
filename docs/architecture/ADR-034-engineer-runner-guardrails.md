# ADR-034: Engineer Runner Guardrails

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Development only
- Superseded by: None
- Owner: Engineer runner
- Decision date: 2026-05-13
- Alpha note: Governs repository task verification, not a shipped runtime
  component.

## Context

Local OpenCode/Qwen work is useful, but tests showed that model instructions alone do not reliably enforce file scope, review quality, or final reporting. A local coding model can pass its own tests while editing files outside the user-approved boundary.

## Decision

ResonantOS will treat Engineer Runner as the mandatory execution backend for local coding work. OpenCode and Qwen remain the coding engine; Engineer Runner owns task contracts, changed-file scope checks, verification commands, and machine-readable reports.

The first implementation is a CLI foundation:

- `scripts/engineer-runner.mjs prompt <task.json>` renders a guarded OpenCode prompt from a task contract.
- `scripts/engineer-runner.mjs verify <task.json> [--json]` checks the current git diff against `allowedFiles` and runs `requiredCommands`.

## Task Contract

```json
{
  "schemaVersion": 1,
  "repo": "/path/to/repo",
  "goal": "Implement a scoped change",
  "allowedFiles": ["scripts/example.mjs"],
  "requiredCommands": ["npm test"],
  "requirements": ["Default behavior remains unchanged"]
}
```

## Consequences

- OpenCode summaries are evidence only after the runner verifies the repository state.
- Scope violations fail deterministically through `git diff --name-only`.
- Required commands are executed by the runner, not trusted from model output.
- ResonantOS Engineer UI and a guarded OpenCode launcher should call this runner instead of asking OpenCode to self-police.
