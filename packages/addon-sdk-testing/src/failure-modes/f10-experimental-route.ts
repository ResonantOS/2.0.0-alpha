// Intent citation: docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md#7-f10
//
// F10 — Experimental route attempt without declaration.
// "A runtime requests an experimental route without
//  `allowExperimentalAuth: true`. Expected: rejected with
//  `experimental-route-not-declared`."

import type { MockHost } from "../mock-host.ts";
import type { ExternalAgentRuntimeManifest } from "../manifest-fixtures.ts";
import type { FailureModeExpectedCode, FailureModeId } from "../outcome.ts";

export function runF10ExperimentalRoute(
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

  // The fixture's providerRequirements.allowExperimentalAuth is false
  // (set in manifest-fixtures.ts). The runtime attempts an
  // experimental route anyway.
  if (manifest.providerRequirements.allowExperimentalAuth) {
    // Defensive: the fixture changed and this test no longer applies.
    return { modeId: "F10", actual: { code: "fixture-mismatch", auditReason: "fixture-mismatch" } };
  }

  const result = host.requestExperimentalRoute({
    callerId: manifest.callerId,
    routingDecisionId: decision.routingDecisionId,
    experimental: true,
  });

  if (result.ok) {
    return { modeId: "F10", actual: { code: "no-deny", auditReason: "no-deny" } };
  }
  const code = result.code;
  return { modeId: "F10", actual: { code, auditReason: code } };
}
