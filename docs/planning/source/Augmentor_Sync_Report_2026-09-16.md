# Augmentor: where we are and what's next

**Subtitle:** Status sync covering 10–16 September
**Original file:** `Augmentor-Sync-Report 9.16.2026.pdf`
**Date:** 16 September 2026
**From:** Tom · For Andrew and Manolo

> This file is a verbatim Markdown conversion of the source PDF (page headers and
> footers removed). It is retained as reference material and is **authoritative
> direction** for the current state of the program. The reconciled,
> execution-oriented view lives in the
> [master implementation plan](../03-master-implementation-plan.md).

---

## Status note

The swap demo is on hold. Andrew has demo work in progress and I don't want to
duplicate it. I can't see it on GitHub yet (latest push 11 September). Andrew,
please share what the demo covers and where the code lives. We'll plan the next
steps around it.

## Direction

| One Augmentor | ResonantOS wraps it | One codebase |
| --- | --- | --- |
| Manolo's DeepSeek Harness Augmentor is the product and keeps the name. | ResonantOS supplies governance, memory and integrations. The harness engine runs inside OS-level confinement. | Manolo's repository now lives in ResonantOS/2.0.0-alpha under `apps/augmentor`. We all work from there. |

## Done

| Merged | PR | What changed |
| --- | --- | --- |
| 16 Sep | #452 | ADR-038: the Guardian is a small, deterministic service that can only restart or roll back. The ADR also defines the Core-only invariants. ADR-038 is now taken on dev, so new ADRs start at 039. |
| 16 Sep | #451 | Form controls the classifier doesn't recognise stay human-only at every automation level. |
| 16 Sep | #450 | Augmentor 0.1.33 is prepared, and its update channel moves to the ResonantOS repo. The release rehearsal passes. Not published yet. |
| 16 Sep | #448 | Manolo's Augmentor was imported with its full commit history and authorship intact. The repo moved to Node 24.21.0. |
| 13 Sep | #447 | The OpenCode boundary is now governed. The extension never holds the OpenCode address or credential, access is capability-scoped, and access can be revoked while running. Closes #321. |
| 11 Sep | #446 | The dev server now gives the bridge config only to pages that present a key. Closes #429. |

Also merged 10–11 Sep:

- Simon: ten Settings PRs (#393–#422).
- Andrew: add-on SDK moved to `packages/addon-sdk` (#441), plus a live-test CDP fix (#445).
- Tom: #433, #438, #443.

Also done: mapped the 44 Future List items to GitHub issues, reviewed Andrew's
14 September roadmap, and reviewed repository access (owner settings sent to
Manolo).

## Decisions

| Decided | Proposed: needs agreement |
| --- | --- |
| Payment and checkout: the agent prepares the purchase and hands off to the user. Automating checkout needs a separately reviewed exception, never a setting. | Privilege split (§13.2), needs Manolo: only the parts that hold authority get privileges: the actuation executor with its field classifier, the commit broker, credential custody and the update channel. |
| Personal-contact fields: replace the blanket block with named disclosure tied to a destination. Not built yet. | Everything else stays first-party but runs as a public extension. |
| Unrecognised controls: human-only (shipped, #451). | Two-person review on invariant paths (§13.10): a working assumption, not applied. |
| Guardian (roadmap §13.1): a separate deterministic service with no model. It can only restart or roll back. The Engineer AI can advise but holds no recovery authority (ADR-038). | #444 DeepSeek dispatcher: the direction changed after this PR opened. Let's decide together what carries forward. |

## Next

| Milestone | Task | Owner | Status |
| --- | --- | --- | --- |
| 1 · Repo and release safety | Apply the organisation owner settings (sent 15 Sep) | Manolo | waiting |
| 1 · Repo and release safety | Protect release tags before any release is published | Tom | next |
| 1 · Repo and release safety | Publish Augmentor 0.1.33 from Manolo's repo, after the ResonantOS-side release | Manolo | waiting |
| 1 · Repo and release safety | Add a second npm maintainer to `dsh-augmentor` | Manolo | waiting |
| 2 · Demo alignment | Share the demo scope and code | Andrew | requested |
| 2 · Demo alignment | Agree the demo plan. The swap demo stays on hold until then. | Tom + Andrew | next |
| 2 · Demo alignment | Rebase #440 and #442 onto dev (both conflict), and settle #444 | Andrew | open |
| 3 · Governed Augmentor | Add the field classifier to Manolo's action executor (upstream PR) | Open · Manolo reviews | open |
| 3 · Governed Augmentor | Run the harness engine inside OS-level confinement | Open | open |
| 3 · Governed Augmentor | Commit broker: named confirmation before send, book or apply | Open | open |
| 3 · Governed Augmentor | macOS support for the harness (not yet verified) | Open | open |
| 4 · Guardian and authority | Guardian contract, then prove restart and roll-back | Open | open |
| 4 · Guardian and authority | Split add-on capability requests from host grants. Move the add-on registry and authority into the bridge. | Open | open |
| 4 · Guardian and authority | Fix primary-agent slot gating in the shell and `packages/addon-sdk` | Open | open |
| 5 · Small fixes | Redact saved job traces · keep page text out of the system prompt · restore Simon's Settings shapes in the compact layout | Open | open |
| 5 · Small fixes | Fix the acceptance-matrix citations and add a citation check · file an issue for FL-02 (omnibox) | Open | open |
| 6 · Future List | Proposed rewrites for Future List items that conflict with the safety model | Tom → Manolo | next |

Open = unassigned. Milestones 3 and 4 touch the add-on SDK. Let's claim them in
the sync so we don't overlap.

## For the sync

- Andrew: what does your demo show, and where is the code? Which open tasks do you want?
- Manolo: do you agree with the privilege split? When can you apply the owner settings and publish 0.1.33?
