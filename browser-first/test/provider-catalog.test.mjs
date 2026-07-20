import assert from "node:assert/strict";
import test from "node:test";

import {
  formatLabel,
  modelLabel,
  modelValue,
  parseModelsText,
  providerModelsText,
  providerSort,
  providerTypeLabel,
  providerTypePresets,
} from "../resonantos-side-panel-extension/src/lib/settings/provider-catalog.js";

test("provider catalog exposes comprehensive direct, gateway, local, and custom templates", () => {
  assert.equal(providerTypePresets.minimax.label, "MiniMax");
  assert.equal(providerTypePresets.openai.providerType, "openai");
  assert.equal(providerTypePresets.zai.models[0], "zai/glm-5.2");
  assert.equal(providerTypePresets.ollama.category, "Local software");
  assert.equal(providerTypePresets["asus-gx10"].category, "User-owned machines");
  assert.equal(providerTypePresets["openai-compatible"].category, "Custom");

  const categories = new Set(Object.values(providerTypePresets).map((preset) => preset.category));
  assert.ok(categories.has("Direct providers"));
  assert.ok(categories.has("Aggregators and gateways"));
  assert.ok(categories.has("Local software"));
  assert.ok(categories.has("User-owned machines"));
});

test("provider catalog normalizes labels, models, and provider type labels", () => {
  assert.equal(formatLabel("auth-failed"), "auth failed");
  assert.equal(formatLabel(null), "unknown");
  assert.equal(modelValue("MiniMax-M3"), "MiniMax-M3");
  assert.equal(modelValue({ model: "gpt-5.5", label: "GPT 5.5" }), "gpt-5.5");
  assert.equal(modelLabel({ model: "gpt-5.5", label: "GPT 5.5" }), "GPT 5.5");
  assert.equal(providerTypeLabel({ templateId: "ollama" }), "Ollama");
  assert.equal(providerTypeLabel({ providerType: "unknown-provider" }), "unknown provider");
  assert.equal(providerModelsText({ models: ["a", { model: "b", label: "B" }, ""] }), "a\nb");
});

test("provider catalog parses model text and preserves canonical provider ordering", () => {
  assert.deepEqual(parseModelsText("a, b\na\rc\n\n"), ["a", "b", "c"]);
  assert.equal(parseModelsText(Array.from({ length: 20 }, (_, index) => `m${index}`).join("\n")).length, 12);

  const providers = [
    { id: "z-provider", label: "Zed" },
    { id: "shared-openai", label: "OpenAI" },
    { id: "shared-zai-glm", label: "Z.AI GLM" },
    { id: "shared-minimax", label: "MiniMax" },
    { id: "a-provider", label: "Alpha" },
  ].sort(providerSort);
  assert.deepEqual(providers.map((provider) => provider.id), [
    "shared-minimax",
    "shared-zai-glm",
    "shared-openai",
    "a-provider",
    "z-provider",
  ]);
});
