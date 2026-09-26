# Daily Summary Protocol

Daily summaries keep the development team aligned on the ResonantOS
post-consolidation architecture and SDK/DAO governance program. Each summary is a
short, dated, factual record — not a planning document.

## Purpose

- Present the same phase, checkpoint, and checklist state to the whole team.
- Surface blockers, decisions needed, and risks within 24 hours.
- Produce a durable, date-stamped log that can be audited against the
  [master implementation plan](../03-master-implementation-plan.md).

## Rules

1. One file per day, named `YYYY-MM-DD.md`.
2. Copy [`TEMPLATE.md`](TEMPLATE.md) to start; fill every section.
3. Report **facts only** from repository evidence, deterministic checks, GitHub
   issues, and Project 2. Do not invent progress.
4. Every phase/checkpoint reference must use the IDs from the master plan.
5. A "Done" item names the artifact, PR, commit, or check that proves it.
6. A "Blocked" item names the owner and the decision or unblock needed.
7. Keep it short enough to read in under five minutes.

## Sections

| Section          | What goes in it                                         |
| ---------------- | ------------------------------------------------------- |
| Status line      | Date, phase(s) in focus, on/off track vs. the timetable |
| Done today       | Dated, verifiable completions with evidence             |
| In progress      | Work currently open, with owner                         |
| Blockers / risks | What is stopping progress and who can unblock           |
| Decisions needed | Questions for the team or maintainers, with deadline    |
| Checkpoints      | Checkpoint IDs hit, at risk, or moved                   |
| Tomorrow         | The next day's concrete target                          |

## Presenting to the team

- Lead with the status line and the single most important blocker/decision.
- Read checkpoint changes aloud; everything else is reference.
- End with the explicit ask: what you need from whom, by when.

## Index

- [2026-09-16 kickoff summary](2026-09-16-kickoff.md) — dated record; leave as-is.
- [2026-09-17 summary](2026-09-17.md) — ADR-038 resolution, Grok-Build demo PASS, docs ready for Tom.
- [Daily summary template](TEMPLATE.md)
