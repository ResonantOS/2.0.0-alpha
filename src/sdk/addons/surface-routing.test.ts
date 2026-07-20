// Intent citation: docs/architecture/ADR-018-addon-sdk-v0.md

import { describe, expect, it } from "vitest";
import type { AddOnInstallation, AddOnManifest, CapabilityGrant } from "../../core/contracts";
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

describe("add-on surface dock routing", () => {
  it("creates a dock route from an enabled manifest-declared shell surface", () => {
    const addon = manifest();

    const routes = createAddOnSurfaceDockRoutes([addon], {
      [addon.id]: installed(addon, [grant("filesystem", true), grant("archive-read", true)]),
    });

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

  it("hides manifest-declared dock routes until required grants are present", () => {
    const addon = manifest();

    const routes = createAddOnSurfaceDockRoutes([addon], {
      [addon.id]: installed(addon, [grant("filesystem", true), grant("archive-read", false)]),
    });

    expect(routes).toEqual([]);
  });
});
