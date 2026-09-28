import { describe, expect, it } from "vitest";
import type { AddOnManifest, CapabilityGrant, SystemSlotId } from "./contracts";
import { buildDefaultState, selectRecommendedDefaultSystemSlotProviderIds } from "./defaults";

const capability = (name: CapabilityGrant["capability"]): CapabilityGrant => ({
  capability: name,
  granted: false,
  scope: "shared",
  revocationBehavior: "hard-stop",
});

const manifestForSlot = (
  id: string,
  slotId: SystemSlotId,
  role: NonNullable<AddOnManifest["systemSlots"]>[number]["role"],
  recommended: boolean,
): AddOnManifest => ({
  id,
  name: id,
  version: "0.1.0",
  author: "test",
  category: "agent",
  description: "test",
  runtimeType: "ui-module",
  surfaces: [],
  requestedCapabilities: [capability("agent-delegation")],
  providerRequirements: { sharedProfiles: [], supportsPrivateCredentials: false },
  systemSlots: [{ id: slotId, role, replaceable: true, recommended }],
  archiveIntegration: { readScopes: [], intakeWriteScopes: [], canRequestIngest: false, canWriteKnowledgePages: false },
  health: { strategy: "none" },
  installHooks: {},
  compatibility: { shellVersion: "^0.1.0", platforms: ["macOS"] },
});

describe("buildDefaultState", () => {
  it("keeps recommended default providers as suggestions without consent or owners", () => {
    const first = manifestForSlot("addon.first", "primary-agent", "default-provider", true);
    const second = manifestForSlot("addon.second", "primary-agent", "default-provider", true);
    const notRecommended = manifestForSlot("addon.not-recommended", "chat-interface", "default-provider", false);
    const alternative = manifestForSlot("addon.alternative", "memory-system", "alternative-provider", true);

    const state = buildDefaultState([first, second, notRecommended, alternative]);

    expect(selectRecommendedDefaultSystemSlotProviderIds([first, second, notRecommended, alternative]))
      .toEqual({ "primary-agent": "addon.first" });
    expect(state.activeSystemSlotProviderIds).toEqual({});
    expect(Object.values(state.installations).every(item => !item.installed && !item.enabled &&
      item.grantedCapabilities.every(grant => !grant.granted))).toBe(true);
  });
});
