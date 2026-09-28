// Intent citation: docs/architecture/ADR-026-minimal-kernel-replaceable-default-addons.md

import type {
  AddOnInstallation,
  AddOnManifest,
  HarnessRegistryProjection,
  ResonantShellState,
  SystemSlotId,
} from "./contracts";

export type SystemSlotProvider = {
  manifest: AddOnManifest;
  installation: AddOnInstallation | HarnessRegistryProjection["installations"][string];
};

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
