// Intent citation: docs/architecture/ADR-002-modular-codebase.md
// Intent citation: docs/architecture/ADR-006-addon-runtime-sdk.md

import type { Dispatch, SetStateAction } from "react";
import type {
  AddOnHookDefinition,
  AddOnInstallation,
  AddOnManifest,
  AddOnScriptDefinition,
  CapabilityGrant,
  InstallationStatus,
  LogicianExecutionArtifact,
  ResonantShellState,
} from "../../core/contracts";
import { executeLogicianHook, executeLogicianScript } from "../../core/logician";
import { applyProviderCredentialStatuses, hydrateState, loadProviderCredentialStatuses, sideloadManifest } from "../../core/runtime";
import type { createHarnessClient, HarnessProjection } from "../../core/harness-client";
import { selectedSystemSlotProviderId } from "../shell/system-slots";

type SideloadControllerInput = {
  sideloadPath: string;
  bundled: AddOnManifest[];
  sideloaded: AddOnManifest[];
  setReadyState: (state: ResonantShellState, nextSideloaded: AddOnManifest[]) => void;
  setSelectedAddonId: Dispatch<SetStateAction<string>>;
  setSideloadPath: Dispatch<SetStateAction<string>>;
  setErrorState: (message: string) => void;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

export const executeSideloadManifest = async ({
  sideloadPath,
  bundled,
  sideloaded,
  setReadyState,
  setSelectedAddonId,
  setSideloadPath,
  setErrorState,
  errorMessageOf,
}: SideloadControllerInput): Promise<void> => {
  if (!sideloadPath.trim()) {
    return;
  }

  try {
    const manifest = await sideloadManifest(sideloadPath.trim());
    const nextSideloaded = [...sideloaded, manifest].filter(
      (item, index, array) => array.findIndex((candidate) => candidate.id === item.id) === index,
    );
    const state = await hydrateState(bundled, nextSideloaded);
    const credentialStatuses = await loadProviderCredentialStatuses();
    const nextState = applyProviderCredentialStatuses(state, credentialStatuses);
    setReadyState(nextState, nextSideloaded);
    setSelectedAddonId(manifest.id);
    setSideloadPath("");
  } catch (error) {
    setErrorState(errorMessageOf(error, "Failed to sideload manifest."));
  }
};

export interface AddonMutationDependencies {
  client: ReturnType<typeof createHarnessClient>;
  getManifest?: (addonId: string) => AddOnManifest | undefined;
  getState: () => ResonantShellState;
  updateRuntimeState: (updater: (current: ResonantShellState) => ResonantShellState) => void;
}

const hostSnapshot = async (deps: AddonMutationDependencies) =>
  deps.client.getSnapshot() ?? await deps.client.refresh();

// Copy only acknowledged governance into the existing display model. Local
// config, catalog metadata and user data are not host consent.
const applyAcknowledgement = (addonId: string, snapshot: HarnessProjection, deps: AddonMutationDependencies) => {
  const acknowledged = snapshot.installations[addonId];
  if (!acknowledged) throw new Error("Host did not acknowledge the add-on installation.");
  deps.updateRuntimeState(draft => {
    // The registry does not attest catalog provenance. Unknown entries get
    // conservative display metadata; governance below comes from the host.
    const installation = draft.installations[addonId] ??= {
      addonId: acknowledged.addonId,
      source: "sideload",
      provenanceTier: "sideloaded-unverified",
      verificationState: "unverified",
      installed: acknowledged.installed,
      enabled: acknowledged.enabled,
      status: "disabled",
      grantedCapabilities: [],
      recommendedGrantPresetIds: [],
      privateProviderProfileIds: [],
      notes: [],
    };
    if (installation.status === "uninstalled") {
      installation.privateProviderProfileIds = [];
      delete installation.config;
    }
    installation.installed = acknowledged.installed;
    installation.enabled = acknowledged.enabled;
    installation.grantedCapabilities = structuredClone([...acknowledged.grantedCapabilities]);
    installation.status = acknowledged.enabled ? "enabled" : "disabled";
    if (addonId === "addon.hermes") {
      const channel = draft.channels.find(item => item.id === "desktop-hermes");
      if (channel) channel.enabled = acknowledged.enabled;
    }
    return draft;
  });
};

export const toggleAddonInstallation = async (
  manifest: AddOnManifest,
  deps: AddonMutationDependencies,
): Promise<void> => {
  const snapshot = await hostSnapshot(deps);
  const installation = snapshot.installations[manifest.id];
  const next = installation?.installed
    ? await deps.client.setEnabled(manifest.id, !installation.enabled, snapshot.revision)
    : await deps.client.install(manifest, true);
  applyAcknowledgement(manifest.id, next, deps);
};

export type UninstallAddonBlockReason =
  | "not-installed"
  | "already-uninstalled"
  | "active-system-slot-provider"
  | "running-work-not-stopped";

export interface UninstallAddonAuditRecord {
  at: string;
  event: "addonUninstalled";
  addonId: string;
  source: AddOnInstallation["source"];
  previousStatus: InstallationStatus;
  previousInstalled: boolean;
  previousEnabled: boolean;
  clearedCapabilities: CapabilityGrant["capability"][];
  clearedPrivateProviderProfileIds: number;
  configDeleted: boolean;
  userDataRetained: true;
  alsoDeleteUserDataOffered: boolean;
  actor: "human";
}

export interface UninstallAddonResult {
  outcome: "uninstalled" | "blocked";
  blockReason?: UninstallAddonBlockReason;
  blockDetail?: string;
  audit?: UninstallAddonAuditRecord;
}

export interface UninstallAddonDependencies extends AddonMutationDependencies {
  stopRunningWork?: (input: { addonId: string }) => Promise<{ stopped: boolean; detail?: string }>;
  now?: () => Date;
}

type UninstallDecision =
  | { ok: true; installation: AddOnInstallation }
  | { ok: false; blockReason: UninstallAddonBlockReason; blockDetail?: string };

const decideUninstall = (state: ResonantShellState, manifest: AddOnManifest): UninstallDecision => {
  const installation = state.installations[manifest.id];
  if (!installation || (!installation.installed && installation.status !== "uninstalled")) {
    return { ok: false, blockReason: "not-installed" };
  }
  if (installation.status === "uninstalled") {
    return { ok: false, blockReason: "already-uninstalled" };
  }
  const activeDefaultSlotIds = (manifest.systemSlots ?? [])
    .filter(slot => selectedSystemSlotProviderId(state, slot.id) === manifest.id)
    .map(slot => slot.id);
  if (activeDefaultSlotIds.length > 0) {
    return {
      ok: false,
      blockReason: "active-system-slot-provider",
      blockDetail: activeDefaultSlotIds.join(", "),
    };
  }
  return { ok: true, installation };
};

export const describeUninstallBlock = (
  state: ResonantShellState,
  manifest: AddOnManifest,
): { blockReason: UninstallAddonBlockReason; blockDetail?: string } | null => {
  const decision = decideUninstall(state, manifest);
  if (decision.ok) {
    return null;
  }
  return { blockReason: decision.blockReason, blockDetail: decision.blockDetail };
};

const runningWorkBlockDetail = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "Running add-on work could not be stopped.";

export const uninstallAddon = async (
  manifest: AddOnManifest,
  deps: UninstallAddonDependencies,
): Promise<UninstallAddonResult> => {
  const initialDecision = decideUninstall(deps.getState(), manifest);
  if (!initialDecision.ok) {
    return { outcome: "blocked", blockReason: initialDecision.blockReason, blockDetail: initialDecision.blockDetail };
  }

  if (deps.stopRunningWork) {
    try {
      const stopResult = await deps.stopRunningWork({ addonId: manifest.id });
      if (!stopResult.stopped) {
        return {
          outcome: "blocked",
          blockReason: "running-work-not-stopped",
          blockDetail: stopResult.detail,
        };
      }
    } catch (error) {
      return {
        outcome: "blocked",
        blockReason: "running-work-not-stopped",
        blockDetail: runningWorkBlockDetail(error),
      };
    }
  }

  const snapshot = await deps.client.remove(manifest.id);
  if (snapshot.installations[manifest.id]) throw new Error("Host did not acknowledge removal.");

  let result: UninstallAddonResult = {
    outcome: "blocked",
    blockReason: "not-installed",
  };
  deps.updateRuntimeState((draft) => {
    const draftDecision = decideUninstall(draft, manifest);
    if (!draftDecision.ok) {
      result = { outcome: "blocked", blockReason: draftDecision.blockReason, blockDetail: draftDecision.blockDetail };
      return draft;
    }

    const installation = draftDecision.installation;
    const audit: UninstallAddonAuditRecord = {
      at: (deps.now ?? (() => new Date()))().toISOString(),
      event: "addonUninstalled",
      addonId: manifest.id,
      source: installation.source,
      previousStatus: installation.status,
      previousInstalled: installation.installed,
      previousEnabled: installation.enabled,
      clearedCapabilities: installation.grantedCapabilities
        .filter((grant) => grant.granted)
        .map((grant) => grant.capability),
      clearedPrivateProviderProfileIds: installation.privateProviderProfileIds.length,
      configDeleted: installation.config !== undefined,
      userDataRetained: true,
      alsoDeleteUserDataOffered: false,
      actor: "human",
    };

    installation.status = "uninstalled";
    installation.installed = false;
    installation.enabled = false;
    installation.grantedCapabilities = [];
    installation.privateProviderProfileIds = [];
    delete installation.config;
    installation.notes = ["Uninstalled; capability grants and add-on config were cleared. User data was retained."];
    if (manifest.id === "addon.hermes") {
      const hermesChannel = draft.channels.find((channel) => channel.id === "desktop-hermes");
      if (hermesChannel) {
        hermesChannel.enabled = false;
      }
    }

    result = { outcome: "uninstalled", audit };
    return draft;
  });

  return result;
};

export const toggleAddonCapabilityGrant = async (
  manifestId: string,
  capability: CapabilityGrant["capability"],
  deps: AddonMutationDependencies,
): Promise<void> => {
  let snapshot = await hostSnapshot(deps);
  let prepared = false;
  if (!snapshot.installations[manifestId]) {
    const manifest = deps.getManifest?.(manifestId);
    if (!manifest) throw new Error("Install the add-on through the host before granting access.");
    snapshot = await deps.client.install(manifest, true);
    prepared = true;
  }
  if (prepared) applyAcknowledgement(manifestId, snapshot, deps);
  const target = snapshot.installations[manifestId]?.grantedCapabilities.find(grant => grant.capability === capability);
  if (!target) throw new Error("Install the add-on through the host before granting access.");
  try {
    const next = await deps.client.setGrants({ addonId: manifestId, grants: [{ ...target, granted: !target.granted }],
      consent: true, expectedRevision: snapshot.revision });
    applyAcknowledgement(manifestId, next, deps);
  } catch (error) {
    if (prepared) {
      try {
        applyAcknowledgement(manifestId, await deps.client.refresh(), deps);
      } catch {
        // Retain the last acknowledged state and the original host refusal if
        // the recovery read fails. Never infer grants from the failed command.
      }
    }
    throw error;
  }
};

export const grantAddonCapabilities = async (
  manifest: AddOnManifest,
  capabilities: CapabilityGrant["capability"][],
  deps: AddonMutationDependencies,
): Promise<void> => {
  // Validate the entire declared set before any transaction. The single grants
  // command lets the host commit all selected grants or reject all of them.
  const grants = [...new Set(capabilities)].map(capability => {
    const request = manifest.requestedCapabilities.find(grant => grant.capability === capability);
    if (!request) throw new Error("The add-on did not request this capability.");
    return { ...request, granted: true };
  });
  let snapshot = await hostSnapshot(deps);
  let prepared = false;
  if (!snapshot.installations[manifest.id]?.installed) {
    snapshot = await deps.client.install(manifest, true);
    prepared = true;
  } else if (!snapshot.installations[manifest.id].enabled) {
    snapshot = await deps.client.setEnabled(manifest.id, true, snapshot.revision);
    prepared = true;
  }
  if (prepared) applyAcknowledgement(manifest.id, snapshot, deps);
  try {
    const next = await deps.client.setGrants({ addonId: manifest.id, grants, consent: true, expectedRevision: snapshot.revision });
    applyAcknowledgement(manifest.id, next, deps);
  } catch (error) {
    if (prepared) {
      try {
        applyAcknowledgement(manifest.id, await deps.client.refresh(), deps);
      } catch {
        // Retain the last acknowledged state and the original host refusal if
        // the recovery read fails. Never infer grants from the failed command.
      }
    }
    throw error;
  }
};

export const grantWorkspaceAccess = async (
  manifest: AddOnManifest | undefined,
  deps: AddonMutationDependencies,
  selectVault?: () => Promise<string | null>,
): Promise<void> => {
  if (!manifest) return;
  const presets: Record<string, CapabilityGrant["capability"][]> = {
    "addon.browser": ["network", "ui-embedding", "browser-control", "filesystem"],
    "addon.obsidian": ["filesystem", "ui-embedding"],
    "addon.opencode": ["filesystem", "shell", "ui-embedding"],
    "addon.paperclip": ["network", "ui-embedding", "agent-delegation"],
    "addon.hermes": ["shell", "ui-embedding"],
  };
  await grantAddonCapabilities(manifest, presets[manifest.id], deps);
  const currentPath = deps.getState().installations[manifest.id]?.config?.vaultPath;
  const vaultPath = manifest.id === "addon.obsidian"
    ? typeof currentPath === "string" && currentPath ? currentPath : await selectVault?.() : undefined;
  deps.updateRuntimeState(draft => {
    const installation = draft.installations[manifest.id];
    if (manifest.id === "addon.obsidian" && vaultPath) {
      installation.config = { ...installation.config, vaultPath, lastWorkspaceConnectedAt: new Date().toISOString() };
    }
    const section = manifest.id.slice("addon.".length);
    if (section === "browser" || section === "opencode" || section === "paperclip" || section === "hermes") {
      draft.uiPreferences.activeSection = section;
    }
    if (manifest.id === "addon.paperclip") {
      installation.config = { ...installation.config, endpoint: installation.config?.endpoint ?? "http://127.0.0.1:3100" };
    }
    return draft;
  });
};

export const updateAddonConfig = (
  manifestId: string,
  config: Record<string, unknown>,
  updateRuntimeState: (updater: (current: ResonantShellState) => ResonantShellState) => void,
): void => {
  updateRuntimeState((draft) => {
    const installation = draft.installations[manifestId];
    if (!installation) {
      return draft;
    }
    installation.config = {
      ...(installation.config ?? {}),
      ...config,
    };
    return draft;
  });
};

const appendVerificationArtifact = (
  artifact: LogicianExecutionArtifact,
  updateRuntimeState: (updater: (current: ResonantShellState) => ResonantShellState) => void,
): void => {
  updateRuntimeState((draft) => {
    const installation = draft.installations[artifact.addonId] as AddOnInstallation | undefined;
    if (!installation) {
      return draft;
    }
    const artifacts = [artifact, ...(installation.verificationArtifacts ?? [])].slice(0, 20);
    installation.verificationArtifacts = artifacts;
    if (artifact.status === "failed" || artifact.status === "blocked") {
      installation.status = installation.enabled ? "degraded" : installation.status;
      installation.notes = [`Latest Logician check ${artifact.status}: ${artifact.summary}`];
    } else if (artifact.status === "passed" && installation.enabled) {
      installation.status = "enabled";
      installation.notes = [`Latest Logician check passed: ${artifact.summary}`];
    } else if (artifact.status === "degraded" && installation.enabled) {
      installation.status = "degraded";
      installation.notes = [`Latest Logician check degraded: ${artifact.summary}`];
    }
    return draft;
  });
};

export const runAddonLogicianScript = async (
  manifest: AddOnManifest,
  installation: AddOnInstallation,
  script: AddOnScriptDefinition,
  updateRuntimeState: (updater: (current: ResonantShellState) => ResonantShellState) => void,
): Promise<LogicianExecutionArtifact> => {
  const artifact = await executeLogicianScript({
    manifest,
    installation,
    script,
    humanInitiated: true,
  });
  appendVerificationArtifact(artifact, updateRuntimeState);
  return artifact;
};

export const runAddonLogicianHook = async (
  manifest: AddOnManifest,
  installation: AddOnInstallation,
  hook: AddOnHookDefinition,
  updateRuntimeState: (updater: (current: ResonantShellState) => ResonantShellState) => void,
): Promise<LogicianExecutionArtifact> => {
  const artifact = await executeLogicianHook({
    manifest,
    installation,
    hook,
    humanInitiated: true,
  });
  appendVerificationArtifact(artifact, updateRuntimeState);
  return artifact;
};
