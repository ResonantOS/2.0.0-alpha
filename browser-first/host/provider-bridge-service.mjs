import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { buildAugmentorChatRequestMessages } from "./augmentor-chat-contract.mjs";
import { runArchiveIngestWriterWithRoute } from "./memory-ingest-writer.mjs";
import {
  defaultRoutingStrategies,
  inferProviderType,
  modelCatalog,
  modelCatalogEntriesForProvider,
  normalizeFallbackModels,
  normalizeRoutingStrategy,
  providerConnectivityTarget,
  providerProfiles,
  providerRouteForModel as providerFabricRouteForModel,
  providerRouteForWorkload as providerFabricRouteForWorkload,
  resolveRoutingStrategies,
} from "./provider-fabric-core.mjs";

export function createProviderBridgeService({
  providerSecretsPath,
  providerAccountsPath,
  providerRoutingPath,
  providerModelPreferencesPath,
  providerDiagnosticsHistoryPath,
  redactDiagnosticText,
  unique,
  extractJsonObject,
} = {}) {
  function assertDependency(name, value) {
    if (!value) {
      throw new Error(`Provider bridge service missing dependency: ${name}`);
    }
  }
  for (const [name, value] of Object.entries({
    providerSecretsPath,
    providerAccountsPath,
    providerRoutingPath,
    providerModelPreferencesPath,
    providerDiagnosticsHistoryPath,
    redactDiagnosticText,
    unique,
    extractJsonObject,
  })) {
    assertDependency(name, value);
  }

  const sessionProviderSecrets = new Map();
  const providerEnvKeys = Object.freeze({
    "shared-minimax": ["MINIMAX_API_KEY"],
    "shared-openai": ["OPENAI_API_KEY"],
    "shared-zai-glm": ["ZAI_API_KEY", "GLM_API_KEY", "ZHIPUAI_API_KEY"],
  });
  const providerTimeoutDefaults = Object.freeze({
    archiveSemantic: 60_000,
    chatAttempt: 90_000,
    inlineAssistant: 30_000,
  });

  function providerTimeoutMs(envName, fallbackMs) {
    const configured = Number(process.env[envName]);
    if (Number.isFinite(configured) && configured > 0) {
      return Math.min(600_000, Math.max(1, Math.floor(configured)));
    }
    return fallbackMs;
  }

  function isAbortError(error) {
    return error?.name === "AbortError";
  }

  async function fetchProviderResponse(url, init, { timeoutMs, label }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function commonEnvProviderSecrets() {
    const entries = [];
    for (const [providerId, envKeys] of Object.entries(providerEnvKeys)) {
      const credential = envKeys
        .map((key) => String(process.env[key] ?? "").trim())
        .find(Boolean);
      if (credential) entries.push([providerId, credential]);
    }
    return Object.fromEntries(entries);
  }

  function envProviderSecrets() {
    const raw = String(process.env.RESONANTOS_PROVIDER_SECRETS_JSON ?? "").trim();
    const common = commonEnvProviderSecrets();
    if (!raw) return common;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("RESONANTOS_PROVIDER_SECRETS_JSON must be a provider-id to credential object.");
    }
    return {
      ...common,
      ...Object.fromEntries(Object.entries(parsed)
        .map(([providerId, credential]) => [String(providerId).trim(), String(credential ?? "").trim()])
        .filter(([providerId, credential]) => providerId && credential)),
    };
  }

  function sessionProviderSecretsObject() {
    return Object.fromEntries(sessionProviderSecrets.entries());
  }

  async function readProviderSecrets() {
    return {
      ...envProviderSecrets(),
      ...sessionProviderSecretsObject(),
    };
  }

  function rememberProviderSecret(providerId, credential) {
    sessionProviderSecrets.set(providerId, credential);
  }

  function forgetProviderSecret(providerId) {
    sessionProviderSecrets.delete(providerId);
  }

  function credentialStoreStatus(secrets) {
    return {
      configured: Object.keys(secrets).length > 0,
      location: "Session-only host memory / environment; no provider secrets are persisted by the alpha host.",
      persistence: "session-only",
      legacyPlaintextDetected: existsSync(providerSecretsPath()),
    };
  }

  function slugifyProviderId(value) {
    return String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 56);
  }

  const localEndpointTemplates = new Set([
    "asus-gx10",
    "dgx-spark",
    "litellm",
    "llama-cpp",
    "lm-studio",
    "localai",
    "ollama",
    "text-generation-webui",
    "vllm",
    "zai",
    "zai-glm",
  ]);

  function isPrivateOrLocalHostname(hostname) {
    const host = String(hostname ?? "").toLowerCase();
    if (!host) return true;
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
    if (host === "::1" || host === "[::1]" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
      const octets = host.split(".").map((part) => Number(part));
      if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
      const [a, b] = octets;
      return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        a === 169 && b === 254 ||
        a === 172 && b >= 16 && b <= 31 ||
        a === 192 && b === 168
      );
    }
    return !host.includes(".");
  }

  function allowsLocalProviderEndpoint(profile = {}) {
    const id = String(profile.id ?? "").toLowerCase();
    const providerType = String(profile.providerType ?? "").toLowerCase();
    const templateId = String(profile.templateId ?? "").toLowerCase();
    const authType = String(profile.authType ?? "").toLowerCase();
    return (
      process.env.RESONANTOS_PROVIDER_ALLOW_LOCAL_ENDPOINTS === "1" ||
      id === "desktop-local" ||
      id === "shared-zai-glm" ||
      authType === "local-runtime" ||
      providerType === "local" ||
      localEndpointTemplates.has(templateId)
    );
  }

  function normalizeProviderEndpointUrl(value, profile = {}, { required = false } = {}) {
    const raw = String(value ?? "").trim();
    if (!raw) {
      if (required) throw new Error("Provider endpoint URL is required.");
      return "";
    }
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new Error("Provider endpoint must be an absolute http or https URL.");
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("Provider endpoint must use http or https.");
    }
    if (url.username || url.password) {
      throw new Error("Provider endpoint must not contain embedded credentials.");
    }
    if (url.search || url.hash) {
      throw new Error("Provider endpoint must not include query strings or fragments.");
    }
    const allowLocal = allowsLocalProviderEndpoint(profile);
    const isLocal = isPrivateOrLocalHostname(url.hostname);
    if (url.protocol !== "https:" && !allowLocal) {
      throw new Error("Provider endpoint must use HTTPS unless it is a known local-runtime provider.");
    }
    const sendsCredential = String(profile.authType ?? "api-key").toLowerCase() !== "none";
    if (sendsCredential && isLocal && !allowLocal) {
      throw new Error("Credential-bearing provider endpoints cannot target local, private, or metadata-network hosts.");
    }
    return url.toString().replace(/\/+$/, "");
  }

  function providerRequestUrl(route, suffix, { sendsCredential = true } = {}) {
    const apiBaseUrl = normalizeProviderEndpointUrl(
      route?.apiBaseUrl,
      { ...route, authType: sendsCredential ? (route?.authType ?? "api-key") : "none" },
      { required: true },
    );
    return `${apiBaseUrl}${suffix}`;
  }

  function providerPreset(rawProviderType, rawTemplateId = rawProviderType) {
    const templateId = String(rawTemplateId ?? rawProviderType ?? "").trim().toLowerCase();
    const type = String(rawProviderType ?? "").trim().toLowerCase();
    if (templateId === "openai" || type === "openai") {
      return {
        providerType: "openai",
        authType: "api-key",
        apiBaseUrl: "https://api.openai.com/v1",
        models: [
          { model: "gpt-5.5", label: "GPT 5.5", runtime: "cloud", costTier: "paid-per-call", qualityTier: "highest reasoning" },
          { model: "gpt-5.4-mini", label: "GPT 5.4 Mini", runtime: "cloud", costTier: "paid-per-call", qualityTier: "lightweight high-reasoning fallback" },
        ],
      };
    }
    const openAiCompatiblePresets = {
      xai: { apiBaseUrl: "https://api.x.ai/v1", models: ["grok-4", "grok-3"] },
      deepseek: { apiBaseUrl: "https://api.deepseek.com/v1", models: ["deepseek-chat", "deepseek-reasoner"] },
      mistral: { apiBaseUrl: "https://api.mistral.ai/v1", models: ["mistral-large-latest", "mistral-small-latest", "open-mixtral"] },
      qwen: { apiBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", models: ["qwen-max", "qwen-plus", "qwen-turbo"] },
      zai: { apiBaseUrl: "http://127.0.0.1:18789/v1", models: ["zai/glm-5.2", "zai/glm-5-turbo", "zai/glm-5.1", "zai/glm-5", "zai/glm-5v-turbo", "zai/glm-4.7", "zai/glm-4.6"] },
      "zai-glm": { apiBaseUrl: "http://127.0.0.1:18789/v1", models: ["zai/glm-5.2"] },
      "nvidia-nim": { apiBaseUrl: "https://integrate.api.nvidia.com/v1", models: ["nvidia/llama-3.1-nemotron-ultra-253b-v1", "nvidia/nemotron"] },
      "microsoft-azure": { apiBaseUrl: "", models: ["azure-model-deployment"] },
      openrouter: { apiBaseUrl: "https://openrouter.ai/api/v1", models: ["openai/gpt-5.5", "anthropic/claude-sonnet-4.5", "google/gemini-2.5-pro"] },
      together: { apiBaseUrl: "https://api.together.xyz/v1", models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "deepseek-ai/DeepSeek-R1"] },
      huggingface: { apiBaseUrl: "", models: ["hf-model-id"] },
      groq: { apiBaseUrl: "https://api.groq.com/openai/v1", models: ["llama-3.3-70b-versatile", "mixtral-8x7b-32768"] },
      fireworks: { apiBaseUrl: "https://api.fireworks.ai/inference/v1", models: ["accounts/fireworks/models/llama-v3p1-70b-instruct"] },
      hyperbolic: { apiBaseUrl: "https://api.hyperbolic.xyz/v1", models: ["meta-llama/Meta-Llama-3.1-70B-Instruct"] },
      "cloudflare-ai-gateway": { apiBaseUrl: "", models: ["gateway-model-id"] },
      litellm: { apiBaseUrl: "http://127.0.0.1:4000/v1", models: ["configured-model-alias"] },
      bifrost: { apiBaseUrl: "", models: ["bifrost-model-alias"] },
      localai: { apiBaseUrl: "http://127.0.0.1:8080/v1", models: ["local-model"] },
      "llama-cpp": { apiBaseUrl: "http://127.0.0.1:8080/v1", models: ["local-model"] },
      vllm: { apiBaseUrl: "http://127.0.0.1:8000/v1", models: ["local-model"] },
      "text-generation-webui": { apiBaseUrl: "http://127.0.0.1:5000/v1", models: ["local-model"] },
      "asus-gx10": { apiBaseUrl: "http://192.168.1.77:30004/v1", models: ["Qwen3.6-35B-A3B-Q4_K_M.gguf"] },
      "openai-compatible": { apiBaseUrl: "", models: ["model-id"] },
    };
    if (openAiCompatiblePresets[templateId] || type === "openai-compatible") {
      const preset = openAiCompatiblePresets[templateId] ?? openAiCompatiblePresets["openai-compatible"];
      return {
        providerType: "openai-compatible",
        authType: "api-key",
        apiBaseUrl: preset.apiBaseUrl,
        models: preset.models.map((model) => ({ model, label: model, runtime: "cloud", costTier: "custom", qualityTier: "custom" })),
      };
    }
    if (templateId === "anthropic" || type === "anthropic") {
      return {
        providerType: "anthropic",
        authType: "api-key",
        apiBaseUrl: "https://api.anthropic.com/v1",
        models: [
          { model: "claude-sonnet-4.5", label: "Claude Sonnet 4.5", runtime: "cloud", costTier: "paid-per-call", qualityTier: "high reasoning" },
          { model: "claude-haiku-4.5", label: "Claude Haiku 4.5", runtime: "cloud", costTier: "paid-per-call", qualityTier: "fast lightweight" },
        ],
      };
    }
    if (templateId === "gemini" || templateId === "google" || type === "gemini" || type === "google") {
      return {
        providerType: "google",
        authType: "api-key",
        apiBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
        models: [
          { model: "gemini-2.5-pro", label: "Gemini 2.5 Pro", runtime: "cloud", costTier: "paid-per-call", qualityTier: "high reasoning" },
          { model: "gemini-2.5-flash", label: "Gemini 2.5 Flash", runtime: "cloud", costTier: "paid-per-call", qualityTier: "fast lightweight" },
          { model: "gemma", label: "Gemma", runtime: "cloud", costTier: "custom", qualityTier: "open model family" },
        ],
      };
    }
    const localPresets = {
      ollama: { apiBaseUrl: "http://127.0.0.1:11434", models: ["batiai/gemma4-e2b:q4"] },
      "lm-studio": { apiBaseUrl: "http://127.0.0.1:1234/v1", models: ["local-model"] },
      "dgx-spark": { apiBaseUrl: "http://dgx-spark.local:11434", models: ["local-model"] },
    };
    if (localPresets[templateId] || type === "local") {
      const preset = localPresets[templateId] ?? localPresets.ollama;
      return {
        providerType: "local",
        authType: "local-runtime",
        apiBaseUrl: preset.apiBaseUrl,
        models: preset.models.map((model) => ({ model, label: model, runtime: "local", costTier: "local-free", qualityTier: "local runtime" })),
      };
    }
    const customPresets = {
      cohere: { apiBaseUrl: "https://api.cohere.com", models: ["command-r-plus", "command-r"] },
      ai21: { apiBaseUrl: "https://api.ai21.com/studio/v1", models: ["jamba-large", "jamba-mini"] },
      replicate: { apiBaseUrl: "https://api.replicate.com", models: ["replicate-model-version"] },
    };
    if (customPresets[templateId] || type === "custom") {
      const preset = customPresets[templateId] ?? { apiBaseUrl: "", models: ["model-id"] };
      return {
        providerType: "custom",
        authType: "api-key",
        apiBaseUrl: preset.apiBaseUrl,
        models: preset.models.map((model) => ({ model, label: model, runtime: "cloud", costTier: "custom", qualityTier: "custom" })),
      };
    }
    return {
      providerType: "minimax",
      authType: "api-key",
      apiBaseUrl: "https://api.minimax.io/v1",
      models: [
        { model: "MiniMax-M3", label: "MiniMax M3", runtime: "cloud", costTier: "subscription", qualityTier: "daily strategic and agentic work", wireModel: "MiniMax-M3" },
      ],
    };
  }

  function normalizeProviderModelEntry(entry, presetModels = []) {
    const rawModel = typeof entry === "string" ? entry : entry?.model;
    const model = String(rawModel ?? "").trim().slice(0, 120);
    if (!model) return null;
    const preset = presetModels.find((candidate) => candidate.model === model) ?? modelCatalog.find((candidate) => candidate.model === model) ?? {};
    return {
      model,
      label: String((typeof entry === "string" ? preset.label : entry?.label) ?? preset.label ?? model).trim().slice(0, 120) || model,
      runtime: String((typeof entry === "string" ? preset.runtime : entry?.runtime) ?? preset.runtime ?? "cloud").trim().slice(0, 40) || "cloud",
      costTier: String((typeof entry === "string" ? preset.costTier : entry?.costTier) ?? preset.costTier ?? "custom").trim().slice(0, 60) || "custom",
      qualityTier: String((typeof entry === "string" ? preset.qualityTier : entry?.qualityTier) ?? preset.qualityTier ?? "custom").trim().slice(0, 100) || "custom",
      wireModel: String((typeof entry === "string" ? preset.wireModel : entry?.wireModel) ?? preset.wireModel ?? model).trim().slice(0, 120) || model,
    };
  }

  function normalizeProviderAccount(raw, existingProfiles = []) {
    const preset = providerPreset(raw?.providerType, raw?.templateId);
    const templateId = String(raw?.templateId ?? preset.providerType).trim().slice(0, 80);
    const label = String(raw?.label ?? raw?.name ?? "").trim().slice(0, 80);
    if (!label) {
      throw new Error("Provider account name is required.");
    }
    const suppliedId = slugifyProviderId(raw?.id);
    const baseId = suppliedId || slugifyProviderId(`${preset.providerType}-${label}`) || `${preset.providerType}-account`;
    const existingIds = new Set(existingProfiles.map((profile) => profile.id));
    let id = baseId;
    if (!suppliedId) {
      let suffix = 2;
      while (existingIds.has(id)) {
        id = `${baseId}-${suffix++}`;
      }
    }
    const modelSource = Array.isArray(raw?.models) && raw.models.length ? raw.models : preset.models;
    const models = unique(modelSource
      .map((entry) => normalizeProviderModelEntry(entry, preset.models))
      .filter(Boolean)
      .map((entry) => JSON.stringify(entry)))
      .map((entry) => JSON.parse(entry));
    if (!models.length) {
      throw new Error("At least one model must be declared for a provider account.");
    }
    const authType = String(raw?.authType ?? preset.authType).trim().slice(0, 40) || "api-key";
    const rawEndpoint = String(raw?.apiBaseUrl ?? "").trim();
    const allowsCustomEndpoint = ["custom", "local", "openai-compatible"].includes(preset.providerType);
    if (rawEndpoint && !allowsCustomEndpoint && rawEndpoint !== preset.apiBaseUrl) {
      throw new Error(`${preset.providerType} provider accounts must use the built-in provider endpoint.`);
    }
    const endpointProfile = {
      id,
      label,
      providerType: preset.providerType,
      templateId,
      authType,
    };
    return {
      id,
      label,
      providerType: preset.providerType,
      templateId,
      authType,
      apiBaseUrl: normalizeProviderEndpointUrl(rawEndpoint || preset.apiBaseUrl, endpointProfile).slice(0, 240),
      role: String(raw?.role ?? `${label} model account`).trim().slice(0, 160) || `${label} model account`,
      models,
      source: raw?.source === "built-in" ? "built-in" : "user",
    };
  }

  async function readProviderAccounts() {
    const filePath = providerAccountsPath();
    if (!existsSync(filePath)) {
      return [];
    }
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
    return accounts.map((account) => normalizeProviderAccount(account, providerProfiles)).filter(Boolean);
  }

  async function writeProviderAccounts(accounts) {
    const filePath = providerAccountsPath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify({ accounts }, null, 2)}\n`, { mode: 0o600 });
    await chmod(filePath, 0o600).catch(() => undefined);
  }

  async function allProviderProfiles() {
    const customAccounts = await readProviderAccounts().catch(() => []);
    const builtIns = providerProfiles.map((profile) => {
      const providerType = profile.providerType ?? inferProviderType(profile.id);
      const preset = providerPreset(providerType, profile.templateId ?? profile.id);
      return {
        ...profile,
        providerType,
        apiBaseUrl: profile.apiBaseUrl ?? preset.apiBaseUrl,
        source: "built-in",
      };
    });
    const byId = new Map(builtIns.map((profile) => [profile.id, profile]));
    for (const account of customAccounts) {
      byId.set(account.id, { ...byId.get(account.id), ...account, source: account.source === "built-in" ? "built-in-customized" : "user" });
    }
    return [...byId.values()];
  }

  async function allModelCatalog() {
    const profiles = await allProviderProfiles();
    const dynamicEntries = profiles.flatMap((profile) => modelCatalogEntriesForProvider(profile));
    const byProviderModel = new Map();
    for (const entry of [...modelCatalog, ...dynamicEntries]) {
      byProviderModel.set(`${entry.providerId}:${entry.model}`, entry);
    }
    return [...byProviderModel.values()];
  }

  async function providerProfileByIdDynamic(providerId) {
    return (await allProviderProfiles()).find((profile) => profile.id === providerId) ?? null;
  }

  function isModelAllowedForProviderModel(providerId, model, preferences = {}, catalog = modelCatalog) {
    const declaredModels = catalog
      .filter((entry) => entry.providerId === providerId)
      .map((entry) => entry.model);
    if (!declaredModels.includes(model)) {
      return false;
    }
    const configured = Array.isArray(preferences.allowedModels?.[providerId])
      ? preferences.allowedModels[providerId].filter((entry) => declaredModels.includes(entry))
      : declaredModels;
    return new Set(configured.length ? configured : declaredModels).has(model);
  }

  function providerModelRuntimeState(entry, { secrets = {}, preferences = {}, localRuntimeUrl = "", catalog = modelCatalog } = {}) {
    const allowed = isModelAllowedForProviderModel(entry.providerId, entry.model, preferences, catalog);
    const configured = entry.providerId === "desktop-local"
      ? Boolean(localRuntimeUrl)
      : Boolean(secrets[entry.providerId]);
    return {
      ...entry,
      allowed,
      configured: allowed && configured,
      state: !allowed ? "disabled" : configured ? "available" : "unavailable",
    };
  }

  async function readRoutingOverrides() {
    const filePath = providerRoutingPath();
    if (!existsSync(filePath)) {
      return {};
    }
    return JSON.parse(await readFile(filePath, "utf8"));
  }

  async function readProviderModelPreferences() {
    const filePath = providerModelPreferencesPath();
    if (!existsSync(filePath)) {
      return {};
    }
    return JSON.parse(await readFile(filePath, "utf8"));
  }

  async function readProviderDiagnosticsHistory() {
    const filePath = providerDiagnosticsHistoryPath();
    if (!existsSync(filePath)) {
      return [];
    }
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  }

  async function appendProviderDiagnosticHistory(entry) {
    const safeEntry = {
      providerId: String(entry.providerId ?? ""),
      label: String(entry.label ?? ""),
      testedAt: String(entry.testedAt ?? new Date().toISOString()),
      state: String(entry.state ?? "unknown"),
      status: typeof entry.status === "number" ? entry.status : null,
      latencyMs: typeof entry.latencyMs === "number" ? entry.latencyMs : null,
      endpoint: String(entry.endpoint ?? "provider endpoint"),
      detail: redactDiagnosticText(entry.detail),
    };
    const current = await readProviderDiagnosticsHistory().catch(() => []);
    const next = [safeEntry, ...current].slice(0, 30);
    const filePath = providerDiagnosticsHistoryPath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify({ entries: next }, null, 2)}\n`, { mode: 0o600 });
    await chmod(filePath, 0o600).catch(() => undefined);
    return safeEntry;
  }

  async function resolvedRoutingStrategies() {
    const [secrets, overrides, preferences, catalog] = await Promise.all([
      readProviderSecrets(),
      readRoutingOverrides().catch(() => ({})),
      readProviderModelPreferences().catch(() => ({})),
      allModelCatalog(),
    ]);
    return resolveRoutingStrategies({
      secrets,
      overrides,
      preferences,
      catalog,
      localRuntimeUrl: process.env.RESONANTOS_LOCAL_RUNTIME_URL,
    });
  }

  async function executeProviderStatus() {
    const [secrets, preferences, strategies, profiles, catalog] = await Promise.all([
      readProviderSecrets(),
      readProviderModelPreferences().catch(() => ({})),
      resolvedRoutingStrategies(),
      allProviderProfiles(),
      allModelCatalog(),
    ]);
    return {
      vault: {
        ...credentialStoreStatus(secrets),
      },
      providers: profiles.map((profile) => ({
        ...profile,
        models: catalog
          .filter((entry) => entry.providerId === profile.id)
          .map((entry) => ({
            model: entry.model,
            label: entry.label,
            runtime: entry.runtime,
            costTier: entry.costTier,
            qualityTier: entry.qualityTier,
            allowed: isModelAllowedForProviderModel(profile.id, entry.model, preferences, catalog),
          })),
        routeConsumers: strategies
          .filter((strategy) =>
            [strategy.primary, ...(strategy.fallbackChain ?? [])]
              .some((entry) => entry?.providerId === profile.id)
          )
          .map((strategy) => ({
            id: strategy.id,
            label: strategy.label,
            workload: strategy.workload,
            routeState: strategy.routeState,
            hardStop: strategy.hardStop,
          })),
        configured: Boolean(secrets[profile.id]),
        credentialPreview: secrets[profile.id] ? "session" : "missing",
      })),
    };
  }

  async function executeProviderHealthCheck(payload) {
    const providerId = String(payload.providerId ?? "").trim();
    const profile = await providerProfileByIdDynamic(providerId);
    if (!profile) {
      throw new Error("Unknown provider profile.");
    }
    const [secrets, preferences, strategies, catalog] = await Promise.all([
      readProviderSecrets(),
      readProviderModelPreferences().catch(() => ({})),
      resolvedRoutingStrategies(),
      allModelCatalog(),
    ]);
    const models = catalog.filter((entry) => entry.providerId === providerId);
    const configured = Boolean(secrets[providerId]);
    const routeConsumers = strategies.filter((strategy) =>
      [strategy.primary, ...(strategy.fallbackChain ?? [])]
        .some((entry) => entry?.providerId === providerId)
    );
    const blockedConsumers = routeConsumers.filter((strategy) => strategy.routeState !== "routable");
    const availableModels = models.filter((entry) => providerModelRuntimeState(entry, {
      secrets,
      preferences,
      catalog,
      localRuntimeUrl: process.env.RESONANTOS_LOCAL_RUNTIME_URL,
    })?.configured);
    const allowedModels = models.filter((entry) => isModelAllowedForProviderModel(providerId, entry.model, preferences, catalog));
    const state = configured && availableModels.length
      ? (blockedConsumers.length ? "degraded" : "ready")
      : configured && !allowedModels.length
        ? "disabled"
      : "missing-credential";
    return {
      providerId,
      label: profile.label,
      checkedAt: new Date().toISOString(),
      state,
      configured,
      models: models.map((entry) => ({
        model: entry.model,
        label: entry.label,
        runtime: entry.runtime,
        allowed: isModelAllowedForProviderModel(providerId, entry.model, preferences, catalog),
        configured: Boolean(providerModelRuntimeState(entry, {
          secrets,
          preferences,
          catalog,
          localRuntimeUrl: process.env.RESONANTOS_LOCAL_RUNTIME_URL,
        })?.configured),
      })),
      routeConsumers: routeConsumers.map((strategy) => ({
        id: strategy.id,
        label: strategy.label,
        routeState: strategy.routeState,
        hardStop: strategy.hardStop,
      })),
      detail: state === "ready"
        ? `${profile.label} is configured and available to all dependent routing strategies.`
        : state === "degraded"
          ? `${profile.label} is configured, but one or more dependent routing strategies still have no available route.`
          : state === "disabled"
            ? `${profile.label} is configured, but all declared models are disabled by the current allowed-model policy.`
          : `${profile.label} has no active credential in the session-only credential store.`,
    };
  }

  async function executeProviderConnectivityTest(payload) {
    const providerId = String(payload.providerId ?? "").trim();
    const profile = await providerProfileByIdDynamic(providerId);
    if (!profile) {
      throw new Error("Unknown provider profile.");
    }
    const secrets = await readProviderSecrets();
    const credential = secrets[providerId];
    if (!credential) {
      const result = {
        providerId,
        label: profile.label,
        testedAt: new Date().toISOString(),
        state: "missing-credential",
        endpoint: "provider models endpoint",
        detail: `${profile.label} cannot be tested because no active credential is stored in the session-only credential store.`,
      };
      await appendProviderDiagnosticHistory(result);
      return result;
    }
    const target = providerConnectivityTarget(providerId, {
      localRuntimeUrl: process.env.RESONANTOS_LOCAL_RUNTIME_URL,
    }) ?? (profile.apiBaseUrl ? {
      providerId,
      url: `${String(profile.apiBaseUrl).replace(/\/$/, "")}/models`,
      label: profile.label,
      sendsCredential: profile.authType !== "none",
    } : null);
    if (!target) {
      throw new Error("No connectivity diagnostic target exists for this provider.");
    }
    const targetUrl = normalizeProviderEndpointUrl(
      target.url,
      { ...profile, id: target.providerId, authType: target.sendsCredential ? (profile.authType ?? "api-key") : "none" },
      { required: true },
    );
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch(targetUrl, {
        method: "GET",
        headers: target.sendsCredential ? { Authorization: `Bearer ${credential}` } : {},
        signal: controller.signal,
      });
      const latencyMs = Date.now() - startedAt;
      const state = response.ok ? "reachable" : response.status === 401 || response.status === 403 ? "auth-failed" : "unreachable";
      const result = {
        providerId,
        label: profile.label,
        testedAt: new Date().toISOString(),
        state,
        status: response.status,
        latencyMs,
        endpoint: "provider models endpoint",
        detail: state === "reachable"
          ? `${profile.label} endpoint is reachable. No prompt or model generation request was sent.`
          : state === "auth-failed"
            ? `${profile.label} endpoint responded, but authentication failed. Update the stored credential.`
            : `${profile.label} endpoint responded with HTTP ${response.status}.`,
      };
      await appendProviderDiagnosticHistory(result);
      return result;
    } catch (error) {
      const result = {
        providerId,
        label: profile.label,
        testedAt: new Date().toISOString(),
        state: "network-failed",
        latencyMs: Date.now() - startedAt,
        endpoint: "provider models endpoint",
        detail: redactDiagnosticText(error instanceof Error ? error.message : String(error)),
      };
      await appendProviderDiagnosticHistory(result);
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function executeProviderDiagnosticsHistory() {
    return {
      entries: await readProviderDiagnosticsHistory(),
    };
  }

  async function executeProviderModelPreferencesSave(payload) {
    const providerId = String(payload.providerId ?? "").trim();
    const profile = await providerProfileByIdDynamic(providerId);
    if (!profile) {
      throw new Error("Unknown provider profile.");
    }
    const catalog = await allModelCatalog();
    const declaredModels = catalog
      .filter((entry) => entry.providerId === providerId)
      .map((entry) => entry.model);
    const allowedModels = unique((Array.isArray(payload.allowedModels) ? payload.allowedModels : [])
      .map((model) => String(model ?? "").trim())
      .filter((model) => declaredModels.includes(model)));
    if (!allowedModels.length) {
      throw new Error("At least one model must remain allowed for this provider.");
    }
    const current = await readProviderModelPreferences().catch(() => ({}));
    const next = {
      ...current,
      allowedModels: {
        ...(current.allowedModels ?? {}),
        [providerId]: allowedModels,
      },
    };
    const filePath = providerModelPreferencesPath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await chmod(filePath, 0o600).catch(() => undefined);
    return {
      providerId,
      allowedModels,
      savedAt: new Date().toISOString(),
      strategies: await resolvedRoutingStrategies(),
    };
  }

  async function executeProviderRoutingStrategies() {
    return {
      updatedAt: new Date().toISOString(),
      models: await allModelCatalog(),
      strategies: await resolvedRoutingStrategies(),
    };
  }

  async function executeProviderRoutingStrategySave(payload) {
    const strategyId = String(payload.strategyId ?? "").trim();
    const base = defaultRoutingStrategies.find((strategy) => strategy.id === strategyId);
    if (!base) {
      throw new Error("Unknown routing strategy.");
    }
    const catalog = await allModelCatalog();
    const next = normalizeRoutingStrategy(base, {
      primaryModel: String(payload.primaryModel ?? "").trim(),
      fallbackModels: payload.fallbackModels,
      costPosture: payload.costPosture,
      hardStop: Boolean(payload.hardStop),
    }, catalog);
    const current = await readRoutingOverrides().catch(() => ({}));
    const filePath = providerRoutingPath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify({ ...current, [strategyId]: next }, null, 2)}\n`, { mode: 0o600 });
    await chmod(filePath, 0o600).catch(() => undefined);
    return {
      strategyId,
      savedAt: new Date().toISOString(),
      strategies: await resolvedRoutingStrategies(),
    };
  }

  async function executeProviderCredentialSave(payload) {
    const providerId = String(payload.providerId ?? "").trim();
    const credential = String(payload.credential ?? "").trim();
    const profile = await providerProfileByIdDynamic(providerId);
    if (!profile) {
      throw new Error("Unknown provider profile.");
    }
    if (credential.length < 8) {
      throw new Error("Credential is too short to save.");
    }
    rememberProviderSecret(providerId, credential);
    return {
      providerId,
      configured: true,
      persistence: "session-only",
      savedAt: new Date().toISOString(),
    };
  }

  async function executeProviderAccountSave(payload) {
    const mode = String(payload.mode ?? (payload.id ? "update" : "create")).trim().toLowerCase();
    const existingCustom = await readProviderAccounts().catch(() => []);
    const profiles = await allProviderProfiles();
    const existing = payload.id ? profiles.find((profile) => profile.id === String(payload.id).trim()) : null;
    if (mode === "update" && !existing) {
      throw new Error("Unknown provider account.");
    }
    const base = existing ? { ...existing, ...payload } : payload;
    const normalized = normalizeProviderAccount(base, profiles.filter((profile) => profile.id !== String(payload.id ?? "")));
    const nextCustom = [
      ...existingCustom.filter((account) => account.id !== normalized.id),
      normalized,
    ].sort((left, right) => left.label.localeCompare(right.label));
    await writeProviderAccounts(nextCustom);
    const credential = String(payload.credential ?? "").trim();
    if (credential) {
      if (credential.length < 8) {
        throw new Error("Credential is too short to save.");
      }
      rememberProviderSecret(normalized.id, credential);
    }
    return {
      provider: normalized,
      savedAt: new Date().toISOString(),
      persistence: "session-only",
      configured: Boolean(credential || (await readProviderSecrets())[normalized.id]),
    };
  }

  async function executeProviderAccountRemove(payload) {
    const providerId = String(payload.providerId ?? payload.id ?? "").trim();
    if (!providerId) {
      throw new Error("A provider id is required to remove an account.");
    }
    if (providerProfiles.some((builtIn) => builtIn.id === providerId)) {
      throw new Error("Built-in provider profiles cannot be removed.");
    }
    const existingCustom = await readProviderAccounts().catch(() => []);
    if (!existingCustom.some((account) => account.id === providerId)) {
      throw new Error("Unknown provider account.");
    }
    // Models this provider contributed — so we can drop any routing override that
    // pinned one of them as a strategy primary. Without this, a stale primary
    // could silently resurrect if a provider with the same id were re-added.
    const removedModels = new Set(
      (await allModelCatalog()).filter((entry) => entry.providerId === providerId).map((entry) => entry.model),
    );
    const nextCustom = existingCustom.filter((account) => account.id !== providerId);
    await writeProviderAccounts(nextCustom);
    forgetProviderSecret(providerId);

    const overrides = await readRoutingOverrides().catch(() => ({}));
    const cleanedOverrides = Object.fromEntries(
      Object.entries(overrides)
        .filter(([, override]) => !removedModels.has(override?.primaryModel))
        .map(([id, override]) => [
          id,
          Array.isArray(override?.fallbackModels)
            ? { ...override, fallbackModels: override.fallbackModels.filter((entry) => !removedModels.has(entry)) }
            : override,
        ]),
    );
    if (JSON.stringify(cleanedOverrides) !== JSON.stringify(overrides)) {
      const filePath = providerRoutingPath();
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, `${JSON.stringify(cleanedOverrides, null, 2)}\n`, { mode: 0o600 });
      await chmod(filePath, 0o600).catch(() => undefined);
    }

    return {
      removed: providerId,
      removedAt: new Date().toISOString(),
      providers: await allProviderProfiles(),
      strategies: await resolvedRoutingStrategies(),
    };
  }

  function sanitizeAssistantContent(providerType, content) {
    if (providerType !== "minimax") {
      return String(content ?? "").trim();
    }
    return String(content ?? "")
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .trim();
  }

  function openAiReasoningEffort(value, fallback = "none") {
    const normalized = String(value ?? fallback).trim().toLowerCase();
    if (normalized === "minimal") return "none";
    return ["none", "low", "medium", "high", "xhigh"].includes(normalized) ? normalized : fallback;
  }

  function providerRouteForModel(model, extra = {}) {
    return providerFabricRouteForModel(model, {
      localRuntimeUrl: process.env.RESONANTOS_LOCAL_RUNTIME_URL,
      ...extra,
    });
  }

  async function providerRouteForWorkload(workloadId, requestedModel = "") {
    const [secrets, preferences, strategies, catalog, profiles] = await Promise.all([
      readProviderSecrets(),
      readProviderModelPreferences().catch(() => ({})),
      resolvedRoutingStrategies(),
      allModelCatalog(),
      allProviderProfiles(),
    ]);
    return providerFabricRouteForWorkload({
      workloadId,
      requestedModel,
      secrets,
      preferences,
      strategies,
      catalog,
      profiles,
      localRuntimeUrl: process.env.RESONANTOS_LOCAL_RUNTIME_URL,
    });
  }

  function providerRouteForArchiveVerifier(secrets, requestedModel = "", { catalog, profiles } = {}) {
    if (requestedModel) {
      const requestedRoute = providerRouteForModel(requestedModel, { catalog, profiles });
      return secrets[requestedRoute.providerId] ? requestedRoute : null;
    }
    const openAiRoute = providerRouteForModel("gpt-5.5");
    if (secrets[openAiRoute.providerId]) {
      return openAiRoute;
    }
    const zaiGlmRoute = providerRouteForModel("zai/glm-5.2");
    if (secrets[zaiGlmRoute.providerId]) {
      return zaiGlmRoute;
    }
    const miniMaxRoute = providerRouteForModel("MiniMax-M3");
    return secrets[miniMaxRoute.providerId] ? miniMaxRoute : null;
  }

  function extractAssistantContent(payload) {
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((part) => part?.text ?? part?.content ?? "")
        .filter(Boolean)
        .join("\n");
    }
    return "";
  }

  async function runArchiveSemanticVerifier({ artifactPath, requestPath, sourceContent, proposedPage, proposedContent, requestedModel }) {
    const [secrets, catalog, profiles] = await Promise.all([
      readProviderSecrets(),
      allModelCatalog(),
      allProviderProfiles(),
    ]);
    const route = providerRouteForArchiveVerifier(secrets, requestedModel, { catalog, profiles });
    if (!route) {
      return {
        semanticStatus: "unavailable",
        semanticSummary: "No configured provider was available for semantic archive verification.",
        semanticFindings: [],
        providerId: "",
        model: "",
        usage: null,
      };
    }
    const systemPrompt = [
      "You are the ResonantOS Living Archive semantic verifier.",
      "Return strict JSON only. Do not include markdown.",
      "Your job is to challenge a draft wiki update before it enters trusted AI Memory.",
      "Check whether the proposed content is grounded in the source, whether it overclaims, loses important caveats, or creates misleading synthesis.",
      "Do not rewrite the page. Only verify it.",
      "Return JSON schema: {\"status\":\"verified|needs-revision\", \"summary\":\"short\", \"findings\":[\"...\"]}",
    ].join("\n");
    const userPrompt = JSON.stringify({
      artifactPath,
      requestPath,
      proposedPage,
      sourceExcerpt: String(sourceContent ?? "").slice(0, 10_000),
      proposedContent: String(proposedContent ?? "").slice(0, 10_000),
    });
    try {
      const response = await fetchProviderResponse(
        providerRequestUrl(route, "/chat/completions"),
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${secrets[route.providerId]}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: route.wireModel,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            ...(route.providerType === "openai" ? { reasoning_effort: openAiReasoningEffort("minimal"), response_format: { type: "json_object" } } : {}),
          }),
        },
        {
          timeoutMs: providerTimeoutMs("RESONANTOS_PROVIDER_ARCHIVE_TIMEOUT_MS", providerTimeoutDefaults.archiveSemantic),
          label: `${route.wireModel} semantic verifier request`,
        },
      );
      const responsePayload = await response.json().catch(() => ({}));
      if (!response.ok) {
        return {
          semanticStatus: "unavailable",
          semanticSummary: responsePayload?.error?.message ?? `Semantic verifier failed with HTTP ${response.status}.`,
          semanticFindings: [],
          providerId: route.providerId,
          model: route.wireModel,
          usage: responsePayload?.usage ?? null,
        };
      }
      const content = sanitizeAssistantContent(route.providerType, extractAssistantContent(responsePayload));
      const parsed = extractJsonObject(content);
      const status = String(parsed.status ?? "").toLowerCase() === "needs-revision" ? "needs-revision" : "verified";
      return {
        semanticStatus: status,
        semanticSummary: String(parsed.summary ?? (status === "verified" ? "Semantic verifier found no blocking issue." : "Semantic verifier requested revision.")).slice(0, 800),
        semanticFindings: Array.isArray(parsed.findings)
          ? parsed.findings.map((finding) => String(finding).trim()).filter(Boolean).slice(0, 8)
          : [],
        providerId: route.providerId,
        model: route.wireModel,
        usage: responsePayload?.usage ?? null,
      };
    } catch (error) {
      return {
        semanticStatus: "unavailable",
        semanticSummary: error instanceof Error ? error.message : String(error),
        semanticFindings: [],
        providerId: route.providerId,
        model: route.wireModel,
        usage: null,
      };
    }
  }

  async function runArchiveIngestWriter({
    sourceContent,
    sourcePath,
    sourceTitle,
    proposedPage,
    requestPath,
    existingIndex,
    requestedModel,
    deterministicContent,
  }) {
    const [secrets, catalog, profiles] = await Promise.all([
      readProviderSecrets(),
      allModelCatalog(),
      allProviderProfiles(),
    ]);
    const route = providerRouteForArchiveVerifier(secrets, requestedModel, { catalog, profiles });
    return runArchiveIngestWriterWithRoute({
      sourceContent,
      sourcePath,
      sourceTitle,
      proposedPage,
      requestPath,
      existingIndex,
      route,
      credential: route ? secrets[route.providerId] : "",
      deterministicContent,
    });
  }

  function decodeXmlEntities(value) {
    return String(value ?? "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  async function executeBridgeChat(payload) {
    const routeDecision = await providerRouteForWorkload(payload.workload || "augmentor-chat", payload.model);
    if (!routeDecision.route) {
      if (routeDecision.source === "manual" && routeDecision.requestedModel) {
        // Manual selection is preserved: report that the chosen model is
        // unavailable (disabled by the allowed-model policy or not in the catalog)
        // instead of silently swapping to another model.
        throw new Error(`The selected model "${routeDecision.requestedModel}" is unavailable — it is disabled by the allowed-model policy or not in the catalog. Pick another model, or enable it in Settings > Providers.`);
      }
      const label = routeDecision.strategy?.label ?? "Augmentor Chat";
      throw new Error(`${label} has no available provider route. Add a provider credential, configure a local runtime, or change the routing strategy in Settings > Routing.`);
    }
    const [secrets, catalog, profiles] = await Promise.all([
      readProviderSecrets(),
      allModelCatalog(),
      allProviderProfiles(),
    ]);
    const requestMessages = buildAugmentorChatRequestMessages(payload);
    const strategyChain = routeDecision.source === "strategy"
      ? [routeDecision.strategy?.primary, ...(routeDecision.strategy?.fallbackChain ?? [])].filter((entry) => entry?.configured)
      : [];
    // Each attempt carries the strategy model it came from, so a fallback is
    // detected by comparing the model that ANSWERED against the strategy's
    // declared primary — not by whether an earlier attempt errored. The primary
    // is filtered out of the chain above when it is unconfigured/disabled, so a
    // failure count would miss that (the most common) silent-swap case (#231).
    const attempts = routeDecision.source === "strategy" && strategyChain.length
      ? strategyChain.map((entry) => ({ model: entry.model, route: providerRouteForModel(entry.model, { catalog, profiles }) }))
      : [{ model: routeDecision.requestedModel ?? null, route: routeDecision.route }];
    const seenRoutes = new Set();
    const uniqueAttempts = attempts.filter(({ route }) => {
      if (!route) return false;
      const key = `${route.providerId}:${route.wireModel}`;
      if (seenRoutes.has(key)) return false;
      seenRoutes.add(key);
      return true;
    });
    const failures = [];
    for (const { model: attemptModel, route } of uniqueAttempts) {
      const apiKey = route.providerId === "desktop-local" ? "local-runtime" : secrets[route.providerId];
      if (!apiKey) {
        if (routeDecision.source !== "strategy") {
          // A manually selected, catalog-valid model whose provider has no
          // credential: name it and point to recovery, instead of the generic
          // exhausted-route error.
          throw new Error(`The selected model "${routeDecision.requestedModel ?? route.wireModel}" has no active provider credential. Add it in Settings > Providers, or pick another model.`);
        }
        failures.push(`${route.label} credential missing`);
        continue;
      }
      let response;
      try {
        response = await fetchProviderResponse(
          providerRequestUrl(route, "/chat/completions", { sendsCredential: route.providerId !== "desktop-local" }),
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: route.wireModel,
              messages: requestMessages,
              ...(route.providerType === "openai" ? { reasoning_effort: openAiReasoningEffort(payload.thinkingDepth) } : {}),
            }),
          },
          {
            timeoutMs: providerTimeoutMs("RESONANTOS_PROVIDER_CHAT_TIMEOUT_MS", providerTimeoutDefaults.chatAttempt),
            label: `${route.wireModel} chat request`,
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${route.wireModel}: ${message}`);
        if (routeDecision.source !== "strategy") {
          throw new Error(message);
        }
        continue;
      }
      const responsePayload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = responsePayload?.error?.message ?? `Provider request failed with HTTP ${response.status}.`;
        failures.push(`${route.wireModel}: ${message}`);
        if (routeDecision.source !== "strategy") {
          throw new Error(message);
        }
        continue;
      }
      const reply = sanitizeAssistantContent(route.providerType, extractAssistantContent(responsePayload));
      if (!reply) {
        failures.push(`${route.wireModel}: Provider returned an empty reply.`);
        if (routeDecision.source !== "strategy") {
          throw new Error("Provider returned an empty reply.");
        }
        continue;
      }
      // A fallback occurred when the strategy model that ANSWERED is not the
      // strategy's declared primary — whether the primary was unconfigured,
      // policy-disabled, or failed at request time. Name the preferred model
      // rather than silently swapping.
      const primaryModel = routeDecision.strategy?.primaryModel;
      const usedFallback = routeDecision.source === "strategy" && Boolean(primaryModel) && attemptModel !== primaryModel;
      const requestedModel = routeDecision.source === "manual" ? (routeDecision.requestedModel ?? null) : null;
      return {
        reply,
        providerId: route.providerId,
        model: routeDecision.source === "strategy" ? route.wireModel : (payload.model || route.wireModel),
        requestedModel,
        routeSource: routeDecision.source,
        routeStrategyId: routeDecision.strategy?.id ?? "",
        routeFallback: usedFallback,
        routeNotice: usedFallback
          ? `Preferred model ${primaryModel} unavailable — answered with ${route.label} (${route.wireModel}). Check provider health in Settings > Providers or the routing strategy in Settings > Routing.`
          : "",
        usage: responsePayload?.usage ?? null,
      };
    }
    throw new Error(`No provider route returned a reply — check provider health in Settings > Providers or the routing strategy in Settings > Routing. Attempts: ${failures.join(" | ")}`);
  }

  async function executeInlineAssistant(payload) {
    const action = String(payload.action ?? "summarize").trim().toLowerCase();
    const prompt = String(payload.prompt ?? "").trim().slice(0, 1200);
    const selection = String(payload.selection ?? "").trim().slice(0, 8000);
    const pageContext = String(payload.pageContext ?? "").trim().slice(0, 4000);
    if (!selection) {
      throw new Error("Inline Assistant requires selected text.");
    }
    if (action === "custom" && !prompt) {
      return {
        reply: "Add a custom instruction, then press Ask.",
        providerId: "local-fallback",
        model: "local-inline-fallback",
        usage: null,
      };
    }
    const [secrets, catalog, profiles] = await Promise.all([
      readProviderSecrets(),
      allModelCatalog(),
      allProviderProfiles(),
    ]);
    const route = providerRouteForModel(payload.model, { catalog, profiles });
    const apiKey = secrets[route.providerId];
    if (!apiKey) {
      return {
        reply: fallbackInlineAssistant({ action, selection, prompt }),
        providerId: "local-fallback",
        model: "local-inline-fallback",
        usage: null,
      };
    }
    const systemPrompt = [
      "You are Augmentor Inline Assistant inside the ResonantOS browser.",
      "Answer only the selected text task. Be concise and useful.",
      "Do not execute browser actions, make purchases, submit forms, access credentials, or claim you changed the page.",
      "For fact-checking, separate verified-looking claims from uncertainty and suggest what should be checked next.",
    ].join("\n");
    const userPrompt = JSON.stringify({
      action,
      customInstruction: prompt || null,
      selectedText: selection,
      pageContext,
    });
    let response;
    try {
      response = await fetchProviderResponse(
        providerRequestUrl(route, "/chat/completions"),
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: route.wireModel,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            ...(route.providerType === "openai" ? { reasoning_effort: openAiReasoningEffort(payload.thinkingDepth) } : {}),
          }),
        },
        {
          timeoutMs: providerTimeoutMs("RESONANTOS_PROVIDER_INLINE_TIMEOUT_MS", providerTimeoutDefaults.inlineAssistant),
          label: `${route.wireModel} inline assistant request`,
        },
      );
    } catch (error) {
      return {
        reply: fallbackInlineAssistant({ action, selection, prompt }),
        providerId: "local-fallback",
        model: "local-inline-fallback",
        usage: { providerError: error instanceof Error ? error.message : String(error) },
      };
    }
    const responsePayload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        reply: fallbackInlineAssistant({ action, selection, prompt }),
        providerId: "local-fallback",
        model: "local-inline-fallback",
        usage: { providerError: responsePayload?.error?.message ?? `HTTP ${response.status}` },
      };
    }
    const reply = sanitizeAssistantContent(route.providerType, extractAssistantContent(responsePayload));
    return {
      reply: reply || fallbackInlineAssistant({ action, selection, prompt }),
      providerId: route.providerId,
      model: payload.model || route.wireModel,
      usage: responsePayload?.usage ?? null,
    };
  }

  function fallbackInlineAssistant({ action, selection, prompt = "" }) {
    const text = String(selection ?? "").replace(/\s+/g, " ").trim();
    const clipped = text.length > 700 ? `${text.slice(0, 700)}...` : text;
    if (action === "custom") {
      return `Custom instruction queued for configured model:\n${prompt}\n\nSelected text:\n${clipped}`;
    }
    if (action === "translate") {
      return `Translation needs the configured model. Selected text:\n\n${clipped}`;
    }
    if (action === "rewrite" || action === "improve") {
      return clipped.replace(/\bteh\b/gi, "the").replace(/\bi\b/g, "I");
    }
    if (action === "define") {
      return `Definition context needed. Selected phrase: ${clipped}`;
    }
    if (action === "fact-check") {
      return `Fact-check queue:\n- Claim to verify: ${clipped}\n- Check primary sources before relying on this.`;
    }
    if (action === "explain") {
      return `Plain-language explanation:\n${clipped}`;
    }
    return `Summary:\n${clipped}`;
  }

  return {
    allModelCatalog,
    allProviderProfiles,
    executeBridgeChat,
    executeInlineAssistant,
    executeProviderAccountSave,
    executeProviderAccountRemove,
    executeProviderConnectivityTest,
    executeProviderCredentialSave,
    executeProviderDiagnosticsHistory,
    executeProviderHealthCheck,
    executeProviderModelPreferencesSave,
    executeProviderRoutingStrategies,
    executeProviderRoutingStrategySave,
    executeProviderStatus,
    extractAssistantContent,
    openAiReasoningEffort,
    providerRouteForArchiveVerifier,
    providerRouteForModel,
    providerRouteForWorkload,
    readProviderSecrets,
    runArchiveIngestWriter,
    runArchiveSemanticVerifier,
    sanitizeAssistantContent,
  };
}
