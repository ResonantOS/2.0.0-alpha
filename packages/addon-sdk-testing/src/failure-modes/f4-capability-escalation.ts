// Intent citation: docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md#7-f4
//
// F4 — Capability escalation.
// "A runtime claims it needs `archive-intake-write` mid-task and tries
//  to call the archive intake route.
//  Expected: host rejects at the bridge (caller-attributed token does
//  not grant `archive-intake-write`); denied-audit with reason
//  `capability-denied`."

import type { MockHost } from "../mock-host.ts";
import { grantedCapabilities } from "../mock-host.ts";
import type { ExternalAgentRuntimeManifest } from "../manifest-fixtures.ts";
import type { FailureModeExpectedCode, FailureModeId } from "../outcome.ts";

export function runF4CapabilityEscalation(
  manifest: ExternalAgentRuntimeManifest,
  host: MockHost,
): { modeId: FailureModeId; actual: { code: FailureModeExpectedCode | string; auditReason?: FailureModeExpectedCode | string } } {
  // Grant a baseline set but NOT archive-intake-write.
  const granted = grantedCapabilities(manifest);

  const result = host.callArchiveIntakeWrite({
    callerId: manifest.callerId,
    granted,
    requested: "archive-intake-write",
    itemRef: "delegated-artifact-001",
  });

  if (result.ok) {
    return { modeId: "F4", actual: { code: "no-deny", auditReason: "no-deny" } };
  }
  const code = result.code;
  return { modeId: "F4", actual: { code, auditReason: code } };
}
