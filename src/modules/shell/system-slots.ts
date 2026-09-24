// Intent citation: docs/architecture/ADR-026-minimal-kernel-replaceable-default-addons.md

import type {
  AddOnInstallation,
  AddOnManifest,
  CapabilityGrant,
  HarnessRegistryProjection,
  ResonantShellState,
  SystemSlotId,
} from "../../core/contracts";

export type SystemSlotProvider = {
  manifest: AddOnManifest;
  installation: AddOnInstallation | HarnessRegistryProjection["installations"][string];
};

export const manifestsForSystemSlot = (manifests: AddOnManifest[], slotId: SystemSlotId): AddOnManifest[] =>
  manifests.filter((manifest) => manifest.systemSlots?.some((slot) => slot.id === slotId));

export const hasSystemSlotManifest = (manifests: AddOnManifest[], slotId: SystemSlotId): boolean =>
  manifestsForSystemSlot(manifests, slotId).length > 0;

export const recommendedSystemSlotManifests = (manifests: AddOnManifest[]): AddOnManifest[] =>
  manifests.filter((manifest) => manifest.systemSlots?.some((slot) => slot.recommended));

// Every SystemSlotId maps to a backing capability so a manifest cannot seize a
// slot (and become its active provider) without requesting — and the user
// granting — that capability. Previously primary-agent and communication-channel
// returned null, leaving those slots with NO capability gate (P1-b bypass).
export const capabilityForSlot = (slotId: SystemSlotId): CapabilityGrant["capability"] => {
  switch (slotId) {
    case "chat-interface":
      return "chat-interface";
    case "memory-system":
      return "memory-provider";
    case "primary-agent":
      return "agent-runtime";
    case "communication-channel":
      return "notifications";
  }
};

export const selectedSystemSlotProviderId = (
  _state: ResonantShellState, slotId: SystemSlotId, projection?: HarnessRegistryProjection | null,
): string | undefined => projection?.slots[slotId]?.addonId ?? undefined;

export const activeSystemSlotProvider = (
  _state: ResonantShellState,
  manifests: AddOnManifest[],
  slotId: SystemSlotId,
  projection?: HarnessRegistryProjection | null,
): SystemSlotProvider | null => {
  const slot = projection?.slots[slotId];
  if (!projection || !slot?.available || !slot.addonId) return null;
  // Catalog metadata may describe the host-selected identity; it cannot choose
  // another owner or contribute any installation/grant state.
  const manifest = projection.candidates.find(item => item.id === slot.addonId)
    ?? manifests.find(item => item.id === slot.addonId);
  const installation = projection.installations[slot.addonId];
  return manifest && installation ? { manifest, installation } : null;
};

export const systemSlotAvailable = (
  state: ResonantShellState,
  manifests: AddOnManifest[],
  slotId: SystemSlotId,
  projection?: HarnessRegistryProjection | null,
): boolean => Boolean(activeSystemSlotProvider(state, manifests, slotId, projection));

export const recommendedGrantCapabilities = (manifest: AddOnManifest): CapabilityGrant["capability"][] => {
  const presetGrants = manifest.grantPresets?.flatMap((preset) => preset.grants.map((grant) => grant.capability)) ?? [];
  return Array.from(new Set(presetGrants.length ? presetGrants : manifest.requestedCapabilities.map((grant) => grant.capability)));
};
