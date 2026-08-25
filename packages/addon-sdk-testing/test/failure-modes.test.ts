// Intent citation: docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md#7-failure-modes
//
// Vitest suite for ADR-040 §7 failure modes F1–F10. One case per
// F-number; each case invokes `runAddOnFailureMode(modeId, manifest)`
// against the synthetic external-agent-runtime fixture and asserts
// the resulting `FailureModeReport.pass` is true.
//
// The expected deny codes and audit reasons are sourced verbatim from
// the ADR-040 §7 `Expected:` clauses; see
// `packages/addon-sdk-testing/src/failure-modes/index.ts` (`expectedFor`)
// for the canonical copy.

import { describe, expect, it } from "vitest";
import {
  runAddOnFailureMode,
  externalAgentRuntimeFixture,
  type FailureModeId,
} from "../src/index.ts";

const ALL_MODES: readonly FailureModeId[] = ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10"];

describe("ADR-040 §7 failure modes", () => {
  for (const modeId of ALL_MODES) {
    it(`${modeId} — host denies with the ADR-040 §7 Expected: clause`, () => {
      const manifest = externalAgentRuntimeFixture();
      const report = runAddOnFailureMode(modeId, manifest);

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

  it("F3 also emits the workspace-escape audit record with the requested path", () => {
    const manifest = externalAgentRuntimeFixture();
    const host = mockHostForInspector();
    const report = runAddOnFailureMode("F3", manifest, { host });

    expect(report.pass).toBe(true);
    const entry = host.audit.latestFor("F3");
    expect(entry).toBeDefined();
    expect(entry?.reason).toBe("workspace-escape");
    expect(entry?.detail).toMatchObject({ requestedPath: "/etc/passwd" });
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
});

import { mockHost } from "../src/mock-host.ts";
function mockHostForInspector() {
  return mockHost();
}
