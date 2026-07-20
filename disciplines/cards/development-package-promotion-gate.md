# Development Package Promotion Gate

Status: active-pattern
Steward: ResonantOS maintainers / Arcanum issue loop users

## Purpose

Keep raw development and run packages out of ResonantOS product pull requests
unless a repository guideline explicitly promotes a distilled artifact as
source, release documentation, review evidence, or durable validation evidence.

## Boundary

This discipline governs ResonantOS commit and pull request surfaces. It does
not forbid source, tests, contributor docs, architecture docs, review reports,
release-scope docs, or curated evidence that the repository already treats as
durable. It also does not own Arcanum's framework-level discipline catalog; if a
practice should be reusable beyond ResonantOS, promote a product-neutral version
to Arcanum after the local rule is in place.

## Evidence

- [Agent instructions](../../AGENTS.md) define the repository scope, secret, local-state, and unrelated-work boundaries.
- [Contribution workflow](../../CONTRIBUTING.md) requires focused branches, ownership review, and exact validation evidence.
- [Project governance](../../docs/PROJECT_GOVERNANCE.md) keeps raw execution output out of project authority and routes durable work through Issues and Project 2.
- [Alpha distribution](../../docs/release/ALPHA_DISTRIBUTION.md) excludes local runtime state, browser profiles, output, runs, and generated credentials from release artifacts.

## Validation

- Mode: mixed
- Check: `npm run discipline:validate` plus `npm run browser-first:audit-scope:staged` before publishing PRs that touch governance or release-scope files.
- Result is established by the current catalog validation and staged scope audit, not a dated narrative report.

## Quality Bar

A ResonantOS pull request satisfies this discipline when:

- raw `development/`, refinement, invoke, task-session, runtime, observability, research, or scratch package paths are absent unless explicitly promoted;
- the PR contains only the source, tests, docs, scripts, or curated evidence needed for the actual change;
- any non-committed run evidence is summarized in the PR body or issue comment instead of bundled as raw process output;
- the final changed-file set matches the stated dependency map and affected-only hypothesis;
- local discipline validation runs before any Arcanum/framework promotion claim.

## Promotion Guardrail

This discipline can recommend an Arcanum discipline, validator, release-scope
rule, or issue-loop contract update, but it cannot promote raw development
packages or framework guidance by itself. Framework promotion must keep this
local-first rule visible.
