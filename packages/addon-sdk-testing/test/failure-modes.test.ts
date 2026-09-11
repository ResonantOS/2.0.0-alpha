// Intent citation: docs/architecture/ADR-056-provider-fabric-boundary-external-agent-runtimes.md#7-failure-modes
//
// Vitest suite for ADR-056 §7 failure modes F1–F10. One case per
// F-number; each case invokes `runAddOnFailureMode(modeId, manifest)`
// against the synthetic external-agent-runtime fixture and asserts
// the resulting `FailureModeReport.pass` is true.
//
// The expected deny codes and audit reasons are sourced verbatim from
// the ADR-056 §7 `Expected:` clauses; see
// `packages/addon-sdk-testing/src/failure-modes/index.ts` (`expectedFor`)
// for the canonical copy.

import { describe, expect, it } from "vitest";
import {
  runAddOnFailureMode,
  externalAgentRuntimeFixture,
  type FailureModeId,
} from "../src/index.ts";
import { syntheticLeakedBearerToken } from "../src/failure-modes/f1-credential-exfiltration.ts";

const ALL_MODES: readonly FailureModeId[] = ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10"];

describe("ADR-056 §7 failure modes", () => {
  for (const modeId of ALL_MODES) {
    it(`${modeId} — host denies with the ADR-056 §7 Expected: clause`, () => {
      const manifest = externalAgentRuntimeFixture();
      // F7 must drive a host whose approval prompt denies `run_task`;
      // every other mode passes a fresh, default host.
      const host = mockHostForInspector(
        modeId === "F7" ? { onApprovalPrompt: () => "denied" } : undefined,
      );
      const report = runAddOnFailureMode(modeId, manifest, { host });

      if (!report.pass) {
        // Surface the actual vs. expected so test output names the regression.
        expect({
          modeId: report.modeId,
          expected: report.expected,
          actual: report.actual,
        }).toEqual({
          modeId: report.modeId,
          expected: report.expected,
          actual: { code: report.expected.code, auditReason: report.expected.auditReason ?? report.expected.code },
        });
        return;
      }

      expect(report.actual.code).toBe(report.expected.code);
      expect(report.actual.auditReason ?? report.actual.code).toBe(report.expected.auditReason ?? report.expected.code);
      expect(report.pass).toBe(true);
    });
  }

  it("F1 also emits the credential-in-payload audit record (Rule 7)", () => {
    const manifest = externalAgentRuntimeFixture();
    const host = mockHostForInspector();
    const report = runAddOnFailureMode("F1", manifest, { host });

    expect(report.pass).toBe(true);
    const entry = host.audit.latestFor("F1");
    expect(entry).toBeDefined();
    expect(entry?.reason).toBe("credential-in-payload");
    expect(entry?.callerId).toBe(manifest.callerId);
  });

  it("F1 assembles its leaked token into a synthetic OpenAI-shaped value at runtime", () => {
    const token = syntheticLeakedBearerToken();
    // OpenAI-shaped: `sk-` prefix, hyphen-joined opaque body, long enough
    // that a committed copy would trip the credential scanner.
    expect(token).toMatch(/^sk-[a-z0-9-]+$/i);
    expect(token.length).toBeGreaterThanOrEqual(16);
    // The synthetic marker segment keeps the value obviously fake.
    expect(token.split("-")[1]).toBe("test");
  });

  it("F1 redacts the leaked token from audit and report output", () => {
    const manifest = externalAgentRuntimeFixture();
    const host = mockHostForInspector();
    const report = runAddOnFailureMode("F1", manifest, { host });

    expect(report.pass).toBe(true);
    expect(report.actual.code).toBe("credential-in-payload");

    const entry = host.audit.latestFor("F1");
    expect(entry).toBeDefined();
    // Only the forbidden header KEY is captured, never its value.
    expect(entry?.detail).toMatchObject({ forbiddenHeaderKeys: ["authorization"] });

    const token = syntheticLeakedBearerToken();
    const surfaces = [
      JSON.stringify(entry),
      JSON.stringify(report),
      entry?.reason ?? "",
      report.actual.code,
      report.actual.auditReason ?? "",
    ];
    for (const surface of surfaces) {
      expect(surface).not.toContain(token);
      expect(surface).not.toContain(`Bearer ${token}`);
    }
    expect(JSON.stringify(entry?.detail)).not.toMatch(/sk-[a-z0-9-]{14,}/i);
  });

  it("F1 host — not the driver — revokes the caller's routing decisions on exfiltration", () => {
    const manifest = externalAgentRuntimeFixture();
    const host = mockHostForInspector();
    const report = runAddOnFailureMode("F1", manifest, { host });

    expect(report.pass).toBe(true);
    // The host's deny record names the revoked decisions...
    const entry = host.audit.latestFor("F1");
    const revoked = entry?.detail?.["revokedRoutingDecisionIds"];
    expect(Array.isArray(revoked)).toBe(true);
    expect((revoked as string[]).length).toBeGreaterThan(0);
    // ...and every revoked id resolves as revoked in the captured store.
    for (const id of revoked as string[]) {
      const resolved = host.routing.resolve(id);
      expect("error" in resolved ? resolved.error : undefined).toBe("routing-decision-revoked");
    }
  });

  it("F3 denies workspace escape via `..` traversal, not only absolute paths", () => {
    const manifest = externalAgentRuntimeFixture();
    const host = mockHostForInspector();
    const report = runAddOnFailureMode("F3", manifest, { host });

    expect(report.pass).toBe(true);
    const entries = host.audit.snapshot().filter((e) => e.modeId === "F3");
    const paths = entries.map((e) => e.detail?.["requestedPath"]);
    expect(paths).toContain("/workspace/external-agent-task-001/../outside");
  });

  it("F3 also emits the workspace-escape audit record with the requested path", () => {
    const manifest = externalAgentRuntimeFixture();
    const host = mockHostForInspector();
    const report = runAddOnFailureMode("F3", manifest, { host });

    expect(report.pass).toBe(true);
    // The F3 driver now probes both an absolute outside path and a `..`
    // traversal; assert over every F3 record, not just the latest.
    const entries = host.audit.snapshot().filter((e) => e.modeId === "F3");
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.reason === "workspace-escape")).toBe(true);
    const paths = entries.map((e) => e.detail?.["requestedPath"]);
    expect(paths).toContain("/etc/passwd");
  });

  it("F8 expires the routing decision before the runtime uses it", () => {
    const manifest = externalAgentRuntimeFixture();
    const host = mockHostForInspector();
    const report = runAddOnFailureMode("F8", manifest, { host });

    expect(report.pass).toBe(true);
    const entry = host.audit.latestFor("F8");
    expect(entry).toBeDefined();
    expect(entry?.reason).toBe("routing-decision-expired");
  });

  it("F9 revokes the routing decision before the runtime uses it", () => {
    const manifest = externalAgentRuntimeFixture();
    const host = mockHostForInspector();
    const report = runAddOnFailureMode("F9", manifest, { host });

    expect(report.pass).toBe(true);
    const entry = host.audit.latestFor("F9");
    expect(entry).toBeDefined();
    expect(entry?.reason).toBe("routing-decision-revoked");
  });

  it("F7 records the approval-denied audit entry from the audit capture", () => {
    const manifest = externalAgentRuntimeFixture();
    const host = mockHostForInspector({ onApprovalPrompt: () => "denied" });
    const report = runAddOnFailureMode("F7", manifest, { host });

    expect(report.pass).toBe(true);
    const entry = host.audit.latestFor("F7");
    expect(entry).toBeDefined();
    expect(entry?.reason).toBe("approval-denied");
    expect(entry?.callerId).toBe(manifest.callerId);
  });

  it("F10 consults the manifest: experimental route denied without allowExperimentalAuth", () => {
    const manifest = externalAgentRuntimeFixture();
    // The fixture's providerRequirements.allowExperimentalAuth defaults to
    // false. The mock's experimental-route gate must consult it; removing
    // the gate here turns F10 red.
    const host = mockHostForInspector();
    const report = runAddOnFailureMode("F10", manifest, { host });

    expect(report.pass).toBe(true);
    const entry = host.audit.latestFor("F10");
    expect(entry).toBeDefined();
    expect(entry?.reason).toBe("experimental-route-not-declared");
    expect(entry?.detail?.["allowExperimentalAuth"]).toBe(false);
  });
});

import { mockHost, type MockHostOptions } from "../src/mock-host.ts";
function mockHostForInspector(options?: MockHostOptions) {
  return mockHost(options);
}
