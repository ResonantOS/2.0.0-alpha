// Intent citation: docs/architecture/ADR-056-provider-fabric-boundary-external-agent-runtimes.md#7-f3
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
    manifest,
  });

  if (result.ok) {
    return { modeId: "F3", actual: { code: "no-deny", auditReason: "no-deny" } };
  }

  // A prefix-only containment check admits `<root>/../outside`; the mock
  // must normalize before deciding (review finding).
  const traversal = host.accessWorkspace({
    callerId: manifest.callerId,
    requestedPath: `${workspaceRoot}/../outside`,
    workspaceRoot,
    manifest,
  });
  if (traversal.ok) {
    return { modeId: "F3", actual: { code: "no-deny", auditReason: "no-deny" } };
  }

  // ADR-056 §7 F3 hard-stop: after a workspace-escape, the `shell`
  // capability is revoked when the manifest declared
  // `revocationBehavior: "hard-stop"`. The driver asserts the
  // revocation by issuing a follow-up `invokeTool` for the `shell`
  // tool — that call must be denied. If the host did not revoke, the
  // call returns ok and F3 reports `no-deny`.
  const shellGrant = manifest.requestedCapabilities.find((g) => g.capability === "shell");
  if (shellGrant?.revocationBehavior === "hard-stop") {
    const followUp = host.invokeTool(
      { callerId: manifest.callerId, toolName: "shell", payload: { command: "cat /etc/passwd" } },
      ["shell", "filesystem.read", "filesystem.write"],
    );
    if (followUp.ok) {
      return { modeId: "F3", actual: { code: "no-deny", auditReason: "no-deny" } };
    }
    return { modeId: "F3", actual: { code: traversal.code, auditReason: traversal.code } };
  }

  return { modeId: "F3", actual: { code: traversal.code, auditReason: traversal.code } };
}
