# Recipe: Job search

Job-search example from the Augmentor Future List. Surfaces opportunities in
tabs, drafts a cover-letter outline, and keeps the human in control of every
apply, send, and login step.

## Goal

Open several job postings across tabs, summarise each role in consistent
shape, draft a cover-letter outline that quotes the human's chosen experience,
and list the open tabs in a single review pane.

Goals and prompts describe intended workflows, not certified end-to-end
automation. Check generated claims against separately captured source content.

## Augmentor features used

- [#237 Workflow recipe documentation](../augmentor-future-list-acceptance-matrix.md#automation)
  — available; execution depends on the bounded capabilities below
- [#221 One-click / question-driven summaries](../augmentor-future-list-acceptance-matrix.md#summarization-research)
  — supported
- [#222 Session summary artifact with restart-safe context](../augmentor-future-list-acceptance-matrix.md#cross-tab-intelligence)
  — saved-state foundation; broader continuity needs hardening
- [#220 Cross-tab comparison with tab provenance](../augmentor-future-list-acceptance-matrix.md#cross-tab-intelligence)
  — needs hardening; provenance does not establish captured-content comparison
- [#31 Form reading & autofill guard (closed)](../augmentor-future-list-acceptance-matrix.md#automation)
  — supported

## Safe automated steps

The Augmentor can:

- Extract the job title, company, location, and required experience from a
  readable job-posting page.
- Summarise each posting separately with its source cited. Use those captured
  summaries as input to a comparison that the human checks against each page.
- Draft a cover-letter outline that quotes the human's chosen experience
  (templated by `#221`, never sent).
- Save each summary as a Living Archive intake item for the human to review.
- Search local browser history for related prior searches to avoid duplication
  (`/history` command).

## Human-only checkpoints

The Augmentor **must not** perform any of these autonomously:

- **Click** an "Apply" button on a job platform.
- **Fill** an application form with personal data (name, address, phone,
  visa status, salary history).
- **Upload** a résumé or portfolio to a third-party site.
- **Type** into password, credential, MFA, or SSO fields.
- **Send** an email or LinkedIn message to a recruiter or hiring manager.
- **Submit** an application form (any site, any field).
- **Connect or sign** with a wallet for any platform that requires it.

Every one of those steps stops for an explicit human handoff per
[AGENTS.md](../../AGENTS.md) and the
[Augmentor tester runbook](../augmentor-tester-runbook.md#4-human-only-boundaries-verify-these-refuse).

## Suggested prompts

- "Summarise this job posting as title, company, location, must-have
  experience, and nice-to-have experience. Cite the section you read."
- "Using these separately captured posting summaries, draft a comparison
  table with source citations for me to check against the original pages."
- "Draft a 200-word cover-letter outline that references my 'eight years of
  platform engineering' profile block. Do not add any facts I have not
  given you."
- "Capture the source pages as a research trail for archive review. I will
  separately retain and check the generated comparison."

## Evidence to capture

- The separately captured summaries and human-checked comparison with source citations.
- The saved Living Archive intake item id.
- A screenshot of the human-only checklist above being shown in the side
  panel after the human reviews the outline.

## Safety boundaries & references

- [AGENTS.md trust boundaries](../../AGENTS.md#secrets-and-local-state)
- [Product Guide — Run A Browser Task](../product/PRODUCT_GUIDE.md#run-a-browser-task)
- [Augmentor tester runbook — human-only boundaries](../augmentor-tester-runbook.md#4-human-only-boundaries-verify-these-refuse)
- [Future List acceptance matrix — Multi-step workflows](../augmentor-future-list-acceptance-matrix.md#automation)
