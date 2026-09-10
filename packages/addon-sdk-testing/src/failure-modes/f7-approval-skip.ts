// Intent citation: docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md#7-f7
//
// F7 — Approval skip.
// "A runtime invokes a `run_task`-style tool marked
//  `requiresHumanApproval: true` without the user having approved.
//  Expected: host blocks until approval; if approval denied, runtime
//  receives `approval-denied` and must abort the task."

import type { MockHost } from "../mock-host.ts";
import { mockHost } from "../mock-host.ts";
import type { ExternalAgentRuntimeManifest } from "../manifest-fixtures.ts";
import type { FailureModeExpectedCode, FailureModeId } from "../outcome.ts";

export function runF7ApprovalSkip(
  manifest: ExternalAgentRuntimeManifest,
  _host: MockHost,
): { modeId: FailureModeId; actual: { code: FailureModeExpectedCode | string; auditReason?: FailureModeExpectedCode | string } } {
  // F7 needs a deterministic approval outcome ("denied"); we make
  // a fresh, scoped mock host with the prompt forced to deny.
  const host = mockHost({ onApprovalPrompt: () => "denied" });

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
