// Intent citation: docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md#7-f3
//
// F3 — Workspace escape.
// "A runtime uses `shell` to `cat` a file outside its task workspace.
//  Expected: host blocks at the bridge; denied-audit with reason
//  `workspace-escape`; the runtime's `shell` grant is revoked if
//  `revocationBehavior` is `hard-stop`."

import type { MockHost } from "../mock-host.ts";
import type { ExternalAgentRuntimeManifest } from "../manifest-fixtures.ts";
import type { FailureModeExpectedCode, FailureModeId } from "../outcome.ts";

export function runF3WorkspaceEscape(
  manifest: ExternalAgentRuntimeManifest,
  host: MockHost,
): { modeId: FailureModeId; actual: { code: FailureModeExpectedCode | string; auditReason?: FailureModeExpectedCode | string } } {
  const workspaceRoot = "/workspace/external-agent-task-001";

  const result = host.accessWorkspace({
    callerId: manifest.callerId,
    requestedPath: "/etc/passwd",
    workspaceRoot,
  });

  if (result.ok) {
    return { modeId: "F3", actual: { code: "no-deny", auditReason: "no-deny" } };
  }
  const code = result.code;
  return { modeId: "F3", actual: { code, auditReason: code } };
}
