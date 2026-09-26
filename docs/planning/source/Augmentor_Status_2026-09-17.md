# Augmentor: status update

**From:** Tom · 17 September 2026 · follows the 16 September sync report

Where we are: six changes merged to `dev` since the last report, all green.
Andrew's planning set and demo report arrived as PR #453 and have been answered.
The swap demo stays on hold; the demo we do run has to show Manolo's harness as
the Augmentor.

## Merged since the last report

| PR   | What changed |
| ---- | ------------ |
| #454 | Saved browser-job records are redacted. Two existing leaks closed: bearer tokens surviving in session summaries, and encoded secret parameters surviving both redaction paths. Old stored records are cleaned up on load. |
| #455 | Page, tab and attachment text no longer enters the system prompt. It travels in the user turn, marked untrusted, and cannot forge its source URL. |
| #456 | Every citation in the Future List acceptance matrix is now true, and `docs:check` fails when a cited file does not exist. |
| #457 | A failed read of job history can no longer lead to overwriting the saved history. New jobs are refused with a clear message instead of being accepted and lost. |
| #458 | One guarded writer for job storage: the workspace cancel/focus writes and the Settings clear now go through it, so nothing bypasses redaction, id safety or the failed-read guard. |
| #459 | Test fix: an order assertion added by #458 depended on timing and failed on CI. Product behaviour unaffected. |

Each change was planned and attacked by models from three vendors, proved
non-vacuous by mutation testing, and passed the full release gate. Two defects
were caught by the gates after reviewers had approved the code: a Settings clear
that wiped a running job, and the timing-dependent test above.

## Reply to Andrew (PR #453)

**Convergence:** confirmed for the Guardian, One Augmentor, the SDK location and
Node. Four rows need correcting:

- the field classifier is **not done** (#451 made unrecognised controls
  human-only; moving the classifier into Manolo's executor is still open);
- Guardian **Phase 1 is not complete**;
- **two-person review** is a working assumption;
- the **~12-week timeline** is his team's proposal.

**His PR:** approve with changes. Its required check fails because
`docs/planning/` is not in the release-scope allow list; he has the exact fix.
DAO, NFT and marketplace items must read as **undecided proposals**, not
scheduled work.

**Target repo:** confirmed, this repo.

**Demo date:** not yet. The demo shows the old Augmentor Chat as "the Augmentor"
with DeepSeek beside it as a third-party add-on — the arrangement One Augmentor
replaced.

**Work split:** we take the system-prompt follow-up; the classifier upstream and
the commit broker are offered to him; the Guardian stays with him.

## Open items

| Item | Owner | Status |
| ---- | ----- | ------ |
| Organisation owner settings: base permission to Read, members cannot delete or transfer | Manolo | waiting |
| Publish Augmentor 0.1.33 from his repo, and add a second npm maintainer | Manolo | waiting |
| Agree the privilege split (§13.2) and the classifier going into his action executor | Manolo | waiting |
| Future List rewrites: eight lines proposed, one page | Tom → Manolo | ready to send |
| #453: fix the release-scope check, correct the four rows, mark DAO/NFT/marketplace undecided, fix stale paths | Andrew | requested |
| Demo: make Manolo's harness the Augmentor, then book a date | Andrew | open |
| Scope decision: is DAO, NFT and marketplace work in or out? | Tom | open |
| Release tags: only the two-person release-managers team can publish `v*` | Tom | done |

## Next steps, in order

1. Finish the job-history failure UI (in progress): show "history could not be
   loaded" with Retry instead of an empty list. Re-review is under way after a
   harness error of mine gave the reviewers the wrong diff.
2. Keep Living Archive and memory text out of the system prompt — the follow-up
   to #455, now ours. Plan written and reviewed.
3. Containment design for the DeepSeek Harness engine — Linux-first, drafted;
   needs Manolo's agreement before any build.
4. Send the Future List note to Manolo, and chase the three items waiting on him.
5. Settle the DAO/NFT/marketplace scope so Andrew's R2–R10 items can be answered
   rather than deferred.
