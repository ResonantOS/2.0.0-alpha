// Intent citation: docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md#3-boundary-rules
// Intent citation: docs/architecture/ADR-038-resonant-extension-framework.md#7-runtime-boundary
//
// Fixture contract: validates that the synthetic external-agent-runtime
// manifest the testing package depends on is shape-compatible with the
// SDK's `validateAddOnManifest`. If the SDK's contract changes, this
// test fails immediately so the F-cases don't drift.

import { describe, expect, it } from "vitest";
import {
  externalAgentRuntimeFixture,
  declaredToolNames,
  withGranted,
} from "../src/manifest-fixtures.ts";
import { validateAddOnManifest } from "../../../src/sdk/addons/validation.ts";
import type { ExternalAgentRuntimeManifest } from "../src/manifest-fixtures.ts";

describe("externalAgentRuntimeFixture contract", () => {
  it("validates against the SDK's `validateAddOnManifest`", () => {
    const manifest = externalAgentRuntimeFixture();
    const result = validateAddOnManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.issues.length).toBe(0);
  });

  it("declares the ADR-040 §3 conjunction: providers + agent-delegation", () => {
    const manifest = externalAgentRuntimeFixture();
    const caps = manifest.requestedCapabilities.map((g) => g.capability);
    expect(caps).toContain("providers");
    expect(caps).toContain("agent-delegation");
  });

  it("declares run_task with requiresHumanApproval: true (ADR-040 §3 Rule 8)", () => {
    const manifest = externalAgentRuntimeFixture();
    const runTask = manifest.tools?.find((t) => t.name === "run_task");
    expect(runTask).toBeDefined();
    expect(runTask?.requiresHumanApproval).toBe(true);
  });

  it("declares providerRequirements.allowExperimentalAuth: false (F10 trigger)", () => {
    const manifest = externalAgentRuntimeFixture();
    expect(manifest.providerRequirements.allowExperimentalAuth).toBe(false);
  });

  it("matches what declaredToolNames reports", () => {
    const manifest: ExternalAgentRuntimeManifest = externalAgentRuntimeFixture();
    expect(declaredToolNames(manifest)).toEqual([
      "send_model_request",
      "run_task",
    ]);
  });

  it("withGranted produces a manifest that still validates against the SDK", () => {
    const manifest = externalAgentRuntimeFixture();
    const flipped = withGranted(manifest, "network");
    expect(flipped.requestedCapabilities.find((g) => g.capability === "network")?.granted).toBe(true);
    const result = validateAddOnManifest(flipped);
    expect(result.valid).toBe(true);
  });

  it("ID is stable: 'addon.testing.external-agent-runtime'", () => {
    expect(externalAgentRuntimeFixture().id).toBe("addon.testing.external-agent-runtime");
  });

  it("runtimeType is 'local-service' (ADR-040 §9 reference shape)", () => {
    expect(externalAgentRuntimeFixture().runtimeType).toBe("local-service");
  });
});
