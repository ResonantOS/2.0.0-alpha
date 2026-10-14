# Embedded governance execution notes

Execution on `testing/augmentor-embed-sidecar`; Tasks 1–10 and 12, with Task 11 limited to script preparation and syntax validation. No commits, workflow edits, generated bridge configuration edits, or live proof execution are authorized.

## Important review finding: stale-lock recovery

The full Grok review was read as review evidence. This follow-up changes only
`browser-first/host/embed-governance-storage.mjs`, its storage test, and these
notes. The two Minor findings remain outside the assigned scope. Normal live
owner `release()` is unchanged.

The conductor approved replacing the tombstone rename with an exclusive
`writer.lock.recovery` directory. Normal acquisition still uses exclusive
`mkdir writer.lock` and creates `owner.json` with `O_EXCL`. Recovery first reads
a valid dead owner (`ESRCH`), acquires the guard with exclusive `mkdir`, and
creates private `guard.json` with `O_EXCL`: `pid`, random `uuid`, and `created`
(milliseconds since the Unix epoch). Under the guard it rereads `owner.json`,
requires the same PID and ownership UUID, and checks `ESRCH` again before
removing the stale owner and directory. The guard remains held until the fresh
writer directory and owner are installed. Cleanup checks the guard's PID, UUID,
and timestamp before removing it. The tombstone path is removed. Normal
live-owner `release()` is unchanged.

Guard contention fails closed for activity storage for that bridge run, without
waiting, spinning, or retrying in the background. The existing service catches
storage startup failure and keeps metadata recording unavailable; chat and page
sharing remain independent of successful logging. A subsequent bridge startup
can reclaim a guard only if its valid recorded PID returns `ESRCH` and its
`created` timestamp is strictly more than 60 seconds old. An exclusive `cleanup`
directory inside the abandoned guard serializes its removal, so two delayed
cleaners cannot remove a newly published guard. Under that marker the identity,
age, and dead PID are checked again; acquisition then gets one exclusive attempt.
A live/reused PID or `EPERM` never authorizes removal.

**Residual crash window:** a dead process's guard younger than or equal to 60
seconds continues to block stale-lock recovery. A bridge that encounters it
keeps logging unavailable for that run, even after the window elapses; recovery
requires a later startup. A crash between guard `mkdir` and complete metadata
publication leaves an unverifiable guard that fails closed regardless of age.
A crashed cleaner can leave its exclusive `cleanup` marker; that unverifiable
marker also fails closed rather than recursively starting another recovery
protocol. These interrupted-publication/cleanup cases require operator repair
with the bridge stopped. Missing/malformed writer metadata likewise remains
unrecoverable automatically.

The retained filesystem-hook regression now exercises the late interleaving
that defeated tombstone rename: delay a recoverer after its initial dead-owner
check, install the other bridge's fresh live owner, then resume. It checks that
the winner's lock remains in place, a third bridge cannot acquire it, and the
winner can still write. With the previous tombstone implementation, the initial
18-test run had nine passes and nine assertion failures, including the stolen
live lock. The guarded implementation passes all 22 storage tests. Added cases
cover a second recoverer while the guard is held, an unpublished guard, younger
and older abandoned guards, old live/EPERM guards, changed PID/UUID/liveness on
owner recheck, cleanup preserving a changed guard UUID, concurrent
abandoned-guard cleaners, and interrupted cleanup. The concurrent-cleaner test
first failed against the initial guarded implementation (one test, zero passes,
one assertion failure), then passed with the exclusive cleanup marker.

Three additional `rig-mutate` cases used
`~/.claude/skills/resonant-rig/scripts/rig-mutate` on the uncommitted source:

- Changing guard creation from exclusive `mkdir` to recursive `mkdir` made the
  unpublished-guard assertion fail: one test, zero passes, one failure.
- Removing the PID/ownership UUID recheck made both changed-owner assertions
  fail: two tests, zero passes, two failures.
- Making the abandoned-guard cleanup marker nonexclusive made its concurrent
  cleaner assertion fail: one test, zero passes, one failure.

All three mutation commands exited zero (mutant killed), restored the candidate
byte-for-byte, and were independently checked against its pre-mutation SHA-256.
Captured failures are behavioral assertions, not syntax or import errors. The
restored storage plus consumer command below passes 45 tests, zero failures,
skips, cancellations, or todo. Mutation scripts and raw logs remain outside Git
in the temporary execution evidence directory under `guard-followup/`.

Current follow-up validation (Node 24.21.0):

- `node --test browser-first/test/embed-governance-storage.test.mjs`: 22 passed,
  zero failures, skips or cancellations.
- Storage plus its direct service consumers: 45 passed, zero failures, skips or
  cancellations, using the explicit command below.
- `npm run repo:hygiene`: passed.
- `npm run docs:check`: passed.
- `npm run test:docs`: 293 passed, one suite, zero failures, skips or cancellations.
- `node scripts/security-pipeline/run-check.mjs`: all seven checks passed.
- Final `npm run test:browser-first`: exit 1; 2,403 tests, 2,393 passed, eight
  failed, two skipped, zero cancelled or todo (227273.983458 ms). All
  embed-governance tests passed, including the pagination case. The eight
  failure names match the historical record below: two CLI artifact self-tests
  and six SDK fault tests, again reporting absent delegation artifacts and
  OpenCode HTTP 500/missing-session prerequisites. The same two skips remain:
  nested macOS sandbox unavailable and no launchable Chrome. This follow-up did
  not rerun an unchanged baseline and does not claim a clean full suite.

The earlier full-suite run (2,401 tests: 2,391 passes, eight failures, two skips)
preceded the cleanup-marker additions and is not final-source verification.
The final run above started after all source changes and mutations finished.
Only these three files are changed in this follow-up:

- `browser-first/host/embed-governance-storage.mjs`
- `browser-first/test/embed-governance-storage.test.mjs`
- `docs/planning/embed-governance-execution-notes.md`

```bash
node --test --test-concurrency=1 browser-first/test/embed-governance-storage.test.mjs browser-first/test/embed-governance-host-service.test.mjs browser-first/test/embed-governance-acceptance.test.mjs browser-first/test/embed-governance-transport.test.mjs browser-first/test/bridge-route-capability-audit.test.mjs
```

## Execution record

Raw command logs and mutation evidence are retained outside Git in the temporary
`embed-governance-execution/` evidence directory.

## Deviations and boundaries

- The requested existing worktree and branch are used; no branch creation or commits. The conductor owns commits.
- The repository has no `RTK.md`; inherited `~/RTK.md` was read.
- Manual checkout bridge startup and Task 11's live upstream/integration proof are not run because they would violate the explicit script-only and generated-config constraints. The required test suites still run their isolated bridge fixtures. Tasks 7–10 are implemented per the user's explicit instruction; upstream protocol acceptance remains pending conductor proof.

- Task 1: default Vitest and Vite config bundling cannot write `node_modules/.vite-temp` because this worktree's dependency symlink points outside writable roots. Original commands failed with EPERM before tests/build bundling; TypeScript compilation completed. `--configLoader runner` passes the SDK tests (75). Keep original failures visible; use the runner loader as supplemental validation.
- Execution correction: an auxiliary Task 4 mutation-inspection process overlapped the initial Task 5 combined test run, producing an expected-rejection failure in `root and ancestor links, repository destinations and missing roots beneath links create no feature data`. That run is invalid verification, not a sandbox artifact. Serial restored rerun passed 18/18. A subsequent capacity run reported `pagination is insertion order and removed anchors expire` storage-unavailable; the exact Task 5 matrix's baseline and final 10/10 tests passed. Retain and recheck this intermittent failure in final gates.

- Task 7 correction (review-confirmed, regression red then green): the plan's controller reused a host-learned notice acknowledgement after a later state-read failure. That contradicts “read failure means unknown.” Track successful-share mount-local acknowledgement separately; discard host-only acknowledgement on failed reads and on fresh false snapshots while retaining the explicitly allowed local fallback after successful confirmed dispatch. Regression: `failed notice read discards host-only acknowledgement but preserves this mount successful-share fallback`.
- Task 11's deterministic contract keeps the exact `p.conversationId=true` assertion required by its red-evidence step, in addition to the provided source checks.
- Additional Task 7 coverage explicitly checks off-to-on without backfill and that focus/poll never write recording or notice consent, as required by the task prose.
- Added a README link to these notes so they remain reachable after the conductor adds the new file to Git.

- Task 7 correction (review-confirmed, regression red then green): `clear()` in the plan aborted notice persistence during ordinary recording-off refreshes and suppressed the save-failure announcement via the metadata generation counter. Notice writes now have their own pending set and mount generation. Polling, recording changes and metadata queue resets leave them intact; frame replacement and destruction still cancel them. Regression: `recording-off refresh preserves notice persistence and reports a later save failure`.

## Task evidence

Every task's initial test ran before implementation. Missing-module/export failures for new modules establish introduction only; guard evidence comes from behavioral mutations below. All commit steps were skipped as requested.

| Task | Initial red | Restored task checks |
| --- | --- | --- |
| 1 | 1 passed, 2 failed: missing interface diagnostics | 3 Node tests; 75 SDK Vitest tests with runner loader |
| 2 | Missing canonical contract | 51 contract/redaction tests; 7 guard mutations plus generated-copy parity mutation |
| 3 | Missing `getDescriptor` | 25 descriptor/tunnel tests; origin-hash mutation |
| 4 | Missing storage module | 9 storage tests; 12 guard mutations |
| 5 | Missing host service | 10 host tests including capacity/race; 11 guard mutations |
| 6 | 3 failures: no-store, method-family response, streaming limit | 40 transport/bridge/audit tests before extra case; 4 transport tests after extra case; 6 guard mutations |
| 11 | Missing `EMBED-UPSTREAM-1` contract | 1 script-contract test, syntax check, conversation-ID assignment mutation; live script never executed |
| 7 | Missing controller | Initially 8 controller tests; now 10 with review regressions; 8 guard mutations |
| 8 | Missing dialog; isolated action test incorrectly returned `Page shared` on cancel | 6 sharing/dialog tests; 4 guard mutations |
| 9 | 7 passed, 3 failed: missing badge, raw-history canary, malformed descriptor | 23 model/bar/composition tests; descriptor guard mutation |
| 10 | Missing `mountEmbedActivityCard` export | 44 privacy/settings tests; 3 guard mutations |
| 12 | Composition passed; acceptance-boundary documentation assertion failed | 2 acceptance tests |

The nine exact task mutation matrices report 53 behavioral guard kills, and generated-copy parity adds one (54). Task 11's separate script-contract mutation adds one more (55). Task 7's separately requested source-only and origin-only mutations add two (57 total mutation cases). The Task 7 matrix was rerun successfully after the review fixes. Each guarded source was restored byte-for-byte. Because `rig-mutate` suppresses child output, the behavioral matrices were also replayed with captured output to inspect their actual assertion failures; syntax/import failures were not counted. Detailed synthetic-only evidence stays outside Git.

## Historical implementation validation

The explicit Node command covers all 24 Node test files referenced anywhere in the plan, including files omitted from its final command but used in individual task checks. After the two review fixes it passes 227 tests, zero failures/skips/cancellations. The exact file list follows in the command appendix.

- `npm run docs:check`: passed.
- `npm run test:docs`: 293 passed, 1 suite, zero failures/skips/cancellations.
- `node scripts/security-pipeline/run-check.mjs`: 7 checks passed: npm-lockfiles, committed-private-key-material, subprocess-no-argv-secret, subprocess-env-clear, subprocess-pinned-roots, subprocess-terminal-allowlist, subprocess-no-shell-string.
- `npm test -- --run`: exit 1 before collecting tests, Vite configuration cache write EPERM. No failing test name exists because startup failed. Supplemental `npm test -- --run --configLoader runner`: 724 tests passed across 48 files.
- `npm run build`: exit 1 during Vite configuration cache write; preceding TypeScript compilation passed. Supplemental `npm run build -- --configLoader runner`: passed, 394 modules transformed; existing >500 kB chunk-size warning remains.
- `node scripts/prepare-embed-governance.mjs --check`: passed.
- `node --check browser-first/test/embed-live.mjs`: passed; script not executed.
- `node --test --test-concurrency=1 scripts/module-ownership-doc.test.mjs`: 2 passed.
- `npm run verify:alpha`: exit 1 at `repo:hygiene`, before later gates. Remaining violations are `[founder-path]` in the pre-existing `docs/planning/embed-governance-plan.md` and `docs/planning/embed-governance-plan-review-1.md`. These are baseline document-policy failures, not sandbox artifacts. The initial run also flagged this new notes file; its inherited instruction path was made home-relative and the rerun contains only the two baseline violations.
- `npm run test:browser-first`: final reviewed run exited 1: 2,390 tests, 2,380 passed, 8 failed, 2 skipped, zero cancelled/todo (225391.852 ms). The earlier run, before the two review regression tests were added, had 2,388 tests, 2,378 passed, the same 8 failures and 2 skips. All embed-governance tests passed, including the previously intermittent pagination case.

### Browser-first failures and baseline comparison

The eight final failures are:

1. `Hermes CLI execution bridge routes prompts through the safe local runtime adapter`
2. `OpenCode CLI execution bridge routes pass in-process deterministic smoke test`
3. `live SDK lane detects injected opencode-version-pin fault`
4. `live SDK lane detects injected opencode-proxy-capability fault`
5. `live SDK lane detects injected opencode-proxy-scope fault`
6. `live SDK lane detects injected opencode-proxy-revocation fault`
7. `live SDK lane detects injected opencode-proxy-raw-log fault`
8. `raw-log fault fails at credential scan`

The first two are in `browser-first/test/addon-cli-execution-inprocess-self-test.test.mjs`; their child self-tests exit 1 because delegation has no result artifact. The other six are in `browser-first/test/live-sdk-lane.test.mjs`: OpenCode session startup returns HTTP 500/500, leaving required sessions absent and/or `OPENCODE_SCAN_INPUT_MISSING: opencode-server.json`. These remain failures; their underlying cause is not established, so none is classified as a proven sandbox artifact.

Unmodified HEAD `00ba8494aa0c7502ad219f1500119bbbde2dcc91` was extracted with `git archive` into the temporary evidence directory’s `baseline/` subdirectory, using a dependency symlink. Running those two files there also reports 32 tests: 23 passed, the same 8 failed, 1 skipped. That initial baseline invocation selected Node 25.7.0; a matched Node 24.21.0 repeat produced the same counts and named failures, recorded in `baseline-head-node24-failing-files.log`. The log named `baseline-failing-files.log` was inadvertently produced in the working tree and is only a current-files repeat, not baseline evidence; the actual unchanged-HEAD evidence uses `baseline-head-` log names.

The two skips are also retained:

- `sandbox-exec confines delegation writes and secret reads on macOS`: confirmed sandbox limitation, `sandbox-exec: sandbox_apply: Operation not permitted` when attempting nested isolation.
- `live SDK lane detects injected extension-status-cards fault`: missing prerequisite, no launchable Chrome.

The confirmed sandbox-related command failures are the default Vitest/build Vite cache writes described above; neither reaches a failing test. The eight browser-first failures are reproduced on baseline but remain unresolved and block a clean full-suite claim.

No workflow, generated checkout bridge config, SDK capability vocabulary, slot/grant policy, or upstream protocol mapping was added beyond the approved plan. No commits or merge authority are claimed. EMBED-UPSTREAM-1 and live integration remain conductor-owned and pending.

## Explicit Node command

```bash
node --test --test-concurrency=1 browser-first/test/bridge-capability-token-consistency.test.mjs browser-first/test/bridge-route-capability-audit.test.mjs browser-first/test/bridge-server.test.mjs browser-first/test/embed-bar-actions.test.mjs browser-first/test/embed-bar-model.test.mjs browser-first/test/embed-bar.test.mjs browser-first/test/embed-descriptor.test.mjs browser-first/test/embed-first-share.test.mjs browser-first/test/embed-governance-acceptance.test.mjs browser-first/test/embed-governance-composition.test.mjs browser-first/test/embed-governance-contract.test.mjs browser-first/test/embed-governance-controller.test.mjs browser-first/test/embed-governance-host-service.test.mjs browser-first/test/embed-governance-privacy.test.mjs browser-first/test/embed-governance-storage.test.mjs browser-first/test/embed-governance-transport.test.mjs browser-first/test/embed-host-service.test.mjs browser-first/test/embed-interface-validation.test.mjs browser-first/test/embed-live-contract.test.mjs browser-first/test/main-workspace-settings.test.mjs browser-first/test/side-panel-entry.test.mjs browser-first/test/trace-redaction-packaging.test.mjs browser-first/test/trace-redaction.test.mjs scripts/module-ownership-doc.test.mjs
```

## Historical implementation changed files

The earlier implementation covered 50 changed/new files; the existing classic redactor copy is byte-identical and therefore has no diff.

- `browser-first/README.md`
- `browser-first/host/bridge-capability-tokens.mjs`
- `browser-first/host/bridge-server.mjs`
- `browser-first/host/embed-governance-host-service.mjs`
- `browser-first/host/embed-governance-storage.mjs`
- `browser-first/host/embed-host-service.mjs`
- `browser-first/host/run-bridge-minimal.mjs`
- `browser-first/resonantos-side-panel-extension/src/lib/bridge-client.js`
- `browser-first/resonantos-side-panel-extension/src/lib/embed-bar-actions.js`
- `browser-first/resonantos-side-panel-extension/src/lib/embed-bar-model.js`
- `browser-first/resonantos-side-panel-extension/src/lib/embed-bar.js`
- `browser-first/resonantos-side-panel-extension/src/lib/embed-governance-controller.js`
- `browser-first/resonantos-side-panel-extension/src/lib/embed-governance-dialog.js`
- `browser-first/resonantos-side-panel-extension/src/lib/generated/embed-governance-contract.js`
- `browser-first/resonantos-side-panel-extension/src/lib/generated/trace-redaction-core.js`
- `browser-first/resonantos-side-panel-extension/src/lib/generated/trace-redaction.js`
- `browser-first/resonantos-side-panel-extension/src/lib/settings/privacy-section.js`
- `browser-first/resonantos-side-panel-extension/src/side-panel-entry.js`
- `browser-first/resonantos-side-panel-extension/src/styles/main-workspace/settings.css`
- `browser-first/resonantos-side-panel-extension/src/styles/side-panel/base-layout.css`
- `browser-first/test/bridge-route-capability-audit.test.mjs`
- `browser-first/test/embed-bar-actions.test.mjs`
- `browser-first/test/embed-bar.test.mjs`
- `browser-first/test/embed-descriptor.test.mjs`
- `browser-first/test/embed-first-share.test.mjs`
- `browser-first/test/embed-governance-acceptance.test.mjs`
- `browser-first/test/embed-governance-composition.test.mjs`
- `browser-first/test/embed-governance-contract.test.mjs`
- `browser-first/test/embed-governance-controller.test.mjs`
- `browser-first/test/embed-governance-host-service.test.mjs`
- `browser-first/test/embed-governance-privacy.test.mjs`
- `browser-first/test/embed-governance-storage.test.mjs`
- `browser-first/test/embed-governance-transport.test.mjs`
- `browser-first/test/embed-host-service.test.mjs`
- `browser-first/test/embed-interface-validation.test.mjs`
- `browser-first/test/embed-live-contract.test.mjs`
- `browser-first/test/embed-live.mjs`
- `browser-first/test/side-panel-entry.test.mjs`
- `docs/architecture/MODULE-OWNERSHIP.md`
- `docs/planning/embed-governance-execution-notes.md`
- `packages/addon-sdk/src/contracts.ts`
- `packages/addon-sdk/src/index.ts`
- `packages/addon-sdk/src/validation.ts`
- `run-bridge-minimal.mjs`
- `scripts/prepare-embed-governance.mjs`
- `scripts/run-browser-first-extension-tests.mjs`
- `src/core/contracts.ts`
- `src/core/embed-governance-contract.js`
- `src/core/trace-redaction-core.js`
- `src/core/trace-redaction.js`
