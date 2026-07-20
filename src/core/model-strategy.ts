// Intent citation: docs/architecture/ADR-005-provider-fabric-routing.md

import type {
  ProviderCostPosture,
  ProviderProfile,
  ProviderRuntimeNode,
  ResonantShellState,
  StrategyRouteReference,
  WorkloadStrategy,
} from "./contracts";

export type StrategyRouteOption = StrategyRouteReference & {
  key: string;
  label: string;
  detail: string;
  providerLabel: string;
  runtimeLabel?: string;
  providerStatus: ProviderProfile["status"];
  runtimeHealth?: ProviderRuntimeNode["healthState"];
};

export type WorkloadStrategyPatch = {
  primaryRoute?: StrategyRouteReference;
  fallbackChainId?: string;
  hardStopWhenNoFallback?: boolean;
};

export const routeOptionKey = (route: Pick<StrategyRouteReference, "providerProfileId" | "runtimeNodeId" | "model">): string =>
  [route.providerProfileId, route.runtimeNodeId ?? "provider", route.model].join("::");

export const inferCostPosture = (
  provider: ProviderProfile | undefined,
  runtimeNode: ProviderRuntimeNode | undefined,
): ProviderCostPosture => {
  if (runtimeNode?.id === "node-local-resurrect") {
    return "emergency-only";
  }
  if (runtimeNode?.kind === "local" || runtimeNode?.kind === "remote-user-owned" || provider?.providerType === "local") {
    return "free-local";
  }
  if (provider?.authMethod === "subscription") {
    return "subscription";
  }
  if (provider?.authMethod === "api-key") {
    return "paid-api";
  }
  if (provider?.authSource === "shared-vault") {
    return "subscription";
  }
  return "unknown";
};

export const costPostureLabel = (posture: ProviderCostPosture | undefined): string => {
  if (posture === "free-local") {
    return "Free local";
  }
  if (posture === "subscription") {
    return "Subscription";
  }
  if (posture === "paid-api") {
    return "Paid API";
  }
  if (posture === "emergency-only") {
    return "Emergency only";
  }
  return "Unknown cost";
};

export const buildStrategyRouteOptions = (state: ResonantShellState): StrategyRouteOption[] =>
  state.runtimeNodes.flatMap((runtimeNode) => {
    const provider = state.providers.find((profile) => profile.id === runtimeNode.providerProfileId);
    if (!provider) {
      return [];
    }
    if (runtimeNode.kind === "remote-user-owned" && !String(runtimeNode.endpoint ?? "").startsWith("http")) {
      return [];
    }
    const models = uniqueValues([...runtimeNode.supportedModels, ...provider.allowedModels]);
    return models.map((model) => {
      const costPosture = inferCostPosture(provider, runtimeNode);
      return {
        providerProfileId: provider.id,
        runtimeNodeId: runtimeNode.id,
        model,
        costPosture,
        key: routeOptionKey({ providerProfileId: provider.id, runtimeNodeId: runtimeNode.id, model }),
        label: `${model} · ${provider.label}`,
        detail: `${runtimeNode.label} · ${runtimeNode.kind} · ${runtimeNode.healthState} · ${costPostureLabel(costPosture)}`,
        providerLabel: provider.label,
        runtimeLabel: runtimeNode.label,
        providerStatus: provider.status,
        runtimeHealth: runtimeNode.healthState,
      };
    });
  });

export const routeFromOptionKey = (
  state: ResonantShellState,
  key: string,
): StrategyRouteReference | undefined => {
  const option = buildStrategyRouteOptions(state).find((item) => item.key === key);
  if (!option) {
    return undefined;
  }
  return {
    providerProfileId: option.providerProfileId,
    runtimeNodeId: option.runtimeNodeId,
    model: option.model,
    costPosture: option.costPosture,
  };
};

export const formatStrategyRoute = (state: ResonantShellState, route: StrategyRouteReference): string => {
  const provider = state.providers.find((profile) => profile.id === route.providerProfileId);
  const runtime = state.runtimeNodes.find((node) => node.id === route.runtimeNodeId);
  return `${route.model} · ${provider?.label ?? route.providerProfileId}${runtime ? ` via ${runtime.label}` : ""}`;
};

export const updateWorkloadStrategy = (
  state: ResonantShellState,
  strategyId: string,
  patch: WorkloadStrategyPatch,
): ResonantShellState => ({
  ...state,
  modelStrategy: {
    ...state.modelStrategy,
    workloadStrategies: state.modelStrategy.workloadStrategies.map((strategy) =>
      strategy.id === strategyId ? applyWorkloadStrategyPatch(strategy, patch) : strategy,
    ),
  },
});

const applyWorkloadStrategyPatch = (
  strategy: WorkloadStrategy,
  patch: WorkloadStrategyPatch,
): WorkloadStrategy => ({
  ...strategy,
  primaryRoute: patch.primaryRoute ?? strategy.primaryRoute,
  fallbackChainId: patch.fallbackChainId ?? strategy.fallbackChainId,
  hardStopWhenNoFallback: patch.hardStopWhenNoFallback ?? strategy.hardStopWhenNoFallback,
});

const uniqueValues = <T,>(values: T[]): T[] =>
  values.filter((value, index, items) => items.indexOf(value) === index);
