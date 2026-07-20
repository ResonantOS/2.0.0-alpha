// #231 — Provider Fabric must not silently swap an explicit model, and must make
// a fallback visible and actionable. Driven via executeBridgeChat with a
// per-endpoint fetch stub (no live secrets). A fallback is detected by comparing
// the model that ANSWERED against the strategy's declared primary, so it is caught
// even when the primary was never configured (the most common silent-swap case).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createProviderBridgeService } from "../host/provider-bridge-service.mjs";

const PROVIDER_ENV = [
  "MINIMAX_API_KEY", "OPENAI_API_KEY", "ZAI_API_KEY", "GLM_API_KEY", "ZHIPUAI_API_KEY",
  "RESONANTOS_PROVIDER_SECRETS_JSON", "RESONANTOS_LOCAL_RUNTIME_URL",
];

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

function reply(content) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage: null }) };
}

async function withService(run) {
  const previous = Object.fromEntries(PROVIDER_ENV.map((name) => [name, process.env[name]]));
  for (const name of PROVIDER_ENV) delete process.env[name];
  const originalFetch = globalThis.fetch;
  const root = await mkdtemp(path.join(os.tmpdir(), "resonant-231-"));
  try {
    await run(createService(root), (stub) => { globalThis.fetch = stub; });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function pinStrategy(svc, primaryModel, fallbackModels) {
  await svc.executeProviderRoutingStrategySave({
    strategyId: "augmentor-chat", primaryModel, fallbackModels, costPosture: "quality-first", hardStop: false,
  });
}

test("#231 an explicitly selected, available model is preserved (no silent swap)", async () => {
  await withService(async (svc, setFetch) => {
    await svc.executeProviderCredentialSave({ providerId: "shared-openai", credential: "openai-test-credential" });
    setFetch(async () => reply("hi from gpt"));
    const out = await svc.executeBridgeChat({ workload: "augmentor-chat", model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] });
    assert.equal(out.model, "gpt-5.5", "the explicitly requested model must be the one used");
    assert.equal(out.requestedModel, "gpt-5.5");
    assert.equal(out.routeSource, "manual");
    assert.equal(out.routeFallback, false);
  });
});

test("#231 an explicitly selected disabled/unknown model reports actionable guidance", async () => {
  await withService(async (svc) => {
    await svc.executeProviderCredentialSave({ providerId: "shared-openai", credential: "openai-test-credential" });
    await assert.rejects(
      () => svc.executeBridgeChat({ workload: "augmentor-chat", model: "no-such-model-xyz", messages: [{ role: "user", content: "hi" }] }),
      /selected model "no-such-model-xyz" is unavailable[\s\S]*Settings > Providers/,
    );
  });
});

test("#231 an explicitly selected model with no provider credential names the model and points to recovery", async () => {
  await withService(async (svc) => {
    // gpt-5.5 is a real, allowed catalog model, but shared-openai has no credential.
    await assert.rejects(
      () => svc.executeBridgeChat({ workload: "augmentor-chat", model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }),
      /selected model "gpt-5.5" has no active provider credential[\s\S]*Settings > Providers/,
    );
  });
});

test("#231 a runtime fallback is visible: response reports routeFallback + an actionable notice", async () => {
  await withService(async (svc, setFetch) => {
    await svc.executeProviderCredentialSave({ providerId: "shared-minimax", credential: "minimax-test-credential" });
    await svc.executeProviderCredentialSave({ providerId: "shared-openai", credential: "openai-test-credential" });
    await pinStrategy(svc, "MiniMax-M3", ["gpt-5.5"]);
    setFetch(async (url) => {
      if (String(url).includes("minimax")) return { ok: false, status: 500, json: async () => ({ error: { message: "primary down" } }) };
      return reply("answered by fallback");
    });
    const out = await svc.executeBridgeChat({ workload: "augmentor-chat", model: "__auto__", messages: [{ role: "user", content: "hi" }] });
    assert.equal(out.model, "gpt-5.5");
    assert.equal(out.routeFallback, true);
    assert.match(out.routeNotice, /Preferred model MiniMax-M3 unavailable[\s\S]*Settings > (Providers|Routing)/);
  });
});

test("#231 a fallback is visible even when the primary was never configured (not just runtime failure)", async () => {
  await withService(async (svc, setFetch) => {
    // Configure ONLY the fallback provider; the strategy primary (MiniMax) has no
    // credential, so it is filtered from the chain before any request is attempted.
    await svc.executeProviderCredentialSave({ providerId: "shared-openai", credential: "openai-test-credential" });
    await pinStrategy(svc, "MiniMax-M3", ["gpt-5.5"]);
    setFetch(async () => reply("answered by the only configured route"));
    const out = await svc.executeBridgeChat({ workload: "augmentor-chat", model: "__auto__", messages: [{ role: "user", content: "hi" }] });
    assert.equal(out.model, "gpt-5.5");
    assert.equal(out.routeFallback, true, "an unconfigured primary swapped for a fallback must be reported, not silent");
    assert.match(out.routeNotice, /Preferred model MiniMax-M3 unavailable/);
  });
});

test("#231 no fallback flag when the primary route answers", async () => {
  await withService(async (svc, setFetch) => {
    await svc.executeProviderCredentialSave({ providerId: "shared-minimax", credential: "minimax-test-credential" });
    await pinStrategy(svc, "MiniMax-M3", []);
    setFetch(async () => reply("answered by primary"));
    const out = await svc.executeBridgeChat({ workload: "augmentor-chat", model: "__auto__", messages: [{ role: "user", content: "hi" }] });
    assert.equal(out.routeFallback, false);
    assert.equal(out.routeNotice, "");
  });
});
