// Intent citation: docs/architecture/ADR-026-minimal-kernel-replaceable-default-addons.md

import { describe, expect, it } from "vitest";
import type { AddOnManifest, CapabilityGrant, SystemSlotId } from "../../core/contracts";
import { buildDefaultState } from "../../core/defaults";
import { applyFirstRunRecommendedAddOns } from "./controller";
import { activeSystemSlotProvider, selectedSystemSlotProviderId, systemSlotAvailable } from "./system-slots";

const grant = (capability: CapabilityGrant["capability"]): CapabilityGrant => ({
  capability,
  granted: false,
  scope: "system",
  revocationBehavior: "hard-stop",
});

const manifestForSlot = (
  id: string,
  slotId: SystemSlotId,
  capability: CapabilityGrant["capability"],
): AddOnManifest => ({
  id,
  name: id === "addon.augmentor-chat" ? "Augmentor Chat" : "Living Archive",
  version: "0.1.0",
  author: "Resonant Alpha",
  category: slotId === "memory-system" ? "memory" : "agent",
  description: "Recommended replaceable default.",
  runtimeType: slotId === "memory-system" ? "local-service" : "ui-module",
  surfaces: [],
  requestedCapabilities: [grant(capability)],
  grantPresets: [
    {
      id: `${slotId}-recommended`,
      label: "Recommended",
      description: "Recommended first-run grants.",
      grants: [{ ...grant(capability), granted: true }],
    },
  ],
  providerRequirements: { sharedProfiles: [], supportsPrivateCredentials: false },
  systemSlots: [{ id: slotId, role: "default-provider", replaceable: true, recommended: true }],
  archiveIntegration: { readScopes: [], intakeWriteScopes: [], canRequestIngest: false, canWriteKnowledgePages: false },
  health: { strategy: "none" },
  installHooks: {},
  compatibility: { shellVersion: "^0.1.0", platforms: ["macOS", "linux", "windows"] },
});

describe("system slot replacement runtime", () => {
  it("keeps legacy no-slot fixtures available until they migrate to ADR-026 manifests", () => {
    const state = buildDefaultState([]);

    expect(systemSlotAvailable(state, [], "chat-interface")).toBe(true);
    expect(systemSlotAvailable(state, [], "memory-system")).toBe(true);
  });

  it("requires an enabled add-on and granted slot capability when a replacement slot exists", () => {
    const chatManifest = manifestForSlot("addon.augmentor-chat", "chat-interface", "chat-interface");
    const state = buildDefaultState([chatManifest]);

    expect(systemSlotAvailable(state, [chatManifest], "chat-interface")).toBe(false);

    const enabled = applyFirstRunRecommendedAddOns(state, [chatManifest], [chatManifest.id]);

    expect(systemSlotAvailable(enabled, [chatManifest], "chat-interface")).toBe(true);
    expect(activeSystemSlotProvider(enabled, [chatManifest], "chat-interface")?.manifest.id).toBe(chatManifest.id);
  });

  it("can enable recommended chat and memory defaults independently during first-run setup", () => {
    const chatManifest = manifestForSlot("addon.augmentor-chat", "chat-interface", "chat-interface");
    const memoryManifest = manifestForSlot("addon.living-archive", "memory-system", "memory-provider");
    const state = buildDefaultState([chatManifest, memoryManifest]);

    const next = applyFirstRunRecommendedAddOns(state, [chatManifest, memoryManifest], [memoryManifest.id]);

    expect(next.uiPreferences.recommendedAddOnsReviewed).toBe(true);
    expect(systemSlotAvailable(next, [chatManifest, memoryManifest], "chat-interface")).toBe(false);
    expect(systemSlotAvailable(next, [chatManifest, memoryManifest], "memory-system")).toBe(true);
  });

  it("does not select an enabled add-on whose slot capability grant is missing, not granted, or the wrong capability (#349)", () => {
    const chatManifest = manifestForSlot("addon.augmentor-chat", "chat-interface", "chat-interface");
    const memoryManifest = manifestForSlot("addon.living-archive", "memory-system", "memory-provider");
    const manifests = [chatManifest, memoryManifest];
    const base = buildDefaultState(manifests);
    const enabledWithGrants = (grants: Record<string, CapabilityGrant[]>) => ({
      ...base,
      installations: Object.fromEntries(
        Object.entries(base.installations).map(([id, installation]) => [
          id,
          { ...installation, installed: true, enabled: true, grantedCapabilities: grants[id] ?? [] },
        ]),
      ),
    });

    // Enabled, but the slot capability is present-and-denied (chat) or absent entirely (memory).
    const ungranted = enabledWithGrants({
      [chatManifest.id]: [grant("chat-interface")],
      [memoryManifest.id]: [],
    });
    expect(activeSystemSlotProvider(ungranted, manifests, "chat-interface")).toBeNull();
    expect(activeSystemSlotProvider(ungranted, manifests, "memory-system")).toBeNull();
    expect(systemSlotAvailable(ungranted, manifests, "chat-interface")).toBe(false);
    expect(systemSlotAvailable(ungranted, manifests, "memory-system")).toBe(false);

    // Enabled with SOME granted capability, just not the one the slot requires.
    const wrongCapability = enabledWithGrants({
      [chatManifest.id]: [{ ...grant("notifications"), granted: true }],
      [memoryManifest.id]: [{ ...grant("chat-interface"), granted: true }],
    });
    expect(activeSystemSlotProvider(wrongCapability, manifests, "chat-interface")).toBeNull();
    expect(activeSystemSlotProvider(wrongCapability, manifests, "memory-system")).toBeNull();

    // The same enabled installations become providers once the backing grant is actually granted.
    const granted = enabledWithGrants({
      [chatManifest.id]: [{ ...grant("chat-interface"), granted: true }],
      [memoryManifest.id]: [{ ...grant("memory-provider"), granted: true }],
    });
    expect(activeSystemSlotProvider(granted, manifests, "chat-interface")?.manifest.id).toBe(chatManifest.id);
    expect(activeSystemSlotProvider(granted, manifests, "memory-system")?.manifest.id).toBe(memoryManifest.id);
    expect(systemSlotAvailable(granted, manifests, "chat-interface")).toBe(true);
    expect(systemSlotAvailable(granted, manifests, "memory-system")).toBe(true);
  });

  it("activeSystemSlotProvider prefers the selected provider when it is enabled and granted", () => {
    const first = manifestForSlot("addon.first", "memory-system", "memory-provider");
    const selected = manifestForSlot("addon.selected", "memory-system", "memory-provider");
    const state = {
      ...buildDefaultState([first, selected]),
      activeSystemSlotProviderIds: { "memory-system": selected.id },
      installations: {
        [first.id]: {
          ...buildDefaultState([first]).installations[first.id],
          installed: true,
          enabled: true,
          grantedCapabilities: [{ ...grant("memory-provider"), granted: true }],
        },
        [selected.id]: {
          ...buildDefaultState([selected]).installations[selected.id],
          installed: true,
          enabled: true,
          grantedCapabilities: [{ ...grant("memory-provider"), granted: true }],
        },
      },
    };

    expect(selectedSystemSlotProviderId(state, "memory-system")).toBe(selected.id);
    expect(activeSystemSlotProvider(state, [first, selected], "memory-system")?.manifest.id).toBe(selected.id);
  });

  it("falls back to the first eligible provider when the selection is disabled or ungranted", () => {
    const first = manifestForSlot("addon.first", "chat-interface", "chat-interface");
    const disabled = manifestForSlot("addon.disabled", "chat-interface", "chat-interface");
    const ungranted = manifestForSlot("addon.ungranted", "chat-interface", "chat-interface");
    const base = buildDefaultState([first, disabled, ungranted]);
    const eligibleInstallation = {
      ...base.installations[first.id],
      installed: true,
      enabled: true,
      grantedCapabilities: [{ ...grant("chat-interface"), granted: true }],
    };

    expect(
      activeSystemSlotProvider(
        {
          ...base,
          activeSystemSlotProviderIds: { "chat-interface": disabled.id },
          installations: {
            ...base.installations,
            [first.id]: eligibleInstallation,
            [disabled.id]: {
              ...base.installations[disabled.id],
              installed: true,
              enabled: false,
              grantedCapabilities: [{ ...grant("chat-interface"), granted: true }],
            },
          },
        },
        [first, disabled, ungranted],
        "chat-interface",
      )?.manifest.id,
    ).toBe(first.id);

    expect(
      activeSystemSlotProvider(
        {
          ...base,
          activeSystemSlotProviderIds: { "chat-interface": ungranted.id },
          installations: {
            ...base.installations,
            [first.id]: eligibleInstallation,
            [ungranted.id]: {
              ...base.installations[ungranted.id],
              installed: true,
              enabled: true,
              grantedCapabilities: [{ ...grant("chat-interface"), granted: false }],
            },
          },
        },
        [first, disabled, ungranted],
        "chat-interface",
      )?.manifest.id,
    ).toBe(first.id);
  });

  it("ignores a selection naming a manifest that does not declare the slot", () => {
    const first = manifestForSlot("addon.first", "memory-system", "memory-provider");
    const selected = manifestForSlot("addon.selected-chat", "chat-interface", "chat-interface");
    const base = buildDefaultState([first, selected]);
    const state = {
      ...base,
      activeSystemSlotProviderIds: { "memory-system": selected.id },
      installations: {
        ...base.installations,
        [first.id]: {
          ...base.installations[first.id],
          installed: true,
          enabled: true,
          grantedCapabilities: [{ ...grant("memory-provider"), granted: true }],
        },
        [selected.id]: {
          ...base.installations[selected.id],
          installed: true,
          enabled: true,
          grantedCapabilities: [{ ...grant("chat-interface"), granted: true }],
        },
      },
    };

    expect(activeSystemSlotProvider(state, [first, selected], "memory-system")?.manifest.id).toBe(first.id);
  });
});
