// Intent citation: docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md#3-rule-7-audit-before-return
// Intent citation: docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md#4-credential-mediation
//
// Infrastructure tests for the mock host. These lock the contract of
// the audit-capture and routing-store primitives so that any change
// to their behavior surfaces as a regression here, before it
// manifests in failure-modes.test.ts.

import { describe, expect, it } from "vitest";
import { createAuditCapture } from "../src/audit-capture.ts";
import { createRoutingStore } from "../src/routing-store.ts";
import { mockHost, grantedCapabilities } from "../src/mock-host.ts";
import { externalAgentRuntimeFixture } from "../src/manifest-fixtures.ts";
import type { FailureModeAuditEntry } from "../src/outcome.ts";

describe("audit-capture", () => {
  it("records each entry with the supplied reason and caller id", () => {
    const audit = createAuditCapture();
    audit.record({ modeId: "F1", callerId: "caller-1", reason: "credential-in-payload" });
    audit.record({ modeId: "F3", callerId: "caller-1", reason: "workspace-escape" });

    const snap = audit.snapshot();
    expect(snap.length).toBe(2);
    expect(snap[0].reason).toBe("credential-in-payload");
    expect(snap[1].reason).toBe("workspace-escape");
  });

  it("latestFor returns the most recent record for a mode id", () => {
    const audit = createAuditCapture();
    audit.record({ modeId: "F1", callerId: "caller-1", reason: "credential-in-payload" });
    audit.record({ modeId: "F3", callerId: "caller-1", reason: "workspace-escape" });
    audit.record({ modeId: "F1", callerId: "caller-1", reason: "credential-in-payload" });

    const entry: FailureModeAuditEntry | undefined = audit.latestFor("F1");
    expect(entry).toBeDefined();
    expect(entry?.reason).toBe("credential-in-payload");
    const snap = audit.snapshot();
    expect(snap[snap.length - 1]).toEqual(entry);
  });

  it("reset drops every record", () => {
    const audit = createAuditCapture();
    audit.record({ modeId: "F1", callerId: "caller-1", reason: "credential-in-payload" });
    audit.reset();
    expect(audit.snapshot().length).toBe(0);
    expect(audit.latestFor("F1")).toBeUndefined();
  });
});

describe("routing-store", () => {
  it("issues and resolves a routing decision while valid", () => {
    const store = createRoutingStore();
    const issued = store.issue({
      providerProfileId: "resonant-deepseek-v4-pro",
      runtimeNodeId: "rn-local",
      model: "deepseek-v4-pro",
      authTier: "supported",
      costPosture: "paid-api",
      fallbackChain: [],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      callerId: "caller-1",
    });

    const resolved = store.resolve(issued.routingDecisionId);
    expect("routingDecisionId" in resolved).toBe(true);
    if ("routingDecisionId" in resolved) {
      expect(resolved.routingDecisionId).toBe(issued.routingDecisionId);
    }
  });

  it("returns routing-decision-expired for an expired decision", () => {
    const store = createRoutingStore();
    const issued = store.issue({
      providerProfileId: "resonant-deepseek-v4-pro",
      runtimeNodeId: "rn-local",
      model: "deepseek-v4-pro",
      authTier: "supported",
      costPosture: "paid-api",
      fallbackChain: [],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      callerId: "caller-1",
    });
    store.expire(issued.routingDecisionId);

    const resolved = store.resolve(issued.routingDecisionId);
    expect("error" in resolved).toBe(true);
    if ("error" in resolved) {
      expect(resolved.error).toBe("routing-decision-expired");
    }
  });

  it("returns routing-decision-revoked after revoke", () => {
    const store = createRoutingStore();
    const issued = store.issue({
      providerProfileId: "resonant-deepseek-v4-pro",
      runtimeNodeId: "rn-local",
      model: "deepseek-v4-pro",
      authTier: "supported",
      costPosture: "paid-api",
      fallbackChain: [],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      callerId: "caller-1",
    });
    store.revoke(issued.routingDecisionId);

    const resolved = store.resolve(issued.routingDecisionId);
    expect("error" in resolved).toBe(true);
    if ("error" in resolved) {
      expect(resolved.error).toBe("routing-decision-revoked");
    }
  });

  it("accepts an injected clock for deterministic F8 testing", () => {
    const baseTime = new Date("2026-08-25T12:00:00Z");
    let virtual = baseTime.getTime();
    const store = createRoutingStore(() => new Date(virtual));
    const issued = store.issue({
      providerProfileId: "resonant-deepseek-v4-pro",
      runtimeNodeId: "rn-local",
      model: "deepseek-v4-pro",
      authTier: "supported",
      costPosture: "paid-api",
      fallbackChain: [],
      expiresAt: new Date(virtual + 60_000).toISOString(),
      callerId: "caller-1",
    });
    virtual += 120_000;

    const resolved = store.resolve(issued.routingDecisionId);
    expect("error" in resolved).toBe(true);
  });
});

describe("mock host primitives", () => {
  it("grantedCapabilities returns the granted subset of a manifest's requestedCapabilities", () => {
    const manifest = externalAgentRuntimeFixture();
    const granted = grantedCapabilities(manifest);
    expect(granted.length).toBe(0);
  });

  it("forwardNetwork blocks when a forbidden authorization header is present", () => {
    const host = mockHost();
    const result = host.forwardNetwork({
      callerId: "caller-1",
      payload: { route: "external-service" },
      headers: { authorization: "Bearer sk-test" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("credential-in-payload");
    }
    const entry = host.audit.latestFor("F1");
    expect(entry).toBeDefined();
  });

  it("forwardNetwork blocks when a credential-shaped key is in the payload body", () => {
    const host = mockHost();
    const result = host.forwardNetwork({
      callerId: "caller-1",
      payload: { apiKey: "sk-test" },
      headers: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("credential-in-payload");
    }
  });

  it("accessWorkspace permits paths within the workspace root and denies elsewhere", () => {
    const host = mockHost();
    const inside = host.accessWorkspace({
      callerId: "caller-1",
      requestedPath: "/workspace/agent/notes.md",
      workspaceRoot: "/workspace/agent",
    });
    expect(inside.ok).toBe(true);

    const outside = host.accessWorkspace({
      callerId: "caller-1",
      requestedPath: "/etc/passwd",
      workspaceRoot: "/workspace/agent",
    });
    expect(outside.ok).toBe(false);
    if (!outside.ok) {
      expect(outside.code).toBe("workspace-escape");
    }
  });

  it("invokeTool denies unknown tool names but permits declared ones", () => {
    const host = mockHost();
    const declared = ["send_model_request", "run_task"];
    const bad = host.invokeTool({ callerId: "caller-1", toolName: "shadowy_tool", payload: {} }, declared);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("unknown-tool");

    const good = host.invokeTool({ callerId: "caller-1", toolName: "send_model_request", payload: {} }, declared);
    expect(good.ok).toBe(true);
  });

  it("returnArtifacts denies surfaces not declared in validSurfaces", () => {
    const host = mockHost();
    const result = host.returnArtifacts(
      { callerId: "caller-1", surface: "agents/calling-agent-direct", artifacts: ["x"] },
      ["testing-external-agent-runs"],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("audit-bypass-attempt");
  });

  it("requestApproval approves a tool when the prompt returns approved", () => {
    const host = mockHost({ onApprovalPrompt: () => "approved" });
    const result = host.requestApproval({ callerId: "caller-1", toolName: "run_task", addonId: "addon.testing.external-agent-runtime" });
    expect(result.ok).toBe(true);
  });

  it("requestApproval denies and audits when the prompt returns denied", () => {
    const host = mockHost({ onApprovalPrompt: () => "denied" });
    const result = host.requestApproval({ callerId: "caller-1", toolName: "run_task", addonId: "addon.testing.external-agent-runtime" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("approval-denied");
    }
    const entry = host.audit.latestFor("F7");
    expect(entry).toBeDefined();
  });

  it("callArchiveIntakeWrite denies when the requested capability is not granted", () => {
    const host = mockHost();
    const result = host.callArchiveIntakeWrite({
      callerId: "caller-1",
      granted: ["providers", "filesystem"],
      requested: "archive-intake-write",
      itemRef: "x",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("capability-denied");
  });

  it("invokeModel accepts the routing decision's model and rejects self-selected models", () => {
    const host = mockHost();
    const decision = host.issueRoutingDecision({
      providerProfileId: "resonant-deepseek-v4-pro",
      runtimeNodeId: "rn-local",
      model: "deepseek-v4-pro",
      authTier: "supported",
      costPosture: "paid-api",
      fallbackChain: [],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      callerId: "caller-1",
    });

    const accepted = host.invokeModel({
      callerId: "caller-1",
      routingDecisionId: decision.routingDecisionId,
      payload: { prompt: "hi" },
    });
    expect(accepted.ok).toBe(true);

    const rejected = host.invokeModel({
      callerId: "caller-1",
      routingDecisionId: decision.routingDecisionId,
      explicitModel: "gpt-4o",
      payload: { prompt: "hi" },
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe("provider-self-selection-rejected");
  });
});
