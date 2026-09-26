# ResonantOS Project State Review

**Date:** 2026-09-16
**Scope:** ROS-SDK repository and its surrounding workspace
**Status:** Research complete — all facts are **OBSERVED** from the local
repository, except where explicitly marked **INFERRED** (requires GitHub access
to confirm).

---

## 1. What this review covers

This document records the verified current state of the ResonantOS SDK project
before the post-consolidation architecture program begins. It is the baseline
that the [master implementation plan](03-master-implementation-plan.md) builds
on.

---

## 2. Workspace topology

The umbrella folder `resonant-os/` is **not** itself a Git repository. It
contains several independent Git checkouts and supporting folders:

| Path                     | Kind             | Git remote(s)                                                             | Purpose                                                  |
| ------------------------ | ---------------- | ------------------------------------------------------------------------- | -------------------------------------------------------- |
| `2.0.0-alpha/`           | Git repo (fork)  | `origin` = `vonstegen/2.0.0-alpha`, `upstream` = `ResonantOS/2.0.0-alpha` | Canonical ROS-SDK / ResonantOS 2.0.0 Alpha               |
| `resonant-os-329/`       | Git clone        | `origin` = `vonstegen/2.0.0-alpha`, `upstream` = `ResonantOS/2.0.0-alpha` | PR #329 resubmission workspace                           |
| `resonant-os-331/`       | Git clone        | `origin` = `vonstegen/2.0.0-alpha`, `upstream` = `ResonantOS/2.0.0-alpha` | PR #331 resubmission workspace                           |
| `2.0.0-alpha.worktrees/` | Linked worktrees | Shares `2.0.0-alpha` object DB                                            | 8 feature worktrees                                      |
| `fork-cleanup/`          | Plain folder     | —                                                                         | 2026-09-04 credential-theft incident remediation runbook |

---

## 3. ROS-SDK repository state (`2.0.0-alpha`)

### 3.1 Product boundary

The SDK is **ResonantOS 2.0.0 Alpha**, a browser-first system composed of:

- a Chrome Manifest V3 side-panel extension; and
- an authenticated local Node.js bridge.

The bridge mediates provider, memory, add-on, diagnostics, and browser-control
services; privileged browser actions remain under explicit human control.
Desktop shells, native browser hosts, terminal add-ons, and Audio2TOL are out of
scope for the Alpha runtime.

### 3.2 Verified snapshot

Values below are **this local checkout as of 2026-09-16, pre-#448**. They are
not the current direction. Tom's 16 Sep decisions supersede several of them
upstream (Node 24.21.0, ADR-038, `packages/addon-sdk`, `apps/augmentor`).

| Fact          | Value (as of 2026-09-16, this checkout, pre-#448)   | Evidence                            |
| ------------- | --------------------------------------------------- | ----------------------------------- |
| Package       | `resonantos-vnext` `2.0.0-beta.1`                   | `package.json`                      |
| Node.js floor | `>=22.13.0` (superseded upstream by 24.21.0, #448)  | `package.json`, `.nvmrc`            |
| Extension     | Manifest V3 `0.1.14`, Chrome 116 minimum            | extension `manifest.json`           |
| Release state | Alpha MVP gate met; beta.1 prepared                 | `docs/STATUS.md`                    |
| Beta.2 gate   | Open; tracked in issue #402                         | `docs/STATUS.md`, `docs/ROADMAP.md` |
| Dev workflow  | Feature branch → PR into `dev`; never push directly | `AGENTS.md`                         |

> **Note:** this snapshot reflects the **local checkout**, which lags `upstream/dev`.
> Tom's 16 Sep decisions supersede several values upstream: Node 24.21.0 (#448),
> ADR-038 (#452), `packages/addon-sdk` (#441), and `apps/augmentor` (#448).

### 3.3 Current branch and working tree

The `2.0.0-alpha` checkout is on branch `resubmit/deepseek-dispatcher`
(`HEAD` = `d2dab56b`), with uncommitted changes to the deepseek dispatcher and
related test/package files plus untracked Discord-sync and DeepSeek-harness
example files.

`resonant-os-329/` is on `resubmit/deepseek-harness-example-trimmed` (20 commits
behind `upstream/dev`), and `resonant-os-331/` is on
`resubmit/dev-external-agent-runtimes-panel` (20 commits behind, with modified
bridge/panel/test files).

---

## 4. Security incident and fork cleanup

On 2026-09-04 a stolen maintainer credential was used to push a malicious
GitHub Actions workflow to `ResonantOS/2.0.0-alpha` `dev`. The workflow exfiltrated
`secrets.PROJECT_SYNC_TOKEN` to an external host. Upstream removed the file on
2026-09-08 and added CI hardening (workflow guards, drift checker, incident
monitoring).

The fork `vonstegen/2.0.0-alpha` retains the malicious file on 22 branches
including `dev`. A five-phase cleanup program is documented in `fork-cleanup/`:

1. Backup everything worth keeping (complete).
2. Delete the fork and re-fork from upstream (complete).
3. Resubmit the SDK work as smaller PRs (in progress).
4. Worktree link repair (optional; links currently verified valid).
5. Local decontamination (pending Phase 3).

The malicious commits remain in history everywhere (upstream removed the file,
not the commits). The resubmission path is therefore **tip-scoped**: new branches
must not contain the malicious workflow file.

---

## 5. Open PRs and their blockers

Confirmed against `ResonantOS/2.0.0-alpha` at capture time (all open):

| PR   | Head branch                              | Theme                                              | Blocker summary                                                                                                   |
| ---- | ---------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| #327 | `feat/tab-referencing`                   | REF V0.1 + ADR-040 + `packages/addon-sdk/` cutover | Not mergeable as-is; hygiene exemption and ADR title/body drift. Split into docs-only ADR PR + SDK relocation PR. |
| #328 | `feat/addon-sdk-testing-f1-f10`          | ADR-040 §7 F1–F10 negative-test harness            | CI-blocked: credential-shaped fixture, repo-wide `tsconfig` change, workspace containment check.                  |
| #329 | `feat/addon-deepseek-harness-example`    | DeepSeek harness example + cross-addon F-tests     | Inherits #328 block; experimental auth and host-command declarations; weak test assertions.                       |
| #330 | `feat/deepseek-harness-phase35-test`     | Bridge-side dispatcher + Phase 3.5 wire-up         | Not mergeable; redesign: entrypoint allowlist, addon-id path guard, auth rewrite scope.                           |
| #331 | `feat/dev-external-agent-runtimes-panel` | Governed external-agent-runtime status panel       | Inherits #330; panel itself careful, needs constant error messages and a maintainer-owned dispatcher.             |

The fork also hosted its own PR chain #1–#16 (CP-5 / CP-6 / CP-7.5 SDK-hardening
splits). These close permanently with the fork; they are retained as source
material for resubmission.

---

## 6. Existing architecture and decision history

The `2.0.0-alpha/docs/architecture/` directory holds ADR-001 through ADR-038 (ADR-038 merged upstream on 16 Sep and now in this checkout),
each with decision status and Alpha applicability. Key SDK-relevant decisions:

- **ADR-006 (Add-on Runtime & SDK)** — manifest validation, provenance,
  capabilities, host mediation.
- **ADR-018 (Add-on SDK V0)** — internal manifest and capability contracts.
- **ADR-023 (Add-on Repository And Registry Model)** — bundled manifests and
  provenance; external registry distribution deferred.
- **ADR-024 (Add-on Store And Commerce)** — deferred.
- **ADR-026 (Minimal Kernel And Replaceable Default Add-ons)** — replaceable chat,
  memory, and add-on boundaries.

The existing capability model and add-on SDK (locally `src/sdk/addons`; upstream relocated to `packages/addon-sdk`, #441) are the starting point for the REF
reconstruction called for by both roadmap documents.

---

## 7. Relationship between the two roadmap documents

Two 2026-09-14 documents define the future direction, and they **differ on one
core identity question**:

| Topic                       | DOCX (post-consolidation)                                     | PDF v2 (SDK + DAO governance)                                 |
| --------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| Augmentor role              | **Fused** — permanent executive intelligence, not replaceable | **De-fused** — governed AI/orchestration component            |
| Root of authority           | ResonantOS (not Augmentor)                                    | ResonantOS Authority Plane + Guardian/Engineer                |
| Persistent stewardship role | (implicit in ResonantOS)                                      | Explicit **Guardian/Engineer** role                           |
| Extension/certification     | REF capability classes, third-party add-on model              | Adds certification pipeline, marketplace, developer NFTs, DAO |
| Implementation phases       | 0–8                                                           | A–K                                                           |

The PDF v2 **supersedes** the DOCX on the Augmentor identity. The DOCX's security
invariants (P1–P7), capability split, caller attribution, commit boundary,
host-held credentials, provenance, and Ground-0 recovery all remain valid and are
carried forward into the [master plan](03-master-implementation-plan.md).

---

## 8. Baseline conclusions

1. The SDK is a **stable Alpha at beta.1**, with a governed extension framework
   already present but not yet split into Public / Privileged / Core-only classes.
2. The **fork-cleanup resubmission** must complete before broad SDK reconstruction
   can be reviewed cleanly.
3. The **PDF v2 Guardian/Engineer architecture** is the authoritative future
   direction; the DOCX supplies the concrete security engineering work items.
4. Daily execution status should flow through the
   [daily summary protocol](daily/README.md) so the dev team always sees the same
   phase, checkpoint, and checklist state.
5. Tom's 16 Sep sync is the authoritative current direction: one Augmentor
   (Manolo's DeepSeek Harness in `apps/augmentor`), Guardian per ADR-038, and the
   SDK at `packages/addon-sdk`.
