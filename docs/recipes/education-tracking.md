# Recipe: Education and progress tracking

Education and progress-tracking example from the Augmentor Future List.
Captures course pages, syllabus content, and progress milestones into the
Living Archive so the human can review them across restarts, while leaving
every enrollment, payment, and forum post to the human.

## Goal

Open a course page (or several), capture the syllabus and assessment plan,
summarise upcoming milestones, and save a continuing-learning intake to the
Living Archive that survives a session restart.

Goals and prompts describe intended workflows, not certified end-to-end
automation. Check generated claims against separately captured source content.

## Augmentor features used

- [#237 Workflow recipe documentation](../augmentor-future-list-acceptance-matrix.md#automation)
  — available; execution depends on the bounded capabilities below
- [#218 Page content analysis / Q&A](../augmentor-future-list-acceptance-matrix.md#web-understanding)
  — supported
- [#221 One-click / question-driven summaries](../augmentor-future-list-acceptance-matrix.md#summarization-research)
  — supported
- [#222 Session summary artifact with restart-safe context](../augmentor-future-list-acceptance-matrix.md#cross-tab-intelligence)
  — saved-state foundation; broader continuity needs hardening
- [#227 Research-trail save and archive review handoff](../augmentor-future-list-acceptance-matrix.md#summarization-research)
  — partial save/review foundation; broader acceptance remains open
- [#228 Living Archive context continuity acceptance proof](../augmentor-future-list-acceptance-matrix.md#cross-tab-intelligence)
  — restores saved state; does not reopen or verify live tabs
- [epic #212 beta.1 — Living Archive and context continuity proof](../augmentor-future-list-acceptance-matrix.md#milestone-epics)
  — closed tracking epic; broader workflow acceptance is separate

## Safe automated steps

The Augmentor can:

- Extract the course title, provider, duration, prerequisites, and
  assessment plan from a course page.
- Summarise the syllabus into a week-by-week reading list with citations
  (`#218` and `#221`).
- Capture readable course pages as a research trail for Living Archive review
  (`#227`); the human checks any generated milestone plan separately.
- Restore explicitly saved context after a restart (`#228`); the human reopens
  relevant pages and verifies the syllabus and milestones against current content.
- Search local browser history for prior course-related searches to avoid
  duplication (`/history` command).

## Human-only checkpoints

The Augmentor **must not** perform any of these autonomously:

- **Enroll** in any course, certificate program, or cohort.
- **Pay** for a course, subscription, or exam voucher.
- **Post** in any course forum, study group, or cohort chat with the
  human's account.
- **Submit** any assignment, quiz, or exam answer.
- **Connect or sign** with any identity or learning-platform SSO on the
  human's behalf.
- **Add** the course schedule to a calendar.

Every one of those steps stops for an explicit human handoff per
[AGENTS.md](../../AGENTS.md) and the
[Augmentor tester runbook](../augmentor-tester-runbook.md#4-human-only-boundaries-verify-these-refuse).
The intake is **not** a confirmed enrollment; it is a draft the human
takes to the platform.

## Suggested prompts

- "Summarise this course page as title, provider, weeks, prerequisites,
  assessments. Cite each section you read."
- "Build a week-by-week reading list from this syllabus. Cite each week."
- "Capture these course pages for archive review. I will check the proposed
  milestones and retain the reviewed plan separately."
- "After I restart, show the restored saved context so I can check the
  syllabus and milestones against the live tabs myself."

## Evidence to capture

- The week-by-week reading list with each citation.
- The Living Archive intake item id for the continuing-learning capture.
- A screenshot of the human-only checklist above being shown in the side
  panel after the human reviews the milestones.

## Safety boundaries & references

- [AGENTS.md trust boundaries](../../AGENTS.md#secrets-and-local-state)
- [Product Guide — Run A Browser Task](../product/PRODUCT_GUIDE.md#run-a-browser-task)
- [Augmentor tester runbook — human-only boundaries](../augmentor-tester-runbook.md#4-human-only-boundaries-verify-these-refuse)
- [Future List acceptance matrix — Multi-step workflows](../augmentor-future-list-acceptance-matrix.md#automation)
- [Living Archive](../architecture/ALPHA_RUNTIME_BOUNDARY.md) runtime boundary
