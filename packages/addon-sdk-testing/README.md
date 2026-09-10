# `@resonantos/addon-sdk-testing`

Negative-test harness for external agent runtime manifests under
ADR-040 §7 (see [PR #327](https://github.com/ResonantOS/2.0.0-alpha/pull/327) for the ADR; it lands as part of the Resonant Extension Framework walk on `feat/tab-referencing` and may not be in `upstream/dev` yet).

> **Status.** V0.1 working draft. Lives at `packages/addon-sdk-testing/` in
> the repo (sibling to `packages/addon-sdk/`). When REF moves to a real
> workspace (Phase 1 of the implementation roadmap), this package becomes
> a published companion; until then, it is private and in-tree.

## Why this package exists

ADR-040 §7 lists ten failure modes (F1–F10) that any external agent
runtime integration must be hardened against. The ADR states:

> Each F-number becomes a test case in `packages/addon-sdk-testing/` (B4
> deliverable) and in the runtime's own manifest review.

This package is that B4 deliverable. It provides:

- An **in-process mock host** (`mockHost(...)`) that simulates the
  bridge, the routing-decision store, the audit log, and the
  approval-prompt surface without spinning up the real ResonantOS
  host.
- **Ten runnable failure-mode cases** (F1–F10) exposing a single
  function `runAddOnFailureMode(modeId, manifest)` that returns a
  `FailureModeReport` describing what the host did and whether the
  outcome matched ADR-040's `Expected:` clause.
- A **synthetic external-agent-runtime manifest fixture**
  (`createExternalAgentRuntimeFixture(...)`) with the standard
  `providers` + `agent-delegation` capability conjunction so the tests
  are repeatable without coordinating with `examples/addons/`.
- A **vitest-conformant test file** at
  `packages/addon-sdk-testing/test/failure-modes.test.ts` that
  asserts each F-number's `Expected` clause. Already passing locally.

## Scope (V0.1)

In scope:

- All ten §7 failure modes (F1–F10), deterministic, no real network.
- Audit-capture surface matching ADR-040 §3 Rule 7 and §4.
- Routing-decision store matching §4 (issue / expire / revoke).
- One synthetic external-agent-runtime manifest fixture.
- The vitest suite.

Out of scope:

- Running against the real ResonantOS host. (Different test runtime;
  see ADR-040 §11 — the real integration is `addons/resonant-browser-host/`.)
- F11+ modes that Tom is expected to add in review. The mock host
  exposes the same audit/routing primitives those would need; adding
  more modes is a copy-and-extend exercise.
- Live harness against `examples/addons/recursive-mas.json`. ADR-040
  §8 names this addon as satisfying the rules; a follow-on test could
  invoke `runAddOnFailureMode("F1", recursiveMasManifest)` for
  cross-addon evidence.

## Public API

```ts
import {
  runAddOnFailureMode,
  mockHost,
  externalAgentRuntimeFixture,
  type FailureModeId,
  type FailureModeReport,
  type ExternalAgentRuntimeManifest,
} from "@resonantos/addon-sdk-testing";

const host = mockHost();
const report: FailureModeReport = runAddOnFailureMode("F1", {
  ...externalAgentRuntimeFixture(),
  // override for the specific failure mode under test
});

if (!report.pass) {
  console.error(report.actual.code, report.actual.auditReason);
}
```

See `src/index.ts` for the full export surface.

## Mapping to ADR-040

| F-number | ADR-040 §7 clause | Test file | Expected host response |
| --- | --- | --- | --- |
| F1 | Credential exfiltration attempt | `failure-modes/f1-credential-exfiltration.ts` | `credential-in-payload` |
| F2 | Provider self-selection | `failure-modes/f2-provider-self-selection.ts` | `provider-self-selection-rejected` |
| F3 | Workspace escape | `failure-modes/f3-workspace-escape.ts` | `workspace-escape` |
| F4 | Capability escalation | `failure-modes/f4-capability-escalation.ts` | `capability-denied` |
| F5 | Undeclared tool | `failure-modes/f5-undeclared-tool.ts` | `unknown-tool` |
| F6 | Audit bypass | `failure-modes/f6-audit-bypass.ts` | `audit-bypass-attempt` |
| F7 | Approval skip | `failure-modes/f7-approval-skip.ts` | `approval-required` (or `approval-denied` if denied) |
| F8 | Stale routing decision | `failure-modes/f8-stale-routing-decision.ts` | `routing-decision-expired` |
| F9 | Revoked routing decision | `failure-modes/f9-revoked-routing-decision.ts` | `routing-decision-revoked` |
| F10 | Experimental route (un-declared) | `failure-modes/f10-experimental-route.ts` | `experimental-route-not-declared` |

## Validation

```bash
npm run docs:check     # package is reachable from docs/README.md
npx tsc --noEmit        # clean
npx vitest run          # all green, including failure-modes.test.ts
```

The full suite (429 vitest + this package's tests) must remain green
across the existing REF PR and any merged follow-ons.

## ADR / ADR-coupling

- **ADR-040 §7** is the spec. Every test's expected behavior is
  copied from the `Expected:` clause of the corresponding failure
  mode.
- **ADR-038 §8** (Phase 3.5 caller-attributed capability tokens) is
  the mechanism the mock host simulates. The mock does not implement
  the full Phase 3.5 token minting/verification path; it only asserts
  the deny codes and audit reasons the ADR says a hardened bridge
  would emit.
- **ADR-005** (Provider Fabric & Routing) is what the
  `routing-store.ts` shape mirrors.
- **ADR-015** (Delegation Fabric) is what the approval-prompt surface
  (`mockHost({ onApprovalPrompt })`) aligns with.

When the ADRs change, the failure-mode `Expected` clauses change with
them. Test names include the ADR-040 F-number so the mapping is
self-documenting in test output.
