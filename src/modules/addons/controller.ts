// Intent citation: docs/architecture/ADR-002-modular-codebase.md
// Intent citation: docs/architecture/ADR-006-addon-runtime-sdk.md

import type { Dispatch, SetStateAction } from "react";
import type {
  AddOnHookDefinition,
  AddOnInstallation,
  AddOnManifest,
  AddOnScriptDefinition,
  CapabilityGrant,
  LogicianExecutionArtifact,
  ResonantShellState,
} from "../../core/contracts";
import { executeLogicianHook, executeLogicianScript } from "../../core/logician";
import { applyProviderCredentialStatuses, hydrateState, loadProviderCredentialStatuses, sideloadManifest } from "../../core/runtime";

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
