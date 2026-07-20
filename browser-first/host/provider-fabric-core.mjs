export const providerProfiles = [
  {
    id: "shared-minimax",
    label: "MiniMax",
    providerType: "minimax",
    authType: "api-key",
    models: ["MiniMax-M3"],
    role: "Default Augmentor and agent-control provider",
  },
  {
    id: "shared-zai-glm",
    label: "Z.AI GLM",
    providerType: "openai-compatible",
    templateId: "zai",
    authType: "api-key",
    apiBaseUrl: "http://127.0.0.1:18789/v1",
    models: ["zai/glm-5.2"],
    role: "OpenClaw/Z.AI GLM fallback provider",
  },
  {
    id: "shared-openai",
    label: "OpenAI",
    providerType: "openai",
    authType: "api-key",
    models: ["gpt-5.5", "gpt-5.4-mini"],
    role: "High-reasoning fallback and archive-quality provider",
  },
];

export const modelCatalog = [
  {
    model: "MiniMax-M3",
    label: "MiniMax M3",
    providerId: "shared-minimax",
    providerLabel: "MiniMax",
    runtime: "cloud",
    costTier: "subscription",
    qualityTier: "daily strategic and agentic work",
  },
  {
    model: "zai/glm-5.2",
    label: "Z.AI GLM 5.2",
    providerId: "shared-zai-glm",
    providerLabel: "Z.AI GLM",
    runtime: "cloud",
    costTier: "paid-per-call",
    qualityTier: "general coding fallback",
  },
  {
    model: "gpt-5.5",
    label: "GPT 5.5",
    providerId: "shared-openai",
    providerLabel: "OpenAI",
    runtime: "cloud",
    costTier: "paid-per-call",
    qualityTier: "highest reasoning",
  },
  {
    model: "gpt-5.4-mini",
    label: "GPT 5.4 Mini",
    providerId: "shared-openai",
    providerLabel: "OpenAI",
    runtime: "cloud",
    costTier: "paid-per-call",
    qualityTier: "lightweight high-reasoning fallback",
  },
  {
    model: "batiai/gemma4-e2b:q4",
    label: "Gemma 4 2B",
    providerId: "desktop-local",
    providerLabel: "Desktop Local",
    runtime: "local",
    costTier: "local-free",
    qualityTier: "last resort recovery",
  },
];

export const defaultRoutingStrategies = [
  {
    id: "augmentor-chat",
    label: "Augmentor Chat",
    workload: "trusted_conversation",
    primaryModel: "MiniMax-M3",
    fallbackModels: ["zai/glm-5.2", "gpt-5.5", "gpt-5.4-mini", "batiai/gemma4-e2b:q4"],
    costPosture: "subscription-first",
    hardStop: false,
    notes: "Use fast subscription capacity first, then higher reasoning only when subscription routes fail.",
  },
  {
    id: "agent-control",
    label: "Agent Control",
    workload: "browser_execution",
    primaryModel: "MiniMax-M3",
    fallbackModels: ["zai/glm-5.2", "gpt-5.4-mini", "gpt-5.5"],
    costPosture: "responsive-subscription",
    hardStop: false,
    notes: "Browser control needs a responsive model, but high-cost escalation should remain visible.",
  },
  {
    id: "archive-ingest",
    label: "Archive Ingest",
    workload: "knowledge_promotion",
    primaryModel: "gpt-5.5",
    fallbackModels: ["zai/glm-5.2", "gpt-5.4-mini", "MiniMax-M3"],
    costPosture: "quality-first",
    hardStop: true,
    notes: "Knowledge writes should prefer the strongest verifier route and stop if no trusted model is available.",
  },
  {
    id: "routine-delegation",
    label: "Routine Delegation",
    workload: "delegated_routine_work",
    primaryModel: "MiniMax-M3",
    fallbackModels: ["zai/glm-5.2", "batiai/gemma4-e2b:q4"],
    costPosture: "low-cost-first",
    hardStop: false,
    notes: "Routine background work uses subscription capacity first, then Z.AI GLM before the local floor.",
  },
  {
    id: "recovery-engineer",
    label: "Recovery Engineer",
    workload: "resurrect_mode",
    primaryModel: "MiniMax-M3",
    fallbackModels: ["zai/glm-5.2", "gpt-5.5", "batiai/gemma4-e2b:q4"],
    costPosture: "best-available-in-emergency",
    hardStop: false,
    notes: "Emergency recovery should find the best reachable brain, with Gemma 4 2B as the final local fallback.",
  },
];

export function providerProfileById(providerId) {
  return providerProfiles.find((profile) => profile.id === providerId) ?? null;
}

export function modelById(model) {
  return modelCatalog.find((entry) => entry.model === model) ?? null;
}

export function inferProviderType(providerId) {
  if (providerId === "shared-openai" || String(providerId ?? "").includes("openai")) return "openai";
  if (providerId === "shared-zai-glm" || String(providerId ?? "").toLowerCase().includes("zai")) return "openai-compatible";
  if (providerId === "desktop-local" || String(providerId ?? "").includes("local")) return "openai-compatible";
  return "minimax";
}

export function modelCatalogEntriesForProvider(profile) {
  const providerId = String(profile?.id ?? "").trim();
  const providerLabel = String(profile?.label ?? providerId ?? "Provider");
  const providerType = profile?.providerType ?? inferProviderType(providerId);
  return (profile?.models ?? [])
    .map((entry) => {
      const model = typeof entry === "string" ? entry : entry?.model;
      if (!model) return null;
      const builtIn = modelCatalog.find((catalogEntry) => catalogEntry.model === model);
      return {
        model,
        label: typeof entry === "string" ? (builtIn?.label ?? model) : (entry.label ?? builtIn?.label ?? model),
        providerId,
        providerLabel,
        providerType,
        runtime: typeof entry === "string" ? (builtIn?.runtime ?? "cloud") : (entry.runtime ?? builtIn?.runtime ?? "cloud"),
        costTier: typeof entry === "string" ? (builtIn?.costTier ?? "custom") : (entry.costTier ?? builtIn?.costTier ?? "custom"),
        qualityTier: typeof entry === "string" ? (builtIn?.qualityTier ?? "custom") : (entry.qualityTier ?? builtIn?.qualityTier ?? "custom"),
        wireModel: typeof entry === "string" ? (builtIn?.wireModel ?? model) : (entry.wireModel ?? builtIn?.wireModel ?? model),
      };
    })
    .filter(Boolean);
}

export function allowedModelsForProvider(providerId, preferences = {}, catalog = modelCatalog) {
  const declaredModels = catalog
    .filter((entry) => entry.providerId === providerId)
    .map((entry) => entry.model);
  const configured = Array.isArray(preferences.allowedModels?.[providerId])
    ? preferences.allowedModels[providerId].filter((model) => declaredModels.includes(model))
    : declaredModels;
  return new Set(configured.length ? configured : declaredModels);
}

export function isModelAllowed(model, preferences = {}, catalog = modelCatalog) {
  const catalogEntry = catalog.find((entry) => entry.model === model) ?? null;
  if (!catalogEntry) {
    return false;
  }
  return allowedModelsForProvider(catalogEntry.providerId, preferences, catalog).has(model);
}

export function normalizeFallbackModels(value, catalog = modelCatalog) {
  const allowed = new Set(catalog.map((entry) => entry.model));
  return [...new Set((Array.isArray(value) ? value : String(value ?? "").split(","))
    .map((model) => String(model ?? "").trim())
    .filter((model) => allowed.has(model)))]
    .slice(0, 6);
}

export function normalizeRoutingStrategy(base, override = {}, catalog = modelCatalog) {
  const known = new Set(catalog.map((entry) => entry.model));
  const primaryModel = known.has(override.primaryModel) ? override.primaryModel : base.primaryModel;
  return {
    ...base,
    primaryModel,
    fallbackModels: normalizeFallbackModels(override.fallbackModels ?? base.fallbackModels, catalog)
      .filter((model) => model !== primaryModel),
    costPosture: String(override.costPosture ?? base.costPosture).trim().slice(0, 80) || base.costPosture,
    hardStop: typeof override.hardStop === "boolean" ? override.hardStop : base.hardStop,
  };
}

export function modelRuntimeState(model, { secrets = {}, preferences = {}, localRuntimeUrl = "", catalog = modelCatalog } = {}) {
  const catalogEntry = catalog.find((entry) => entry.model === model) ?? null;
  if (!catalogEntry) {
    return null;
  }
  const allowed = isModelAllowed(model, preferences, catalog);
  const configured = catalogEntry.providerId === "desktop-local"
    ? Boolean(localRuntimeUrl)
    : Boolean(secrets[catalogEntry.providerId]);
  return {
    ...catalogEntry,
    allowed,
    configured: allowed && configured,
    state: !allowed ? "disabled" : configured ? "available" : "unavailable",
  };
}

export function resolveRoutingStrategies({
  secrets = {},
  overrides = {},
  preferences = {},
  localRuntimeUrl = "",
  catalog = modelCatalog,
} = {}) {
  return defaultRoutingStrategies.map((base) => {
    const strategy = normalizeRoutingStrategy(base, overrides[base.id], catalog);
    const chain = [strategy.primaryModel, ...strategy.fallbackModels]
      .map((model) => modelRuntimeState(model, { secrets, preferences, localRuntimeUrl, catalog }))
      .filter(Boolean);
    return {
      ...strategy,
      primary: chain[0] ?? null,
      fallbackChain: chain.slice(1),
      routeState: chain.some((entry) => entry.configured) ? "routable" : "unavailable",
    };
  });
}

export function providerRouteForModel(model, { localRuntimeUrl = "", catalog = modelCatalog, profiles = providerProfiles } = {}) {
  if (model === "__auto__" || model === "auto") {
    return null;
  }
  // A model contributed by a custom (non-built-in) provider account routes to
  // that provider's own endpoint. Checked before the built-in prefix rules so a
  // custom model whose name resembles a built-in (e.g. "gpt-*") is not hijacked
  // to a shared endpoint. Built-in providers fall through to the rules below.
  const dynamicEntry = catalog.find((candidate) => candidate.model === model);
  if (dynamicEntry && !providerProfiles.some((builtIn) => builtIn.id === dynamicEntry.providerId)) {
    const profile = profiles.find((candidate) => candidate.id === dynamicEntry.providerId);
    if (profile?.apiBaseUrl) {
      return {
        providerId: dynamicEntry.providerId,
        providerType: dynamicEntry.providerType ?? profile.providerType ?? "openai-compatible",
        apiBaseUrl: profile.apiBaseUrl,
        wireModel: dynamicEntry.wireModel ?? model,
        label: profile.label ?? dynamicEntry.providerLabel ?? "Provider",
      };
    }
  }
  if (model?.startsWith("batiai/")) {
    return {
      providerId: "desktop-local",
      providerType: "openai-compatible",
      apiBaseUrl: localRuntimeUrl || "http://127.0.0.1:11434/v1",
      wireModel: model,
      label: "Desktop Local",
    };
  }
  if (model?.startsWith("gpt-")) {
    return {
      providerId: "shared-openai",
      providerType: "openai",
      apiBaseUrl: "https://api.openai.com/v1",
      wireModel: model,
      label: "Shared OpenAI",
    };
  }
  if (model === "zai/glm-5.2" || model?.toLowerCase().startsWith("zai/glm")) {
    return {
      providerId: "shared-zai-glm",
      providerType: "openai-compatible",
      apiBaseUrl: "http://127.0.0.1:18789/v1",
      wireModel: model || "zai/glm-5.2",
      label: "Shared Z.AI GLM",
    };
  }
  return {
    providerId: "shared-minimax",
    providerType: "minimax",
    apiBaseUrl: "https://api.minimax.io/v1",
    wireModel: model === "MiniMax-M3" ? "MiniMax-M3" : model || "MiniMax-M3",
    label: "Shared MiniMax",
  };
}

export function providerConnectivityTarget(providerId, { localRuntimeUrl = "" } = {}) {
  if (providerId === "desktop-local") {
    return {
      providerId,
      url: localRuntimeUrl || "http://127.0.0.1:11434/v1/models",
      label: "Desktop Local",
      sendsCredential: false,
    };
  }
  if (providerId === "shared-openai") {
    return {
      providerId,
      url: "https://api.openai.com/v1/models",
      label: "Shared OpenAI",
      sendsCredential: true,
    };
  }
  if (providerId === "shared-zai-glm") {
    return {
      providerId,
      url: "http://127.0.0.1:18789/v1/models",
      label: "Shared Z.AI GLM",
      sendsCredential: true,
    };
  }
  if (providerId === "shared-minimax") {
    return {
      providerId,
      url: "https://api.minimax.io/v1/models",
      label: "Shared MiniMax",
      sendsCredential: true,
    };
  }
  return null;
}

export function providerRouteForWorkload({
  workloadId,
  requestedModel = "",
  secrets = {},
  preferences = {},
  strategies = [],
  localRuntimeUrl = "",
  catalog = modelCatalog,
  profiles = providerProfiles,
} = {}) {
  const explicitModel = String(requestedModel ?? "").trim();
  if (explicitModel && !["__auto__", "auto", "strategy"].includes(explicitModel)) {
    if (!isModelAllowed(explicitModel, preferences, catalog)) {
      return {
        route: null,
        source: "manual",
        strategy: null,
        requestedModel: explicitModel,
        reason: "model-disabled",
      };
    }
    const explicitRoute = providerRouteForModel(explicitModel, { localRuntimeUrl, catalog, profiles });
    return {
      route: explicitRoute,
      source: "manual",
      strategy: null,
      requestedModel: explicitModel,
    };
  }
  const strategy = strategies.find((entry) => entry.id === workloadId || entry.workload === workloadId)
    ?? strategies.find((entry) => entry.id === "augmentor-chat")
    ?? null;
  const chain = [strategy?.primary, ...(strategy?.fallbackChain ?? [])].filter(Boolean);
  const available = chain.find((entry) => entry.configured);
  if (!available) {
    return {
      route: null,
      source: "strategy",
      strategy,
      requestedModel: explicitModel || "__auto__",
    };
  }
  return {
    route: providerRouteForModel(available.model, { localRuntimeUrl, catalog, profiles }),
    source: "strategy",
    strategy,
    requestedModel: explicitModel || "__auto__",
  };
}
