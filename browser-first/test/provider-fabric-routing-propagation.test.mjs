// Regression for #207: "New Provider not propagating to Provider Fabric Routing".
// A user-added provider (e.g. OpenRouter) must be usable end-to-end through the
// Provider Fabric: visible in the routing dropdown, selectable/persistable as a
// strategy primary, shown as routable, and actually routed to its own endpoint
// for chat — not silently dropped or misrouted to the built-in MiniMax default.
// Dropdown source: settings/routing-section.js (GET /providers/routing-strategies).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createProviderBridgeService } from "../host/provider-bridge-service.mjs";

function createService(root) {
  return createProviderBridgeService({
    providerSecretsPath: () => path.join(root, "Secrets", "provider-secrets.json"),
    providerAccountsPath: () => path.join(root, "ProviderFabric", "provider-accounts.json"),
    providerRoutingPath: () => path.join(root, "ProviderFabric", "routing-strategies.json"),
    providerModelPreferencesPath: () => path.join(root, "ProviderFabric", "model-preferences.json"),
    providerDiagnosticsHistoryPath: () => path.join(root, "ProviderFabric", "diagnostics-history.json"),
    redactDiagnosticText: (value) => String(value ?? ""),
    unique: (values) => [...new Set(values.filter(Boolean))],
    extractJsonObject: (value) => JSON.parse(String(value ?? "{}")),
  });
}

async function withOpenRouter(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "resonant-207-"));
  try {
    const service = createService(root);
    const customModel = "anthropic/claude-sonnet-4.5"; // absent from the built-in modelCatalog
    const apiBaseUrl = "https://openrouter.ai/api/v1";
    const saved = await service.executeProviderAccountSave({
      label: "OpenRouter",
      providerType: "openai-compatible",
      templateId: "openai-compatible",
      apiBaseUrl,
      models: [customModel],
      credential: "openrouter-test-credential",
    });
    await run({ service, customModel, apiBaseUrl, providerId: saved.provider.id });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("#207.1 added provider model appears in the Fabric Routing dropdown", async () => {
  await withOpenRouter(async ({ service, customModel, providerId }) => {
    const routing = await service.executeProviderRoutingStrategies();
    const names = routing.models.map((entry) => entry.model);
    assert.ok(names.includes(customModel), `dropdown missing "${customModel}"; got: ${names.join(", ")}`);
    assert.ok(routing.models.some((entry) => entry.providerId === providerId), "added provider not selectable in dropdown");
  });
});

test("#207.2 selecting the added model as a strategy primary persists (no silent revert)", async () => {
  await withOpenRouter(async ({ service, customModel }) => {
    const before = await service.executeProviderRoutingStrategies();
    const strategyId = before.strategies[0].id;
    await service.executeProviderRoutingStrategySave({
      strategyId,
      primaryModel: customModel,
      fallbackModels: [],
      costPosture: "low-cost-first",
      hardStop: false,
    });
    const after = await service.executeProviderRoutingStrategies();
    const saved = after.strategies.find((strategy) => strategy.id === strategyId);
    assert.equal(saved.primaryModel, customModel, "added model did not persist as strategy primary");
  });
});

test("#207.3 saved dynamic strategy is routable and chat routes to the provider's own endpoint", async () => {
  await withOpenRouter(async ({ service, customModel, apiBaseUrl, providerId }) => {
    const before = await service.executeProviderRoutingStrategies();
    const strategyId = before.strategies[0].id;
    await service.executeProviderRoutingStrategySave({
      strategyId,
      primaryModel: customModel,
      fallbackModels: [],
      costPosture: "low-cost-first",
      hardStop: false,
    });
    // routing display: the strategy resolves the dynamic model (not null/unavailable)
    const after = await service.executeProviderRoutingStrategies();
    const saved = after.strategies.find((strategy) => strategy.id === strategyId);
    assert.equal(saved.primary?.model, customModel, "dynamic strategy primary did not resolve a route");
    assert.equal(saved.routeState, "routable", "configured dynamic strategy should be routable");
    // live chat: workload routing must target the provider's endpoint, not MiniMax
    const decision = await service.providerRouteForWorkload(strategyId, customModel);
    assert.equal(decision.route?.apiBaseUrl, apiBaseUrl, `chat misrouted; got ${decision.route?.apiBaseUrl}`);
    assert.equal(decision.route?.providerId, providerId, "chat routed to the wrong provider");
    assert.equal(decision.route?.wireModel, customModel, "chat used the wrong wire model");
  });
});

test("#207.4 a custom provider can be removed (built-ins protected, overrides cleaned)", async () => {
  await withOpenRouter(async ({ service, customModel, providerId }) => {
    // Pin the custom model as a strategy primary, so we can prove override cleanup.
    const before = await service.executeProviderRoutingStrategies();
    const strategyId = before.strategies[0].id;
    await service.executeProviderRoutingStrategySave({
      strategyId, primaryModel: customModel, fallbackModels: [], costPosture: "low-cost-first", hardStop: false,
    });

    // Safety: built-in providers cannot be removed; unknown ids reject.
    await assert.rejects(
      () => service.executeProviderAccountRemove({ providerId: "shared-minimax" }),
      /Built-in provider profiles cannot be removed/,
    );
    await assert.rejects(
      () => service.executeProviderAccountRemove({ providerId: "does-not-exist" }),
      /Unknown provider account/,
    );

    // Remove the custom provider.
    const result = await service.executeProviderAccountRemove({ providerId });
    assert.equal(result.removed, providerId);
    assert.ok(!result.providers.some((profile) => profile.id === providerId), "removed provider still present");

    // Its model leaves the dropdown, and the pinned strategy reverts off it.
    const after = await service.executeProviderRoutingStrategies();
    assert.ok(!after.models.some((entry) => entry.model === customModel), "removed provider model still in dropdown");
    const strategy = after.strategies.find((entry) => entry.id === strategyId);
    assert.notEqual(strategy.primaryModel, customModel, "strategy still pinned to the removed provider's model");
  });
});

test("#207.5 default Auto-route chat reaches the added provider's endpoint (not MiniMax)", async () => {
  // The realistic UX: pin the added model via the routing strategy, then chat with
  // model "__auto__" (the composer default). This exercises executeBridgeChat's
  // strategy-chain dispatch — the path a certification panel proved still misrouted
  // to shared-MiniMax even after the dropdown/save/workload paths were fixed.
  await withOpenRouter(async ({ service, customModel, apiBaseUrl, providerId }) => {
    const before = await service.executeProviderRoutingStrategies();
    const strategy = before.strategies.find((entry) => entry.id === "augmentor-chat" || entry.workload === "augmentor-chat")
      ?? before.strategies[0];
    await service.executeProviderRoutingStrategySave({
      strategyId: strategy.id, primaryModel: customModel, fallbackModels: [], costPosture: "low-cost-first", hardStop: false,
    });

    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "hi from openrouter" } }], usage: null }) };
    };
    try {
      const result = await service.executeBridgeChat({
        workload: "augmentor-chat",
        model: "__auto__",
        messages: [{ role: "user", content: "hi" }],
      });
      assert.ok(calls.some((url) => url.startsWith(apiBaseUrl)), `Auto-route chat must call ${apiBaseUrl}; called: ${calls.join(", ") || "(none)"}`);
      assert.ok(!calls.some((url) => url.includes("api.minimax.io")), "Auto-route chat must not fall back to the MiniMax endpoint");
      assert.equal(result.providerId, providerId, "chat reported the wrong provider");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
