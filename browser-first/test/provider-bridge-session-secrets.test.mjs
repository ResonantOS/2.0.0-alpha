import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

const providerEnvNames = [
  "MINIMAX_API_KEY",
  "OPENAI_API_KEY",
  "ZAI_API_KEY",
  "GLM_API_KEY",
  "ZHIPUAI_API_KEY",
  "RESONANTOS_PROVIDER_SECRETS_JSON",
  "RESONANTOS_PROVIDER_ARCHIVE_TIMEOUT_MS",
  "RESONANTOS_PROVIDER_CHAT_TIMEOUT_MS",
  "RESONANTOS_PROVIDER_INLINE_TIMEOUT_MS",
];

function withProviderEnv(values = {}) {
  const previous = Object.fromEntries(providerEnvNames.map((name) => [name, process.env[name]]));
  for (const name of providerEnvNames) {
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(values)) {
    process.env[name] = value;
  }
  return () => {
    for (const name of providerEnvNames) {
      if (previous[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous[name];
      }
    }
  };
}

test("provider credentials saved through the alpha host are session-only", async () => {
  const restoreEnv = withProviderEnv();
  const root = await mkdtemp(path.join(os.tmpdir(), "resonantos-provider-session-"));
  const secretPath = path.join(root, "Secrets", "provider-secrets.json");
  const service = createService(root);
  try {
    const saved = await service.executeProviderCredentialSave({
      providerId: "shared-minimax",
      credential: "minimax-test-credential",
    });

    assert.equal(saved.configured, true);
    assert.equal(saved.persistence, "session-only");
    assert.equal(existsSync(secretPath), false);
    assert.equal((await service.readProviderSecrets())["shared-minimax"], "minimax-test-credential");

    const status = await service.executeProviderStatus();
    const minimax = status.providers.find((provider) => provider.id === "shared-minimax");
    assert.equal(status.vault.persistence, "session-only");
    assert.equal(status.vault.legacyPlaintextDetected, false);
    assert.equal(minimax.configured, true);
    assert.equal(minimax.credentialPreview, "session");
  } finally {
    restoreEnv();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy plaintext provider secret files are detected but ignored", async () => {
  const restoreEnv = withProviderEnv();
  const root = await mkdtemp(path.join(os.tmpdir(), "resonantos-provider-legacy-"));
  const secretPath = path.join(root, "Secrets", "provider-secrets.json");
  const service = createService(root);
  try {
    await mkdir(path.dirname(secretPath), { recursive: true });
    await writeFile(secretPath, JSON.stringify({ "shared-minimax": "legacy-plaintext-secret" }));

    const secrets = await service.readProviderSecrets();
    const status = await service.executeProviderStatus();
    const minimax = status.providers.find((provider) => provider.id === "shared-minimax");

    assert.equal(secrets["shared-minimax"], undefined);
    assert.equal(status.vault.legacyPlaintextDetected, true);
    assert.equal(minimax.configured, false);
    assert.equal(minimax.credentialPreview, "missing");
  } finally {
    restoreEnv();
    await rm(root, { recursive: true, force: true });
  }
});

test("common provider environment keys configure built-in providers without persistence", async () => {
  const restoreEnv = withProviderEnv({
    OPENAI_API_KEY: "openai-env-credential",
    ZAI_API_KEY: "zai-env-credential",
  });
  const root = await mkdtemp(path.join(os.tmpdir(), "resonantos-provider-env-"));
  const secretPath = path.join(root, "Secrets", "provider-secrets.json");
  const service = createService(root);
  try {
    const secrets = await service.readProviderSecrets();
    const status = await service.executeProviderStatus();
    const openai = status.providers.find((provider) => provider.id === "shared-openai");
    const zai = status.providers.find((provider) => provider.id === "shared-zai-glm");
    const minimax = status.providers.find((provider) => provider.id === "shared-minimax");

    assert.equal(secrets["shared-openai"], "openai-env-credential");
    assert.equal(secrets["shared-zai-glm"], "zai-env-credential");
    assert.equal(secrets["shared-minimax"], undefined);
    assert.equal(status.vault.configured, true);
    assert.equal(status.vault.persistence, "session-only");
    assert.equal(existsSync(secretPath), false);
    assert.equal(openai.configured, true);
    assert.equal(zai.configured, true);
    assert.equal(minimax.configured, false);
  } finally {
    restoreEnv();
    await rm(root, { recursive: true, force: true });
  }
});

test("provider account save enforces credential-safe endpoint policy", async () => {
  const restoreEnv = withProviderEnv();
  const root = await mkdtemp(path.join(os.tmpdir(), "resonantos-provider-endpoint-policy-"));
  const service = createService(root);
  try {
    await assert.rejects(
      () => service.executeProviderAccountSave({
        label: "Metadata Target",
        providerType: "openai-compatible",
        templateId: "openai-compatible",
        apiBaseUrl: "http://169.254.169.254/latest",
        models: ["custom-model"],
        credential: "custom-test-credential",
      }),
      /HTTPS|local, private, or metadata-network/,
    );

    await assert.rejects(
      () => service.executeProviderAccountSave({
        label: "Plain HTTP Public",
        providerType: "openai-compatible",
        templateId: "openai-compatible",
        apiBaseUrl: "http://api.example.com/v1",
        models: ["custom-model"],
        credential: "custom-test-credential",
      }),
      /must use HTTPS/,
    );

    await assert.rejects(
      () => service.executeProviderAccountSave({
        label: "Embedded Credentials",
        providerType: "openai-compatible",
        templateId: "openai-compatible",
        apiBaseUrl: "https://user:pass@api.example.com/v1",
        models: ["custom-model"],
        credential: "custom-test-credential",
      }),
      /embedded credentials/,
    );

    await assert.rejects(
      () => service.executeProviderAccountSave({
        label: "OpenAI Override",
        providerType: "openai",
        templateId: "openai",
        apiBaseUrl: "https://api.attacker.example/v1",
        models: ["gpt-5.5"],
        credential: "openai-test-credential",
      }),
      /built-in provider endpoint/,
    );

    const publicCustom = await service.executeProviderAccountSave({
      label: "Public Custom",
      providerType: "openai-compatible",
      templateId: "openai-compatible",
      apiBaseUrl: "https://api.example.com/v1/",
      models: ["custom-model"],
      credential: "custom-test-credential",
    });
    assert.equal(publicCustom.provider.apiBaseUrl, "https://api.example.com/v1");

    const localRuntime = await service.executeProviderAccountSave({
      label: "Local Runtime",
      providerType: "local",
      templateId: "ollama",
      apiBaseUrl: "http://127.0.0.1:11434/v1",
      models: ["local-model"],
    });
    assert.equal(localRuntime.provider.apiBaseUrl, "http://127.0.0.1:11434/v1");
  } finally {
    restoreEnv();
    await rm(root, { recursive: true, force: true });
  }
});

function abortingFetch() {
  return async (_url, options = {}) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    });
  });
}

test("provider chat times out a strategy route and falls back to the next configured route", async () => {
  const restoreEnv = withProviderEnv({
    MINIMAX_API_KEY: "minimax-env-credential",
    OPENAI_API_KEY: "openai-env-credential",
    RESONANTOS_PROVIDER_CHAT_TIMEOUT_MS: "5",
  });
  const previousFetch = globalThis.fetch;
  const root = await mkdtemp(path.join(os.tmpdir(), "resonantos-provider-chat-timeout-"));
  const service = createService(root);
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push(String(url));
    if (calls.length === 1) {
      return abortingFetch()(url, options);
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "fallback route reply" } }],
        usage: { total_tokens: 12 },
      }),
    };
  };
  try {
    const result = await service.executeBridgeChat({
      model: "__auto__",
      messages: [{ role: "user", content: "hello" }],
    });

    assert.equal(result.reply, "fallback route reply");
    assert.equal(result.providerId, "shared-openai");
    assert.equal(calls.length, 2);
    assert.match(calls[0], /api\.minimax\.io/);
    assert.match(calls[1], /api\.openai\.com/);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv();
    await rm(root, { recursive: true, force: true });
  }
});

test("archive semantic verifier reports provider timeout as unavailable", async () => {
  const restoreEnv = withProviderEnv({
    OPENAI_API_KEY: "openai-env-credential",
    RESONANTOS_PROVIDER_ARCHIVE_TIMEOUT_MS: "5",
  });
  const previousFetch = globalThis.fetch;
  const root = await mkdtemp(path.join(os.tmpdir(), "resonantos-provider-archive-timeout-"));
  const service = createService(root);
  globalThis.fetch = abortingFetch();
  try {
    const result = await service.runArchiveSemanticVerifier({
      artifactPath: "artifact.json",
      requestPath: "request.json",
      sourceContent: "source",
      proposedPage: "Page",
      proposedContent: "content",
    });

    assert.equal(result.semanticStatus, "unavailable");
    assert.equal(result.providerId, "shared-openai");
    assert.match(result.semanticSummary, /timed out/i);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv();
    await rm(root, { recursive: true, force: true });
  }
});

test("inline assistant falls back when the provider request times out", async () => {
  const restoreEnv = withProviderEnv({
    OPENAI_API_KEY: "openai-env-credential",
    RESONANTOS_PROVIDER_INLINE_TIMEOUT_MS: "5",
  });
  const previousFetch = globalThis.fetch;
  const root = await mkdtemp(path.join(os.tmpdir(), "resonantos-provider-inline-timeout-"));
  const service = createService(root);
  globalThis.fetch = abortingFetch();
  try {
    const result = await service.executeInlineAssistant({
      action: "summarize",
      model: "gpt-5.5",
      selection: "This text should be summarized.",
    });

    assert.equal(result.providerId, "local-fallback");
    assert.equal(result.model, "local-inline-fallback");
    assert.match(result.reply, /Summary/);
    assert.match(result.usage.providerError, /timed out/i);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv();
    await rm(root, { recursive: true, force: true });
  }
});
