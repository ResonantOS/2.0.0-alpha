import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProviderBridgeService } from "../host/provider-bridge-service.mjs";

const PROVIDER_ENV = ["MINIMAX_API_KEY", "OPENAI_API_KEY", "ZAI_API_KEY", "GLM_API_KEY", "ZHIPUAI_API_KEY",
  "RESONANTOS_PROVIDER_SECRETS_JSON", "RESONANTOS_LOCAL_RUNTIME_URL", "RESONANTOS_PROVIDER_ALLOW_LOCAL_ENDPOINTS"];
const credential = "context-test-credential";
const contextSources = [
  ["living-archive", "page"], ["system-memory", "page"], ["conversation-memory", "compact"], ["archive-workspace", "workspace"],
].map(([source, kind]) => ({ source, kind, title: `${source}_TITLE`, path: `${source}_PATH`, text: `${source}_SECRET` }));
const payload = {
  contextSources,
  workload: "augmentor-chat", thinkingDepth: "high",
  pageContext: "Title: Page sentinel\nURL: https://page.test/\nPAGE_SECRET",
  tabContexts: [{ title: "Tab sentinel", url: "https://tab.test/", text: "TAB_SECRET" }],
  runtimeContext: "Composer attachments:\nfile.txt\nATTACHMENT_SECRET",
  messages: [{ role: "assistant", content: "leading fragment" }, { role: "user", content: "first" },
    { role: "user", content: "second" }, { role: "assistant", content: "answer" }, { role: "user", content: "inspect" }]
};
const expectedRecords = [
  { source: "current-page", title: "Page sentinel", url: "https://page.test/", text: payload.pageContext },
  { source: "referenced-tab", index: 1, title: "Tab sentinel", url: "https://tab.test/", text: "TAB_SECRET" },
  { source: "runtime-context", title: "Composer attachments", url: "unknown", text: payload.runtimeContext },
  ...contextSources
];
function reply(content = "context reply") {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage: null }) };
}
async function withService(run) {
  const previous = Object.fromEntries(PROVIDER_ENV.map(name => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  let root;
  try {
    for (const name of PROVIDER_ENV) delete process.env[name];
    root = await mkdtemp(path.join(os.tmpdir(), "resonant-context-"));
    const service = createProviderBridgeService({
      providerSecretsPath: () => path.join(root, "Secrets", "provider-secrets.json"),
      providerAccountsPath: () => path.join(root, "ProviderFabric", "provider-accounts.json"),
      providerRoutingPath: () => path.join(root, "ProviderFabric", "routing-strategies.json"),
      providerModelPreferencesPath: () => path.join(root, "ProviderFabric", "model-preferences.json"),
      providerDiagnosticsHistoryPath: () => path.join(root, "ProviderFabric", "diagnostics-history.json"),
      redactDiagnosticText: value => String(value ?? ""),
      unique: values => [...new Set(values.filter(Boolean))],
      extractJsonObject: value => JSON.parse(String(value ?? "{}")),
    });
    const captured = [];
    // Capture only; assert after submission so bridge error handling cannot swallow failures.
    globalThis.fetch = async (url, init) => {
      captured.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      return reply();
    };
    await run(service, captured);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    if (root) await rm(root, { recursive: true, force: true });
  }
}
function assertSafe(messages) {
  for (const sentinel of ["PAGE_SECRET", "TAB_SECRET", "ATTACHMENT_SECRET", "Page sentinel", "Tab sentinel", "https://page.test/", "https://tab.test/", "file.txt", ...contextSources.flatMap(record => [record.title, record.path, record.text])]) {
    assert.ok(!messages[0].content.includes(sentinel), `system must exclude ${sentinel}`);
  }
  assert.deepEqual(messages.map(message => message.role), ["system", "user", "assistant", "user"]);
  assert.equal(messages[1].content, "first\n\nsecond");
  assert.equal(messages[2].content, "answer");
  assert.ok(messages.every(message => typeof message.content === "string"));
  assert.ok(messages[3].content.startsWith("inspect\n\n<untrusted_context>\n"));
  const parsed = [...messages[3].content.matchAll(/^<untrusted_context>\n([^\n]+)\n<\/untrusted_context>$/gm)].map(match => JSON.parse(match[1]));
  assert.deepEqual(parsed, expectedRecords);
}
const routes = [
  ["MiniMax-M3", "shared-minimax", "https://api.minimax.io/v1/chat/completions"],
  ["gpt-5.5", "shared-openai", "https://api.openai.com/v1/chat/completions"],
  ["gpt-5.4-mini", "shared-openai", "https://api.openai.com/v1/chat/completions"],
  ["zai/glm-5.2", "shared-zai-glm", "http://127.0.0.1:18789/v1/chat/completions"],
  ["batiai/gemma4-e2b:q4", null, "http://127.0.0.1:11434/v1/chat/completions"],
  ["context-keyed-model", "custom-keyed", "https://context-provider.test/v1/chat/completions"],
  ["context-keyless-model", "custom-keyless", "http://127.0.0.1:11434/v1/chat/completions"],
];
test("every chat route sends context only in a valid user turn", async t => {
  for (const [model, providerId, url] of routes) await t.test(model, async () => withService(async (svc, captured) => {
    const keyless = !providerId || providerId === "custom-keyless";
    // Built-in loopback routes require this supported endpoint opt-in in the
    // current bridge. Fetch remains stubbed; no listener or network is used.
    if (providerId === "shared-zai-glm" || !providerId) process.env.RESONANTOS_PROVIDER_ALLOW_LOCAL_ENDPOINTS = "1";
    if (providerId?.startsWith("custom")) {
      await svc.executeProviderAccountSave({ mode: "create", templateId: keyless ? "ollama" : "openai-compatible",
        label: providerId, providerType: keyless ? "local" : "openai-compatible", apiBaseUrl: url.replace("/chat/completions", ""),
        models: [model], credential: keyless ? "" : credential });
    } else if (providerId) await svc.executeProviderCredentialSave({ providerId, credential });
    const out = await svc.executeBridgeChat({ ...payload, model });
    assert.equal(captured.length, 1);
    assert.equal(out.reply, "context reply");
    assert.equal(out.model, model);
    assert.equal(out.requestedModel, model);
    const [request] = captured;
    assert.equal(request.url, url);
    assert.equal(request.body.model, model);
    assert.equal(request.headers.Authorization, keyless ? undefined : `Bearer ${credential}`);
    assert.equal(request.headers["Content-Type"], "application/json");
    if (model.startsWith("gpt-")) assert.equal(request.body.reasoning_effort, "high");
    else assert.equal(request.body.reasoning_effort, undefined);
    assertSafe(request.body.messages);
  }));
});

test("fallback attempts reuse the same safe contextual conversation", async () => withService(async (svc, captured) => {
  await svc.executeProviderCredentialSave({ providerId: "shared-minimax", credential });
  await svc.executeProviderCredentialSave({ providerId: "shared-openai", credential });
  await svc.executeProviderRoutingStrategySave({ strategyId: "augmentor-chat", primaryModel: "MiniMax-M3", fallbackModels: ["gpt-5.5"], costPosture: "quality-first", hardStop: false });
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return captured.length === 1 ? { ok: false, status: 500, json: async () => ({ error: { message: "primary down" } }) } : reply("fallback reply");
  };
  const out = await svc.executeBridgeChat({ ...payload, model: "__auto__" });
  assert.equal(captured.length, 2);
  assert.deepEqual(captured.map(request => request.body.model), ["MiniMax-M3", "gpt-5.5"]);
  assert.deepEqual(captured[0].body.messages, captured[1].body.messages);
  assert.equal(out.reply, "fallback reply");
  assert.equal(out.model, "gpt-5.5");
  assert.equal(out.routeFallback, true);
  assert.match(out.routeNotice, /Preferred model MiniMax-M3 unavailable/);
  // Check each attempt separately so the test reports both unsafe submissions.
  assert.deepEqual(captured.map(request => request.body.messages[0].content.includes("PAGE_SECRET")), [false, false]);
  for (const request of captured) assertSafe(request.body.messages);
}));

test("invalid contextual history makes no provider request", async () => withService(async (svc, captured) => {
  await svc.executeProviderCredentialSave({ providerId: "shared-openai", credential });
  const histories = [
    [[{ role: "assistant", content: "answer" }], "Context requires a user message."],
    [[{ role: "user", content: "question" }, { role: "assistant", content: "answer" }], "Contextual chat must end with a user message."]
  ];
  for (const [messages, message] of histories) for (const context of [payload, { contextSources }]) {
    const result = await svc.executeBridgeChat({ ...context, model: "gpt-5.5", messages }).then(() => null, error => error);
    assert.equal(captured.length, 0, "invalid contextual history must make zero provider requests");
    assert.equal(result?.message, message);
  }
}));
