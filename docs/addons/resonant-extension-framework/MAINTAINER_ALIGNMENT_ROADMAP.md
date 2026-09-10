# Maintainer-Alignment Roadmap — REF/SDK Contribution

## Status

- Date: 2026-08-31
- Source: external review of Tom's *indirect* maintainer feedback (ChatGPT, 2026-08-31), verified against the upstream issue record.
- Verdict: the architecture is aligned (~8/10); the disagreement is **release-scope timing** (Alpha/beta.1 vs beta.2), not design. Remaining work is decision hygiene and decomposition, not redesign.
- Tom has **not reviewed** the REF PRs. Every maintainer signal below is a release-scope disposition on issues (#109, #180, #215, #137), each drafted via Claude Code and read from the issue comment record on 2026-08-31.

## Principle

REF is the governed evolution of the existing Add-on SDK (ADR-006/ADR-018), not a replacement. It splits into two planes:

- **REF Core / Add-on SDK V0.1** — manifests, capability declarations, validation, delegation contracts, external-runtime boundary, host-owned authority, negative-test infrastructure. Moves now.
- **REF Distribution & Lifecycle (beta.2)** — `.rpkg` install, remote registry, third-party sideload, signature/hash enforcement, certification, update/uninstall/revocation, marketplace. Gated on a third-party install path existing.

Security requirements become mandatory at the boundary where third-party code actually becomes installable (Tom, #109).

## Completed

| # | Recommendation | State | Evidence |
|---|---|---|---|
| 0 | Verify Tom's feedback rather than trust the sweep | Done | GitHub API read of #109/#180/#215/#137; zero reviews/comments from `tompennington` on #327–#331 |
| 1 | Reframe ADR-055 as evolution, not replacement | Done | ADR-055 §1: "extension of, not replacement for, ADR-006 and ADR-018" |
| 2 | Divide SDK Core V0.1 from Distribution/Lifecycle beta.2 | Done (status) | ADR-055 §15.2 re-classifies C6/C7/C8/C10/C11 as beta.2 distribution deferrals |
| 3 | Gate signing/.rpkg/registry/sideload behind "activates when third-party install exists" | Done (documented) | ADR-055 §15.2 cites #109: "becomes gating the moment a remote/marketplace registry or extension-side sideload lands" |
| 4 | Uninstall/revocation/re-consent as a first-class contract (#180) | Done | ADR-055 §16 — four-transition lifecycle contract (disable/enable/uninstall/update), grounded in the #180 audit |
| 5 | PR #327 too large — decompose | Done | Split into #327 (REF) + #334 (tab-referencing); original history on `backup/tab-referencing-pre-split` |
| 6 | "Maintainer-alignment patch" as the next move | Done | ADR-055 §15 reconciliation + §15.2 re-classification + split |
| 7 | Keep the DeepSeek/external-runtime experiment | Intact | ADR-056 lives in #327; external-runtime PRs #329–#331 unaffected |
| 8 | Resolve the ADR double-claim (fork hygiene) | Done | REF renumbered ADR-038→055, ADR-040→056, ADR-039→057 (153 refs + 2 renames); CP branch retains ADR-038–054 |

## Remaining

### Phase 1 — blocked on Tom

1. **Review #327 + #334**, and answer ADR-055 §15.3:
   - REF-vs-"Add-on SDK V1" terminology;
   - `packages/addon-sdk/` as the long-term public boundary;
   - which V0.1 subset to accept now;
   - the Deferred → Accepted transition path.

### Phase 2 — parallel CP workstream

2. CP-7 redaction/export/retention/deletion tests; CP-5 assistant-only output-filtering parity; CP-6 executor UI; CP-9 "declare stable" (blocked on live harness validation + OpenClaw key).

## Sequencing

1. Tom reviews #327 + #334 and answers ADR-055 §15.3 → Deferred → Accepted.
2. In parallel: CP-7 tests, CP-5 filtering, CP-6 UI → CP-9 stable.
