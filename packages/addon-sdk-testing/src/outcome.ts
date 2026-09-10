// Intent citation: docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md#7-failure-modes
//
// Result types for the negative-test harness. These describe what the
// mock host did in response to a failure-mode attempt and whether that
// response matches ADR-040 §7's "Expected:" clause.

/**
 * The deny-code / reason the ADR-040 §7 clause asserts the host should
 * emit in response to a given failure mode. Each value corresponds
 * verbatim to one `Expected:` clause in ADR-040 §7.
 */
export type FailureModeExpectedCode =
  | "credential-in-payload"
  | "provider-self-selection-rejected"
  | "workspace-escape"
  | "capability-denied"
  | "unknown-tool"
  | "audit-bypass-attempt"
  | "approval-required"
  | "approval-denied"
  | "routing-decision-expired"
  | "routing-decision-revoked"
  | "experimental-route-not-declared";

export type FailureModeId =
  | "F1"
  | "F2"
  | "F3"
  | "F4"
  | "F5"
  | "F6"
  | "F7"
  | "F8"
  | "F9"
  | "F10";

export interface FailureModeAuditEntry {
  /** ISO timestamp of the audit event. */
  readonly timestamp: string;
  /** Failure-mode id this audit entry was emitted for. */
  readonly modeId: FailureModeId;
  /** Mirrors the deny-code so callers can correlate with `actual.code`. */
  readonly reason: FailureModeExpectedCode | string;
  /** Caller-attributed capability-token id (ADR-038 §8) that was on the wire. */
  readonly callerId: string;
  /** Free-form structured detail the simulated bridge attached. */
  readonly detail?: Record<string, unknown>;
}

/**
 * The outcome of running one failure-mode case against a manifest
 * fixture. `expected` is verbatim from ADR-040 §7; `actual` is what
 * the mock host did; `pass` is whether `actual` matches `expected`.
 */
export interface FailureModeReport {
  readonly modeId: FailureModeId;
  readonly expected: {
    readonly code: FailureModeExpectedCode;
    readonly auditReason?: FailureModeExpectedCode | string;
  };
  readonly actual: {
    readonly code: FailureModeExpectedCode | string;
    readonly auditReason?: FailureModeExpectedCode | string;
    readonly auditEntry?: FailureModeAuditEntry;
  };
  readonly pass: boolean;
}
