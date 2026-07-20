// #233 acceptance coverage for the provider route boundary: status, health,
// connectivity, chat-route availability, fallback routability, and the
// route-unavailable copy — all deterministic (no live provider secrets) and
// asserting no raw credential leaks into any surfaced payload.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createProviderBridgeService } from "../host/provider-bridge-service.mjs";

// Provider secrets can come from env or the session store; clear the env ones so
// each test starts from a deterministic "nothing configured" baseline.
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

async function withService(run) {
  const previous = Object.fromEntries(PROVIDER_ENV.map((name) => [name, process.env[name]]));
  for (const name of PROVIDER_ENV) delete process.env[name];
  const root = await mkdtemp(path.join(os.tmpdir(), "resonant-233-"));
  try {
    await run(createService(root));
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

test("#233 status reports missing vs configured providers", async () => {
  await withService(async (svc) => {
    let status = await svc.executeProviderStatus();
    const before = status.providers.find((p) => p.id === "shared-minimax");
    assert.equal(before.configured, false, "provider is not configured before a credential is saved");
    assert.equal(before.credentialPreview, "missing");

    await svc.executeProviderCredentialSave({ providerId: "shared-minimax", credential: "minimax-test-credential" });
    status = await svc.executeProviderStatus();
    assert.equal(status.providers.find((p) => p.id === "shared-minimax").configured, true);
  });
});

test("#233 health check reports each provider state and rejects unknown providers", async () => {
  await withService(async (svc) => {
    let health = await svc.executeProviderHealthCheck({ providerId: "shared-minimax" });
    assert.equal(health.state, "missing-credential");
    assert.match(health.detail, /no active credential/i);

    await assert.rejects(() => svc.executeProviderHealthCheck({ providerId: "does-not-exist" }), /Unknown provider profile/);

    await svc.executeProviderCredentialSave({ providerId: "shared-minimax", credential: "minimax-test-credential" });
    health = await svc.executeProviderHealthCheck({ providerId: "shared-minimax" });
    assert.equal(health.configured, true);
    assert.ok(["ready", "degraded"].includes(health.state), `configured provider should be ready/degraded, got ${health.state}`);
  });
});

test("#233 connectivity test is deterministic for missing credential and maps HTTP status to state", async () => {
  await withService(async (svc) => {
    const missing = await svc.executeProviderConnectivityTest({ providerId: "shared-minimax" });
    assert.equal(missing.state, "missing-credential"); // no network needed

    await svc.executeProviderCredentialSave({ providerId: "shared-minimax", credential: "minimax-test-credential" });
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
      assert.equal((await svc.executeProviderConnectivityTest({ providerId: "shared-minimax" })).state, "reachable");
      globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
      assert.equal((await svc.executeProviderConnectivityTest({ providerId: "shared-minimax" })).state, "auth-failed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("#233 chat with no available route fails with actionable Settings guidance", async () => {
  await withService(async (svc) => {
    await assert.rejects(
      () => svc.executeBridgeChat({ workload: "augmentor-chat", model: "__auto__", messages: [{ role: "user", content: "hi" }] }),
      /no available provider route[\s\S]*Settings > Routing/,
      "route-unavailable error must point the user to Settings > Routing",
    );
  });
});

test("#233 configuring a provider makes its dependent routing strategies routable (fallback health)", async () => {
  await withService(async (svc) => {
    const before = await svc.executeProviderRoutingStrategies();
    assert.ok(before.strategies.every((s) => s.routeState !== "routable"), "no strategy is routable with nothing configured");

    await svc.executeProviderCredentialSave({ providerId: "shared-minimax", credential: "minimax-test-credential" });
    const after = await svc.executeProviderRoutingStrategies();
    assert.ok(
      after.strategies.some((s) => s.routeState === "routable"),
      "configuring a provider should make at least one strategy routable via its primary/fallback chain",
    );
  });
});

test("#233 no raw credential leaks into status, health, or connectivity payloads", async () => {
  await withService(async (svc) => {
    const secret = "SUPER-SECRET-minimax-credential-9f3c";
    await svc.executeProviderCredentialSave({ providerId: "shared-minimax", credential: secret });
    const status = JSON.stringify(await svc.executeProviderStatus());
    const health = JSON.stringify(await svc.executeProviderHealthCheck({ providerId: "shared-minimax" }));
    const connectivity = JSON.stringify(await svc.executeProviderConnectivityTest({ providerId: "shared-minimax" }));
    for (const [name, payload] of [["status", status], ["health", health], ["connectivity", connectivity]]) {
      assert.ok(!payload.includes(secret), `${name} payload must not contain the raw credential`);
    }
  });
});
