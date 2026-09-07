// Intent citation: docs/architecture/ADR-005-provider-fabric-routing.md
// Intent citation: docs/architecture/ADR-006-addon-runtime-sdk.md

import type {
  AddOnInstallation,
  AddOnManifest,
  ArchiveAction,
  ArchiveActorPolicy,
  Capability,
  CapabilityGrant,
  ProviderDiagnosticReport,
  ProviderExecutionAdapterId,
  ProviderExecutionAdapterPolicy,
  ProviderProfile,
  ProviderRoutingDecision,
  ProviderRoutingPolicyInput,
  ProviderRuntimeNode,
  ResonantShellState,
} from "./contracts";
import { providerNeedsStoredCredential } from "./provider-credentials";

export const strategistDisplayName = (state: ResonantShellState): string =>
  state.strategistIdentity.customName?.trim() || state.strategistIdentity.defaultName;

export const actorPolicyFor = (state: ResonantShellState, actorId: string): ArchiveActorPolicy | undefined =>
  state.archivePolicy.actorPolicies.find((policy) => policy.actorId === actorId);

export const canPerformArchiveAction = (
  state: ResonantShellState,
  actorId: string,
  action: ArchiveAction,
  scope?: string,
): boolean => {
  const policy = actorPolicyFor(state, actorId);
  if (!policy) {
    return false;
  }

  if (action === "archive-read") {
    return scope ? policy.readScopes.some((item) => scope.startsWith(item)) : policy.readScopes.length > 0;
  }
  if (action === "archive-intake-write") {
    return scope
      ? policy.intakeWriteScopes.some((item) => scope.startsWith(item))
      : policy.intakeWriteScopes.length > 0;
  }
  if (action === "archive-knowledge-write") {
    return policy.canWriteKnowledgePages;
  }
  return policy.canRequestIngest;
};

export const capabilityGrantFor = (installation: AddOnInstallation | undefined, capability: Capability): CapabilityGrant | undefined =>
  installation?.grantedCapabilities.find((grant) => grant.capability === capability);

export const isCapabilityGranted = (
  installation: AddOnInstallation | undefined,
  capability: Capability,
  expectedScope?: CapabilityGrant["scope"],
): boolean => {
  const grant = capabilityGrantFor(installation, capability);
  if (!grant || !grant.granted) {
    return false;
  }
  return expectedScope ? grant.scope === expectedScope || grant.scope === "system" : true;
};

export const resolveProviderPath = (
  provider: ProviderProfile | undefined,
  fallbackProvider: ProviderProfile | undefined,
): { active: ProviderProfile | undefined; usingFallback: boolean } => {
  if (!provider) {
    return { active: fallbackProvider, usingFallback: Boolean(fallbackProvider) };
  }
  if (provider.status !== "missing") {
    return { active: provider, usingFallback: false };
  }
  return { active: fallbackProvider, usingFallback: Boolean(fallbackProvider) };
};

const providerStatusFromDiagnostic = (
  status: ProviderDiagnosticReport["status"],
): ProviderProfile["status"] => {
  if (status === "healthy") {
    return "ready";
  }
  if (status === "attention") {
    return "fallback";
  }
  return "missing";
};

const runtimeHealthFromDiagnostic = (
  probeState: ProviderDiagnosticReport["runtimeDiagnostics"][number]["probeState"],
): ProviderRuntimeNode["healthState"] => {
  if (probeState === "healthy") {
    return "ready";
  }
  if (probeState === "attention" || probeState === "unprobeable") {
    return "degraded";
  }
  return "unavailable";
};

export const applyProviderDiagnostics = (
  state: ResonantShellState,
  reports: ProviderDiagnosticReport[],
): ResonantShellState => {
  if (!reports.length) {
    return state;
  }

  const reportsByProviderId = new Map(reports.map((report) => [report.providerId, report]));
  const runtimeReportsById = new Map(
    reports.flatMap((report) => report.runtimeDiagnostics.map((runtime) => [runtime.runtimeNodeId, runtime] as const)),
  );

  return {
    ...state,
    providers: state.providers.map((provider) => {
      const report = reportsByProviderId.get(provider.id);
      if (!report) {
        return provider;
      }
      return {
        ...provider,
        status: providerStatusFromDiagnostic(report.status),
        credentialStatus:
          !providerNeedsStoredCredential(provider)
            ? "configured"
            : report.credentialConfigured
              ? "configured"
              : "missing",
      };
    }),
    runtimeNodes: state.runtimeNodes.map((node) => {
      const report = runtimeReportsById.get(node.id);
      if (!report) {
        return node;
      }
      return {
        ...node,
        healthState: runtimeHealthFromDiagnostic(report.probeState),
      };
    }),
  };
};

const defaultProvenanceTier = (
  manifest: AddOnManifest,
  source: AddOnInstallation["source"],
): AddOnInstallation["provenanceTier"] =>
  source === "sideload" ? "sideloaded-unverified" : (manifest.provenance?.tier ?? "sideloaded-unverified");

const defaultVerificationState = (
  manifest: AddOnManifest,
  source: AddOnInstallation["source"],
): AddOnInstallation["verificationState"] =>
  source === "sideload" ? "unverified" : (manifest.provenance?.verificationState ?? "unverified");

const rankLocality = (
  node: ProviderRuntimeNode,
  preferredLocalities: ProviderRoutingPolicyInput["preferredLocalities"],
): number => {
  if (!preferredLocalities?.length) {
    return 0;
  }
  const index = preferredLocalities.indexOf(node.locality);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
};

const rankRuntimeNode = (
  node: ProviderRuntimeNode,
  preferredRuntimeNodeIds: ProviderRoutingPolicyInput["preferredRuntimeNodeIds"],
): number => {
  if (!preferredRuntimeNodeIds?.length) {
    return 0;
  }
  const index = preferredRuntimeNodeIds.indexOf(node.id);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
};

const adapterPolicyForRoute = (
  adapters: ProviderExecutionAdapterPolicy[],
  provider: ProviderProfile,
  node: ProviderRuntimeNode,
): ProviderExecutionAdapterPolicy | undefined =>
  adapters.find(
    (adapter) =>
      adapter.supportedProviderTypes.includes(provider.providerType) &&
      adapter.supportedRuntimeKinds.includes(node.kind) &&
      adapter.supportedAuthMethods.includes(provider.authMethod),
  );

export const resolveProviderRoute = (
  state: Pick<ResonantShellState, "providers" | "runtimeNodes" | "providerRouting">,
  input: ProviderRoutingPolicyInput & {
    primaryProviderProfileId?: string;
    fallbackProviderProfileId?: string;
  },
): ProviderRoutingDecision => {
  const fallbackPolicy =
    state.providerRouting.fallbackPolicies.find((policy) => policy.id === input.fallbackPolicyId) ??
    state.providerRouting.fallbackPolicies[0];
  const allowExperimental =
    input.allowExperimentalAuth ?? fallbackPolicy?.allowExperimentalAuth ?? state.providerRouting.experimentalPolicy.allowOptIn;
  const allowResurrection = input.allowResurrection ?? fallbackPolicy?.allowResurrection ?? false;
  const allowedAuthTiers = input.allowedAuthTiers ?? (allowExperimental ? ["supported", "experimental"] : ["supported"]);
  const allowedAdapterIds = input.allowedAdapterIds;
  const allowedProviderIds = input.allowedProviderProfileIds;

  const orderedProviderIds = [
    ...(input.preferredProviderProfileIds ?? []),
    input.primaryProviderProfileId,
    input.fallbackProviderProfileId,
    ...(fallbackPolicy?.orderedProviderProfileIds ?? []),
  ].filter((value, index, items): value is string => {
    if (typeof value !== "string" || items.indexOf(value) !== index) {
      return false;
    }
    return !allowedProviderIds?.length || allowedProviderIds.includes(value);
  });

  let fallbackUsed = false;
  for (const providerId of orderedProviderIds) {
    const provider = state.providers.find((item) => item.id === providerId);
    if (!provider || provider.status === "missing" || provider.credentialStatus === "missing" || !allowedAuthTiers.includes(provider.authTier)) {
      fallbackUsed = fallbackUsed || providerId !== input.primaryProviderProfileId;
      continue;
    }

    const preferredModels = input.preferredModels?.length ? input.preferredModels : [provider.primaryModel, provider.fallbackModel].filter(Boolean);
    const candidateNodes = state.runtimeNodes
      .filter((node) => node.providerProfileId === provider.id && allowedAuthTiers.includes(node.authTier))
      .filter((node) => !input.allowedRuntimeKinds?.length || input.allowedRuntimeKinds.includes(node.kind))
      .filter(
        (node) =>
          node.healthState === "ready" ||
          node.healthState === "degraded" ||
          (node.healthState === "deployable" && node.deployableOnDemand),
      )
      .sort((left, right) => {
        const runtimeDelta = rankRuntimeNode(left, input.preferredRuntimeNodeIds) - rankRuntimeNode(right, input.preferredRuntimeNodeIds);
        if (runtimeDelta !== 0) {
          return runtimeDelta;
        }
        return rankLocality(left, input.preferredLocalities) - rankLocality(right, input.preferredLocalities);
      });

    for (const node of candidateNodes) {
      const adapterPolicy = adapterPolicyForRoute(state.providerRouting.executionAdapters, provider, node);
      if (!adapterPolicy) {
        continue;
      }
      if (allowedAdapterIds?.length && !allowedAdapterIds.includes(adapterPolicy.id)) {
        continue;
      }
      const matchedPreferredModel = preferredModels.find((candidate) => candidate && node.supportedModels.includes(candidate));
      if (input.preferredModels?.length && !matchedPreferredModel) {
        continue;
      }
      const model = matchedPreferredModel ?? node.supportedModels[0] ?? provider.primaryModel;
      if (!model) {
        continue;
      }
      return {
        providerProfileId: provider.id,
        runtimeNodeId: node.id,
        executionAdapterId: adapterPolicy.id,
        model,
        authTier: provider.authTier,
        usingFallback: fallbackUsed || provider.id !== input.primaryProviderProfileId,
        resolutionReason:
          provider.id === input.primaryProviderProfileId && node.healthState === "ready"
            ? "primary-healthy"
            : "fallback-in-policy",
        fallbackPolicyId: fallbackPolicy?.id,
      };
    }

    fallbackUsed = true;
  }

  if (allowResurrection) {
    const recoveryAction = state.providerRouting.recoveryActions.find((item) => item.prepared);
    const recoveryNode = recoveryAction
      ? state.runtimeNodes.find((node) => node.id === recoveryAction.runtimeNodeId && node.deployableOnDemand)
      : undefined;
    if (recoveryAction && recoveryNode) {
      const recoveryProvider = state.providers.find((item) => item.id === recoveryNode.providerProfileId);
      return {
        providerProfileId: recoveryProvider?.id,
        runtimeNodeId: recoveryNode.id,
        executionAdapterId:
          recoveryProvider
            ? adapterPolicyForRoute(state.providerRouting.executionAdapters, recoveryProvider, recoveryNode)?.id
            : undefined,
        model: recoveryNode.supportedModels[0] ?? recoveryProvider?.primaryModel,
        authTier: recoveryNode.authTier,
        usingFallback: true,
        resolutionReason: "resurrection-available",
        fallbackPolicyId: fallbackPolicy?.id,
        recoveryActionId: recoveryAction.id,
      };
    }
  }

  return {
    authTier: "unavailable",
    usingFallback: true,
    resolutionReason: "no-viable-route",
    fallbackPolicyId: fallbackPolicy?.id,
  };
};

export const createInstallationSnapshot = (
  manifest: AddOnManifest,
  current: AddOnInstallation | undefined,
  source: AddOnInstallation["source"],
): AddOnInstallation => {
  if (current) {
    const isUninstalled = current.status === "uninstalled";
    const currentSnapshot = { ...current };
    if (isUninstalled) {
      delete currentSnapshot.config;
    }
    const existingGrants = new Map(current.grantedCapabilities.map((grant) => [grant.capability, grant]));
    const grantedCapabilities = manifest.requestedCapabilities.map((grant) => ({
      ...grant,
      granted: isUninstalled ? false : (existingGrants.get(grant.capability)?.granted ?? false),
    }));
    return {
      ...currentSnapshot,
      source,
      provenanceTier: source === "sideload" ? "sideloaded-unverified" : (manifest.provenance?.tier ?? current.provenanceTier),
      verificationState: source === "sideload" ? "unverified" : (manifest.provenance?.verificationState ?? current.verificationState),
      grantedCapabilities,
      recommendedGrantPresetIds: (manifest.grantPresets ?? []).map((preset) => preset.id),
      grantRecommendationSource: manifest.grantPresets?.length
        ? "preset-bundle"
        : isUninstalled
          ? "manifest-request"
          : current.grantRecommendationSource,
      privateProviderProfileIds: isUninstalled ? [] : (current.privateProviderProfileIds ?? []),
      ...(isUninstalled ? {} : { config: current.config ?? {} }),
      notes: current.notes ?? [],
    };
  }
  return {
    addonId: manifest.id,
    source,
    provenanceTier: defaultProvenanceTier(manifest, source),
    verificationState: defaultVerificationState(manifest, source),
    installed: false,
    enabled: false,
    status: "available",
    grantedCapabilities: manifest.requestedCapabilities.map((grant) => ({ ...grant, granted: false })),
    recommendedGrantPresetIds: (manifest.grantPresets ?? []).map((preset) => preset.id),
    grantRecommendationSource: manifest.grantPresets?.length ? "preset-bundle" : "manifest-request",
    privateProviderProfileIds: [],
    config: {},
    notes: ["Not installed yet."],
  };
};
