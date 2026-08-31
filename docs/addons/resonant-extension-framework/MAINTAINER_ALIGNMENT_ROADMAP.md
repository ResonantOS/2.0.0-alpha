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
| 1 | Reframe ADR-038 as evolution, not replacement | Done | ADR-038 §1: "extension of, not replacement for, ADR-006 and ADR-018" |
| 2 | Divide SDK Core V0.1 from Distribution/Lifecycle beta.2 | Done (status) | ADR-038 §15.2 re-classifies C6/C7/C8/C10/C11 as beta.2 distribution deferrals |
| 3 | Gate signing/.rpkg/registry/sideload behind "activates when third-party install exists" | Done (documented) | ADR-038 §15.2 cites #109: "becomes gating the moment a remote/marketplace registry or extension-side sideload lands" |
| 4 | Uninstall/revocation/re-consent as a first-class contract (#180) | **Partial** | §15.2 records only `disable ≠ uninstall ≠ re-authorize`; the full lifecycle contract is ADR-038 §16 (in progress) |
| 5 | PR #327 too large — decompose | Done | Split into #327 (REF) + #334 (tab-referencing); original history on `backup/tab-referencing-pre-split` |
| 6 | "Maintainer-alignment patch" as the next move | Done | ADR-038 §15 reconciliation + §15.2 re-classification + split |
| 7 | Keep the DeepSeek/external-runtime experiment | Intact | ADR-040 lives in #327; external-runtime PRs #329–#331 unaffected |

## Remaining

### Phase 1 — unblocked

1. **Close the Amendment-4 gap.** Draft ADR-038 §16: the add-on lifecycle security contract —
   - `disable` — execution impossible, configuration preserved;
   - `enable` — no silent re-authorization of materially changed grants;
   - `uninstall` — atomic revoke of all grants, terminate associated runtimes, remove host residue (`Settings/addon-execution.json`, `DelegationArtifacts/`);
   - `update` — diff the capability manifest, require fresh consent for expanded authority.
   Grounded in Tom's #180 audit.
2. **Resolve the ADR-038 double-claim.** `feat/tab-referencing` (#327) assigns ADR-038 = REF; `feat/dev-external-agent-runtimes-panel` (#331) assigns ADR-038 = Add-on Runtime Identity. One must renumber before either merges to `dev` (which tops out at ADR-037).

### Phase 2 — blocked on Tom

3. **Review #327 + #334**, and answer ADR-038 §15.3:
   - REF-vs-"Add-on SDK V1" terminology;
   - `packages/addon-sdk/` as the long-term public boundary;
   - which V0.1 subset to accept now;
   - the Deferred → Accepted transition path.

### Phase 3 — parallel CP workstream

4. CP-7 redaction/export/retention/deletion tests; CP-5 assistant-only output-filtering parity; CP-6 executor UI; CP-9 "declare stable" (blocked on live harness validation + OpenClaw key).

## Sequencing

```text
Phase 1 (do now)           Phase 2 (blocked)           Phase 3 (parallel)
--------------------       --------------------        --------------------
1. ADR-038 §16 lifecycle → feeds §15.3 answers        4. CP-7 tests
2. ADR-038 renumber       → clean merge surface          CP-5 filtering
       │                      (Tom reviews #327/#334)    CP-6 UI
       └────────────────► all converge at Accepted ────► CP-9 stable
```
