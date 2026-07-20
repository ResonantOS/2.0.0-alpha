# ADR-010: Recovery Ladder & Engineer Promotion Flow

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Deferred
- Superseded by: None
- Owner: Recovery
- Decision date: 2026-04-23
- Alpha note: The recovery product workflow is not required for Alpha.

## Decision

Recovery mode is a staged ladder, not a generic low-capability debugging session.

The `Resonant Engineer Agent` starts on the local recovery floor model, but its first priority is to restore access to a stronger model or runtime route. Only after that promotion should it perform deeper diagnosis and repair.

## Why

- The local recovery floor is valuable for bootstrapping, but not ideal for deeper diagnosis or complex repairs.
- A weak emergency model should restore better reasoning capacity before attempting broad system repair.
- Recovery needs a deterministic order of operations so it does not waste time or make fragile edits while underpowered.

## Model Tiers

- `Floor`
  - guaranteed minimum local recovery model
  - current default: local Ollama-backed Gemma route
- `Recovery`
  - stronger model used by the `Resonant Engineer Agent` once connectivity or remote runtime access is restored
- `Operational`
  - normal Strategist-grade route for full system operation

The floor must remain available as a fallback even after promotion.

## Rules

- Recovery mode starts with the `Resonant Engineer Agent`, not the Strategist.
- Strategist and archive ingest are offline during active recovery.
- The first recovery objective is `restore better brain`.
- Promotion to a stronger route requires real validation, not just config presence.
- Recovery must distinguish:
  - no network
  - local network only
  - endpoint reachable but auth broken
  - auth valid but model unavailable
  - runtime configured but unhealthy
- Recovery changes must be logged with explicit tool/action summaries.

## Recovery Phases

### 1. Establish Facts

- confirm the local recovery runtime is alive
- inspect the current runtime and provider state
- write the initial diagnosis

### 2. Restore Better Brain

- probe internet reachability
- probe stronger cloud providers
- probe user-owned remote/local runtime nodes
- inspect configuration drift and credential status

### 3. Validate Candidate

- choose the best stronger candidate
- run a real probe turn or route validation
- confirm it is usable enough for promotion

### 4. Promote

- move the `Resonant Engineer Agent` onto the stronger route
- preserve the local floor as fallback
- tell the user which stronger model is now recommended for the next phase

### 5. Deep Diagnosis

- inspect logs, docs, ADRs, config, and code
- narrow the root cause

### 6. Repair

- apply the safest practical repair
- keep the change log current

### 7. Verify

- rerun probes, tests, or service checks
- confirm the system is stable enough to exit recovery

### 8. Handoff

- write the recovery report
- return control to the Strategist

## Required Engineer Tools

The Engineer recovery path must have host-mediated tools for at least:

- local runtime status
- network probe
- provider route probe
- file listing and file reads
- codebase search
- targeted file edits
- safe command execution
- structured recovery change logging

These are recovery-only capabilities and remain bounded by host-side policy.

## Promotion Policy

The Engineer Agent should rank candidates in this order unless the user overrides:

1. healthy stronger local/remote user-owned runtime
2. healthy preferred cloud provider
3. experimental but reachable cloud/runtime route
4. remain on local floor if no stronger route validates

Promotion should be explicit and visible to the user.

## Blind Spots To Guard Against

- Do not treat “endpoint reachable” as “model usable”.
- Do not overwrite config just because a route fails once.
- Do not let the floor model make broad architectural changes without better-brain restoration if a stronger route can be recovered first.
- Do not drop the floor fallback after promotion.
- Do not rely on chat text alone for the audit trail; use structured tool/action logs.

## Consequences

- Recovery mode is now a specialized workflow, not just a themed chat surface.
- Engineer tooling should continue to expand around staged recovery needs.
- Future UI should expose:
  - recovery phase
  - candidate stronger routes
  - promotion recommendation
  - change log
  - recovery report
