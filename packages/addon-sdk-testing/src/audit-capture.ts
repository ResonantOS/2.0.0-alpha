// Intent citation: docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md#3-rule-7-audit-before-return
//
// Thread-safe in-memory audit-log capture. The real ResonantOS host
// emits audit records through the bridge; this module is the mock-host
// side of that surface. Every failure-mode case calls
// `audit.record(...)` after the bridge denies something, and the test
// asserts the recorded entry's `reason` matches the ADR-040 §7 expected.

import type { FailureModeAuditEntry, FailureModeId } from "./outcome.ts";

export interface AuditCapture {
  /** Append a deny record to the audit log. Idempotent across modes. */
  record(entry: Omit<FailureModeAuditEntry, "timestamp"> & { timestamp?: string }): FailureModeAuditEntry;
  /** Snapshot of all records recorded so far (in insertion order). */
  snapshot(): readonly FailureModeAuditEntry[];
  /** Convenience: latest record whose `modeId` matches. */
  latestFor(modeId: FailureModeId): FailureModeAuditEntry | undefined;
  /** Drop all records (used by tests that want a fresh log per case). */
  reset(): void;
}

export function createAuditCapture(): AuditCapture {
  const records: FailureModeAuditEntry[] = [];

  function record(entry: Omit<FailureModeAuditEntry, "timestamp"> & { timestamp?: string }): FailureModeAuditEntry {
    const full: FailureModeAuditEntry = {
      timestamp: entry.timestamp ?? new Date().toISOString(),
      modeId: entry.modeId,
      reason: entry.reason,
      callerId: entry.callerId,
      detail: entry.detail,
    };
    records.push(full);
    return full;
  }

  function snapshot(): readonly FailureModeAuditEntry[] {
    return records.slice();
  }

  function latestFor(modeId: FailureModeId): FailureModeAuditEntry | undefined {
    for (let i = records.length - 1; i >= 0; i--) {
      if (records[i].modeId === modeId) return records[i];
    }
    return undefined;
  }

  function reset(): void {
    records.length = 0;
  }

  return { record, snapshot, latestFor, reset };
}
