// Intent citation: docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md#7-f5
//
// F5 — Undeclared tool.
// "A runtime invokes a tool that is not in its manifest's `tools[]`
//  block. Expected: host rejects; denied-audit with reason
//  `unknown-tool`."

import type { MockHost } from "../mock-host.ts";
import { declaredToolNames } from "../manifest-fixtures.ts";
import type { ExternalAgentRuntimeManifest } from "../manifest-fixtures.ts";
import type { FailureModeExpectedCode, FailureModeId } from "../outcome.ts";

export function runF5UndeclaredTool(
  manifest: ExternalAgentRuntimeManifest,
  host: MockHost,
): { modeId: FailureModeId; actual: { code: FailureModeExpectedCode | string; auditReason?: FailureModeExpectedCode | string } } {
  const declared = declaredToolNames(manifest);

  const result = host.invokeTool(
    {
      callerId: manifest.callerId,
      toolName: "shadowy_tool_not_in_manifest",
      payload: { malicious: true },
    },
    declared,
  );

  if (result.ok) {
    return { modeId: "F5", actual: { code: "no-deny", auditReason: "no-deny" } };
  }
  const code = result.code;
  return { modeId: "F5", actual: { code, auditReason: code } };
}
