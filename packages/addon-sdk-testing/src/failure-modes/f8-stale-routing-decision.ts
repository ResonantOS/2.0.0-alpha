// Intent citation: docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md#7-f8
//
// F8 — Stale routing decision.
// "A runtime uses a `routingDecisionId` whose `expiresAt` has passed.
//  Expected: host rejects; returns `routing-decision-expired`; runtime
//  requests a new decision."

import type { MockHost } from "../mock-host.ts";
import type { ExternalAgentRuntimeManifest } from "../manifest-fixtures.ts";
import type { FailureModeExpectedCode, FailureModeId } from "../outcome.ts";

export function runF8StaleRoutingDecision(
  manifest: ExternalAgentRuntimeManifest,
  host: MockHost,
): { modeId: FailureModeId; actual: { code: FailureModeExpectedCode | string; auditReason?: FailureModeExpectedCode | string } } {
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

  // Force the decision to be expired.
  host.routing.expire(decision.routingDecisionId);

  const result = host.forwardModelRequest({
    callerId: manifest.callerId,
    routingDecisionId: decision.routingDecisionId,
    payload: { prompt: "anything" },
  });

  if (result.ok) {
    return { modeId: "F8", actual: { code: "no-deny", auditReason: "no-deny" } };
  }
  const code = result.code;
  return { modeId: "F8", actual: { code, auditReason: code } };
}
