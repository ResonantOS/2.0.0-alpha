// Intent citation: docs/architecture/ADR-002-modular-codebase.md
// Intent citation: docs/architecture/ADR-009-rust-service-ipc-boundary.md

import type { Dispatch, SetStateAction } from "react";
import type {
  AddOnManifest,
  LivingArchiveMemoryServiceResult,
  LivingArchiveMemoryServiceStatus,
  ProviderDiagnosticReport,
  ProviderProfile,
  ProviderRuntimeNode,
  ProviderSmokeTestResult,
  ResonantShellState,
} from "../../core/contracts";
import { routeFromOptionKey, updateWorkloadStrategy, type WorkloadStrategyPatch } from "../../core/model-strategy";
import { applyProviderDiagnostics } from "../../core/policies";
import {
  requestLivingArchiveMemoryServiceStart,
  requestLivingArchiveMemoryServiceStatus,
  requestLivingArchiveMemoryServiceStop,
  requestProviderDiagnostics,
  requestProviderSetupProbe,
  requestProviderSmokeTest,
  saveProviderSecret,
} from "../../core/runtime";
import { findProviderTemplate, type ProviderTemplateId } from "./provider-templates";

type ReadyShellSnapshot = {
  state: ResonantShellState;
  bundled: AddOnManifest[];
  sideloaded: AddOnManifest[];
};

type RefreshProviderDiagnosticsInput = {
  snapshot: ReadyShellSnapshot;
  providerId?: string;
  commitReadyState: (state: ResonantShellState) => void;
  updateRuntimeState: (updater: (current: ResonantShellState) => ResonantShellState) => void;
  setProviderDiagnosticsBusy: Dispatch<SetStateAction<boolean>>;
  setActiveProviderProbeId: Dispatch<SetStateAction<string | null>>;
  setProviderDiagnostics: Dispatch<SetStateAction<ProviderDiagnosticReport[]>>;
  setSettingsNotice: Dispatch<SetStateAction<string | null>>;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

type SaveProviderSecretInput = {
  snapshot: ReadyShellSnapshot;
  profileId: string;
  secret: string;
  commitReadyState: (state: ResonantShellState) => void;
  updateRuntimeState: (updater: (current: ResonantShellState) => ResonantShellState) => void;
  setProviderDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  setSettingsNotice: Dispatch<SetStateAction<string | null>>;
  setProviderDiagnosticsBusy: Dispatch<SetStateAction<boolean>>;
  setActiveProviderProbeId: Dispatch<SetStateAction<string | null>>;
  setProviderDiagnostics: Dispatch<SetStateAction<ProviderDiagnosticReport[]>>;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

type RunProviderSmokeTestInput = {
  snapshot: ReadyShellSnapshot;
  providerId: string;
  setProviderSmokeBusyId: Dispatch<SetStateAction<string | null>>;
  setProviderSmokeResults: Dispatch<SetStateAction<Record<string, ProviderSmokeTestResult>>>;
  setSettingsNotice: Dispatch<SetStateAction<string | null>>;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

export type CreateProviderProfileInput = {
  templateId: ProviderTemplateId;
  label: string;
  secret?: string;
  apiBaseUrl?: string;
};

type ExecuteCreateProviderProfileInput = CreateProviderProfileInput & {
  updateRuntimeState: (updater: (current: ResonantShellState) => ResonantShellState) => void;
  setSettingsNotice: Dispatch<SetStateAction<string | null>>;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

type ExecuteDeleteProviderProfileInput = {
  snapshot: ReadyShellSnapshot;
  profileId: string;
  updateRuntimeState: (updater: (current: ResonantShellState) => ResonantShellState) => void;
  setSettingsNotice: Dispatch<SetStateAction<string | null>>;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

type ExecuteSetupProviderProfileInput = {
  snapshot: ReadyShellSnapshot;
  profileId: string;
  updateRuntimeState: (updater: (current: ResonantShellState) => ResonantShellState) => void;
  setSettingsNotice: Dispatch<SetStateAction<string | null>>;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

type RefreshMemoryServiceStatusInput = {
  setMemoryServiceBusy: Dispatch<SetStateAction<boolean>>;
  setMemoryServiceStatus: Dispatch<SetStateAction<LivingArchiveMemoryServiceStatus | null>>;
  setSettingsNotice: Dispatch<SetStateAction<string | null>>;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

type StartMemoryServiceInput = RefreshMemoryServiceStatusInput & {
  setMemoryServiceLastResult: Dispatch<SetStateAction<LivingArchiveMemoryServiceResult | null>>;
};

export const executeRefreshProviderDiagnostics = async ({
  snapshot,
  providerId,
  commitReadyState,
  updateRuntimeState,
  setProviderDiagnosticsBusy,
  setActiveProviderProbeId,
  setProviderDiagnostics,
  setSettingsNotice,
  errorMessageOf,
}: RefreshProviderDiagnosticsInput): Promise<void> => {
  try {
    setProviderDiagnosticsBusy(true);
    setActiveProviderProbeId(providerId ?? null);
    const reports = await requestProviderDiagnostics(providerId);
    updateRuntimeState((draft) => applyProviderDiagnostics(draft, reports));
    setProviderDiagnostics((current) => {
      if (!providerId) {
        return reports;
      }
      const byId = new Map(current.map((report) => [report.providerId, report]));
      for (const report of reports) {
        byId.set(report.providerId, report);
      }
      return Array.from(byId.values());
    });
    const nextState = applyProviderDiagnostics(snapshot.state, reports);
    commitReadyState(nextState);
    setSettingsNotice(
      providerId ? `Diagnostics refreshed for ${reports[0]?.providerLabel ?? providerId}.` : "Provider diagnostics refreshed.",
    );
  } catch (error) {
    setSettingsNotice(errorMessageOf(error, "Failed to probe provider diagnostics."));
  } finally {
    setProviderDiagnosticsBusy(false);
    setActiveProviderProbeId(null);
  }
};

export const executeSaveProviderSecret = async ({
  snapshot,
  profileId,
  secret,
  commitReadyState,
  updateRuntimeState,
  setProviderDrafts,
  setSettingsNotice,
  setProviderDiagnosticsBusy,
  setActiveProviderProbeId,
  setProviderDiagnostics,
  errorMessageOf,
}: SaveProviderSecretInput): Promise<void> => {
  try {
    await saveProviderSecret(profileId, secret);
    const credentialStatus: ResonantShellState["providers"][number]["credentialStatus"] = secret.trim()
      ? "configured"
      : "missing";
    updateRuntimeState((draft) => {
      const profile = draft.providers.find((item) => item.id === profileId);
      if (profile) {
        profile.credentialStatus = credentialStatus;
      }
      return draft;
    });
    const nextState = {
      ...snapshot.state,
      providers: snapshot.state.providers.map((profile) =>
        profile.id === profileId
          ? { ...profile, credentialStatus }
          : profile,
      ),
    };
    commitReadyState(nextState);
    setProviderDrafts((current) => ({ ...current, [profileId]: "" }));
    setSettingsNotice(secret.trim() ? "Provider secret saved." : "Provider secret cleared.");
    await executeRefreshProviderDiagnostics({
      snapshot: { ...snapshot, state: nextState },
      providerId: profileId,
      commitReadyState,
      updateRuntimeState,
      setProviderDiagnosticsBusy,
      setActiveProviderProbeId,
      setProviderDiagnostics,
      setSettingsNotice,
      errorMessageOf,
    });
  } catch (error) {
    setSettingsNotice(errorMessageOf(error, "Failed to save provider secret."));
  }
};

export const executeProviderSmokeTest = async ({
  snapshot,
  providerId,
  setProviderSmokeBusyId,
  setProviderSmokeResults,
  setSettingsNotice,
  errorMessageOf,
}: RunProviderSmokeTestInput): Promise<void> => {
  const provider = snapshot.state.providers.find((item) => item.id === providerId);
  if (!provider) {
    setSettingsNotice(`Provider ${providerId} was not found.`);
    return;
  }
  const runtimeNode = snapshot.state.runtimeNodes.find((node) => node.providerProfileId === provider.id);
  try {
    setProviderSmokeBusyId(providerId);
    const result = await requestProviderSmokeTest({
      providerId: provider.id,
      providerType: provider.providerType,
      apiBaseUrl: provider.apiBaseUrl,
      runtimeNodeId: runtimeNode?.id,
      runtimeNodeKind: runtimeNode?.kind,
      runtimeNodeEndpoint: runtimeNode?.endpoint,
      authTier: provider.authTier,
      model: provider.primaryModel,
    });
    setProviderSmokeResults((current) => ({ ...current, [providerId]: result }));
    setSettingsNotice(result.summary);
  } catch (error) {
    setSettingsNotice(errorMessageOf(error, "Provider smoke test failed."));
  } finally {
    setProviderSmokeBusyId(null);
  }
};

const createStableProviderId = (label: string, templateId: ProviderTemplateId): string => {
  const safeLabel = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 34);
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : `${Date.now()}`.slice(-8);
  return `provider-${safeLabel || templateId}-${suffix}`;
};

const applySetupProbeToProvider = async ({
  provider,
  runtimeNode,
  errorMessageOf,
}: {
  provider: ProviderProfile;
  runtimeNode: ProviderRuntimeNode;
  errorMessageOf: (error: unknown, fallback: string) => string;
}): Promise<{ provider: ProviderProfile; runtimeNode: ProviderRuntimeNode; notice: string }> => {
  try {
    const setupProbe = await requestProviderSetupProbe({
      providerId: provider.id,
      providerType: provider.providerType,
      apiBaseUrl: provider.apiBaseUrl,
      runtimeNodeKind: runtimeNode.kind,
      runtimeNodeEndpoint: runtimeNode.endpoint,
      authTier: provider.authTier,
    });
    if (setupProbe.discoveredModels.length === 0) {
      return {
        provider,
        runtimeNode,
        notice: `${provider.label} setup probe finished: ${setupProbe.summary}`,
      };
    }
    const discoveredOpenAiCompatibleLocal =
      setupProbe.source === "openai-compatible-models" &&
      (runtimeNode.kind === "local" || runtimeNode.kind === "remote-user-owned");
    const nextProvider: ProviderProfile = {
      ...provider,
      providerType: discoveredOpenAiCompatibleLocal ? "openai-compatible" : provider.providerType,
      authMethod: discoveredOpenAiCompatibleLocal ? "local-runtime" : provider.authMethod,
      authTier: discoveredOpenAiCompatibleLocal ? "supported" : provider.authTier,
      apiBaseUrl: setupProbe.endpoint.startsWith("http") ? setupProbe.endpoint : provider.apiBaseUrl,
      allowedModels: setupProbe.discoveredModels,
      primaryModel: setupProbe.recommendedPrimaryModel ?? setupProbe.discoveredModels[0] ?? provider.primaryModel,
      fallbackModel: setupProbe.recommendedFallbackModel ?? setupProbe.discoveredModels[1] ?? provider.fallbackModel,
      modelContext: setupProbe.discoveredModels.map((model) => ({
        model,
        maxContextTokens: 32_000,
        tokenEstimateMethod: "provider-metadata",
        source: "provider-default",
      })),
      status: setupProbe.setupState === "routable-now" ? "ready" : "missing",
    };
    const nextRuntimeNode: ProviderRuntimeNode = {
      ...runtimeNode,
      endpoint: setupProbe.endpoint.startsWith("http") ? setupProbe.endpoint : runtimeNode.endpoint,
      supportedModels: setupProbe.discoveredModels,
      authTier: discoveredOpenAiCompatibleLocal ? "supported" : runtimeNode.authTier,
      healthState: setupProbe.setupState === "routable-now" ? "ready" : "unavailable",
      notes: [`${setupProbe.setupState}: ${setupProbe.summary}`, setupProbe.detail],
    };
    return {
      provider: nextProvider,
      runtimeNode: nextRuntimeNode,
      notice: `${provider.label} setup probe finished: ${setupProbe.summary}`,
    };
  } catch (error) {
    return {
      provider,
      runtimeNode,
      notice: `${provider.label} setup probe failed: ${errorMessageOf(error, "Probe failed.")}`,
    };
  }
};

export const executeCreateProviderProfile = async ({
  templateId,
  label,
  secret,
  apiBaseUrl,
  updateRuntimeState,
  setSettingsNotice,
  errorMessageOf,
}: ExecuteCreateProviderProfileInput): Promise<void> => {
  const template = findProviderTemplate(templateId);
  if (!template) {
    setSettingsNotice(`Provider template ${templateId} was not found.`);
    return;
  }
  const cleanLabel = label.trim() || template.label;
  const cleanSecret = secret?.trim() ?? "";
  const cleanApiBaseUrl = apiBaseUrl?.trim() || template.defaultApiBaseUrl;

  if (template.requiresBaseUrl && !cleanApiBaseUrl) {
    setSettingsNotice(`${template.label} needs an API base URL.`);
    return;
  }
  if (template.requiresSecret && !cleanSecret) {
    setSettingsNotice(`${template.label} needs a credential before it can be added.`);
    return;
  }

  try {
    const providerId = createStableProviderId(cleanLabel, template.id);
    const credentialStatus: ProviderProfile["credentialStatus"] = template.requiresSecret ? "configured" : "configured";
    const provider: ProviderProfile = {
      id: providerId,
      label: cleanLabel,
      providerType: template.providerType,
      authSource: template.requiresSecret ? "shared-vault" : "manual",
      authMethod: template.authMethod,
      authTier: template.authTier,
      apiBaseUrl: cleanApiBaseUrl,
      allowedModels: [...template.allowedModels],
      primaryModel: template.primaryModel,
      fallbackModel: template.fallbackModel,
      modelContext: template.modelContext.map((policy) => ({ ...policy })),
      consumerScopes: [...template.consumerScopes],
      shared: true,
      status: template.initialStatus,
      credentialStatus,
    };
    const runtimeNode: ProviderRuntimeNode = {
      id: `node-${providerId}`,
      label: `${cleanLabel} Runtime`,
      providerProfileId: providerId,
      kind: template.runtimeKind,
      locality: template.runtimeLocality,
      endpoint: cleanApiBaseUrl,
      supportedModels: [...template.allowedModels],
      authTier: template.authTier,
      healthState: template.initialRuntimeHealthState,
      deployableOnDemand: template.deployableOnDemand,
      notes: [`${template.executionState}: ${template.note}`],
    };

    if (template.requiresSecret) {
      await saveProviderSecret(providerId, cleanSecret);
    }

    const setupResult = await applySetupProbeToProvider({ provider, runtimeNode, errorMessageOf });

    updateRuntimeState((draft) => ({
      ...draft,
      providers: [...draft.providers, setupResult.provider],
      deletedProviderProfileIds: draft.deletedProviderProfileIds.filter((id) => id !== providerId),
      runtimeNodes: [...draft.runtimeNodes, setupResult.runtimeNode],
    }));
    setSettingsNotice(`${cleanLabel} was added. ${setupResult.notice}`);
  } catch (error) {
    setSettingsNotice(errorMessageOf(error, "Failed to add provider profile."));
  }
};

// Provider reference sites (all must be cleaned up on deletion):
//   - providers[]                          (filtered out)
//   - runtimeNodes[]                       (filtered by providerProfileId)
//   - agents[].providerProfileId           (reassigned to a surviving provider)
//   - agents[].fallbackProviderProfileId   (cleared)
//   - workloadStrategies[].primaryRoute    (reset to empty route)
//   - fallbackChains[].orderedRoutes[]     (filtered out)
//   - fallbackChains[].lastResortRoute     (cleared if it matches)
//   - emergencyPolicy.orderedPromotionTargets[]  (filtered out)
//   - emergencyPolicy.hardFloorRoute       (cleared if it matches)
//   - fallbackPolicies[].orderedProviderProfileIds[]  (filtered out)
//   - fallbackPolicies[].orderedRuntimeNodeIds[] (filtered out)
//   - recoveryActions[].runtimeNodeId       (filtered out)
export const executeDeleteProviderProfile = ({
  snapshot,
  profileId,
  updateRuntimeState,
  setSettingsNotice,
  errorMessageOf,
}: ExecuteDeleteProviderProfileInput): Promise<void> => {
  if (!snapshot.state.providers.some((item) => item.id === profileId)) {
    setSettingsNotice(`Provider ${profileId} was not found.`);
    return Promise.resolve();
  }

  return (async () => {
    try {
      await saveProviderSecret(profileId, "");
      updateRuntimeState((draft) => {
        const provider = draft.providers.find((item) => item.id === profileId);
        if (!provider) {
          return draft;
        }

        const remainingProviders = draft.providers.filter((item) => item.id !== profileId);
        const removedRuntimeNodeIds = new Set(
          draft.runtimeNodes
            .filter((node) => node.providerProfileId === profileId)
            .map((node) => node.id),
        );

        const updatedAgents = draft.agents.map((agent) => {
          const patch: Partial<Pick<typeof agent, "providerProfileId" | "fallbackProviderProfileId">> = {};
          if (agent.providerProfileId === profileId) {
            const replacement = remainingProviders.find(
              (p) => p.consumerScopes.includes("strategist") || p.consumerScopes.includes("setup"),
            );
            patch.providerProfileId = replacement?.id ?? "";
          }
          if (agent.fallbackProviderProfileId === profileId) {
            patch.fallbackProviderProfileId = undefined;
          }
          return Object.keys(patch).length ? { ...agent, ...patch } : agent;
        });

        const updatedStrategies = draft.modelStrategy.workloadStrategies.map((strategy) => {
          const primary =
            strategy.primaryRoute.providerProfileId === profileId
              ? { providerProfileId: "", runtimeNodeId: "", model: "", costPosture: "unknown" as const }
              : strategy.primaryRoute;
          return { ...strategy, primaryRoute: primary };
        });

        const updatedChains = draft.modelStrategy.fallbackChains.map((chain) => ({
          ...chain,
          orderedRoutes: chain.orderedRoutes.filter((r) => r.providerProfileId !== profileId),
          lastResortRoute: chain.lastResortRoute?.providerProfileId === profileId ? undefined : chain.lastResortRoute,
        }));

        const emergencyPromotionTargets = draft.modelStrategy.emergencyPolicy.orderedPromotionTargets.filter(
          (target) => target.providerProfileId !== profileId,
        );
        const emergencyHardFloor =
          draft.modelStrategy.emergencyPolicy.hardFloorRoute.providerProfileId === profileId
            ? { providerProfileId: "", runtimeNodeId: "", model: "", costPosture: "unknown" as const }
          : draft.modelStrategy.emergencyPolicy.hardFloorRoute;

        const updatedFallbackPolicies = draft.providerRouting.fallbackPolicies.map((policy) => ({
          ...policy,
          orderedProviderProfileIds: policy.orderedProviderProfileIds.filter((id) => id !== profileId),
          orderedRuntimeNodeIds: (policy.orderedRuntimeNodeIds ?? []).filter((id) => !removedRuntimeNodeIds.has(id)),
        }));
        const updatedRecoveryActions = draft.providerRouting.recoveryActions.filter(
          (action) => !removedRuntimeNodeIds.has(action.runtimeNodeId),
        );

        return {
          ...draft,
          providers: remainingProviders,
          deletedProviderProfileIds: Array.from(new Set([...draft.deletedProviderProfileIds, profileId])),
          runtimeNodes: draft.runtimeNodes.filter((node) => node.providerProfileId !== profileId),
          agents: updatedAgents,
          modelStrategy: {
            ...draft.modelStrategy,
            workloadStrategies: updatedStrategies,
            fallbackChains: updatedChains,
            emergencyPolicy: {
              ...draft.modelStrategy.emergencyPolicy,
              orderedPromotionTargets: emergencyPromotionTargets,
              hardFloorRoute: emergencyHardFloor,
            },
          },
          providerRouting: {
            ...draft.providerRouting,
            fallbackPolicies: updatedFallbackPolicies,
            recoveryActions: updatedRecoveryActions,
          },
        };
      });
      setSettingsNotice("Provider removed.");
    } catch (error) {
      setSettingsNotice(errorMessageOf(error, "Failed to remove provider credential; provider was not removed."));
    }
  })();
};

export const executeSetupProviderProfile = async ({
  snapshot,
  profileId,
  updateRuntimeState,
  setSettingsNotice,
  errorMessageOf,
}: ExecuteSetupProviderProfileInput): Promise<void> => {
  const provider = snapshot.state.providers.find((item) => item.id === profileId);
  const runtimeNode = snapshot.state.runtimeNodes.find((node) => node.providerProfileId === profileId);
  if (!provider || !runtimeNode) {
    setSettingsNotice(`Provider ${profileId} is missing a profile or runtime node.`);
    return;
  }
  const setupResult = await applySetupProbeToProvider({ provider, runtimeNode, errorMessageOf });
  updateRuntimeState((draft) => ({
    ...draft,
    providers: draft.providers.map((item) => (item.id === profileId ? setupResult.provider : item)),
    runtimeNodes: draft.runtimeNodes.map((node) => (node.id === runtimeNode.id ? setupResult.runtimeNode : node)),
  }));
  setSettingsNotice(setupResult.notice);
};

export const updateProviderProfile = (
  profileId: string,
  field: "primaryModel" | "fallbackModel" | "status",
  value: string,
  updateRuntimeState: (updater: (current: ResonantShellState) => ResonantShellState) => void,
): void => {
  updateRuntimeState((draft) => {
    const profile = draft.providers.find((item) => item.id === profileId);
    if (!profile) {
      return draft;
    }
    if (field === "status") {
      profile.status = value as ResonantShellState["providers"][number]["status"];
    } else if (field === "fallbackModel") {
      profile.fallbackModel = value || undefined;
    } else {
      profile.primaryModel = value;
    }
    return draft;
  });
};

export const updateModelWorkloadStrategy = (
  strategyId: string,
  patch: WorkloadStrategyPatch,
  updateRuntimeState: (updater: (current: ResonantShellState) => ResonantShellState) => void,
): void => {
  updateRuntimeState((draft) => updateWorkloadStrategy(draft, strategyId, patch));
};

export const updateModelWorkloadStrategyRoute = (
  strategyId: string,
  routeKey: string,
  updateRuntimeState: (updater: (current: ResonantShellState) => ResonantShellState) => void,
): void => {
  updateRuntimeState((draft) => {
    const route = routeFromOptionKey(draft, routeKey);
    if (!route) {
      return draft;
    }
    const updated = updateWorkloadStrategy(draft, strategyId, { primaryRoute: route });
    const strategy = updated.modelStrategy.workloadStrategies.find((s) => s.id === strategyId);
    if (!strategy || strategy.ownerType !== "agent") {
      return updated;
    }
    return {
      ...updated,
      agents: updated.agents.map((agent) =>
        agent.id === strategy.ownerId
          ? { ...agent, providerProfileId: route.providerProfileId }
          : agent,
      ),
    };
  });
};

export const executeRefreshMemoryServiceStatus = async ({
  setMemoryServiceBusy,
  setMemoryServiceStatus,
  setSettingsNotice,
  errorMessageOf,
}: RefreshMemoryServiceStatusInput): Promise<void> => {
  try {
    setMemoryServiceBusy(true);
    const status = await requestLivingArchiveMemoryServiceStatus();
    setMemoryServiceStatus(status);
    setSettingsNotice(status.statusDetail);
  } catch (error) {
    setSettingsNotice(errorMessageOf(error, "Failed to read Living Archive memory service status."));
  } finally {
    setMemoryServiceBusy(false);
  }
};

export const executeStartMemoryService = async ({
  setMemoryServiceBusy,
  setMemoryServiceStatus,
  setMemoryServiceLastResult,
  setSettingsNotice,
  errorMessageOf,
}: StartMemoryServiceInput): Promise<void> => {
  try {
    setMemoryServiceBusy(true);
    const result = await requestLivingArchiveMemoryServiceStart();
    setMemoryServiceLastResult(result);
    const status = await requestLivingArchiveMemoryServiceStatus({ sessionId: result.sessionId });
    setMemoryServiceStatus(status);
    setSettingsNotice(
      result.alreadyRunning
        ? `Living Archive memory service is already running at ${result.endpoint}.`
        : `Living Archive memory service started at ${result.endpoint}.`,
    );
  } catch (error) {
    setSettingsNotice(errorMessageOf(error, "Failed to start Living Archive memory service."));
  } finally {
    setMemoryServiceBusy(false);
  }
};

export const executeStopMemoryService = async ({
  setMemoryServiceBusy,
  setMemoryServiceStatus,
  setMemoryServiceLastResult,
  setSettingsNotice,
  errorMessageOf,
}: StartMemoryServiceInput): Promise<void> => {
  try {
    setMemoryServiceBusy(true);
    const result = await requestLivingArchiveMemoryServiceStop();
    setMemoryServiceLastResult(result);
    const status = await requestLivingArchiveMemoryServiceStatus({ sessionId: result.sessionId });
    setMemoryServiceStatus(status);
    setSettingsNotice(`Living Archive memory service stopped at ${result.endpoint}.`);
  } catch (error) {
    setSettingsNotice(errorMessageOf(error, "Failed to stop Living Archive memory service."));
  } finally {
    setMemoryServiceBusy(false);
  }
};
