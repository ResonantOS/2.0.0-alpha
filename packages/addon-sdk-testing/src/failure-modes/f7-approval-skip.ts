// Intent citation: docs/architecture/ADR-056-provider-fabric-boundary-external-agent-runtimes.md#7-f7
//
// F7 — Approval skip.
// "A runtime invokes a `run_task`-style tool marked
//  `requiresHumanApproval: true` without the user having approved.
//  Expected: host blocks until approval; if approval denied, runtime
//  receives `approval-denied` and must abort the task."

import type { MockHost } from "../mock-host.ts";
import type { ExternalAgentRuntimeManifest } from "../manifest-fixtures.ts";
import type { FailureModeExpectedCode, FailureModeId } from "../outcome.ts";

/**
 * F7 exercises the supplied host's approval gate. The mock-host
 * factory wires the approval prompt via its `onApprovalPrompt`
 * option; the caller (the harness runner) is responsible for
 * constructing a host whose approval gate denies `run_task` for the
 * fixture manifest. This driver asserts the deny code and audit
 * reason that ADR-056 §7 specifies — no fresh mock is built here.
 */
export function runF7ApprovalSkip(
  manifest: ExternalAgentRuntimeManifest,
  host: MockHost,
): { modeId: FailureModeId; actual: { code: FailureModeExpectedCode | string; auditReason?: FailureModeExpectedCode | string } } {
  const result = host.requestApproval({
    callerId: manifest.callerId,
    toolName: "run_task",
    addonId: manifest.id,
  });

  if (result.ok) {
    return { modeId: "F7", actual: { code: "no-deny", auditReason: "no-deny" } };
  }
  const code = result.code;
  return { modeId: "F7", actual: { code, auditReason: code } };
}
