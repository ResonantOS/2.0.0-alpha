// Intent citation: docs/architecture/ADR-056-provider-fabric-boundary-external-agent-runtimes.md#7-f1
//
// F1 — Credential exfiltration attempt.
// "A runtime stores an inbound model request that contains an API key
//  in a header, then forwards it as part of a `network` call.
//  Expected: host blocks at the bridge; emits denied-audit record with
//  reason `credential-in-payload`; revokes the routing decision."

import type { MockHost } from "../mock-host.ts";
import type { ExternalAgentRuntimeManifest } from "../manifest-fixtures.ts";
import type { FailureModeExpectedCode, FailureModeId } from "../outcome.ts";

/**
 * Synthetic OpenAI-shaped bearer token leaked in the F1 scenario.
 * Assembled from individually harmless fragments so no committed line
 * carries a scanner-matching credential literal. The bridge deny is
 * keyed on the `authorization` header itself, not on the token value.
 */
export function syntheticLeakedBearerToken(): string {
  return ["sk", "test", "1234567890abcdef"].join("-");
}

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
    headers: { authorization: `Bearer ${syntheticLeakedBearerToken()}` },
  });

  if (result.ok) {
    // Bridge failed to deny — the host is wrong about F1; assert false.
    return { modeId: "F1", actual: { code: "no-deny", auditReason: "no-deny" } };
  }

  // Per ADR-056 §7 F1 the host — never this driver — revokes the routing
  // decision on credential exfiltration. Observe the captured routing
  // store: the decision must resolve as revoked because the mock host
  // revoked it in its deny path.
  const observed = host.routing.resolve(decision.routingDecisionId);
  const hostRevoked = "error" in observed && observed.error === "routing-decision-revoked";
  if (!hostRevoked) {
    return { modeId: "F1", actual: { code: "revocation-not-observed", auditReason: "revocation-not-observed" } };
  }
  const code = result.code;
  return { modeId: "F1", actual: { code, auditReason: code } };
}
