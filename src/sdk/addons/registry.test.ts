// Intent citation: docs/architecture/ADR-023-addon-repository-registry-model.md

import { describe, expect, it } from "vitest";
import type { AddOnInstallation, AddOnManifest } from "../../core/contracts";
import { createDefaultInstallation } from "../../core/defaults";
import { createAddOnRegistryEntry, createAddOnRegistrySnapshot } from "./registry";

const manifest = (id: string, overrides: Partial<AddOnManifest> = {}): AddOnManifest => ({
  id,
  name: id,
  version: "0.1.0",
  author: "test",
  category: "integration",
  description: "test add-on",
  runtimeType: "local-service",
  surfaces: [],
  requestedCapabilities: [{ capability: "network", granted: false, scope: "shared", revocationBehavior: "hard-stop" }],
  providerRequirements: {
    sharedProfiles: [],
    supportsPrivateCredentials: false,
  },
  archiveIntegration: {
    readScopes: [],
    intakeWriteScopes: [],
    canRequestIngest: false,
    canWriteKnowledgePages: false,
  },
  health: {
    strategy: "none",
  },
  installHooks: {},
  compatibility: {
    shellVersion: "^0.1.0",
    platforms: ["macOS", "Windows", "Linux"],
  },
  ...overrides,
});

describe("add-on registry snapshot", () => {
  it("keeps bundled catalog entries separate from installed add-ons", () => {
    const addon = manifest("addon.obsidian", {
      // P1-e: this manifest carries no provenance, so it must NOT be trusted by
      // omission. It resolves to dev/internal/unreviewed instead of curated-signed.
      grantPresets: [
        {
          id: "obsidian-basic",
          label: "Obsidian basic",
          description: "Recommended vault read access.",
          grants: [],
        },
      ],
    });
    const entry = createAddOnRegistryEntry(addon, {
      registrySource: "bundled-catalog",
      installation: createDefaultInstallation(addon, "bundled"),
    });

    expect(entry.registrySource).toBe("bundled-catalog");
    expect(entry.provenanceTier).toBe("sideloaded-unverified");
    expect(entry.verificationState).toBe("unverified");
    expect(entry.installState).toBe("available");
    expect(entry.installed).toBe(false);
    expect(entry.enabled).toBe(false);
    expect(entry.recommendedGrantPresetIds).toContain("obsidian-basic");
  });

  it("marks a bundled manifest with NO provenance as dev/internal/unreviewed (P1-e, no trust by omission)", () => {
    const addon = manifest("addon.no-provenance");
    const entry = createAddOnRegistryEntry(addon, { registrySource: "bundled-catalog" });

    expect(entry.provenanceTier).toBe("sideloaded-unverified");
    expect(entry.verificationState).toBe("unverified");
    expect(entry.reviewState).toBe("unreviewed");
  });

  it("keeps a signed bundled manifest verified (P1-e)", () => {
    const addon = manifest("addon.signed", {
      provenance: {
        tier: "curated-signed",
        verificationState: "verified",
        signed: true,
        signer: "ResonantOS bundled catalog",
      },
    });
    const entry = createAddOnRegistryEntry(addon, { registrySource: "bundled-catalog" });

    expect(entry.provenanceTier).toBe("curated-signed");
    expect(entry.verificationState).toBe("verified");
    expect(entry.reviewState).toBe("reviewed");
  });

  it("marks sideloaded add-ons as untrusted registry entries by default", () => {
    const sideloaded = manifest("addon.test-lab", {
      provenance: {
        tier: "curated-signed",
        verificationState: "verified",
        signed: true,
        signer: "test",
      },
    });
    const entry = createAddOnRegistryEntry(sideloaded, {
      registrySource: "sideloaded-local",
      installation: createDefaultInstallation(sideloaded, "sideload"),
    });

    expect(entry.provenanceTier).toBe("sideloaded-unverified");
    expect(entry.verificationState).toBe("unverified");
    expect(entry.reviewState).toBe("unreviewed");
    expect(entry.installed).toBe(false);
  });

  it("derives enabled state only from the host-owned installation record", () => {
    const bundled = manifest("addon.browser");
    const installation: AddOnInstallation = {
      ...createDefaultInstallation(bundled, "bundled"),
      installed: true,
      enabled: true,
      status: "enabled",
    };

    const snapshot = createAddOnRegistrySnapshot({
      bundled: [bundled],
      sideloaded: [manifest("addon.local-tool")],
      installations: {
        [bundled.id]: installation,
      },
    });

    expect(snapshot.byId["addon.browser"].enabled).toBe(true);
    expect(snapshot.byId["addon.browser"].installState).toBe("enabled");
    expect(snapshot.byId["addon.local-tool"].registrySource).toBe("sideloaded-local");
    expect(snapshot.byId["addon.local-tool"].enabled).toBe(false);
  });
});
