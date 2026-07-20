// Intent citation: docs/architecture/ADR-005-provider-fabric-routing.md
// Intent citation: docs/architecture/ADR-009-rust-service-ipc-boundary.md

import type {
  ProviderCostPosture,
  ProviderExecutionAdapterPolicy,
  ProviderProfile,
  ProviderRoutingDecision,
  ProviderRuntimeNode,
  ResonantShellState,
  StrategyRouteReference,
  WorkloadClass,
  WorkloadStrategy,
} from "./contracts";
import { resolveProviderRoute } from "./policies";

export type ProviderRouteResolution = {
  decision: ProviderRoutingDecision;
  provider?: ProviderProfile;
  runtimeNode?: ProviderRuntimeNode;
  model?: string;
  executionAdapter?: ProviderExecutionAdapterPolicy;
};

const ROUTABLE_RUNTIME_HEALTH: ProviderRuntimeNode["healthState"][] = ["ready", "degraded", "deployable"];
const CANONICAL_CHAT_MODEL_ORDER = [
  "MiniMax-M3",
  "zai/glm-5.2",
  "gpt-5.5",
  "gpt-5.4-mini",
  "batiai/gemma4-e2b:q4",
  "Qwen3.6-35B-A3B-Q4_K_M.gguf",
];

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

const routeCanServeModel = (
  state: ResonantShellState,
  provider: ProviderProfile,
  node: ProviderRuntimeNode,
  model: string,
  allowedRuntimeKinds?: Array<ProviderRuntimeNode["kind"]>,
): boolean =>
  provider.status !== "missing" &&
  node.providerProfileId === provider.id &&
  (node.kind !== "remote-user-owned" || String(node.endpoint ?? "").startsWith("http")) &&
  ROUTABLE_RUNTIME_HEALTH.includes(node.healthState) &&
  (node.healthState !== "deployable" || node.deployableOnDemand) &&
  (!allowedRuntimeKinds?.length || allowedRuntimeKinds.includes(node.kind)) &&
  provider.allowedModels.includes(model) &&
  node.supportedModels.includes(model) &&
  Boolean(adapterPolicyForRoute(state.providerRouting.executionAdapters, provider, node));

const providerIdsForPreferredModel = (
  state: ResonantShellState,
  model: string | undefined,
  allowedRuntimeKinds?: Array<ProviderRuntimeNode["kind"]>,
): string[] => {
  if (!model) {
    return [];
  }
  return state.providers
    .filter((provider) =>
      state.runtimeNodes.some((node) => routeCanServeModel(state, provider, node, model, allowedRuntimeKinds)),
    )
    .map((provider) => provider.id);
};

export const selectableAgentChatModels = (
  state: ResonantShellState,
  agentId: string,
): string[] => {
  const isRecoveryAgent = agentId === state.recoverySession.engineerAgentId;
  const allowedRuntimeKinds: Array<ProviderRuntimeNode["kind"]> = isRecoveryAgent
    ? ["local", "cloud", "remote-user-owned"]
    : ["cloud", "local", "remote-user-owned"];
  const models = state.providers.flatMap((provider) =>
    provider.allowedModels.filter((model) =>
      state.runtimeNodes.some((node) => routeCanServeModel(state, provider, node, model, allowedRuntimeKinds)),
    ),
  );
  const uniqueModels = uniqueValues(models);
  return [
    ...CANONICAL_CHAT_MODEL_ORDER.filter((model) => uniqueModels.includes(model)),
    ...uniqueModels.filter((model) => !CANONICAL_CHAT_MODEL_ORDER.includes(model)),
  ];
};

export const resolveAgentChatRoute = (
  state: ResonantShellState,
  agentId: string,
  preferredModel?: string,
): ProviderRouteResolution => {
  const agent = state.agents.find((item) => item.id === agentId);
  const strategy = strategyForAgent(state, agentId);
  const isRecoveryAgent = agentId === state.recoverySession.engineerAgentId;
  const localRecoveryPinned = agent?.providerProfileId === "shared-local" && !isRecoveryAgent;
  const usingStrategy = Boolean(strategy) && !localRecoveryPinned && agent?.providerProfileId === strategy?.primaryRoute.providerProfileId;
  const decision = usingStrategy && strategy
    ? resolveStrategyRoute(state, strategy, {
        consumerId: agent?.id ?? agentId,
        preferredModel,
        allowedRuntimeKinds: isRecoveryAgent ? ["local", "cloud", "remote-user-owned"] : ["cloud", "local", "remote-user-owned"],
        preferredLocalities: isRecoveryAgent ? ["desktop-local", "cloud", "lan-remote"] : ["cloud", "desktop-local", "lan-remote"],
      })
    : resolveProviderRoute(state, {
        consumerId: agent?.id ?? agentId,
        primaryProviderProfileId: agent?.providerProfileId,
        fallbackProviderProfileId: agent?.fallbackProviderProfileId,
        preferredModels: preferredModel ? [preferredModel] : undefined,
        allowedRuntimeKinds: isRecoveryAgent ? ["local", "cloud", "remote-user-owned"] : localRecoveryPinned ? ["local"] : ["cloud", "local", "remote-user-owned"],
        preferredLocalities: isRecoveryAgent ? ["desktop-local", "cloud", "lan-remote"] : localRecoveryPinned ? ["desktop-local"] : ["cloud", "desktop-local", "lan-remote"],
        fallbackPolicyId: localRecoveryPinned ? "strict-supported-only" : "core-default",
        allowResurrection: true,
      });

  const provider = state.providers.find((profile) => profile.id === decision.providerProfileId);
  const runtimeNode = state.runtimeNodes.find((node) => node.id === decision.runtimeNodeId);
  return {
    decision,
    provider,
    runtimeNode,
    model: decision.model ?? provider?.primaryModel,
    executionAdapter: state.providerRouting.executionAdapters.find((adapter) => adapter.id === decision.executionAdapterId),
  };
};

export const resolveStrategistChatRoute = (
  state: ResonantShellState,
  preferredModel?: string,
): ProviderRouteResolution => resolveAgentChatRoute(state, "strategist.core", preferredModel);

export const resolveWorkloadRoute = (
  state: ResonantShellState,
  workloadClass: WorkloadClass,
  preferredModel?: string,
): ProviderRouteResolution => {
  const strategy = strategyForWorkload(state, workloadClass);
  const decision = strategy
    ? resolveStrategyRoute(state, strategy, {
        consumerId: `workload:${workloadClass}`,
        preferredModel,
        allowedRuntimeKinds: workloadClass === "archive-ingest" ? ["cloud"] : ["cloud", "local", "remote-user-owned"],
        preferredLocalities: workloadClass === "archive-ingest" ? ["cloud"] : ["cloud", "lan-remote", "desktop-local"],
      })
    : resolveProviderRoute(state, {
        consumerId: `workload:${workloadClass}`,
        preferredModels: preferredModel ? [preferredModel] : undefined,
        allowedRuntimeKinds: workloadClass === "archive-ingest" ? ["cloud"] : ["cloud", "local", "remote-user-owned"],
        preferredLocalities: workloadClass === "archive-ingest" ? ["cloud"] : ["cloud", "lan-remote", "desktop-local"],
        fallbackPolicyId: workloadClass === "archive-ingest" ? "core-default" : "core-default",
        allowResurrection: workloadClass !== "archive-ingest",
      });

  const provider = state.providers.find((profile) => profile.id === decision.providerProfileId);
  const runtimeNode = state.runtimeNodes.find((node) => node.id === decision.runtimeNodeId);
  return {
    decision,
    provider,
    runtimeNode,
    model: decision.model ?? provider?.primaryModel,
    executionAdapter: state.providerRouting.executionAdapters.find((adapter) => adapter.id === decision.executionAdapterId),
  };
};

export const resolveArchiveIngestRoute = (
  state: ResonantShellState,
  preferredModel?: string,
): ProviderRouteResolution => resolveWorkloadRoute(state, "archive-ingest", preferredModel);

export const resolveRoutineRoute = (
  state: ResonantShellState,
  preferredModel?: string,
): ProviderRouteResolution => resolveWorkloadRoute(state, "routine", preferredModel);

export const routedProviderLabel = (route: ProviderRouteResolution): string => {
  if (!route.provider) {
    return "Missing";
  }
  return route.runtimeNode ? `${route.provider.label} via ${route.runtimeNode.label}` : route.provider.label;
};

export const assertExecutableProviderRoute = (
  route: ProviderRouteResolution,
  purpose = "provider execution",
): Required<Pick<ProviderRouteResolution, "provider" | "runtimeNode" | "model" | "executionAdapter">> => {
  if (!route.provider || !route.runtimeNode || !route.model) {
    throw new Error(`No routed provider node is currently available for ${purpose}.`);
  }
  if (!route.executionAdapter || !route.decision.executionAdapterId) {
    throw new Error(
      `Provider route for ${purpose} is not executable because no approved execution adapter is available for ${route.provider.label} via ${route.runtimeNode.label}.`,
    );
  }
  return {
    provider: route.provider,
    runtimeNode: route.runtimeNode,
    model: route.model,
    executionAdapter: route.executionAdapter,
  };
};

const strategyForAgent = (state: ResonantShellState, agentId: string): WorkloadStrategy | undefined =>
  state.modelStrategy.workloadStrategies.find((strategy) => strategy.ownerType === "agent" && strategy.ownerId === agentId);

const strategyForWorkload = (state: ResonantShellState, workloadClass: WorkloadClass): WorkloadStrategy | undefined =>
  state.modelStrategy.workloadStrategies.find(
    (strategy) => strategy.ownerType === "workload" && strategy.ownerId === workloadClass,
  );

const expandStrategyRoutes = (state: ResonantShellState, strategy: WorkloadStrategy): StrategyRouteReference[] => {
  const chain = state.modelStrategy.fallbackChains.find((item) => item.id === strategy.fallbackChainId);
  if (!chain) {
    return [strategy.primaryRoute];
  }
  return [
    strategy.primaryRoute,
    ...chain.orderedRoutes,
    ...(chain.lastResortRoute ? [chain.lastResortRoute] : []),
  ];
};

/**
 * Reorders strategy routes based on the active cost posture preference.
 * Preferred-posture routes are sorted to the front; mismatched routes are
 * deprioritized to the back rather than eliminated (fail-open, not fail-closed).
 */
const applyCostPostureOrdering = (
  routes: StrategyRouteReference[],
  activeCostPosture: ProviderCostPosture,
): StrategyRouteReference[] => {
  if (activeCostPosture === "subscription") {
    // Default posture — preserve original strategy ordering.
    return routes;
  }
  if (activeCostPosture === "free-local") {
    // Prefer free-local routes; move paid-api routes to the back.
    const preferred = routes.filter((r) => r.costPosture === "free-local");
    const neutral = routes.filter(
      (r) => !r.costPosture || (r.costPosture !== "free-local" && r.costPosture !== "paid-api"),
    );
    const deprioritized = routes.filter((r) => r.costPosture === "paid-api");
    return [...preferred, ...neutral, ...deprioritized];
  }
  if (activeCostPosture === "emergency-only") {
    // Prefer emergency-only and free-local routes; deprioritize everything else.
    const preferred = routes.filter(
      (r) => r.costPosture === "emergency-only" || r.costPosture === "free-local",
    );
    const deprioritized = routes.filter(
      (r) => r.costPosture !== "emergency-only" && r.costPosture !== "free-local",
    );
    return [...preferred, ...deprioritized];
  }
  // paid-api / unknown posture: no reordering.
  return routes;
};

const resolveStrategyRoute = (
  state: ResonantShellState,
  strategy: WorkloadStrategy,
  options: {
    consumerId: string;
    preferredModel?: string;
    allowedRuntimeKinds?: Array<ProviderRuntimeNode["kind"]>;
    preferredLocalities?: Array<ProviderRuntimeNode["locality"]>;
  },
): ProviderRoutingDecision => {
  const activeCostPosture: ProviderCostPosture = state.uiPreferences.activeCostPosture ?? "subscription";
  const strategyRoutes = applyCostPostureOrdering(expandStrategyRoutes(state, strategy), activeCostPosture);
  const strategyModels = uniqueValues(strategyRoutes.map((route) => route.model));
  const effectivePreferredModel = options.preferredModel && strategyModels.includes(options.preferredModel)
    ? options.preferredModel
    : undefined;
  const preferredModelProviderIds = providerIdsForPreferredModel(
    state,
    effectivePreferredModel,
    options.allowedRuntimeKinds,
  );
  return resolveProviderRoute(state, {
    consumerId: options.consumerId,
    allowedProviderProfileIds: uniqueValues([
      ...strategyRoutes.map((route) => route.providerProfileId),
      ...preferredModelProviderIds,
    ]),
    primaryProviderProfileId: strategy.primaryRoute.providerProfileId,
    fallbackProviderProfileId: strategyRoutes.find((route) => route.providerProfileId !== strategy.primaryRoute.providerProfileId)?.providerProfileId,
    preferredProviderProfileIds: uniqueValues([
      ...preferredModelProviderIds,
      ...strategyRoutes.map((route) => route.providerProfileId),
    ]),
    preferredRuntimeNodeIds: uniqueValues(strategyRoutes.map((route) => route.runtimeNodeId)),
    preferredModels: effectivePreferredModel
      ? [effectivePreferredModel, ...strategyModels]
      : strategyModels,
    allowedRuntimeKinds: options.allowedRuntimeKinds,
    preferredLocalities: options.preferredLocalities,
    fallbackPolicyId: "core-default",
    allowResurrection: !strategy.hardStopWhenNoFallback,
  });
};

const uniqueValues = <T,>(values: Array<T | undefined>): T[] =>
  values.filter((value, index, items): value is T => value !== undefined && items.indexOf(value) === index);
