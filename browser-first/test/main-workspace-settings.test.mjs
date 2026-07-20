import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { renderSettingsWorkspace } from "../resonantos-side-panel-extension/src/lib/main-workspace-settings.js";
import {
  buildMoveImportPreflight,
  executeMoveImport,
  rollbackMoveImport,
  shouldDeregisterMovedSourceAfterRollback,
} from "../host/memory-source-move.mjs";

function memoryStorage(initial = {}) {
  const state = { ...initial };
  return {
    state,
    async get(keys) {
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, state[key]]));
      }
      if (typeof keys === "string") {
        return { [keys]: state[keys] };
      }
      return { ...state };
    },
    async set(next) {
      Object.assign(state, next);
    }
  };
}

function setupDom() {
  const dom = new JSDOM("<!doctype html><main id=\"root\"></main>", { url: "https://resonantos.local/" });
  dom.window.confirm = () => true;
  dom.window.prompt = () => "";
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Event = dom.window.Event;
  return {
    container: dom.window.document.querySelector("#root"),
    cleanup: () => {
      delete globalThis.window;
      delete globalThis.document;
      delete globalThis.HTMLElement;
      delete globalThis.Event;
    }
  };
}

async function waitForCondition(predicate, { timeout = 2_000, interval = 20 } = {}) {
  const started = Date.now();
  let lastValue;
  while (Date.now() - started < timeout) {
    lastValue = await predicate();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return lastValue;
}

test("settings workspace renders provider status without exposing credentials", async () => {
  const { container, cleanup } = setupDom();
  const calls = [];
  const diagnosticsHistory = [{
    providerId: "shared-openai",
    label: "OpenAI",
    state: "auth-failed",
    status: 401,
    latencyMs: 31,
    testedAt: "2026-05-29T09:00:00.000Z",
    endpoint: "provider models endpoint",
    detail: "OpenAI endpoint responded, but authentication failed. Update the stored credential."
  }, {
    providerId: "shared-openai",
    label: "OpenAI",
    state: "auth-failed",
    status: 401,
    latencyMs: 28,
    testedAt: "2026-05-29T08:30:00.000Z",
    endpoint: "provider models endpoint",
    detail: "Authentication failed. Stored credential was rejected."
  }];
  const bridgeRequest = async (route, options = {}) => {
    calls.push([route, options]);
    if (route === "/providers/status") {
      return {
        providers: [
          {
            id: "shared-openai",
            label: "OpenAI",
            authType: "api-key",
            role: "High-reasoning fallback",
            models: [{
              model: "gpt-5.5",
              label: "GPT 5.5",
              costTier: "paid-per-call",
              qualityTier: "highest reasoning"
            }],
            routeConsumers: [{
              id: "archive-ingest",
              label: "Archive Ingest",
              workload: "knowledge_promotion",
              routeState: "unavailable",
              hardStop: true
            }],
            configured: false,
            credentialPreview: "missing"
          },
          {
            id: "shared-minimax",
            label: "MiniMax",
            authType: "api-key",
            role: "Default Augmentor provider",
            models: [{
              model: "MiniMax-M3",
              label: "MiniMax M3",
              costTier: "subscription",
              qualityTier: "daily strategic and agentic work",
              allowed: true
            }],
            routeConsumers: [{
              id: "augmentor-chat",
              label: "Augmentor Chat",
              workload: "trusted_conversation",
              routeState: "routable",
              hardStop: false
            }],
            configured: true,
            credentialPreview: "stored"
          }
        ],
        vault: {
          configured: true,
          location: "ResonantOS local provider vault"
        }
      };
    }
    if (route === "/providers/health") {
      return {
        providerId: options.body.providerId,
        label: options.body.providerId === "shared-minimax" ? "MiniMax" : "OpenAI",
        state: options.body.providerId === "shared-minimax" ? "ready" : "missing-credential",
        detail: options.body.providerId === "shared-minimax"
          ? "MiniMax is configured and available to all dependent routing strategies."
          : "OpenAI has no stored credential in the local provider vault.",
        checkedAt: "2026-05-29T00:00:00.000Z"
      };
    }
    if (route === "/providers/connectivity-test") {
      const entry = {
        providerId: options.body.providerId,
        label: options.body.providerId === "shared-minimax" ? "MiniMax" : "OpenAI",
        state: options.body.providerId === "shared-minimax" ? "reachable" : "missing-credential",
        status: options.body.providerId === "shared-minimax" ? 200 : null,
        detail: options.body.providerId === "shared-minimax"
          ? "MiniMax endpoint is reachable. No prompt or model generation request was sent."
          : "OpenAI cannot be tested because no credential is stored in the local provider vault.",
        latencyMs: 42,
        testedAt: "2026-05-29T00:00:00.000Z"
      };
      diagnosticsHistory.unshift(entry);
      return {
        ...entry
      };
    }
    if (route === "/providers/diagnostics-history") {
      return { entries: diagnosticsHistory };
    }
    if (route === "/providers/model-preferences") {
      return {
        providerId: options.body.providerId,
        allowedModels: options.body.allowedModels,
        savedAt: "2026-05-29T00:00:00.000Z"
      };
    }
    if (route === "/providers/routing-strategies") {
      return {
        models: [
          { model: "MiniMax-M3", label: "MiniMax M3", providerLabel: "MiniMax", costTier: "subscription" },
          { model: "gpt-5.5", label: "GPT 5.5", providerLabel: "OpenAI", costTier: "paid-per-call" }
        ],
        strategies: [{
          id: "augmentor-chat",
          label: "Augmentor Chat",
          workload: "trusted_conversation",
          primaryModel: "MiniMax-M3",
          fallbackModels: ["gpt-5.5"],
          fallbackChain: [{ model: "gpt-5.5", label: "GPT 5.5", providerLabel: "OpenAI", costTier: "paid-per-call", configured: false }],
          routeState: "routable",
          hardStop: false,
          costPosture: "subscription-first"
        }]
      };
    }
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderSettingsWorkspace({ container, bridgeRequest, initialSection: "providers" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(container.textContent, /Start Here/);
    assert.match(container.textContent, /Providers/);
    assert.match(container.textContent, /Provider Profiles/);
    assert.match(container.textContent, /MiniMax/);
    assert.match(container.textContent, /OpenAI/);
    assert.match(container.textContent, /Credential store/);
    assert.match(container.textContent, /Created/);
    assert.equal(container.querySelector(".settings-provider-advanced").open, false);
    const initialMiniMaxCard = [...container.querySelectorAll(".settings-provider-card")].find((card) => /MiniMax/.test(card.textContent));
    assert.match(initialMiniMaxCard.textContent, /Details/);
    assert.match(initialMiniMaxCard.textContent, /More/);
    initialMiniMaxCard.querySelector("[data-action='show-provider']").click();
    assert.match(initialMiniMaxCard.textContent, /Hide details/);
    assert.match(container.textContent, /MiniMax M3 · subscription · daily strategic and agentic work/i);
    const initialOpenAiCard = [...container.querySelectorAll(".settings-provider-card")].find((card) => /OpenAI/.test(card.textContent));
    initialOpenAiCard.querySelector("[data-action='show-provider']").click();
    assert.match(container.textContent, /GPT 5\.5 · paid per call · highest reasoning/i);
    assert.match(container.textContent, /Augmentor Chat/);
    assert.match(container.textContent, /Archive Ingest/);
    assert.match(container.textContent, /trusted conversation · fallback allowed · routable/i);
    assert.match(container.textContent, /knowledge promotion · hard-stop · unavailable/i);
    assert.match(container.textContent, /1\/2 provider profiles configured/);
    assert.match(container.textContent, /Recent provider diagnostics/);
    assert.match(container.textContent, /Suggested recovery/);
    assert.match(container.textContent, /OpenAI: credential recovery needed/);
    assert.match(container.textContent, /Update or replace the stored credential/i);
    assert.match(container.textContent, /OpenAI · auth failed/i);
    assert.match(container.textContent, /HTTP 401 · 31ms/i);
    assert.doesNotMatch(container.textContent, /sk-|Bearer|api_key/i);

    const miniMaxCard = [...container.querySelectorAll(".settings-provider-card")].find((card) => /MiniMax/.test(card.textContent));
    miniMaxCard.querySelector("[data-action='show-provider']").click();
    const miniMaxModel = [...miniMaxCard.querySelectorAll("input[name='allowedModel']")].find((input) => input.value === "MiniMax-M3");
    miniMaxModel.checked = true;
    miniMaxCard.querySelector(".settings-provider-model-policy").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(calls.some(([route, options]) =>
      route === "/providers/model-preferences" &&
      options.capability === "provider-routing-write" &&
      options.body.providerId === "shared-minimax" &&
      options.body.allowedModels.length === 1 &&
      options.body.allowedModels[0] === "MiniMax-M3"
    ));
    const reloadedMiniMaxCard = [...container.querySelectorAll(".settings-provider-card")].find((card) => /MiniMax/.test(card.textContent));
    [...reloadedMiniMaxCard.querySelectorAll(".settings-provider-actions button")].find((button) => button.textContent === "Check readiness").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(container.textContent, /MiniMax is configured and available/i);
    [...reloadedMiniMaxCard.querySelectorAll(".settings-provider-actions button")].find((button) => button.textContent === "Test connection").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(calls.some(([route, options]) =>
      route === "/providers/connectivity-test" &&
      options.body.providerId === "shared-minimax"
    ));
    assert.match(container.textContent, /No prompt or model generation request was sent/i);
    assert.match(container.textContent, /MiniMax · reachable/i);
    assert.match(container.textContent, /HTTP 200 · 42ms/i);
    assert.doesNotMatch(container.textContent, /stored-minimax|sk-|Bearer|api_key/i);
    [...reloadedMiniMaxCard.querySelectorAll(".settings-provider-actions button")].find((button) => button.textContent === "Open routing").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(container.textContent, /Provider Fabric Routing/i);
    assert.match(container.textContent, /Subscription first/i);
  } finally {
    cleanup();
  }
});

test("settings workspace saves provider credentials through the host bridge", async () => {
  const { container, cleanup } = setupDom();
  const calls = [];
  let configured = false;
  const bridgeRequest = async (route, options = {}) => {
    calls.push([route, options]);
    if (route === "/providers/status") {
      return {
        providers: [{
          id: "shared-minimax",
          label: "MiniMax",
          role: "Default Augmentor provider",
          models: ["MiniMax-M3"],
          configured,
          credentialPreview: configured ? "stored" : "missing"
        }]
      };
    }
    if (route === "/providers/credentials") {
      configured = true;
      return { providerId: options.body.providerId, configured: true, savedAt: "2026-05-28T00:00:00.000Z" };
    }
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderSettingsWorkspace({ container, bridgeRequest, initialSection: "providers" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const card = container.querySelector(".settings-provider-card");
    card.querySelector("[data-action='edit-provider']").click();
    const input = card.querySelector(".settings-provider-form input[name='credential']");
    input.value = "minimax-test-credential";
    card.querySelector(".settings-provider-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(calls.some(([route, options]) =>
      route === "/providers/credentials" &&
      options.capability === "provider-credential-write" &&
      options.body.providerId === "shared-minimax" &&
      options.body.credential === "minimax-test-credential"
    ));
    assert.equal(input.value, "");
    assert.match(container.textContent, /1\/1 provider profiles configured/);
  } finally {
    cleanup();
  }
});

test("settings provider profiles can add and edit separate accounts for the same provider type", async () => {
  const { container, cleanup } = setupDom();
  const calls = [];
  const providers = [
    {
      id: "minimax-fast",
      label: "MiniMax Fast",
      providerType: "minimax",
      authType: "api-key",
      apiBaseUrl: "https://api.minimax.io/v1",
      role: "Fast subscription account for Augmentor",
      source: "user",
      models: [{
        model: "MiniMax-M3",
        label: "MiniMax M3",
        costTier: "subscription",
        qualityTier: "daily strategic work",
        allowed: true
      }],
      routeConsumers: [],
      configured: true,
      credentialPreview: "stored"
    },
    {
      id: "minimax-routine",
      label: "MiniMax Routine",
      providerType: "minimax",
      authType: "api-key",
      apiBaseUrl: "https://api.minimax.io/v1",
      role: "Slow subscription account for background work",
      source: "user",
      models: [{
        model: "MiniMax-M3",
        label: "MiniMax M3",
        costTier: "subscription",
        qualityTier: "routine and fallback work",
        allowed: true
      }],
      routeConsumers: [],
      configured: false,
      credentialPreview: "missing"
    }
  ];
  const bridgeRequest = async (route, options = {}) => {
    calls.push([route, options]);
    if (route === "/providers/status") {
      return {
        providers,
        vault: { configured: true, location: "ResonantOS local provider vault" }
      };
    }
    if (route === "/providers/diagnostics-history") return { entries: [] };
    if (route === "/providers/accounts") {
      if (options.body.mode === "update") {
        const index = providers.findIndex((provider) => provider.id === options.body.id);
        providers[index] = {
          ...providers[index],
          label: options.body.label,
          role: options.body.role,
          apiBaseUrl: options.body.apiBaseUrl,
          models: options.body.models.map((model) => ({ model, label: model, costTier: "subscription", qualityTier: "custom" })),
          configured: Boolean(options.body.credential) || providers[index].configured,
          credentialPreview: Boolean(options.body.credential) || providers[index].configured ? "stored" : "missing"
        };
        return { provider: providers[index], configured: providers[index].configured };
      }
      providers.push({
        id: "minimax-research",
        label: options.body.label,
        providerType: options.body.providerType,
        authType: "api-key",
        apiBaseUrl: options.body.apiBaseUrl,
        role: options.body.role,
        source: "user",
        models: options.body.models.map((model) => ({ model, label: model, costTier: "subscription", qualityTier: "custom" })),
        routeConsumers: [],
        configured: true,
        credentialPreview: "stored"
      });
      return { provider: providers.at(-1), configured: true };
    }
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderSettingsWorkspace({ container, bridgeRequest, initialSection: "providers" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(container.textContent, /MiniMax Fast/);
    assert.match(container.textContent, /MiniMax Routine/);
    assert.doesNotMatch(container.textContent, /Use one block per account/i);
    const fastCard = [...container.querySelectorAll(".settings-provider-card")].find((card) => /MiniMax Fast/.test(card.textContent));
    fastCard.querySelector("[data-action='show-provider']").click();
    assert.match(container.textContent, /Provider type: MiniMax · Account ID: minimax-fast/i);

    container.querySelector(".settings-provider-toolbar button").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const modal = document.querySelector(".settings-provider-modal");
    assert.ok(modal);
    modal.querySelector("input[name='label']").value = "MiniMax Research";
    modal.querySelector("select[name='templateId']").value = "minimax";
    modal.querySelector("input[name='apiBaseUrl']").value = "https://api.minimax.io/v1";
    modal.querySelector("input[name='role']").value = "Research subscription account";
    modal.querySelector("textarea[name='models']").value = "MiniMax-M3";
    modal.querySelector("input[name='credential']").value = "minimax-research-key";
    modal.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(calls.some(([route, options]) =>
      route === "/providers/accounts" &&
      options.capability === "provider-credential-write" &&
      options.body.mode === "create" &&
      options.body.templateId === "minimax" &&
      options.body.label === "MiniMax Research" &&
      options.body.providerType === "minimax" &&
      options.body.credential === "minimax-research-key"
    ));
    assert.match(container.textContent, /MiniMax Research/);
    assert.match(container.textContent, /2\/3 provider profiles configured/);

    const routineCard = [...container.querySelectorAll(".settings-provider-card")]
      .find((card) => /MiniMax Routine/.test(card.textContent));
    routineCard.querySelector("[data-action='edit-provider']").click();
    routineCard.querySelector("input[name='label']").value = "MiniMax Slow";
    routineCard.querySelector("input[name='role']").value = "Background and cron account";
    routineCard.querySelector("textarea[name='models']").value = "MiniMax-M3";
    routineCard.querySelector(".settings-provider-account-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(calls.some(([route, options]) =>
      route === "/providers/accounts" &&
      options.body.mode === "update" &&
      options.body.id === "minimax-routine" &&
      options.body.label === "MiniMax Slow"
    ));
    assert.match(container.textContent, /MiniMax Slow/);
  } finally {
    document.querySelector(".settings-provider-modal")?.remove();
    cleanup();
  }
});

test("settings provider add modal exposes comprehensive cloud, gateway, local, and custom templates", async () => {
  const { container, cleanup } = setupDom();
  const bridgeRequest = async (route) => {
    if (route === "/providers/status") {
      return { providers: [], vault: { configured: false, location: "ResonantOS local provider vault" } };
    }
    if (route === "/providers/diagnostics-history") return { entries: [] };
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderSettingsWorkspace({ container, bridgeRequest, initialSection: "providers" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    container.querySelector(".settings-provider-toolbar button").click();
    const select = document.querySelector("select[name='templateId']");
    const optionText = [...select.querySelectorAll("option")].map((option) => option.textContent);
    const optionValues = [...select.querySelectorAll("option")].map((option) => option.value);

    assert.ok(optionText.includes("Ollama"));
    assert.ok(optionText.includes("LM Studio"));
    assert.ok(optionText.includes("OpenRouter"));
    assert.ok(optionText.includes("Groq"));
    assert.ok(optionText.includes("Together AI"));
    assert.ok(optionText.includes("DeepSeek"));
    assert.ok(optionText.includes("Mistral AI"));
    assert.ok(optionText.includes("OpenAI-Compatible API"));
    assert.ok(optionValues.includes("asus-gx10"));

    select.value = "ollama";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    assert.equal(document.querySelector("input[name='apiBaseUrl']").value, "http://127.0.0.1:11434");
    assert.match(document.querySelector("textarea[name='models']").value, /batiai\/gemma4-e2b:q4/);
  } finally {
    document.querySelector(".settings-provider-modal")?.remove();
    cleanup();
  }
});

test("settings routing section renders cost-aware workload strategies", async () => {
  const { container, cleanup } = setupDom();
  const bridgeRequest = async (route, options = {}) => {
    if (route === "/providers/routing-strategies") {
      return {
        models: [
          { model: "MiniMax-M3", label: "MiniMax M3", providerLabel: "MiniMax", costTier: "subscription" },
          { model: "gpt-5.5", label: "GPT 5.5", providerLabel: "OpenAI", costTier: "paid-per-call" }
        ],
        strategies: [{
          id: "augmentor-chat",
          label: "Augmentor Chat",
          workload: "trusted_conversation",
          primaryModel: "MiniMax-M3",
          fallbackModels: ["gpt-5.5"],
          costPosture: "subscription-first",
          hardStop: false,
          notes: "Use subscription first.",
          routeState: "routable",
          primary: {
            label: "MiniMax M3",
            providerLabel: "MiniMax",
            costTier: "subscription",
            state: "available"
          },
          fallbackChain: [{
            label: "GPT 5.5",
            providerLabel: "OpenAI",
            costTier: "paid-per-call",
            state: "unavailable"
          }]
        }]
      };
    }
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderSettingsWorkspace({ container, bridgeRequest, initialSection: "routing" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(container.textContent, /Provider Fabric Routing/);
    assert.match(container.textContent, /Augmentor Chat/);
    assert.match(container.textContent, /MiniMax M3 · MiniMax · Subscription · available/);
    assert.match(container.textContent, /GPT 5\.5 · OpenAI · Paid per call · unavailable/);
    assert.match(container.textContent, /1\/1 routing strategies currently have at least one available route/);
  } finally {
    cleanup();
  }
});

test("settings routing section saves strategy changes through scoped capability", async () => {
  const { container, cleanup } = setupDom();
  const calls = [];
  const bridgeRequest = async (route, options = {}) => {
    calls.push([route, options]);
    if (route === "/providers/routing-strategies" && options.method !== "POST") {
      return {
        models: [
          { model: "MiniMax-M3", label: "MiniMax M3", providerLabel: "MiniMax", costTier: "subscription" },
          { model: "gpt-5.5", label: "GPT 5.5", providerLabel: "OpenAI", costTier: "paid-per-call" }
        ],
        strategies: [{
          id: "archive-ingest",
          label: "Archive Ingest",
          workload: "knowledge_promotion",
          primaryModel: "gpt-5.5",
          fallbackModels: ["MiniMax-M3"],
          costPosture: "quality-first",
          hardStop: true,
          notes: "Quality first.",
          routeState: "routable",
          primary: { label: "GPT 5.5", providerLabel: "OpenAI", costTier: "paid-per-call", state: "available" },
          fallbackChain: []
        }]
      };
    }
    if (route === "/providers/routing-strategies" && options.method === "POST") {
      return { strategyId: options.body.strategyId, savedAt: "2026-05-29T12:00:00.000Z", strategies: [] };
    }
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderSettingsWorkspace({ container, bridgeRequest, initialSection: "routing" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const form = container.querySelector(".settings-routing-form");
    form.querySelector("select[name='primaryModel']").value = "MiniMax-M3";
    form.querySelector("input[name='fallbackModels']").value = "gpt-5.5";
    form.querySelector("select[name='costPosture']").value = "subscription-first";
    form.querySelector("input[name='hardStop']").checked = false;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(calls.some(([route, options]) =>
      route === "/providers/routing-strategies" &&
      options.method === "POST" &&
      options.capability === "provider-routing-write" &&
      options.body.strategyId === "archive-ingest" &&
      options.body.primaryModel === "MiniMax-M3" &&
      options.body.fallbackModels.join(",") === "gpt-5.5" &&
      options.body.costPosture === "subscription-first" &&
      options.body.hardStop === false
    ));
    assert.match(container.textContent, /Archive Ingest routing strategy saved/);
  } finally {
    cleanup();
  }
});

test("settings workspace lists archived chats and projects with restore actions", async () => {
  const { container, cleanup } = setupDom();
  const restored = [];
  const opened = [];
  const chatSessionStore = {
    getSessions: () => [{
      id: "chat-1",
      title: "Archived Chat",
      archivedAt: "2026-05-28T00:00:00.000Z"
    }],
    getProjects: () => [{
      id: "project-1",
      name: "Archived Project",
      archivedAt: "2026-05-28T00:00:00.000Z"
    }],
    setSessionArchived: async (id, archived) => restored.push(["chat", id, archived]),
    setProjectArchived: async (id, archived) => restored.push(["project", id, archived])
  };
  const bridgeRequest = async (route, options = {}) => {
    if (route === "/providers/status") return { providers: [] };
    if (route === "/archive/intake/list") return { root: "ResonantOS/Memory/INTAKE", entries: [] };
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderSettingsWorkspace({
      container,
      bridgeRequest,
      chatSessionStore,
      onOpenSession: async (id) => opened.push(id),
      onRestore: () => restored.push(["render"]),
      initialSection: "work"
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(container.textContent, /Archived chats and projects/);
    assert.match(container.textContent, /Archived Chat/);
    assert.match(container.textContent, /Archived Project/);

    const buttons = [...container.querySelectorAll(".settings-archive-row button")];
    buttons[0].click();
    buttons[1].click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(restored.filter((entry) => entry[0] !== "render"), [
      ["project", "project-1", false],
      ["chat", "chat-1", false]
    ]);
    assert.deepEqual(opened, []);
  } finally {
    cleanup();
  }
});

test("settings work section manages active chats and projects", async () => {
  const { container, cleanup } = setupDom();
  const calls = [];
  const sessions = [
    {
      id: "chat-1",
      title: "Architecture Review",
      projectId: "",
      updatedAt: "2026-05-28T01:00:00.000Z"
    },
    {
      id: "chat-2",
      title: "Provider Routing",
      projectId: "project-1",
      updatedAt: "2026-05-28T02:00:00.000Z"
    }
  ];
  const projects = [{
    id: "project-1",
    name: "ResonantOS Core",
    updatedAt: "2026-05-28T00:00:00.000Z"
  }];
  const chatSessionStore = {
    getSessions: () => sessions,
    getProjects: () => projects,
    createProject: async (name) => {
      calls.push(["createProject", name]);
      projects.push({ id: "project-2", name, updatedAt: "2026-05-29T00:00:00.000Z" });
    },
    deleteProject: async (id) => {
      calls.push(["deleteProject", id]);
      const index = projects.findIndex((project) => project.id === id);
      if (index >= 0) projects.splice(index, 1);
      sessions.forEach((session) => {
        if (session.projectId === id) session.projectId = "";
      });
    },
    deleteSession: async (id) => {
      calls.push(["deleteSession", id]);
      const index = sessions.findIndex((session) => session.id === id);
      if (index >= 0) sessions.splice(index, 1);
    },
    setProjectArchived: async (id, archived) => {
      calls.push(["setProjectArchived", id, archived]);
      const project = projects.find((item) => item.id === id);
      if (project) project.archivedAt = archived ? "2026-05-29T00:00:00.000Z" : "";
    },
    setProjectPinned: async (id, pinned) => {
      calls.push(["setProjectPinned", id, pinned]);
      const project = projects.find((item) => item.id === id);
      if (project) project.pinned = pinned;
    },
    renameProject: async (id, name) => {
      calls.push(["renameProject", id, name]);
      const project = projects.find((item) => item.id === id);
      if (project) project.name = name;
    },
    setSessionArchived: async (id, archived) => {
      calls.push(["setSessionArchived", id, archived]);
      const session = sessions.find((item) => item.id === id);
      if (session) session.archivedAt = archived ? "2026-05-29T00:00:00.000Z" : "";
    },
    setSessionProject: async (id, projectId) => {
      calls.push(["setSessionProject", id, projectId]);
      const session = sessions.find((item) => item.id === id);
      if (session) session.projectId = projectId;
      return session;
    }
  };
  const opened = [];
  const bridgeRequest = async (route, options = {}) => {
    if (route === "/providers/status") return { providers: [] };
    if (route === "/archive/intake/list") {
      calls.push(["artifactList"]);
      return {
        root: "ResonantOS/Memory/INTAKE",
        entries: [
          {
            title: "Browser Job Report",
            kind: "browser-job-report",
            path: "INTAKE/browser/job-report.md",
            excerpt: "Completed browser work"
          },
          {
            title: "Wallet Audit",
            kind: "browser-intake",
            path: "INTAKE/wallet/audit.md",
            excerpt: "Read-only wallet evidence"
          }
        ]
      };
    }
    if (route === "/archive/intake/read") {
      calls.push(["artifactRead", options.body?.path]);
      return {
        title: "Browser Job Report",
        kind: "browser-job-report",
        path: options.body?.path,
        content: "# Browser Job Report\n\nCompleted browser work."
      };
    }
    if (route === "/archive/review/request") {
      calls.push(["reviewRequest", options.body?.path]);
      return { path: "REVIEW/requests/job-report.md" };
    }
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderSettingsWorkspace({
      container,
      bridgeRequest,
      chatSessionStore,
      onOpenSession: async (id) => opened.push(id),
      initialSection: "work"
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(container.textContent, /Active work/);
    assert.match(container.textContent, /Architecture Review/);
    assert.match(container.textContent, /Provider Routing/);
    assert.match(container.textContent, /ResonantOS Core/);

    const search = container.querySelector(".settings-work-tools input[type='search']");
    search.value = "routing";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    assert.doesNotMatch(container.textContent, /Architecture Review/);
    assert.match(container.textContent, /Provider Routing/);

    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    const projectName = container.querySelector(".settings-work-tools input[name='projectName']");
    projectName.value = "Client Work";
    container.querySelector(".settings-work-tools").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(calls.some((call) => call[0] === "createProject" && call[1] === "Client Work"));

    const chatRow = [...container.querySelectorAll(".settings-work-row")].find((row) => /Architecture Review/.test(row.textContent));
    const selector = chatRow.querySelector("select");
    selector.value = "project-1";
    selector.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(calls.some((call) => call[0] === "setSessionProject" && call[1] === "chat-1" && call[2] === "project-1"));

    const projectRow = [...container.querySelectorAll(".settings-work-row")].find((row) => /ResonantOS Core/.test(row.textContent));
    const renameInput = projectRow.querySelector("input[name='projectRename']");
    renameInput.value = "Core Build";
    projectRow.querySelector(".settings-work-rename-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(calls.some((call) => call[0] === "renameProject" && call[1] === "project-1" && call[2] === "Core Build"));
    assert.match(container.textContent, /Project renamed: Core Build/);

    const renamedProjectRow = [...container.querySelectorAll(".settings-work-row")].find((row) => /Core Build/.test(row.textContent));
    [...renamedProjectRow.querySelectorAll("button")].find((button) => button.textContent === "Pin").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(calls.some((call) => call[0] === "setProjectPinned" && call[1] === "project-1" && call[2] === true));
    assert.match(container.textContent, /Project pinned/);

    const refreshedChatRow = [...container.querySelectorAll(".settings-work-row")].find((row) => /Architecture Review/.test(row.textContent));
    [...refreshedChatRow.querySelectorAll("button")].find((button) => button.textContent === "Open").click();
    assert.deepEqual(opened, ["chat-1"]);

    [...refreshedChatRow.querySelectorAll("button")].find((button) => button.textContent === "Archive").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(calls.some((call) => call[0] === "setSessionArchived" && call[1] === "chat-1" && call[2] === true));
    assert.match(container.textContent, /Chat archived/);

    const deleteRow = [...container.querySelectorAll(".settings-work-row")].find((row) => /Provider Routing/.test(row.textContent));
    const deleteButton = [...deleteRow.querySelectorAll("button")].find((button) => button.textContent === "Delete");
    deleteButton.click();
    assert.equal(deleteButton.textContent, "Confirm delete");
    deleteButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(calls.some((call) => call[0] === "deleteSession" && call[1] === "chat-2"));

    assert.match(container.textContent, /Artifact Management/);
    assert.match(container.textContent, /Browser Job Report/);
    assert.match(container.textContent, /Wallet Audit/);
    const artifactSearch = container.querySelector(".settings-work-artifact-actions input[type='search']");
    artifactSearch.value = "wallet";
    artifactSearch.dispatchEvent(new Event("input", { bubbles: true }));
    assert.doesNotMatch(container.textContent, /Browser Job Report/);
    assert.match(container.textContent, /Wallet Audit/);
    artifactSearch.value = "";
    artifactSearch.dispatchEvent(new Event("input", { bubbles: true }));
    const artifactRow = [...container.querySelectorAll(".settings-archive-row")].find((row) => /Browser Job Report/.test(row.textContent));
    [...artifactRow.querySelectorAll("button")].find((button) => button.textContent === "Preview").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(calls.some((call) => call[0] === "artifactRead" && call[1] === "INTAKE/browser/job-report.md"));
    assert.match(container.textContent, /Completed browser work/);
    [...artifactRow.querySelectorAll("button")].find((button) => button.textContent === "Request review").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(calls.some((call) => call[0] === "reviewRequest" && call[1] === "INTAKE/browser/job-report.md"));
    assert.match(container.textContent, /Review request created/);
  } finally {
    cleanup();
  }
});

test("settings memory section renders active add-on and connected sources", async () => {
  const { container, cleanup } = setupDom();
  const calls = [];
  let latestSyncHistory = [{
    id: "sync-existing",
    finishedAt: "2026-06-01T10:00:00.000Z",
    status: "review-only",
    reviewedSources: 1,
    eligibleFiles: 1,
    createdArtifacts: 0,
    reviewRequests: 0,
    skippedSources: [{
      sourceId: "source-disabled",
      path: "[path]/DisabledVault",
      reason: "source disabled"
    }],
    sources: [{
      sourceId: "source-vault",
      status: "reviewed",
      candidates: 3,
      eligibleFiles: 1,
      createdArtifacts: 0,
      reviewRequests: 0,
      rejectedFiles: 0,
      eligibleFileSamples: ["notes/research.txt"]
    }],
    autoIntake: false
  }];
  const latestRepairHistory = [{
    id: "repair-existing",
    repairedAt: "2026-06-01T09:45:00.000Z",
    status: "repaired",
    sourceId: "source-vault",
    sourcePath: "[path]/Vault",
    backupPath: "CONFIG/source-file-history/repairs/source-file-versions.json",
    message: "Unreadable source version manifest was backed up and reset."
  }];
  const latestMoveHistory = [{
    id: "move-existing",
    at: "2026-06-01T09:30:00.000Z",
    action: "move-execute",
    status: "moved",
    sourceId: "source-vault",
    originalPath: "[path]/OriginalVault",
    managedPath: "HUMAN_KNOWLEDGE/sources/OriginalVault",
    ledgerPath: "CONFIG/move-imports/move-a/move-ledger.jsonl",
    message: "Source moved into managed Memory and registered as the canonical source."
  }];
  const bridgeRequest = async (route, options = {}) => {
    calls.push([route, options]);
    if (route === "/memory/settings") {
      return {
        settings: {
          activeMemoryAddon: "living-archive",
          autoSync: true,
          syncMode: "auto-intake-review",
          sources: [{
            path: "/Users/test/Vault",
            kind: "obsidian-vault",
            ownership: "human-knowledge",
            importMode: "copy-on-import",
            exists: true
          }]
        },
        status: {
          wiki: { pages: 42 },
          intake: { artifacts: 7 }
        },
        memoryAddons: [{ id: "addon.living-archive", name: "Living Archive", mode: "memory-system" }],
        syncHistory: latestSyncHistory,
        sourceRepairHistory: latestRepairHistory,
        sourceMoveHistory: latestMoveHistory
      };
    }
    if (route === "/memory/source/sync") {
      const result = {
        status: "intake-created",
        autoIntake: true,
        finishedAt: "2026-06-01T10:05:00.000Z",
        reviewedSources: 1,
        eligibleFiles: 2,
        createdArtifacts: 2,
        reviewRequests: 2,
        rejectedFiles: 0,
        sources: [{
          sourceId: "source-vault",
          status: "intake-created",
          candidates: 4,
          eligibleFiles: 2,
          createdArtifacts: 2,
          reviewRequests: 2,
          rejectedFiles: 0,
          eligibleFileSamples: ["notes/research.txt", "notes/new.md"],
          createdArtifactSamples: [
            { sourceFile: "notes/research.txt", path: "INTAKE/sources/research.md" },
            { sourceFile: "notes/new.md", path: "INTAKE/sources/new.md" }
          ]
        }]
      };
      latestSyncHistory = [{ id: "sync-new", ...result }];
      return result;
    }
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderSettingsWorkspace({ container, bridgeRequest, initialSection: "memory" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(container.textContent, /Living Archive Settings/);
    assert.match(container.textContent, /Connect the folders or vaults Augmentor can learn from/);
    assert.match(container.textContent, /Connected sources/);
    assert.match(container.textContent, /Add a source/);
    assert.match(container.textContent, /Advanced source options/);
    assert.match(container.textContent, /Source boundary and move-on-import/);
    assert.equal(container.querySelector(".settings-memory-advanced").open, false);
    assert.match(container.textContent, /living-archive/);
    assert.match(container.textContent, /42/);
    assert.match(container.textContent, /7/);
    assert.match(container.textContent, /\/Users\/test\/Vault/);
    assert.match(container.textContent, /Obsidian vault · human knowledge · copy on import · found/);
    assert.match(container.textContent, /1 source connected · auto-intake-review/);
    assert.match(container.textContent, /Last source sync/);
    assert.match(container.textContent, /Last source repair/);
    assert.match(container.textContent, /CONFIG\/source-file-history\/repairs\/source-file-versions\.json/);
    assert.match(container.textContent, /Last source move/);
    assert.match(container.textContent, /HUMAN_KNOWLEDGE\/sources\/OriginalVault/);
    assert.match(container.textContent, /CONFIG\/move-imports\/move-a\/move-ledger\.jsonl/);
    assert.match(container.textContent, /review-only/);
    assert.match(container.textContent, /1 new\/changed/);
    assert.match(container.textContent, /Inspect source outcome/);
    assert.match(container.textContent, /source-vault · reviewed/);
    assert.match(container.textContent, /Files: notes\/research\.txt/);
    assert.match(container.textContent, /\[path\]\/DisabledVault: source disabled/);
    [...container.querySelectorAll("button")].find((button) => button.textContent === "Run Sync Now").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(calls.some(([route, options]) =>
      route === "/memory/source/sync" &&
      options.capability === "memory-source-file-intake"
    ));
    assert.match(container.textContent, /created 2 intake artifact\(s\), and queued 2 review request\(s\)/);
    assert.match(container.textContent, /intake-created/);
    assert.match(container.textContent, /2 new\/changed/);
    assert.match(container.textContent, /source-vault · intake-created/);
    assert.match(container.textContent, /Intake: notes\/research\.txt → INTAKE\/sources\/research\.md/);
  } finally {
    cleanup();
  }
});

test("settings memory section saves source and sync policy through scoped capability", async () => {
  const { container, cleanup } = setupDom();
  const calls = [];
  let sourceCount = 0;
  const bridgeRequest = async (route, options = {}) => {
    calls.push([route, options]);
    if (route === "/memory/settings" && options.method !== "POST") {
      return {
        settings: {
          activeMemoryAddon: "living-archive",
          autoSync: false,
          syncMode: "manual-review",
          sources: Array.from({ length: sourceCount }, () => ({
            path: "/Users/test/Research",
            kind: "folder",
            ownership: "external-knowledge",
            importMode: "linked-readonly",
            exists: true
          }))
        },
        status: { wiki: { pages: 0 }, intake: { artifacts: 0 } },
        memoryAddons: [{ id: "addon.living-archive", name: "Living Archive", mode: "memory-system" }]
      };
    }
    if (route === "/memory/settings" && options.method === "POST") {
      sourceCount = options.body.source ? 1 : 0;
      return { savedAt: "2026-05-29T13:00:00.000Z", settings: {} };
    }
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderSettingsWorkspace({ container, bridgeRequest, initialSection: "memory" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const form = container.querySelector(".settings-routing-form");
    form.querySelector("input[name='path']").value = "/Users/test/Research";
    form.querySelector("select[name='kind']").value = "folder";
    form.querySelector("select[name='ownership']").value = "external-knowledge";
    form.querySelector("select[name='importMode']").value = "linked-readonly";
    form.querySelector("select[name='syncMode']").value = "auto-intake-review";
    form.querySelector("input[name='autoSync']").checked = true;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(calls.some(([route, options]) =>
      route === "/memory/settings" &&
      options.method === "POST" &&
      options.capability === "memory-settings-write" &&
      options.body.autoSync === true &&
      options.body.syncMode === "auto-intake-review" &&
      options.body.source.path === "/Users/test/Research" &&
      options.body.source.ownership === "external-knowledge" &&
      options.body.source.importMode === "linked-readonly"
    ));
    assert.match(container.textContent, /Memory settings saved/);
  } finally {
    cleanup();
  }
});

test("settings memory section gates move-on-import behind preflight and confirmation", async () => {
  const { container, cleanup } = setupDom();
  const calls = [];
  const openedWorkspaces = [];
  let sources = [];
  const bridgeRequest = async (route, options = {}) => {
    calls.push([route, options]);
    if (route === "/memory/settings") {
      return {
        settings: {
          activeMemoryAddon: "living-archive",
          autoSync: false,
          syncMode: "manual-review",
          sources
        },
        status: { wiki: { pages: 0 }, intake: { artifacts: 0 } },
        memoryAddons: []
      };
    }
    if (route === "/memory/source/move-preflight") {
      return {
        okToMove: true,
        sourcePath: options.body.path,
        sourceName: "MoveMe",
        destinationRoot: "/Users/test/ResonantOS_User/Memory/HUMAN_KNOWLEDGE/sources/moveme",
        fileCount: 2,
        directoryCount: 1,
        hiddenFiles: 0,
        totalBytes: 2048,
        blocked: [],
        confirmationPhrase: "MOVE MoveMe",
        preflightFingerprint: "preflight-fingerprint-123"
      };
    }
    if (route === "/memory/source/move-execute") {
      sources = [{
        id: "source-moved",
        path: "/Users/test/ResonantOS_User/Memory/HUMAN_KNOWLEDGE/sources/moveme",
        kind: options.body.kind,
        ownership: options.body.ownership,
        importMode: "move-on-import",
        ledgerPath: "/Users/test/ResonantOS_User/Memory/CONFIG/move-imports/move-a/move-ledger.jsonl",
        exists: true
      }];
      return {
        movedCount: 2,
        sourceCleanupStatus: "preserved-new-content",
        ledgerPath: sources[0].ledgerPath,
        settings: { sources }
      };
    }
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderSettingsWorkspace({
      container,
      bridgeRequest,
      initialSection: "memory",
      onOpenWorkspace: async (workspaceId) => {
        openedWorkspaces.push(workspaceId);
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const form = container.querySelector(".settings-routing-form");
    form.querySelector("input[name='path']").value = "/Users/test/MoveMe";
    form.querySelector("select[name='ownership']").value = "human-knowledge";
    form.querySelector("select[name='importMode']").value = "move-on-import";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(calls.some(([route, options]) =>
      route === "/memory/source/move-preflight" &&
      options.capability === "memory-source-move" &&
      options.body.path === "/Users/test/MoveMe"
    ));
    assert.match(container.textContent, /Move preflight ready/);
    assert.match(container.textContent, /MOVE MoveMe/);
    assert.match(container.textContent, /managed copy canonical/);
    assert.match(container.textContent, /verifies file hashes/);
    assert.equal(calls.some(([route, options]) => route === "/memory/settings" && options.method === "POST"), false);

    const confirmationInput = container.querySelector('[aria-label="Move import confirmation phrase"]');
    const executeMoveButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Execute Move Import");
    assert.equal(executeMoveButton.disabled, true);
    confirmationInput.value = "MOVE";
    confirmationInput.dispatchEvent(new Event("input", { bubbles: true }));
    assert.equal(executeMoveButton.disabled, true);
    confirmationInput.value = "MOVE MoveMe";
    confirmationInput.dispatchEvent(new Event("input", { bubbles: true }));
    assert.equal(executeMoveButton.disabled, false);
    executeMoveButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(calls.some(([route, options]) =>
      route === "/memory/source/move-execute" &&
      options.capability === "memory-source-move" &&
      options.body.confirmation === "MOVE MoveMe" &&
      options.body.preflightFingerprint === "preflight-fingerprint-123"
    ));
    assert.match(container.textContent, /Move import completed and source registered/);
    assert.match(container.textContent, /Original source folder preserved because new files appeared during cleanup/);
    assert.match(container.textContent, /review it before deleting anything/);
    assert.match(container.textContent, /canonical knowledge source/);
    assert.match(container.textContent, /Open Living Archive/);
    assert.match(container.textContent, /move on import/);
    assert.match(container.textContent, /Rollback/);

    [...container.querySelectorAll("button")].find((button) => button.textContent === "Open Living Archive").click();
    assert.deepEqual(openedWorkspaces, ["memory"]);
  } finally {
    cleanup();
  }
});

test("settings memory section completes real move-on-import and rollback against a temporary source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resonantos-settings-real-move-"));
  const source = path.join(root, "Human Vault");
  const memoryRoot = path.join(root, "ResonantOS_User", "Memory");
  await mkdir(path.join(source, ".obsidian"), { recursive: true });
  await mkdir(memoryRoot, { recursive: true });
  await writeFile(path.join(source, "note.md"), "# Human note\n");
  await writeFile(path.join(source, ".obsidian", "app.json"), "{}\n");

  const { container, cleanup } = setupDom();
  const calls = [];
  let sources = [];
  window.prompt = () => "ROLLBACK MOVE";
  const bridgeRequest = async (route, options = {}) => {
    calls.push([route, options]);
    if (route === "/memory/settings") {
      return {
        settings: {
          activeMemoryAddon: "living-archive",
          autoSync: false,
          syncMode: "manual-review",
          sources
        },
        status: { wiki: { pages: 0 }, intake: { artifacts: 0 } },
        memoryAddons: []
      };
    }
    if (route === "/memory/source/move-preflight") {
      return buildMoveImportPreflight({
        sourcePath: options.body.path,
        memoryRoot,
        kind: options.body.kind,
        ownership: options.body.ownership,
      });
    }
    if (route === "/memory/source/move-execute") {
      const result = await executeMoveImport({
        sourcePath: options.body.path,
        memoryRoot,
        kind: options.body.kind,
        ownership: options.body.ownership,
        confirmation: options.body.confirmation,
        expectedPreflightFingerprint: options.body.preflightFingerprint,
      });
      sources = [{
        id: "source-real-move",
        path: result.source.path,
        kind: result.source.kind,
        ownership: result.source.ownership,
        importMode: "move-on-import",
        ledgerPath: result.source.ledgerPath,
        exists: existsSync(result.source.path)
      }];
      return {
        ...result,
        source: sources[0],
        settings: { sources }
      };
    }
    if (route === "/memory/source/move-rollback") {
      const report = await rollbackMoveImport({
        ledgerPath: options.body.ledgerPath,
        confirmation: options.body.confirmation,
      });
      if (shouldDeregisterMovedSourceAfterRollback(report)) {
        sources = [];
      }
      return {
        ...report,
        settings: { sources }
      };
    }
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderSettingsWorkspace({ container, bridgeRequest, initialSection: "memory" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const form = container.querySelector(".settings-routing-form");
    form.querySelector("input[name='path']").value = source;
    form.querySelector("select[name='kind']").value = "obsidian-vault";
    form.querySelector("select[name='ownership']").value = "human-knowledge";
    form.querySelector("select[name='importMode']").value = "move-on-import";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.match(container.textContent, /Move preflight ready/);
    assert.match(container.textContent, /2 file\(s\)/);
    assert.match(container.textContent, /1 hidden file\(s\)/);

    const confirmationInput = container.querySelector('[aria-label="Move import confirmation phrase"]');
    const executeMoveButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Execute Move Import");
    confirmationInput.value = `MOVE ${path.basename(source)}`;
    confirmationInput.dispatchEvent(new Event("input", { bubbles: true }));
    executeMoveButton.click();
    await waitForCondition(() => sources.length === 1 && !existsSync(source));

    assert.equal(existsSync(source), false);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].importMode, "move-on-import");
    assert.equal(existsSync(path.join(sources[0].path, "note.md")), true);
    assert.equal(await readFile(path.join(sources[0].path, "note.md"), "utf8"), "# Human note\n");
    assert.equal(existsSync(path.join(sources[0].path, ".obsidian", "app.json")), true);
    assert.match(container.textContent, /Move import completed and source registered/);
    assert.match(container.textContent, /This managed Memory copy is now the canonical knowledge source/);
    assert.match(container.textContent, /Rollback/);

    [...container.querySelectorAll("button")].find((button) => button.textContent === "Rollback").click();
    await waitForCondition(() => sources.length === 0 && existsSync(path.join(source, "note.md")));

    assert.equal(sources.length, 0);
    assert.equal(existsSync(path.join(source, "note.md")), true);
    assert.equal(await readFile(path.join(source, "note.md"), "utf8"), "# Human note\n");
    assert.equal(existsSync(path.join(source, ".obsidian", "app.json")), true);
    assert.match(container.textContent, /Move rollback restored 2 file/);
    assert.ok(calls.some(([route, options]) =>
      route === "/memory/source/move-preflight" &&
      options.capability === "memory-source-move"
    ));
    assert.ok(calls.some(([route, options]) =>
      route === "/memory/source/move-execute" &&
      options.capability === "memory-source-move"
    ));
    assert.ok(calls.some(([route, options]) =>
      route === "/memory/source/move-rollback" &&
      options.capability === "memory-source-move"
    ));
  } finally {
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      await rm(root, { recursive: true, force: true });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }
});

test("settings memory section blocks unsafe move preflight without execute controls", async () => {
  const { container, cleanup } = setupDom();
  const calls = [];
  const bridgeRequest = async (route, options = {}) => {
    calls.push([route, options]);
    if (route === "/memory/settings") {
      return {
        settings: {
          activeMemoryAddon: "living-archive",
          autoSync: false,
          syncMode: "manual-review",
          sources: []
        },
        status: { wiki: { pages: 0 }, intake: { artifacts: 0 } },
        memoryAddons: []
      };
    }
    if (route === "/memory/source/move-preflight") {
      return {
        okToMove: false,
        sourcePath: options.body.path,
        destinationRoot: "/Users/test/ResonantOS_User/Memory/HUMAN_KNOWLEDGE/sources",
        fileCount: 0,
        directoryCount: 0,
        hiddenFiles: 0,
        totalBytes: 0,
        blocked: [{ reason: "selected path is too broad" }]
      };
    }
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderSettingsWorkspace({ container, bridgeRequest, initialSection: "memory" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const form = container.querySelector(".settings-routing-form");
    form.querySelector("input[name='path']").value = "/Users/test";
    form.querySelector("select[name='importMode']").value = "move-on-import";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(calls.some(([route, options]) =>
      route === "/memory/source/move-preflight" &&
      options.capability === "memory-source-move" &&
      options.body.path === "/Users/test"
    ));
    assert.match(container.textContent, /Move preflight blocked/);
    assert.match(container.textContent, /selected path is too broad/);
    assert.match(container.textContent, /Move preflight blocked\. Review the listed reason before continuing/);
    assert.equal(container.querySelector('[aria-label="Move import confirmation phrase"]'), null);
    assert.equal([...container.querySelectorAll("button")].some((button) => button.textContent === "Execute Move Import"), false);
    assert.equal(calls.some(([route]) => route === "/memory/source/move-execute"), false);
  } finally {
    cleanup();
  }
});

test("settings memory section recovers when move execution fails after approval", async () => {
  const { container, cleanup } = setupDom();
  const calls = [];
  const bridgeRequest = async (route, options = {}) => {
    calls.push([route, options]);
    if (route === "/memory/settings") {
      return {
        settings: {
          activeMemoryAddon: "living-archive",
          autoSync: false,
          syncMode: "manual-review",
          sources: []
        },
        status: { wiki: { pages: 0 }, intake: { artifacts: 0 } },
        memoryAddons: []
      };
    }
    if (route === "/memory/source/move-preflight") {
      return {
        okToMove: true,
        sourcePath: options.body.path,
        sourceName: "Unstable Vault",
        destinationRoot: "/Users/test/ResonantOS_User/Memory/INTAKE/imports/mixed/unstable-vault",
        fileCount: 3,
        directoryCount: 1,
        hiddenFiles: 0,
        totalBytes: 4096,
        blocked: [],
        confirmationPhrase: "MOVE Unstable Vault",
        preflightFingerprint: "preflight-fingerprint-unstable"
      };
    }
    if (route === "/memory/source/move-execute") {
      throw new Error(
        "Move import failed and automatic rollback restored 2 file(s), 1 folder(s), source root restored: yes; 0 file(s), 0 folder(s), 0 root cleanup issue(s) skipped."
      );
    }
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderSettingsWorkspace({ container, bridgeRequest, initialSection: "memory" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const form = container.querySelector(".settings-routing-form");
    form.querySelector("input[name='path']").value = "/Users/test/Unstable Vault";
    form.querySelector("select[name='importMode']").value = "move-on-import";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const confirmationInput = container.querySelector('[aria-label="Move import confirmation phrase"]');
    const executeMoveButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Execute Move Import");
    confirmationInput.value = "MOVE Unstable Vault";
    confirmationInput.dispatchEvent(new Event("input", { bubbles: true }));
    assert.equal(executeMoveButton.disabled, false);
    executeMoveButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(calls.some(([route, options]) =>
      route === "/memory/source/move-execute" &&
      options.capability === "memory-source-move" &&
      options.body.preflightFingerprint === "preflight-fingerprint-unstable"
    ));
    assert.match(container.textContent, /Move import failed/);
    assert.match(container.textContent, /automatic rollback restored 2 file/);
    assert.match(container.textContent, /source root restored: yes/);
    assert.equal(executeMoveButton.disabled, false);
    assert.equal(calls.some(([route, options]) => route === "/memory/settings" && options.method === "POST"), false);
  } finally {
    cleanup();
  }
});

test("settings memory section rolls back moved sources through scoped capability", async () => {
  const { container, cleanup } = setupDom();
  const calls = [];
  let promptMessage = "";
  window.prompt = (message) => {
    promptMessage = message;
    return "ROLLBACK MOVE";
  };
  let sources = [{
    id: "source-moved",
    path: "/Users/test/ResonantOS_User/Memory/HUMAN_KNOWLEDGE/sources/moveme",
    kind: "folder",
    ownership: "human-knowledge",
    importMode: "move-on-import",
    ledgerPath: "/Users/test/ResonantOS_User/Memory/CONFIG/move-imports/move-a/move-ledger.jsonl",
    exists: true
  }];
  const bridgeRequest = async (route, options = {}) => {
    calls.push([route, options]);
    if (route === "/memory/settings") {
      return {
        settings: { activeMemoryAddon: "living-archive", autoSync: false, syncMode: "manual-review", sources },
        status: { wiki: { pages: 0 }, intake: { artifacts: 0 } },
        memoryAddons: []
      };
    }
    if (route === "/memory/source/move-rollback") {
      sources = [];
      return { restoredCount: 2, skippedCount: 0, settings: { sources } };
    }
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderSettingsWorkspace({ container, bridgeRequest, initialSection: "memory" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    [...container.querySelectorAll("button")].find((button) => button.textContent === "Rollback").click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(promptMessage, /restores files from ResonantOS Memory back to the original source path/);
    assert.ok(calls.some(([route, options]) =>
      route === "/memory/source/move-rollback" &&
      options.capability === "memory-source-move" &&
      options.body.confirmation === "ROLLBACK MOVE" &&
      /move-ledger/.test(options.body.ledgerPath)
    ));
    assert.match(container.textContent, /Move rollback restored 2 file/);
  } finally {
    cleanup();
  }
});

test("settings memory section browses for a source folder through scoped capability", async () => {
  const { container, cleanup } = setupDom();
  const calls = [];
  const bridgeRequest = async (route, options = {}) => {
    calls.push([route, options]);
    if (route === "/memory/settings") {
      return {
        settings: {
          activeMemoryAddon: "living-archive",
          autoSync: false,
          syncMode: "manual-review",
          sources: []
        },
        status: { wiki: { pages: 0 }, intake: { artifacts: 0 } },
        memoryAddons: [{ id: "addon.living-archive", name: "Living Archive", mode: "memory-system" }]
      };
    }
    if (route === "/memory/source/browse") {
      return {
        cancelled: false,
        kind: "obsidian-vault",
        path: "/Users/test/ObsidianVault"
      };
    }
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderSettingsWorkspace({ container, bridgeRequest, initialSection: "memory" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    [...container.querySelectorAll("button")].find((button) => button.textContent === "Browse").click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(calls.some(([route, options]) =>
      route === "/memory/source/browse" &&
      options.method === "POST" &&
      options.capability === "memory-source-browse"
    ));
    assert.equal(container.querySelector("input[name='path']").value, "/Users/test/ObsidianVault");
    assert.equal(container.querySelector("select[name='kind']").value, "obsidian-vault");
    assert.match(container.textContent, /Folder selected/);
  } finally {
    cleanup();
  }
});

test("settings memory section scans selected source folder before saving", async () => {
  const { container, cleanup } = setupDom();
  const calls = [];
  const bridgeRequest = async (route, options = {}) => {
    calls.push([route, options]);
    if (route === "/memory/settings") {
      return {
        settings: {
          activeMemoryAddon: "living-archive",
          autoSync: false,
          syncMode: "manual-review",
          sources: []
        },
        status: { wiki: { pages: 0 }, intake: { artifacts: 0 } },
        memoryAddons: []
      };
    }
    if (route === "/memory/source/scan") {
      return {
        categories: {
          compatible: 4,
          processed: 2,
          "raw-audio": 1,
          media: 3,
          unsupported: 5,
          hidden: 1
        },
        kind: "obsidian-vault",
        limitReached: false,
        path: options.body.path,
        recommendation: "This source has compatible knowledge files and can be registered for governed intake.",
        totalScanned: 16
      };
    }
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderSettingsWorkspace({ container, bridgeRequest, initialSection: "memory" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    container.querySelector("input[name='path']").value = "/Users/test/MixedVault";
    [...container.querySelectorAll("button")].find((button) => button.textContent === "Scan").click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(calls.some(([route, options]) =>
      route === "/memory/source/scan" &&
      options.method === "POST" &&
      options.capability === "memory-source-scan" &&
      options.body.path === "/Users/test/MixedVault"
    ));
    assert.equal(container.querySelector("select[name='kind']").value, "obsidian-vault");
    assert.match(container.textContent, /16 file\(s\) scanned/);
    assert.match(container.textContent, /4 compatible/);
    assert.match(container.textContent, /1 raw audio/);
    assert.match(container.textContent, /Source scan complete/);
  } finally {
    cleanup();
  }
});

test("settings memory section disables and removes connected sources through scoped capability", async () => {
  const { container, cleanup } = setupDom();
  const calls = [];
  let sources = [
    {
      id: "source-alpha",
      path: "/Users/test/Knowledge",
      kind: "folder",
      ownership: "human-knowledge",
      importMode: "copy-on-import",
      exists: true
    },
    {
      id: "source-beta",
      path: "/Users/test/Research",
      kind: "obsidian-vault",
      ownership: "external-knowledge",
      importMode: "linked-readonly",
      exists: true
    }
  ];
  const memorySettings = () => ({
    settings: {
      activeMemoryAddon: "living-archive",
      autoSync: false,
      syncMode: "manual-review",
      sources
    },
    status: { wiki: { pages: 0 }, intake: { artifacts: 0 } },
    memoryAddons: []
  });
  const bridgeRequest = async (route, options = {}) => {
    calls.push([route, options]);
    if (route === "/memory/settings") {
      return memorySettings();
    }
    if (route === "/memory/source/action") {
      if (options.body.action === "disable") {
        sources = sources.map((source) => source.id === options.body.sourceId
          ? { ...source, disabledAt: "2026-05-29T10:00:00.000Z" }
          : source);
      }
      if (options.body.action === "enable") {
        sources = sources.map((source) => source.id === options.body.sourceId
          ? { ...source, disabledAt: undefined, enabledAt: "2026-05-29T10:01:00.000Z" }
          : source);
      }
      if (options.body.action === "remove") {
        sources = sources.filter((source) => source.id !== options.body.sourceId);
      }
      return memorySettings();
    }
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderSettingsWorkspace({ container, bridgeRequest, initialSection: "memory" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(container.textContent, /\/Users\/test\/Knowledge/);
    assert.match(container.textContent, /\/Users\/test\/Research/);

    [...container.querySelectorAll("button")].find((button) => button.textContent === "Disable").click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(calls.some(([route, options]) =>
      route === "/memory/source/action" &&
      options.method === "POST" &&
      options.capability === "memory-source-manage" &&
      options.body.action === "disable" &&
      options.body.sourceId === "source-alpha"
    ));
    assert.match(container.textContent, /Memory source disabled/);
    assert.match(container.textContent, /disabled/);

    [...container.querySelectorAll("button")].find((button) => button.textContent === "Enable").click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(calls.some(([route, options]) =>
      route === "/memory/source/action" &&
      options.method === "POST" &&
      options.capability === "memory-source-manage" &&
      options.body.action === "enable" &&
      options.body.sourceId === "source-alpha"
    ));
    assert.match(container.textContent, /Memory source enabled/);

    [...container.querySelectorAll("button")].find((button) => button.textContent === "Remove").click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(calls.some(([route, options]) =>
      route === "/memory/source/action" &&
      options.method === "POST" &&
      options.capability === "memory-source-manage" &&
      options.body.action === "remove" &&
      options.body.sourceId === "source-alpha"
    ));
    assert.match(container.textContent, /Memory source removed/);
  } finally {
    cleanup();
  }
});

test("settings memory section reports cancelled source browsing without changing path", async () => {
  const { container, cleanup } = setupDom();
  const bridgeRequest = async (route) => {
    if (route === "/memory/settings") {
      return {
        settings: { activeMemoryAddon: "living-archive", autoSync: false, syncMode: "manual-review", sources: [] },
        status: { wiki: { pages: 0 }, intake: { artifacts: 0 } },
        memoryAddons: []
      };
    }
    if (route === "/memory/source/browse") {
      return { cancelled: true, path: "" };
    }
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderSettingsWorkspace({ container, bridgeRequest, initialSection: "memory" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const pathInput = container.querySelector("input[name='path']");
    pathInput.value = "/existing/path";
    [...container.querySelectorAll("button")].find((button) => button.textContent === "Browse").click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(pathInput.value, "/existing/path");
    assert.match(container.textContent, /Folder selection cancelled/);
  } finally {
    cleanup();
  }
});

test("settings memory section redacts failed settings errors", async () => {
  const { container, cleanup } = setupDom();
  const bridgeRequest = async (route) => {
    if (route === "/memory/settings") throw new Error("memory settings failed token=abc123 sk-memory-secret");
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderSettingsWorkspace({ container, bridgeRequest, initialSection: "memory" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(container.textContent, /Memory settings unavailable/);
    assert.match(container.textContent, /token=\[redacted\]/);
    assert.match(container.textContent, /\[redacted-key\]/);
    assert.doesNotMatch(container.textContent, /abc123|sk-memory-secret/i);
  } finally {
    cleanup();
  }
});

test("settings appearance section loads, applies, and saves local UI preferences", async () => {
  const { container, cleanup } = setupDom();
  const stored = {
    augmentorAppearancePreferences: {
      density: "compact",
      fontScale: "small",
      motion: "reduced"
    }
  };
  const storage = {
    get: async (key) => ({ [key]: stored[key] }),
    set: async (patch) => Object.assign(stored, patch)
  };

  try {
    renderSettingsWorkspace({
      container,
      bridgeRequest: async () => ({}),
      initialSection: "appearance",
      storage,
      storageKeys: { appearance: "augmentorAppearancePreferences" }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(container.textContent, /Interface Preferences/);
    assert.match(container.textContent, /Tune the workspace for desktop focus or touch-friendly use/);
    assert.match(container.textContent, /Recommended default/);
    assert.match(container.textContent, /Density/);
    assert.match(container.textContent, /Text size/);
    assert.match(container.textContent, /Motion/);
    assert.equal(document.body.dataset.density, "compact");
    assert.equal(document.body.dataset.fontScale, "small");
    assert.equal(document.body.dataset.motion, "reduced");

    const form = container.querySelector(".settings-appearance-form");
    form.querySelector("select[name='density']").value = "touch";
    form.querySelector("select[name='fontScale']").value = "large";
    form.querySelector("select[name='motion']").value = "full";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(stored.augmentorAppearancePreferences, {
      density: "touch",
      fontScale: "large",
      motion: "full"
    });
    assert.equal(document.body.dataset.density, "touch");
    assert.match(container.textContent, /Appearance settings saved/);
  } finally {
    cleanup();
  }
});

test("settings workspace defaults to overview health and routes sections from sub-sidebar", async () => {
  const { container, cleanup } = setupDom();
  const calls = [];
  const bridgeRequest = async (route, options = {}) => {
    calls.push([route, options]);
    if (route === "/providers/status") {
      return {
        providers: [
          {
            id: "shared-minimax",
            label: "MiniMax",
            role: "Default Augmentor provider",
            models: ["MiniMax-M3"],
            configured: true
          }
        ]
      };
    }
    if (route === "/status") {
      return {
        bridge: "ready",
        addons: [
          { name: "Augmentor Chat", available: true, mode: "chat-interface" },
          { name: "Living Archive", available: false, mode: "memory-system" }
        ],
        memory: {
          wiki: { pages: 12 },
          intake: { artifacts: 4 }
        }
      };
    }
    if (route === "/addons/status") {
      return {
        addons: [
          { name: "Augmentor Chat", available: true, mode: "chat-interface" },
          { name: "Living Archive", available: false, mode: "memory-system" }
        ]
      };
    }
    if (route === "/memory/status") {
      return {
        wiki: { pages: 12 },
        intake: { artifacts: 4 }
      };
    }
    if (route === "/memory/settings") {
      return {
        settings: {
          activeMemoryAddon: "living-archive",
          autoSync: false,
          syncMode: "manual-review",
          sources: []
        },
        status: {
          wiki: { pages: 12 },
          intake: { artifacts: 4 }
        },
        memoryAddons: [{ id: "addon.living-archive", name: "Living Archive", mode: "memory-system", available: true }]
      };
    }
    if (route === "/browser/launch-diagnostics") {
      return {
        status: "ready",
        launchMode: "mac-app-bundle",
        appkitMenu: "installed",
        bridge: { status: "started" },
        phantomLoaded: true
      };
    }
    if (route === "/diagnostics/report") {
      return {
        path: "~/ResonantOS_User/BrowserFirst/Diagnostics/overview-diagnostics.json"
      };
    }
    if (route === "/addons/delegate") {
      return {
        id: "delegation-recovery",
        target: "engineer",
        path: "~/ResonantOS_User/Delegations/delegation-recovery"
      };
    }
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderSettingsWorkspace({ container, bridgeRequest });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(container.textContent, /Start Here/);
    assert.match(container.textContent, /Set the essentials first/);
    assert.match(container.textContent, /Edit profile/);
    assert.match(container.textContent, /Set models/);
    assert.match(container.textContent, /Open memory/);
    assert.match(container.textContent, /Start here/);
    assert.match(container.textContent, /Work/);
    assert.match(container.textContent, /Advanced/);
    assert.equal(container.querySelector(".settings-advanced-disclosure").open, false);
    assert.match(container.textContent, /1\/1/);
    assert.match(container.textContent, /1\/2/);
    assert.match(container.textContent, /12/);
    assert.match(container.textContent, /Open Diagnostics/);
    assert.match(container.textContent, /Export Report/);
    assert.match(container.textContent, /Start Recovery Handoff/);
    assert.equal(container.querySelector('[data-section="overview"]').dataset.active, "true");

    [...container.querySelectorAll(".settings-setup-card button")].find((button) => button.textContent === "Edit profile").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(container.querySelector('[data-section="profile"]').dataset.active, "true");

    container.querySelector('[data-section="overview"]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    [...container.querySelectorAll(".settings-setup-card button")].find((button) => button.textContent === "Set models").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(container.querySelector('[data-section="providers"]').dataset.active, "true");

    container.querySelector('[data-section="overview"]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    [...container.querySelectorAll(".settings-setup-card button")].find((button) => button.textContent === "Open memory").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(container.querySelector('[data-section="memory"]').dataset.active, "true");

    container.querySelector('[data-section="overview"]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    [...container.querySelectorAll(".settings-overview-action-buttons button")].find((button) => button.textContent === "Export Report").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(calls.some(([route, options]) =>
      route === "/diagnostics/report" &&
      options.capability === "diagnostics-report-export" &&
      options.body.scope === "overview"
    ));
    assert.match(container.textContent, /Report exported: ~\/ResonantOS_User\/BrowserFirst\/Diagnostics\/overview-diagnostics\.json/);

    [...container.querySelectorAll(".settings-overview-action-buttons button")].find((button) => button.textContent === "Start Recovery Handoff").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(calls.some(([route, options]) =>
      route === "/addons/delegate" &&
      options.body.target === "engineer" &&
      /health diagnosis/i.test(options.body.mission)
    ));
    assert.match(container.textContent, /Recovery handoff queued: delegation-recovery/);

    [...container.querySelectorAll(".settings-overview-action-buttons button")].find((button) => button.textContent === "Open Diagnostics").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(container.textContent, /Diagnostics/);
    assert.equal(container.querySelector('[data-section="diagnostics"]').dataset.active, "true");

    container.querySelector('[data-section="providers"]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(container.textContent, /Provider Profiles/);
    assert.equal(container.querySelector('[data-section="providers"]').dataset.active, "true");
    assert.ok(calls.some(([route]) => route === "/status"));
  } finally {
    cleanup();
  }
});

test("settings workspace edits user profile and Augmentor prompt", async () => {
  const { container, cleanup } = setupDom();
  const storage = memoryStorage({
    augmentorUserProfile: {
      displayName: "Existing User",
      subtitle: "Existing profile",
      email: "existing@example.com"
    },
    augmentorConfig: {
      displayName: "Augmentor",
      systemPrompt: "Existing prompt"
    }
  });
  let updated = null;
  let openedWorkspace = null;
  const bridgeCalls = [];
  const bridgeRequest = async (route, options = {}) => {
    bridgeCalls.push([route, options]);
    if (route === "/memory/settings") {
      return {
        settings: {
          activeMemoryAddon: "living-archive",
          autoSync: false,
          syncMode: "manual-review",
          sources: [{ id: "source-a", path: "/knowledge", kind: "folder" }]
        },
        status: {
          wiki: { pages: 12 },
          intake: { artifacts: 4 }
        },
        memoryAddons: [{ id: "addon.living-archive", name: "Living Archive", mode: "memory-system", available: true }]
      };
    }
    if (route === "/addons/status") {
      return {
        addons: [
          { id: "addon.living-archive", name: "Living Archive", available: true, mode: "memory-system", trust: "host-mediated memory provider", grantedCapabilities: ["archive-read", "archive-intake-write"] },
          { id: "addon.hermes", name: "Hermes", available: true, mode: "delegation-addon", trust: "add-on agent", grantedCapabilities: ["agent-delegation"] }
        ]
      };
    }
    return {};
  };

  try {
    renderSettingsWorkspace({
      container,
      bridgeRequest,
      initialSection: "profile",
      onOpenWorkspace: (workspaceId) => {
        openedWorkspace = workspaceId;
      },
      onProfileUpdated: (next) => {
        updated = next;
      },
      storage,
      storageKeys: {
        augmentorConfig: "augmentorConfig",
        userProfile: "augmentorUserProfile"
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(container.textContent, /User & Augmentor/);
    assert.match(container.textContent, /Memory System/);
    assert.match(container.textContent, /Living Archive is the active AI memory system/);
    assert.match(container.textContent, /Skills & Plugins/);
    assert.match(container.textContent, /Browser control/);
    assert.match(container.textContent, /Hermes/);
    assert.equal(container.querySelector('[data-section="profile"]').dataset.active, "true");
    assert.ok(bridgeCalls.some(([route]) => route === "/memory/settings"));
    assert.ok(bridgeCalls.some(([route]) => route === "/addons/status"));

    [...container.querySelectorAll("button")].find((button) => /Open Memory Workspace/.test(button.textContent)).click();
    assert.equal(openedWorkspace, "memory");

    [...container.querySelectorAll("button")].find((button) => /Open Memory Settings/.test(button.textContent)).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(container.querySelector('[data-section="memory"]').dataset.active, "true");
    assert.match(container.textContent, /Living Archive Settings/);

    container.querySelector('[data-section="profile"]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const name = container.querySelector('[aria-label="User display name"]');
    const subtitle = container.querySelector('[aria-label="User profile subtitle"]');
    const prompt = container.querySelector('[aria-label="Augmentor system prompt"]');
    name.value = "Manolo Remiddi";
    subtitle.value = "ResonantOS builder";
    prompt.value = "Answer as Augmentor with concise strategic reasoning.";
    container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(storage.state.augmentorUserProfile.displayName, "Manolo Remiddi");
    assert.equal(storage.state.augmentorUserProfile.subtitle, "ResonantOS builder");
    assert.match(storage.state.augmentorConfig.systemPrompt, /concise strategic reasoning/);
    assert.equal(updated.profile.displayName, "Manolo Remiddi");
    assert.match(container.textContent, /Identity settings saved/);
  } finally {
    cleanup();
  }
});

test("settings workspace renders add-on status and capability boundaries", async () => {
  const { container, cleanup } = setupDom();
  const bridgeCalls = [];
  let hermesExecutionEnabled = false;
  const bridgeRequest = async (route, options = {}) => {
    bridgeCalls.push([route, options]);
    if (route === "/providers/status") return { providers: [] };
    if (route === "/status") return { addons: [], memory: null };
    if (route === "/memory/status") return { wiki: { pages: 0 }, intake: { artifacts: 0 } };
    if (route === "/browser/launch-diagnostics") return { status: "attention", launchMode: "unknown", appkitMenu: "unknown", phantomLoaded: false };
    if (route === "/addons/status") {
      return {
        addons: [
          {
            id: "addon.hermes",
            name: "Hermes",
            available: true,
            mode: "delegation-addon",
            trust: "add-on agent",
            requestedCapabilities: ["agent-delegation", "network", "notifications"],
            grantedCapabilities: ["agent-delegation", "notifications"],
            deniedCapabilities: ["network"],
            execution: { localCliExecution: hermesExecutionEnabled }
          },
          {
            id: "addon.living-archive",
            name: "Living Archive",
            available: true,
            mode: "memory-system",
            trust: "host-mediated memory provider",
            requestedCapabilities: ["archive-read", "archive-intake-write", "archive-knowledge-write"],
            grantedCapabilities: ["archive-read", "archive-intake-write"],
            deniedCapabilities: ["archive-knowledge-write"]
          },
          {
            id: "addon.opencode",
            name: "OpenCode",
            available: false,
            mode: "coding-addon",
            trust: "add-on agent",
            execution: { localCliExecution: false }
          }
        ]
      };
    }
    if (route === "/addons/execution-settings") {
      hermesExecutionEnabled = Boolean(options.body.localCliExecution);
      return {
        addon: options.body.addon,
        settings: { hermes: { localCliExecution: hermesExecutionEnabled }, opencode: { localCliExecution: false } },
        status: hermesExecutionEnabled ? "enabled" : "disabled"
      };
    }
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderSettingsWorkspace({ container, bridgeRequest });
    await new Promise((resolve) => setTimeout(resolve, 0));

    container.querySelector('[data-section="addons"]').click();
    assert.match(container.textContent, /Add-on Control/);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(container.textContent, /2\/3 add-ons available/);
    assert.match(container.textContent, /Enable replaceable capabilities without lock-in/);
    assert.match(container.textContent, /Permission rule/);
    assert.match(container.textContent, /Hermes/);
    assert.match(container.textContent, /Living Archive/);
    assert.match(container.textContent, /OpenCode/);
    assert.match(container.textContent, /2 granted · 1 denied/);
    assert.match(container.textContent, /2 granted · 1 denied/);
    assert.match(container.textContent, /Explicit grants required/);
    assert.deepEqual(
      [...container.querySelectorAll(".settings-addon-disclosure")].map((details) => details.open),
      [false, false, false, false, false]
    );
    assert.match(container.textContent, /Granted/);
    assert.match(container.textContent, /agent-delegation/);
    assert.match(container.textContent, /notifications/);
    assert.match(container.textContent, /Denied/);
    assert.match(container.textContent, /network/);
    assert.match(container.textContent, /archive-read/);
    assert.match(container.textContent, /archive-intake-write/);
    assert.match(container.textContent, /archive-knowledge-write/);
    assert.match(container.textContent, /Capability state/);
    assert.match(container.textContent, /Direct trusted wiki writes remain blocked/);
    assert.match(container.textContent, /Coding add-ons receive bounded delegation packets/);
    assert.match(container.textContent, /Local CLI execution disabled/);
    const enableHermes = [...container.querySelectorAll("button")].find((button) => /Enable local execution/.test(button.textContent));
    enableHermes.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(bridgeCalls.some(([route, options]) =>
      route === "/addons/execution-settings" &&
      options.capability === "addon-execution-settings-write" &&
      options.body.addon === "hermes" &&
      options.body.localCliExecution === true
    ));
    assert.match(container.textContent, /Local CLI execution enabled/);

    container.querySelector('[data-section="diagnostics"]').click();
    assert.match(container.textContent, /Diagnostics/);
    assert.match(container.textContent, /Checking diagnostics endpoints/);
  } finally {
    cleanup();
  }
});

test("settings add-ons section reports bridge failures without exposing secrets", async () => {
  const { container, cleanup } = setupDom();
  const bridgeRequest = async (route) => {
    if (route === "/providers/status") return { providers: [] };
    if (route === "/status") return { addons: [], memory: null };
    if (route === "/addons/status") throw new Error("host unavailable token=abc123 sk-settings-secret");
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderSettingsWorkspace({ container, bridgeRequest, initialSection: "addons" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(container.textContent, /Add-on registry unavailable: host unavailable/);
    assert.match(container.textContent, /token=\[redacted\]/);
    assert.match(container.textContent, /\[redacted-key\]/);
    assert.equal(container.querySelector(".settings-status").dataset.tone, "error");
    assert.doesNotMatch(container.textContent, /abc123|sk-settings-secret|Bearer\s+[a-z0-9._-]+|api_key\s*=/i);
  } finally {
    cleanup();
  }
});

test("settings sections replace bridge authorization failures with recovery guidance", async () => {
  const sections = [
    ["providers", /Provider status unavailable/],
    ["memory", /Memory settings unavailable/],
    ["addons", /Add-on registry unavailable/],
    ["routing", /Routing strategies unavailable/],
    ["diagnostics", /Diagnostics loaded with 5 unavailable endpoints/],
  ];

  for (const [initialSection, heading] of sections) {
    const { container, cleanup } = setupDom();
    try {
      renderSettingsWorkspace({
        container,
        bridgeRequest: async () => {
          throw new Error("Unauthorized browser-first bridge request.");
        },
        initialSection,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.match(container.textContent, heading);
      assert.match(container.textContent, /ResonantOS bridge rejected this browser profile token/);
      assert.match(container.textContent, /Settings > Bridge Target/);
      assert.doesNotMatch(container.textContent, /Unauthorized browser-first bridge request/);
      assert.doesNotMatch(container.textContent, /requires provider-diagnostics-read capability/);
    } finally {
      cleanup();
    }
  }
});

test("settings sections replace bridge capability failures with recovery guidance", async () => {
  const { container, cleanup } = setupDom();

  try {
    renderSettingsWorkspace({
      container,
      bridgeRequest: async () => {
        throw new Error("Bridge route requires provider-diagnostics-read capability.");
      },
      initialSection: "providers",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(container.textContent, /Provider status unavailable/);
    assert.match(container.textContent, /ResonantOS bridge rejected this browser profile token/);
    assert.match(container.textContent, /Settings > Bridge Target/);
    assert.doesNotMatch(container.textContent, /requires provider-diagnostics-read capability/);
  } finally {
    cleanup();
  }
});

test("settings bridge target reports 401 token mismatch with recovery guidance", async () => {
  const { container, cleanup } = setupDom();
  const previousFetch = globalThis.fetch;
  const previousBridgeConfig = globalThis.__RESONANTOS_BRIDGE_CONFIG__;
  globalThis.__RESONANTOS_BRIDGE_CONFIG__ = {
    bridgeUrl: "http://127.0.0.1:47773",
    bridgeToken: "stale-token",
    capabilityBootstrapToken: "stale-bootstrap",
  };
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: false,
    error: "Unauthorized browser-first bridge request.",
  }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });

  try {
    renderSettingsWorkspace({
      container,
      bridgeRequest: async () => ({}),
      initialSection: "bridge-target",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(container.textContent, /Bridge Target/);
    assert.match(container.textContent, /Bridge http:\/\/127\.0\.0\.1:47773 replied 401/);
    assert.match(container.textContent, /ResonantOS bridge rejected this browser profile token/);
    assert.match(container.textContent, /reload the extension/);
    assert.doesNotMatch(container.textContent, /Check the token/);
    assert.doesNotMatch(container.textContent, /Unauthorized browser-first bridge request/);
  } finally {
    if (previousFetch === undefined) {
      delete globalThis.fetch;
    } else {
      globalThis.fetch = previousFetch;
    }
    if (previousBridgeConfig === undefined) {
      delete globalThis.__RESONANTOS_BRIDGE_CONFIG__;
    } else {
      globalThis.__RESONANTOS_BRIDGE_CONFIG__ = previousBridgeConfig;
    }
    cleanup();
  }
});

test("settings bridge target uses loopback-detected URL when tokenless override is stale", async () => {
  const { container, cleanup } = setupDom();
  const previousFetch = globalThis.fetch;
  const previousBridgeConfig = globalThis.__RESONANTOS_BRIDGE_CONFIG__;
  const previousChrome = globalThis.chrome;
  globalThis.__RESONANTOS_BRIDGE_CONFIG__ = {
    bridgeUrl: "http://127.0.0.1:47773",
    bridgeToken: "generated-token",
    capabilityBootstrapToken: "generated-bootstrap",
  };
  globalThis.chrome = {
    storage: {
      local: memoryStorage({
        bridgeTargetOverride: {
          bridgeUrl: "http://127.0.0.1:48773",
          bridgeToken: "",
          capabilityBootstrapToken: "",
        },
      }),
    },
  };
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value === "http://127.0.0.1:48773/status") {
      throw new Error("connection refused");
    }
    if (value === "https://localhost:19443/status") {
      throw new Error("certificate unavailable");
    }
    if (value === "http://localhost:47773/status") {
      return new Response(JSON.stringify({
        ok: true,
        bridge: "resonantos-bridge",
        providers: { "shared-minimax": false },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected bridge target probe: ${value}`);
  };

  try {
    renderSettingsWorkspace({
      container,
      bridgeRequest: async () => ({}),
      initialSection: "bridge-target",
    });
    await waitForCondition(() => /Bridge http:\/\/localhost:47773 responded OK/.test(container.textContent));

    assert.match(container.textContent, /Bridge Target/);
    assert.match(container.textContent, /http:\/\/localhost:47773/);
    assert.match(container.textContent, /Loopback/);
    assert.match(container.textContent, /local loopback bridge detected from override config/);
    assert.match(container.textContent, /Bridge http:\/\/localhost:47773 responded OK/);
    assert.doesNotMatch(container.textContent, /Could not reach http:\/\/127\.0\.0\.1:48773/);
  } finally {
    if (previousFetch === undefined) {
      delete globalThis.fetch;
    } else {
      globalThis.fetch = previousFetch;
    }
    if (previousBridgeConfig === undefined) {
      delete globalThis.__RESONANTOS_BRIDGE_CONFIG__;
    } else {
      globalThis.__RESONANTOS_BRIDGE_CONFIG__ = previousBridgeConfig;
    }
    if (previousChrome === undefined) {
      delete globalThis.chrome;
    } else {
      globalThis.chrome = previousChrome;
    }
    cleanup();
  }
});

test("settings workspace exposes privacy boundaries and about metadata", async () => {
  const { container, cleanup } = setupDom();
  const bridgeRequest = async (route) => {
    if (route === "/providers/status") return { providers: [] };
    if (route === "/status") return { addons: [], memory: null };
    throw new Error(`Unexpected route ${route}`);
  };
  const chromeApi = {
    runtime: {
      getManifest: () => ({
        name: "ResonantOS Test Browser",
        version: "0.7.2"
      })
    }
  };

  try {
    renderSettingsWorkspace({ container, bridgeRequest, chromeApi, initialSection: "privacy" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(container.textContent, /Privacy/);
    assert.match(container.textContent, /Trust Boundaries/);
    assert.match(container.textContent, /Provider credentials/);
    assert.match(container.textContent, /Living Archive writes/);
    assert.match(container.textContent, /Wallet and payments/);
    assert.match(container.textContent, /Vault mediated/);

    container.querySelector('[data-section="about"]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(container.textContent, /About ResonantOS/);
    assert.match(container.textContent, /ResonantOS Test Browser/);
    assert.match(container.textContent, /0\.7\.2/);
    assert.match(container.textContent, /Browser-first/);
  } finally {
    cleanup();
  }
});

test("settings diagnostics section summarizes host status and exports redacted reports", async () => {
  const { container, cleanup } = setupDom();
  const calls = [];
  const bridgeRequest = async (route, options = {}) => {
    calls.push([route, options]);
    if (route === "/status") {
      return {
        bridge: "resonantos-browser-first",
        memory: { wiki: { pages: 3 }, intake: { artifacts: 2 } },
        addons: [{ name: "Hermes", available: true }]
      };
    }
    if (route === "/providers/status") {
      return {
        providers: [
          { id: "shared-minimax", label: "MiniMax", configured: true },
          { id: "shared-openai", label: "OpenAI", configured: false }
        ]
      };
    }
    if (route === "/addons/status") {
      return {
        addons: [
          { id: "addon.hermes", name: "Hermes", available: true },
          { id: "addon.opencode", name: "OpenCode", available: false }
        ]
      };
    }
    if (route === "/memory/status") {
      return {
        wiki: { pages: 3 },
        intake: { artifacts: 2 }
      };
    }
    if (route === "/browser/launch-diagnostics") {
      return {
        status: "ready",
        launchMode: "mac-app-bundle",
        appkitMenu: "installed",
        bridge: { status: "started" },
        phantomLoaded: true
      };
    }
    if (route === "/diagnostics/report") {
      return {
        path: "~/ResonantOS_User/BrowserFirst/Diagnostics/diagnostics.json",
        generatedAt: "2026-05-29T10:00:00.000Z"
      };
    }
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderSettingsWorkspace({ container, bridgeRequest, initialSection: "diagnostics" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(container.textContent, /Diagnostics/);
    assert.match(container.textContent, /Check whether ResonantOS is healthy/);
    assert.match(container.textContent, /Endpoint details/);
    assert.match(container.textContent, /Support report/);
    assert.match(container.textContent, /resonantos-browser-first/);
    assert.match(container.textContent, /1\/2/);
    assert.match(container.textContent, /3 pages/);
    assert.match(container.textContent, /Chromium/);
    assert.match(container.textContent, /launch=mac-app-bundle · menu=installed · bridge=started · Phantom=loaded/);
    assert.match(container.textContent, /Diagnostics loaded from host-mediated status endpoints/);
    assert.deepEqual(
      [...container.querySelectorAll(".settings-diagnostics-advanced")].map((details) => details.open),
      [false, false]
    );

    container.querySelector(".settings-primary-action").click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(calls.some(([route, options]) =>
      route === "/diagnostics/report" &&
      options.capability === "diagnostics-report-export" &&
      options.method === "POST"
    ));
    assert.match(container.textContent, /Report exported: ~\/ResonantOS_User\/BrowserFirst\/Diagnostics\/diagnostics\.json/);
  } finally {
    cleanup();
  }
});

test("settings diagnostics section redacts failed endpoint and report export errors", async () => {
  const { container, cleanup } = setupDom();
  const bridgeRequest = async (route) => {
    if (route === "/status") throw new Error("bridge failed token=abc123 sk-settings-secret");
    if (route === "/providers/status") return { providers: [] };
    if (route === "/addons/status") return { addons: [] };
    if (route === "/memory/status") return { wiki: { pages: 0 }, intake: { artifacts: 0 } };
    if (route === "/browser/launch-diagnostics") return { status: "attention", launchMode: "unknown", appkitMenu: "unknown", phantomLoaded: false };
    if (route === "/diagnostics/report") throw new Error("export failed bearer abc.secret api_key=raw");
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderSettingsWorkspace({ container, bridgeRequest, initialSection: "diagnostics" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(container.textContent, /Diagnostics loaded with 1 unavailable endpoint/);
    assert.match(container.textContent, /token=\[redacted\]/);
    assert.match(container.textContent, /\[redacted-key\]/);
    assert.doesNotMatch(container.textContent, /abc123|sk-settings-secret/i);

    container.querySelector(".settings-primary-action").click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(container.textContent, /Report export failed/);
    assert.match(container.textContent, /Bearer \[redacted-token\]/);
    assert.match(container.textContent, /api_key=\[redacted\]/);
    assert.doesNotMatch(container.textContent, /abc\.secret|api_key=raw/i);
  } finally {
    cleanup();
  }
});

test("settings browser control section manages scoped grants and browser jobs", async () => {
  const { container, cleanup } = setupDom();
  const resets = [];
  const revokes = [];
  const stored = {
    augmentorBrowserJobs: [
      {
        id: "job-running",
        goal: "Find the booking page",
        status: "running",
        updatedAt: "2026-05-29T10:00:00.000Z"
      },
      {
        id: "job-done",
        goal: "Summarize page",
        status: "completed",
        updatedAt: "2026-05-29T09:00:00.000Z"
      }
    ],
    augmentorActiveBrowserJob: "job-running"
  };
  const storage = {
    get: async (key) => ({ [key]: stored[key] }),
    set: async (patch) => Object.assign(stored, patch)
  };
  const sitePermissionStore = {
    permissionForUrl: async () => "trusted-for-safe-actions",
    resetSitePermission: async (siteKey) => {
      resets.push(siteKey);
    },
    siteKeyForUrl: () => "example.com",
    sitePermissions: async () => ({
      "blocked.test": "blocked",
      "example.com": "trusted-for-safe-actions"
    })
  };
  const taskConsentStore = {
    revokeTaskConsent: async ({ siteKey, taskClass }) => {
      revokes.push(`${siteKey}:${taskClass}`);
    },
    taskConsents: async () => ({
      "example.com::shopping": {
        expiresAt: "2026-06-01T00:00:00.000Z",
        mode: "allow-safe",
        siteKey: "example.com",
        taskClass: "shopping"
      }
    })
  };

  try {
    renderSettingsWorkspace({
      container,
      bridgeRequest: async () => ({}),
      chromeApi: { tabs: { query: async () => [{ url: "https://example.com/path" }] } },
      initialSection: "browser-control",
      sitePermissionStore,
      storage,
      storageKeys: {
        activeBrowserJob: "augmentorActiveBrowserJob",
        browserJobs: "augmentorBrowserJobs"
      },
      taskConsentStore
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(container.textContent, /Agent Control Permissions/);
    assert.match(container.textContent, /The default is ask-before-action/);
    assert.match(container.textContent, /Agent permissions/);
    assert.match(container.textContent, /Browser management pages/);
    assert.match(container.textContent, /Recent downloads/);
    assert.match(container.textContent, /Browser job history/);
    assert.match(container.textContent, /example\.com · Trusted safe actions/);
    assert.match(container.textContent, /blocked\.test/);
    assert.match(container.textContent, /example\.com · shopping/);
    assert.match(container.textContent, /Find the booking page/);
    assert.match(container.textContent, /running · focused/);
    assert.match(container.textContent, /3 stored grants · 2 browser jobs/);
    assert.deepEqual(
      [...container.querySelectorAll(".settings-control-advanced")].map((details) => details.open),
      [false, false, false]
    );

    [...container.querySelectorAll("button")].find((button) => button.textContent === "Reset").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(resets, ["blocked.test"]);

    [...container.querySelectorAll("button")].find((button) => button.textContent === "Revoke").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(revokes, ["example.com:shopping"]);

    container.querySelector(".settings-primary-action").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(stored.augmentorBrowserJobs.map((job) => job.id), ["job-running"]);
  } finally {
    cleanup();
  }
});

test("settings browser control section degrades when browser stores are unavailable", async () => {
  const { container, cleanup } = setupDom();

  try {
    renderSettingsWorkspace({
      container,
      bridgeRequest: async () => ({}),
      chromeApi: { tabs: { query: async () => [] } },
      initialSection: "browser-control"
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(container.textContent, /Agent Control Permissions/);
    assert.match(container.textContent, /No readable http\/https tab is currently active/);
    assert.match(container.textContent, /No stored grants/);
    assert.match(container.textContent, /No browser jobs/);
  } finally {
    cleanup();
  }
});
