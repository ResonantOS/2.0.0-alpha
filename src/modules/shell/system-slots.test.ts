// Intent citation: docs/architecture/ADR-026-minimal-kernel-replaceable-default-addons.md

import { describe, expect, it } from "vitest";
import type { AddOnManifest, CapabilityGrant, HarnessRegistryProjection, SystemSlotId } from "../../core/contracts";
import { buildDefaultState } from "../../core/defaults";
import { activeSystemSlotProvider, capabilityForSlot, selectedSystemSlotProviderId, systemSlotAvailable } from "./system-slots";

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

// Forged legacy records must never become host governance.
const legacyGrantedState = (manifest: AddOnManifest) => {
  const state = buildDefaultState([manifest]);
  state.installations[manifest.id] = { ...state.installations[manifest.id], installed: true, enabled: true,
    grantedCapabilities: manifest.requestedCapabilities.map(g => ({ ...g, granted: true })) };
  return state;
};

const acknowledgedSelection = (manifest: AddOnManifest): HarnessRegistryProjection => ({
  bootEpoch: "first-run", revision: 3, governanceActivated: false, candidates: [manifest],
  installations: { [manifest.id]: { addonId: manifest.id, installed: true, enabled: true,
    grantedCapabilities: manifest.requestedCapabilities.map(g => ({ ...g, granted: true })), disabledOperations: [], hiddenSurfaceIds: [] } },
  slots: Object.fromEntries(manifest.systemSlots!.map(slot => [slot.id, { addonId: manifest.id, generation: 1, available: true }])),
});

describe("system slot replacement runtime", () => {
  it("primary capability mapping remains runtime rather than delegation consent", () => {
    expect(capabilityForSlot("primary-agent")).toBe("agent-runtime");
  });

  it.each([
    ["primary-agent", "agent-runtime"], ["chat-interface", "chat-interface"],
    ["memory-system", "memory-provider"], ["communication-channel", "notifications"],
  ] as const)("all vacant slots remain unavailable regardless of catalog order: %s", (slot, capability) => {
    const first = manifestForSlot("addon.first", slot, capability);
    const second = manifestForSlot("addon.second", slot, capability);
    const state = legacyGrantedState(first);
    state.installations[second.id] = legacyGrantedState(second).installations[second.id];
    state.activeSystemSlotProviderIds = { [slot]: second.id };
    const acknowledged = acknowledgedSelection(second);
    expect(selectedSystemSlotProviderId(state, slot, acknowledged)).toBe(second.id);
    expect(activeSystemSlotProvider(state, [first, second], slot, acknowledged)?.manifest.id).toBe(second.id);
    expect(systemSlotAvailable(state, [], slot, acknowledged)).toBe(true);
    const noSlot = { ...first, systemSlots: undefined };
    for (const catalog of [[first, second], [second, first], [noSlot], []]) {
      for (const projection of [undefined, null, projectionFor({}),
        projectionFor({ [slot]: { addonId: null, available: false, generation: 1 } })]) {
        expect(selectedSystemSlotProviderId(state, slot, projection)).toBeUndefined();
        expect(activeSystemSlotProvider(state, catalog, slot, projection)).toBeNull();
        expect(systemSlotAvailable(state, catalog, slot, projection)).toBe(false);
      }
    }
  });

  it.each(["primary-agent", "chat-interface", "memory-system", "communication-channel"] as const)(
    "no-manifest fixtures leave %s unavailable without host acknowledgement", slot => {
      expect(systemSlotAvailable(buildDefaultState([]), [], slot)).toBe(false);
    },
  );

  it("requires host acknowledgement even for locally enabled and granted recommended defaults", () => {
    const chat = manifestForSlot("addon.augmentor-chat", "chat-interface", "chat-interface");
    const memory = manifestForSlot("addon.living-archive", "memory-system", "memory-provider");
    const state = legacyGrantedState(chat);
    const projection = acknowledgedSelection(memory);
    expect(systemSlotAvailable(state, [chat, memory], "chat-interface", projection)).toBe(false);
    expect(systemSlotAvailable(state, [chat, memory], "memory-system", projection)).toBe(true);
    expect(activeSystemSlotProvider(state, [chat, memory], "memory-system", projection)?.manifest.id).toBe(memory.id);
  });
});

const projectionFor = (slots: HarnessRegistryProjection["slots"]): HarnessRegistryProjection => ({
  bootEpoch: "boot-1", revision: 4, governanceActivated: true, candidates: [], installations: {}, slots,
});

describe("host-managed system slots", () => {
  it.each([
    { addonId: null, available: false, generation: 1 },
    { addonId: "addon.local", available: false, generation: 2 },
  ])("managed vacancy overrides eligible local defaults: %j", (slot) => {
    const manifest = manifestForSlot("addon.local", "chat-interface", "chat-interface");
    const state = legacyGrantedState(manifest);
    const projection = projectionFor({ "chat-interface": slot });
    expect(activeSystemSlotProvider(state, [manifest], "chat-interface", projection)).toBeNull();
    expect(systemSlotAvailable(state, [manifest], "chat-interface", projection)).toBe(false);
    expect(systemSlotAvailable(state, [], "chat-interface", projection)).toBe(false);
    expect(systemSlotAvailable(state, [manifest], "memory-system", projection)).toBe(false);
    expect(activeSystemSlotProvider(state, [manifest], "chat-interface", projectionFor({}))).toBeNull();
  });

  it("requires host-owner metadata and installation before reporting a usable provider", () => {
    const host = manifestForSlot("addon.host", "primary-agent", "agent-runtime");
    const local = manifestForSlot("addon.local", "primary-agent", "agent-runtime");
    const state = legacyGrantedState(local);
    const projection = { ...projectionFor({ "primary-agent": { addonId: host.id, generation: 2, available: true } }),
      installations: { [host.id]: { addonId: host.id, installed: true, enabled: true,
        grantedCapabilities: [], disabledOperations: [], hiddenSurfaceIds: [] } } };
    expect(selectedSystemSlotProviderId(state, "primary-agent", projection)).toBe(host.id);
    expect(activeSystemSlotProvider(state, [local], "primary-agent", projection)).toBeNull();
    expect(systemSlotAvailable(state, [local], "primary-agent", projection)).toBe(false);
    expect(systemSlotAvailable(state, [local], "primary-agent", { ...projection, candidates: [host] })).toBe(true);
    expect(systemSlotAvailable(state, [host], "primary-agent", projection)).toBe(true);
    expect(systemSlotAvailable(state, [host], "primary-agent", { ...projection, installations: {} })).toBe(false);
  });

  it("uses only the projected owner and installation despite stale local grants or selection", () => {
    const local = manifestForSlot("addon.local", "primary-agent", "agent-runtime");
    const host = manifestForSlot("addon.host", "primary-agent", "agent-runtime");
    const state = legacyGrantedState(local);
    const installation = { addonId: host.id, installed: true, enabled: true,
      grantedCapabilities: [{ ...grant("agent-runtime"), granted: true }], disabledOperations: [], hiddenSurfaceIds: [] };
    const projection = { ...projectionFor({ "primary-agent": { addonId: host.id, generation: 4, available: true } }),
      candidates: [host], installations: { [host.id]: installation } };
    expect(selectedSystemSlotProviderId(state, "primary-agent", projection)).toBe(host.id);
    expect(activeSystemSlotProvider(state, [local], "primary-agent", projection)).toEqual({ manifest: host, installation });
    expect(systemSlotAvailable(state, [], "primary-agent", projection)).toBe(true);
    expect(selectedSystemSlotProviderId(state, "primary-agent", projectionFor({ "primary-agent": { addonId: null, generation: 5, available: false } }))).toBeUndefined();
  });
});
