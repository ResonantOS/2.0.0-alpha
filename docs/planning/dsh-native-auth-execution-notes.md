# DSH native authentication execution notes

Execution covers Tasks 1–12 in order on `feat/dsh-native-auth`. Task 0 is conductor-owned and was not repeated. Only deterministic Task 12 checks are authorized; live certification remains outstanding. No commits are made by the executor.

## Initial conditions

- Worktree initially clean on the requested branch.
- The referenced root `RTK.md` is absent; repository instructions and the plan remain applicable.
- No real DSH process, credentials, protected DSH home, desktop application, or port 19387 may be accessed. Tests use synthetic fixtures only.
- External fleet probing is omitted because credential and desktop inspection are prohibited. Task workers use the available internal agent interface sequentially.

## Task results and deviations

### Task 1 — native declaration and capability floor

- Initial TDD red: `node --test browser-first/test/dsh-native-policy.test.mjs` reported 11 tests, 0 passed, 11 failed. The first assertion showed that the native manifest was invalid before the scheme was added. The floor tests also failed before the policy change.
- Focused green: `node --test browser-first/test/dsh-native-policy.test.mjs browser-first/test/harness-manifest.test.mjs browser-first/test/harness-policy.test.mjs browser-first/test/harness-registry.test.mjs` reported 99 tests, 99 passed, 0 failed.
- The separate native example passed SDK manifest validation with five requested capabilities and no granted capabilities.
- Nine `rig-mutate` invocations each confirmed a passing baseline, a named behavioral assertion failure, and byte-identical source restoration: adapter pairing (1 failed test), endpoint guard (1), omitted native floor installation for filesystem and shell (1 each), slot denial for filesystem and shell (1 each), operation denial for filesystem and shell (1 each), and saved-load repair for both capabilities (2 failed tests). The saved-load tests asserted revision 3 and valid grants before checking disabled installation and vacated owner, excluding the registry catch/reset path.
- Deviation from the plan's literal test snippet: the durable store fixture uses a read/write helper so the saved document can be edited and written back before reload. The plan's direct `saved` mutation and this helper exercise the same durable load behavior. Added the isolated filesystem/shell slot and operation tests required by the plan's red-evidence prose, so an earlier missing-install assertion cannot mask those checks.
- No commit was made. No live DSH, credentials, protected DSH home, desktop app, or reserved probe port was accessed.

### Task 2 — native configuration, prefix, home, and announcement validation

- The initial behavior red used skeletal named exports, so all 19 planned tests failed assertions or behavioral access, without import or syntax errors. The supplied implementation then passed all 19.
- Two additional assertions isolate otherwise masked guards: a malformed `0.2.0-01` prerelease under a temporary exact-version allowance, and a truncated conflicting announcement after an initial complete token line. The exact-version allowance was used only during mutation proof and restored byte-for-byte. This is a minimal test correction to the plan's combined tests, which could pass when the semver or post-capture truncated-EOF guard was removed.
- Thirty-one `rig-mutate` probes produced named failing TAP assertions and byte-identical restoration. The conflict-comparison mutant was run separately against same-write and later-write tests. The continued-scanning mutant was run separately against the later-write conflict and post-token byte budget. The two initial inconclusive probes (a non-unique edit anchor and a truncated-EOF case masked by the missing-token guard) were corrected before counting evidence. The detailed probe list and TAP paths are in `/tmp/dsh-native-execution/task-2-report.md`.
- Focused checks: native runtime tests 21 passed; module ownership tests 2 passed. The broader docs and security checks also passed. The broader browser-first suite completed with 2311 passed, 0 failed, and 1 skipped for no launchable Chrome prerequisite. No commit or staging was performed.
- Scope remained `browser-first/host/dsh-runtime.mjs`, `browser-first/test/dsh-native-runtime.test.mjs`, this note, and `docs/architecture/MODULE-OWNERSHIP.md`. No real DSH, credential source, protected home, desktop app, or reserved probe port was accessed.

### Task 3 — owned child epochs and confirmed-stop clock

- Six planned lifecycle tests first failed on a behavioral `createDshRuntime` stub while the 21 Task 2 tests passed. The runtime now admits authorized leases to one owned child, fences epochs on failure, and applies a single 1s/2s/3s TERM/KILL/unconfirmed-exit clock.
- Two minimal plan corrections: the stop test asserts that an unconfirmed stop remains pending just before 3 seconds, making the return deadline observable; a new deadline test holds prefix validation indefinitely and requires acquisition to reject at the 30-second deadline. The supplied implementation left that waiter pending because its race listened only to caller abort, so acquisition now listens to the epoch abort as well. Both tests were run red before the final implementation.
- Eight `rig-mutate` probes produced named failing TAP assertions and confirmed byte-identical restoration: grouped authorization fence, final-lease gate, stale-epoch exit guard, unconfirmed lock retention, TERM clock, KILL clock, return clock, and deadline-waiter fence. TAP paths and exact results are in `/tmp/dsh-native-execution/task-3-report.md`. An initial TERM-clock mutation shortened the delay and survived because the fake timer jumped past it; a delayed TERM mutation corrected that inconclusive probe.
- Focused runtime check: 28 tests passed, 0 failed. Task 3 did not run broad gates, stage, commit, or launch real DSH. Synthetic child and filesystem fixtures only.
- Task 3 review correction: a spawned but unannounced child could hold the caller's deadline rejection until the 3-second stop clock finished, because the acquisition catch awaited final release. A synthetic fake-clock test reproduced the 30s-to-33s delay. Acquisition now starts the tracked stop without awaiting it; the caller receives `deadline-exceeded` at 30s, while TERM/KILL and the unconfirmed-home lock still complete on the original stop clock. The corrected focused suite passed 29/29. A ninth `rig-mutate` probe restored the blocking await and failed the named 30-second assertion with byte-identical restoration; see the report.

### Task 4 — shared epoch credentials and retained redaction

- Initial TDD red: the new native credential suite reported 1 pass and 5 failures. Each failure was the expected `runtime-unavailable` from the legacy source reader rejecting `{ managedDsh: true }`; the exact public binding denial test passed before implementation.
- Native leases now share one epoch credential record, cookie generation, and in-flight exchange. They keep individual caller access and runtime references. Disposal or caller cancellation cannot clear a cookie needed by another live lease. Redaction registrations survive disposal for late output.
- The default refresh map bakes the reviewed Task 0 result directly: `0.1.5-rc.1: false`, `0.1.7-rc.2: false`, and `0.2.0-rc.2: true`. Deviation from the plan's script: the worker did not read external `results.json` or credentials, per the execution constraint. The already reviewed, sanitized Task 0 outcome in the plan was used as authority. No installed DSH package was inspected or certified here.
- The focused native and legacy credential suites passed 9/9 before mutation. Fifteen `rig-mutate` probes each caused a named behavioral TAP assertion failure and verified byte-identical source restoration: the five exact public binding fields, disposed access, single-flight exchange, stale generation, disabled refresh, epoch loss, and the five independent redaction registrations. Details and TAP paths are in `/tmp/dsh-native-execution/task-4-report.md`.
- Only synthetic runtime stubs, randomly generated canaries, and local focused tests were used. No real DSH, credential source, protected home, desktop app, or reserved probe port was accessed. No commit or staging was performed.
- Task 4 review correction: a disposed credential lease retained `ready()` and `fail()` authority while another runtime client remained live. A two-lease regression first failed with the missing `ready()` exception. Both methods now check caller lease authority before delegation. The focused suites passed 10/10; two additional `rig-mutate` probes independently removed each check and failed the named assertion, with byte-identical source restoration. The shared readiness lease still has its intended epoch-scoped authority.

### Task 5 — direct DSH connections and native cookie transport

- Initial TDD red: `node --test browser-first/test/dsh-native-transport.test.mjs` reported 16 failures at the native-scheme permission gate. The supplied implementation then passed the focused suite.
- One minimal source correction followed an explicit red test. A trusted socket event with an observed handshake 401 now refreshes once without a read-only diagnostic; a second 401 fences the epoch. The handshake path separates observed 401 from opaque failures so the diagnostic remains limited to the latter. A later review corrected my misreading of the global contract: `Location` is optional on the 303 exchange. A positive no-Location regression first failed under my stricter condition, then passed after restoring the supplied optional-Location expression. A supplied foreign Location remains denied.
- The supplied fixture gained valid oversized JSON cases for request, response, outbound socket, and inbound socket bounds; those distinguish each byte limit from parse failures. It also tests absent Location acceptance, observed handshake 401, and a repeated handshake 401. These additions serve the plan's stated red-evidence and handshake contract.
- The requested `npm install --package-lock-only --ignore-scripts --save-exact undici@7.30.0` was first attempted at the worktree root with empty isolated npm user/global configuration and a temporary cache. It failed `EPERM` while trying to unlink `.package-lock.json` through the preexisting read-only shared `node_modules` symlink. To preserve that symlink, the same command ran in a temporary directory containing copies of `package.json` and the original lockfile, then only the generated lockfile was copied back. The first temporary `--prefix` attempt had produced temp-relative lock keys; it was discarded. The final lockfile diff contains only the root dependency addition and the already present Undici 7.30.0 entry's promotion from dev to runtime. Installed Undici metadata reports 7.30.0.
- Focused check: 102 tests passed, 0 failed across the native transport, legacy transport, endpoint, adapter, and stream suites. Twenty `rig-mutate` probes produced named failing TAP assertions and byte-identical source restoration: cookie grammar, size, expiry, cardinality; exchange status and foreign location; native route and socket-header isolation; 401-only replay and second-401 fence; request, response, outbound, and inbound byte bounds; opaque and denial opening guards; direct HTTP and WebSocket dispatchers; and observed handshake 401 refresh. The first opaque-guard probe was inconclusive because an observed-status condition still masked it; the guard structure and mutation were corrected. The vacuous `!location` deletion probe from the discarded stricter implementation is not counted. TAP paths and exact assertions are recorded in `/tmp/dsh-native-execution/task-5-report.md`.
- Synthetic HTTP/WebSocket fixtures and randomly chosen loopback ports were used. No real DSH, actual credential source, protected home, desktop app, or port 19387 was accessed. No commit or staging was performed. Broader tests belong to Task 12.

### Task 6 — native protocol readiness

- Initial TDD red: `node --test browser-first/test/dsh-native-readiness.test.mjs` reported 3 expected behavioral failures and 1 pass. Native probe omitted `protocolReady` and accepted malformed catalogs; the existing RPC error-envelope guard passed before implementation.
- The existing bounded model catalog decoder was moved unchanged to `decodeDshCatalog` and reused by native probe. A valid empty catalog means protocol readiness with `providerAvailable: false`; a catalog containing a model means provider availability. Plugin probe retains its previous return and validation behavior.
- Minimal plan correction: the error-envelope loop was split into a separate named valid-catalog case. Otherwise the undefined-value case could fail first and mask the proof that an `ok: false` envelope carrying a valid catalog never reaches Ready.
- Focused checks: `node --test browser-first/test/dsh-native-readiness.test.mjs browser-first/test/dsh-harness-adapter.test.mjs browser-first/test/dsh-harness-stream.test.mjs` passed 64/64 before the test split; the readiness suite passed 5/5 after the split. Two `rig-mutate` probes independently failed the named malformed-catalog and valid-catalog error-envelope assertions, and each restored the adapter byte-for-byte. TAP records: `/tmp/dsh-native-execution/task-6-mutant-catalog.tap` and `/tmp/dsh-native-execution/task-6-mutant-envelope.tap`.
- No real DSH, credential source, protected home, desktop app, or reserved probe port was accessed. No staging or commit. Broader gates belong to Task 12.
- Final focused rerun after the test split and both restored mutations passed 65/65, 0 failed.

### Task 7 — boundary authorization cancellation and runtime retirement

- Initial behavioral red: `node --test browser-first/test/dsh-native-boundary.test.mjs` reported 6 tests, 1 pass and 5 expected failures. The passing post-create revocation case covered an existing guard; missing adapter-resolution options, runtime binding, and retirement APIs caused the failures. An initial test syntax typo was corrected before this red run and was not counted as evidence.
- The boundary now passes an abort signal and guarded runtime binder to adapter resolution, rechecks authorization before dispatch and after creation, and retires a matching runtime epoch synchronously. Retirement emits the terminal bus error before closing readers, invalidates the reference, calls `onRetired` once for registered sessions, and suppresses late output. `isLive` checks current `createSession` permission.
- Minimal plan correction: `retireRuntime(undefined)` previously matched an unbound session because both epoch values were undefined. A named regression failed first, then the epoch filter required a nonempty string. This prevents an absent epoch from retiring unrelated sessions without changing the public reference shape.
- Focused final check: `node --test browser-first/test/dsh-native-boundary.test.mjs browser-first/test/harness-boundary.test.mjs browser-first/test/harness-event-bus.test.mjs` passed 52/52, 0 failed.
- Six `rig-mutate` probes caused named behavioral TAP assertions to fail and restored source bytes exactly: missing resolution signal, grouped post-resolution dispatch fence, grouped post-create fence, epoch filter (both replacement and absent-epoch assertions), synchronous callback, and `isLive` operation check. Logs are `/tmp/dsh-native-execution/task-7-mutant-{signal,dispatch,post-create,epoch,callback,is-live}.tap`.
- No staging or commit. No real DSH process, credential source, protected home, desktop app, or reserved probe port was accessed. Broader checks belong to Task 12.

### Task 8 — shared readiness, assembled sanitation and chat cache retirement

- Initial behavioral red: `node --test browser-first/test/dsh-native-host.test.mjs` ran 6 tests with 5 expected failures and 1 existing cold-clock pass. Native deltas were published; native runtime failure had no host callback; the exact-reference retirement callback and pre-cache liveness guard were absent. The fixture's missing `onFailure` was a consequence of the uncomposed native runtime, not a syntax/import failure.
- Composition snapshots only an approved native binding, injects the trusted runtime factory into credential custody, binds session epochs, and shares one authenticated protocol-readiness promise per epoch through a host-only readiness lease. The lease has no independent process reference. Native output passes assembled method/final sanitation before route, event, and receipt publication; native deltas are suppressed. Retirement clears only the matching four-field chat cache reference, in-flight chats retain a local reference for provenance and timeout cancellation, and close awaits native stop plus bounded resource drain. The ownership map records these boundaries.
- The literal plan's cache-race fixture could retire after cache assignment, so its pre-cache mutant survived. A deterministic test wrapper now returns an already retired reference at the exact handoff; removing the liveness guard makes the next explicit chat fail. The four assembled method assertions were split into named tests so each wrapper has an independent mutation proof. The shared-readiness test disposes the first waiting transport while authentication is held, makes that waiter fail at session creation, and verifies the second reaches Ready; this synthetic seam tests lease independence without launching a child.
- Focused check: `node --test browser-first/test/dsh-native-host.test.mjs browser-first/test/dsh-native-credentials.test.mjs browser-first/test/harness-host-service.test.mjs browser-first/test/harness-provider-dispatch.test.mjs` passed 65/65 before the final test-fixture refinement. The final restored-source rerun is recorded in the Task 8 report.
- Fifteen `rig-mutate` probes each yielded one named behavioral TAP failure and byte-identical source restoration: native delta suppression; final sanitation; history, status, selectModel and modelCatalog sanitation; each of four cache reference fields; unconditional cache clearing; pre-cache liveness; local timeout reference; shared readiness transport lease; and native close drain. TAP files are `/tmp/dsh-native-execution/task-8-mutant-*.tap`. Initial inconclusive probes from a nonunique cache edit anchor and the original cache-race timing are excluded from this count.
- No staging or commit was performed under the task's explicit execution constraint. No real DSH, credential source, protected home, desktop app, or port 19387 was accessed. Broader gates belong to Task 12.

### Task 9 — bridge-owned asynchronous signal shutdown

- Initial behavioral red: `node --test browser-first/test/dsh-native-shutdown.test.mjs` reported 5 tests, 2 passed and 3 failed. Temporary export shells let the test reach named assertions: native stop had not started on signal (`0 !== 1`), repeated shutdown calls returned different promises, and OpenCode retained a signal listener when opted out (`1 !== 0`). The shells were replaced by the implementation.
- The new bridge shutdown owner invokes native stop synchronously, starts OpenCode disposal and preference/subscription cleanup, waits for all four to settle, then closes the server. Repeated shutdown calls share a promise; repeated signals attach only one exit continuation. The bridge disables OpenCode's asynchronous signal handlers, while OpenCode keeps its synchronous process-exit child cleanup hook. The ownership map records the new boundary.
- Focused green: `node --test browser-first/test/dsh-native-shutdown.test.mjs browser-first/test/opencode-client.test.mjs browser-first/test/opencode-execution-revocation.test.mjs` passed 69/69 before mutation.
- Four `rig-mutate` probes each produced a named failing assertion and byte-identical restoration: delayed native stop (immediate call count), removed shutdown idempotence (promise identity and duplicate native call), repeated signal exit (two exits), and missing OpenCode exit hook in false mode. TAP records are `/tmp/dsh-native-execution/task-9-mutant-{native-delay,idempotence,repeat-exit,exit-hook}.tap`.
- No deviation from the Task 9 runtime design was needed. No staging, commit, real DSH, real OpenCode process, actual credential source, protected home, desktop app, or port 19387 was used. Broader gates belong to Task 12.

### Task 10 — isolated executable composition

- The integration suite first ran with an inert synthetic child and failed 10 named behavioral cases at session or chat assertions; the foreign-listener and conflicting-announcement cases passed under that skeleton and were not counted as security evidence. The complete Node-only child then exercised the real prefix walker, process launch, cookie exchange, RPC and follow stream, route authority, revocation, crash recovery, persistence, and signed receipt sanitation. No real DSH or provider connection was used.
- Fixture deviation: the plan's home-based temporary root was outside this runner's writable sandbox. The fixture selects the canonical process temporary root only when its entire ancestor chain has safe ownership and no group or world write bits and the base is writable. Otherwise it tries the canonical user home with the same checks; if neither qualifies it fails explicitly. A synthetic unsafe shared-temp/safe-home case failed before this selector was implemented and passed afterward. This allows standard Linux shared temporary directories without relaxing or skipping the production prefix and home validators. The fixture also places governance state under its private root, instead of using the host service's default external state directory. It creates and restricts its own user directory, which keeps the `umask 002` run isolated.
- An intermittent active-crash replacement failure exposed a production stop reentrancy race. The original immediate explicit replacement assertion was retained. The owning runtime task added a deterministic regression and fixed promise publication before synchronous fencing; this integration suite then passed with no wait on home-lock removal.
- Seven final `rig-mutate` probes failed their named behavioral assertions and verified byte-identical source restoration: forced telemetry (session startup), fresh per-lease cookie record (second session), stop on the first lease release (remaining session history), removed port reservation (foreign-listener child count), removed retirement cache clearing (explicit post-crash chat), unconditional announcement EOF rejection (valid EOF readiness), and persistent post-capture announcement suppression (conflict during delayed catalog probe). The exact integration command passed again after each restored mutation. Earlier inconclusive probes and a prematurely interrupted restore attempt are excluded; the interrupted host file was independently reconstructed from its prior diff and matched byte-for-byte.
- Focused normal and `umask 002` commands each passed 13/13 after the portability correction. No staging or commit was performed. No actual credential source, protected home, desktop app, generated bridge config, real DSH process, or port 19387 was used. Broader certification belongs to Task 12.
- Task 10 integration exposed a Task 3 stop reentrancy race after child exit. A deterministic runtime test used synchronous `onFailure -> lease.fail()` reentry and held the first synthetic home release; the pre-fix code called home release twice and could let a fresh acquisition begin while the old lock still existed. `stop()` now publishes and tracks its promise before fencing, so reentry shares the same job. Focused runtime tests passed 30/30. A `rig-mutate` probe moved publication back after fencing; the named reentrancy assertion failed with two release calls and byte-identical restoration. This is a minimal correction to the Task 3 owner, with no integration-test edits.

### Task 11 — native operator documentation

- Initial documentation red: `node --test browser-first/test/dsh-native-docs.test.mjs` reported 1 failed test. Its first assertion named the missing `## Native DSH authentication` heading, as planned.
- The guide now describes the dedicated install prefix and home, exact native binding, consent, child and credential isolation, fixed bounds, recovery, plugin coexistence, and the separate production live lane. The host README links to that section. The prose records only `0.2.0-rc.2` as native-eligible; `0.1.5-rc.1` and `0.1.7-rc.2` remain blocked by the Task 0 `anchor-missing` observation. Production live certification was not performed.
- Focused green: `node --test browser-first/test/dsh-native-docs.test.mjs` passed 1/1. `npm run docs:check` passed and `npm run test:docs` passed 293/293 before this note was appended. Final documentation checks are rerun after the note.
- No implementation deviation from the planned Task 11 text or test. The plan's commit step is intentionally omitted under this execution's no-stage/no-commit constraint. No live examples, real DSH, credential source, protected home, desktop app, generated bridge configuration, or port 19387 were accessed.

### Final review correction — native cleanup cancellation and replacement WebSocket scope

- The final deterministic review found two important lifecycle gaps. Before source changes, focused regressions for active-session retirement and refreshed WebSocket 503, constructor failure, and caller cancellation produced four named behavioral failures. The constructor test initially expected only one socket even though the failed constructor was the second attempt; that assertion was corrected, and all four final red cases were rerun before implementation. Review probes used only injected in-memory child and transport doubles; no production DSH was accessed.
- A retired native session now has a one-second, cleanup-only path to send its fixed owned `session/cancel` RPC. Its transport binds the adapter-created session ID once, reads the current cookie from shared epoch custody for that one fixed request, and sends no plugin token, arbitrary headers, refresh, retry, prompt replay, follow opening, or published output. The ordinary lease remains fenced immediately. A per-session cleanup deadline expires even while another lease keeps the epoch live; on epoch stop, the shared usable cookie expires after the same cleanup phase while redaction registrations remain. The adapter starts this path synchronously from its first abort-triggered cancellation so an earlier ordinary-transport rejection cannot be cached. Transport disposal awaits the bounded cleanup while releasing its runtime lease concurrently, preserving the original stop clock.
- Replacement WebSocket opening failures now fence the shared epoch only for a confirmed second 401. Observed 503, constructor failure, and caller cancellation fail only that opening. An opaque replacement failure uses one bounded, read-only, non-refreshing diagnostic to establish whether it was a 401; no third socket or prompt replay occurs. The replacement error is retained if the epoch-failure callback itself throws.
- Two new synthetic composition cases cover single-session retirement while a second remains usable and whole-host close before child stop. Additional transport tests cover exact owned ID, fixed headers/route, one-second timeout, one request, replacement 503/constructor/caller cancellation, and opaque 401/503 diagnosis. A credential test covers immediate normal-access revocation, one-second per-lease and epoch cleanup expiry, unaffected second lease, and retained redaction. A preexisting Task 8 synthetic host fixture gained a no-op `bindSession` hook because production composition now binds the adapter-created ID; no production check was weakened.
- Final focused run: `node --test --test-reporter=tap browser-first/test/dsh-native-final-fixes.test.mjs browser-first/test/dsh-native-transport.test.mjs browser-first/test/dsh-native-credentials.test.mjs browser-first/test/dsh-native-host.test.mjs browser-first/test/dsh-harness-adapter.test.mjs` passed 83/83, 0 failed, 0 skipped. `git diff --check` passed. Eleven `rig-mutate` probes yielded named behavioral TAP failures and byte-identical restoration: per-lease expiry, epoch expiry, fixed session ID, one-second bound, shared cookie use, fixed cancel route, adapter cleanup dispatch, host session binding, non-auth replacement scope, observed second 401, and opaque second 401. TAP paths and exact evidence are in `/tmp/dsh-native-execution/final-fix-report.md`. A 30-second command wrapper interrupted the first batch during the replacement-scope probe; that probe was rerun alone, and its red assertion plus byte restoration were confirmed. It is counted once.
- This correction expanded the touched source from the review's location hints to the adapter and host binding seam because the first abort-triggered RPC had to use the cleanup path and the transport had to know the fixed owned session ID. The ownership map was updated accordingly. No staging, commit, full browser-first command, live DSH, actual credential source, protected home, desktop app, generated bridge configuration, or port 19387 was used. Broader deterministic gates remain parent-owned.

### Task 12 — deterministic gates and execution limits

- All task commit steps are intentionally omitted. The conductor owns commits and any PR. No external certification file was created or read. The plan’s final accounting assertion combines deterministic status with conductor-owned live observations; it was not run or fabricated under the deterministic-only instruction. Native live certification remains 0 certified / 3 uncertified: both 0.1.x rows remain blocked by the recorded observer result, and the sole eligible 0.2.0-rc.2 awaits live certification.
- The exact aggregate `npm run test:browser-first` contains existing tests that launch live OpenCode SDK fault lanes. This was discovered during the final run, which was interrupted (exit 130). The earlier Task 2 aggregate had completed before this behavior was recognized. That earlier run also included the existing test that fingerprints and restores the checkout generated bridge configuration; this indirect access conflicts with the requested boundary. No deliberate generated-config edit was made, and no real DSH was launched or certified. The deterministic rerun explicitly excludes the nine live-lane invocations and that generated-config test, without modifying or weakening the repository test runner.
- Exclusion expression: `^(live SDK lane detects injected .* fault|raw-log fault fails at credential scan|run-bridge-minimal honors RESONANTOS_EXTENSION_ROOT without writing checkout bridge config)$`. It matches eight injected-fault cases, one raw-log live case, and one generated-config case. All remaining browser-first tests, including plugin transport and OpenCode unit suites, are retained.
- Before interruption, the exact aggregate reported `live SDK lane detects injected opencode-version-pin fault` (unrelated session-start HTTP 500, missing registered sessions and scan input) and `live SDK lane detects injected opencode-proxy-capability fault` (observed missing-session detail instead of the expected capability fault). These are unresolved live-lane failures, not dismissed as sandbox artifacts, and were not rerun. Interrupted later files do not constitute completed test evidence.
- The exact `npm test -- --run` and `npm run build` both exited 1 because Vite tried to write its generated config bundle through the preexisting read-only shared `node_modules` symlink into `.vite-temp` and received `EPERM`. This is a sandbox filesystem limitation at configuration startup, with no failing test name. TypeScript completed before the build’s Vite failure. The supported `--configLoader runner` option avoids that write: Vitest passed 724 tests in 48 files, and the build passed (with its existing large-chunk warning). No dependency symlink or repository config was changed to bypass the sandbox.
- `npm run verify:alpha` exited 1 at the same build configuration `EPERM`, after repository hygiene, documentation check, and 293 documentation tests passed. Full Alpha certification is not claimed.

- Two deterministic cases fail under the managed sandbox and remain reported failures: `Hermes CLI execution bridge routes prompts through the safe local runtime adapter` and `OpenCode CLI execution bridge routes pass in-process deterministic smoke test`. Both use fake CLIs but require nested macOS `sandbox-exec`; a harmless `/usr/bin/true` probe through that sandbox exits 71 with `sandbox_apply: Operation not permitted`. Focused reruns reproduce both missing-result-artifact assertions. Their test, delegation, and isolation source files are unchanged by this implementation. No assertions or isolation policy were weakened. The earlier Task 2 passing run’s sandbox context was not recorded, so its difference is not explained away.

Final independent review approved both lifecycle corrections. Original synthetic probes now observe one upstream cancellation for whole-host close and individual retirement, and zero epoch failures for a refreshed replacement WebSocket 503. No live result is implied.

| Final deterministic check | Result |
| --- | --- |
| `node --test browser-first/test/dsh-native-*.test.mjs` (all 11 touched test files) | 120 passed, 0 failed, 0 skipped |
| `node --test --test-concurrency=1 --test-skip-pattern='<expression above>' browser-first/test/*.test.mjs` | 2390 reported: 2387 passed, 2 failed, 1 skipped; 10 prohibited cases excluded from enumeration |
| `npm run docs:check` | Passed; rerun after final notes |
| `npm run test:docs` | 293 passed, 0 failed; rerun after final notes |
| `npm run repo:hygiene` | Passed; rerun after final notes |
| `node scripts/security-pipeline/run-check.mjs` | 7 checks passed after final source fixes |
| `node --test --test-concurrency=1 scripts/module-ownership-doc.test.mjs` | 2 passed, 0 failed after final ownership update |
| `npm test -- --run` | Exit 1: sandbox config-bundle write failure before tests |
| `npm test -- --run --configLoader runner` | 724 passed in 48 files |
| `npm run build` | Exit 1: sandbox config-bundle write failure after TypeScript |
| `npm run build -- --configLoader runner` | Passed |
| `npm run verify:alpha` | Exit 1 at the same build sandbox failure |
| `git diff --check` | Passed |

The broad deterministic suite’s existing skipped case is `sandbox-exec confines delegation writes and secret reads on macOS`, which reports unavailable nested sandbox execution. The two failed CLI cases are named above and remain failures. No tests were weakened. The native suites and mutation probes use synthetic children and generated test canaries; they are not production certification.

## Changed files

All changes remain unstaged and uncommitted on `feat/dsh-native-auth`. The inventory below includes added files. No workflow or generated bridge configuration is included in the implementation diff.

33 files:

- `browser-first/host/README.md`
- `browser-first/host/agent-adapters/dsh-typert.mjs`
- `browser-first/host/agent-runtime-endpoint.mjs`
- `browser-first/host/bridge-shutdown.mjs`
- `browser-first/host/dsh-runtime.mjs`
- `browser-first/host/harness-boundary.mjs`
- `browser-first/host/harness-credentials.mjs`
- `browser-first/host/harness-examples/deepseek-harness-native.json`
- `browser-first/host/harness-host-service.mjs`
- `browser-first/host/harness-policy.mjs`
- `browser-first/host/harness-transport.mjs`
- `browser-first/host/opencode-client.mjs`
- `browser-first/host/run-bridge-minimal.mjs`
- `browser-first/test/dsh-native-boundary.test.mjs`
- `browser-first/test/dsh-native-credentials.test.mjs`
- `browser-first/test/dsh-native-docs.test.mjs`
- `browser-first/test/dsh-native-fake-child.mjs`
- `browser-first/test/dsh-native-final-fixes.test.mjs`
- `browser-first/test/dsh-native-host.test.mjs`
- `browser-first/test/dsh-native-integration.test.mjs`
- `browser-first/test/dsh-native-policy.test.mjs`
- `browser-first/test/dsh-native-readiness.test.mjs`
- `browser-first/test/dsh-native-runtime.test.mjs`
- `browser-first/test/dsh-native-shutdown.test.mjs`
- `browser-first/test/dsh-native-transport.test.mjs`
- `docs/addons/harness-adapter-demo.md`
- `docs/architecture/MODULE-OWNERSHIP.md`
- `docs/planning/dsh-native-auth-execution-notes.md`
- `docs/planning/dsh-native-auth-plan.md`
- `package-lock.json`
- `package.json`
- `packages/addon-sdk/src/validation.ts`
- `src/core/contracts.ts`

Brief N telemetry correction: Layer 1 found that telemetry injects only sessions and OTel, so feedback requires explicit Cordis injection. Layer 2 found that assistant messages require an append surface marker. Layer 3 found that sessions.create does not bind a persistence writer. Layer 4 found that v4 messages require source.kind. Layer 5 found that v4 also enforces the full request/header, protected system head, turn/step, and tool-resolution grammar. The certification driver now rates real replies to synthetic prompts, committing a rating and then a versioned comment through the canonical feedback service in the managed DISABLED lane and descriptor-validated HTTP in the FEEDBACK_ONLY control. The control is now keyed from the conductor's DEEPSEEK_API_KEY environment variable, included in the in-memory persistence scan, with provider-and-local-sink-only egress; public collectors and all other destinations remain blocked and counted. Live execution remains conductor-only and was not run for this correction.

Brief S (2026-10-17) adds the conductor-only `browser-first/test/dsh-native-browser.live.mjs` and its deterministic contract tests; neither live lane was run while authoring. It requires absolute `DSH_LIVE_PREFIX`, `DSH_LIVE_PLUGIN_PREFIX`, `DSH_LIVE_PLUGIN_TARBALL`, `DSH_LIVE_CHROME_EXECUTABLE` (Chrome for Testing), `DSH_LIVE_BROWSER_OUT` (an existing external directory), and `DSH_LIVE_FINAL_GATE`, plus `DEEPSEEK_API_KEY` supplied only through the environment. Scratch state and the extension copy stay outside both checkouts; the approved input prefixes and verified tarball remain read-only. Evidence uses fixed reasons and screenshot SHA-256 digests, and canonical core-driver gate input is patched only for the two observations, their reasons, and the screenshot attestation; status, blockedReasons and deterministic evidence remain conductor-owned, and the core driver must not run concurrently. Source inspection found that harness management and attributed harness chat currently exist only in the React shell: the MV3 extension has neither surface. The companion therefore fails closed with `harness-ui-unavailable` at that prerequisite, without substituting React, bypassing consent, or claiming screenshots; the remaining UI steps require renewed conductor validation when extension integration exists. Digest and gate-key guard mutations use `rig-mutate` with byte-identical restoration; deterministic success is not live certification.


Brief T (2026-10-17) supersedes Brief S's unavailable-extension path. Tom chose
"React harness-demo shell over the production bridge; not the Chrome extension"
for `browserVisible` and `pluginCoexistence`, because the extension has no
harness management UI or attributed harness chat. Extension-surface proof is
future work. The companion composes the production host and bridge with a
persistent external registry as the swap demo does, reuses its exported
`createBridgeClient`, and serves the React shell in `harness-demo` mode on an
unused loopback port. It selects **Choose Add-ons Manually**, installs and grants
explicitly through authenticated host transactions, assigns both primary and
chat-interface owners, and matches browser-composer text and add-on identity
to signed dispatch/final receipts. No swap-demo behavior or runtime owner was
changed. The plugin prefix remains read-only; the digest-pinned tarball,
`--ignore-scripts`, scratch HOME/DSH_HOME, protected-port refusals and sanitized
summary remain. The gate now additionally records `surface` while preserving
all unrelated fields. Cleanup uses captured child handles without process-group
escalation; each swap checks the plugin PID/API before and after the reply and
checks the bridge's owned-signal audit. No live lanes were run and no commit was
made for this brief.

Brief T deterministic verification (2026-10-17):

| Command | Result |
| --- | --- |
| `node --check browser-first/test/dsh-native-browser.live.mjs` | Exit 0 |
| `node --test browser-first/test/dsh-native-*.test.mjs` | 132 passed, 0 failed, 0 skipped |
| `node --test browser-first/test/harness-swap-demo.test.mjs` | 60 passed, 0 failed, 0 skipped; source unchanged |
| `npm run docs:check` | Passed |
| `npm run test:docs` | 293 passed, 0 failed, 0 skipped |
| `git diff --check` | Passed |
| `node scripts/security-pipeline/run-check.mjs` | 7 checks passed |

Three `rig-mutate` probes each produced one named failing assertion and
byte-identical restoration: omitted gate surface, removed input-key restriction,
and an unauthorized change to the unrelated `reply` field. TAP evidence is in
`/tmp/dsh-brief-t/mutant-{surface,allowed-keys,unrelated-fields}.tap`. Initial
contracts also failed for the missing surface and obsolete extension path.
The signed-reply contract rejects tampered signatures, mismatched text, wrong
session/epoch/generation/turn and an owner ID with an extra suffix (important
because the native ID starts with the plugin ID). A separate bootstrap contract
checks every capability currently requested by React's transport. These checks
use synthetic receipts and fixtures, never live DSH or browser lanes.

**Conductor live completion, 2026-10-17.** The conductor ran `dsh-native-browser.live.mjs` live, in the React harness-demo shell over the production bridge, as Tom decided on 2026-10-17. Both lanes passed. Combined with the core driver's 11 observations, 0.2.0-rc.2 now has 13/13 live observations, labelled conductor-verified with screenshots pending owner review. The live runs exposed four driver defects, not product defects, all fixed:

1. The external gate must live outside every repository. The launcher now uses an external gate folder.
2. DSH 0.1.5-rc.1 resolves its own host `dsh-tools` at 0.1.5-rc.3, because its packages peer on `^0.1.5-rc.3`. The driver had asserted the DSH version.
3. `dsh-augmentor@0.2.11` `/api/augmentor/auth` returns the login token as JSON `{token}` and sets no cookie.
4. The screenshot privacy guard now also admits the shell's static seed greeting, but only as an exact string literal from `src/core/defaults.ts`.

The deterministic Task 12 checks and the final review gate remain.
