// Intent citation: docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md#3-boundary-rules
// Intent citation: docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md#4-credential-mediation
// Intent citation: docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md#5-model-routing
//
// In-process mock ResonantOS host. Implements the bridge, the
// routing-decision store, the audit log, and the approval-prompt
// surface — just enough to back ADR-040 §7 failure modes F1–F10.
//
// The mock does NOT replicate the real host's token-mint / verify
// pipeline; it asserts the deny codes and audit reasons described in
// ADR-040 §7. The mock host is the only object tests interact with
// across F1–F10; it is intentionally narrow.

import type {
  AddOnManifest,
  Capability,
  CapabilityGrant,
  CapabilityScope,
  RevocationBehavior,
} from "../../../src/core/contracts.ts";

import type { AuditCapture, } from "./audit-capture.ts";
import { createAuditCapture } from "./audit-capture.ts";
import type { RoutingDecision, RoutingStore } from "./routing-store.ts";
import { createRoutingStore } from "./routing-store.ts";
import type { FailureModeExpectedCode, FailureModeId } from "./outcome.ts";

export type ApprovalDecision = "approved" | "denied";

export interface MockHostOptions {
  /** Approval prompt resolver. F7 invokes this with the tool name + manifest id. */
  onApprovalPrompt?: (toolName: string, addonId: string) => ApprovalDecision;
  /** Clock for the routing store; defaults to wall clock. F8 overrides to force expiry. */
  now?: () => Date;
  /** Default TTL for issued routing decisions (ms). */
  routingDecisionTtlMs?: number;
}

export type BridgeDeny =
  | { ok: false; code: "credential-in-payload"; callerId: string; payloadKeys: readonly string[] }
  | { ok: false; code: "provider-self-selection-rejected"; callerId: string; rejectedModel: string; requiredRoutingDecisionId: string }
  | { ok: false; code: "workspace-escape"; callerId: string; requestedPath: string; workspaceRoot: string }
  | { ok: false; code: "capability-denied"; callerId: string; required: Capability; current: readonly Capability[] }
  | { ok: false; code: "unknown-tool"; callerId: string; toolName: string; declaredTools: readonly string[] }
  | { ok: false; code: "audit-bypass-attempt"; callerId: string; surface: string }
  | { ok: false; code: "approval-required"; callerId: string; toolName: string }
  | { ok: false; code: "approval-denied"; callerId: string; toolName: string }
  | { ok: false; code: "routing-decision-expired"; callerId: string; routingDecisionId: string }
  | { ok: false; code: "routing-decision-revoked"; callerId: string; routingDecisionId: string }
  | { ok: false; code: "experimental-route-not-declared"; callerId: string; requestedAuthTier: string };

export type BridgeResult<R> = { ok: true; result: R } | { ok: false } & BridgeDeny;

export interface ToolCallRequest {
  toolName: string;
  payload: Record<string, unknown>;
  callerId: string;
}

export interface ModelRequest {
  callerId: string;
  /** If set, the runtime is overriding what the routing decision said (F2 trigger). */
  explicitModel?: string;
  /** The routing decision the runtime is forwarding. */
  routingDecisionId: string;
  payload: Record<string, unknown>;
  /** Streamed model request. The runtime is allowed to stream model chunks while the decision is valid. */
  streamChunks?: boolean;
}

export interface WorkspaceAccessRequest {
  callerId: string;
  requestedPath: string;
  /** Workspace root the runtime was scoped to by the runtime grant set. */
  workspaceRoot: string;
}

export interface ArtifactReturnRequest {
  callerId: string;
  /** Surface the runtime is returning artifacts to. */
  surface: string;
  artifacts: readonly string[];
}

export interface ApproveRequest {
  callerId: string;
  toolName: string;
  addonId: string;
}

export interface MockHost {
  readonly audit: AuditCapture;
  readonly routing: RoutingStore;
  /** Issue a fresh routing decision (used to set up F8/F9). */
  issueRoutingDecision(input: Omit<RoutingDecision, "routingDecisionId"> & { routingDecisionId?: string }): RoutingDecision;
  /** F1 surface: forward payload across the network bridge. */
  forwardNetwork(request: { callerId: string; payload: Record<string, unknown>; headers: Record<string, string> }): BridgeResult<{ forwarded: true }>;
  /** F2 surface: validate a model request against a routing decision. */
  invokeModel(request: ModelRequest): BridgeResult<{ model: string; streamedChunks: number }>;
  /** F3 surface: route a workspace path access. */
  accessWorkspace(request: WorkspaceAccessRequest): BridgeResult<{ resolvedPath: string }>;
  /** F4 surface: attempt a privileged route not in the granted caller token. */
  callArchiveIntakeWrite(request: { callerId: string; granted: readonly Capability[]; requested: Capability; itemRef: string }): BridgeResult<{ intakeId: string }>;
  /** F5 surface: validate a tool name is in the addon manifest's `tools[]`. */
  invokeTool(request: ToolCallRequest, declaredTools: readonly string[]): BridgeResult<{ toolName: string }>;
  /** F6 surface: return artifacts from a delegated task. */
  returnArtifacts(request: ArtifactReturnRequest, validSurfaces: readonly string[]): BridgeResult<{ acceptedArtifacts: readonly string[] }>;
  /** F7 surface: attempt a tool that requires human approval. */
  requestApproval(request: ApproveRequest): BridgeResult<{ decision: ApprovalDecision }>;
  /** F8/F9 surface: forward a model request that depends on a routing decision. */
  forwardModelRequest(request: ModelRequest): BridgeResult<{ resolvedModel: string }>;
  /** F10 surface: request an experimental route. The mock checks `allowExperimentalAuth` from the manifest. */
  requestExperimentalRoute(request: { callerId: string; routingDecisionId: string; experimental: true }): BridgeResult<{ resolvedModel: string }>;
  /** Reset audit + routing store (used between F-cases in the same `runAddOnFailureMode` invocation). */
  reset(): void;
}

export function mockHost(options: MockHostOptions = {}): MockHost {
  const audit = createAuditCapture();
  const routing = createRoutingStore(options.now);
  const onApproval = options.onApprovalPrompt ?? (() => "approved");
  const ttlMs = options.routingDecisionTtlMs ?? 5 * 60 * 1000;

  function recordDeny(modeId: FailureModeId, callerId: string, code: FailureModeExpectedCode | string, detail?: Record<string, unknown>): void {
    audit.record({ modeId, callerId, reason: code, detail });
  }

  function defaultIssue(input: Omit<RoutingDecision, "routingDecisionId"> & { routingDecisionId?: string }): RoutingDecision {
    return routing.issue(input);
  }

  function forwardNetwork(request: { callerId: string; payload: Record<string, unknown>; headers: Record<string, string> }): BridgeResult<{ forwarded: true }> {
    const forbiddenKeys = Object.keys(request.headers).filter((k) => /^(authorization|x-api-key|cookie)$/i.test(k));
    if (forbiddenKeys.length > 0) {
      const code: FailureModeExpectedCode = "credential-in-payload";
      recordDeny("F1", request.callerId, code, {
        forbiddenHeaderKeys: forbiddenKeys,
        bodyKeys: Object.keys(request.payload),
      });
      return { ok: false, code, callerId: request.callerId, payloadKeys: forbiddenKeys } as BridgeDeny & { ok: false };
    }
    if (Object.keys(request.payload).some((k) => /(api[-_]?key|token|secret)/i.test(k))) {
      const code: FailureModeExpectedCode = "credential-in-payload";
      recordDeny("F1", request.callerId, code, {
        forbiddenBodyKeys: Object.keys(request.payload).filter((k) => /(api[-_]?key|token|secret)/i.test(k)),
      });
      return { ok: false, code, callerId: request.callerId, payloadKeys: Object.keys(request.payload) } as BridgeDeny & { ok: false };
    }
    return { ok: true, result: { forwarded: true } };
  }

  function lookupRouting(routingDecisionId: string, callerId: string): { ok: true; decision: RoutingDecision } | { ok: false; code: FailureModeExpectedCode } {
    const resolved = routing.resolve(routingDecisionId);
    if ("error" in resolved) {
      recordDeny(resolved.error === "routing-decision-expired" ? "F8" : "F9", callerId, resolved.error, { routingDecisionId });
      return { ok: false, code: resolved.error };
    }
    return { ok: true, decision: resolved };
  }

  function invokeModel(request: ModelRequest): BridgeResult<{ model: string; streamedChunks: number }> {
    const routingResult = lookupRouting(request.routingDecisionId, request.callerId);
    if (!routingResult.ok) {
      const code = routingResult.code;
      if (code === "routing-decision-expired") {
        return { ok: false, code, callerId: request.callerId, routingDecisionId: request.routingDecisionId } as BridgeDeny & { ok: false };
      }
      return { ok: false, code, callerId: request.callerId, routingDecisionId: request.routingDecisionId } as BridgeDeny & { ok: false };
    }
    const decision = routingResult.decision;
    if (request.explicitModel !== undefined && request.explicitModel !== decision.model) {
      const code: FailureModeExpectedCode = "provider-self-selection-rejected";
      recordDeny("F2", request.callerId, code, {
        rejectedModel: request.explicitModel,
        routingDecisionModel: decision.model,
        routingDecisionId: request.routingDecisionId,
      });
      return { ok: false, code, callerId: request.callerId, rejectedModel: request.explicitModel, requiredRoutingDecisionId: request.routingDecisionId } as BridgeDeny & { ok: false };
    }
    return { ok: true, result: { model: decision.model, streamedChunks: request.streamChunks ? 1 : 0 } };
  }

  function accessWorkspace(request: WorkspaceAccessRequest): BridgeResult<{ resolvedPath: string }> {
    const requested = request.requestedPath;
    const root = request.workspaceRoot;
    const inside = requested === root || requested.startsWith(root + "/");
    if (!inside) {
      const code: FailureModeExpectedCode = "workspace-escape";
      recordDeny("F3", request.callerId, code, {
        requestedPath: requested,
        workspaceRoot: root,
      });
      return { ok: false, code, callerId: request.callerId, requestedPath: requested, workspaceRoot: root } as BridgeDeny & { ok: false };
    }
    return { ok: true, result: { resolvedPath: requested } };
  }

  function callArchiveIntakeWrite(request: { callerId: string; granted: readonly Capability[]; requested: Capability; itemRef: string }): BridgeResult<{ intakeId: string }> {
    if (!request.granted.includes(request.requested)) {
      const code: FailureModeExpectedCode = "capability-denied";
      recordDeny("F4", request.callerId, code, {
        required: request.requested,
        current: [...request.granted],
        itemRef: request.itemRef,
      });
      return { ok: false, code, callerId: request.callerId, required: request.requested, current: request.granted } as BridgeDeny & { ok: false };
    }
    return { ok: true, result: { intakeId: `intake-${request.itemRef}` } };
  }

  function invokeTool(request: ToolCallRequest, declaredTools: readonly string[]): BridgeResult<{ toolName: string }> {
    if (!declaredTools.includes(request.toolName)) {
      const code: FailureModeExpectedCode = "unknown-tool";
      recordDeny("F5", request.callerId, code, {
        toolName: request.toolName,
        declaredTools: [...declaredTools],
      });
      return { ok: false, code, callerId: request.callerId, toolName: request.toolName, declaredTools } as BridgeDeny & { ok: false };
    }
    return { ok: true, result: { toolName: request.toolName } };
  }

  function returnArtifacts(request: ArtifactReturnRequest, validSurfaces: readonly string[]): BridgeResult<{ acceptedArtifacts: readonly string[] }> {
    if (!validSurfaces.includes(request.surface)) {
      const code: FailureModeExpectedCode = "audit-bypass-attempt";
      recordDeny("F6", request.callerId, code, {
        surface: request.surface,
        validSurfaces: [...validSurfaces],
      });
      return { ok: false, code, callerId: request.callerId, surface: request.surface } as BridgeDeny & { ok: false };
    }
    return { ok: true, result: { acceptedArtifacts: request.artifacts } };
  }

  function requestApproval(request: ApproveRequest): BridgeResult<{ decision: ApprovalDecision }> {
    const decision = onApproval(request.toolName, request.addonId);
    if (decision === "approved") {
      return { ok: true, result: { decision } };
    }
    const code: FailureModeExpectedCode = "approval-denied";
    recordDeny("F7", request.callerId, code, { toolName: request.toolName, addonId: request.addonId });
    return { ok: false, code, callerId: request.callerId, toolName: request.toolName } as BridgeDeny & { ok: false };
  }

  function forwardModelRequest(request: ModelRequest): BridgeResult<{ resolvedModel: string }> {
    const routingResult = lookupRouting(request.routingDecisionId, request.callerId);
    if (!routingResult.ok) {
      const code = routingResult.code;
      return { ok: false, code, callerId: request.callerId, routingDecisionId: request.routingDecisionId } as BridgeDeny & { ok: false };
    }
    return { ok: true, result: { resolvedModel: routingResult.decision.model } };
  }

  function requestExperimentalRoute(request: { callerId: string; routingDecisionId: string; experimental: true }): BridgeResult<{ resolvedModel: string }> {
    // Caller signals the attempt; mock returns "experimental-route-not-declared"
    // because the resolve path itself is what would gate on the manifest's
    // `allowExperimentalAuth`. F10 caller is expected to provide a manifest
    // whose `providerRequirements.allowExperimentalAuth` is false; the resolve
    // below is shared with F8/F9 to exercise stale/revoked paths too.
    const routingResult = lookupRouting(request.routingDecisionId, request.callerId);
    if (!routingResult.ok) {
      const code = routingResult.code;
      return { ok: false, code, callerId: request.callerId, routingDecisionId: request.routingDecisionId } as BridgeDeny & { ok: false };
    }
    const code: FailureModeExpectedCode = "experimental-route-not-declared";
    recordDeny("F10", request.callerId, code, { authTier: "experimental", routingDecisionId: request.routingDecisionId });
    return { ok: false, code, callerId: request.callerId, requestedAuthTier: "experimental" } as BridgeDeny & { ok: false };
  }

  function reset(): void {
    audit.reset();
    routing.reset();
  }

  return {
    audit,
    routing,
    issueRoutingDecision: defaultIssue,
    forwardNetwork,
    invokeModel,
    accessWorkspace,
    callArchiveIntakeWrite,
    invokeTool,
    returnArtifacts,
    requestApproval,
    forwardModelRequest,
    requestExperimentalRoute,
    reset,
  };
}

/**
 * Convenience: `caps` for a manifest fixture's `requestedCapabilities`.
 * Used by F4 and F7 to know which capabilities are currently in the
 * caller-attributed token.
 */
export function grantedCapabilities(manifest: AddOnManifest): readonly Capability[] {
  return manifest.requestedCapabilities.filter((g: CapabilityGrant) => g.granted).map((g) => g.capability);
}

export function grantedScope(manifest: AddOnManifest, capability: Capability): CapabilityScope | undefined {
  return manifest.requestedCapabilities.find((g) => g.capability === capability)?.scope;
}

export function revocationBehavior(manifest: AddOnManifest, capability: Capability): RevocationBehavior | undefined {
  return manifest.requestedCapabilities.find((g) => g.capability === capability)?.revocationBehavior;
}

// Re-export for callers that don't want to import the sub-paths.
export { createAuditCapture } from "./audit-capture.ts";
export { createRoutingStore } from "./routing-store.ts";
export type { AuditCapture } from "./audit-capture.ts";
export type { RoutingDecision, RoutingStore } from "./routing-store.ts";
