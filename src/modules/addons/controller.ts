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

export const toggleAddonInstallation = (
  manifest: AddOnManifest,
  updateRuntimeState: (updater: (current: ResonantShellState) => ResonantShellState) => void,
): void => {
  updateRuntimeState((draft) => {
    const installation = draft.installations[manifest.id];
    if (!installation) {
      return draft;
    }
    if (!installation.installed) {
      if (installation.status === "uninstalled") {
        // Reinstall after uninstall is a fresh grant flow: nothing from the removed installation carries over.
        installation.grantedCapabilities = manifest.requestedCapabilities.map((grant) => ({ ...grant, granted: false }));
        installation.privateProviderProfileIds = [];
        delete installation.config;
      }
      installation.installed = true;
      installation.enabled = true;
      installation.status = "enabled";
      installation.notes = [`Installed from the ${installation.source} catalog.`];
    } else if (installation.enabled) {
      installation.enabled = false;
      installation.status = "disabled";
      installation.notes = ["Disabled without uninstalling the add-on."];
    } else {
      installation.enabled = true;
      installation.status = "enabled";
      installation.notes = ["Re-enabled after prior disable."];
    }
    if (manifest.id === "addon.hermes") {
      const hermesChannel = draft.channels.find((channel) => channel.id === "desktop-hermes");
      if (hermesChannel) {
        hermesChannel.enabled = installation.enabled;
      }
    }
    return draft;
  });
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

export interface UninstallAddonDependencies {
  getState: () => ResonantShellState;
  updateRuntimeState: (updater: (current: ResonantShellState) => ResonantShellState) => void;
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
  const activeDefaultSlotIds =
    installation.source === "bundled"
      ? (manifest.systemSlots ?? [])
          .filter(
            (slot) =>
              slot.role === "default-provider" &&
              slot.recommended === true &&
              selectedSystemSlotProviderId(state, slot.id) === manifest.id,
          )
          .map((slot) => slot.id)
      : [];
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

export const toggleAddonCapabilityGrant = (
  manifestId: string,
  capability: CapabilityGrant["capability"],
  updateRuntimeState: (updater: (current: ResonantShellState) => ResonantShellState) => void,
): void => {
  updateRuntimeState((draft) => {
    const installation = draft.installations[manifestId] as AddOnInstallation | undefined;
    if (!installation) {
      return draft;
    }
    const target = installation?.grantedCapabilities.find((grant) => grant.capability === capability);
    if (target) {
      target.granted = !target.granted;
      installation.status = installation.enabled ? "enabled" : installation.installed ? "installed" : "available";
    }
    return draft;
  });
};

export const grantAddonCapabilities = (
  manifestId: string,
  capabilities: CapabilityGrant["capability"][],
  requestedCapabilities: CapabilityGrant[],
  updateRuntimeState: (updater: (current: ResonantShellState) => ResonantShellState) => void,
): void => {
  updateRuntimeState((draft) => {
    const installation = draft.installations[manifestId] as AddOnInstallation | undefined;
    if (!installation) {
      return draft;
    }
    installation.installed = true;
    installation.enabled = true;
    const existingGrants = new Map(installation.grantedCapabilities.map((grant) => [grant.capability, grant]));
    const missingRequestedGrants = requestedCapabilities.filter((grant) => !existingGrants.has(grant.capability));
    installation.grantedCapabilities = [...installation.grantedCapabilities, ...missingRequestedGrants].map((grant) =>
      capabilities.includes(grant.capability) ? { ...grant, granted: true } : grant,
    );
    installation.status = "enabled";
    installation.notes = [`Installed, enabled, and granted ${capabilities.join(", ")} through reviewed setup.`];
    if (manifestId === "addon.hermes") {
      const hermesChannel = draft.channels.find((channel) => channel.id === "desktop-hermes");
      if (hermesChannel) {
        hermesChannel.enabled = true;
      }
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
