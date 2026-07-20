# Augmentor Future List — acceptance matrix

The maintained source-of-truth mapping each **Augmentor Future List** capability
family to its canonical GitHub issue, current status, required tests/proof, and
safety boundary — so contributors read this instead of doing chat-history
archaeology (issue #217).

**On the "FL-01…FL-44" numbering:** the original Future List used a numbered
FL-01…FL-44 index, but that numbered artifact lives outside the repo. Rather than
reproduce numbers that can't be verified against a committed source, this matrix
is keyed to the **capability families** the Future List defines and to the
**canonical issue** for each — which is the durable identifier. When a numbered
source is committed to the repo, add an `FL-NN` column here.

## How to read the status column

| Status | Meaning |
|---|---|
| ✅ **supported** | Foundation shipped and working on `dev` today (closed delivering issue). |
| 🔧 **needs hardening** | Working, but open issues add coverage/UX/edge-cases before community-test. |
| 🔒 **safety-constrained** | Bounded by a human-only or consent boundary; never shipped as silent automation. |
| ⏸ **deferred** | Scoped `deferred`; not in the current milestone. |
| 🔮 **future** | Planned, open, not yet started. |

Legend: `(C)` = closed/shipped issue · `epic` = tracking epic · issues without a
suffix are open. Safety-boundary rows are **never** casual good-first-issues.

## Matrix

### Core interface
| Capability | Canonical issue(s) | Status | Tests / proof | Safety boundary |
|---|---|---|---|---|
| Side panel + Alt+A / Alt+S shortcuts | #241 · #46 (C) | 🔧 needs hardening | shortcut-contract + conflict handling — **live-browser proof** (#241) | — |
| Augmentor mode selector + permission-state | #230 | 🔧 needs hardening | mode-select + permission-surface tests; live-browser proof | surfaces current permissions; no silent capability escalation |

### Web understanding
| Capability | Canonical issue(s) | Status | Tests / proof | Safety boundary |
|---|---|---|---|---|
| Page content analysis / Q&A | #218 · #8 (C) | ✅ supported | page-understanding fixture coverage (#218); `npm run test:browser-first` | — |
| Highlight-to-ask (inline assistant) | #9 (C) | ✅ supported | inline-assistant path in `provider-bridge-service` tests | — |
| Counterpoints / explain-jargon | #219 | 🔮 future | fixtures TBD | — |
| Image / media understanding | #242 | ⏸ deferred · 🔒 | live-browser proof; bounded media handling | privacy/security-sensitive |

### Cross-tab intelligence
| Capability | Canonical issue(s) | Status | Tests / proof | Safety boundary |
|---|---|---|---|---|
| Cross-tab comparison (model-chosen) | #220 · #118 | 🔧 needs hardening | tab-provenance assertions | — |
| Explicit `@tab` referencing | #252 | 🔮 future | `@tab` token→tab-id resolution unit tests; live-browser proof | only tabs the user can already see |
| Session-level memory / restart-safe context | #222 · #228 · epic #212 · PR #197 (C) | 🔧 needs hardening | Living Archive continuity acceptance proof (#228) | — |

### Summarization & research
| Capability | Canonical issue(s) | Status | Tests / proof | Safety boundary |
|---|---|---|---|---|
| One-click / question-driven summaries | #221 · #222 · #39 (C) · #114 | ✅ supported | summary intake flows | — |
| Cross-source synthesis / research trail | #227 · #237 (docs) | 🔮 future | research-trail save + archive handoff | — |

### Automation
| Capability | Canonical issue(s) | Status | Tests / proof | Safety boundary |
|---|---|---|---|---|
| Autonomous navigation / Agent Control | #118 · #225 · epic #211 | 🔧 needs hardening · 🔒 | click/type/scroll certification fixtures; live-browser proof | governed; human-only public-submit / field-typing boundaries |
| Agent Control stop/cancel & recovery UX | #226 · epic #211 | 🔧 needs hardening · 🔒 | stop/cancel kill-path + recovery-state tests; live-browser proof | user can always halt an in-flight action; no orphaned run state |
| Form reading & autofill guard | #31 (C) · #8 (C) | ✅ supported | autofill-guard tests | never auto-submits; approval-gated |
| Multi-step workflows | #237 · #14 (C) · #12 (C) | ✅ supported | — | — |
| Shopping decision packet / checkout handoff | #243 · #16 (C) | ⏸ deferred · 🔒 | packet assembly + human-confirm gate | **human-only** checkout; draft/packet only |
| Booking option packet / reservation handoff | #244 | ⏸ deferred · 🔒 | packet + human-confirm gate | **human-only** reservation |
| Email drafting | #235 · #68 (C) · #47 (C) · #11 (C) | 🔒 safety-constrained | draft-only handoff tests | draft-only; human sends |
| Meeting scheduling / coordination (write) | #253 | ⏸ deferred · 🔒 | packet + non-bypassable human-confirm | **human-only** send; calendar-read is #248 |
| Day briefing / recurring tasks | #245 · #246 | ⏸ deferred · 🔒 | consent / dry-run / kill-switch tests | opt-in; consent + kill-switch required |

### Integrations (personal connectors)
| Capability | Canonical issue(s) | Status | Tests / proof | Safety boundary |
|---|---|---|---|---|
| Gmail — read + draft-only handoff | #247 · #234 · #11 (C) | ⏸ deferred · 🔒 | read-only retrieval; draft-only handoff UX | read-only / draft-only; no autonomous send |
| Calendar — read-only availability | #248 · #138 | ⏸ deferred · 🔒 | availability read tests | read-only |

### Voice
| Capability | Canonical issue(s) | Status | Tests / proof | Safety boundary |
|---|---|---|---|---|
| Voice mode — transcript to composer | #235 · #249 · epic #216 | ⏸ deferred · 🔒 | transcript→composer flow; reviewed-transcript preflight | permission-light; reviewed before action |

### Multi-model backend & provider routing
| Capability | Canonical issue(s) | Status | Tests / proof | Safety boundary |
|---|---|---|---|---|
| Provider Fabric routing (add/select/route) | #207 (C) · #214 (epic) | ✅ supported | `provider-fabric-routing-propagation.test.mjs`; `provider-route-acceptance.test.mjs` | credential/route safeguards preserved |
| Visible fallback + manual model preservation | #231 (C) | ✅ supported | `provider-fallback-visibility.test.mjs` | no silent model swap |
| Provider route health / fallback acceptance | #233 (C) | ✅ supported | `provider-route-acceptance.test.mjs` (no-secret-leak) | secrets never surfaced |
| Reasoning-trace / durable job trace | #225 | 🔮 future | step-counter proof; live-browser | — |
| Spreadsheet / document artifact contract | #232 | 🔮 future | artifact-contract tests | — |
| Renderer-controlled routing hardening | #143 (C) | ✅ supported · 🔒 | routing input-validation tests | rejects renderer-controlled provider input |

### Personalization
| Capability | Canonical issue(s) | Status | Tests / proof | Safety boundary |
|---|---|---|---|---|
| Opt-in preference memory + reset | #236 | ⏸ deferred · 🔒 | default-off + reset tests | opt-in; no profiling beyond preference |

### Proactive assistance
| Capability | Canonical issue(s) | Status | Tests / proof | Safety boundary |
|---|---|---|---|---|
| Opt-in proactive suggestions (surface only) | #254 | 🔮 future · 🔒 | default-off + opt-in gate tests | **off by default**; surfaces only, never acts |

### Safety (cross-cutting)
| Capability | Canonical issue(s) | Status | Safety boundary |
|---|---|---|---|
| Consent / dry-run / history / kill-switch | #246 · #234 · #243–#245 · #249 · #253 | 🔒 safety-constrained | every automation with side effects is opt-in, consent-gated, and human-confirmed; wallet/signing/payment/checkout/public-submit/credential/login stay human-only |

## Milestone epics

- `beta.1` — Augmentor browser-layer acceptance: **#210**
- `beta.1` — onboarding & tester-ready setup: **#213**
- `beta.1` — add-on delegation lifecycle & capability cleanup: **#215**
- `beta.1` — Living Archive & context continuity: **#212**
- `beta.1` — provider routing, reasoning trace, artifacts: **#214**
- `beta.1` — governed Agent Control & safety proofs: **#211**
- `beta.2` — personal connectors, voice, delegated automation: **#216**

## Maintenance

Keep each row's status, canonical issue, and Project 2 fields (Release Scope,
Area, Priority, Status, milestone) in agreement with the canonical issue; when an
issue closes, update its row's status and cite the delivering test. This matrix is
verified by the docs gate (`npm run docs:check`) and the browser-first suite
(`npm run test:browser-first`).
