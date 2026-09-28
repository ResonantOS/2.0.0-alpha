// Intent citation: docs/architecture/ADR-002-modular-codebase.md
// Intent citation: docs/architecture/ADR-009-rust-service-ipc-boundary.md

import type {
  AddOnManifest,
  LocalRuntimeStatus,
  RecoveryRouteCandidate,
  ResonantShellState,
} from "../../core/contracts";
import {
  applyProviderCredentialStatuses,
  hydrateState,
  loadBundledManifests,
  loadProviderCredentialStatuses,
  loadSideloadedManifests,
  requestLocalRuntimeStatus,
  requestRecoveryRouteCandidates,
} from "../../core/runtime";
import type { createHarnessClient } from "../../core/harness-client";
import { recommendedGrantCapabilities, recommendedSystemSlotManifests } from "./system-slots";

export type BootedShellState = {
  bundled: AddOnManifest[];
  sideloaded: AddOnManifest[];
  state: ResonantShellState;
  selectedAddonId: string;
};

export const loadInitialShellState = async (client?: ReturnType<typeof createHarnessClient>): Promise<BootedShellState> => {
  const bundled = await loadBundledManifests();
  const sideloaded = await loadSideloadedManifests();
  const projection = client?.getSnapshot() ?? await client?.refresh().catch(() => null);
  const state = await hydrateState(bundled, sideloaded, projection);
  const credentialStatuses = await loadProviderCredentialStatuses();
  const nextState = applyProviderCredentialStatuses(state, credentialStatuses);

  return {
    bundled,
    sideloaded,
    state: nextState,
    selectedAddonId: bundled[0]?.id ?? "",
  };
};

export const loadRecoveryRuntimeSnapshot = async (
  state: ResonantShellState,
): Promise<{
  status: LocalRuntimeStatus;
  candidates: RecoveryRouteCandidate[];
}> => {
  const localTargetModel =
    state.providers.find((profile) => profile.id === "shared-local")?.primaryModel ?? "batiai/gemma4-e2b:q4";

  const [status, candidates] = await Promise.all([
    requestLocalRuntimeStatus(localTargetModel),
    requestRecoveryRouteCandidates(),
  ]);

  return { status, candidates };
};

// Only these bundled defaults participate in first-run consent. Catalog and
// sideloaded recommendations cannot widen the first-run transaction.
export const firstRunRecommendedAddOns = (bundled: AddOnManifest[]): AddOnManifest[] =>
  recommendedSystemSlotManifests(bundled).filter(manifest =>
    manifest.id === "addon.augmentor-chat" || manifest.id === "addon.living-archive");

export const applyFirstRunRecommendedAddOns = async (
  state: ResonantShellState,
  bundled: AddOnManifest[],
  selectedAddonIds: string[],
  client: ReturnType<typeof createHarnessClient>,
): Promise<ResonantShellState> => {
  const selected = new Set(selectedAddonIds);
  const recommended = firstRunRecommendedAddOns(bundled);
  for (const manifest of recommended.filter(item => selected.has(item.id))) {
    let snapshot = client.getSnapshot() ?? await client.refresh();
    const installation = snapshot.installations[manifest.id];
    if (!installation?.installed) snapshot = await client.install(manifest, true);
    else if (!installation.enabled) snapshot = await client.setEnabled(manifest.id, true, snapshot.revision);

    const capabilities = recommendedGrantCapabilities(manifest);
    snapshot = await client.setGrants({ addonId: manifest.id, consent: true, expectedRevision: snapshot.revision,
      grants: manifest.requestedCapabilities.filter(grant => capabilities.includes(grant.capability))
        .map(grant => ({ ...grant, granted: true })),
    });
    for (const slot of manifest.systemSlots?.filter(item => item.recommended) ?? []) {
      const owner = snapshot.slots[slot.id];
      if (owner?.addonId) continue;
      // First-run does not consent to replacing an existing host owner.
      snapshot = await client.assignSlot({ slot: slot.id, addonId: manifest.id, expectedGeneration: 0 });
    }
  }

  // Only preferences are local. Installations, grants and owners remain in the
  // acknowledged harness projection, including during partial success/retry.
  return { ...state, uiPreferences: {
    ...state.uiPreferences,
    recommendedAddOnsReviewed: true,
    chatSidebarOpen: selected.has("addon.augmentor-chat") || !recommended.some(item => item.id === "addon.augmentor-chat")
      ? state.uiPreferences.chatSidebarOpen : false,
  } };
};

export const markFirstRunRecommendedAddOnsReviewed = (state: ResonantShellState): ResonantShellState => ({
  ...state,
  uiPreferences: {
    ...state.uiPreferences,
    recommendedAddOnsReviewed: true,
  },
});
