// Intent citation: docs/architecture/ADR-026-minimal-kernel-replaceable-default-addons.md

import type {
  AddOnInstallation,
  AddOnManifest,
  CapabilityGrant,
  ResonantShellState,
  SystemSlotId,
} from "../../core/contracts";

export type SystemSlotProvider = {
  manifest: AddOnManifest;
  installation: AddOnInstallation;
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
      return "agent-delegation";
    case "communication-channel":
      return "notifications";
  }
};

export const selectedSystemSlotProviderId = (state: ResonantShellState, slotId: SystemSlotId): string | undefined =>
  state.activeSystemSlotProviderIds?.[slotId];

const eligibleSystemSlotProvider = (
  state: ResonantShellState,
  manifest: AddOnManifest,
  slotId: SystemSlotId,
): SystemSlotProvider | null => {
  if (!manifest.systemSlots?.some((slot) => slot.id === slotId)) {
    return null;
  }
  const installation = state.installations[manifest.id];
  if (!installation?.enabled) {
    return null;
  }
  const requiredCapability = capabilityForSlot(slotId);
  if (!installation.grantedCapabilities.some((grant) => grant.capability === requiredCapability && grant.granted)) {
    return null;
  }
  return { manifest, installation };
};

export const activeSystemSlotProvider = (
  state: ResonantShellState,
  manifests: AddOnManifest[],
  slotId: SystemSlotId,
): SystemSlotProvider | null => {
  const selectedManifestId = selectedSystemSlotProviderId(state, slotId);
  const selectedManifest = selectedManifestId ? manifests.find((manifest) => manifest.id === selectedManifestId) : undefined;
  if (selectedManifest) {
    const selectedProvider = eligibleSystemSlotProvider(state, selectedManifest, slotId);
    if (selectedProvider) {
      return selectedProvider;
    }
  }

  for (const manifest of manifestsForSystemSlot(manifests, slotId)) {
    const provider = eligibleSystemSlotProvider(state, manifest, slotId);
    if (provider) {
      return provider;
    }
  }

  return null;
};

export const systemSlotAvailable = (
  state: ResonantShellState,
  manifests: AddOnManifest[],
  slotId: SystemSlotId,
): boolean => {
  // Legacy/test manifest sets predate ADR-026 and do not declare replacement slots.
  // In that case the old built-in surfaces remain available until migrated.
  if (!hasSystemSlotManifest(manifests, slotId)) {
    return true;
  }
  return Boolean(activeSystemSlotProvider(state, manifests, slotId));
};

export const recommendedGrantCapabilities = (manifest: AddOnManifest): CapabilityGrant["capability"][] => {
  const presetGrants = manifest.grantPresets?.flatMap((preset) => preset.grants.map((grant) => grant.capability)) ?? [];
  return Array.from(new Set(presetGrants.length ? presetGrants : manifest.requestedCapabilities.map((grant) => grant.capability)));
};
