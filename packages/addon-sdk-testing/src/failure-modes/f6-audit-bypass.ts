// Intent citation: docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md#7-f6
//
// F6 — Audit bypass.
// "A runtime attempts to return artifacts directly to its calling
//  agent without going through the artifact return protocol.
//  Expected: host rejects; denied-audit with reason
//  `audit-bypass-attempt`."

import type { MockHost } from "../mock-host.ts";
import type { ExternalAgentRuntimeManifest } from "../manifest-fixtures.ts";
import type { FailureModeExpectedCode, FailureModeId } from "../outcome.ts";

export function runF6AuditBypass(
  manifest: ExternalAgentRuntimeManifest,
  host: MockHost,
): { modeId: FailureModeId; actual: { code: FailureModeExpectedCode | string; auditReason?: FailureModeExpectedCode | string } } {
  // The runtime tries to return artifacts on a surface the manifest
  // does not declare. The valid artifact-return surface is
  // `testing-external-agent-runs` (the background-task-monitor the
  // fixture declares); a sibling surface (or worse, an undeclared
  // "calling agent" surface like `addons/recursive-mas/runs`) is a
  // bypass attempt.
  const validSurfaces = ["testing-external-agent-runs"];

  const result = host.returnArtifacts(
    {
      callerId: manifest.callerId,
      surface: "agents/calling-agent-direct",
      artifacts: ["delegated-artifact-001"],
    },
    validSurfaces,
  );

  if (result.ok) {
    return { modeId: "F6", actual: { code: "no-deny", auditReason: "no-deny" } };
  }
  const code = result.code;
  return { modeId: "F6", actual: { code, auditReason: code } };
}
