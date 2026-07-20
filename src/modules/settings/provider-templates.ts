// Intent citation: docs/architecture/ADR-005-provider-fabric-routing.md

import type {
  AuthTier,
  ProviderAuthMethod,
  ProviderModelContextPolicy,
  ProviderStatus,
  ProviderType,
  RuntimeNodeHealthState,
  RuntimeNodeKind,
  RuntimeNodeLocality,
} from "../../core/contracts";

export type ProviderTemplateId = string;
export type ProviderTemplateCategory = "direct-provider" | "aggregator" | "local-runtime" | "runtime-node" | "custom";
export type ProviderTemplateExecutionState = "routable-now" | "adapter-pending" | "profile-only";

export type ProviderTemplate = {
  id: ProviderTemplateId;
  label: string;
  shortLabel: string;
  category: ProviderTemplateCategory;
  executionState: ProviderTemplateExecutionState;
  providerType: ProviderType;
  authMethod: ProviderAuthMethod;
  authTier: AuthTier;
  defaultApiBaseUrl?: string;
  requiresSecret: boolean;
  requiresBaseUrl: boolean;
  allowedModels: string[];
  primaryModel: string;
  fallbackModel?: string;
  consumerScopes: string[];
  runtimeKind: RuntimeNodeKind;
  runtimeLocality: RuntimeNodeLocality;
  initialStatus: ProviderStatus;
  initialRuntimeHealthState: RuntimeNodeHealthState;
  deployableOnDemand: boolean;
  modelContext: ProviderModelContextPolicy[];
  note: string;
};

export const providerTemplateCategoryLabels: Record<ProviderTemplateCategory, string> = {
  "direct-provider": "Direct providers",
  aggregator: "Aggregators and gateways",
  "local-runtime": "Local software",
  "runtime-node": "User-owned machines",
  custom: "Custom",
};

const contextPolicy = (
  model: string,
  maxContextTokens: number,
  source: ProviderModelContextPolicy["source"] = "provider-default",
): ProviderModelContextPolicy => ({
  model,
  maxContextTokens,
  tokenEstimateMethod: "provider-metadata",
  source,
});

const openAiCompatibleTemplate = ({
  id,
  label,
  shortLabel = label,
  category = "direct-provider",
  apiBaseUrl,
  models,
  primaryModel = models[0],
  fallbackModel = models[1],
  note,
  runtimeKind = "cloud",
  runtimeLocality = "cloud",
  requiresBaseUrl = false,
  consumerScopes = ["strategist", "setup", "routine"],
}: {
  id: string;
  label: string;
  shortLabel?: string;
  category?: ProviderTemplateCategory;
  apiBaseUrl?: string;
  models: string[];
  primaryModel?: string;
  fallbackModel?: string;
  note: string;
  runtimeKind?: RuntimeNodeKind;
  runtimeLocality?: RuntimeNodeLocality;
  requiresBaseUrl?: boolean;
  consumerScopes?: string[];
}): ProviderTemplate => ({
  id,
  label,
  shortLabel,
  category,
  executionState: "routable-now",
  providerType: "openai-compatible",
  authMethod: "api-key",
  authTier: "supported",
  defaultApiBaseUrl: apiBaseUrl,
  requiresSecret: true,
  requiresBaseUrl,
  allowedModels: models,
  primaryModel,
  fallbackModel,
  consumerScopes,
  runtimeKind,
  runtimeLocality,
  initialStatus: "ready",
  initialRuntimeHealthState: "ready",
  deployableOnDemand: runtimeKind === "local",
  modelContext: models.map((model) => contextPolicy(model, 128_000, "provider-default")),
  note,
});

const adapterPendingTemplate = ({
  id,
  label,
  shortLabel = label,
  providerType = "custom",
  apiBaseUrl,
  models,
  primaryModel = models[0],
  fallbackModel = models[1],
  note,
}: {
  id: string;
  label: string;
  shortLabel?: string;
  providerType?: ProviderType;
  apiBaseUrl?: string;
  models: string[];
  primaryModel?: string;
  fallbackModel?: string;
  note: string;
}): ProviderTemplate => ({
  id,
  label,
  shortLabel,
  category: "direct-provider",
  executionState: "adapter-pending",
  providerType,
  authMethod: "api-key",
  authTier: "supported",
  defaultApiBaseUrl: apiBaseUrl,
  requiresSecret: true,
  requiresBaseUrl: !apiBaseUrl,
  allowedModels: models,
  primaryModel,
  fallbackModel,
  consumerScopes: ["strategist", "setup"],
  runtimeKind: "cloud",
  runtimeLocality: "cloud",
  initialStatus: "missing",
  initialRuntimeHealthState: "unavailable",
  deployableOnDemand: false,
  modelContext: models.map((model) => contextPolicy(model, 128_000, "provider-default")),
  note,
});

const localTemplate = ({
  id,
  label,
  shortLabel = label,
  apiBaseUrl,
  models,
  primaryModel = models[0],
  fallbackModel = models[1],
  runtimeKind = "local",
  runtimeLocality = "desktop-local",
  executionState = "routable-now",
  note,
}: {
  id: string;
  label: string;
  shortLabel?: string;
  apiBaseUrl: string;
  models: string[];
  primaryModel?: string;
  fallbackModel?: string;
  runtimeKind?: RuntimeNodeKind;
  runtimeLocality?: RuntimeNodeLocality;
  executionState?: ProviderTemplateExecutionState;
  note: string;
}): ProviderTemplate => ({
  id,
  label,
  shortLabel,
  category: runtimeKind === "remote-user-owned" ? "runtime-node" : "local-runtime",
  executionState,
  providerType: "local",
  authMethod: "local-runtime",
  authTier: executionState === "routable-now" ? "supported" : "experimental",
  defaultApiBaseUrl: apiBaseUrl,
  requiresSecret: false,
  requiresBaseUrl: true,
  allowedModels: models,
  primaryModel,
  fallbackModel,
  consumerScopes: ["setup", "recovery", "routine"],
  runtimeKind,
  runtimeLocality,
  initialStatus: executionState === "routable-now" ? "fallback" : "missing",
  initialRuntimeHealthState: executionState === "routable-now" ? "deployable" : "unavailable",
  deployableOnDemand: true,
  modelContext: models.map((model) => contextPolicy(model, 32_000, "runtime-node")),
  note,
});

export const providerTemplates: ProviderTemplate[] = [
  {
    id: "minimax",
    label: "MiniMax",
    shortLabel: "MiniMax",
    category: "direct-provider",
    executionState: "routable-now",
    providerType: "minimax",
    authMethod: "subscription",
    authTier: "experimental",
    defaultApiBaseUrl: "https://api.minimax.io/v1",
    requiresSecret: true,
    requiresBaseUrl: false,
    allowedModels: ["MiniMax-M3"],
    primaryModel: "MiniMax-M3",
    fallbackModel: undefined,
    consumerScopes: ["strategist", "setup", "archive-ingest", "telegram-channel"],
    runtimeKind: "cloud",
    runtimeLocality: "cloud",
    initialStatus: "ready",
    initialRuntimeHealthState: "ready",
    deployableOnDemand: false,
    modelContext: [contextPolicy("MiniMax-M3", 1_000_000)],
    note: "Best for your current Augmentor and Engineer primary route when MiniMax credentials are configured.",
  },
  {
    id: "openai",
    label: "OpenAI",
    shortLabel: "OpenAI",
    category: "direct-provider",
    executionState: "routable-now",
    providerType: "openai",
    authMethod: "api-key",
    authTier: "supported",
    defaultApiBaseUrl: "https://api.openai.com/v1",
    requiresSecret: true,
    requiresBaseUrl: false,
    allowedModels: ["gpt-5.5", "gpt-5.4-mini"],
    primaryModel: "gpt-5.5",
    fallbackModel: "gpt-5.4-mini",
    consumerScopes: ["strategist", "setup", "archive-ingest"],
    runtimeKind: "cloud",
    runtimeLocality: "cloud",
    initialStatus: "ready",
    initialRuntimeHealthState: "ready",
    deployableOnDemand: false,
    modelContext: [contextPolicy("gpt-5.5", 128_000), contextPolicy("gpt-5.4-mini", 128_000)],
    note: "Use for demanding reasoning, coding, and trusted archive ingest when cost policy allows it.",
  },
  adapterPendingTemplate({
    id: "anthropic",
    label: "Anthropic",
    providerType: "anthropic",
    apiBaseUrl: "https://api.anthropic.com",
    models: ["claude-sonnet-4.5", "claude-haiku-4.5"],
    note: "Profile can be stored now; native Anthropic execution needs its dedicated host adapter before routing.",
  }),
  adapterPendingTemplate({
    id: "google",
    label: "Google Gemini / Gemma",
    shortLabel: "Gemini",
    providerType: "google",
    apiBaseUrl: "https://generativelanguage.googleapis.com",
    models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemma"],
    note: "Profile can be stored now; native Gemini execution needs its dedicated host adapter before routing.",
  }),
  openAiCompatibleTemplate({
    id: "xai",
    label: "xAI",
    apiBaseUrl: "https://api.x.ai/v1",
    models: ["grok-4", "grok-3"],
    note: "xAI exposes an OpenAI-compatible path for Grok-family routing.",
  }),
  openAiCompatibleTemplate({
    id: "deepseek",
    label: "DeepSeek",
    apiBaseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    note: "OpenAI-compatible route for DeepSeek V/R families.",
  }),
  openAiCompatibleTemplate({
    id: "mistral",
    label: "Mistral AI",
    apiBaseUrl: "https://api.mistral.ai/v1",
    models: ["mistral-large-latest", "mistral-small-latest", "open-mixtral"],
    note: "OpenAI-compatible route for Mistral, Mixtral, Small, and Large families.",
  }),
  openAiCompatibleTemplate({
    id: "qwen",
    label: "Alibaba / Qwen",
    apiBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-max", "qwen-plus", "qwen-turbo"],
    note: "Qwen can be routed through an OpenAI-compatible DashScope endpoint.",
  }),
  adapterPendingTemplate({
    id: "cohere",
    label: "Cohere",
    apiBaseUrl: "https://api.cohere.com",
    models: ["command-r-plus", "command-r"],
    note: "Profile can be stored now; Cohere requires a native adapter or aggregator route.",
  }),
  adapterPendingTemplate({
    id: "ai21",
    label: "AI21 Labs",
    apiBaseUrl: "https://api.ai21.com/studio/v1",
    models: ["jamba-large", "jamba-mini", "jurassic"],
    note: "Profile can be stored now; AI21 requires a native adapter or aggregator route.",
  }),
  adapterPendingTemplate({
    id: "baidu",
    label: "Baidu ERNIE",
    models: ["ernie-4.0", "ernie-speed"],
    note: "Profile shell for ERNIE-family access; execution adapter and regional auth need dedicated setup.",
  }),
  adapterPendingTemplate({
    id: "tencent",
    label: "Tencent Hunyuan",
    models: ["hunyuan-large", "hunyuan-standard"],
    note: "Profile shell for Hunyuan-family access; execution adapter and regional auth need dedicated setup.",
  }),
  openAiCompatibleTemplate({
    id: "zai",
    label: "Z.AI GLM",
    apiBaseUrl: "http://127.0.0.1:18789/v1",
    models: ["zai/glm-5.2", "zai/glm-5-turbo", "zai/glm-5.1", "zai/glm-5", "zai/glm-5v-turbo", "zai/glm-4.7", "zai/glm-4.6"],
    primaryModel: "zai/glm-5.2",
    note: "OpenClaw/Z.AI route for GLM-family models such as the configured zai/glm-5.2 route.",
  }),
  openAiCompatibleTemplate({
    id: "databricks-mosaic",
    label: "Databricks / Mosaic AI",
    models: ["databricks-dbrx-instruct"],
    requiresBaseUrl: true,
    note: "Use the workspace-serving OpenAI-compatible endpoint for DBRX or other Mosaic-hosted models.",
  }),
  adapterPendingTemplate({
    id: "aws-bedrock",
    label: "Amazon AWS Bedrock",
    models: ["bedrock-model-id"],
    note: "Bedrock is a platform route with many providers; credentials and signing need a native adapter.",
  }),
  openAiCompatibleTemplate({
    id: "stability",
    label: "Stability AI",
    models: ["stablelm-model-id"],
    requiresBaseUrl: true,
    note: "Profile for StableLM-compatible text routes; endpoint and model IDs should be confirmed during setup.",
  }),
  adapterPendingTemplate({
    id: "huawei-pangu",
    label: "Huawei Pangu",
    models: ["pangu-model-id"],
    note: "Profile shell for Pangu-family access; execution adapter and regional auth need dedicated setup.",
  }),
  openAiCompatibleTemplate({
    id: "ibm-granite",
    label: "IBM Granite",
    models: ["granite-model-id"],
    requiresBaseUrl: true,
    note: "Use an IBM watsonx or compatible gateway endpoint when Granite is exposed through chat completions.",
  }),
  openAiCompatibleTemplate({
    id: "nvidia-nim",
    label: "NVIDIA Nemotron / NIM",
    apiBaseUrl: "https://integrate.api.nvidia.com/v1",
    models: ["nvidia/llama-3.1-nemotron-ultra-253b-v1", "nvidia/nemotron"],
    note: "OpenAI-compatible NIM route for Nemotron-family and hosted NVIDIA models.",
  }),
  openAiCompatibleTemplate({
    id: "meta-llama",
    label: "Meta Llama",
    models: ["llama-3.3-70b", "llama-4"],
    requiresBaseUrl: true,
    note: "Meta models are usually accessed through an aggregator, local runtime, or hosted OpenAI-compatible endpoint.",
  }),
  openAiCompatibleTemplate({
    id: "microsoft-azure",
    label: "Microsoft Azure AI",
    models: ["azure-model-deployment"],
    requiresBaseUrl: true,
    note: "Use the Azure OpenAI or Azure AI deployment endpoint and deployment/model name.",
  }),
  openAiCompatibleTemplate({
    id: "microsoft-phi",
    label: "Microsoft Phi",
    models: ["phi-4"],
    requiresBaseUrl: true,
    note: "Phi models are usually accessed through Azure, local runtimes, or aggregators.",
  }),
  openAiCompatibleTemplate({
    id: "openrouter",
    label: "OpenRouter",
    category: "aggregator",
    apiBaseUrl: "https://openrouter.ai/api/v1",
    models: ["openai/gpt-5.5", "anthropic/claude-sonnet-4.5", "google/gemini-2.5-pro"],
    note: "Unified OpenAI-compatible marketplace route for many premium and open models.",
  }),
  openAiCompatibleTemplate({
    id: "together",
    label: "Together AI",
    category: "aggregator",
    apiBaseUrl: "https://api.together.xyz/v1",
    models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "deepseek-ai/DeepSeek-R1"],
    note: "Hosted open-model inference with OpenAI-compatible chat completions.",
  }),
  openAiCompatibleTemplate({
    id: "huggingface",
    label: "Hugging Face",
    category: "aggregator",
    models: ["hf-model-id"],
    requiresBaseUrl: true,
    note: "Use a Hugging Face inference endpoint that exposes an OpenAI-compatible chat path.",
  }),
  adapterPendingTemplate({
    id: "replicate",
    label: "Replicate",
    models: ["replicate-model-version"],
    note: "Profile can be stored now; Replicate workflows need a dedicated adapter or gateway route.",
  }),
  openAiCompatibleTemplate({
    id: "groq",
    label: "Groq",
    category: "aggregator",
    apiBaseUrl: "https://api.groq.com/openai/v1",
    models: ["llama-3.3-70b-versatile", "mixtral-8x7b-32768"],
    note: "Fast OpenAI-compatible inference platform for selected popular models.",
  }),
  openAiCompatibleTemplate({
    id: "fireworks",
    label: "Fireworks AI",
    category: "aggregator",
    apiBaseUrl: "https://api.fireworks.ai/inference/v1",
    models: ["accounts/fireworks/models/llama-v3p1-70b-instruct"],
    note: "Hosted open-model deployment and inference with OpenAI-compatible endpoints.",
  }),
  openAiCompatibleTemplate({
    id: "hyperbolic",
    label: "Hyperbolic",
    category: "aggregator",
    apiBaseUrl: "https://api.hyperbolic.xyz/v1",
    models: ["meta-llama/Meta-Llama-3.1-70B-Instruct"],
    note: "Developer inference aggregation through an OpenAI-compatible API.",
  }),
  openAiCompatibleTemplate({
    id: "cloudflare-ai-gateway",
    label: "Cloudflare AI Gateway",
    category: "aggregator",
    models: ["gateway-model-id"],
    requiresBaseUrl: true,
    note: "Routing, caching, and observability gateway. Use the user-specific gateway endpoint.",
  }),
  openAiCompatibleTemplate({
    id: "litellm",
    label: "LiteLLM Gateway",
    category: "aggregator",
    apiBaseUrl: "http://127.0.0.1:4000/v1",
    models: ["configured-model-alias"],
    runtimeKind: "local",
    runtimeLocality: "desktop-local",
    note: "Local or remote open-source gateway for routing across many LLM providers.",
  }),
  openAiCompatibleTemplate({
    id: "bifrost",
    label: "Bifrost by Maxim AI",
    category: "aggregator",
    models: ["bifrost-model-alias"],
    requiresBaseUrl: true,
    note: "Enterprise gateway profile for observability and failover when exposed through compatible chat completions.",
  }),
  localTemplate({
    id: "ollama",
    label: "Ollama",
    apiBaseUrl: "http://127.0.0.1:11434",
    models: ["batiai/gemma4-e2b:q4"],
    primaryModel: "batiai/gemma4-e2b:q4",
    fallbackModel: undefined,
    note: "Desktop-local Ollama route. This is currently the supported local execution adapter.",
  }),
  localTemplate({
    id: "lm-studio",
    label: "LM Studio",
    apiBaseUrl: "http://127.0.0.1:1234/v1",
    models: ["local-model"],
    executionState: "adapter-pending",
    note: "LM Studio normally exposes an OpenAI-compatible local server; local compatible execution needs a dedicated adapter.",
  }),
  localTemplate({
    id: "dgx-spark",
    label: "NVIDIA DGX Spark",
    apiBaseUrl: "http://dgx-spark.local:11434",
    models: [],
    primaryModel: "",
    runtimeKind: "remote-user-owned",
    runtimeLocality: "lan-remote",
    executionState: "adapter-pending",
    note: "User-owned machine profile. It becomes routable when it exposes a supported Ollama or OpenAI-compatible endpoint.",
  }),
  openAiCompatibleTemplate({
    id: "asus-gx10",
    label: "ASUS GX10",
    category: "runtime-node",
    apiBaseUrl: "http://192.168.1.77:30004/v1",
    models: ["Qwen3.6-35B-A3B-Q4_K_M.gguf"],
    primaryModel: "Qwen3.6-35B-A3B-Q4_K_M.gguf",
    runtimeKind: "remote-user-owned",
    runtimeLocality: "lan-remote",
    note: "User-owned LAN runtime profile for GX10-class local AI machines exposing an OpenAI-compatible llama.cpp endpoint.",
  }),
  openAiCompatibleTemplate({
    id: "openai-compatible",
    label: "OpenAI-Compatible API",
    shortLabel: "Compatible",
    category: "custom",
    models: ["model-id"],
    primaryModel: "model-id",
    fallbackModel: undefined,
    requiresBaseUrl: true,
    note: "Use this for any hosted provider, gateway, or deployment that exposes OpenAI-compatible chat completions.",
  }),
];

export const providerTemplatesByCategory = (category: ProviderTemplateCategory): ProviderTemplate[] =>
  providerTemplates.filter((template) => template.category === category);

export const findProviderTemplate = (templateId: ProviderTemplateId): ProviderTemplate | undefined =>
  providerTemplates.find((template) => template.id === templateId);
