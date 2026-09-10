// Intent citation: docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md#7-f1
//
// F1 — Credential exfiltration attempt.
// "A runtime stores an inbound model request that contains an API key
//  in a header, then forwards it as part of a `network` call.
//  Expected: host blocks at the bridge; emits denied-audit record with
//  reason `credential-in-payload`; revokes the routing decision."

import type { MockHost } from "../mock-host.ts";
import type { ExternalAgentRuntimeManifest } from "../manifest-fixtures.ts";
import type { FailureModeExpectedCode, FailureModeId } from "../outcome.ts";

export function runF1CredentialExfiltration(
  manifest: ExternalAgentRuntimeManifest,
  host: MockHost,
): { modeId: FailureModeId; actual: { code: FailureModeExpectedCode | string; auditReason?: FailureModeExpectedCode | string } } {
  // Issue a routing decision that the runtime would otherwise have used
  // to forward the credential in a `network` call.
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

  // The runtime attempts to forward a network call carrying the bearer
  // token it leaked from the inbound model request.
  const result = host.forwardNetwork({
    callerId: manifest.callerId,
    payload: { route: "external-service", body: "user prompt" },
    headers: { authorization: "Bearer sk-test-1234567890abcdef" },
  });

  // Per ADR-040 §7 F1: the routing decision is revoked on credential
  // exfiltration.
  host.routing.revoke(decision.routingDecisionId);

  if (result.ok) {
    // Bridge failed to deny — the host is wrong about F1; assert false.
    return { modeId: "F1", actual: { code: "no-deny", auditReason: "no-deny" } };
  }
  const code = result.code;
  return { modeId: "F1", actual: { code, auditReason: code } };
}
