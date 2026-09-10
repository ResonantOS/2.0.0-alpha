// Intent citation: docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md#7-failure-modes
//
// Public runner for the ADR-040 §7 failure modes. Each F-number lives
// in its own sibling file (`./f1-credential-exfiltration.ts`, etc.) and
// exports a `run(modeId, manifest, host)` function that drives the
// shared mock host and returns what the host actually did. This
// module's `runAddOnFailureMode` is the single callable surface that
// test files import. It attaches the matching `expected` clause
// from ADR-040 §7 and computes `pass` by comparing the host's actual
// response to the §7 `Expected:` row.

import type { MockHost, MockHostOptions } from "../mock-host.ts";
import { mockHost } from "../mock-host.ts";
export { mockHost } from "../mock-host.ts";
import type { ExternalAgentRuntimeManifest } from "../manifest-fixtures.ts";

import type { FailureModeExpectedCode, FailureModeId, FailureModeReport } from "../outcome.ts";

import { runF1CredentialExfiltration } from "./f1-credential-exfiltration.ts";
import { runF2ProviderSelfSelection } from "./f2-provider-self-selection.ts";
import { runF3WorkspaceEscape } from "./f3-workspace-escape.ts";
import { runF4CapabilityEscalation } from "./f4-capability-escalation.ts";
import { runF5UndeclaredTool } from "./f5-undeclared-tool.ts";
import { runF6AuditBypass } from "./f6-audit-bypass.ts";
import { runF7ApprovalSkip } from "./f7-approval-skip.ts";
import { runF8StaleRoutingDecision } from "./f8-stale-routing-decision.ts";
import { runF9RevokedRoutingDecision } from "./f9-revoked-routing-decision.ts";
import { runF10ExperimentalRoute } from "./f10-experimental-route.ts";

/** The shape each per-F function returns from the host. */
export type FailureModeRunResult = {
  readonly modeId: FailureModeId;
  readonly actual: {
    readonly code: FailureModeExpectedCode | string;
    readonly auditReason?: FailureModeExpectedCode | string;
  };
};

export type FailureModeRunner = (
  manifest: ExternalAgentRuntimeManifest,
  host: MockHost,
) => FailureModeRunResult;

const MODE_RUNNERS: Readonly<Record<FailureModeId, FailureModeRunner>> = {
  F1: runF1CredentialExfiltration,
  F2: runF2ProviderSelfSelection,
  F3: runF3WorkspaceEscape,
  F4: runF4CapabilityEscalation,
  F5: runF5UndeclaredTool,
  F6: runF6AuditBypass,
  F7: runF7ApprovalSkip,
  F8: runF8StaleRoutingDecision,
  F9: runF9RevokedRoutingDecision,
  F10: runF10ExperimentalRoute,
};

/**
 * All ten §7 mode ids, in their canonical order. Useful for callers
 * that want to drive the full grid (e.g. cross-addon test suites).
 */
export const FAILURE_MODE_IDS: readonly FailureModeId[] = [
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10",
];

export interface RunOptions {
  /** Optional pre-built mock host. Useful for sharing state across modes in one test. */
  host?: MockHost;
  /** Mock host options if `host` is not provided. */
  hostOptions?: MockHostOptions;
}

/**
 * Run a single ADR-040 §7 failure-mode case against the given manifest.
 *
 * Each per-F runner drives the mock host and returns the host's
 * observed outcome. The `runAddOnFailureMode` aggregator wraps that
 * with the matching `expected` row from ADR-040 §7 and computes
 * `pass` by string-equality on `actual.code` and `actual.auditReason`
 * versus the `Expected:` row.
 *
 * The mock host is reset between calls (audit + routing store)
 * **only when the runner owns the host** (i.e., the caller did not
 * pass `options.host`). When the caller supplies a host, the host's
 * state survives so callers can inspect it after the call.
 */
export function runAddOnFailureMode(
  modeId: FailureModeId,
  manifest: ExternalAgentRuntimeManifest,
  options: RunOptions = {},
): FailureModeReport {
  const host = options.host ?? mockHost(options.hostOptions);
  const hostOwned = options.host === undefined;
  const expected = expectedFor(modeId);
  const observed = MODE_RUNNERS[modeId](manifest, host);
  if (hostOwned) {
    host.reset();
  }
  return {
    modeId,
    expected,
    actual: observed.actual,
    pass: codeAndReasonMatch(expected, observed.actual),
  };
}

function codeAndReasonMatch(
  expected: { code: FailureModeExpectedCode; auditReason?: FailureModeExpectedCode | string },
  actual: { code: FailureModeExpectedCode | string; auditReason?: FailureModeExpectedCode | string },
): boolean {
  if (expected.code !== actual.code) return false;
  const expectedReason = expected.auditReason ?? expected.code;
  const actualReason = actual.auditReason ?? actual.code;
  return expectedReason === actualReason;
}

/**
 * Hard-coded mapping from ADR-040 §7 to its `Expected:` clause. The
 * `expected.code` is the deny code; `expected.auditReason` is the
 * audit reason to match in the audit record (defaults to `code`).
 *
 * Keeping this table verbatim at the runner level (not in each per-F
 * file) makes it easy to audit against the ADR during review; the
 * per-F files only describe how to drive the host.
 */
function expectedFor(modeId: FailureModeId): { code: FailureModeExpectedCode; auditReason?: FailureModeExpectedCode | string } {
  switch (modeId) {
    case "F1":
      return { code: "credential-in-payload", auditReason: "credential-in-payload" };
    case "F2":
      return { code: "provider-self-selection-rejected", auditReason: "provider-self-selection-rejected" };
    case "F3":
      return { code: "workspace-escape", auditReason: "workspace-escape" };
    case "F4":
      return { code: "capability-denied", auditReason: "capability-denied" };
    case "F5":
      return { code: "unknown-tool", auditReason: "unknown-tool" };
    case "F6":
      return { code: "audit-bypass-attempt", auditReason: "audit-bypass-attempt" };
    case "F7":
      return { code: "approval-denied", auditReason: "approval-denied" };
    case "F8":
      return { code: "routing-decision-expired", auditReason: "routing-decision-expired" };
    case "F9":
      return { code: "routing-decision-revoked", auditReason: "routing-decision-revoked" };
    case "F10":
      return { code: "experimental-route-not-declared", auditReason: "experimental-route-not-declared" };
    default: {
      const exhaustive: never = modeId;
      throw new Error(`Unknown failure mode: ${exhaustive}`);
    }
  }
}
