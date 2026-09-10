// Intent citation: docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md#7-f2
//
// F2 — Provider self-selection.
// "A runtime declares its own model (`model: 'gpt-4o'`) in a tool
//  call payload, bypassing the routing decision.
//  Expected: host rejects the model request; returns
//  `provider-self-selection-rejected`; the runtime must use its
//  routing decision's model."

import type { MockHost } from "../mock-host.ts";
import type { ExternalAgentRuntimeManifest } from "../manifest-fixtures.ts";
import type { FailureModeExpectedCode, FailureModeId } from "../outcome.ts";

export function runF2ProviderSelfSelection(
  manifest: ExternalAgentRuntimeManifest,
  host: MockHost,
): { modeId: FailureModeId; actual: { code: FailureModeExpectedCode | string; auditReason?: FailureModeExpectedCode | string } } {
  // Routing decision says: deepseek-v4-pro.
  const decision = host.issueRoutingDecision({
    providerProfileId: "resonant-deepseek-v4-pro",
    runtimeNodeId: "rn-local-user-mac",
    model: "deepseek-v4-pro",
    authTier: "supported",
    costPosture: "paid-api",
    fallbackChain: [],
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    callerId: manifest.callerId,
  });

  const result = host.invokeModel({
    callerId: manifest.callerId,
    routingDecisionId: decision.routingDecisionId,
    explicitModel: "gpt-4o",
    payload: { prompt: "hi" },
  });

  if (result.ok) {
    return { modeId: "F2", actual: { code: "no-deny", auditReason: "no-deny" } };
  }
  const code = result.code;
  return { modeId: "F2", actual: { code, auditReason: code } };
}
