# SDK Reviewer Agent V0.1 — Augmentor/Logician Review Copilot for Add-on Certification

## Status

Design-stage proposal, part of the Resonant Extension Framework V0.1
package at `docs/design/resonant-extension-framework/`. Companion to
`ADDON_CERTIFICATION_AND_SIGNING_V0.1.md`; does not amend it.

## Purpose

Define an agent — the **SDK Reviewer** — that operates inside the REF
certification pipeline and helps the ResonantOS team review add-on
submissions: extracting facts, applying review policy, and drafting
review records with recommended decisions.

The SDK Reviewer is built the ResonantOS way: it is itself an add-on,
declared against the same SDK contracts it reviews others with.

## Grounding: What Already Exists

This design assembles existing, proven pieces rather than inventing a
new subsystem:

- **Augmentor** — the reasoning/strategist persona. Add-ons teach it
  operating methods through the `augmentorSkills` manifest contract
  (`docs/architecture/ADDON_AUGMENTOR_SKILL_TEMPLATE.md`): declared
  workflow phases, approval gates, required tools, delegation packets,
  audit logging.
- **Logician** — the deterministic-verification workstream, already
  shipped as `addon.logician` ("policy and reasoning rules engine",
  `runtimeType: local-service`, archive read scopes `constitution` /
  `protocols`, no provider credentials). ADR-018: "Deterministic
  verification is owned by the Logician workstream. Add-ons declare the
  checks and hooks; Logician or host-side services execute and report
  them."
- **Engineer runner** (`scripts/engineer-runner.mjs`, ADR-034) — the
  prompt/verify precedent: an agent does work, then deterministic checks
  verify the result.
- **Certification spec** — the review record schema, review outcomes
  (`approved` / `approved-with-constraints` / `changes-requested` /
  `rejected` / `suspended` / `revoked`), human review triggers, and the
  core state rule:

```text
VALID != VERIFIED != APPROVED != GRANTED
```

## The One Non-Negotiable Rule

**The SDK Reviewer recommends. Humans approve.**

- The agent may contribute to VALID and VERIFIED (automated checks).
- The agent may *draft* an APPROVED review record.
- The APPROVED transition and the release signature always require a
  human (or explicit enterprise policy) decision. The agent's output is
  an input to that decision, never a substitute for it.
- A positive agent recommendation **never lowers** a manual-review
  trigger defined in the certification spec. High/critical-risk releases
  get human eyes regardless of what the agent says.
- The certification spec's non-goal — "no automatic approval of
  sensitive permission changes" — is retained unchanged.

### Adversarial stance

The agent's job is to argue **against** the submission: find reasons to
reject, constrain, or request changes. A reviewer copilot that looks for
reasons to approve amplifies automation bias; one that must cite
evidence for every concern it raises (and explicitly states what it
could not verify) strengthens the human decision.

## Architecture

Two halves, matching the repo's Augmentor/Logician split:

```text
Submission bundle (.rpkg + audit + provenance)
        |
        v
+--------------------------------------------------+
| LOGICIAN HALF — deterministic, no LLM            |
|                                                  |
|  validate manifest (validateAddOnManifest)       |
|  compute package + manifest digests              |
|  diff requestedCapabilities vs prior approved    |
|  dependency inventory + advisory scan            |
|  run sandboxed smoke tests                       |
|  evaluate policy rules (constitution)            |
|    e.g. shell + network -> mandatory human       |
|                                                  |
|  output: EVIDENCE BUNDLE (machine-readable)      |
+--------------------------------------------------+
        |
        v
+--------------------------------------------------+
| AUGMENTOR HALF — reasoning, advisory             |
|                                                  |
|  reviewer skill (augmentorSkills contract):      |
|    1. read evidence bundle (never raw bytes)     |
|    2. check policy findings against release type |
|    3. adversarial analysis: what could this      |
|       add-on do with each granted capability?    |
|    4. draft review record:                       |
|         recommendedDecision + evidenceRefs       |
|         + mandatoryHumanTriggers                 |
|         + unverifiableItems                      |
|    5. prepare human decision packet              |
+--------------------------------------------------+
        |
        v
Human reviewer approves / constrains / requests changes / rejects
        |
        v
Signature service signs the exact approved digest
```

### Why the halves are separated

Facts the decision rests on (digests, capability diffs, scan results,
policy-rule hits) must be **reproducible and non-interpretive** — that is
Logician work, executable in CI without any model. The LLM only
*interprets* evidence that is already deterministic, which makes the
agent's contribution auditable and its failure modes bounded: a wrong
model can produce a bad recommendation, but it cannot fabricate a digest
or hide a capability diff.

## The Reviewer Is an Add-on (Dogfooding)

```json
{
  "id": "addon.sdk-reviewer",
  "name": "SDK Reviewer",
  "category": "security",
  "runtimeType": "local-service",
  "requestedCapabilities": [
    { "capability": "archive-read", "scope": "shared",
      "revocationBehavior": "hard-stop" },
    { "capability": "archive-intake-write", "scope": "intake-only",
      "revocationBehavior": "hard-stop" },
    { "capability": "providers", "scope": "shared",
      "revocationBehavior": "degrade" }
  ],
  "tools": [
    { "name": "review.extract_facts", "requiresHumanApproval": false },
    { "name": "review.diff_capabilities", "requiresHumanApproval": false },
    { "name": "review.classify_risk", "requiresHumanApproval": false },
    { "name": "review.draft_record", "requiresHumanApproval": false },
    { "name": "review.record_decision", "requiresHumanApproval": true }
  ]
}
```

Deliberate constraints:

- **No `shell` capability.** Deterministic certification tooling runs
  host-side (Logician/engineer-runner pattern); the reviewer calls
  declared host-mediated tools. This follows the Hermes lesson: passive
  audit must not run submission binaries, shell commands, or network
  calls.
- **Archive writes are intake-only.** Draft review records land in an
  intake/review boundary; the trusted registry and the signing service
  are written only after human decision.
- **Provider access via shared profiles** — the reviewer never holds
  raw credentials.
- **Self-review rule:** updates to `addon.sdk-reviewer` itself go
  through the same pipeline with mandatory human review. The reviewer
  never touches its own release.

## "Trained Within the SDK Framework"

In ResonantOS vocabulary, agents are trained with **skills plus
fixtures**, not weights:

1. **Reviewer skill** — an `augmentorSkills` document (per the SDK
   template) encoding the review operating method: intake checklist,
   evidence requirements, capability-risk heuristics, adversarial
   probes, delegation-packet output for the human decision, and explicit
   "when not to recommend approval" conditions.
2. **Golden fixture corpus** — deterministic review cases with expected
   outcomes, replayed in CI (`node --test`):

| Fixture | Expected recommendation |
|---|---|
| clean low-risk utility, no network/shell | `approved` (streamlined) |
| calculator requesting `filesystem.write` + `shell` | `changes-requested` |
| v1.3 adding `network` over approved v1.2 | `changes-requested` (re-review) |
| package digest mismatch after submission | `rejected` |
| secret-like file in package | `rejected` |
| unsupported SDK range | `rejected` |
| publisher key change between versions | escalate: mandatory human |

3. **Measured agreement** — CI reports decision agreement and
   evidence-citation coverage per fixture. Skill or model changes that
   regress fixtures block the reviewer add-on's own release.

## Prompt-Injection Containment

Submission content (manifest text, README, code, skill docs) is
**untrusted data**:

- Facts reach the model only through deterministic extractors (the
  evidence bundle), never by the model reading raw submission bytes for
  ground truth.
- Raw content may be quoted only as bounded evidence excerpts attached
  to findings.
- The reviewer executes nothing from the submission. Smoke tests run in
  the Logician half's sandbox, host-side.
- The skill instructs the reviewer to ignore instructions embedded in
  submission content and to report their presence as a finding.

## Auditability

Every AI-assisted review record carries: model id, reviewer-skill
version, evidence-bundle hash, prompt-template hash, and the human
decision that followed. A disputed decision can therefore be replayed:
same evidence bundle + same skill version + same model -> same
recommendation, or a documented divergence.

## Phasing

### R1 — Deterministic facts, human-only decisions

Logician half ships; evidence bundles attached to every submission; all
decisions human. (Mostly already specified in the certification spec.)

*Exit gate:* evidence bundle reproducible across runs for the same
submission bytes.

### R2 — Advisory drafting

Augmentor half ships; agent drafts a recommendation on every submission;
humans decide every release. Fixture corpus runs in CI.

*Exit gate:* measured agreement on the golden corpus at or above a
threshold the team sets; zero cases of the agent lowering a
manual-review trigger.

### R3 — Fast-track for low-risk only (optional, policy decision)

After a fixture-proven track record: LOW-risk releases with a clean
agent recommendation may use a streamlined human sign-off. Still
human-signed, version-bound, revocable. Sensitive triggers untouched.

*Exit gate:* explicit team policy decision recorded in an ADR; not
implied by this document.

## Open Questions for Review

1. Should the reviewer's evidence bundle schema be the same document as
   the certification spec's machine-readable capability report, or a
   superset?
2. What agreement threshold on the golden corpus qualifies R2 -> R3,
   and who owns that threshold?
3. Should the reviewer see the *previous* human review records for
   earlier versions of the same add-on (continuity) — and does that risk
   anchoring?
4. Is a second, deliberately different model/skill as a
   counter-reviewer worth the cost for HIGH/CRITICAL releases?
5. Does `addon.sdk-reviewer` belong in the Resonant Approved tier by
   definition once shipped, or does it earn the tier like everyone else?
