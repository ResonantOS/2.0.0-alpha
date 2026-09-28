# Augmentor Future List — acceptance matrix

This maintained mapping relates the **Augmentor Future List** capability families
to canonical issues, bounded implementation evidence, outstanding acceptance
proof, and safety boundaries (issue #217). Project 2 remains the release-planning
authority; this matrix does not certify the complete Future List.

The FL column uses the supplied 44-item numbering, transcribed in the appendix
below so the associations are reviewable in the repository. Associations identify
related capabilities; they do not accept incompatible promises such as autonomous
sending, checkout, reservation, sensitive typing, or public submission.

## How to read the status column

| Status | Meaning |
|---|---|
| ✅ **supported** | Inspected implementation and tests support the bounded claim in this row. |
| ◐ **partial foundation** | A related implementation exists, but broader Future List acceptance remains unproved or open. |
| 🔧 **needs hardening** | Coverage, UX, edge cases, or live-browser acceptance remain outstanding, even if the issue is closed. |
| 🔒 **safety-constrained** | A human-only or consent boundary limits the capability. Consent cannot override human-only actions. |
| ⏸ **deferred** | The issue is labeled scope:deferred; this does not establish whether work has started. |
| 🔮 **future** | Planned acceptance work remains open; no claim about work-start status. |

Issue **CLOSED**, **OPEN**, and PR **MERGED** are metadata observations, separate
from implementation status and outstanding acceptance proof. They do not imply
Project 2 Done or live-browser certification. **Required** marks prospective
proof, not a supplied test result. Issue/PR metadata was checked directly for this
revision; safety-boundary rows are never casual good-first-issues.

## Matrix

### Core interface

| Capability | FL | Canonical issue(s) | Status | Tests / proof | Safety boundary |
|---|---|---|---|---|---|
| Side panel + Alt+A / Alt+S shortcuts | FL-01, FL-03 | #241 CLOSED · PR #305 MERGED | ✅ supported shortcut foundation | `browser-first/test/augmentor-shortcut-controller.test.mjs` lines 54–165: shortcut classification and conflict handling. This is not full-context proof for every page. | — |
| Augmentor mode selector + permission-state | FL-39 | #230 CLOSED | 🔧 needs hardening | `browser-first/test/mode-status-section.test.mjs` lines 67–120: mode descriptions. **Required:** live-browser proof; #230 retains its community-test label. | descriptions preserve current permissions and human-only limits |

### Web understanding

| Capability | FL | Canonical issue(s) | Status | Tests / proof | Safety boundary |
|---|---|---|---|---|---|
| Page content analysis / Q&A | FL-04, FL-06 | #218 CLOSED · #8 CLOSED | ◐ partial readable-page extraction foundation | `browser-first/test/browser-page-actions.test.mjs` lines 795–845: readable-page fixtures. PDF-like HTML and absent media text do not establish universal PDF/media understanding. | readable content only within permitted context |
| Highlight-to-ask (inline assistant) | FL-07 | #9 CLOSED | ◐ partial foundation; successful browser interaction proof outstanding | `browser-first/resonantos-side-panel-extension/src/lib/content-inline-actions.js` line 4 defines Ask/custom; `browser-first/resonantos-side-panel-extension/src/content.js` lines 1288–1328 constructs selection/prompt requests and listens for selection. `browser-first/test/background-message-policy.test.mjs` lines 15–29 tests payload sanitization; `browser-first/test/local-provider-chat.test.mjs` lines 137–156 tests inline host routing; `browser-first/test/content-inline-action-gate-enforcement.test.mjs` lines 117–134 tests denial. **Required:** successful highlight→custom Ask live-browser proof. | selection and page restrictions apply; routing or denial tests do not prove successful Ask interaction |
| Counterpoints / explain-jargon | FL-08, FL-37 | #219 CLOSED | ✅ supported bounded actions | `browser-first/resonantos-side-panel-extension/src/lib/content-inline-actions.js` lines 7–8 defines actions; `browser-first/resonantos-side-panel-extension/src/lib/content-inline-action-surface-gate.js` and `browser-first/test/content-inline-action-surface-gate.test.mjs` lines 26–66 cover HTTP(S), restricted schemes, and empty URLs. `browser-first/test/content-redaction.test.mjs` lines 173–217 covers local fallbacks. `browser-first/resonantos-side-panel-extension/src/content.js` lines 1222–1234 applies the location gate. | read-only selected-text actions; location gating does not prove saved-site permission enforcement |
| Image / media understanding | FL-05 | #242 OPEN | ⏸ deferred · 🔒 | **Required:** bounded media handling and live-browser proof. `browser-first/test/browser-page-actions.test.mjs` lines 703–729 and 841–845 proves absent readable text handling, not media interpretation. | privacy/security-sensitive |

### Cross-tab intelligence

| Capability | FL | Canonical issue(s) | Status | Tests / proof | Safety boundary |
|---|---|---|---|---|---|
| Cross-tab comparison (model-chosen) | FL-09 | #220 CLOSED · #118 OPEN | ◐ partial foundation · 🔧 needs hardening | `browser-first/test/tab-context-controller.test.mjs` lines 158–176 asserts provenance. `browser-first/resonantos-side-panel-extension/src/lib/side-panel-command-router.js` lines 31–35 routes comparison before quoted-tab capture; `browser-first/resonantos-side-panel-extension/src/lib/tab-context-controller.js` lines 171–218 posts multi-tab provenance without capturing page contents. **Required:** grounded comparison capture and acceptance proof. | provenance alone does not establish captured-content comparison |
| Explicit `@tab` referencing | FL-12 | #252 CLOSED | ◐ partial quoted-reference capture/typeahead foundation | `browser-first/test/tab-context-controller.test.mjs` lines 206–227 tests quoted-reference capture; `browser-first/test/tab-mention-typeahead.test.mjs` lines 36–53 and 78–93 tests typeahead. Comparison prompts still encounter the capture gap above. | only readable permitted tabs; no broader comparison certification |
| Session-level memory / restart-safe context | FL-11 | #222 CLOSED · #228 CLOSED · epic #212 CLOSED · PR #197 MERGED | ◐ partial saved-state foundation · 🔧 broader continuity needs hardening | `browser-first/test/session-summary-store.test.mjs` lines 43–58 tests reload; `browser-first/test/living-archive-continuity-acceptance.test.mjs` lines 128–252 tests persistence/recovery of supplied state. | explicitly saved state; does not establish background monitoring, reopening tabs, or verifying current tab contents |

### Summarization & research

| Capability | FL | Canonical issue(s) | Status | Tests / proof | Safety boundary |
|---|---|---|---|---|---|
| One-click / question-driven summaries | FL-13, FL-14 | #221 CLOSED · #39 CLOSED | ✅ supported readable-content summaries and reviewed intake | `browser-first/test/browser-page-actions.test.mjs` line 563 and lines 668–729 tests summary templates/intake and unreadable-content handling. | no universal media-format claim |
| Cross-source synthesis / research trail | FL-15 | #227 OPEN · #39 CLOSED foundation · #237 CLOSED recipes | ◐ partial save/review foundation; broader acceptance open | `browser-first/test/browser-page-actions.test.mjs` lines 732–780 tests multi-page research-trail capture and archive review handoff. **Required:** broader synthesis acceptance; recipes do not certify execution. | captured research trail is distinct from saving a generated comparison |

### Automation

| Capability | FL | Canonical issue(s) | Status | Tests / proof | Safety boundary |
|---|---|---|---|---|---|
| Autonomous navigation / Agent Control | FL-17 | #223 CLOSED · epic #211 CLOSED · #118 OPEN | ✅ supported governed safe actions · 🔒 · 🔧 multi-tab work | `browser-first/test/agent-control-runner.test.mjs` lines 593–613 tests safe click/type/scroll fixture execution. No fresh live-run certification is claimed here. | public submission and sensitive typing remain human-only |
| Agent Control stop/cancel & recovery UX | — | #226 CLOSED · epic #211 CLOSED · PR #301 MERGED | ✅ supported bounded cancellation · 🔒 | `browser-first/test/agent-control-runner.test.mjs` lines 681–711 and 735–756 tests cancellation and cleanup. | user halt and run cleanup; no fresh live-lane success claim |
| Form reading & autofill guard | FL-18 | #31 CLOSED · #8 CLOSED · #224 CLOSED | ✅ supported field reading and recognized benign typing · 🔒 | `browser-first/test/content-redaction.test.mjs` lines 644, 665, 722, 872, 956, 1032 tests field evidence and typing boundaries. | sensitive fields and public submission remain human-only, including after approval |
| Multi-step workflows | FL-19 | #223 CLOSED safe steps · #237 CLOSED recipe documentation · #118 OPEN multi-tab | ◐ partial safe multi-step foundation | `browser-first/test/agent-control-runner.test.mjs` lines 593–613 tests bounded execution; `scripts/recipe-doc-fixtures.test.mjs` lines 24–63 checks recipe structure. **Required:** broader end-to-end workflow proof. | recipe availability does not authorize booking, checkout, or sending |
| Shopping decision packet / checkout handoff | FL-20 | #243 OPEN | ⏸ deferred · 🔒 | **Required:** packet assembly and human-handoff proof; existing field and public-submit boundaries are cited below. | **human-only** checkout; draft/packet only |
| Booking option packet / reservation handoff | FL-21 | #244 OPEN | ⏸ deferred · 🔒 | **Required:** option packet and human-handoff proof. | **human-only** reservation |
| Email drafting | FL-22 | #11 CLOSED draft handoff · #234 OPEN audit UX | ◐ partial draft foundation; audit UX deferred · 🔒 | `browser-first/test/addon-draft-connectors.test.mjs` lines 24–39 and 70–78 tests Gmail compose handoff and audit text explicitly without sending. | draft-only; human sends |
| Meeting scheduling / coordination (write) | FL-23 | #11 CLOSED template foundation · #253 OPEN coordination · #248 OPEN availability | ◐ partial template handoff; coordination deferred · 🔒 | `browser-first/test/addon-draft-connectors.test.mjs` lines 42–56 tests a Calendar event-template URL and explicitly no scheduling. **Required:** coordination/availability acceptance. | **human-only** external send/scheduling; template creation is not availability retrieval |
| Day briefing / recurring tasks | FL-24, FL-25 | #245 OPEN · #246 OPEN | ⏸ deferred · 🔒 | **Required:** read-only briefing/triage proof and recurring-task consent, dry-run, history, kill-switch tests. | opt-in; current task consent does not prove recurring automation |

### Integrations (personal connectors)

| Capability | FL | Canonical issue(s) | Status | Tests / proof | Safety boundary |
|---|---|---|---|---|---|
| Gmail — read + draft-only handoff | FL-26, FL-28 | #11 CLOSED handoff · #247 OPEN retrieval · #234 OPEN audit UX | ◐ partial compose handoff; retrieval/audit deferred · 🔒 | `browser-first/test/addon-draft-connectors.test.mjs` lines 24–39 tests compose URL construction. **Required:** authenticated inbox retrieval/triage and audit UX proof. | read-only / draft-only; no autonomous send |
| Calendar — read-only availability | FL-27, FL-29 | #248 OPEN · #138 OPEN | ⏸ deferred availability · 🔒 | **Required:** availability retrieval and calendar-aware planning proof. The scheduling row's `browser-first/test/addon-draft-connectors.test.mjs` lines 42–56 tests templates only. | availability scope is read-only; template handoff does not read a calendar |

### Voice

| Capability | FL | Canonical issue(s) | Status | Tests / proof | Safety boundary |
|---|---|---|---|---|---|
| Voice mode — transcript to composer | FL-30, FL-31 | #235 OPEN · #249 OPEN · epic #216 OPEN | ◐ partial browser dictation; full voice/delegation deferred · 🔒 | `browser-first/test/composer-runtime.test.mjs` lines 126–184 tests browser dictation into the composer. **Required:** full voice mode and reviewed-transcript preflight proof; dictation does not establish hands-free delegation. | permission-light; transcript reviewed before action |

### Multi-model backend & provider routing

| Capability | FL | Canonical issue(s) | Status | Tests / proof | Safety boundary |
|---|---|---|---|---|---|
| Provider Fabric routing (add/select/route) | FL-32 | #207 CLOSED · epic #214 CLOSED | ✅ supported configured routing foundation | `browser-first/test/provider-fabric-routing-propagation.test.mjs` lines 48–94 tests added-model availability, persistence and route resolution; `browser-first/test/provider-route-acceptance.test.mjs` lines 103–125 tests route availability and credential checks. | configured provider/route safeguards |
| Visible fallback + manual model preservation | — | #231 CLOSED | ✅ supported related FL-32 infrastructure | `browser-first/test/provider-fallback-visibility.test.mjs` lines 58–120 tests manual model preservation, errors, and visible fallback metadata. | fallback remains visible; manual selection preserved in tested cases |
| Provider route health / fallback acceptance | — | #233 CLOSED | ✅ supported related FL-32 infrastructure | `browser-first/test/provider-route-acceptance.test.mjs` lines 117–125 asserts tested status, health and connectivity payloads omit the raw credential. | bounded credential assertions, not universal secrecy certification |
| Reasoning-trace / durable job trace | FL-33 | #225 CLOSED · PR #302 MERGED · #454, #456, #457 | ✅ supported report/archive-request foundation and bounded redacted job persistence | `browser-first/test/control-reporting-service.test.mjs` lines 130–163 and 232–283 tests redaction, report progress calculation, and mocked archive handoff in `browser-first/resonantos-side-panel-extension/src/lib/control-reporting-service.js`; `browser-first/test/monitor-renderers.test.mjs` line 158 tests progress calculation in `browser-first/resonantos-side-panel-extension/src/lib/monitor-renderers.js`. `browser-first/test/browser-job-store.test.mjs` tests redacted persisted records, legacy redaction on load, and failed-read write suppression/new-job refusal in `browser-first/resonantos-side-panel-extension/src/lib/browser-job-store.js`. `browser-first/test/trace-redaction.test.mjs` tests bearer-token ordering and encoded compound secrets in `browser-first/resonantos-side-panel-extension/src/lib/trace-redaction.js`. `scripts/validate-docs.test.mjs` tests the matrix citation-existence gate implemented in `scripts/validate-docs.mjs` and run by `npm run docs:check`. | storage-adapter tests do not certify fresh live UI behavior or successful persistence after write failure; other extension storage sinks are not yet routed through redaction; citation existence does not prove semantic relevance |
| Spreadsheet / document artifact contract | FL-34 | #232 OPEN | 🔮 future acceptance work open | **Required:** artifact-contract proof. Existing summary/research intake does not certify spreadsheet creation/population. | broader artifact workflow remains unproved |
| Renderer-controlled routing hardening | — | #143 CLOSED | ✅ supported provider/privacy infrastructure · 🔒 | `browser-first/test/provider-bridge-session-secrets.test.mjs` lines 135–205 tests credential-safe endpoint restrictions, including permitted custom/local configuration. | restrictions protect credentials; not a blanket rejection of renderer-controlled input |

### Personalization

| Capability | FL | Canonical issue(s) | Status | Tests / proof | Safety boundary |
|---|---|---|---|---|---|
| Opt-in preference memory + reset | FL-35 | #236 OPEN | ⏸ deferred · 🔒 | **Required:** default-off and reset proof. No learned browsing/questioning profile is claimed. | opt-in; no profiling beyond preference |

### Proactive assistance

| Capability | FL | Canonical issue(s) | Status | Tests / proof | Safety boundary |
|---|---|---|---|---|---|
| Opt-in proactive suggestions (surface only) | FL-36 | #254 OPEN | ⏸ deferred · 🔒 | **Required:** surface-only, default-off and opt-in gate tests. | **off by default**; surfaces only, never acts |

### Safety (cross-cutting)

| Capability | FL | Canonical issue(s) | Status | Tests / proof | Safety boundary |
|---|---|---|---|---|---|
| Consent / dry-run / history / kill-switch | FL-38, FL-40 | #116, #224, #240, #226 CLOSED · #246, #234, #243–#245, #249, #253 OPEN · #458, #460 | 🔒 safety-constrained; bounded existing controls and history recovery plus deferred requirements | `browser-first/test/task-consent-store.test.mjs` lines 36–99 tests scoped consent, expiry/revocation; `browser-first/test/content-redaction.test.mjs` lines 665 and 872 tests field boundaries; `browser-first/test/agent-control-runner.test.mjs` lines 373–406, 477–520 and 681 tests scoped safe-action consent, public-submit handoff and preflight cancellation. `browser-first/test/main-workspace-browser-job-controller.test.mjs` and `browser-first/test/settings-job-history-read.test.mjs` test guarded cancel/focus and Settings clear paths in `browser-first/resonantos-side-panel-extension/src/lib/main-workspace-browser-job-controller.js` and `browser-first/resonantos-side-panel-extension/src/lib/settings/browser-control-section.js`, both using the shared storage writer in `browser-first/resonantos-side-panel-extension/src/lib/browser-job-store.js`. `browser-first/test/monitor-renderers.test.mjs` tests visible failed-history Retry and Clear disabled while history is unavailable in `browser-first/resonantos-side-panel-extension/src/lib/monitor-renderers.js`; `browser-first/test/side-panel-browser-job-controller.test.mjs` tests coalesced retry/recovery in `browser-first/resonantos-side-panel-extension/src/lib/side-panel-browser-job-controller.js`. **Required:** deferred recurring/draft/packet/voice controls. | consent cannot override human-only wallet/signing/payment/checkout/reservation/public-submit/credential/login actions; Settings browser-job list can still show “No browser jobs” when its own read fails; the monitor Retry/Clear claim does not cover that Settings read path |
| Prompt-injection containment / untrusted context | FL-40 | #455, #461 | ✅ supported structural role separation · 🔒 | `browser-first/test/augmentor-chat-contract.test.mjs` tests page, referenced-tab and attachment text excluded from the system role, provenance framing on the final user turn, and delimiter escaping in `browser-first/host/augmentor-chat-contract.mjs`. `src/modules/chat/controller.test.ts` tests React shell Living Archive retrieval, system memory and compact state excluded from system prompts, preserved across streaming/fallback and framed on the final user turn by the host contract; `src/modules/chat/controller.ts` composes trusted guidance separately from the untrusted context records built in `src/modules/chat/archive-context.ts`. | provenance is not instruction authority; structural escaping does not guarantee how a model interprets content; no universal prompt-injection prevention or live-model certification |

## Milestone epics

- `beta.1` — Augmentor browser-layer acceptance: **#210 CLOSED**
- `beta.1` — onboarding & tester-ready setup: **#213 CLOSED**
- `beta.1` — add-on delegation lifecycle & capability cleanup: **#215 CLOSED**
- `beta.1` — Living Archive & context continuity: **#212 CLOSED**
- `beta.1` — provider routing, reasoning trace, artifacts: **#214 CLOSED**
- `beta.1` — governed Agent Control & safety proofs: **#211 CLOSED**
- `beta.2` — personal connectors, voice, delegated automation: **#216 OPEN**

Closing an epic does not establish completion of every broader FL promise. For
example, artifact-contract acceptance #232 remains open despite #214 being closed.

## Maintenance

Keep issue metadata, bounded implementation claims, and outstanding acceptance
proof separate when updating a row. Record Project 2 fields without equating issue
closure with acceptance. Use full repository-relative file paths, one file per
code span, with line references outside the span.

The offline docs gate (`npm run docs:check`) resolves file-like inline-code
citations in this matrix against Git's tracked inventory, checks file existence
and containment, and rejects ambiguous basenames. It does not validate semantic
relevance, GitHub state, FL interpretation, or live behavior. The browser-first
suite (`npm run test:browser-first`) supplies deterministic behavior checks;
required live-browser proof remains a separate acceptance step.

Follow-up investigations remain separate from this documentation change:
successful highlight→custom Ask browser proof, comparison content capture, and
saved-site permission handling (the lookups at lines 1059–1064 and 1222–1234 in
`browser-first/resonantos-side-panel-extension/src/content.js` differ). Report
construction and archive-request tests also do not replace storage/live UI proof.

## FL mapping overlaps and infrastructure

- Stop/cancel is shared infrastructure with no unique FL item.
- Fallback, route health, and renderer-routing hardening support provider/privacy
  capabilities without a separate primary FL assignment. Routing owns FL-32.
- FL-02 is a broader invocation promise, including address-bar invocation; no
  unambiguous single row establishes it.
- FL-10 overlaps comparison, summaries, and research; their separate bounded
  proofs do not establish the complete cross-tab summarization promise.
- FL-16 overlaps comparisons, summaries, and workflows; decision support requires
  human checking and does not imply decision accuracy.
- FL-38 belongs to task consent/safety; FL-39 belongs to automation-mode choice.
- FL-41–FL-44 are composite example jobs described by the
  [job-search](recipes/job-search.md), [travel](recipes/travel.md),
  [education/tracking](recipes/education-tracking.md), and
  [product-research](recipes/product-research.md) recipes. Recipe existence is not
  complete end-to-end execution proof.

## Appendix: supplied Future List numbering

These ID/title pairs transcribe the supplied numbered Future List (typographic
hyphens normalized). Titles identify the original promises, not accepted runtime
scope; the safety boundaries and bounded claims above govern implementation.

| ID | Title |
|---|---|
| FL-01 | Assistant sidebar (Alt + A) |
| FL-02 | Always-available thought partner |
| FL-03 | Contextual invoke via shortcuts |
| FL-04 | Content analysis of any page |
| FL-05 | Image and media understanding |
| FL-06 | On-page context awareness |
| FL-07 | Highlight-to-ask |
| FL-08 | Counterpoints and “what am I missing?” prompts |
| FL-09 | Cross-tab comparisons |
| FL-10 | Cross-tab summarization |
| FL-11 | Session-level memory |
| FL-12 | Tab referencing in prompts |
| FL-13 | One-click summarization (Alt + S) |
| FL-14 | Question-driven summarization |
| FL-15 | Cross-source synthesis |
| FL-16 | Decision-oriented analysis |
| FL-17 | Autonomous navigation |
| FL-18 | Form filling and data entry |
| FL-19 | Multi-step workflow execution |
| FL-20 | Shopping and purchasing |
| FL-21 | End-to-end booking workflows |
| FL-22 | Email drafting and sending |
| FL-23 | Meeting scheduling and coordination |
| FL-24 | Day briefing and to-do clearing |
| FL-25 | Recurring task automation |
| FL-26 | Gmail integration (read/write) |
| FL-27 | Google Calendar integration |
| FL-28 | Inbox triage and retrieval |
| FL-29 | Calendar-aware planning |
| FL-30 | Voice mode (Shift + Alt + V on desktop) |
| FL-31 | Hands-free task delegation |
| FL-32 | Multi-model backend |
| FL-33 | Expanded reasoning trace |
| FL-34 | Spreadsheet and document creation |
| FL-35 | Learns how you think |
| FL-36 | Proactive suggestions within context |
| FL-37 | Curiosity-centric behavior |
| FL-38 | Explicit permission for browser control |
| FL-39 | User-first control model |
| FL-40 | Privacy-first design |
| FL-41 | Job search orchestration |
| FL-42 | Travel deal hunting |
| FL-43 | Education and tracking workflows |
| FL-44 | Product research and price comparison |
