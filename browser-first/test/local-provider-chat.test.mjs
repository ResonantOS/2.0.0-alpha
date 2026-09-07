// #218 follow-up — local/keyless providers must not demand a credential at chat time.
// A custom Ollama account (authType local-runtime, no API key) must be routable
// when its model is selected, instead of failing with "no active provider credential".
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
  const root = await mkdtemp(path.join(os.tmpdir(), "resonant-local-"));
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

const localOllamaAccount = {
  mode: "create",
  templateId: "ollama",
  label: "Ollama local",
  providerType: "local",
  apiBaseUrl: "http://127.0.0.1:11434/v1",
  models: ["deepseek-v4-flash:cloud"],
  credential: "",
};

test("local Ollama account without API key is routable and does not demand a credential", async () => {
  await withService(async (svc, setFetch) => {
    const saveResult = await svc.executeProviderAccountSave(localOllamaAccount);
    assert.equal(saveResult.provider.authType, "local-runtime", "account should be saved as local-runtime");
    assert.equal(saveResult.provider.models[0]?.model, "deepseek-v4-flash:cloud");

    let requestedUrl;
    setFetch(async (url, init) => {
      requestedUrl = String(url);
      assert.equal(init.headers?.Authorization, undefined, "local-runtime chat must not send an Authorization header");
      return reply("hello from local Ollama");
    });

    const out = await svc.executeBridgeChat({
      workload: "augmentor-chat",
      model: "deepseek-v4-flash:cloud",
      messages: [{ role: "user", content: "hi" }],
    });

    assert.match(requestedUrl, /127\.0\.0\.1:11434/);
    assert.equal(out.model, "deepseek-v4-flash:cloud");
    assert.equal(out.requestedModel, "deepseek-v4-flash:cloud");
    assert.equal(out.routeSource, "manual");
    assert.equal(out.reply, "hello from local Ollama");
  });
});

test("provider status reports a local-runtime account as configured without a credential", async () => {
  await withService(async (svc) => {
    const { provider } = await svc.executeProviderAccountSave(localOllamaAccount);
    const status = await svc.executeProviderStatus();
    const found = status.providers.find((p) => p.id === provider.id);
    assert.ok(found, `provider not found in status: ${status.providers.map((p) => p.id).join(", ")}`);
    assert.equal(found.authType, "local-runtime");
    assert.equal(found.configured, true, "local-runtime provider should be configured without a credential");
    const model = found.models.find((m) => m.model === "deepseek-v4-flash:cloud");
    assert.ok(model, "local model should appear in provider status");
    assert.equal(model.runtime, "local", "custom local model should inherit local runtime");
  });
});

test("local provider accounts saved with stale api-key authType are normalized to local-runtime", async () => {
  await withService(async (svc) => {
    const stale = { ...localOllamaAccount, authType: "api-key" };
    const { provider } = await svc.executeProviderAccountSave(stale);
    assert.equal(provider.authType, "local-runtime", "providerType local must force local-runtime authType");

    const status = await svc.executeProviderStatus();
    const found = status.providers.find((p) => p.id === provider.id);
    assert.equal(found.configured, true, "normalized local account should not require a credential");
  });
});

test("legacy Ollama endpoint without /v1 is normalized so chat hits /v1/chat/completions", async () => {
  await withService(async (svc, setFetch) => {
    const legacy = { ...localOllamaAccount, apiBaseUrl: "http://127.0.0.1:11434" };
    const { provider } = await svc.executeProviderAccountSave(legacy);
    assert.equal(provider.apiBaseUrl, "http://127.0.0.1:11434/v1", "legacy local endpoint should be normalized to /v1");

    let requestedUrl;
    setFetch(async (url, init) => {
      requestedUrl = String(url);
      assert.match(requestedUrl, /\/v1\/chat\/completions$/);
      assert.equal(init.headers?.Authorization, undefined);
      return reply("hello from normalized Ollama");
    });

    const out = await svc.executeBridgeChat({
      workload: "augmentor-chat",
      model: "deepseek-v4-flash:cloud",
      messages: [{ role: "user", content: "hi" }],
    });

    assert.equal(out.reply, "hello from normalized Ollama");
  });
});

test("inline assistant routes to local provider instead of falling back to local-fallback", async () => {
  await withService(async (svc, setFetch) => {
    await svc.executeProviderAccountSave(localOllamaAccount);
    let requestedUrl;
    setFetch(async (url, init) => {
      requestedUrl = String(url);
      assert.equal(init.headers?.Authorization, undefined, "local inline assistant must not send Authorization");
      return reply("local inline reply");
    });

    const out = await svc.executeInlineAssistant({
      action: "summarize",
      model: "deepseek-v4-flash:cloud",
      selection: "Some selected text to summarize.",
      pageContext: "",
    });

    assert.match(requestedUrl, /127\.0\.0\.1:11434/);
    assert.equal(out.reply, "local inline reply");
    assert.notEqual(out.model, "local-inline-fallback");
  });
});

test("local software templates saved as openai-compatible are reclassified as keyless local runtimes", async () => {
  await withService(async (svc, setFetch) => {
    const legacyVllm = {
      mode: "create",
      templateId: "vllm",
      label: "vLLM local",
      providerType: "openai-compatible",
      apiBaseUrl: "http://127.0.0.1:8000/v1",
      models: ["local-model"],
      credential: "",
    };
    const { provider } = await svc.executeProviderAccountSave(legacyVllm);
    assert.equal(provider.providerType, "local", "vllm template should be reclassified as local");
    assert.equal(provider.authType, "local-runtime", "vllm template should not require an API key");

    let requestedUrl;
    setFetch(async (url, init) => {
      requestedUrl = String(url);
      assert.equal(init.headers?.Authorization, undefined, "reclassified local runtime must not send an Authorization header");
      return reply("hello from vLLM");
    });

    const out = await svc.executeBridgeChat({
      workload: "augmentor-chat",
      model: "local-model",
      messages: [{ role: "user", content: "hi" }],
    });

    assert.match(requestedUrl, /127\.0\.0\.1:8000\/v1\/chat\/completions$/);
    assert.equal(out.reply, "hello from vLLM");
  });
});
