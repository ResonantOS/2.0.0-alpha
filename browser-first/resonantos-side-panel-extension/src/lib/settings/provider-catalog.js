const knownProviderOrder = ["shared-minimax", "shared-zai-glm", "shared-openai"];

export function providerSort(left, right) {
  const leftIndex = knownProviderOrder.indexOf(left.id);
  const rightIndex = knownProviderOrder.indexOf(right.id);
  const order = (leftIndex === -1 ? 99 : leftIndex) - (rightIndex === -1 ? 99 : rightIndex);
  return order || String(left.label ?? "").localeCompare(String(right.label ?? ""));
}

export function formatLabel(value) {
  return String(value ?? "unknown").replace(/[-_]/g, " ");
}

export function modelValue(model) {
  return typeof model === "string" ? model : model.model;
}

export function modelLabel(model) {
  return typeof model === "string" ? model : (model.label ?? model.model);
}

export const providerTypePresets = {
  minimax: {
    label: "MiniMax",
    providerType: "minimax",
    category: "Direct providers",
    apiBaseUrl: "https://api.minimax.io/v1",
    models: ["MiniMax-M3"],
  },
  openai: {
    label: "OpenAI",
    providerType: "openai",
    category: "Direct providers",
    apiBaseUrl: "https://api.openai.com/v1",
    models: ["gpt-5.5", "gpt-5.4-mini"],
  },
  anthropic: {
    label: "Anthropic",
    providerType: "anthropic",
    category: "Direct providers",
    apiBaseUrl: "https://api.anthropic.com",
    models: ["claude-sonnet-4.5", "claude-haiku-4.5"],
  },
  gemini: {
    label: "Google Gemini",
    providerType: "google",
    category: "Direct providers",
    apiBaseUrl: "https://generativelanguage.googleapis.com",
    models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemma"],
  },
  xai: {
    label: "xAI",
    providerType: "openai-compatible",
    category: "Direct providers",
    apiBaseUrl: "https://api.x.ai/v1",
    models: ["grok-4", "grok-3"],
  },
  deepseek: {
    label: "DeepSeek",
    providerType: "openai-compatible",
    category: "Direct providers",
    apiBaseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  mistral: {
    label: "Mistral AI",
    providerType: "openai-compatible",
    category: "Direct providers",
    apiBaseUrl: "https://api.mistral.ai/v1",
    models: ["mistral-large-latest", "mistral-small-latest", "open-mixtral"],
  },
  qwen: {
    label: "Alibaba / Qwen",
    providerType: "openai-compatible",
    category: "Direct providers",
    apiBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-max", "qwen-plus", "qwen-turbo"],
  },
  zai: {
    label: "Z.AI GLM",
    providerType: "openai-compatible",
    category: "Direct providers",
    apiBaseUrl: "http://127.0.0.1:18789/v1",
    models: ["zai/glm-5.2", "zai/glm-5-turbo", "zai/glm-5.1", "zai/glm-5", "zai/glm-5v-turbo", "zai/glm-4.7", "zai/glm-4.6"],
  },
  cohere: {
    label: "Cohere",
    providerType: "custom",
    category: "Direct providers",
    apiBaseUrl: "https://api.cohere.com",
    models: ["command-r-plus", "command-r"],
  },
  ai21: {
    label: "AI21 Labs",
    providerType: "custom",
    category: "Direct providers",
    apiBaseUrl: "https://api.ai21.com/studio/v1",
    models: ["jamba-large", "jamba-mini"],
  },
  "nvidia-nim": {
    label: "NVIDIA Nemotron / NIM",
    providerType: "openai-compatible",
    category: "Direct providers",
    apiBaseUrl: "https://integrate.api.nvidia.com/v1",
    models: ["nvidia/llama-3.1-nemotron-ultra-253b-v1", "nvidia/nemotron"],
  },
  "microsoft-azure": {
    label: "Microsoft Azure AI",
    providerType: "openai-compatible",
    category: "Direct providers",
    apiBaseUrl: "",
    models: ["azure-model-deployment"],
  },
  openrouter: {
    label: "OpenRouter",
    providerType: "openai-compatible",
    category: "Aggregators and gateways",
    apiBaseUrl: "https://openrouter.ai/api/v1",
    models: ["openai/gpt-5.5", "anthropic/claude-sonnet-4.5", "google/gemini-2.5-pro"],
  },
  together: {
    label: "Together AI",
    providerType: "openai-compatible",
    category: "Aggregators and gateways",
    apiBaseUrl: "https://api.together.xyz/v1",
    models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "deepseek-ai/DeepSeek-R1"],
  },
  huggingface: {
    label: "Hugging Face",
    providerType: "openai-compatible",
    category: "Aggregators and gateways",
    apiBaseUrl: "",
    models: ["hf-model-id"],
  },
  replicate: {
    label: "Replicate",
    providerType: "custom",
    category: "Aggregators and gateways",
    apiBaseUrl: "https://api.replicate.com",
    models: ["replicate-model-version"],
  },
  groq: {
    label: "Groq",
    providerType: "openai-compatible",
    category: "Aggregators and gateways",
    apiBaseUrl: "https://api.groq.com/openai/v1",
    models: ["llama-3.3-70b-versatile", "mixtral-8x7b-32768"],
  },
  fireworks: {
    label: "Fireworks AI",
    providerType: "openai-compatible",
    category: "Aggregators and gateways",
    apiBaseUrl: "https://api.fireworks.ai/inference/v1",
    models: ["accounts/fireworks/models/llama-v3p1-70b-instruct"],
  },
  hyperbolic: {
    label: "Hyperbolic",
    providerType: "openai-compatible",
    category: "Aggregators and gateways",
    apiBaseUrl: "https://api.hyperbolic.xyz/v1",
    models: ["meta-llama/Meta-Llama-3.1-70B-Instruct"],
  },
  "cloudflare-ai-gateway": {
    label: "Cloudflare AI Gateway",
    providerType: "openai-compatible",
    category: "Aggregators and gateways",
    apiBaseUrl: "",
    models: ["gateway-model-id"],
  },
  litellm: {
    label: "LiteLLM Gateway",
    providerType: "openai-compatible",
    category: "Aggregators and gateways",
    apiBaseUrl: "http://127.0.0.1:4000/v1",
    models: ["configured-model-alias"],
  },
  bifrost: {
    label: "Bifrost by Maxim AI",
    providerType: "openai-compatible",
    category: "Aggregators and gateways",
    apiBaseUrl: "",
    models: ["bifrost-model-alias"],
  },
  ollama: {
    label: "Ollama",
    providerType: "local",
    category: "Local software",
    apiBaseUrl: "http://127.0.0.1:11434",
    models: ["batiai/gemma4-e2b:q4"],
  },
  "lm-studio": {
    label: "LM Studio",
    providerType: "local",
    category: "Local software",
    apiBaseUrl: "http://127.0.0.1:1234/v1",
    models: ["local-model"],
  },
  "localai": {
    label: "LocalAI",
    providerType: "openai-compatible",
    category: "Local software",
    apiBaseUrl: "http://127.0.0.1:8080/v1",
    models: ["local-model"],
  },
  "llama-cpp": {
    label: "llama.cpp server",
    providerType: "openai-compatible",
    category: "Local software",
    apiBaseUrl: "http://127.0.0.1:8080/v1",
    models: ["local-model"],
  },
  vllm: {
    label: "vLLM",
    providerType: "openai-compatible",
    category: "Local software",
    apiBaseUrl: "http://127.0.0.1:8000/v1",
    models: ["local-model"],
  },
  "text-generation-webui": {
    label: "Text Generation WebUI",
    providerType: "openai-compatible",
    category: "Local software",
    apiBaseUrl: "http://127.0.0.1:5000/v1",
    models: ["local-model"],
  },
  "dgx-spark": {
    label: "NVIDIA DGX Spark",
    providerType: "local",
    category: "User-owned machines",
    apiBaseUrl: "http://dgx-spark.local:11434",
    models: ["local-model"],
  },
  "asus-gx10": {
    label: "ASUS GX10",
    providerType: "openai-compatible",
    category: "User-owned machines",
    apiBaseUrl: "http://192.168.1.77:30004/v1",
    models: ["Qwen3.6-35B-A3B-Q4_K_M.gguf"],
  },
  "openai-compatible": {
    label: "OpenAI-Compatible API",
    providerType: "openai-compatible",
    category: "Custom",
    apiBaseUrl: "",
    models: ["model-id"],
  },
};

export function providerTypeLabel(provider) {
  const type = provider.templateId ?? provider.providerType ?? provider.type ?? "minimax";
  return providerTypePresets[type]?.label ?? formatLabel(type);
}

export function providerModelsText(provider) {
  return (provider.models ?? [])
    .map((model) => modelValue(model))
    .filter(Boolean)
    .join("\n");
}

export function parseModelsText(value) {
  return [...new Set(String(value ?? "")
    .split(/[\n\r,]+/)
    .map((line) => line.trim())
    .filter(Boolean))]
    .slice(0, 12);
}
