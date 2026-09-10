// Intent citation: docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md#7-f9
//
// F9 — Revoked routing decision.
// "A runtime uses a `routingDecisionId` after the host revoked it
//  (e.g., user disabled the runtime). Expected: same as F8 with
//  reason `routing-decision-revoked`."

import type { MockHost } from "../mock-host.ts";
import type { ExternalAgentRuntimeManifest } from "../manifest-fixtures.ts";
import type { FailureModeExpectedCode, FailureModeId } from "../outcome.ts";

export function runF9RevokedRoutingDecision(
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

  // User disabled the runtime (or any other revocation trigger).
  host.routing.revoke(decision.routingDecisionId);

  const result = host.forwardModelRequest({
    callerId: manifest.callerId,
    routingDecisionId: decision.routingDecisionId,
    payload: { prompt: "anything" },
  });

  if (result.ok) {
    return { modeId: "F9", actual: { code: "no-deny", auditReason: "no-deny" } };
  }
  const code = result.code;
  return { modeId: "F9", actual: { code, auditReason: code } };
}
