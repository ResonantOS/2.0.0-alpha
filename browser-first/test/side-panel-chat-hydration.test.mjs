import assert from "node:assert/strict";
import test from "node:test";

import { createSidePanelChatHydration } from "../resonantos-side-panel-extension/src/lib/side-panel-chat-hydration.js";

test("side panel chat hydration owns startup ordering and state handoff", async () => {
  const events = [];
  const hydration = createSidePanelChatHydration({
    chatSessionStore: {
      hydrate: async () => events.push("session-hydrate"),
      ensureFreshSession: async () => events.push("unexpected-ensure-fresh-session")
    },
    hydrateControlPreflight: async () => events.push("hydrate-control-preflight"),
    hydrateProviderModelOptions: async () => events.push("hydrate-provider-options"),
    readPersonalizationSettings: async () => {
      events.push("read-personalization");
      return { userName: "Manolo", augmentorPrompt: "Be precise." };
    },
    renderAttachments: () => events.push("render-attachments"),
    renderMessages: () => events.push("render-messages"),
    setContextDockExpanded: (expanded) => events.push(["context-expanded", expanded]),
    setContextMeter: () => events.push("set-context-meter"),
    setPersonalizationSettings: (settings) => events.push(["personalization", settings]),
    storage: {
      get: async (keys) => {
        events.push(["storage-get", keys]);
        return { augmentorContextDockExpanded: true };
      }
    },
    storageKeys: {
      contextDockExpanded: "augmentorContextDockExpanded"
    },
    updateConnectionLine: () => events.push("update-connection-line")
  });

  await hydration.hydrateChatSettings();

  assert.deepEqual(events, [
    "hydrate-provider-options",
    "session-hydrate",
    "read-personalization",
    ["personalization", { userName: "Manolo", augmentorPrompt: "Be precise." }],
    ["storage-get", ["augmentorContextDockExpanded"]],
    ["context-expanded", true],
    "hydrate-control-preflight",
    "render-messages",
    "render-attachments",
    "update-connection-line",
    "set-context-meter"
  ]);
});

test("side panel chat hydration safely treats missing context dock state as collapsed", async () => {
  const events = [];
  const hydration = createSidePanelChatHydration({
    chatSessionStore: {
      hydrate: async () => undefined,
      ensureFreshSession: async () => events.push("unexpected-ensure-fresh-session")
    },
    hydrateControlPreflight: async () => undefined,
    hydrateProviderModelOptions: async () => undefined,
    readPersonalizationSettings: async () => ({}),
    renderAttachments: () => undefined,
    renderMessages: () => undefined,
    setContextDockExpanded: (expanded) => events.push(expanded),
    setContextMeter: () => undefined,
    setPersonalizationSettings: () => undefined,
    storage: {
      get: async () => {
        throw new Error("storage unavailable");
      }
    },
    storageKeys: {
      contextDockExpanded: "augmentorContextDockExpanded"
    },
    updateConnectionLine: () => undefined
  });

  await hydration.hydrateChatSettings();

  assert.deepEqual(events, [false]);
});
