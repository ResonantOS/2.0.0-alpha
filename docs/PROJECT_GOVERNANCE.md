# Project Governance

## Sources Of Truth

- [GitHub Issues](https://github.com/ResonantOS/2.0.0-alpha/issues) are the
  public intake queue for bugs, feature requests, and bounded work proposals.
- [ResonantOS Project 2](https://github.com/orgs/ResonantOS/projects/2) is the
  release-planning source of truth for accepted scope, area, priority, and
  delivery status.
- Pull requests implement approved work. A pull request must link its issue and
  report the exact validation performed.
- Repository documents and code are authoritative for behavior. Chat history,
  agent memory, and local run artifacts are not project authority.

An issue label or milestone can help discovery, but it does not override a
populated Project 2 field.

## Roles And Decisions

Anyone may open an issue or propose a field value. Triagers may request missing
information, close duplicates, apply labels, and recommend Project 2 values.
Only maintainers with Project 2 write access may make a release-scope promotion
or declare an item `Done`.

Module responsibility is defined in
[Module Ownership](architecture/MODULE-OWNERSHIP.md). The project deliberately
does not use `CODEOWNERS` until maintainers and GitHub handles are verified.
Project assignment, the `Agent` field, or an issue comment does not transfer
module ownership.

## Project Fields

### Release Scope

| Value | Meaning |
| --- | --- |
| `Alpha MVP` | Required for the current browser-first alpha gate. |
| `Community Test` | Intended for the tester-ready validation phase after the minimum alpha gate. |
| `Deferred / Waived` | Explicitly excluded from the current release path until reconsidered. |
| `Experimental` | Useful exploration with no release commitment. |
| `Native Future` | Work for a possible future native product, outside the browser-first alpha. |
| `Legacy` | Historical work from an earlier repository or runtime line. |

### Area

Project 2 has one coarse `Area` value per item: `Bridge`, `Extension`, `Chat`,
`Settings`, `Hermes`, `OpenCode`, `Living Archive`, `Blackboard`, `Build`,
`Security`, `Docs`, or `Legacy`. Choose the area that owns the acceptance
criteria. Cross-cutting topical labels may provide more detail without changing
that single owning area.

### Status

| Value | Meaning |
| --- | --- |
| `Inbox` | Newly synchronized and not yet triaged. |
| `Backlog` | Accepted as valid work but not selected for near-term execution. |
| `TODOS` | Selected for follow-up, but still missing an owner, decision, dependency, or readiness evidence. |
| `Ready` | Scoped, accepted, unblocked, and ready to claim. |
| `In Progress` | An assignee or agent is actively implementing the item. |
| `In Review` | An implementation exists and is undergoing code or documentation review. |
| `Review / QA` | Review feedback is addressed and required integration, safety, or live proof is being checked. |
| `Blocked` | Progress cannot continue until a named dependency or decision is resolved. |
| `Deferred / Waived` | Delivery is intentionally postponed or the gate is explicitly waived. |
| `Done` | Acceptance criteria and required checks are complete and the change is merged or otherwise delivered. |

Closing an issue does not make the sync script set `Done`; the triager must keep
the Project 2 status consistent. Reopening an item returns it to triage unless
the current Project status is still accurate.

### Other Planning Fields

- `Priority` is `P0`, `P1`, or `P2`. `P0` blocks a committed gate or addresses
  an urgent safety failure, `P1` is important planned work, and `P2` is useful
  but lower urgency.
- `Size` (`XS` through `XL`) is a relative complexity estimate, not a deadline.
- `Estimate`, start date, and target date are optional planning aids.
- `Agent` and `Last Claimed At` coordinate active work. They do not replace an
  assignee, reviewer, or module owner.
- GitHub-native title, labels, assignees, reviewers, linked pull requests,
  milestone, parent, and sub-issue fields retain their normal GitHub meanings.

## Intake And Triage

1. Use the structured bug or feature form. Never post a vulnerability, token,
   credential, browser profile, private user data, or unredacted log publicly.
2. Confirm the report is reproducible, bounded, and not a duplicate. Route
   suspected vulnerabilities to the private process in
   [Security Policy](../SECURITY.md) without copying sensitive details.
3. Identify acceptance criteria, the owning module, safety/privacy impact, and
   any required live-browser proof or human-only handoff.
4. Apply at most one managed release-scope label and one managed area label.
   Set `Priority` only after impact and release relevance are understood.
5. Let the sync add the item to Project 2, then review the populated fields and
   move it out of `Inbox`.
6. Record blockers in the issue and name the dependency before using `Blocked`.
7. Link the implementation pull request. Move through review and QA based on
   evidence, not merely on an open or merged pull request.

## Release-Scope Promotion

The issue author's requested scope is advisory. A maintainer with Project 2
write access may promote an item toward `Community Test` or `Alpha MVP` only
when all of the following are visible on the issue:

- release value and user impact;
- bounded acceptance criteria and an owning module;
- dependencies and an accountable implementer or maintainer;
- deterministic checks for the proposed behavior;
- safety, privacy, secret-handling, and human-only boundary analysis; and
- a live-browser proof plan when the behavior depends on extension UI,
  permissions, or real browser interaction.

Promotion to `Alpha MVP` also requires evidence that deferring the item would
break the current alpha gate. Scope may be demoted when dependencies, risk, or
evidence change. Record the reason in the issue so the Project field is not an
unexplained planning decision.

## Project And Label Sync

The `project-issue-sync` workflow runs for issue and trusted-base
`pull_request_target` events, on a six-hour schedule, and by manual dispatch.
It uses
`scripts/sync-project-issue-labels.mjs` for open items in
`ResonantOS/2.0.0-alpha`.

The synchronization contract is:

1. Add missing open issues and pull requests to Project 2.
2. For a newly added item, infer empty `Release Scope` and `Area` fields from
   recognized labels, then set `Status` to `Inbox`.
3. For existing items with empty fields, recognized labels may populate those
   fields.
4. Once fields are populated, Project 2 wins and the script reconciles only
   the managed scope and area labels to the field values.
5. Before any write, validate the complete open-item snapshot. Multiple managed
   scope labels with an empty `Release Scope`, or multiple managed area labels
   with an empty `Area`, fail the run without partial synchronization.

Managed release-scope labels are:

| Project value | Label |
| --- | --- |
| `Alpha MVP` | `scope:alpha-mvp` |
| `Community Test` | `scope:community-test` |
| `Deferred / Waived` | `scope:deferred` |
| `Experimental` | `scope:experimental` |
| `Native Future` | `scope:native-future` |
| `Legacy` | `scope:legacy` |

Managed area labels are `area:bridge`, `area:extension`, `area:chat`,
`area:settings`, `area:hermes`, `area:opencode`, `area:living-archive`,
`area:blackboard`, `area:build`, `area:security`, `area:docs`, and
`area:legacy`.

Other topical labels currently in use, such as `area:agent-control`,
`area:augmentor`, `area:connectors`, `area:research`, and `area:voice`, are not
managed by the script. They may coexist with one managed owning-area label.
The script does not synchronize `Priority`, `Size`, or general status labels.

### Label Conflicts

Never leave multiple managed scope labels or multiple managed area labels on an
item with an empty corresponding Project field. The script aggregates all such
conflicts and exits before its first write. A triager must remove the conflict,
set the intended Project field, and run the sync again. Do not solve a conflict
by adding another label. Unmapped topical labels do not override the Project
field. Project 2 has no `P3` priority option even though some issues carry a
`P3` label; resolve that case explicitly in Project 2 rather than inventing an
automatic mapping.

## Dry Run And Recovery

Use a dry run before manual reconciliation or after changing credentials:

```bash
GH_TOKEN="$(gh auth token)" node scripts/sync-project-issue-labels.mjs --dry-run
```

The token must be able to read repository issues and pull requests and read and
write the organization Project. Dry run still needs read access. It logs
planned mutations but does not write. For an item not yet present in Project 2,
dry run logs the planned add but cannot fully simulate later field hydration on
that synthetic item.

The equivalent manual workflow dispatch is:

```bash
gh workflow run project-issue-sync.yml -f dry_run=true
```

Review the run log before dispatching with `dry_run=false`.

Before changing roadmap classifications, compare the canonical roadmap to a
fresh read-only Project 2 snapshot:

```bash
GH_TOKEN="$(gh auth token)" gh project item-list 2 --owner ResonantOS --format json --limit 500 > /tmp/resonantos-project-2.json
npm run project:check-roadmap -- --project-json /tmp/resonantos-project-2.json
```

The workflow runs the same check before synchronization writes. The comparator
uses a populated `Release Scope` field when present, otherwise the one unique
managed scope label allowed by the hydration contract. Beta milestone headings
are not duplicate `Release Scope` fields and are not compared by this check.

The workflow uses the repository secret `PROJECT_SYNC_TOKEN`. Events fail when
the secret is absent so Project 2 drift cannot appear green. Pull-request runs
execute only the repository default-branch revision of the workflow and
synchronization script, never the pull-request checkout or a non-default target
branch, and checkout does not persist Git credentials. If the token is expired,
revoked, or cannot see Project 2:

1. create or rotate a token with repository issue/pull-request access and
   organization Project read/write access;
2. replace the `PROJECT_SYNC_TOKEN` repository secret without posting its value
   in an issue, pull request, command transcript, or workflow log;
3. manually dispatch a dry run and inspect every planned change; and
4. dispatch a normal run only after the dry run has the expected repository,
   project number, fields, and label changes.

If a partial run leaves fields and labels inconsistent, stop repeated write
runs. Resolve duplicate managed labels, correct the Project 2 fields, run once
with `--dry-run`, then allow one normal reconciliation run.
