import { describe, expect, it } from "vitest";
import {
  providerTemplates,
  providerTemplatesByCategory,
  type ProviderTemplateCategory,
} from "./provider-templates";

const categories: ProviderTemplateCategory[] = [
  "direct-provider",
  "aggregator",
  "local-runtime",
  "runtime-node",
  "custom",
];

describe("provider templates", () => {
  it("keeps every setup template visible in exactly one provider category", () => {
    const groupedTemplateIds = categories.flatMap((category) => providerTemplatesByCategory(category).map((template) => template.id));
    const uniqueGroupedTemplateIds = new Set(groupedTemplateIds);

    expect(groupedTemplateIds).toHaveLength(providerTemplates.length);
    expect(uniqueGroupedTemplateIds.size).toBe(providerTemplates.length);
    expect(groupedTemplateIds).toContain("ollama");
    expect(groupedTemplateIds).toContain("openrouter");
    expect(groupedTemplateIds).toContain("openai-compatible");
  });

  it("separates routable templates from stored profiles that still need adapters", () => {
    const templateById = new Map(providerTemplates.map((template) => [template.id, template]));

    expect(templateById.get("ollama")?.executionState).toBe("routable-now");
    expect(templateById.get("anthropic")?.executionState).toBe("adapter-pending");
    expect(templateById.get("anthropic")?.initialStatus).toBe("missing");
    expect(templateById.get("anthropic")?.initialRuntimeHealthState).toBe("unavailable");
  });

  it("classifies local OpenAI-compatible software as keyless local runtimes", () => {
    const templateById = new Map(providerTemplates.map((template) => [template.id, template]));

    for (const templateId of ["localai", "llama-cpp", "vllm", "text-generation-webui"]) {
      const template = templateById.get(templateId);

      expect(template?.category).toBe("local-runtime");
      expect(template?.providerType).toBe("local");
      expect(template?.authMethod).toBe("local-runtime");
      expect(template?.requiresSecret).toBe(false);
      expect(template?.requiresBaseUrl).toBe(true);
    }
  });
});
