// Intent citation: docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md#4-credential-mediation
// Intent citation: docs/architecture/ADR-005-provider-fabric-routing.md
//
// In-process routing-decision store used by `mock-host.ts` to back the
// failure modes F8 (stale) and F9 (revoked). Mirrors the wire shape in
// ADR-040 §4 (the "routed model handle") — opaque IDs, expiry, revocable.

import type { AuthTier, ProviderCostPosture, RuntimeNodeKind } from "../../../src/core/contracts.ts";

export interface RoutingDecision {
  readonly routingDecisionId: string;
  readonly providerProfileId: string;
  readonly runtimeNodeId: string;
  readonly model: string;
  readonly authTier: AuthTier;
  readonly costPosture: ProviderCostPosture;
  readonly fallbackChain: readonly string[];
  /** ISO timestamp; past this, the host treats the decision as stale. */
  readonly expiresAt: string;
  readonly callerId: string;
}

export interface RoutingStore {
  issue(decision: Omit<RoutingDecision, "routingDecisionId"> & { routingDecisionId?: string }): RoutingDecision;
  /** Returns the decision if it exists, is not expired, and is not revoked. */
  resolve(routingDecisionId: string, nowIso?: string): RoutingDecision | { error: FailureModeExpectedCode };
  revoke(routingDecisionId: string): boolean;
  /** Force an issue to be expired immediately. Used to test F8 in a deterministic clock. */
  expire(routingDecisionId: string): boolean;
  snapshot(): readonly RoutingDecision[];
  reset(): void;
}

import type { FailureModeExpectedCode } from "./outcome.ts";

let nextId = 1;

export function createRoutingStore(now?: () => Date): RoutingStore {
  const decisions = new Map<string, RoutingDecision>();
  const revoked = new Set<string>();
  const clock = now ?? (() => new Date());

  function issue(input: Omit<RoutingDecision, "routingDecisionId"> & { routingDecisionId?: string }): RoutingDecision {
    const id = input.routingDecisionId ?? `rd-${String(nextId++).padStart(3, "0")}`;
    const decision: RoutingDecision = {
      routingDecisionId: id,
      providerProfileId: input.providerProfileId,
      runtimeNodeId: input.runtimeNodeId,
      model: input.model,
      authTier: input.authTier,
      costPosture: input.costPosture,
      fallbackChain: input.fallbackChain,
      expiresAt: input.expiresAt,
      callerId: input.callerId,
    };
    decisions.set(id, decision);
    revoked.delete(id);
    return decision;
  }

  function resolve(routingDecisionId: string, nowIso?: string): RoutingDecision | { error: FailureModeExpectedCode } {
    const d = decisions.get(routingDecisionId);
    if (!d) return { error: "routing-decision-revoked" };
    if (revoked.has(routingDecisionId)) return { error: "routing-decision-revoked" };
    const nowMs = nowIso ? Date.parse(nowIso) : clock().getTime();
    if (nowMs > Date.parse(d.expiresAt)) return { error: "routing-decision-expired" };
    return d;
  }

  function revoke(routingDecisionId: string): boolean {
    if (!decisions.has(routingDecisionId)) return false;
    revoked.add(routingDecisionId);
    return true;
  }

  function expire(routingDecisionId: string): boolean {
    const d = decisions.get(routingDecisionId);
    if (!d) return false;
    const past: RoutingDecision = { ...d, expiresAt: "1970-01-01T00:00:00Z" };
    decisions.set(routingDecisionId, past);
    return true;
  }

  function snapshot(): readonly RoutingDecision[] {
    return Array.from(decisions.values());
  }

  function reset(): void {
    decisions.clear();
    revoked.clear();
  }

  return { issue, resolve, revoke, expire, snapshot, reset };
}

export const _internal = { setNextId: (n: number) => { nextId = n; } };
