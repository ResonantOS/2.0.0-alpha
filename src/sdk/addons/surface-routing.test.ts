// Intent citation: docs/architecture/ADR-018-addon-sdk-v0.md

import { describe, expect, it } from "vitest";
import type { AddOnInstallation, AddOnManifest, CapabilityGrant } from "../../core/contracts";
import { createHarnessClient, type HarnessProjection } from "../../core/harness-client";
import { createDefaultInstallation } from "../../core/defaults";
import { createAddOnSurfaceDockRoutes } from "./surface-routing";

const grant = (capability: CapabilityGrant["capability"], granted = false): CapabilityGrant => ({
  capability,
  granted,
  scope: "shared",
  revocationBehavior: "hard-stop",
});

const manifest = (): AddOnManifest => ({
  id: "addon.custom-tool",
  name: "Custom Tool",
  version: "0.1.0",
  author: "test",
  category: "tool",
  description: "test add-on",
  runtimeType: "local-service",
  surfaces: [
    {
      id: "custom-tool-page",
      type: "page",
      label: "Custom Tool",
      description: "Custom tool workspace.",
      shellNavigation: {
        sectionId: "custom-tool",
        dockIcon: "custom-tool",
        eyebrow: "Tool",
        order: 70,
        requiredCapabilities: ["filesystem", "archive-read"],
      },
    },
  ],
  requestedCapabilities: [grant("filesystem"), grant("archive-read")],
  providerRequirements: { sharedProfiles: [], supportsPrivateCredentials: false },
  archiveIntegration: { readScopes: [], intakeWriteScopes: [], canRequestIngest: false, canWriteKnowledgePages: false },
  health: { strategy: "none" },
  installHooks: {},
  compatibility: { shellVersion: "^0.1.0", platforms: ["macOS"] },
});

const installed = (addon: AddOnManifest, grants: CapabilityGrant[]): AddOnInstallation => ({
  ...createDefaultInstallation(addon, "bundled"),
  installed: true,
  enabled: true,
  status: "enabled",
  grantedCapabilities: grants,
});

const projected = (addon: AddOnManifest, hiddenSurfaceIds: string[] = []): HarnessProjection => {
  const client = createHarnessClient();
  client.applySnapshot({ bootEpoch: "surfaces", revision: 1, governanceActivated: true,
    candidates: [addon], installations: { [addon.id]: {
      addonId: addon.id, installed: true, enabled: true,
      grantedCapabilities: addon.requestedCapabilities.map(grant => ({ ...grant, granted: true })),
      disabledOperations: [], hiddenSurfaceIds,
    } }, slots: {} });
  return client.getSnapshot()!;
};

describe("add-on surface dock routing", () => {
  it("creates a dock route from an enabled manifest-declared shell surface", () => {
    const addon = manifest();

    const routes = createAddOnSurfaceDockRoutes([addon], {
      [addon.id]: installed(addon, [grant("filesystem", true), grant("archive-read", true)]),
    }, projected(addon));

    expect(routes).toEqual([
      {
        addonId: "addon.custom-tool",
        surfaceId: "custom-tool-page",
        sectionId: "custom-tool",
        label: "Custom Tool",
        eyebrow: "Tool",
        dockIcon: "custom-tool",
        order: 70,
      },
    ]);
  });

  it("surfaces and labels agree with projected governance despite forged local state", () => {
    const addon = { ...manifest(), systemSlots: [{ id: "memory-system" as const, role: "default-provider" as const, replaceable: true }] };
    const local = { [addon.id]: installed(addon, [grant("filesystem", true), grant("archive-read", true)]) };
    const projection = projected(addon);
    const owned = { ...projection, slots: { "memory-system": { addonId: addon.id, generation: 1, available: true } } };
    expect(createAddOnSurfaceDockRoutes([addon], local, owned)).toHaveLength(1);
    expect(createAddOnSurfaceDockRoutes([addon], local, {
      ...owned, installations: { [addon.id]: { ...owned.installations[addon.id], hiddenSurfaceIds: [addon.surfaces[0].id] } },
    })).toEqual([]);
    expect(createAddOnSurfaceDockRoutes([addon], local, projection)).toEqual([]);
    expect(createAddOnSurfaceDockRoutes([addon], local, null)).toEqual([]);
  });

  it("hides manifest-declared dock routes until required grants are present", () => {
    const addon = manifest();

    const routes = createAddOnSurfaceDockRoutes([addon], {
      [addon.id]: installed(addon, [grant("filesystem", true), grant("archive-read", false)]),
    }, { ...projected(addon), installations: { [addon.id]: {
      ...projected(addon).installations[addon.id], grantedCapabilities: [grant("filesystem", true), grant("archive-read", false)],
    } } });

    expect(routes).toEqual([]);
  });

  it("routes host-only candidates with projected labels and ignores stale local installation fields", () => {
    const addon = manifest();
    const projection = projected(addon);
    expect(createAddOnSurfaceDockRoutes([], {}, projection)).toHaveLength(1);
    const stale = { ...addon, name: "Stale name", surfaces: [{ ...addon.surfaces[0], label: "Stale label" }] };
    expect(createAddOnSurfaceDockRoutes([stale], {}, projection)[0].label).toBe("Custom Tool");
    for (const denied of [{ installed: false }, { enabled: false }, { hiddenSurfaceIds: [addon.surfaces[0].id] }]) {
      expect(createAddOnSurfaceDockRoutes([addon], { [addon.id]: installed(addon, [grant("filesystem", true), grant("archive-read", true)]) }, {
        ...projection, installations: { [addon.id]: { ...projection.installations[addon.id], ...denied } },
      })).toEqual([]);
    }
  });
});
